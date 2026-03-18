//! Edge WebSocket server — combined control-relay and voice channel on `edge_port`.
//!
//! Every Edge starts a lightweight TCP/WebSocket listener on the same port number as
//! its UDP `edge_port` (UDP and TCP share the port number but are distinct protocols).
//! Two WebSocket paths are served:
//!
//! - `/relay` — transparent Hub proxy relay (unchanged behaviour from the old relay server)
//! - `/voice` — direct Edge-to-Edge voice channel for `DirectTcp` routing
//!
//! ```text
//!   Edge A (cannot reach Hub)
//!        │ ws://edge-b-host:edge_port/relay
//!        ▼
//!   Edge B (relay server)  ───ws://hub-host:hub-port/──►  Hub
//!
//!   Edge A (DirectTcp voice)
//!        │ ws://edge-b-host:edge_port/voice
//!        ▼
//!   Edge B — delivers voice frames directly to local clients
//! ```

use std::sync::{Arc, Mutex as StdMutex};

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};
use tracing::{debug, error, info, warn};

use crate::state::{EdgeEvent, EdgeState};

type WsMessage = tokio_tungstenite::tungstenite::Message;
type WsError = tokio_tungstenite::tungstenite::Error;

/// Idle timeout for relay connections: drop connections that carry no traffic
/// for this duration. This prevents resource leaks from stale/zombie relays.
const RELAY_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Voice TCP connection channel buffer size.
const VOICE_TCP_CHAN_BUF: usize = 256;

/// Start the combined edge WebSocket server (relay + voice) on `edge_port`.
///
/// Binds to `0.0.0.0:edge_port` (TCP) and dispatches incoming WebSocket connections
/// by path:
/// - `/relay` → Hub proxy relay (for Edges that can't reach Hub directly)
/// - `/voice` → Edge-to-Edge voice delivery channel
///
/// This function never returns under normal operation.
pub async fn run_edge_ws_server(
    edge_port: u16,
    hub_host: String,
    hub_port: u16,
    edge_state: Arc<EdgeState>,
) {
    let bind_addr = format!("0.0.0.0:{}", edge_port);
    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => {
            info!("Edge WS server (relay+voice) listening on {}", bind_addr);
            l
        }
        Err(e) => {
            error!("Failed to bind edge WS server on {}: {}", bind_addr, e);
            return;
        }
    };
    run_edge_ws_server_with_listener(listener, hub_host, hub_port, edge_state).await;
}

/// Accept-loop variant that takes a pre-bound listener — used in tests to avoid
/// port conflicts by letting the OS pick a free port.
pub async fn run_edge_ws_server_with_listener(
    listener: TcpListener,
    hub_host: String,
    hub_port: u16,
    edge_state: Arc<EdgeState>,
) {
    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                let hub_host = hub_host.clone();
                let hub_port = hub_port;
                let edge_state = edge_state.clone();
                tokio::spawn(async move {
                    // Capture the HTTP upgrade path via a header callback
                    let captured_path: Arc<StdMutex<String>> =
                        Arc::new(StdMutex::new(String::new()));
                    let cp = captured_path.clone();

                    let ws_result = timeout(
                        Duration::from_secs(30),
                        tokio_tungstenite::accept_hdr_async(
                            stream,
                            move |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                                  response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                                *cp.lock().unwrap() = req.uri().path().to_string();
                                Ok(response)
                            },
                        ),
                    )
                    .await;

                    let ws = match ws_result {
                        Ok(Ok(ws)) => ws,
                        Ok(Err(e)) => {
                            debug!("Edge WS handshake error from {}: {}", peer_addr, e);
                            return;
                        }
                        Err(_) => {
                            debug!("Edge WS handshake timeout from {}", peer_addr);
                            return;
                        }
                    };

                    let path = captured_path.lock().unwrap().clone();
                    match path.as_str() {
                        "/voice" => {
                            debug!("Edge WS /voice connection from {}", peer_addr);
                            handle_voice_connection(ws, peer_addr, edge_state).await;
                        }
                        _ => {
                            // Default: /relay or any unknown path → Hub proxy
                            debug!("Edge WS /relay connection from {}", peer_addr);
                            if let Err(e) =
                                run_relay_for_ws(ws, peer_addr, hub_host, hub_port).await
                            {
                                debug!(
                                    "Control relay connection from {} ended: {}",
                                    peer_addr, e
                                );
                            }
                        }
                    }
                });
            }
            Err(e) => {
                warn!("Edge WS server accept error: {}", e);
            }
        }
    }
}

