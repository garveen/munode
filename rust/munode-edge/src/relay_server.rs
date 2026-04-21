//! Edge WebSocket server — combined control-relay and voice channel on `edge_port`.
//!
//! Every Edge starts a lightweight TCP/WebSocket listener on the same port number as
//! its UDP `edge_port` (UDP and TCP share the port number but are distinct protocols).
//! Two WebSocket paths are served:
//!
//! - `/relay` — transparent Hub proxy relay (unchanged behaviour from the old relay server)
//! - `/voice` — direct Edge-to-Edge voice channel for `DirectTcp` routing
//!
//! ## Relay Authentication (Challenge-Response)
//!
//! When the Edge is configured with an `hmac_secret`, incoming `/relay` and `/voice`
//! connections must complete a challenge-response handshake immediately after the
//! WebSocket upgrade.  This replaces the previous timestamp-based token scheme,
//! eliminating all dependency on clock synchronisation between nodes.
//!
//! Protocol (server = Edge-B relay, client = Edge-A connecting):
//!
//! ```text
//!   Server → Client : Binary frame  [0xC1][nonce(32 random bytes)]
//!   Client → Server : Binary frame  [0xC2][HMAC-SHA256(secret, nonce)(32 bytes)]
//! ```
//!
//! The server generates a cryptographically random 32-byte nonce per connection,
//! sends it as the first WebSocket frame, and verifies the client's HMAC response
//! before relaying any traffic.  The nonce is single-use, providing natural replay
//! protection without requiring clock agreement.  Connections that fail or time out
//! during the handshake are closed immediately.
//!
//! ```text
//!   Edge A (cannot reach Hub)
//!        │ ws://edge-b-host:edge_port/relay  (challenge-response handshake first)
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
use tracing::{debug, error, info, trace, warn};

use crate::state::{EdgeEvent, EdgeState};

type WsMessage = tokio_tungstenite::tungstenite::Message;
type WsError = tokio_tungstenite::tungstenite::Error;

/// Idle timeout for relay connections: drop connections that carry no traffic
/// for this duration. This prevents resource leaks from stale/zombie relays.
const RELAY_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Voice TCP connection channel buffer size.
const VOICE_TCP_CHAN_BUF: usize = 256;

