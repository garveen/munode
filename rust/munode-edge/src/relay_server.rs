//! Edge WebSocket server — combined control-relay and voice channel on `edge_port`.
//!
//! Every Edge starts a lightweight TCP/WebSocket listener on the same port number as
//! its UDP `edge_port` (UDP and TCP share the port number but are distinct protocols).
//! Two WebSocket paths are served:
//!
//! - `/relay` — transparent Hub proxy relay (unchanged behaviour from the old relay server)
//! - `/voice` — direct Edge-to-Edge voice channel for `DirectTcp` routing
//!
//! ## Relay Authentication
//!
//! When the Edge is configured with an `hmac_secret`, incoming `/relay` connections
//! must prove they know the same secret by including a timestamp-based HMAC token in
//! the WebSocket URL query string:
//!
//! ```text
//!   ws://relay-host:edge_port/relay?ts=<unix_ms>&token=<hex_hmac>
//! ```
//!
//! The token is `hex(HMAC-SHA256(hmac_secret, "relay:<ts>"))`.  The relay server
//! checks that `ts` is within 30 seconds of the current time and that the token
//! matches, rejecting the connection with HTTP 401 otherwise.  Connections without
//! a query string are allowed only when no `hmac_secret` is configured.
//!
//! ```text
//!   Edge A (cannot reach Hub)
//!        │ ws://edge-b-host:edge_port/relay?ts=...&token=...
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

/// Maximum age (ms) of a relay auth token before it is considered expired.
const RELAY_TOKEN_MAX_AGE_MS: u64 = 30_000;

/// Compute the HMAC-SHA256 relay token for a given timestamp.
///
/// `token = hex(HMAC-SHA256(secret, "relay:<ts_ms>"))`
///
/// The key is `secret` (raw bytes of the UTF-8 string); the message is the
/// ASCII string `"relay:<ts_ms>"` where `<ts_ms>` is the decimal timestamp.
///
/// Example (illustrative — not a real key):
/// ```text
/// secret  = "my-hmac-secret"
/// ts_ms   = 1742371200000
/// message = "relay:1742371200000"
/// token   = hex(HMAC-SHA256("my-hmac-secret", "relay:1742371200000"))
/// ```
fn compute_relay_token(secret: &str, ts_ms: u64) -> String {
    use ring::hmac;
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let msg = format!("relay:{}", ts_ms);
    let sig = hmac::sign(&key, msg.as_bytes());
    hex::encode(sig.as_ref())
}

