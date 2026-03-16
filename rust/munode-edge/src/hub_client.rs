use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::time;
use tokio_tungstenite::tungstenite;
use tracing::{debug, error, info, trace, warn};

use munode_common::config::{EdgeConfig, HubServerConfig};
use munode_protocol::message_type::MessageType;
use munode_protocol::hubedge::{
    self, EdgeAuthenticateUserParams, EdgeFullSyncParams,
    EdgeHandleAclParams, EdgePluginDataTransmissionParams,
    EdgeHubPacket, EdgeJoinCompleteParams, EdgeJoinParams, EdgeRegisterParams,
    BlobPutParams, BlobGetParams, BlobGetUserTextureParams, BlobGetUserCommentParams,
    BlobSetUserTextureParams, BlobSetUserCommentParams,
    PacketType, TypedRpcNotification, TypedRpcRequest, TypedRpcResponse,
    EdgeHandleUserLeftParams, EdgeHandleUserRemoveParams, EdgeHandleUserMovedParams,
    EdgeHandleUserStateChangedParams, EdgeHandleTextMessageParams,
    EdgeHandleChannelStateParams, EdgeHandleChannelRemoveParams,
    EdgeReportSessionParams, GlobalSessionProto,
    EdgeContextActionParams,
};

use crate::channel_manager::{ChannelData, RemoteUser};
use crate::state::{EdgeEvent, EdgeState, PeerEdgeInfo};

/// Maximum time to wait for the primary pool slot to register before bringing
/// up secondary slots.  100ms × 100 = 10 seconds.
const SECONDARY_SLOT_WAIT_POLL_INTERVAL_MS: u64 = 100;
const SECONDARY_SLOT_WAIT_MAX_POLLS: u32 = 100;

/// Exponential backoff helper for reconnection loops.
///
/// Starts at `base_ms` milliseconds and doubles on each failed attempt, up to
/// a maximum of 30 seconds.  A successful connection resets the counter to zero.
/// Minimum allowed base delay in milliseconds.  Prevents accidentally-zero intervals
/// (e.g. when `reconnect_interval = 0` is set in config) from causing a tight reconnect loop.
const MIN_BACKOFF_MS: u64 = 100;

struct ExponentialBackoff {
    base_ms: u64,
    current_ms: u64,
    attempt: u32,
}

impl ExponentialBackoff {
    const MAX_DELAY_MS: u64 = 30_000;

    fn new(base_ms: u64) -> Self {
        let base_ms = base_ms.max(MIN_BACKOFF_MS); // enforce minimum
        Self { base_ms, current_ms: base_ms, attempt: 0 }
    }

    /// Return the delay for the next reconnect attempt and advance the counter.
    fn next_delay(&mut self) -> Duration {
        let delay = self.current_ms;
        self.attempt += 1;
        // Double the delay on every failure, capped at MAX_DELAY_MS.
        self.current_ms = (self.current_ms.saturating_mul(2)).min(Self::MAX_DELAY_MS);
        Duration::from_millis(delay)
    }

    /// Reset the backoff after a successful connection.
    fn reset(&mut self) {
        self.attempt = 0;
        self.current_ms = self.base_ms;
    }
}

/// Connection state for the Hub client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HubConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Registered,
}

/// Pending RPC request waiting for response.
struct PendingRequest {
    tx: oneshot::Sender<Result<TypedRpcResponse, String>>,
}

/// Client for communicating with the Hub server via WebSocket + protobuf.
///
/// When `pool_size > 1`, multiple parallel WebSocket connections are maintained.
/// RPC requests are distributed across connections in round-robin order.
/// Hub-to-Edge notifications (push events) are only processed on the primary
/// connection (slot 0) to avoid duplicate state updates.
pub struct HubClient {
    config: HubServerConfig,
    server_id: u32,
    server_name: String,
    /// External host advertised to Hub and broadcast to peer Edges.
    external_host: String,
    /// Effective external port for Mumble client connections (NAT-mapped).
    external_port: u16,
    /// Effective port for Edge-to-Edge TLS connections.
    edge_port: u16,
    /// Geographic region identifier.
    region: Option<String>,
    /// Maximum number of users for this Edge.
    capacity: u32,
    /// Statically configured peers for bootstrap relay (from config).
    /// These are tried first before dynamically-discovered peers.
    static_relay_peers: Vec<(String, u16)>,
    state: RwLock<HubConnectionState>,
    edge_state: Arc<EdgeState>,
    /// Pending RPC requests awaiting responses (shared across all pool slots).
    pending: Mutex<HashMap<String, PendingRequest>>,
    /// Number of pool connections to maintain (1 = no pool, >1 = pool mode).
    pool_size: usize,
    /// Per-slot send channels.  Index 0 is the primary (handles notifications).
    pool_senders: Vec<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    /// Round-robin index for distributing sends across pool slots.
    pool_rr: AtomicUsize,
    /// Counter for generating unique request IDs.
    request_counter: Mutex<u64>,
    /// Time when this HubClient was created (for uptime reporting).
    start_time: Instant,
}

impl HubClient {
    pub fn new(
        config: &EdgeConfig,
        edge_state: Arc<EdgeState>,
    ) -> Arc<Self> {
        let external_port = config.network.external_port.unwrap_or(config.network.port);
        let edge_port = config.network.edge_port.unwrap_or(config.network.port + 1);
        let pool_size = config.hub_server.pool_size.max(1) as usize;
        let pool_senders = (0..pool_size).map(|_| Mutex::new(None)).collect();
        // Static peers from config (for bootstrap before Hub connection).
        let static_relay_peers: Vec<(String, u16)> = config
            .hub_server
            .static_peers
            .iter()
            .map(|p| (p.host.clone(), p.relay_port))
            .collect();
        Arc::new(Self {
            config: config.hub_server.clone(),
            server_id: config.server_id,
            server_name: config.name.clone(),
            external_host: config.network.external_host.clone(),
            external_port,
            edge_port,
            region: config.network.region.clone(),
            capacity: config.server.capacity,
            static_relay_peers,
            state: RwLock::new(HubConnectionState::Disconnected),
            edge_state,
            pending: Mutex::new(HashMap::new()),
            pool_size,
            pool_senders,
            pool_rr: AtomicUsize::new(0),
            request_counter: Mutex::new(0),
            start_time: Instant::now(),
        })
    }

    pub async fn state(&self) -> HubConnectionState {
        *self.state.read().await
    }

    /// Get the current edge ID (our registered ID from Hub, or fallback to server_id).
    fn edge_id(&self) -> u32 {
        let id = self.edge_state.get_edge_id();
        if id != 0 { id } else { self.server_id }
    }

    /// Generate a unique request ID.
    async fn next_request_id(&self) -> String {
        let mut counter = self.request_counter.lock().await;
        *counter += 1;
        format!("{}-{}", current_millis(), *counter)
    }

    /// Connect to the Hub and run the main communication loop with reconnection.
    ///
    /// When `pool_size > 1`, the primary connection (slot 0) is established first
    /// so the Edge can register and do a full sync.  Then secondary connections are
    /// started in background tasks.  Reconnection works per-slot independently.
    pub async fn connect_and_run(self: &Arc<Self>) -> Result<()> {
        if self.pool_size == 1 {
            // Single-connection mode: original behaviour.
            self.run_single_slot(0, true).await;
        } else {
            info!("Hub connection pool mode: {} slots", self.pool_size);
            // Start the primary slot first and wait for it to register.
            self.run_primary_slot_init().await?;
            // Start remaining slots in background (they only need to authenticate,
            // not do full sync / cluster join, since the primary already did that).
            for slot in 1..self.pool_size {
                let me = self.clone();
                tokio::spawn(async move {
                    me.run_secondary_slot(slot).await;
                });
            }
            // Keep primary alive with reconnection loop (exponential backoff).
            let mut backoff = ExponentialBackoff::new(self.config.reconnect_interval);
            loop {
                match self.try_connect_slot(0, true).await {
                    Ok(()) => {
                        info!("Primary Hub connection closed, reconnecting…");
                        backoff.reset();
                    }
                    Err(e) => error!("Primary Hub connection error: {}", e),
                }
                self.clear_slot(0).await;
                // If ALL slots are gone, the edge is fully disconnected.
                if !self.any_slot_connected().await {
                    *self.state.write().await = HubConnectionState::Disconnected;
                    self.pending.lock().await.clear();
                    self.edge_state.emit(EdgeEvent::HubDisconnected);
                }
                let delay = backoff.next_delay();
                warn!("Primary: reconnecting to Hub in {:?}", delay);
                time::sleep(delay).await;
            }
        }
        Ok(())
    }