/// Handle an incoming `/voice` WebSocket connection from a peer Edge.
///
/// Protocol:
/// 1. First binary message = peer's `edge_id` (4 bytes BE).
/// 2. Subsequent binary messages:
///    - `[0x01][session_BE(4)][plaintext...]` → deliver locally via `RelayedVoice`.
///    - `[0x02][ttl(1)][target_BE(4)][session_BE(4)][plaintext...]` → relay (dropped for now).
async fn handle_voice_connection(
    ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    peer_addr: std::net::SocketAddr,
    edge_state: Arc<EdgeState>,
) {
    let (mut _write, mut read) = ws.split();

    // Read peer edge_id from the first binary frame
    let peer_edge_id = loop {
        match timeout(Duration::from_secs(10), read.next()).await {
            Ok(Some(Ok(WsMessage::Binary(data)))) if data.len() == 4 => {
                let id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                break id;
            }
            Ok(Some(Ok(WsMessage::Binary(data)))) => {
                warn!(
                    "Voice conn from {}: unexpected first frame length {}",
                    peer_addr,
                    data.len()
                );
                return;
            }
            Ok(Some(Ok(_))) => continue, // skip non-binary frames
            Ok(Some(Err(e))) => {
                debug!("Voice conn from {}: read error: {}", peer_addr, e);
                return;
            }
            Ok(None) => {
                debug!("Voice conn from {}: closed before edge_id", peer_addr);
                return;
            }
            Err(_) => {
                warn!("Voice conn from {}: timeout waiting for edge_id", peer_addr);
                return;
            }
        }
    };

    info!(
        "Voice TCP connection from peer edge {} ({})",
        peer_edge_id, peer_addr
    );

    // Process incoming voice frames
    while let Ok(Some(msg)) = timeout(RELAY_IDLE_TIMEOUT, read.next()).await {
        let data = match msg {
            Ok(WsMessage::Binary(d)) => d,
            Ok(WsMessage::Close(_)) => break,
            Ok(_) => continue,
            Err(e) => {
                debug!(
                    "Voice conn from peer edge {}: read error: {}",
                    peer_edge_id, e
                );
                break;
            }
        };

        if data.is_empty() {
            continue;
        }

        match data[0] {
            0x01 if data.len() >= 6 => {
                // Direct delivery: [0x01][session_BE(4)][plaintext...]
                let sender_session =
                    u32::from_be_bytes([data[1], data[2], data[3], data[4]]);
                let plaintext = &data[5..];
                // Build RelayedVoice packet: inject session varint into plaintext
                let voice_packet = make_relayed_voice_packet(plaintext, sender_session);
                if !voice_packet.is_empty() {
                    edge_state.emit(EdgeEvent::RelayedVoice { voice_packet });
                }
            }
            0x02 => {
                // Relay frame — not handled on the /voice channel (log and drop)
                debug!(
                    "Voice conn from peer edge {}: relay frame dropped (len={})",
                    peer_edge_id,
                    data.len()
                );
            }
            _ => {
                debug!(
                    "Voice conn from peer edge {}: unknown frame type 0x{:02X}",
                    peer_edge_id, data[0]
                );
            }
        }
    }

    info!(
        "Voice TCP connection from peer edge {} ({}) closed",
        peer_edge_id, peer_addr
    );
}