/// Length of the auth nonce in bytes (256-bit random value).
const RELAY_AUTH_NONCE_LEN: usize = 32;
/// Length of the HMAC-SHA256 output in bytes.
const RELAY_AUTH_HMAC_LEN: usize = 32;
/// Magic byte prefixing the server challenge frame.
const RELAY_CHALLENGE_MAGIC: u8 = 0xC1;
/// Magic byte prefixing the client response frame.
const RELAY_RESPONSE_MAGIC: u8 = 0xC2;
/// Maximum time allowed for the challenge-response handshake to complete.
const RELAY_AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// Server-side challenge-response handshake.
///
/// Sends a random nonce to the client and verifies the HMAC-SHA256 response.
/// Returns `Ok(())` on success; the caller should close the connection on error.
pub(crate) async fn relay_auth_server<S>(
    ws: &mut tokio_tungstenite::WebSocketStream<S>,
    secret: &str,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use futures_util::{SinkExt, StreamExt};
    use ring::{hmac, rand::{self, SecureRandom}};

    // Generate a cryptographically random nonce.
    let rng = rand::SystemRandom::new();
    let mut nonce = [0u8; RELAY_AUTH_NONCE_LEN];
    rng.fill(&mut nonce)
        .map_err(|_| anyhow::anyhow!("failed to generate auth nonce"))?;

    // Send challenge: [CHALLENGE_MAGIC][nonce(32)]
    let mut challenge = Vec::with_capacity(1 + RELAY_AUTH_NONCE_LEN);
    challenge.push(RELAY_CHALLENGE_MAGIC);
    challenge.extend_from_slice(&nonce);
    ws.send(WsMessage::Binary(challenge.into()))
        .await
        .map_err(|e| anyhow::anyhow!("failed to send auth challenge: {}", e))?;

    // Wait for response with timeout.
    let msg = timeout(RELAY_AUTH_TIMEOUT, ws.next())
        .await
        .map_err(|_| anyhow::anyhow!("auth response timeout"))?
        .ok_or_else(|| anyhow::anyhow!("connection closed during auth"))?
        .map_err(|e| anyhow::anyhow!("error reading auth response: {}", e))?;

    let data = match msg {
        WsMessage::Binary(d) => d,
        _ => return Err(anyhow::anyhow!("unexpected auth frame type")),
    };
    if data.len() != 1 + RELAY_AUTH_HMAC_LEN || data[0] != RELAY_RESPONSE_MAGIC {
        return Err(anyhow::anyhow!("invalid auth response format"));
    }

    // Constant-time HMAC verification.
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let expected = hmac::sign(&key, &nonce);
    let received = &data[1..];
    let mismatch = expected
        .as_ref()
        .iter()
        .zip(received.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if mismatch != 0 {
        return Err(anyhow::anyhow!("auth failed: invalid token"));
    }
    Ok(())
}

/// Client-side challenge-response handshake.
///
/// Reads the server's nonce challenge and sends back the HMAC-SHA256 response.
/// Returns `Ok(())` on success; the caller should close the connection on error.
pub(crate) async fn relay_auth_client<S>(
    ws: &mut tokio_tungstenite::WebSocketStream<S>,
    secret: &str,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use futures_util::{SinkExt, StreamExt};
    use ring::hmac;

    // Receive challenge with timeout.
    let msg = timeout(RELAY_AUTH_TIMEOUT, ws.next())
        .await
        .map_err(|_| anyhow::anyhow!("auth challenge timeout"))?
        .ok_or_else(|| anyhow::anyhow!("connection closed before challenge"))?
        .map_err(|e| anyhow::anyhow!("error reading auth challenge: {}", e))?;

    let data = match msg {
        WsMessage::Binary(d) => d,
        _ => return Err(anyhow::anyhow!("unexpected challenge frame type")),
    };
    if data.len() != 1 + RELAY_AUTH_NONCE_LEN || data[0] != RELAY_CHALLENGE_MAGIC {
        return Err(anyhow::anyhow!("invalid challenge format"));
    }
    let nonce = &data[1..];

    // Compute and send HMAC response: [RESPONSE_MAGIC][hmac(32)]
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let hmac_bytes = hmac::sign(&key, nonce);
    let mut response = Vec::with_capacity(1 + RELAY_AUTH_HMAC_LEN);
    response.push(RELAY_RESPONSE_MAGIC);
    response.extend_from_slice(hmac_bytes.as_ref());
    ws.send(WsMessage::Binary(response.into()))
        .await
        .map_err(|e| anyhow::anyhow!("failed to send auth response: {}", e))?;
    Ok(())
}

/// Start the combined edge WebSocket server (relay + voice) on `edge_port`.
///
/// Binds to `0.0.0.0:edge_port` (TCP) and dispatches incoming WebSocket connections
/// by path:
/// - `/relay` → Hub proxy relay (for Edges that can't reach Hub directly)
/// - `/voice` → Edge-to-Edge voice delivery channel
///
/// When `hmac_secret` is `Some`, incoming `/relay` connections must include a
/// valid HMAC token in the query string (see module documentation).
///
/// This function never returns under normal operation.
pub async fn run_edge_ws_server(
    edge_port: u16,
    hub_host: String,
    hub_port: u16,
    hmac_secret: Option<String>,
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
    run_edge_ws_server_with_listener(listener, hub_host, hub_port, hmac_secret, edge_state).await;
}

/// Accept-loop variant that takes a pre-bound listener — used in tests to avoid
/// port conflicts by letting the OS pick a free port.
pub async fn run_edge_ws_server_with_listener(
    listener: TcpListener,
    hub_host: String,
    hub_port: u16,
    hmac_secret: Option<String>,
    edge_state: Arc<EdgeState>,
) {
    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                let hub_host = hub_host.clone();
                let hub_port = hub_port;
                let hmac_secret = hmac_secret.clone();
                let edge_state = edge_state.clone();
                tokio::spawn(async move {
                    // Capture the HTTP upgrade path via a header callback.
                    // Authentication is deferred to a challenge-response handshake
                    // at the WebSocket message level after the upgrade completes.
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
                            handle_voice_connection(
                                ws,
                                peer_addr,
                                edge_state,
                                hmac_secret.as_deref(),
                            )
                            .await;
                        }
                        _ => {
                            // Default: /relay or any unknown path → Hub proxy
                            debug!("Edge WS /relay connection from {}", peer_addr);
                            if let Err(e) = run_relay_for_ws(
                                ws,
                                peer_addr,
                                hub_host,
                                hub_port,
                                hmac_secret.as_deref(),
                            )
                            .await
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

/// Maximum size (bytes) for a single voice WebSocket frame.
/// Typical Opus voice frames are under 1 KB; anything above this limit is
/// either malicious or grossly malformed and should be dropped.
const MAX_VOICE_FRAME_SIZE: usize = 8192;

/// Handle an incoming `/voice` WebSocket connection from a peer Edge.
///
/// Protocol:
/// 1. First binary message = peer's `edge_id` (4 bytes BE).
/// 2. Subsequent binary messages:
///    - `[0x01][session_BE(4)][plaintext...]` → deliver locally via `RelayedVoice`.
///    - `[0x02][ttl(1)][target_BE(4)][session_BE(4)][plaintext...]` → relay (dropped for now).
async fn handle_voice_connection(
    mut ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    peer_addr: std::net::SocketAddr,
    edge_state: Arc<EdgeState>,
    hmac_secret: Option<&str>,
) {
    // Challenge-response auth before any voice traffic.
    if let Some(secret) = hmac_secret {
        if let Err(e) = relay_auth_server(&mut ws, secret).await {
            warn!("Voice TCP auth failed for {}: {}", peer_addr, e);
            return;
        }
    }

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

        // Reject oversized frames to prevent memory exhaustion from a
        // malicious or buggy peer.
        if data.len() > MAX_VOICE_FRAME_SIZE {
            warn!(
                "Voice conn from peer edge {}: frame too large ({} bytes), dropping",
                peer_edge_id,
                data.len()
            );
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

/// Keepalive ping interval for outbound peer voice TCP connections.
/// A WebSocket-level Ping is sent at this interval to detect silent TCP failures
/// (e.g. NAT table expiry with no RST) before the OS retransmission timeout fires.
const VOICE_TCP_KEEPALIVE: Duration = Duration::from_secs(30);

/// Minimum and maximum retry delay for the voice TCP reconnect loop.
const VOICE_TCP_MIN_RETRY_MS: u64 = 1_000;
const VOICE_TCP_MAX_RETRY_MS: u64 = 30_000;

/// Build a voice WebSocket URL.
///
/// Authentication is performed via challenge-response handshake at the WebSocket
/// message level after the upgrade completes — no query parameters are needed.
fn build_voice_url(peer_host: &str, peer_edge_port: u16) -> String {
    format!("ws://{}:{}/voice", peer_host, peer_edge_port)
}

/// Connect to a peer Edge's `/voice` WebSocket endpoint, establishing a pool of
/// `edge_state.peer_voice_tcp_pool_size` parallel connections for improved
/// reliability.
///
/// Each slot in the pool independently maintains its own TCP connection and
/// reconnects on failure with exponential back-off.  Outbound voice frames are
/// distributed round-robin across live slots, so a single slot failure leaves the
/// remaining connections available until it recovers.
///
/// The pool is torn down when `hub.peerLeft` fires (which removes the peer from
/// `voice_tcp_peers` and calls `pool.close_all()`).
pub async fn connect_peer_voice_tcp(
    peer_edge_id: u32,
    peer_host: String,
    peer_edge_port: u16,
    self_edge_id: u32,
    edge_state: Arc<EdgeState>,
    hmac_secret: Option<String>,
) {
    let pool_size = edge_state.peer_voice_tcp_pool_size;
    info!(
        "Voice TCP: establishing {}-slot pool to peer edge {} at {}:{}",
        pool_size, peer_edge_id, peer_host, peer_edge_port
    );

    // Mark this peer as one we want to stay connected to.  All slot reconnect
    // loops check this set; removing the ID triggers a graceful stop.
    edge_state.voice_tcp_peers.write().await.insert(peer_edge_id);

    // Create the pool up-front and publish it so callers (udp.rs) can send
    // immediately once any slot connects.
    let pool = Arc::new(crate::peer_registry::PeerVoiceTcpPool::new(pool_size));
    {
        let current = edge_state.voice_tcp_conns.load_full();
        let mut new_conns = (*current).clone();
        new_conns.insert(peer_edge_id, pool.clone());
        edge_state.voice_tcp_conns.store(Arc::new(new_conns));
    }

    // Spawn N independent slot tasks.
    let mut slot_handles = Vec::with_capacity(pool_size);
    for slot_idx in 0..pool_size {
        let peer_host_c = peer_host.clone();
        let secret_c = hmac_secret.clone();
        let state_c = edge_state.clone();
        let pool_c = pool.clone();
        let handle = tokio::spawn(async move {
            run_voice_tcp_slot(
                peer_edge_id,
                slot_idx,
                peer_host_c,
                peer_edge_port,
                self_edge_id,
                state_c,
                pool_c,
                secret_c,
            )
            .await;
        });
        slot_handles.push(handle);
    }

    // Wait for all slots to stop naturally.
    for h in slot_handles {
        let _ = h.await;
    }

    // Final cleanup — no-ops if peerLeft already removed us, but safe to call twice.
    edge_state.voice_tcp_peers.write().await.remove(&peer_edge_id);
    {
        let current = edge_state.voice_tcp_conns.load_full();
        let mut new_conns = (*current).clone();
        new_conns.remove(&peer_edge_id);
        edge_state.voice_tcp_conns.store(Arc::new(new_conns));
    }
    info!("Voice TCP pool for peer edge {} stopped", peer_edge_id);
}

/// Run the reconnect loop for a single pool slot.
///
/// Loops until the peer is removed from `voice_tcp_peers` (hub.peerLeft).
/// On each iteration it attempts one TCP voice connection; on failure it applies
/// exponential back-off before retrying.  On success it resets the back-off.
async fn run_voice_tcp_slot(
    peer_edge_id: u32,
    slot_idx: usize,
    peer_host: String,
    peer_edge_port: u16,
    self_edge_id: u32,
    edge_state: Arc<EdgeState>,
    pool: Arc<crate::peer_registry::PeerVoiceTcpPool>,
    hmac_secret: Option<String>,
) {
    let mut retry_ms = VOICE_TCP_MIN_RETRY_MS;
    // Track whether the previous attempt actually established a connection.
    // A slot that connected (sender was placed in the pool) and then dropped
    // is more likely a transient glitch than a slot that never connected at
    // all — so we grant one immediate retry before starting the backoff.
    let mut was_connected = false;

    loop {
        if !edge_state.voice_tcp_peers.read().await.contains(&peer_edge_id) {
            debug!(
                "Voice TCP slot [{}/{}]: peer left cluster, stopping",
                peer_edge_id, slot_idx
            );
            break;
        }

        let url = build_voice_url(&peer_host, peer_edge_port);

        let result =
            run_voice_tcp_once_pooled(
                peer_edge_id,
                slot_idx,
                &url,
                self_edge_id,
                pool.clone(),
                hmac_secret.as_deref(),
            )
            .await;

        // Always clear this slot's sender while reconnecting so the pool's
        // round-robin skips it rather than blocking on a dead channel.
        let did_connect = {
            let mut slot = pool.senders[slot_idx].lock().ok();
            let connected = slot.as_ref().map_or(false, |g| g.is_some());
            if let Some(ref mut g) = slot { **g = None; }
            connected
        };

        match result {
            Ok(()) => {
                // rx returned None — the sender was dropped by peerLeft→close_all().
                info!(
                    "Voice TCP slot [{}/{}]: connection ended by peer-left signal",
                    peer_edge_id, slot_idx
                );
                break;
            }
            Err(e) => {
                warn!("Voice TCP slot [{}/{}]: {}", peer_edge_id, slot_idx, e);
            }
        }

        if !edge_state.voice_tcp_peers.read().await.contains(&peer_edge_id) {
            break;
        }

        // Immediate retry: if the slot was connected before this failure (i.e.
        // it successfully established a TCP session that then dropped), retry
        // once without any delay — the failure is likely a transient TCP hiccup.
        // Only the very first retry after a live connection gets this treatment;
        // subsequent failures fall through to the normal exponential backoff.
        if did_connect && !was_connected {
            was_connected = true;
            debug!(
                "Voice TCP slot [{}/{}]: was connected, immediate retry",
                peer_edge_id, slot_idx
            );
            retry_ms = VOICE_TCP_MIN_RETRY_MS; // reset backoff for next failure
            continue;
        }

        was_connected = false;
        let delay = Duration::from_millis(retry_ms);
        debug!(
            "Voice TCP slot [{}/{}]: reconnecting in {:?}",
            peer_edge_id, slot_idx, delay
        );
        tokio::time::sleep(delay).await;
        retry_ms = (retry_ms.saturating_mul(2)).min(VOICE_TCP_MAX_RETRY_MS);
    }

    debug!("Voice TCP slot [{}/{}]: stopped", peer_edge_id, slot_idx);
}

/// Single connection attempt for one pool slot.
///
/// Connects, sends `self_edge_id`, stores the tx in `pool.senders[slot_idx]`, then
/// runs a writer loop (draining `rx`) with periodic keepalive pings.  A concurrent
/// reader task drains incoming WebSocket frames; if no frame arrives within
/// `VOICE_TCP_KEEPALIVE × 3`, the reader declares the connection dead and the
/// writer loop exits with an error.
///
/// Returns `Ok(())` when the peer-left signal fires (the sender is dropped via
/// `pool.close_all()`, causing `rx.recv()` to return `None`), or an `Err` on any
/// network or protocol error.
async fn run_voice_tcp_once_pooled(
    peer_edge_id: u32,
    slot_idx: usize,
    url: &str,
    self_edge_id: u32,
    pool: Arc<crate::peer_registry::PeerVoiceTcpPool>,
    hmac_secret: Option<&str>,
) -> anyhow::Result<()> {
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

    let mut ws =
        match timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url)).await {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => {
                return Err(anyhow::anyhow!("connect error: {}", e));
            }
            Err(_) => {
                return Err(anyhow::anyhow!("connect timed out after {:?}", CONNECT_TIMEOUT));
            }
        };

    // Challenge-response auth before sending any data.
    if let Some(secret) = hmac_secret {
        relay_auth_client(&mut ws, secret)
            .await
            .map_err(|e| anyhow::anyhow!("voice auth failed: {}", e))?;
    }

    let (mut write, read) = ws.split();

    // Announce our identity as the first frame.
    write
        .send(WsMessage::Binary(
            self_edge_id.to_be_bytes().to_vec().into(),
        ))
        .await
        .map_err(|e| anyhow::anyhow!("failed to send edge_id frame: {}", e))?;

    // Create the outbound frame channel and store it in the pool slot.
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(VOICE_TCP_CHAN_BUF);
    if let Ok(mut slot) = pool.senders[slot_idx].lock() {
        *slot = Some(tx);
    } else {
        return Err(anyhow::anyhow!("pool slot {} mutex poisoned", slot_idx));
    }
    info!(
        "Voice TCP slot [{}/{}]: connected ({})",
        peer_edge_id, slot_idx, url
    );

    // ── Reader task ──────────────────────────────────────────────────────────
    let reader_idle_timeout = VOICE_TCP_KEEPALIVE * 3;
    let (reader_done_tx, mut reader_done_rx) =
        tokio::sync::oneshot::channel::<anyhow::Result<()>>();

    let reader_handle = {
        tokio::spawn(async move {
            let mut fused_read = read;
            let result = loop {
                match timeout(reader_idle_timeout, fused_read.next()).await {
                    Ok(Some(Ok(WsMessage::Pong(_)))) => {
                        trace!(
                            "Voice TCP slot [{}/{}]: pong",
                            peer_edge_id, slot_idx
                        );
                    }
                    Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) => {
                        break Ok(());
                    }
                    Ok(Some(Err(e))) => {
                        break Err(anyhow::anyhow!("read error: {}", e));
                    }
                    Err(_) => {
                        break Err(anyhow::anyhow!(
                            "idle timeout: no data for {:?}",
                            reader_idle_timeout
                        ));
                    }
                    Ok(Some(Ok(_))) => {}
                }
            };
            let _ = reader_done_tx.send(result);
        })
    };

    // ── Writer loop with keepalive pings ─────────────────────────────────────
    let mut ping_timer = tokio::time::interval(VOICE_TCP_KEEPALIVE);
    ping_timer.tick().await; // consume the immediate first tick

    let result = loop {
        tokio::select! {
            biased;

            reader_result = &mut reader_done_rx => {
                let msg = match reader_result {
                    Ok(Ok(())) => "remote closed".to_string(),
                    Ok(Err(e)) => e.to_string(),
                    Err(_) => "reader task panicked".to_string(),
                };
                break Err(anyhow::anyhow!("reader: {}", msg));
            }

            frame = rx.recv() => {
                match frame {
                    Some(data) => {
                        if let Err(e) = write.send(WsMessage::Binary(data.into())).await {
                            break Err(anyhow::anyhow!("write error: {}", e));
                        }
                    }
                    None => {
                        // Sender was cleared by peerLeft → pool.close_all().
                        break Ok(());
                    }
                }
            }

            _ = ping_timer.tick() => {
                if let Err(e) = write.send(WsMessage::Ping(bytes::Bytes::new())).await {
                    break Err(anyhow::anyhow!("keepalive ping failed: {}", e));
                }
                debug!(
                    "Voice TCP slot [{}/{}]: keepalive ping sent",
                    peer_edge_id, slot_idx
                );
            }
        }
    };

    reader_handle.abort();
    result
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
    let mut pkt = Vec::with_capacity(1 + 5 + plaintext.len() - 1);
    pkt.push(header);
    crate::udp::write_mumble_varint(sender_session, &mut pkt);
    pkt.extend_from_slice(&plaintext[1..]);
    pkt
}

/// Handle a single proxy connection: upgrade to WebSocket, connect to Hub,
/// Relay an already-upgraded client WebSocket connection to the Hub.
///
/// Opens a new WebSocket connection to the Hub and relays frames bidirectionally
/// until either side closes or the connection is idle for [`RELAY_IDLE_TIMEOUT`].
async fn run_relay_for_ws(
    mut client_ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    peer_addr: std::net::SocketAddr,
    hub_host: String,
    hub_port: u16,
    hmac_secret: Option<&str>,
) -> Result<()> {
    // Challenge-response auth before proxying any traffic.
    if let Some(secret) = hmac_secret {
        relay_auth_server(&mut client_ws, secret)
            .await
            .map_err(|e| {
                warn!("Relay auth failed for {}: {}", peer_addr, e);
                e
            })?;
    }

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
    /// Perform a full challenge-response handshake over an in-memory duplex pair.
    async fn run_handshake(secret: &str) -> (anyhow::Result<()>, anyhow::Result<()>) {
        let (server_stream, client_stream) = tokio::io::duplex(4096);

        let (server_ws, client_ws) = tokio::join!(
            tokio_tungstenite::WebSocketStream::from_raw_socket(
                server_stream,
                tokio_tungstenite::tungstenite::protocol::Role::Server,
                None,
            ),
            tokio_tungstenite::WebSocketStream::from_raw_socket(
                client_stream,
                tokio_tungstenite::tungstenite::protocol::Role::Client,
                None,
            ),
        );

        let secret_s = secret.to_string();
        let secret_c = secret.to_string();
        let server_fut = async move {
            let mut ws = server_ws;
            super::relay_auth_server(&mut ws, &secret_s).await
        };
        let client_fut = async move {
            let mut ws = client_ws;
            super::relay_auth_client(&mut ws, &secret_c).await
        };
        tokio::join!(server_fut, client_fut)
    }

    /// Correct shared secret: both sides must succeed.
    #[tokio::test]
    async fn relay_auth_matching_secret_succeeds() {
        let (server_res, client_res) = run_handshake("shared-secret").await;
        assert!(server_res.is_ok(), "server: {:?}", server_res);
        assert!(client_res.is_ok(), "client: {:?}", client_res);
    }

    /// Wrong secret on client side: server must reject.
    #[tokio::test]
    async fn relay_auth_wrong_secret_rejected() {
        let (server_stream, client_stream) = tokio::io::duplex(4096);
        let (server_ws, client_ws) = tokio::join!(
            tokio_tungstenite::WebSocketStream::from_raw_socket(
                server_stream,
                tokio_tungstenite::tungstenite::protocol::Role::Server,
                None,
            ),
            tokio_tungstenite::WebSocketStream::from_raw_socket(
                client_stream,
                tokio_tungstenite::tungstenite::protocol::Role::Client,
                None,
            ),
        );

        let server_fut = async move {
            let mut ws = server_ws;
            super::relay_auth_server(&mut ws, "real-secret").await
        };
        let client_fut = async move {
            let mut ws = client_ws;
            // Client uses wrong secret → sends wrong HMAC
            super::relay_auth_client(&mut ws, "wrong-secret").await
        };
        let (server_res, _client_res) = tokio::join!(server_fut, client_fut);
        assert!(server_res.is_err(), "server should reject wrong HMAC");
    }
}