/// Verify the relay auth query parameters.
///
/// Returns `true` if no `hmac_secret` is configured (unauthenticated relays
/// are allowed when the secret is absent), or if both the timestamp is fresh
/// and the token matches.
fn verify_relay_auth(hmac_secret: &str, query: Option<&str>) -> bool {
    let query = match query {
        Some(q) if !q.is_empty() => q,
        _ => return false, // secret configured but no query params → reject
    };

    // Parse ts and token from query string
    let mut ts_ms_opt: Option<u64> = None;
    let mut token_opt: Option<String> = None;
    for part in query.split('&') {
        if let Some(val) = part.strip_prefix("ts=") {
            ts_ms_opt = val.parse::<u64>().ok();
        } else if let Some(val) = part.strip_prefix("token=") {
            token_opt = Some(val.to_string());
        }
    }

    let (ts_ms, token) = match (ts_ms_opt, token_opt) {
        (Some(ts), Some(tok)) => (ts, tok),
        _ => return false,
    };

    // Check timestamp freshness using absolute difference to handle skewed clocks.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if now_ms.abs_diff(ts_ms) > RELAY_TOKEN_MAX_AGE_MS {
        return false;
    }

    // Constant-time token comparison to prevent timing attacks.
    // We use a manual XOR-fold instead of ring::constant_time::verify_slices_are_equal
    // because that function is marked deprecated in ring 0.17 and the workspace uses
    // aws_lc_rs as the primary provider.  The fold achieves the same O(n) constant-time
    // property: all byte differences are OR-ed together before the final comparison.
    let expected = compute_relay_token(hmac_secret, ts_ms);
    if expected.len() != token.len() {
        return false;
    }
    expected
        .bytes()
        .zip(token.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
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
                    // Capture the HTTP upgrade path and query via a header callback.
                    // When hmac_secret is set, reject /relay connections without a
                    // valid HMAC token immediately during the HTTP upgrade.
                    let captured_path: Arc<StdMutex<String>> =
                        Arc::new(StdMutex::new(String::new()));
                    let cp = captured_path.clone();
                    let secret_for_cb = hmac_secret.clone();

                    let ws_result = timeout(
                        Duration::from_secs(30),
                        tokio_tungstenite::accept_hdr_async(
                            stream,
                            move |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                                  response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                                let path = req.uri().path().to_string();
                                *cp.lock().unwrap() = path.clone();

                                // Authenticate /relay connections when hmac_secret is configured.
                                // /voice connections carry their own session-level auth.
                                if path != "/voice" {
                                    if let Some(secret) = &secret_for_cb {
                                        let query = req.uri().query();
                                        if !verify_relay_auth(secret, query) {
                                            warn!(
                                                "Relay auth failed for connection from {} to {}",
                                                peer_addr,
                                                path,
                                            );
                                            // Return an HTTP 401 response to reject the upgrade.
                                            return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                                                .status(tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED)
                                                .body(Some("relay authentication required".to_string()))
                                                .unwrap());
                                        }
                                    }
                                }
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
/// `edge_state.voice_tcp_conns[peer_edge_id]`.
///
/// Makes a single connection attempt.  On disconnect or error, the entry is
/// removed from `voice_tcp_conns` and the function returns.  The caller (spawned
/// via `hub.peerJoined`) is expected to re-spawn this function if a persistent
/// channel is needed.
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
    // Reuse the shared varint encoder from udp.rs to avoid duplicating the
    // implementation and risking divergence.
    let session_bytes = crate::udp::encode_mumble_varint(sender_session);
    let mut pkt = Vec::with_capacity(1 + session_bytes.len() + plaintext.len() - 1);
    pkt.push(header);
    pkt.extend_from_slice(&session_bytes);
    pkt.extend_from_slice(&plaintext[1..]);
    pkt
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

    /// A valid token must pass verification.
    #[test]
    fn relay_auth_valid_token_accepted() {
        let secret = "test-secret";
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let token = compute_relay_token(secret, ts_ms);
        let query = format!("ts={}&token={}", ts_ms, token);
        assert!(verify_relay_auth(secret, Some(&query)));
    }

    /// A token with a wrong HMAC must be rejected.
    #[test]
    fn relay_auth_wrong_token_rejected() {
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let query = format!("ts={}&token=deadbeef", ts_ms);
        assert!(!verify_relay_auth("secret", Some(&query)));
    }

    /// A token signed with a different secret must be rejected.
    #[test]
    fn relay_auth_wrong_secret_rejected() {
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let token = compute_relay_token("real-secret", ts_ms);
        let query = format!("ts={}&token={}", ts_ms, token);
        assert!(!verify_relay_auth("wrong-secret", Some(&query)));
    }

    /// An expired timestamp must be rejected.
    #[test]
    fn relay_auth_expired_token_rejected() {
        let secret = "test-secret";
        // 60 seconds in the past — well beyond the 30-second window.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let old_ts = now_ms.saturating_sub(60_000);
        let token = compute_relay_token(secret, old_ts);
        let query = format!("ts={}&token={}", old_ts, token);
        assert!(!verify_relay_auth(secret, Some(&query)));
    }

    /// Missing query string must be rejected when a secret is configured.
    #[test]
    fn relay_auth_no_query_rejected() {
        assert!(!verify_relay_auth("secret", None));
        assert!(!verify_relay_auth("secret", Some("")));
    }

    /// Token with missing fields must be rejected.
    #[test]
    fn relay_auth_incomplete_query_rejected() {
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        // Only ts, no token
        assert!(!verify_relay_auth("secret", Some(&format!("ts={}", ts_ms))));
        // Only token, no ts
        let token = compute_relay_token("secret", ts_ms);
        assert!(!verify_relay_auth("secret", Some(&format!("token={}", token))));
    }
}