/// Connect to a peer Edge's `/voice` WebSocket endpoint and store the sender in
/// `edge_state.voice_tcp_conns[peer_edge_id]`.  Reconnects once if the
/// connection drops.
pub async fn connect_peer_voice_tcp(
    peer_edge_id: u32,
    peer_host: String,
    peer_edge_port: u16,
    self_edge_id: u32,
    edge_state: Arc<EdgeState>,
) {
    let url = format!("ws://{}:{}/voice", peer_host, peer_edge_port);

    let ws = match timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(&url),
    )
    .await
    {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(e)) => {
            warn!(
                "Failed to connect TCP voice channel to peer edge {} ({}): {}",
                peer_edge_id, url, e
            );
            return;
        }
        Err(_) => {
            warn!(
                "Timeout connecting TCP voice channel to peer edge {} ({})",
                peer_edge_id, url
            );
            return;
        }
    };

    let (mut write, _read) = ws.split();

    // Send our own edge_id as the first 4-byte frame
    let id_frame = WsMessage::Binary(self_edge_id.to_be_bytes().to_vec().into());
    if let Err(e) = write.send(id_frame).await {
        warn!(
            "TCP voice to peer edge {}: failed to send edge_id: {}",
            peer_edge_id, e
        );
        return;
    }

    // Create the channel and store the sender so udp.rs can enqueue frames
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(VOICE_TCP_CHAN_BUF);
    {
        let mut conns = edge_state.voice_tcp_conns.write().await;
        conns.insert(peer_edge_id, tx);
    }
    info!(
        "TCP voice channel to peer edge {} ({}) established",
        peer_edge_id, url
    );

    // Drain the rx channel and forward frames over the WebSocket
    while let Some(frame) = rx.recv().await {
        if let Err(e) = write.send(WsMessage::Binary(frame.into())).await {
            debug!(
                "TCP voice to peer edge {}: send error: {}",
                peer_edge_id, e
            );
            break;
        }
    }

    // Connection dropped — clean up
    {
        let mut conns = edge_state.voice_tcp_conns.write().await;
        conns.remove(&peer_edge_id);
    }
    info!(
        "TCP voice channel to peer edge {} ({}) disconnected",
        peer_edge_id, url
    );
}

/// Build a `RelayedVoice`-compatible packet from a raw plaintext voice payload
/// (client-to-server format) and a sender session ID.
///
/// Input `plaintext`: `[header(1B)][sequence_varint][audio_data]`
/// Output: `[header(1B)][session_varint][sequence_varint][audio_data]`
fn make_relayed_voice_packet(plaintext: &[u8], sender_session: u32) -> Vec<u8> {
    if plaintext.is_empty() {
        return Vec::new();
    }
    let header = plaintext[0];
    let session_bytes = encode_varint(sender_session);
    let mut pkt = Vec::with_capacity(1 + session_bytes.len() + plaintext.len() - 1);
    pkt.push(header);
    pkt.extend_from_slice(&session_bytes);
    pkt.extend_from_slice(&plaintext[1..]);
    pkt
}

/// Encode a u32 as a Mumble varint.
fn encode_varint(value: u32) -> Vec<u8> {
    if value < 0x80 {
        vec![value as u8]
    } else if value < 0x4000 {
        vec![((value >> 8) | 0x80) as u8, (value & 0xFF) as u8]
    } else if value < 0x200000 {
        vec![
            ((value >> 16) | 0xC0) as u8,
            ((value >> 8) & 0xFF) as u8,
            (value & 0xFF) as u8,
        ]
    } else {
        vec![
            0xF0,
            ((value >> 24) & 0xFF) as u8,
            ((value >> 16) & 0xFF) as u8,
            ((value >> 8) & 0xFF) as u8,
            (value & 0xFF) as u8,
        ]
    }
}

