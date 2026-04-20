//! Edge-to-Edge Session Mesh — session sync server and client.
//!
//! Each Edge serves a `/session` WebSocket endpoint (on `edge_port`) that peer Edges
//! connect to in order to receive the full snapshot of locally-owned sessions and
//! ongoing incremental deltas.
//!
//! ## Protocol
//!
//! All frames are binary WebSocket frames containing a length-prefixed prost-encoded
//! `PeerSyncPacket` protobuf message.  The 4-byte big-endian length header matches
//! the framing used by the rest of MuNode's protobuf transport.
//!
//! ### Initiating sync (client side)
//!
//! 1. Connect to `ws://<peer_host>:<edge_port>/session`
//! 2. Send `PeerSyncPacket { packet_type: SYNC_REQUEST, sync_request: { requesting_edge_id } }`
//! 3. Receive `PeerSyncPacket { packet_type: SYNC_RESPONSE, sync_response: { seq_fence, sessions[] } }`
//! 4. Apply snapshot via `ChannelManager::apply_peer_snapshot()`
//! 5. Continue receiving `PeerSyncPacket { packet_type: DELTA, delta: ... }` frames indefinitely.
//!
//! ### Serving sync (server side)
//!
//! 1. Receive `SyncRequest`
//! 2. Take atomic snapshot of local sessions + current `LOCAL_SESSION_SEQ`
//! 3. Send `SyncResponse` with snapshot + seq_fence
//! 4. Register peer as a subscriber; forward all future `EdgeSessionDelta`s.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tracing::{debug, info, warn};

use munode_protocol::edgepeersync::{
    EdgeSessionDelta, EdgeSessionSyncRequest, EdgeSessionSyncResponse,
    PeerSyncPacket, RemoteSessionProto,
    PACKET_TYPE_DELTA, PACKET_TYPE_SYNC_REQUEST, PACKET_TYPE_SYNC_RESPONSE,
};

use crate::channel_manager::PeerSyncState;
use crate::state::{EdgeEvent, EdgeState, LOCAL_SESSION_SEQ};

type WsMessage = tokio_tungstenite::tungstenite::Message;

/// Timeout to wait for a `SyncRequest` after connection before dropping the peer.
const SYNC_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Gap timer: if we haven't received expected delta within this duration, re-sync.
const GAP_RESYNC_TIMEOUT: Duration = Duration::from_secs(5);

/// Maximum WebSocket frame size accepted from peers (8 MiB).
#[allow(dead_code)]
const MAX_FRAME_SIZE: usize = 8 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Global broadcaster — every delta from local event loop is sent here so that
// `handle_session_sync_connection` can receive and relay it.
// ─────────────────────────────────────────────────────────────────────────────

/// Broadcast channel capacity for session deltas.
const DELTA_BROADCAST_CAP: usize = 512;

static DELTA_BROADCAST: OnceLock<broadcast::Sender<EdgeSessionDelta>> = OnceLock::new();

fn delta_broadcast() -> &'static broadcast::Sender<EdgeSessionDelta> {
    DELTA_BROADCAST.get_or_init(|| {
        broadcast::channel::<EdgeSessionDelta>(DELTA_BROADCAST_CAP).0
    })
}

