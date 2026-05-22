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
//! Only ONE auth service connection is treated as active at a time. A
//! monotonic generation counter is bumped on each new connection; only the
//! connection whose generation still matches the counter owns the shared
//! `sender` slot. Pending auth requests are tagged with the generation they
//! were sent on, so ownership and cleanup are per-generation:
//!
//! - An `authenticate` call snapshots the current `(sender, gen)` pair under
//!   the sender lock, tags its waiter with that `gen`, then sends outside the
//!   lock.
//! - When a connection's read loop exits, its teardown drains waiters tagged
//!   with its own `gen` (they can no longer complete through this
//!   now-defunct connection), then clears the `sender` slot only if it's
//!   still the current connection. A superseded connection's teardown leaves
//!   the `sender` slot alone — the newer connection owns it.
//! - A superseded connection whose WebSocket is still alive keeps delivering
//!   any late `AuthResponse`s it receives via the shared `pending` map,
//!   routed by `request_id` — so in-flight requests that were sent on it
//!   before it was superseded still have a chance to complete until their
//!   connection's own teardown fires.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, mpsc, oneshot};
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
///
/// `generation` tags the connection the request was dispatched on.  Teardown
/// only cancels waiters whose generation matches the closing connection's own
/// generation, so a superseded-but-still-alive connection can still deliver
/// late responses for entries it sent.
struct PendingAuth {
    generation: u64,
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
    /// Monotonic generation counter. Incremented on every new connection;
    /// a connection only owns the sender / pending state while its generation
    /// still matches. See `handle_connection` for the usage pattern.
    active_conn_gen: AtomicU64,
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

impl Default for AuthServiceHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthServiceHandle {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AuthServiceInner {
                active_conn_gen: AtomicU64::new(0),
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

        let (resp_tx, resp_rx) = oneshot::channel::<AuthResponse>();

        // Encode the packet before acquiring any lock.
        let packet = AuthServicePacket {
            r#type: AuthServicePacketType::AuthRequest as i32,
            auth_request: Some(request),
            auth_response: None,
            hello: None,
        };
        let data = packet.encode_to_vec();

        // Under the sender lock, snapshot the current generation and clone the
        // outbound sender, then register our waiter tagged with that same
        // generation. Holding the sender lock across the generation load and
        // the pending insert makes the (gen, sender) pair consistent: teardown
        // that advances the generation also holds this lock, so it cannot
        // race us into registering against a stale generation. We release the
        // sender lock before the `tx.send(...).await` so a slow writer cannot
        // block connection handover.
        let tx_clone = {
            let sender_guard = self.inner.sender.lock().await;
            let tx = sender_guard.as_ref()?;
            let generation = self.inner.active_conn_gen.load(Ordering::Relaxed);
            {
                let mut pending = self.inner.pending.lock().await;
                pending.insert(
                    request_id.clone(),
                    PendingAuth {
                        generation,
                        tx: resp_tx,
                        edge_request_id: edge_request_id.clone(),
                        username: username.clone(),
                    },
                );
            }
            tx.clone()
        };

        if tx_clone.send(data).await.is_err() {
            // Target connection's writer has gone away. Remove our waiter
            // (if teardown hasn't already) and bail.
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

    /// Fail pending requests belonging to a specific connection generation.
    ///
    /// Only entries whose `generation` matches `my_gen` are removed; entries
    /// for other generations are left untouched — they belong to a superseded
    /// sibling that is still alive or to a future connection.
    async fn drain_pending(&self, my_gen: u64) {
        /// How many individual pending entries to enumerate in the disconnect
        /// log line before falling back to an aggregate count.  An Edge
        /// allows 32 concurrent auth RPCs locally, so a multi-Edge fleet can
        /// accumulate hundreds of pending entries if the auth service drops;
        /// enumerating them all would produce an unreadable multi-kilobyte
        /// warn line.
        const SUMMARY_CAP: usize = 8;

        let entries: Vec<(String, PendingAuth)> = {
            let mut pending = self.inner.pending.lock().await;
            let keys: Vec<String> = pending
                .iter()
                .filter(|(_, v)| v.generation == my_gen)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| pending.remove(&k).map(|v| (k, v)))
                .collect()
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
                "{} pending auth request(s) cancelled due to auth service disconnect \
                 (gen={}): [{}, \u{2026} and {} more]",
                total,
                my_gen,
                summary,
                total - shown,
            );
        } else {
            warn!(
                "{} pending auth request(s) cancelled due to auth service disconnect \
                 (gen={}): [{}]",
                total, my_gen, summary,
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
        let (mut ws_tx, mut ws_rx) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_BUFFER);

        // Atomic claim: bump the generation counter and install this
        // connection's sender under one sender-lock critical section.
        // `authenticate` also reads the generation and clones the sender
        // under this same lock, so an external observer can never see
        // `(gen advanced, sender still old)`. `Relaxed` is sufficient because
        // all accesses to `active_conn_gen` happen inside this mutex — the
        // mutex itself provides the ordering and visibility guarantees.
        let my_gen = {
            let mut sender_guard = self.inner.sender.lock().await;
            let g = self.inner.active_conn_gen.fetch_add(1, Ordering::Relaxed) + 1;
            *sender_guard = Some(tx.clone());
            g
        };
        info!("Auth service connected from {} (gen={})", addr, my_gen);

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
                Ok(WsMessage::Binary(data)) => match AuthServicePacket::decode(data.as_ref()) {
                    Ok(packet) => {
                        self.handle_packet(packet, &tx).await;
                    }
                    Err(e) => {
                        warn!("Failed to decode auth service packet from {}: {}", addr, e);
                    }
                },
                Ok(WsMessage::Close(_)) => {
                    info!("Auth service disconnected: {} (gen={})", addr, my_gen);
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
                    error!(
                        "Auth service WS error from {} (gen={}): {}",
                        addr, my_gen, e
                    );
                    break;
                }
                _ => {}
            }
        }

        // Teardown step 1 — stop handing our sender to new callers.
        // Clear the sender slot first (only if we're still the current
        // connection) so `authenticate()` cannot continue to snapshot our
        // now-dead `tx`. A newer connection that has already claimed the
        // slot owns `sender`; leaving it alone is correct for that case.
        let was_current = {
            let mut sender_guard = self.inner.sender.lock().await;
            if self.inner.active_conn_gen.load(Ordering::Relaxed) == my_gen {
                *sender_guard = None;
                true
            } else {
                false
            }
        };

        // Teardown step 2 — sever the writer pipe. Aborting the writer task
        // drops the `rx` end of the mpsc channel, so any `tx.send(...).await`
        // from an `authenticate()` that slipped in during the tiny window
        // between its sender-lock release and our sender-lock acquisition
        // fails immediately. Combined with step 3, that call's waiter will
        // be removed too, so it returns `None` rather than quietly queueing
        // data to a dead peer.
        write_task.abort();

        // Teardown step 3 — cancel waiters tagged with our generation. They
        // can no longer complete through this connection. Entries tagged
        // with other generations are left alone: they belong either to a
        // superseded sibling that's still reading or to a future connection
        // that hasn't been born yet.
        self.drain_pending(my_gen).await;

        if was_current {
            info!(
                "Auth service connection closed: {} (gen={}, was current)",
                addr, my_gen
            );
        } else {
            info!(
                "Auth service connection closed: {} (gen={}, superseded)",
                addr, my_gen
            );
        }
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