    /// Run the single-slot (no pool) reconnect loop with exponential backoff.
    ///
    /// After `RELAY_FALLBACK_THRESHOLD` consecutive direct-connect failures,
    /// attempts to connect via a known peer Edge's control-relay port.
    /// Relay candidates are tried in priority order:
    ///   1. Statically configured peers (`hub_server.static_peers` in config)
    ///   2. Dynamically discovered peers (received via `hub.peerJoined` notifications)
    async fn run_single_slot(self: &Arc<Self>, slot: usize, is_primary: bool) {
        let mut backoff = ExponentialBackoff::new(self.config.reconnect_interval);
        let mut direct_fail_count: u32 = 0;
        const RELAY_FALLBACK_THRESHOLD: u32 = 3;

        loop {
            // After several consecutive direct failures, try relay via a peer Edge.
            let use_relay = direct_fail_count >= RELAY_FALLBACK_THRESHOLD;
            let connect_result = if use_relay {
                self.try_connect_via_relay(slot, is_primary).await
            } else {
                self.try_connect_slot(slot, is_primary).await
            };

            match connect_result {
                Ok(()) => {
                    info!("Hub connection closed normally");
                    backoff.reset();
                    direct_fail_count = 0;
                }
                Err(e) => {
                    error!("Hub connection error: {}", e);
                    if !use_relay {
                        direct_fail_count += 1;
                        if direct_fail_count == RELAY_FALLBACK_THRESHOLD {
                            info!(
                                "Direct Hub connection failed {} times — \
                                 will try peer relay on next attempt",
                                direct_fail_count
                            );
                        }
                    } else {
                        // Relay also failed — Hub is completely unreachable.
                        // Signal that all connected clients should be disconnected.
                        warn!("Hub relay connection also failed — Hub is unreachable, disconnecting all clients");
                        self.edge_state.emit(EdgeEvent::HubUnreachable);
                    }
                }
            }
            // Clean up state
            *self.state.write().await = HubConnectionState::Disconnected;
            self.clear_slot(slot).await;
            self.pending.lock().await.clear();
            self.edge_state.emit(EdgeEvent::HubDisconnected);

            let delay = backoff.next_delay();
            warn!("Reconnecting to Hub in {:?}", delay);
            time::sleep(delay).await;
        }
    }

    /// Try to connect to Hub via a peer Edge's control-relay port.
    ///
    /// Candidates are tried in priority order:
    ///   1. Static peers from `hub_server.static_peers` (available before Hub connection)
    ///   2. Dynamic peers discovered via `hub.peerJoined` notifications
    ///
    /// Returns `Ok(())` if a relay connection ran and closed normally, or an error if all
    /// candidates failed.
    async fn try_connect_via_relay(self: &Arc<Self>, slot: usize, is_primary: bool) -> Result<()> {
        // 1. Static peers from config (for bootstrap before Hub connection)
        for (host, relay_port) in &self.static_relay_peers {
            let relay_url = format!("ws://{}:{}", host, relay_port);
            info!("Attempting Hub relay via static peer at {}", relay_url);
            match self.try_connect_via_url(&relay_url, slot, is_primary).await {
                Ok(()) => {
                    info!("Static peer relay connection ({}) closed normally", relay_url);
                    return Ok(());
                }
                Err(e) => {
                    warn!("Static peer relay via {} failed: {}", relay_url, e);
                }
            }
        }

        // 2. Dynamically discovered peers (from hub.peerJoined notifications)
        let dynamic_peers = self.edge_state.peer_registry.read().await.relay_peers();
        if dynamic_peers.is_empty() && self.static_relay_peers.is_empty() {
            return Err(anyhow::anyhow!("No relay peers available"));
        }
        for (peer_id, host, relay_port) in &dynamic_peers {
            let relay_url = format!("ws://{}:{}", host, relay_port);
            info!("Attempting Hub relay via peer {} at {}", peer_id, relay_url);
            match self.try_connect_via_url(&relay_url, slot, is_primary).await {
                Ok(()) => {
                    info!("Dynamic peer relay (peer {}) closed normally", peer_id);
                    return Ok(());
                }
                Err(e) => {
                    warn!("Dynamic peer relay via {} failed: {}", relay_url, e);
                }
            }
        }
        Err(anyhow::anyhow!("All relay attempts failed"))
    }

    /// Connect via a specific WebSocket URL (used for both direct and relay connections).
    async fn try_connect_via_url(self: &Arc<Self>, url: &str, slot: usize, is_primary: bool) -> Result<()> {
        *self.state.write().await = HubConnectionState::Connecting;
        info!("Connecting to Hub via {} (slot {})", url, slot);

        let (ws_stream, _) = tokio_tungstenite::connect_async(url)
            .await
            .with_context(|| format!("Failed to connect to Hub WebSocket via {} (slot {})", url, slot))?;

        info!("WebSocket connected via {} (slot {})", url, slot);
        if is_primary {
            *self.state.write().await = HubConnectionState::Connected;
        }

        let (mut ws_write, mut ws_read) = ws_stream.split();

        let (send_tx, mut send_rx) = mpsc::channel::<Vec<u8>>(256);
        if let Some(s) = self.pool_senders.get(slot) {
            *s.lock().await = Some(send_tx);
        }

        let writer_handle = tokio::spawn(async move {
            while let Some(data) = send_rx.recv().await {
                if let Err(e) = ws_write.send(tungstenite::Message::Binary(Bytes::from(data))).await {
                    error!("WebSocket write error (slot {}): {}", slot, e);
                    break;
                }
            }
        });

        let (reader_done_tx, reader_done_rx) = tokio::sync::oneshot::channel::<()>();
        let reader_self = self.clone();
        let reader_handle = tokio::spawn(async move {
            loop {
                match ws_read.next().await {
                    Some(Ok(msg)) => match msg {
                        tungstenite::Message::Binary(data) => {
                            if let Err(e) = reader_self.handle_incoming_slot(&data, is_primary).await {
                                warn!("Error handling Hub message (slot {}): {}", slot, e);
                            }
                        }
                        tungstenite::Message::Close(_) => {
                            info!("Hub sent close frame (slot {})", slot);
                            break;
                        }
                        tungstenite::Message::Ping(data) => {
                            reader_self.send_on_slot(slot, tungstenite::Message::Pong(data).into_data().to_vec()).await.ok();
                        }
                        _ => {}
                    },
                    Some(Err(e)) => {
                        error!("WebSocket read error (slot {}): {}", slot, e);
                        break;
                    }
                    None => {
                        info!("WebSocket stream ended (slot {})", slot);
                        break;
                    }
                }
            }
            let _ = reader_done_tx.send(());
        });

        if is_primary {
            self.do_register().await?;
            let disappeared = self.do_full_sync().await?;
            // Clear stale voice-target cache from before the reconnect.
            self.edge_state.voice_targets.write().await.clear();
            self.do_join_cluster().await?;
            // Report any already-connected local users (Hub may have restarted)
            if let Err(e) = self.do_report_local_users().await {
                warn!("Failed to report existing users to Hub: {}", e);
            }
            *self.state.write().await = HubConnectionState::Registered;
            self.edge_state.emit(EdgeEvent::HubRegistered { disappeared_session_ids: disappeared });
            info!("Edge registered with Hub successfully (via {}, slot {})", url, slot);
        }

        let heartbeat_self = self.clone();
        let heartbeat_handle = tokio::spawn(async move {
            heartbeat_self.heartbeat_loop().await;
        });

        let _ = reader_done_rx.await;
        heartbeat_handle.abort();
        reader_handle.abort();
        writer_handle.abort();
        Ok(())
    }

    /// Connect the primary slot and wait until it has registered.  Returns an
    /// error if the initial connection fails.
    async fn run_primary_slot_init(self: &Arc<Self>) -> Result<()> {
        self.try_connect_slot(0, true).await
    }

    /// Background reconnect loop for a secondary pool slot with exponential backoff.
    async fn run_secondary_slot(self: &Arc<Self>, slot: usize) {
        let mut backoff = ExponentialBackoff::new(self.config.reconnect_interval);
        loop {
            match self.try_connect_secondary_slot(slot).await {
                Ok(()) => {
                    debug!("Pool slot {} closed", slot);
                    backoff.reset();
                }
                Err(e) => warn!("Pool slot {} error: {}", slot, e),
            }
            self.clear_slot(slot).await;

            let delay = backoff.next_delay();
            debug!("Pool slot {} reconnecting in {:?}", slot, delay);
            time::sleep(delay).await;
        }
    }

    /// True if at least one pool slot has a live send channel.
    async fn any_slot_connected(&self) -> bool {
        for sender in &self.pool_senders {
            if sender.lock().await.is_some() {
                return true;
            }
        }
        false
    }

    /// Clear a slot's send channel.
    async fn clear_slot(&self, slot: usize) {
        if let Some(s) = self.pool_senders.get(slot) {
            *s.lock().await = None;
        }
    }