/// Broadcast a local session delta to all connected session sync subscribers.
/// Called from `handler.rs` whenever a local user joins/leaves/moves/changes state.
pub fn broadcast_session_delta(delta: EdgeSessionDelta) {
    let _ = delta_broadcast().send(delta);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: encode a PeerSyncPacket into a binary WebSocket frame.
// ─────────────────────────────────────────────────────────────────────────────

fn encode_packet(packet: &PeerSyncPacket) -> WsMessage {
    let mut buf = Vec::with_capacity(packet.encoded_len() + 4);
    let len = packet.encoded_len() as u32;
    buf.extend_from_slice(&len.to_be_bytes());
    packet.encode(&mut buf).expect("prost encode cannot fail for valid messages");
    WsMessage::Binary(buf.into())
}

fn decode_packet(data: &[u8]) -> Result<PeerSyncPacket> {
    // Skip the 4-byte length prefix if present.
    let payload = if data.len() >= 4 {
        let expected_len = u32::from_be_bytes(data[..4].try_into().unwrap()) as usize;
        if data.len() == expected_len + 4 {
            &data[4..]
        } else {
            // No length prefix — try decoding raw
            data
        }
    } else {
        data
    };
    Ok(PeerSyncPacket::decode(payload)?)
}

// ─────────────────────────────────────────────────────────────────────────────
// Server side: handle an incoming /session WebSocket connection from a peer.
// ─────────────────────────────────────────────────────────────────────────────

/// Handle an incoming Edge-to-Edge session sync WebSocket connection.
/// `ws` is the already-upgraded WebSocket stream.
pub async fn handle_session_sync_connection(
    ws: WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    edge_state: Arc<EdgeState>,
) {
    let my_edge_id = edge_state.get_edge_id();
    if let Err(e) = run_session_sync_server(ws, edge_state, my_edge_id).await {
        debug!(my_edge_id, "Session sync server connection ended: {:#}", e);
    }
}

/// Same as `handle_session_sync_connection` but for plain (non-TLS) TCP, used in
/// tests or when the relay listener wraps the stream in a `MaybeTlsStream`.
pub async fn handle_session_sync_plain<S>(
    ws: WebSocketStream<S>,
    edge_state: Arc<EdgeState>,
)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let my_edge_id = edge_state.get_edge_id();
    if let Err(e) = run_session_sync_server_generic(ws, edge_state, my_edge_id).await {
        debug!(my_edge_id, "Session sync server connection ended: {:#}", e);
    }
}

async fn run_session_sync_server(
    ws: WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    edge_state: Arc<EdgeState>,
    my_edge_id: u32,
) -> Result<()> {
    run_session_sync_server_generic(ws, edge_state, my_edge_id).await
}