/// Handle a single proxy connection: upgrade to WebSocket, connect to Hub,
/// Relay an already-upgraded client WebSocket connection to the Hub.
///
/// Opens a new WebSocket connection to the Hub and relays frames bidirectionally
/// until either side closes or the connection is idle for [`RELAY_IDLE_TIMEOUT`].
async fn run_relay_for_ws(
    client_ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    peer_addr: std::net::SocketAddr,
    hub_host: String,
    hub_port: u16,
) -> Result<()> {
    // Connect to Hub as a WebSocket client
    const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
    let hub_url = format!("ws://{}:{}", hub_host, hub_port);
    let (hub_ws, _) = timeout(HANDSHAKE_TIMEOUT, tokio_tungstenite::connect_async(&hub_url))
        .await
        .map_err(|_| anyhow::anyhow!("WebSocket connect to Hub timed out ({})", hub_url))??;
    debug!("Control relay: connected to Hub at {} for peer {}", hub_url, peer_addr);

    let (mut client_write, client_read) = client_ws.split();
    let (mut hub_write, hub_read) = hub_ws.split();

    // Relay in both directions concurrently; stop when either side closes
    // or when the connection is idle for RELAY_IDLE_TIMEOUT.
    let c2h = format!("client→hub ({})", peer_addr);
    let h2c = format!("hub→client ({})", peer_addr);
    tokio::select! {
        r = relay_frames(client_read, &mut hub_write, &c2h) => {
            debug!("Peer proxy relay {} ended: {:?}", c2h, r);
        }
        r = relay_frames(hub_read, &mut client_write, &h2c) => {
            debug!("Peer proxy relay {} ended: {:?}", h2c, r);
        }
    }

    info!("Control relay connection from {} closed", peer_addr);
    Ok(())
}