    /// Attempt a single WebSocket connection on `slot`.
    /// `is_primary` = true  → handles notifications + runs do_register/do_full_sync/do_join_cluster.
    /// `is_primary` = false → secondary slot, only processes RPC responses.
    async fn try_connect_slot(self: &Arc<Self>, slot: usize, is_primary: bool) -> Result<()> {
        *self.state.write().await = HubConnectionState::Connecting;

        let scheme = if self.config.tls { "wss" } else { "ws" };
        let url = format!("{}://{}:{}", scheme, self.config.host, self.config.control_port);
        info!("Connecting to Hub at {} (slot {})", url, slot);

        let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
            .await
            .with_context(|| format!("Failed to connect to Hub WebSocket (slot {})", slot))?;

        info!("WebSocket connected to Hub (slot {})", slot);
        if is_primary {
            *self.state.write().await = HubConnectionState::Connected;
        }

        let (mut ws_write, mut ws_read) = ws_stream.split();

        // Channel for sending outgoing messages
        let (send_tx, mut send_rx) = mpsc::channel::<Vec<u8>>(256);
        if let Some(s) = self.pool_senders.get(slot) {
            *s.lock().await = Some(send_tx);
        }

        // Writer task
        let writer_handle = tokio::spawn(async move {
            while let Some(data) = send_rx.recv().await {
                if let Err(e) = ws_write.send(tungstenite::Message::Binary(Bytes::from(data))).await {
                    error!("WebSocket write error (slot {}): {}", slot, e);
                    break;
                }
            }
        });

        // Reader task
        let (reader_done_tx, reader_done_rx) = tokio::sync::oneshot::channel::<()>();
        let reader_self = self.clone();
        let reader_handle = tokio::spawn(async move {
            loop {
                match ws_read.next().await {
                    Some(Ok(msg)) => match msg {
                        tungstenite::Message::Binary(data) => {
                            if let Err(e) = reader_self.handle_incoming_slot(&data, is_primary).await {
                                warn!("Error handling Hub message (slot {}): {}", slot, e);
                            }
                        }
                        tungstenite::Message::Close(_) => {
                            info!("Hub sent close frame (slot {})", slot);
                            break;
                        }
                        tungstenite::Message::Ping(data) => {
                            reader_self.send_on_slot(slot, tungstenite::Message::Pong(data).into_data().to_vec()).await.ok();
                        }
                        _ => {}
                    },
                    Some(Err(e)) => {
                        error!("WebSocket read error (slot {}): {}", slot, e);
                        break;
                    }
                    None => {
                        info!("WebSocket stream ended (slot {})", slot);
                        break;
                    }
                }
            }
            let _ = reader_done_tx.send(());
        });

        if is_primary {
            // Register with Hub (reader task is now running)
            self.do_register().await?;
            // Request full sync; capture disappeared session IDs for the event.
            let disappeared = self.do_full_sync().await?;
            // Clear stale voice-target cache from before the reconnect.
            self.edge_state.voice_targets.write().await.clear();
            // Join cluster topology
            self.do_join_cluster().await?;
            // Report any already-connected local users (Hub may have restarted)
            if let Err(e) = self.do_report_local_users().await {
                warn!("Failed to report existing users to Hub: {}", e);
            }

            *self.state.write().await = HubConnectionState::Registered;
            self.edge_state.emit(EdgeEvent::HubRegistered { disappeared_session_ids: disappeared });
            info!("Edge registered with Hub successfully (pool primary)");
        }

        // Heartbeat runs on every slot
        let heartbeat_self = self.clone();
        let heartbeat_handle = tokio::spawn(async move {
            heartbeat_self.heartbeat_loop().await;
        });

        let _ = reader_done_rx.await;
        heartbeat_handle.abort();
        reader_handle.abort();
        writer_handle.abort();
        Ok(())
    }

    /// Connect a secondary slot: only authenticate / heartbeat (no full sync / cluster join).
    async fn try_connect_secondary_slot(self: &Arc<Self>, slot: usize) -> Result<()> {
        // Wait until primary is registered before bringing up secondary slots.
        for _ in 0..SECONDARY_SLOT_WAIT_MAX_POLLS {
            if self.state().await == HubConnectionState::Registered {
                break;
            }
            time::sleep(Duration::from_millis(SECONDARY_SLOT_WAIT_POLL_INTERVAL_MS)).await;
        }
        self.try_connect_slot(slot, false).await
    }

    /// Send raw bytes through a specific pool slot.
    async fn send_on_slot(&self, slot: usize, data: Vec<u8>) -> Result<()> {
        if let Some(s) = self.pool_senders.get(slot) {
            if let Some(tx) = s.lock().await.as_ref() {
                tx.send(data).await.context("Send channel closed")?;
            }
        }
        Ok(())
    }

    /// Send raw bytes through the WebSocket, using round-robin across live pool slots.
    async fn send_raw(&self, data: Vec<u8>) -> Result<()> {
        if self.pool_size == 1 {
            return self.send_on_slot(0, data).await;
        }
        // Try each slot starting from the round-robin position.
        let start = self.pool_rr.fetch_add(1, Ordering::Relaxed) % self.pool_size;
        for i in 0..self.pool_size {
            let slot = (start + i) % self.pool_size;
            let sender_opt = {
                let guard = self.pool_senders[slot].lock().await;
                guard.as_ref().map(|s| s.clone())
            };
            if let Some(tx) = sender_opt {
                if tx.send(data.clone()).await.is_ok() {
                    return Ok(());
                }
            }
        }
        // No live slot – fall back silently (Hub is down, caller handles errors)
        Ok(())
    }

    /// Send an EdgeHubPacket to the Hub.
    async fn send_packet(&self, packet: &EdgeHubPacket) -> Result<()> {
        let data = packet.encode_to_vec();
        self.send_raw(data).await
    }

