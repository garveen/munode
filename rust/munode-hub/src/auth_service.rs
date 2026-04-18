//! Auth service WebSocket server.
//!
//! This module provides the Hub-side WebSocket server that external TypeScript
//! authentication services connect to. When a Mumble client attempts to
//! authenticate, the Hub forwards the request to the connected auth service
//! and waits for a response.
//!
//! # Protocol
//!
//! All messages use length-prefixed protobuf binary encoding wrapped in
//! WebSocket binary frames. The message type is defined in `AuthService.proto`.
//!
//! # Connection model
//!
//! Only ONE auth service connection is active at a time. If a new connection
//! arrives while one is active, the old connection is dropped.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{error, info, warn};

use munode_protocol::authservice::*;

/// Timeout waiting for an auth response from the service (seconds).
const AUTH_TIMEOUT_SECS: u64 = 10;

/// Channel buffer size for outbound messages to the auth service.
const OUTBOUND_BUFFER: usize = 256;

/// State tracked for each in-flight auth request.
///
/// Correlation with the incoming `AuthResponse` is done entirely via the
/// Hub-generated `request_id` (the map key).  The other fields exist purely
/// for diagnostics — they let timeout / disconnect / stale-response log
/// lines cross-reference the original Edge RPC so the whole auth flow can
/// be traced end-to-end without a separate correlation table.
struct PendingAuth {
    tx: oneshot::Sender<AuthResponse>,
    edge_request_id: String,
    username: String,
}

type PendingAuthMap = Mutex<HashMap<String, PendingAuth>>;

/// Shared handle to the auth service connection state.
/// This is cheap to clone (Arc<Mutex<...>> inside).
#[derive(Clone)]
pub struct AuthServiceHandle {
    inner: Arc<AuthServiceInner>,
}