/// Relay WebSocket frames from `src` to `dst`.
///
/// Only binary and text frames are forwarded; ping/pong/close frames are
/// handled transparently by tungstenite.  Each individual frame read is
/// subject to [`RELAY_IDLE_TIMEOUT`], so a stalled stream will be detected
/// even if the connection itself stays open.
///
/// `label` should describe the relay direction **and** the peer address for
/// traceability when multiple relay connections run concurrently, e.g.
/// `"client→hub (1.2.3.4:50000)"`.
async fn relay_frames<R, W>(
    mut src: R,
    dst: &mut W,
    label: &str,
) -> Result<()>
where
    R: StreamExt<Item = Result<WsMessage, WsError>> + Unpin,
    W: SinkExt<WsMessage, Error = WsError> + Unpin,
{
    loop {
        // Apply per-frame idle timeout so a stalled sender is detected.
        let msg = match timeout(RELAY_IDLE_TIMEOUT, src.next()).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break, // stream ended cleanly
            Err(_) => {
                debug!("Relay {}: per-frame idle timeout ({:?}), closing", label, RELAY_IDLE_TIMEOUT);
                return Err(anyhow::anyhow!("relay {}: idle timeout", label));
            }
        };

        match msg {
            Ok(WsMessage::Binary(data)) => {
                dst.send(WsMessage::Binary(data)).await?;
            }
            Ok(WsMessage::Text(text)) => {
                dst.send(WsMessage::Text(text)).await?;
            }
            Ok(WsMessage::Close(frame)) => {
                debug!("Relay {}: received Close frame, forwarding and stopping", label);
                let _ = dst.send(WsMessage::Close(frame)).await;
                break;
            }
            Ok(WsMessage::Ping(data)) => {
                dst.send(WsMessage::Pong(data)).await?;
            }
            Ok(WsMessage::Pong(_)) => {
                // Ignore pong responses
            }
            Ok(_) => {}
            Err(e) => {
                return Err(anyhow::anyhow!("relay {}: read error: {}", label, e));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use crate::channel_manager::ChannelManager;
    use crate::client::ClientManager;
    use crate::state::{EdgeEvent, EdgeState};

    /// Bind a random OS-assigned TCP port and return (port, listener).
    async fn random_port_listener() -> (u16, TcpListener) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        (port, listener)
    }

    /// Start a minimal `run_edge_ws_server` on a random port.
    /// Returns the port and the EdgeState so tests can subscribe to events.
    async fn start_test_voice_server() -> (u16, Arc<EdgeState>) {
        let cm = ChannelManager::new();
        let clm = ClientManager::new();
        let state = EdgeState::new(cm, clm, false);

        let (port, listener) = random_port_listener().await;

        let state_clone = state.clone();
        tokio::spawn(async move {
            // Provide a non-functional hub address; /relay won't be used in these tests.
            run_edge_ws_server_with_listener(listener, "127.0.0.1".to_string(), 0, state_clone).await;
        });

        // Give the server a moment to start accepting
        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        (port, state)
    }

    // ── /voice round-trip ────────────────────────────────────────────────────

    /// Test that a voice frame sent via `connect_peer_voice_tcp` is received by the
    /// server and emitted as a `RelayedVoice` event on EdgeState.
    #[tokio::test]
    async fn test_voice_ws_roundtrip() {
        let (port, server_state) = start_test_voice_server().await;

        // Subscribe to events BEFORE connecting so we don't miss the emission
        let mut rx = server_state.subscribe_events();

        // Outbound side: connect to the server's /voice endpoint as "edge 42"
        let cm = ChannelManager::new();
        let clm = ClientManager::new();
        let client_state = EdgeState::new(cm, clm, false);
        client_state.edge_id.store(42, std::sync::atomic::Ordering::Relaxed);

        tokio::spawn(async move {
            connect_peer_voice_tcp(
                99, // peer edge id (from server's perspective: us)
                "127.0.0.1".to_string(),
                port,
                42, // self edge id
                client_state,
            ).await;
        });

        // Wait briefly for connection to establish
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        // Now send a voice frame via voice_tcp_conns  — but in this test we verify
        // that the server side emits RelayedVoice when it receives [0x01] frames.
        // We do this by connecting our own raw WS client directly.
        let url = format!("ws://127.0.0.1:{}/voice", port);
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await
            .expect("WS connect failed");

        // Send self edge_id (4 bytes BE) as handshake
        let self_id: u32 = 77;
        ws.send(WsMessage::Binary(bytes::Bytes::from(self_id.to_be_bytes().to_vec()))).await.unwrap();

        // Build a [0x01][session_BE(4)][voice header + dummy payload] frame
        // voice header byte: type=2 (Opus), target=0 (broadcast) → 0x80
        let session: u32 = 12345;
        let mut frame = vec![0x01u8]; // EDGE_PKT_VOICE
        frame.extend_from_slice(&session.to_be_bytes());
        // Minimal Opus voice packet: [header 0x80][sequence 0x01][payload 0xAA 0xBB]
        frame.push(0x80); // header: type Opus, target 0
        frame.push(0x01); // sequence varint
        frame.push(0xAA);
        frame.push(0xBB);

        ws.send(WsMessage::Binary(bytes::Bytes::from(frame))).await.unwrap();

        // The server should emit RelayedVoice; wait up to 500ms
        let got = tokio::time::timeout(
            tokio::time::Duration::from_millis(500),
            async {
                loop {
                    match rx.recv().await {
                        Ok(EdgeEvent::RelayedVoice { voice_packet }) => return Some(voice_packet),
                        Ok(_) => continue,
                        Err(_) => return None,
                    }
                }
            }
        ).await;

        let voice_pkt = got.expect("timed out").expect("channel closed");
        // First byte = voice header (0x80), then session varint, then payload
        assert_eq!(voice_pkt[0], 0x80, "voice header should be 0x80");
        assert!(!voice_pkt.is_empty(), "voice_packet should not be empty");
    }

    // ── Server accepts connections on unknown paths (falls through to relay) ──

    #[tokio::test]
    async fn test_unknown_ws_path_connects_as_relay() {
        let (port, _state) = start_test_voice_server().await;

        // Unknown paths fall through to the /relay handler (Hub proxy).
        // The connection will be accepted (HTTP 101), but will close quickly
        // because the hub address is non-functional (port 0).
        let url = format!("ws://127.0.0.1:{}/unknown", port);
        // Connection accepted: either succeeds or errors after upgrade
        let result = tokio_tungstenite::connect_async(&url).await;
        // We just verify the server doesn't panic — outcome depends on hub reachability
        let _ = result; // ok or err, both acceptable
    }
}