async fn run_session_sync_server_generic<S>(
    mut ws: WebSocketStream<S>,
    edge_state: Arc<EdgeState>,
    my_edge_id: u32,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    // Step 1: Wait for SyncRequest with timeout.
    let requesting_edge_id = timeout(SYNC_REQUEST_TIMEOUT, async {
        while let Some(msg) = ws.next().await {
            match msg? {
                WsMessage::Binary(data) => {
                    let packet = decode_packet(&data)?;
                    if packet.packet_type == PACKET_TYPE_SYNC_REQUEST {
                        let req_id = packet.sync_request
                            .as_ref()
                            .map(|r| r.requesting_edge_id)
                            .unwrap_or(0);
                        return Ok::<u32, anyhow::Error>(req_id);
                    }
                }
                WsMessage::Close(_) => anyhow::bail!("peer closed before SyncRequest"),
                _ => {}
            }
        }
        anyhow::bail!("WebSocket stream ended before SyncRequest")
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for SyncRequest"))??;

    info!(my_edge_id, requesting_edge_id, "Session sync: received SyncRequest, preparing snapshot");

    // Step 2: Take snapshot atomically with seq_fence.
    // seq_fence = current LOCAL_SESSION_SEQ value (last seq already written).
    let seq_fence = LOCAL_SESSION_SEQ.load(std::sync::atomic::Ordering::Acquire).saturating_sub(1);
    let sessions = snapshot_local_sessions(&edge_state, my_edge_id).await;

    // Step 3: Send SyncResponse.
    let response_packet = PeerSyncPacket {
        packet_type: PACKET_TYPE_SYNC_RESPONSE,
        sync_response: Some(EdgeSessionSyncResponse {
            seq_fence,
            sessions,
        }),
        ..Default::default()
    };
    ws.send(encode_packet(&response_packet)).await?;
    info!(my_edge_id, requesting_edge_id, seq_fence, "Session sync: snapshot sent");

    // Step 4: Subscribe to delta broadcast and forward deltas from our edge.
    let mut delta_rx = delta_broadcast().subscribe();

    loop {
        tokio::select! {
            delta_result = delta_rx.recv() => {
                match delta_result {
                    Ok(delta) => {
                        // Only forward deltas owned by us.
                        if delta.source_edge_id == my_edge_id {
                            let packet = PeerSyncPacket {
                                packet_type: PACKET_TYPE_DELTA,
                                delta: Some(delta),
                                ..Default::default()
                            };
                            if let Err(e) = ws.send(encode_packet(&packet)).await {
                                debug!("Session sync: peer disconnected while sending delta: {}", e);
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // We fell behind — the peer must reconnect.
                        warn!(my_edge_id, requesting_edge_id, skipped = n, "Delta broadcast lagged, closing connection");
                        let _ = ws.close(None).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // Drain any incoming frames (ping/pong/close).
            incoming = ws.next() => {
                match incoming {
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Ok(WsMessage::Ping(payload))) => {
                        let _ = ws.send(WsMessage::Pong(payload)).await;
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Client side: connect to a peer Edge and receive its session snapshot + deltas.
// ─────────────────────────────────────────────────────────────────────────────

/// Connect to `peer_host:sync_port/session`, receive the snapshot and all deltas.
/// This function runs forever until the connection closes (then it returns so the
/// caller can decide whether to reconnect).
pub async fn sync_sessions_from_peer(
    peer_id: u32,
    peer_host: String,
    sync_port: u16,
    my_edge_id: u32,
    edge_state: Arc<EdgeState>,
) {
    let url = format!("ws://{}:{}/session", peer_host, sync_port);
    info!(my_edge_id, peer_id, %url, "Session sync: connecting to peer");

    let ws_result = timeout(Duration::from_secs(10), async {
        tokio_tungstenite::connect_async(&url).await
    })
    .await;

    let (mut ws, _) = match ws_result {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            warn!(peer_id, "Session sync: failed to connect to {}: {}", url, e);
            return;
        }
        Err(_) => {
            warn!(peer_id, "Session sync: connection timeout to {}", url);
            return;
        }
    };

    // Send SyncRequest.
    let request = PeerSyncPacket {
        packet_type: PACKET_TYPE_SYNC_REQUEST,
        sync_request: Some(EdgeSessionSyncRequest { requesting_edge_id: my_edge_id }),
        ..Default::default()
    };
    if let Err(e) = ws.send(encode_packet(&request)).await {
        warn!(peer_id, "Session sync: failed to send SyncRequest: {}", e);
        return;
    }

    // Mark peer as Syncing.
    edge_state.channel_manager
        .set_peer_sync_state(peer_id, PeerSyncState::Syncing)
        .await;

    // Receive SyncResponse (snapshot).
    let snapshot = timeout(Duration::from_secs(30), async {
        while let Some(msg) = ws.next().await {
            match msg {
                Ok(WsMessage::Binary(data)) => {
                    if let Ok(packet) = decode_packet(&data) {
                        if packet.packet_type == PACKET_TYPE_SYNC_RESPONSE {
                            return Some(packet.sync_response);
                        }
                    }
                }
                Ok(WsMessage::Close(_)) | Err(_) => return None,
                _ => {}
            }
        }
        None
    })
    .await;

    let snapshot = match snapshot {
        Ok(Some(Some(snap))) => snap,
        _ => {
            warn!(peer_id, "Session sync: failed to receive snapshot from peer");
            return;
        }
    };

    info!(peer_id, seq_fence = snapshot.seq_fence, sessions = snapshot.sessions.len(), "Session sync: received snapshot");

    // Apply snapshot.
    edge_state.channel_manager
        .apply_peer_snapshot(peer_id, snapshot.seq_fence, &snapshot.sessions)
        .await;

    // Emit events for all remote users now visible from this peer.
    for session in &snapshot.sessions {
        edge_state.emit(EdgeEvent::RemoteUserJoined {
            session_id: session.session_id,
            username: session.username.clone(),
            channel_id: session.channel_id,
            is_ninja: false,
        });
    }

    // Receive deltas indefinitely.
    while let Some(msg) = ws.next().await {
        match msg {
            Ok(WsMessage::Binary(data)) => {
                if let Ok(packet) = decode_packet(&data) {
                    if packet.packet_type == PACKET_TYPE_DELTA {
                        if let Some(delta) = packet.delta {
                            apply_incoming_delta(peer_id, delta, &edge_state).await;
                        }
                    }
                }
            }
            Ok(WsMessage::Ping(payload)) => {
                let _ = ws.send(WsMessage::Pong(payload)).await;
            }
            Ok(WsMessage::Close(_)) | Err(_) => break,
            _ => {}
        }

        // Check for gap timeout.
        if edge_state.channel_manager
            .is_peer_gap_expired(peer_id, GAP_RESYNC_TIMEOUT)
            .await
        {
            warn!(peer_id, "Session sync: delta gap exceeded timeout, disconnecting for re-sync");
            break;
        }
    }

    info!(peer_id, "Session sync: peer connection closed");
    // The caller (or reconnect loop) should decide whether to reconnect.
}

/// Apply an incoming delta from a peer and emit the corresponding EdgeEvent.
async fn apply_incoming_delta(peer_id: u32, delta: EdgeSessionDelta, edge_state: &Arc<EdgeState>) {
    // Determine event type before consuming delta.
    let joined_session_id = delta.user_joined.as_ref().map(|u| (u.session_id, u.username.clone(), u.channel_id));
    let left_session_id = delta.user_left.as_ref().map(|u| u.session_id);
    let state_changed = delta.user_state.as_ref().map(|u| u.session_id);
    let moved = delta.user_moved.as_ref().map(|u| (u.session_id, u.channel_id));

    let applied = edge_state.channel_manager.apply_peer_delta(peer_id, delta).await;

    if applied {
        if let Some((sid, username, channel_id)) = joined_session_id {
            edge_state.emit(EdgeEvent::RemoteUserJoined { session_id: sid, username, channel_id, is_ninja: false });
        } else if let Some(sid) = left_session_id {
            edge_state.emit(EdgeEvent::RemoteUserLeft { session_id: sid });
        } else if let Some(sid) = state_changed {
            edge_state.emit(EdgeEvent::RemoteUserStateChanged {
                session_id: sid,
                delta: crate::state::RemoteUserStateDelta::default(),
                listening_channel_add: vec![],
                listening_channel_remove: vec![],
            });
        } else if let Some((sid, channel_id)) = moved {
            edge_state.emit(EdgeEvent::RemoteUserMoved { session_id: sid, channel_id, actor_session: 0 });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Build a session snapshot for all locally-owned sessions on this Edge.
/// Returns `Vec<RemoteSessionProto>` suitable for inclusion in a `SyncResponse`.
async fn snapshot_local_sessions(edge_state: &Arc<EdgeState>, my_edge_id: u32) -> Vec<RemoteSessionProto> {
    let clients = edge_state.client_manager.get_all_clients().await;
    clients
        .into_iter()
        .map(|c| RemoteSessionProto {
                session_id: c.session,
                edge_id: my_edge_id,
                user_id: c.user_id,
                username: c.username.clone(),
                channel_id: c.channel_id,
                cert_hash: c.cert_hash.clone(),
                groups: c.groups.clone(),
                mute: Some(c.mute),
                deaf: Some(c.deaf),
                suppress: Some(c.suppress),
                self_mute: Some(c.self_mute),
                self_deaf: Some(c.self_deaf),
                priority_speaker: Some(c.priority_speaker),
                recording: Some(c.recording),
                listening_channels: c.listening_channels.clone(),
                texture_hash: c.texture_hash.clone(),
                comment_hash: c.comment_hash.clone(),
                listening_volume_adjustments: c.listening_volume_adjustments
                    .iter()
                    .map(|(&ch, &vol)| munode_protocol::edgepeersync::ListeningVolumeAdjustment {
                        channel_id: ch,
                        volume_adjustment: vol,
                    })
                    .collect(),
                plugin_context: if c.plugin_context.is_empty() { None } else { Some(c.plugin_context.clone()) },
            })
        .collect()
}