struct AuthServiceInner {
    /// Monotonic counter for generating Hub-local auth request IDs.
    ///
    /// We deliberately do NOT reuse the Edge's RPC `request_id` as the
    /// correlation key here.  Edge-side IDs are only unique within one
    /// `HubClient` instance — each Edge has its own `AtomicU64` counter,
    /// independently reset to 0 on Edge restart — so any time two Edges'
    /// `{millis, counter}` pairs align, they mint the same string.  The
    /// risk is not limited to Edges that still have `counter == 0`:
    /// after a cluster cold start every Edge tends to walk the same
    /// startup RPC sequence (register → full sync → heartbeat) in
    /// near-lockstep, leaving their counters numerically close to their
    /// peers' (not necessarily zero), so subsequent auth RPCs on
    /// different Edges land in the same millisecond with matching
    /// counter values substantially more often than random traffic
    /// would.  Since this handle is shared by every Edge,
    /// `pending.insert` would then silently overwrite the earlier
    /// waiter and the next response to arrive would be delivered to the
    /// wrong caller — i.e. auth identities crossed between Edges.
    next_request_id: AtomicU64,
    /// Pending auth requests waiting for a response, keyed by a Hub-local ID.
    pending: PendingAuthMap,
    /// Sender to the currently connected auth service WebSocket writer.
    /// None when no service is connected.
    sender: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

impl AuthServiceHandle {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AuthServiceInner {
                next_request_id: AtomicU64::new(0),
                pending: Mutex::new(HashMap::new()),
                sender: Mutex::new(None),
            }),
        }
    }

    /// Mint a fresh, process-unique request ID for one auth exchange.
    fn next_request_id(&self) -> String {
        let n = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        format!("hub-{}", n)
    }

    /// Returns true if an auth service is currently connected.
    pub async fn is_connected(&self) -> bool {
        self.inner.sender.lock().await.is_some()
    }

    /// Send an auth request to the external service and await the response.
    ///
    /// Returns `None` if:
    /// - No auth service is connected.
    /// - The response timed out (>10 s).
    /// - The connection was dropped while waiting.
    pub async fn authenticate(&self, mut request: AuthRequest) -> Option<AuthResponse> {
        // Overwrite whatever `request_id` the caller supplied with one minted
        // here.  The external auth service echoes `request_id` verbatim, so
        // this becomes the correlation key on both sides of the wire — and
        // unlike the Edge-supplied value it is guaranteed unique across the
        // Hub's lifetime, across every connected Edge, and across Edge
        // restarts.  This closes the race where two Edges could submit
        // colliding IDs and have responses routed to the wrong waiter.
        //
        // The original Edge-supplied request_id is preserved in `PendingAuth`
        // so diagnostics can still stitch the Edge↔Hub and Hub↔auth-service
        // sides of the flow together in logs.
        let request_id = self.next_request_id();
        let edge_request_id = std::mem::take(&mut request.request_id);
        let username = request.username.clone();
        request.request_id = request_id.clone();

        // Register the pending waiter BEFORE sending so the response cannot
        // arrive and be dropped as "unknown" between send and insert.
        let (resp_tx, resp_rx) = oneshot::channel::<AuthResponse>();
        {
            let mut pending = self.inner.pending.lock().await;
            pending.insert(
                request_id.clone(),
                PendingAuth {
                    tx: resp_tx,
                    edge_request_id: edge_request_id.clone(),
                    username: username.clone(),
                },
            );
        }

        // Encode and send the AuthRequest packet.
        let packet = AuthServicePacket {
            r#type: AuthServicePacketType::AuthRequest as i32,
            auth_request: Some(request),
            auth_response: None,
            hello: None,
        };
        let data = packet.encode_to_vec();

        let send_ok = {
            let sender = self.inner.sender.lock().await;
            if let Some(tx) = sender.as_ref() {
                tx.send(data).await.is_ok()
            } else {
                false
            }
        };

        if !send_ok {
            // Clean up pending waiter and signal "not connected".
            self.inner.pending.lock().await.remove(&request_id);
            return None;
        }

        // Await the response with a hard timeout.
        match tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECS), resp_rx).await {
            Ok(Ok(response)) => Some(response),
            Ok(Err(_)) => {
                warn!(
                    "Auth response channel closed: hub_request_id={} edge_request_id={} user={}",
                    request_id, edge_request_id, username
                );
                None
            }
            Err(_) => {
                warn!(
                    "Auth request timed out: hub_request_id={} edge_request_id={} user={}",
                    request_id, edge_request_id, username
                );
                self.inner.pending.lock().await.remove(&request_id);
                None
            }
        }
    }

    /// Deliver a received AuthResponse to the waiting caller.
    async fn deliver_response(&self, response: AuthResponse) {
        let request_id = response.request_id.clone();
        let entry = self.inner.pending.lock().await.remove(&request_id);
        match entry {
            Some(pending) => {
                let _ = pending.tx.send(response);
            }
            None => {
                warn!(
                    "Received auth response for unknown hub_request_id={} \
                     (expired, duplicate, or from a stale connection)",
                    request_id
                );
            }
        }
    }

    /// Register a new outbound sender (called when a new connection is accepted).
    async fn set_sender(&self, sender: Option<mpsc::Sender<Vec<u8>>>) {
        *self.inner.sender.lock().await = sender;
    }

    /// Fail all pending requests (called when the connection is lost).
    async fn drain_pending(&self) {
        /// How many individual pending entries to enumerate in the disconnect
        /// log line before falling back to an aggregate count.  An Edge
        /// allows 32 concurrent auth RPCs locally, so a multi-Edge fleet can
        /// accumulate hundreds of pending entries if the auth service drops;
        /// enumerating them all would produce an unreadable multi-kilobyte
        /// warn line.
        const SUMMARY_CAP: usize = 8;

        let entries: Vec<(String, PendingAuth)> = {
            let mut pending = self.inner.pending.lock().await;
            pending.drain().collect()
        };
        if entries.is_empty() {
            return;
        }
        let total = entries.len();
        let shown = total.min(SUMMARY_CAP);
        let summary = entries
            .iter()
            .take(shown)
            .map(|(hub_id, p)| {
                format!(
                    "{{hub_id={} edge_request_id={} user={}}}",
                    hub_id, p.edge_request_id, p.username
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if total > shown {
            warn!(
                "{} pending auth request(s) cancelled due to auth service disconnect: \
                 [{}, … and {} more]",
                total,
                summary,
                total - shown,
            );
        } else {
            warn!(
                "{} pending auth request(s) cancelled due to auth service disconnect: [{}]",
                total, summary,
            );
        }
        // Dropping `entries` drops every `PendingAuth.tx`, which signals Err
        // to each waiter in `authenticate()`.
    }

    /// Handle an active WebSocket connection from an auth service.
    async fn handle_connection(
        &self,
        ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        addr: std::net::SocketAddr,
    ) {
        info!("Auth service connected from {}", addr);

        let (mut ws_tx, mut ws_rx) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_BUFFER);

        // Register this connection's sender.
        self.set_sender(Some(tx.clone())).await;

        // Spawn writer task.
        let write_task = tokio::spawn(async move {
            while let Some(data) = rx.recv().await {
                if let Err(e) = ws_tx.send(WsMessage::Binary(data.into())).await {
                    error!("Auth service write error: {}", e);
                    break;
                }
            }
        });

        // Process inbound messages.
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(WsMessage::Binary(data)) => {
                    match AuthServicePacket::decode(data.as_ref()) {
                        Ok(packet) => {
                            self.handle_packet(packet, &tx).await;
                        }
                        Err(e) => {
                            warn!("Failed to decode auth service packet from {}: {}", addr, e);
                        }
                    }
                }
                Ok(WsMessage::Close(_)) => {
                    info!("Auth service disconnected: {}", addr);
                    break;
                }
                Ok(WsMessage::Ping(payload)) => {
                    // tokio-tungstenite auto-responds to Pong for WS-level pings.
                    // This is an application-level ping inside our binary frame.
                    let _ = tx
                        .send(
                            AuthServicePacket {
                                r#type: AuthServicePacketType::Pong as i32,
                                ..Default::default()
                            }
                            .encode_to_vec(),
                        )
                        .await;
                    let _ = payload; // suppress unused warning
                }
                Err(e) => {
                    error!("Auth service WS error from {}: {}", addr, e);
                    break;
                }
                _ => {}
            }
        }

        // Clean up on disconnect.
        self.set_sender(None).await;
        self.drain_pending().await;
        write_task.abort();
        info!("Auth service connection closed: {}", addr);
    }

    /// Dispatch a decoded packet.
    async fn handle_packet(&self, packet: AuthServicePacket, reply_tx: &mpsc::Sender<Vec<u8>>) {
        match AuthServicePacketType::try_from(packet.r#type) {
            Ok(AuthServicePacketType::AuthResponse) => {
                if let Some(response) = packet.auth_response {
                    self.deliver_response(response).await;
                }
            }
            Ok(AuthServicePacketType::Hello) => {
                if let Some(hello) = packet.hello {
                    info!(
                        "Auth service hello: name={}, version={}",
                        hello.service_name,
                        hello.version.as_deref().unwrap_or("unknown")
                    );
                }
            }
            Ok(AuthServicePacketType::Ping) => {
                let pong = AuthServicePacket {
                    r#type: AuthServicePacketType::Pong as i32,
                    ..Default::default()
                };
                let _ = reply_tx.send(pong.encode_to_vec()).await;
            }
            Ok(AuthServicePacketType::Pong) => {
                // No action needed for pong responses.
            }
            Ok(AuthServicePacketType::Unknown) | Err(_) => {
                warn!("Received unknown packet type: {}", packet.r#type);
            }
            Ok(AuthServicePacketType::AuthRequest) => {
                warn!("Auth service unexpectedly sent an AuthRequest — ignoring");
            }
        }
    }
}

/// Start the auth service WebSocket listener.
///
/// Runs indefinitely, accepting connections and handing them to `handle`.
/// Only one connection is served at a time; a new connection replaces the old one.
pub async fn run_auth_service_listener(addr: String, handle: AuthServiceHandle) -> Result<()> {
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| anyhow::anyhow!("Auth service bind error on {}: {}", addr, e))?;

    info!("Auth service WS listener on ws://{}", addr);

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let handle = handle.clone();
                tokio::spawn(async move {
                    match tokio_tungstenite::accept_async(stream).await {
                        Ok(ws_stream) => {
                            handle.handle_connection(ws_stream, addr).await;
                        }
                        Err(e) => {
                            error!("Auth service WS handshake failed from {}: {}", addr, e);
                        }
                    }
                });
            }
            Err(e) => {
                error!("Auth service accept error: {}", e);
            }
        }
    }
}