    /// Send an RPC request and wait for the response.
    async fn rpc_call(&self, request: TypedRpcRequest) -> Result<TypedRpcResponse> {
        let request_id = request.request_id.clone();
        let method = request.method.clone();

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), PendingRequest { tx });

        let packet = EdgeHubPacket {
            r#type: PacketType::RpcRequest as i32,
            rpc_request: Some(request),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            // Remove pending entry immediately on send failure to avoid a stale
            // entry that would only be cleaned up on timeout.
            self.pending.lock().await.remove(&request_id);
            return Err(e);
        }

        // Wait for response with timeout
        let timeout = Duration::from_secs(30);
        match time::timeout(timeout, rx).await {
            Ok(Ok(Ok(response))) => Ok(response),
            Ok(Ok(Err(err_msg))) => anyhow::bail!("RPC {} error: {}", method, err_msg),
            Ok(Err(_)) => anyhow::bail!("RPC {} cancelled", method),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                anyhow::bail!("RPC {} timed out", method)
            }
        }
    }

    /// Handle an incoming message from a specific pool slot.
    /// `is_primary = true`  → process both RPC responses and push notifications.
    /// `is_primary = false` → process RPC responses only (suppress notifications to
    ///                        avoid duplicate state updates in pool mode).
    async fn handle_incoming_slot(&self, data: &[u8], is_primary: bool) -> Result<()> {
        let packet = EdgeHubPacket::decode(data)
            .context("Failed to decode EdgeHubPacket")?;

        match PacketType::try_from(packet.r#type) {
            Ok(PacketType::RpcResponse) => {
                if let Some(response) = packet.rpc_response {
                    self.handle_rpc_response(response).await;
                }
            }
            Ok(PacketType::RpcError) => {
                if let Some(error) = packet.rpc_error {
                    self.handle_rpc_error(&error.request_id, &error.message).await;
                }
            }
            Ok(PacketType::RpcNotification) => {
                // Only the primary slot processes push notifications.
                if is_primary {
                    if let Some(notification) = packet.rpc_notification {
                        self.handle_notification(notification).await;
                    }
                }
            }
            Ok(PacketType::HeartbeatAck) => {
                debug!("Heartbeat ack received");
                if let Some(ack) = packet.heartbeat_ack {
                    if let Some(limits) = ack.server_limits {
                        debug!("Received updated server limits from Hub heartbeat");
                        *self.edge_state.hub_limits.write().await = Some(limits);
                    }
                }
            }
            _ => {
                debug!("Unknown packet type: {}", packet.r#type);
            }
        }
        Ok(())
    }

    /// Handle an RPC response by resolving the pending request.
    async fn handle_rpc_response(&self, response: TypedRpcResponse) {
        let request_id = response.request_id.clone();
        if let Some(pending) = self.pending.lock().await.remove(&request_id) {
            let _ = pending.tx.send(Ok(response));
        } else {
            warn!("Received response for unknown request: {}", request_id);
        }
    }

    /// Handle an RPC error by rejecting the pending request.
    async fn handle_rpc_error(&self, request_id: &str, message: &str) {
        if let Some(pending) = self.pending.lock().await.remove(request_id) {
            let _ = pending.tx.send(Err(message.to_string()));
        }
    }

    /// Handle a notification from the Hub.
    async fn handle_notification(&self, notification: TypedRpcNotification) {
        let method = &notification.method;
        let eid = self.edge_id();
        // High-frequency voice relay notifications are trace-level to avoid log flooding.
        if method == "hub.relayVoicePacket" {
            trace!("Hub notification: {} (edge={})", method, eid);
        } else {
            debug!("Hub notification: {} (edge={})", method, eid);
        }

        match method.as_str() {
            "hub.userJoined" => {
                if let Some(params) = &notification.user_joined {
                    let local_edge_id = self.edge_id();
                    let is_local = params.edge_id == local_edge_id;
                    // Only add REMOTE users (from other edges) to channel_manager.remote_users.
                    // Local users are tracked by their own connection handler via client_manager;
                    // adding them here would cause duplicate UserState messages during login.
                    if !is_local {
                        let user = RemoteUser {
                            session_id: params.session_id,
                            edge_id: params.edge_id,
                            user_id: params.user_id,
                            username: params.username.clone(),
                            channel_id: params.channel_id,
                            cert_hash: params.cert_hash.clone(),
                            groups: params.groups.clone(),
                            mute: params.mute.unwrap_or(false),
                            deaf: params.deaf.unwrap_or(false),
                            suppress: params.suppress.unwrap_or(false),
                            self_mute: params.self_mute.unwrap_or(false),
                            self_deaf: params.self_deaf.unwrap_or(false),
                            priority_speaker: params.priority_speaker.unwrap_or(false),
                            recording: params.recording.unwrap_or(false),
                            listening_channels: vec![],
                        };
                        info!("Remote user joined: {} (session {})", user.username, user.session_id);
                        let channel_id = user.channel_id;
                        self.edge_state.channel_manager.upsert_remote_user(user.clone()).await;

                        // Check if this is a ninja channel
                        let is_ninja = self.edge_state.ninja_channels.read().await.contains(&channel_id);
                        self.edge_state.emit(EdgeEvent::RemoteUserJoined {
                            session_id: user.session_id,
                            username: user.username,
                            channel_id: user.channel_id,
                            is_ninja,
                        });
                    } else {
                        info!("Local user joined (hub.userJoined echo): {} (session {})", params.username, params.session_id);
                    }
                }
            }
            "hub.userRemoveBroadcast" => {
                if let Some(params) = &notification.user_remove_broadcast {
                    let target_session = params.session;
                    info!("User removed: session {}", target_session);
                    // If the kicked user is a LOCAL client on this edge, send them UserRemove then close
                    if let Some(sender) = self.edge_state.client_manager.get_sender(target_session).await {
                        let msg = crate::handler::build_user_remove_msg(
                            target_session,
                            params.reason.as_deref(),
                        );
                        sender.send_message(MessageType::UserRemove, &msg).await;
                        // Drop sender by removing client from manager - this closes the TCP connection
                        self.edge_state.client_manager.remove_client(target_session).await;
                    }
                    // Remove from remote user tracking and broadcast removal to local clients
                    self.edge_state.channel_manager.remove_remote_user(target_session).await;
                    self.edge_state.emit(EdgeEvent::RemoteUserLeft {
                        session_id: target_session,
                    });
                }
            }
            "hub.userStateBroadcast" => {
                // User state changed on another edge (mute, deaf, etc.)
                if let Some(p) = &notification.user_state_broadcast {
                    let session_id = p.session_id;
                    if session_id > 0 {
                        if let Some(mut user) = self.edge_state.channel_manager.get_remote_user(session_id).await {
                            let mut delta = crate::state::RemoteUserStateDelta::default();
                            if let Some(b) = p.self_mute     { user.self_mute = b;         delta.self_mute = Some(b); }
                            if let Some(b) = p.self_deaf     { user.self_deaf = b;         delta.self_deaf = Some(b); }
                            if let Some(b) = p.mute          { user.mute = b;              delta.mute = Some(b); }
                            if let Some(b) = p.deaf          { user.deaf = b;              delta.deaf = Some(b); }
                            if let Some(b) = p.suppress      { user.suppress = b;          delta.suppress = Some(b); }
                            if let Some(b) = p.priority_speaker { user.priority_speaker = b; delta.priority_speaker = Some(b); }
                            if let Some(b) = p.recording     { user.recording = b;         delta.recording = Some(b); }
                            let listening_add: Vec<u32> = p.listening_channel_add.iter()
                                .copied()
                                .filter(|&ch_id| !user.listening_channels.contains(&ch_id))
                                .collect();
                            let listening_remove = p.listening_channel_remove.clone();
                            for &ch_id in &listening_add {
                                user.listening_channels.push(ch_id);
                            }
                            user.listening_channels.retain(|ch| !listening_remove.contains(ch));
                            self.edge_state.channel_manager.upsert_remote_user(user).await;
                            self.edge_state.emit(EdgeEvent::RemoteUserStateChanged {
                                session_id,
                                delta,
                                listening_channel_add: listening_add,
                                listening_channel_remove: listening_remove,
                            });
                        }
                    }
                }
            }
            "hub.userMoved" => {
                if let Some(params) = &notification.user_moved {
                    debug!("Remote user moved: session {} -> channel {}", params.session_id, params.channel_id);
                    if let Some(mut user) = self.edge_state.channel_manager.get_remote_user(params.session_id).await {
                        user.channel_id = params.channel_id;
                        self.edge_state.channel_manager.upsert_remote_user(user).await;
                    }
                    // actor_session: 0 means server-initiated; fall back to session_id for user self-moves
                    let actor_session = params.actor_session
                        .filter(|&a| a != 0)
                        .unwrap_or(params.session_id);
                    self.edge_state.emit(EdgeEvent::RemoteUserMoved {
                        session_id: params.session_id,
                        channel_id: params.channel_id,
                        actor_session,
                    });
                }
            }
            "hub.channelCreated" => {
                if let Some(params) = &notification.channel_created {
                    let ch_proto = &params.channel;
                    let channel = ChannelData::from(ch_proto);
                    info!("Channel created: {} (id {})", channel.name, channel.id);
                    self.edge_state.channel_manager.upsert_channel(channel).await;
                    self.edge_state.emit(EdgeEvent::ChannelCreated { channel_id: ch_proto.channel_id });
                }
            }
            "hub.channelRemoved" => {
                if let Some(params) = &notification.channel_removed {
                    info!("Channel removed: {}", params.channel_id);
                    self.edge_state.channel_manager.remove_channel(params.channel_id).await;
                    self.edge_state.emit(EdgeEvent::ChannelRemoved { channel_id: params.channel_id });
                }
            }
            "hub.channelUpdated" => {
                if let Some(params) = &notification.channel_updated {
                    let ch_proto = &params.channel;
                    let channel = ChannelData::from(ch_proto);
                    let channel_id = ch_proto.channel_id;
                    // Compute link delta so the broadcast to local clients uses
                    // links_add / links_remove (Mumble protocol incremental update).
                    let old_links = if let Some(old_ch) = self.edge_state.channel_manager.get_channel(channel_id).await {
                        old_ch.links
                    } else {
                        vec![]
                    };
                    let new_links = channel.links.clone();
                    let links_add: Vec<u32> = new_links.iter().filter(|l| !old_links.contains(l)).copied().collect();
                    let links_remove: Vec<u32> = old_links.iter().filter(|l| !new_links.contains(l)).copied().collect();
                    debug!("Channel updated: {} (id {}), links_add={:?}, links_remove={:?}", channel.name, channel_id, links_add, links_remove);
                    self.edge_state.channel_manager.upsert_channel(channel).await;
                    self.edge_state.emit(EdgeEvent::ChannelUpdated { channel_id, links_add, links_remove });
                }
            }
            "edge.forceDisconnect" => {
                if let Some(params) = &notification.force_disconnect {
                    warn!("Hub forced disconnect: {}", params.reason);
                }
            }
            "hub.shutdownRequest" => {
                // Hub requests this Edge to gracefully shut down (cluster partition handling)
                let reason = "Network partition detected";
                warn!("Hub shutdown request received: {}", reason);
                // Emit shutdown event so server can gracefully disconnect all clients
                self.edge_state.emit(EdgeEvent::ShutdownRequested {
                    reason: reason.to_string(),
                });
            }
            "edge.peerJoined" => {
                if let Some(params) = &notification.peer_joined {
                    info!("Peer edge joined: {} (id {})", params.name, params.id);
                }
            }
            "hub.textMessageForward" => {
                // Text message forwarded from another edge via Hub
                if let Some(p) = &notification.text_message_forward {
                    self.edge_state.emit(EdgeEvent::TextMessageForward {
                        actor: p.actor,
                        message: p.message.clone(),
                        channel_id: p.channel_id.clone(),
                        tree_id: p.tree_id.clone(),
                        session: p.session.clone(),
                    });
                }
            }
            "hub.pluginDataBroadcast" => {
                // Plugin data forwarded from another edge
                if let Some(params) = &notification.plugin_data_broadcast {
                    self.edge_state.emit(EdgeEvent::PluginDataBroadcast {
                        sender_session: params.sender_session,
                        data_id: params.data_id.clone(),
                        data: params.data.clone(),
                        target_sessions: params.target_sessions.clone(),
                    });
                }
            }
            "hub.syncVoiceTarget" => {
                // Voice target synced from another edge via Hub
                if let Some(params) = &notification.sync_voice_target {
                    let client_session = params.client_session;
                    let target_id = params.target_id;
                    if let Some(cfg) = &params.config {
                        use crate::state::{VoiceTargetConfig, VoiceTargetChannelConfig};
                        let sessions: Vec<u32> = cfg.sessions.iter().map(|s| s.session).collect();
                        let channels: Vec<VoiceTargetChannelConfig> = cfg.channels.iter().map(|c| {
                            VoiceTargetChannelConfig {
                                channel_id: c.channel_id,
                                links: c.links.unwrap_or(false),
                                children: c.children.unwrap_or(false),
                                group: c.group.clone(),
                            }
                        }).collect();
                        let mut vt_cache = self.edge_state.voice_targets.write().await;
                        let session_vts = vt_cache.entry(client_session).or_default();
                        if sessions.is_empty() && channels.is_empty() {
                            session_vts.remove(&target_id);
                        } else {
                            session_vts.insert(target_id, VoiceTargetConfig { sessions, channels });
                        }
                        debug!("Synced voice target {} for session {}", target_id, client_session);
                    } else {
                        // No config means clear the target
                        let mut vt_cache = self.edge_state.voice_targets.write().await;
                        if let Some(session_vts) = vt_cache.get_mut(&client_session) {
                            session_vts.remove(&target_id);
                        }
                    }
                }
            }
            "hub.relayVoicePacket" => {
                // Voice packet relayed from another edge via Hub (typed protobuf)
                if let Some(params) = &notification.relay_voice_packet {
                    let voice_packet = params.voice_packet.clone();
                    self.edge_state.emit(EdgeEvent::RelayedVoice { voice_packet });
                } else {
                    debug!("hub.relayVoicePacket notification missing relay_voice_packet field");
                }
            }
            "hub.peerJoined" => {
                // Another Edge joined the cluster (from handle_cluster_join broadcast)
                if let Some(p) = &notification.cluster_peer_joined {
                    let peer_edge_id = p.edge_id;
                    let name = &p.name;
                    let host = &p.host;
                    let voice_port = p.voice_port as u16;
                    info!("Peer edge joined cluster: {} (id {}) at {}:{}", name, peer_edge_id, host, voice_port);
                    if !host.is_empty() && voice_port > 0 {
                        if let Ok(udp_addr) = format!("{}:{}", host, voice_port).parse() {
                            let mut reg = self.edge_state.peer_registry.write().await;
                            reg.upsert(peer_edge_id, PeerEdgeInfo {
                                udp_addr,
                                host: host.clone(),
                                relay_port: None,
                            });
                            info!("Registered direct UDP route to peer edge {} at {}", peer_edge_id, udp_addr);
                        }
                    }
                }
            }
            "hub.peerLeft" => {
                // An Edge left the cluster (disconnect arbitration)
                if let Some(p) = &notification.cluster_peer_left {
                    let peer_edge_id = p.edge_id;
                    warn!("Peer edge left cluster: id {}", peer_edge_id);
                    self.edge_state.peer_registry.write().await.remove(peer_edge_id);
                }
            }
            "hub.routeTableUpdate" => {
                if let Some(params) = &notification.route_table_update {
                    use crate::state::RouteDecision;
                    let mut table = self.edge_state.route_table.write().await;
                    table.clear();
                    for entry in &params.routes {
                        let decision = match entry.route_type {
                            1 => RouteDecision::RelayVia {
                                relay_edge_id: entry.next_hop.unwrap_or(0),
                            },
                            2 => RouteDecision::HubTcp,
                            _ => RouteDecision::Direct,
                        };
                        table.insert(entry.target_edge_id, decision);
                    }
                    let count = table.len();
                    drop(table);
                    debug!("Route table updated: {} entries", count);
                }
            }
            "hub.contextActionModify" => {
                // Hub pushes a ContextActionModify to specific clients on this Edge.
                // Forward the ContextActionModify message to each targeted client.
                if let Some(params) = &notification.context_action_modify {
                    let msg = &params.action;
                    let target_sessions = &params.target_sessions;
                    if target_sessions.is_empty() {
                        // Broadcast to all local clients
                        self.edge_state.client_manager
                            .broadcast(MessageType::ContextActionModify, msg, None)
                            .await;
                        debug!("ContextActionModify broadcast to all clients: action={:?}", msg.action.as_str());
                    } else {
                        for &sid in target_sessions {
                            if let Some(sender) = self.edge_state.client_manager.get_sender(sid).await {
                                sender.send_message(MessageType::ContextActionModify, msg).await;
                            }
                        }
                        debug!(
                            "ContextActionModify sent to {} client(s): action={:?}",
                            target_sessions.len(),
                            msg.action.as_str()
                        );
                    }
                }
            }
            _ => {
                // Check for hub.ninjaConfig (uses unknown_params_json)
                if method == "hub.ninjaConfig" {
                    if let Some(json_str) = &notification.unknown_params_json {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                            if val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
                                let channels: Vec<u32> = val
                                    .get("ninja_channels")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| arr.iter()
                                        .filter_map(|v| v.as_u64().map(|n| n as u32))
                                        .collect())
                                    .unwrap_or_default();
                                let mut nc = self.edge_state.ninja_channels.write().await;
                                *nc = channels;
                                debug!("Ninja channels updated from Hub: {:?}", &*nc);
                            }
                        }
                    }
                } else {
                    debug!("Unhandled notification: {}", method);
                }
            }
        }
    }

    // ==================== RPC Methods ====================

    /// Register this Edge with the Hub (with optional HMAC challenge-response).
    async fn do_register(&self) -> Result<()> {
        let request_id = self.next_request_id().await;
        let params = EdgeRegisterParams {
            server_id: self.server_id,
            name: self.server_name.clone(),
            host: self.external_host.clone(),
            port: self.external_port as u32,
            region: self.region.clone(),
            capacity: self.capacity,
            certificate: String::new(),
            challenge: None,
            challenge_response: None,
        };

        let request = TypedRpcRequest {
            request_id,
            method: "edge.register".to_string(),
            timeout_ms: Some(30000),
            edge_register: Some(params),
            ..Default::default()
        };

        let response = self.rpc_call(request).await
            .context("edge.register RPC failed")?;

        let result = response.edge_register
            .ok_or_else(|| anyhow::anyhow!("No edge_register in response"))?;

        if !result.success {
            // Check if we need HMAC challenge-response
            if let Some(challenge) = &result.challenge {
                if let Some(hmac_secret) = &self.config.hmac_secret {
                    info!("Received HMAC challenge, sending response");
                    return self.do_register_with_challenge(challenge, hmac_secret).await;
                }
            }
            anyhow::bail!("Registration failed: {:?}", result.error);
        }

        if let Some(hub_id) = result.hub_server_id {
            info!("Registered with Hub, assigned hub_server_id={}", hub_id);
        }

        // Store our edge_id (Hub may assign it)
        if let Some(id) = result.hub_server_id {
            self.edge_state.set_edge_id(id);
        }

        // Store server limits received from Hub
        if let Some(limits) = result.server_limits {
            *self.edge_state.hub_limits.write().await = Some(limits);
            debug!("Stored server limits from Hub registration");
        }

        Ok(())
    }

    /// Register with HMAC challenge-response.
    async fn do_register_with_challenge(&self, challenge: &str, hmac_secret: &str) -> Result<()> {
        use ring::hmac;

        let key = hmac::Key::new(hmac::HMAC_SHA256, hmac_secret.as_bytes());
        let data = format!("{}:{}", challenge, self.server_id);
        let signature = hmac::sign(&key, data.as_bytes());
        let challenge_response = hex::encode(signature.as_ref());

        let request_id = self.next_request_id().await;
        let params = EdgeRegisterParams {
            server_id: self.server_id,
            name: self.server_name.clone(),
            host: self.external_host.clone(),
            port: self.external_port as u32,
            region: self.region.clone(),
            capacity: self.capacity,
            certificate: String::new(),
            challenge: Some(challenge.to_string()),
            challenge_response: Some(challenge_response),
        };

        let request = TypedRpcRequest {
            request_id,
            method: "edge.register".to_string(),
            timeout_ms: Some(30000),
            edge_register: Some(params),
            ..Default::default()
        };

        let response = self.rpc_call(request).await
            .context("edge.register (challenge) RPC failed")?;

        let result = response.edge_register
            .ok_or_else(|| anyhow::anyhow!("No edge_register in response"))?;

        if !result.success {
            anyhow::bail!("Registration with challenge failed: {:?}", result.error);
        }

        if let Some(id) = result.hub_server_id {
            self.edge_state.set_edge_id(id);
        }
        info!("Registered with Hub via HMAC challenge-response");

        // Store server limits received from Hub
        if let Some(limits) = result.server_limits {
            *self.edge_state.hub_limits.write().await = Some(limits);
            debug!("Stored server limits from Hub registration (challenge)");
        }

        Ok(())
    }

    /// Request full sync from Hub (channels, users, ACLs).
    ///
    /// Returns the list of remote-user session IDs that were present in the local
    /// cache *before* the sync but are absent from the fresh Hub snapshot.
    /// These "disappeared" sessions should be communicated to connected local clients
    /// via `UserRemove` so they don't keep stale entries in their user lists.
    async fn do_full_sync(&self) -> Result<Vec<u32>> {
        let request_id = self.next_request_id().await;
        let request = TypedRpcRequest {
            request_id,
            method: "edge.fullSync".to_string(),
            timeout_ms: Some(30000),
            edge_full_sync: Some(EdgeFullSyncParams {
                for_user_id: None,
                for_user_groups: vec![],
                for_user_channel_id: None,
                for_user_cert_hash: None,
            }),
            ..Default::default()
        };

        let response = self.rpc_call(request).await
            .context("edge.fullSync RPC failed")?;

        let result = response.edge_full_sync
            .ok_or_else(|| anyhow::anyhow!("No edge_full_sync in response"))?;

        // Snapshot the old remote-user session IDs **before** clearing the cache so
        // we can compute the "disappeared" diff once the fresh data is loaded.
        let old_session_ids: std::collections::HashSet<u32> = self.edge_state
            .channel_manager
            .get_all_remote_users()
            .await
            .iter()
            .map(|u| u.session_id)
            .collect();

        // Load channels
        self.edge_state.channel_manager.load_channels(
            &result.channels,
            &result.channel_links,
        ).await;

        // Load remote users (clears and repopulates the cache).
        self.edge_state.channel_manager.load_remote_users(&result.sessions).await;

        // Compute sessions that existed before but are no longer present.
        let new_session_ids: std::collections::HashSet<u32> = result.sessions
            .iter()
            .map(|s| s.session_id)
            .collect();
        let disappeared: Vec<u32> = old_session_ids
            .into_iter()
            .filter(|id| !new_session_ids.contains(id))
            .collect();

        if !disappeared.is_empty() {
            info!("Full sync: {} session(s) disappeared from Hub snapshot", disappeared.len());
        }

        info!(
            "Full sync complete: {} channels, {} sessions",
            result.channels.len(),
            result.sessions.len()
        );
        Ok(disappeared)
    }

    /// Join the cluster topology so Hub can broadcast our address to peer Edges.
    /// Called after successful registration and full sync; sends `edge.join` RPC
    /// then confirms with `edge.joinComplete`.
    async fn do_join_cluster(&self) -> Result<()> {
        let request_id = self.next_request_id().await;
        let params = EdgeJoinParams {
            server_id: self.server_id,
            name: self.server_name.clone(),
            host: self.external_host.clone(),
            port: self.external_port as u32,
            voice_port: self.edge_port as u32,
            capacity: self.capacity,
        };

        let request = TypedRpcRequest {
            request_id,
            method: "edge.join".to_string(),
            timeout_ms: Some(30000),
            edge_join: Some(params),
            ..Default::default()
        };

        let response = self.rpc_call(request).await
            .context("edge.join RPC failed")?;

        let result = response.edge_join
            .ok_or_else(|| anyhow::anyhow!("No edge_join in response"))?;

        if !result.success {
            anyhow::bail!("edge.join failed: {:?}", result.error);
        }

        info!(
            "Joined cluster topology, {} existing peers",
            result.peers.len()
        );
        for peer in &result.peers {
            info!("  Peer edge: {} (id={}, {}:{})", peer.name, peer.id, peer.host, peer.port);
            // Register each existing peer's UDP address
            if !peer.host.is_empty() && peer.voice_port > 0 {
                if let Ok(udp_addr) = format!("{}:{}", peer.host, peer.voice_port).parse() {
                    let mut reg = self.edge_state.peer_registry.write().await;
                    reg.upsert(peer.id, PeerEdgeInfo {
                        udp_addr,
                        host: peer.host.clone(),
                        relay_port: None,
                    });
                    info!("Registered direct UDP route to existing peer edge {} at {}", peer.id, udp_addr);
                }
            }
        }

        // Notify Hub that we have processed the peer list
        let complete_id = self.next_request_id().await;
        let token = result.token.unwrap_or_default();
        let connected_peers: Vec<u32> = result.peers.iter().map(|p| p.id).collect();
        let complete_request = TypedRpcRequest {
            request_id: complete_id,
            method: "edge.joinComplete".to_string(),
            timeout_ms: Some(10000),
            edge_join_complete: Some(EdgeJoinCompleteParams {
                server_id: self.server_id,
                token,
                connected_peers,
            }),
            ..Default::default()
        };
        let _ = self.rpc_call(complete_request).await;

        Ok(())
    }

    /// After a Hub reconnect, report all currently-connected local users to the
    /// Hub so it can rebuild its session registry.  Without this, Hub restart
    /// leaves Hub unaware of existing users, breaking cross-edge visibility and
    /// other Hub-side logic.
    async fn do_report_local_users(&self) -> Result<()> {
        use crate::client::ClientState;
        let edge_id = self.edge_id();
        let clients = self.edge_state.client_manager.get_all_clients().await;
        let ready_clients: Vec<_> = clients.iter()
            .filter(|c| c.state == ClientState::Ready)
            .collect();

        if ready_clients.is_empty() {
            return Ok(());
        }

        info!("Reporting {} existing local users to Hub after reconnect", ready_clients.len());

        for client in ready_clients {
            let session_proto = GlobalSessionProto {
                session_id: client.session,
                edge_id,
                user_id: client.user_id,
                username: client.username.clone(),
                channel_id: client.channel_id,
                ip_address: Some(client.ip_address.clone()),
                cert_hash: client.cert_hash.clone(),
                connected_at: None,
                groups: client.groups.clone(),
                mute: Some(client.mute),
                deaf: Some(client.deaf),
                suppress: Some(client.suppress),
                self_mute: Some(client.self_mute),
                self_deaf: Some(client.self_deaf),
                priority_speaker: Some(client.priority_speaker),
                recording: Some(client.recording),
            };
            let request_id = self.next_request_id().await;
            let request = TypedRpcRequest {
                request_id,
                method: "edge.reportSession".to_string(),
                timeout_ms: Some(10000),
                edge_report_session: Some(EdgeReportSessionParams { session: session_proto }),
                ..Default::default()
            };
            if let Err(e) = self.rpc_call(request).await {
                warn!("Failed to report existing session {} to Hub: {}", client.session, e);
            } else {
                debug!("Reported session {} ({}) to Hub", client.session, client.username);
            }
        }

        Ok(())
    }

    /// Heartbeat loop.
    async fn heartbeat_loop(&self) {
        let interval = Duration::from_millis(self.config.heartbeat_interval);
        let mut sequence: u64 = 0;

        loop {
            time::sleep(interval).await;
            sequence += 1;

            let user_count = self.edge_state.client_manager.client_count().await as u32;
            let channel_count = self.edge_state.channel_manager.get_all_channels().await.len() as u32;
            let uptime_seconds = self.start_time.elapsed().as_secs();

            let packet = EdgeHubPacket {
                r#type: PacketType::Heartbeat as i32,
                heartbeat: Some(hubedge::Heartbeat {
                    edge_id: self.edge_id(),
                    sequence,
                    stats: Some(hubedge::ServerStats {
                        user_count,
                        channel_count,
                        cpu_usage: None,
                        memory_usage_mb: None,
                        network_send_kbps: None,
                        network_recv_kbps: None,
                        uptime_seconds: Some(uptime_seconds),
                    }),
                }),
                ..Default::default()
            };

            if let Err(e) = self.send_packet(&packet).await {
                warn!("Failed to send heartbeat (seq={}): {}", sequence, e);
                // A single send failure may be a transient network blip. Continue
                // sending heartbeats; the connection manager will detect a dead link
                // through its own reconnect logic after consecutive failures.
                continue;
            }
            debug!("Heartbeat sent (seq={})", sequence);
        }
    }

    /// Authenticate a user via the Hub.
    pub async fn authenticate_user(
        &self,
        session_id: u32,
        username: &str,
        password: &str,
        tokens: Vec<String>,
        client_info: Option<hubedge::ClientInfo>,
        preconnect_self_mute: Option<bool>,
        preconnect_self_deaf: Option<bool>,
    ) -> Result<hubedge::EdgeAuthenticateUserResult> {
        let request_id = self.next_request_id().await;
        let request = TypedRpcRequest {
            request_id,
            method: "edge.authenticateUser".to_string(),
            timeout_ms: Some(30000),
            edge_authenticate_user: Some(EdgeAuthenticateUserParams {
                session_id,
                server_id: self.server_id,
                username: username.to_string(),
                password: password.to_string(),
                tokens,
                client_info,
                mute: None,
                deaf: None,
                suppress: None,
                self_mute: preconnect_self_mute,
                self_deaf: preconnect_self_deaf,
                priority_speaker: None,
                recording: None,
            }),
            ..Default::default()
        };

        let response = self.rpc_call(request).await
            .context("edge.authenticateUser RPC failed")?;

        response.edge_authenticate_user
            .ok_or_else(|| anyhow::anyhow!("No edge_authenticate_user in response"))
    }

    /// Notify the Hub that a local user has disconnected.
    pub async fn notify_user_left(&self, session_id: u32, reason: Option<&str>) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handleUserLeft".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_user_left: Some(EdgeHandleUserLeftParams {
                session_id,
                edge_id,
                reason: reason.map(String::from),
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to notify Hub of user disconnect: {}", e);
        }
    }

    /// Notify the Hub about a user-initiated kick/ban (UserRemove).
    pub async fn notify_user_remove(
        &self,
        actor_session: u32,
        actor_user_id: u32,
        actor_username: &str,
        target_session: u32,
        reason: &str,
        ban: bool,
    ) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handleUserRemove".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_user_remove: Some(EdgeHandleUserRemoveParams {
                edge_id,
                actor_session,
                actor_user_id,
                actor_username: actor_username.to_string(),
                target_session,
                reason: reason.to_string(),
                ban,
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to notify Hub of user remove: {}", e);
        }
    }

    /// Notify the Hub about a user channel move.
    pub async fn notify_user_moved(&self, session_id: u32, channel_id: u32, actor_session: u32) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handleUserMoved".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_user_moved: Some(EdgeHandleUserMovedParams {
                session_id,
                edge_id,
                channel_id,
                actor_session: Some(actor_session),
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to notify Hub of user move: {}", e);
        }
    }

    /// Notify the Hub about a user state change (self-mute/deaf etc).
    pub async fn notify_user_state_changed(
        &self,
        session_id: u32,
        self_mute: Option<bool>,
        self_deaf: Option<bool>,
        mute: Option<bool>,
        deaf: Option<bool>,
        suppress: Option<bool>,
        priority_speaker: Option<bool>,
        recording: Option<bool>,
        listening_channel_add: Vec<u32>,
        listening_channel_remove: Vec<u32>,
    ) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handleUserStateChanged".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_user_state_changed: Some(EdgeHandleUserStateChangedParams {
                session_id,
                edge_id,
                self_mute,
                self_deaf,
                mute,
                deaf,
                suppress,
                priority_speaker,
                recording,
                listening_channel_add,
                listening_channel_remove,
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to notify Hub of user state change: {}", e);
        }
    }

    /// Forward a PermissionQuery to the Hub.
    pub async fn handle_permission_query(
        &self,
        session_id: u32,
        channel_id: u32,
    ) -> Result<hubedge::EdgeHandlePermissionQueryResult> {
        let request_id = self.next_request_id().await;
        let edge_id = self.edge_id();

        // Get actor info from client
        let (user_id, username) = if let Some(client) = self.edge_state.client_manager.get_client(session_id).await {
            (client.user_id, client.username.clone())
        } else {
            (0, String::new())
        };

        let request = TypedRpcRequest {
            request_id,
            method: "edge.handlePermissionQuery".to_string(),
            timeout_ms: Some(10000),
            edge_handle_permission_query: Some(hubedge::EdgeHandlePermissionQueryParams {
                edge_id,
                actor_session: session_id,
                actor_user_id: user_id,
                actor_username: username,
                channel_id,
            }),
            ..Default::default()
        };
        let response = self.rpc_call(request).await
            .context("edge.handlePermissionQuery RPC failed")?;
        response.edge_handle_permission_query
            .ok_or_else(|| anyhow::anyhow!("No edge_handle_permission_query in response"))
    }

    /// Sync a VoiceTarget to the Hub.
    pub async fn sync_voice_target(
        &self,
        client_session: u32,
        target_id: u32,
        config: Option<hubedge::VoiceTargetConfigProto>,
    ) -> Result<hubedge::EdgeSyncVoiceTargetResult> {
        let request_id = self.next_request_id().await;
        let edge_id = self.edge_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.syncVoiceTarget".to_string(),
            timeout_ms: Some(10000),
            edge_sync_voice_target: Some(hubedge::EdgeSyncVoiceTargetParams {
                edge_id,
                client_session,
                target_id,
                config,
            }),
            ..Default::default()
        };
        let response = self.rpc_call(request).await
            .context("edge.syncVoiceTarget RPC failed")?;
        response.edge_sync_voice_target
            .ok_or_else(|| anyhow::anyhow!("No edge_sync_voice_target in response"))
    }

    /// Allocate a session ID from the Hub.
    pub async fn allocate_session_id(&self) -> Result<u32> {
        let request_id = self.next_request_id().await;
        let edge_id = self.edge_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.allocateSessionId".to_string(),
            timeout_ms: Some(10000),
            edge_allocate_session_id: Some(hubedge::EdgeAllocateSessionIdParams {
                edge_id,
            }),
            ..Default::default()
        };

        let response = self.rpc_call(request).await
            .context("edge.allocateSessionId RPC failed")?;

        let result = response.edge_allocate_session_id
            .ok_or_else(|| anyhow::anyhow!("No edge_allocate_session_id in response"))?;

        Ok(result.session_id)
    }

    /// Forward a channel create/edit request to Hub via saveChannel RPC.
    pub async fn save_channel(
        &self,
        channel_id: Option<u32>,
        parent_id: Option<u32>,
        name: Option<&str>,
        description: Option<&str>,
        position: Option<i32>,
        max_users: Option<u32>,
    ) -> Result<hubedge::EdgeSaveChannelResult> {
        let request_id = self.next_request_id().await;
        let request = TypedRpcRequest {
            request_id,
            method: "edge.saveChannel".to_string(),
            timeout_ms: Some(10000),
            edge_save_channel: Some(hubedge::EdgeSaveChannelParams {
                id: channel_id,
                parent_id,
                name: name.map(String::from),
                description: description.map(String::from),
                description_blob: None,
                position,
                max_users,
                inherit_acl: None,
            }),
            ..Default::default()
        };

        let response = self.rpc_call(request).await
            .context("edge.saveChannel RPC failed")?;

        response.edge_save_channel
            .ok_or_else(|| anyhow::anyhow!("No edge_save_channel in response"))
    }

    /// RPC: Save channel listeners for a user on disconnect.
    ///
    /// This is a best-effort fire-and-forget call; failures are logged but do
    /// not propagate to the caller.
    pub async fn save_channel_listeners(&self, user_id: u32, channel_ids: Vec<u32>) {
        if user_id == 0 {
            return; // Guests have no persistent listeners
        }
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "edge.saveChannelListeners".to_string(),
            timeout_ms: Some(5000),
            edge_save_channel_listeners: Some(hubedge::EdgeSaveChannelListenersParams {
                user_id,
                channel_ids,
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => {
                if let Some(result) = resp.edge_save_channel_listeners {
                    if !result.success {
                        warn!("Hub rejected channel listeners save for user {}: {:?}", user_id, result.error);
                    }
                }
            }
            Err(e) => warn!("Failed to save channel listeners for user {}: {}", user_id, e),
        }
    }

    /// RPC: Load persisted channel listeners for a user on connect.
    ///
    /// Returns the list of channel IDs the user was listening to at their last
    /// disconnect, or an empty `Vec` on failure.
    pub async fn load_channel_listeners(&self, user_id: u32) -> Vec<u32> {
        if user_id == 0 {
            return vec![]; // Guests have no persistent listeners
        }
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "edge.loadChannelListeners".to_string(),
            timeout_ms: Some(5000),
            edge_load_channel_listeners: Some(hubedge::EdgeLoadChannelListenersParams {
                user_id,
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => {
                resp.edge_load_channel_listeners
                    .map(|r| if r.success { r.channel_ids } else { vec![] })
                    .unwrap_or_default()
            }
            Err(e) => {
                warn!("Failed to load channel listeners for user {}: {}", user_id, e);
                vec![]
            }
        }
    }

    /// Notify Hub about a channel state change (including links_add/links_remove).
    pub async fn notify_channel_state(
        &self,
        channel_id: u32,
        links_add: Vec<u32>,
        links_remove: Vec<u32>,
    ) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handleChannelState".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_channel_state: Some(EdgeHandleChannelStateParams {
                edge_id,
                channel_id,
                links_add,
                links_remove,
                name: None,
                description: None,
                position: None,
                parent_id: None,
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to notify Hub of channel state: {}", e);
        }
    }

    /// Notify Hub about a channel removal request.
    pub async fn notify_channel_remove(&self, channel_id: u32) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handleChannelRemove".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_channel_remove: Some(EdgeHandleChannelRemoveParams {
                edge_id,
                channel_id,
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to notify Hub of channel remove: {}", e);
        }
    }

    /// Forward a text message to Hub for cross-edge delivery.
    pub async fn notify_text_message(&self, sender_session: u32, text_msg: &munode_protocol::mumbleproto::TextMessage) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handleTextMessage".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_text_message: Some(EdgeHandleTextMessageParams {
                actor: sender_session,
                edge_id,
                message: text_msg.message.clone(),
                channel_id: text_msg.channel_id.clone(),
                tree_id: text_msg.tree_id.clone(),
                session: text_msg.session.clone(),
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to forward text message to Hub: {}", e);
        }
    }

    /// Notify the Hub that a client triggered a context action.
    ///
    /// This allows Hub-side callbacks (plugins, Lua scripts) to respond to
    /// context menu interactions registered via `hub.contextActionModify`.
    pub async fn notify_context_action(
        &self,
        session_id: u32,
        action: munode_protocol::mumbleproto::ContextAction,
    ) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.contextAction".to_string(),
            timestamp: Some(current_millis() as i64),
            context_action: Some(EdgeContextActionParams {
                edge_id,
                session_id,
                action,
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to forward ContextAction to Hub: {}", e);
        }
    }

    /// RPC: Get ban list from Hub. Returns raw BanList protobuf bytes.
    pub async fn rpc_get_ban_list(&self) -> Option<Vec<u8>> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "edge.getBanList".to_string(),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.edge_handle_acl.and_then(|r| r.raw_data),
            Err(e) => {
                warn!("Failed to get ban list: {}", e);
                None
            }
        }
    }

    /// RPC: Update ban list on Hub using raw BanList protobuf bytes.
    pub async fn rpc_update_ban_list(&self, raw_ban_list: &[u8]) {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "edge.updateBanList".to_string(),
            edge_handle_acl: Some(EdgeHandleAclParams {
                edge_id: self.edge_id(),
                actor_session: 0,
                actor_user_id: 0,
                actor_username: String::new(),
                channel_id: 0,
                query: false,
                raw_data: raw_ban_list.to_vec(),
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(_) => debug!("Ban list updated on Hub"),
            Err(e) => warn!("Failed to update ban list: {}", e),
        }
    }

    /// RPC: Handle ACL query/update. Returns raw ACL protobuf bytes on query.
    pub async fn rpc_handle_acl(
        &self,
        actor_session: u32,
        actor_user_id: u32,
        actor_username: &str,
        channel_id: u32,
        query: bool,
        raw_data: &[u8],
    ) -> Option<Vec<u8>> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "edge.handleACL".to_string(),
            edge_handle_acl: Some(EdgeHandleAclParams {
                edge_id: self.edge_id(),
                actor_session,
                actor_user_id,
                actor_username: actor_username.to_string(),
                channel_id,
                query,
                raw_data: raw_data.to_vec(),
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.edge_handle_acl.and_then(|r| r.raw_data),
            Err(e) => {
                warn!("Failed to handle ACL: {}", e);
                None
            }
        }
    }

    /// RPC: Get the registered user list from Hub (returns raw protobuf UserList bytes).
    pub async fn rpc_get_user_list(&self) -> Option<Vec<u8>> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "edge.getUserList".to_string(),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.edge_handle_acl.and_then(|r| r.raw_data),
            Err(e) => {
                warn!("Failed to get user list: {}", e);
                None
            }
        }
    }

    /// RPC: Update (rename / de-register) users in Hub database.
    pub async fn rpc_update_user_list(&self, raw_user_list: &[u8]) -> bool {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "edge.updateUserList".to_string(),
            edge_handle_acl: Some(EdgeHandleAclParams {
                edge_id: self.edge_id(),
                actor_session: 0,
                actor_user_id: 0,
                actor_username: String::new(),
                channel_id: 0,
                query: false,
                raw_data: raw_user_list.to_vec(),
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.edge_handle_acl.map(|r| r.success).unwrap_or(false),
            Err(e) => {
                warn!("Failed to update user list: {}", e);
                false
            }
        }
    }

    /// Notify Hub of plugin data transmission for cross-edge forwarding.
    pub async fn notify_plugin_data(
        &self,
        sender_session: u32,
        sender_username: &str,
        data_id: &str,
        data: &[u8],
        receiver_sessions: &[u32],
    ) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handlePluginDataTransmission".to_string(),
            timestamp: Some(current_millis() as i64),
            plugin_data_transmission: Some(EdgePluginDataTransmissionParams {
                edge_id,
                actor_session: sender_session,
                actor_username: sender_username.to_string(),
                sender_session,
                data_id: data_id.to_string(),
                data: data.to_vec(),
                receiver_sessions: receiver_sessions.to_vec(),
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        if let Err(e) = self.send_packet(&packet).await {
            warn!("Failed to forward plugin data to Hub: {}", e);
        }
    }

    // ==================== Blob RPC Methods ====================

    /// RPC: Upload blob data to Hub. Returns SHA-256 hash on success.
    pub async fn blob_put(&self, data: Vec<u8>) -> Option<String> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "blob.put".to_string(),
            blob_put: Some(BlobPutParams { data }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.blob_put.and_then(|r| if r.success { r.hash } else { None }),
            Err(e) => { warn!("blob.put failed: {}", e); None }
        }
    }

    /// RPC: Download blob data by SHA-256 hash.
    pub async fn blob_get(&self, hash: &str) -> Option<Vec<u8>> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "blob.get".to_string(),
            blob_get: Some(BlobGetParams { hash: hash.to_string() }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.blob_get.and_then(|r| if r.success { r.data } else { None }),
            Err(e) => { warn!("blob.get failed: {}", e); None }
        }
    }

    /// RPC: Get user texture blob. Returns (hash, data) on success.
    pub async fn blob_get_user_texture(&self, user_id: u32) -> Option<(String, Vec<u8>)> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "blob.getUserTexture".to_string(),
            blob_get_user_texture: Some(BlobGetUserTextureParams { user_id }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.blob_get_user_texture.and_then(|r| {
                if r.success { Some((r.hash.unwrap_or_default(), r.data.unwrap_or_default())) } else { None }
            }),
            Err(e) => { warn!("blob.getUserTexture failed: {}", e); None }
        }
    }

    /// RPC: Get user comment blob. Returns (hash, data) on success.
    pub async fn blob_get_user_comment(&self, user_id: u32) -> Option<(String, Vec<u8>)> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "blob.getUserComment".to_string(),
            blob_get_user_comment: Some(BlobGetUserCommentParams { user_id }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.blob_get_user_comment.and_then(|r| {
                if r.success { Some((r.hash.unwrap_or_default(), r.data.unwrap_or_default())) } else { None }
            }),
            Err(e) => { warn!("blob.getUserComment failed: {}", e); None }
        }
    }

    /// RPC: Set user texture blob. Returns hash on success.
    pub async fn blob_set_user_texture(&self, user_id: u32, data: Vec<u8>) -> Option<String> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "blob.setUserTexture".to_string(),
            blob_set_user_texture: Some(BlobSetUserTextureParams { user_id, data }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.blob_set_user_texture.and_then(|r| if r.success { r.hash } else { None }),
            Err(e) => { warn!("blob.setUserTexture failed: {}", e); None }
        }
    }

    /// RPC: Set user comment blob. Returns hash on success.
    pub async fn blob_set_user_comment(&self, user_id: u32, data: Vec<u8>) -> Option<String> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id().await,
            method: "blob.setUserComment".to_string(),
            blob_set_user_comment: Some(BlobSetUserCommentParams { user_id, data }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.blob_set_user_comment.and_then(|r| if r.success { r.hash } else { None }),
            Err(e) => { warn!("blob.setUserComment failed: {}", e); None }
        }
    }

    /// Relay a voice packet to a target Edge via Hub TCP tunnel.
    /// Called when a local sender needs to reach a remote user on another edge.
    pub async fn relay_voice_via_hub(&self, target_edge_id: u32, voice_packet: Vec<u8>) {
        let from_edge_id = self.edge_id();
        let request_id = self.next_request_id().await;

        let request = TypedRpcRequest {
            request_id,
            method: "edge.relayVoiceViaTcp".to_string(),
            timeout_ms: Some(5000),
            edge_relay_voice_via_tcp: Some(hubedge::EdgeRelayVoiceViaTcpParams {
                from_edge_id,
                target_edge_id,
                voice_packet,
                timestamp: current_millis() as i64,
            }),
            ..Default::default()
        };

        if let Err(e) = self.rpc_call(request).await {
            debug!("relay_voice_via_hub to edge {} failed: {}", target_edge_id, e);
        }
    }

    /// Report link quality to a peer Edge to Hub for route table computation.
    pub async fn report_quality(&self, target_edge_id: u32, rtt_ms: f32, packet_loss: f32, jitter_ms: f32, samples: u32) {
        let from_edge_id = self.edge_id();
        let request_id = self.next_request_id().await;
        let request = TypedRpcRequest {
            request_id,
            method: "edge.reportQuality".to_string(),
            timeout_ms: Some(5000),
            edge_report_quality: Some(hubedge::EdgeReportQualityParams {
                edge_id: from_edge_id,
                target_edge_id,
                quality: hubedge::NetworkQualityProto {
                    rtt: rtt_ms,
                    packet_loss,
                    jitter: jitter_ms,
                    samples,
                },
            }),
            ..Default::default()
        };
        if let Err(e) = self.rpc_call(request).await {
            debug!("report_quality to edge {} failed: {}", target_edge_id, e);
        }
    }
}

/// Simple timestamp in millis (no external dependency needed).
fn current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Hex encoding helper (no external dependency).
mod hex {
    pub fn encode(data: &[u8]) -> String {
        data.iter().map(|b| format!("{:02x}", b)).collect()
    }
}


