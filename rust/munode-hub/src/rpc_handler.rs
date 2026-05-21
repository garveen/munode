use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use flate2::Compression;
use flate2::write::ZlibEncoder;
use prost::Message;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{debug, info, trace, warn};

use munode_common::config::HubConfig;
use munode_common::permission;
use munode_protocol::authservice::AuthRequest as ExtAuthRequest;
use munode_protocol::hubedge::*;
use munode_protocol::mumbleproto;

use crate::acl_manager::AclManager;
use crate::channel_store::ChannelRecord;
use crate::lua_auth::LuaAuthRequest;
use crate::server::HubState;
use crate::session_manager::SessionInfo;
use crate::topology_manager::{
    ArbitrationResult, LinkQuality, SourceDisseminationPlan, TopologyEdge,
};

mod admin;
mod auth;
mod blob;
mod channel;
mod cluster;
mod mutation;
mod notification;
mod relay;
mod sync;
mod voice_target;

/// HTTP auth request body sent to an external authentication endpoint.
#[derive(Debug, Serialize)]
struct HttpAuthRequest {
    username: String,
    password: String,
    tokens: Vec<String>,
    server_id: u32,
    session_id: u32,
    ip: String,
    ip_version: String,
    release: String,
    version: Option<u32>,
    os: String,
    osversion: String,
    certificate_hash: Option<String>,
}

/// HTTP auth response from an external authentication endpoint.
#[derive(Debug, Deserialize)]
struct HttpAuthResponse {
    success: bool,
    user_id: Option<u32>,
    username: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    groups: Option<Vec<String>>,
    reason: Option<String>,
    #[serde(rename = "rejectType")]
    reject_type: Option<u32>,
}

/// Sender type for pushing serialized packets to a specific edge.
pub type EdgeSender = mpsc::Sender<Vec<u8>>;

/// A set of outbound senders for a single Edge's connection pool.
///
/// Hub may maintain multiple WebSocket connections from the same Edge
/// (`pool_size > 1`). When a send fails because a connection has died,
/// the pool automatically falls back to the next available sender and
/// prunes the closed sender from the list.
#[derive(Clone)]
pub struct EdgeSenderPool {
    senders: std::sync::Arc<std::sync::Mutex<Vec<EdgeSender>>>,
}

impl EdgeSenderPool {
    /// Create a new pool containing a single sender.
    pub fn new(sender: EdgeSender) -> Self {
        Self {
            senders: std::sync::Arc::new(std::sync::Mutex::new(vec![sender])),
        }
    }

    /// Add a sender to the pool (called when a new pool connection registers).
    pub fn add(&self, sender: EdgeSender) {
        self.senders.lock().unwrap().push(sender);
    }

    /// Remove a specific sender from the pool (called on connection disconnect).
    ///
    /// Returns `true` if the pool is now empty (all connections for this edge gone).
    pub fn remove(&self, target: &EdgeSender) -> bool {
        let mut senders = self.senders.lock().unwrap();
        senders.retain(|sender| !sender.same_channel(target));
        senders.is_empty()
    }

    /// Number of active senders currently in the pool.
    pub fn len(&self) -> usize {
        self.senders.lock().unwrap().len()
    }

    /// Try to send `data` non-blocking. Falls back to the next sender if the
    /// current one is closed or full. Closed senders are pruned in-place.
    ///
    /// Returns `true` if the data was accepted by at least one sender.
    pub fn try_send(&self, data: Vec<u8>) -> bool {
        let mut senders = self.senders.lock().unwrap();
        let mut index = 0;
        while index < senders.len() {
            match senders[index].try_send(data.clone()) {
                Ok(()) => return true,
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    senders.swap_remove(index);
                }
                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                    index += 1;
                }
            }
        }
        false
    }

    /// Async send with backpressure. Tries each sender in order, skipping
    /// closed ones. Returns `true` if at least one send succeeded.
    ///
    /// Must NOT be called while holding the `edge_connections` lock.
    pub async fn send_async(&self, data: Vec<u8>) -> bool {
        let snapshot: Vec<EdgeSender> = self.senders.lock().unwrap().clone();
        for sender in snapshot {
            match sender.send(data.clone()).await {
                Ok(()) => return true,
                Err(_) => continue,
            }
        }
        false
    }
}

use crate::server::{EdgeRegistration, VoiceTargetEntry};

/// Handles all incoming RPC requests from edges.
pub struct RpcHandler {
    state: Arc<HubState>,
    /// Pre-compiled username regex (cached from config at startup).
    username_regex: Option<Regex>,
    /// Pre-compiled channel name regex (cached from config at startup).
    channel_name_regex: Option<Regex>,
    /// Shared HTTP client for external auth requests (keeps connection pool alive).
    http_client: reqwest::Client,
}

impl RpcHandler {
    pub(crate) async fn disconnect_edge_connections_for_fresh_register(
        &self,
        server_id: u32,
        keep_connection_id: u64,
    ) -> usize {
        let controls: Vec<crate::server::EdgeConnectionControl> = {
            let mut controls = self.state.edge_connection_controls.write().await;
            let mut detached = Vec::new();
            let remove_server_entry = if let Some(entries) = controls.get_mut(&server_id) {
                let stale_connection_ids: Vec<u64> = entries
                    .keys()
                    .copied()
                    .filter(|connection_id| *connection_id != keep_connection_id)
                    .collect();

                for connection_id in stale_connection_ids {
                    if let Some(control) = entries.remove(&connection_id) {
                        detached.push(control);
                    }
                }

                entries.is_empty()
            } else {
                false
            };

            if remove_server_entry {
                controls.remove(&server_id);
            }

            detached
        };

        if controls.is_empty() {
            return 0;
        }

        info!(
            "Fresh edge register for {}: forcibly shutting down {} old connection(s) without waiting",
            server_id,
            controls.len()
        );

        for control in &controls {
            control.shutdown.notify_waiters();
        }

        controls.len()
    }

    pub(crate) async fn is_connection_active(&self, server_id: u32, connection_id: u64) -> bool {
        let controls = self.state.edge_connection_controls.read().await;
        controls
            .get(&server_id)
            .map(|entries| entries.contains_key(&connection_id))
            .unwrap_or(false)
    }

    pub fn new(state: Arc<HubState>) -> Self {
        let username_regex =
            state
                .config
                .validation
                .username_regex
                .as_deref()
                .and_then(|pattern| match Regex::new(pattern) {
                    Ok(regex) => Some(regex),
                    Err(error) => {
                        warn!("Invalid username_regex '{}': {}", pattern, error);
                        None
                    }
                });
        let channel_name_regex = state
            .config
            .validation
            .channel_name_regex
            .as_deref()
            .and_then(|pattern| match Regex::new(pattern) {
                Ok(regex) => Some(regex),
                Err(error) => {
                    warn!("Invalid channel_name_regex '{}': {}", pattern, error);
                    None
                }
            });
        Self {
            state,
            username_regex,
            channel_name_regex,
            http_client: reqwest::Client::new(),
        }
    }

    /// Handle an RPC request from an edge. Returns the response packet bytes.
    pub async fn handle_request(
        &self,
        request: TypedRpcRequest,
        edge_server_id: u32,
        connection_id: u64,
    ) -> Result<Vec<u8>> {
        let request_id = request.request_id.clone();
        let method = request.method.clone();

        if method == "edge.relayVoiceViaTcp" {
            trace!("RPC request: {} (id={})", method, request_id);
        } else {
            debug!("RPC request: {} (id={})", method, request_id);
        }

        if method != "edge.register"
            && edge_server_id != 0
            && !self
                .is_connection_active(edge_server_id, connection_id)
                .await
        {
            warn!(
                edge_id = edge_server_id,
                connection_id,
                method,
                request_id,
                "Ignoring RPC from stale edge connection after fresh takeover"
            );
            return Ok(self
                .make_error_packet(&request_id, -1, "stale edge connection")
                .encode_to_vec());
        }

        let response = if method == "edge.relayVoiceViaTcp" {
            self.handle_relay_voice_via_tcp(request, &request_id).await
        } else {
            match method.as_str() {
                "edge.register" => {
                    self.handle_register(&request, &request_id, connection_id)
                        .await
                }
                "edge.authenticateUser" => {
                    self.handle_authenticate_user(
                        &request,
                        &request_id,
                        edge_server_id,
                        connection_id,
                    )
                    .await
                }
                "edge.reportSession" => {
                    self.handle_report_session(&request, &request_id, edge_server_id, connection_id)
                        .await
                }
                "edge.fullSync" => {
                    self.handle_full_sync(&request, &request_id, edge_server_id)
                        .await
                }
                "edge.handlePermissionQuery" => {
                    self.handle_permission_query(&request, &request_id).await
                }
                "edge.batchPermissionQuery" => {
                    self.handle_batch_permission_query(&request, &request_id)
                        .await
                }
                "edge.syncVoiceTarget" => {
                    self.handle_sync_voice_target(&request, &request_id).await
                }
                "edge.getVoiceTargets" => self.handle_get_voice_targets(&request_id).await,
                "edge.saveChannel" => self.handle_save_channel(&request, &request_id).await,
                "edge.handleACL" => self.handle_acl(&request, &request_id).await,
                "edge.getBanList" => self.handle_get_ban_list(&request, &request_id).await,
                "edge.updateBanList" => self.handle_update_ban_list(&request, &request_id).await,
                "edge.getUserList" => self.handle_get_user_list(&request_id).await,
                "edge.updateUserList" => self.handle_update_user_list(&request, &request_id).await,
                "edge.saveChannelListeners" => {
                    self.handle_save_channel_listeners(&request, &request_id)
                        .await
                }
                "edge.loadChannelListeners" => {
                    self.handle_load_channel_listeners(&request, &request_id)
                        .await
                }
                "blob.put" => self.handle_blob_put(&request, &request_id).await,
                "blob.get" => self.handle_blob_get(&request, &request_id).await,
                "blob.getUserTexture" => {
                    self.handle_blob_get_user_texture(&request, &request_id)
                        .await
                }
                "blob.getUserComment" => {
                    self.handle_blob_get_user_comment(&request, &request_id)
                        .await
                }
                "blob.setUserTexture" => {
                    self.handle_blob_set_user_texture(&request, &request_id)
                        .await
                }
                "blob.setUserComment" => {
                    self.handle_blob_set_user_comment(&request, &request_id)
                        .await
                }
                "edge.join" => {
                    self.handle_cluster_join(&request, &request_id, edge_server_id)
                        .await
                }
                "edge.joinComplete" => {
                    self.handle_cluster_join_complete(&request, &request_id)
                        .await
                }
                "edge.reportPeerDisconnect" => {
                    self.handle_report_peer_disconnect(&request, &request_id)
                        .await
                }
                "edge.reportQuality" => self.handle_report_quality(&request, &request_id).await,
                "cluster.getStatus" => self.handle_cluster_get_status(&request_id).await,
                "edge.userLeft" => {
                    self.handle_user_left_rpc(&request, &request_id, edge_server_id)
                        .await
                }
                "edge.userMoved" => {
                    self.handle_user_moved_rpc(&request, &request_id, edge_server_id)
                        .await
                }
                "edge.userStateChanged" => {
                    self.handle_user_state_changed_rpc(&request, &request_id, edge_server_id)
                        .await
                }
                "edge.channelState" => self.handle_channel_state_rpc(&request, &request_id).await,
                "edge.channelRemove" => self.handle_channel_remove_rpc(&request, &request_id).await,
                "edge.userRemove" => self.handle_user_remove_rpc(&request, &request_id).await,
                _ => {
                    warn!("Unknown RPC method: {}", method);
                    Ok(self.make_error_packet(
                        &request_id,
                        -1,
                        &format!("Unknown method: {}", method),
                    ))
                }
            }
        };

        match response {
            Ok(packet) => {
                let data = packet.encode_to_vec();
                let compressed = tokio::task::spawn_blocking(move || maybe_compress(data))
                    .await
                    .unwrap_or_else(|error| {
                        warn!("Compression task panicked: {}", error);
                        vec![]
                    });
                Ok(compressed)
            }
            Err(error) => {
                warn!("RPC handler error for {}: {}", method, error);
                let packet = self.make_error_packet(&request_id, -1, &error.to_string());
                Ok(packet.encode_to_vec())
            }
        }
    }

    /// Handle a notification from an edge.
    pub async fn handle_notification(
        &self,
        notification: TypedRpcNotification,
        edge_server_id: u32,
    ) {
        let method = &notification.method;
        debug!("Notification from edge {}: {}", edge_server_id, method);

        match method.as_str() {
            "hub.handleUserLeft" => {
                self.on_user_left(&notification).await;
            }
            "hub.handleUserRemove" => {
                self.on_user_remove(&notification).await;
            }
            "hub.handleUserMoved" => {
                self.on_user_moved(&notification).await;
            }
            "hub.handleUserStateChanged" => {
                self.on_user_state_changed(&notification).await;
            }
            "hub.handleTextMessage" => {
                self.on_text_message(&notification, edge_server_id).await;
            }
            "hub.handleChannelState" => {
                self.on_channel_state(&notification).await;
            }
            "hub.handleChannelRemove" => {
                self.on_channel_remove(&notification).await;
            }
            "hub.handlePluginDataTransmission" => {
                self.on_plugin_data(&notification, edge_server_id).await;
            }
            "hub.contextAction" => {
                if let Some(context_action) = &notification.context_action {
                    if let Some(ref action) = context_action.action {
                        debug!(
                            edge_id = edge_server_id,
                            session_id = context_action.session_id,
                            action = action.action.as_str(),
                            actor = action.session.unwrap_or(0),
                            channel = action.channel_id.unwrap_or(0),
                            "ContextAction received from edge (no Hub-side processing yet)"
                        );
                    }
                }
            }
            _ => {
                debug!("Unhandled notification: {}", method);
            }
        }
    }

    /// Save user's last channel when they disconnect (for auto-restore on reconnect).
    async fn save_user_last_channel(&self, session_id: u32) {
        if let Some(session) = self.state.session_manager.get_session(session_id).await {
            if session.user_id > 0 {
                if let Err(e) = self
                    .state
                    .user_store
                    .save_last_channel(session.user_id, session.channel_id)
                    .await
                {
                    warn!(
                        "Failed to save last channel for user {}: {}",
                        session.user_id, e
                    );
                }
            }
        }
    }

    // ==================== Helpers ====================

    /// Record a failed authentication attempt for the given IP address and apply an auto-ban
    /// if the threshold is reached. Returns `true` if the IP has now been banned.
    async fn record_auth_failure(&self, client_ip: &str) -> bool {
        let config = &self.state.config;
        if !config.auto_ban.enabled || client_ip.is_empty() {
            return false;
        }

        let count = self
            .state
            .failed_auth_tracker
            .write()
            .await
            .record_failure(client_ip, config.auto_ban.time_window);

        if count >= config.auto_ban.attempts {
            warn!(
                "Auto-banning IP {} after {} failed attempts",
                client_ip, count
            );
            if let Some(ip_bytes) = parse_ip_to_bytes(client_ip) {
                let ban = crate::database::BanRecord {
                    id: 0,
                    address: ip_bytes,
                    mask: if client_ip.contains(':') { 128 } else { 32 },
                    name: format!("auto-ban:{}", client_ip),
                    cert_hash: String::new(),
                    reason: format!("Auto-banned: {} failed login attempts", count),
                    start_time: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64,
                    duration: config.auto_ban.duration as u32,
                };
                if let Err(e) = self.state.ban_store.add_ban(&ban).await {
                    warn!("Failed to add auto-ban: {}", e);
                }
            } else {
                warn!(
                    "Auto-ban: unable to parse IP '{}', skipping DB entry",
                    client_ip
                );
            }
            self.state
                .failed_auth_tracker
                .write()
                .await
                .clear(client_ip);
            return true;
        }
        false
    }

    /// Broadcast a sequenced notification to all connected edges.
    ///
    /// Each edge receives a per-edge notification sequence number so it can
    /// detect gaps, duplicates, and apply state changes in order.
    async fn broadcast_notification<F>(&self, method: &str, build: F)
    where
        F: FnOnce(&mut TypedRpcNotification),
    {
        let mut notification = TypedRpcNotification {
            method: method.to_string(),
            timestamp: Some(current_millis() as i64),
            ..Default::default()
        };
        build(&mut notification);

        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };

        let data = packet.encode_to_vec();
        crate::server::broadcast_critical_sequenced(&self.state, data).await;
    }

    /// Like [`broadcast_notification`] but skips the edge identified by `exclude_edge_id`.
    ///
    /// Used when the notification originates from (or is only relevant to) a specific edge
    /// so that edge does not receive it back — for example, stale-session cleanup when an
    /// edge re-registers should only be sent to *other* edges, not to the re-registering
    /// edge itself, which would otherwise kick its own still-connected local users.
    async fn broadcast_notification_excluding<F>(
        &self,
        method: &str,
        exclude_edge_id: u32,
        build: F,
    ) where
        F: FnOnce(&mut TypedRpcNotification),
    {
        let mut notification = TypedRpcNotification {
            method: method.to_string(),
            timestamp: Some(current_millis() as i64),
            ..Default::default()
        };
        build(&mut notification);

        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };

        let data = packet.encode_to_vec();
        crate::server::broadcast_critical_excluding_sequenced(&self.state, data, exclude_edge_id)
            .await;
    }

    /// Return the current live server limits (updated on hot-reload).
    /// Used when building responses to edge registration and heartbeat ACK.
    pub(crate) async fn build_server_limits(&self) -> ServerLimitsConfig {
        self.state.live_limits.read().await.clone()
    }

    /// Load the welcome text asynchronously.
    ///
    /// If `welcome_text_file` is set, the file is read with `tokio::fs` (non-blocking).
    /// Falls back to the inline `welcome_text` config value on error or if not set.
    async fn load_welcome_text(&self) -> Option<String> {
        if let Some(ref file_path) = self.state.config.auth.welcome_text_file {
            match tokio::fs::read_to_string(file_path).await {
                Ok(text) => Some(text.trim_end().to_string()),
                Err(e) => {
                    warn!("Failed to read welcome_text_file '{}': {}", file_path, e);
                    self.state.config.auth.welcome_text.clone()
                }
            }
        } else {
            self.state.config.auth.welcome_text.clone()
        }
    }

    fn make_response_packet<F>(&self, request_id: &str, method: &str, build: F) -> EdgeHubPacket
    where
        F: FnOnce(&mut TypedRpcResponse),
    {
        let mut response = TypedRpcResponse {
            request_id: request_id.to_string(),
            method: Some(method.to_string()),
            processing_time_ms: None,
            ..Default::default()
        };
        build(&mut response);

        EdgeHubPacket {
            r#type: PacketType::RpcResponse as i32,
            rpc_response: Some(response),
            ..Default::default()
        }
    }

    /// Send a sequenced notification to a single specific edge.
    #[allow(dead_code)]
    pub(crate) async fn send_notification_to_edge<F>(&self, edge_id: u32, method: &str, build: F)
    where
        F: FnOnce(&mut TypedRpcNotification),
    {
        let mut notification = TypedRpcNotification {
            method: method.to_string(),
            timestamp: Some(current_millis() as i64),
            ..Default::default()
        };
        build(&mut notification);

        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };

        let data = packet.encode_to_vec();
        crate::server::notify_sequenced(&self.state, edge_id, data).await;
    }

    /// Send an unsequenced notification to a single edge.
    ///
    /// Use this for notifications that do not affect client-visible state (e.g.
    /// route table updates, ninja config, peer topology changes).
    pub(crate) async fn send_notification_to_edge_unsequenced<F>(
        &self,
        edge_id: u32,
        method: &str,
        build: F,
    ) where
        F: FnOnce(&mut TypedRpcNotification),
    {
        let mut notification = TypedRpcNotification {
            method: method.to_string(),
            timestamp: Some(current_millis() as i64),
            ..Default::default()
        };
        build(&mut notification);

        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };

        let data = packet.encode_to_vec();
        crate::server::notify(&self.state, edge_id, data).await;
    }

    /// Compute and push route tables to all connected edges.
    async fn push_route_tables_to_all(&self) {
        // Hold the topology read lock only for the Dijkstra computations; drop before
        // sending (which involves I/O and may block).  Multiple concurrent readers are
        // fine since this is a shared read lock — only topology writers are briefly
        // paused.  For typical cluster sizes (2–20 edges) the total computation time
        // is well under a millisecond.
        let route_epoch = current_millis() as u64;
        let edge_data: Vec<(
            u32,
            Vec<(u32, u32, Vec<u32>, f32)>,
            Vec<SourceDisseminationPlan>,
        )> = {
            let topo = self.state.topology.read().await;
            let config = &self.state.config.voice_routing;
            topo.get_all_edges()
                .iter()
                .map(|e| {
                    (
                        e.edge_id,
                        topo.compute_route_table(e.edge_id, config),
                        topo.compute_dissemination_plan(e.edge_id, config),
                    )
                })
                .collect()
        }; // lock released here

        for (edge_id, routes, dissemination_sources) in edge_data {
            let max_ttl_val = self.state.config.voice_routing.max_ttl;
            if !routes.is_empty() {
                self.send_notification_to_edge_unsequenced(edge_id, "hub.routeTableUpdate", |n| {
                    n.route_table_update = Some(HubRouteTableUpdateParams {
                        routes: routes
                            .into_iter()
                            .map(|(target, rtype, relay_chain, cost)| {
                                let relay_transports = vec![0u32; relay_chain.len()];
                                HubRouteEntryProto {
                                    target_edge_id: target,
                                    route_type: rtype,
                                    relay_chain,
                                    relay_transports,
                                    cost,
                                }
                            })
                            .collect(),
                        max_ttl: Some(max_ttl_val),
                    });
                })
                .await;
            }

            self.send_notification_to_edge_unsequenced(edge_id, "hub.disseminationUpdate", |n| {
                n.dissemination_update = Some(HubDisseminationUpdateParams {
                    sources: dissemination_sources
                        .into_iter()
                        .map(|source| HubSourceDisseminationProto {
                            source_edge_id: source.source_edge_id,
                            active_children: source.active_children,
                            duplicate_children: source.duplicate_children,
                            branch_backups: source
                                .branch_backups
                                .into_iter()
                                .map(|(primary_child_edge_id, backup_next_hops)| {
                                    HubDisseminationBackupProto {
                                        primary_child_edge_id,
                                        backup_next_hops,
                                    }
                                })
                                .collect(),
                        })
                        .collect(),
                    route_epoch: Some(route_epoch),
                    max_ttl: Some(max_ttl_val),
                });
            })
            .await;
        }
    }

    fn make_error_packet(&self, request_id: &str, code: i32, message: &str) -> EdgeHubPacket {
        EdgeHubPacket {
            r#type: PacketType::RpcError as i32,
            rpc_error: Some(RpcError {
                request_id: request_id.to_string(),
                code,
                message: message.to_string(),
                details: None,
            }),
            ..Default::default()
        }
    }

    /// Remove all sessions and authoritative cluster state for a disconnected edge.
    ///
    /// Called only after the last old connection for that edge has fully exited.
    /// See audit C2 / C5 in `docs/edge-hub-consistency-audit.md`.
    pub async fn cleanup_edge(&self, server_id: u32) {
        // Cancel any in-flight `authenticate_user` tasks owned by this edge so
        // that sessions mid-auth do not ghost after edge-level cleanup.
        {
            let pending = self.state.pending_auths.read().await;
            for (_sid, entry) in pending.iter() {
                if entry.edge_id == server_id {
                    entry.cancel.store(true, Ordering::Relaxed);
                }
            }
        }

        let sessions = self
            .state
            .session_manager
            .get_sessions_by_edge(server_id)
            .await;
        info!(
            server_id,
            session_count = sessions.len(),
            "Cleaning up Hub state for edge"
        );
        for session in &sessions {
            self.state
                .session_manager
                .remove_session(session.session_id)
                .await;

            let remove_params = HubUserRemoveBroadcastParams {
                session: session.session_id,
                actor: None,
                reason: Some("Edge disconnected".to_string()),
                ban: None,
                target_sessions: vec![],
            };
            // Exclude the disconnecting/reconnecting edge from the broadcast.
            // If the edge is reconnecting, its new connection must not receive a
            // spurious UserRemove for its own still-connected local clients.
            // Other edges still need the notification to purge stale remote-user entries.
            self.broadcast_notification_excluding("hub.userRemoveBroadcast", server_id, |n| {
                n.user_remove_broadcast = Some(remove_params);
            })
            .await;
        }

        self.state.edge_registry.write().await.remove(&server_id);

        // Remove from cluster topology
        self.state.topology.write().await.remove_edge(server_id);

        // Drop the per-edge inbound notification processor and sequence counter
        // so a later re-registration starts with a fresh state machine.
        self.state
            .edge_notif_senders
            .write()
            .await
            .remove(&server_id);
        if let Ok(mut seqs) = self.state.notification_seqs.lock() {
            seqs.remove(&server_id);
        }

        // Notify remaining edges that this peer has left the cluster so they
        // stop their relay reconnect loops and clean up UDP routing entries.
        self.broadcast_notification("hub.peerLeft", |n| {
            n.cluster_peer_left = Some(HubClusterPeerLeftParams { edge_id: server_id });
        })
        .await;

        if !sessions.is_empty() {
            info!(
                "Cleaned up {} sessions for disconnected edge {}",
                sessions.len(),
                server_id
            );
        }
    }
}

/// Generate a random challenge string for HMAC authentication.
fn generate_challenge() -> Result<String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let rng = SystemRandom::new();
    let mut buf = [0u8; 32];
    rng.fill(&mut buf)
        .map_err(|_| anyhow::anyhow!("RNG failed: system entropy unavailable"))?;
    Ok(hex_encode(&buf))
}

/// Compute HMAC-SHA256 of `challenge:server_id` with the given secret.
fn compute_hmac(secret: &str, challenge: &str, server_id: u32) -> String {
    use ring::hmac;
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let data = format!("{}:{}", challenge, server_id);
    let signature = hmac::sign(&key, data.as_bytes());
    hex_encode(signature.as_ref())
}

fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Build the ancestor chain `[root, …, parent, channel_id]` from a pre-snapshotted
/// parent map (produced by [`ChannelStore::get_parent_and_inherit_snapshot`]).
///
/// Using this free function instead of `ChannelStore::get_channel()` in a loop
/// avoids O(depth) async lock acquisitions per channel.  The snapshot is acquired
/// once before the batch and shared read-only across all chain builds.
fn build_ancestor_chain(snapshot: &HashMap<u32, (Option<u32>, bool)>, channel_id: u32) -> Vec<u32> {
    let mut chain = Vec::new();
    let mut current = channel_id;
    loop {
        chain.push(current);
        if current == 0 {
            break;
        }
        match snapshot.get(&current) {
            Some((Some(parent), _)) => current = *parent,
            _ => break,
        }
    }
    chain.reverse();
    chain
}

fn current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Hash a password using Argon2id (PHC string format).
#[allow(dead_code)]
pub fn hash_password(password: &str) -> Result<String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let rng = SystemRandom::new();
    let mut salt_bytes = [0u8; 16];
    rng.fill(&mut salt_bytes)
        .map_err(|_| anyhow::anyhow!("RNG failed"))?;
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|e| anyhow::anyhow!("Salt encoding failed: {}", e))?;
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("Password hashing failed: {}", e))?
        .to_string();
    Ok(hash)
}

/// Verify a password against an Argon2id PHC hash string.
fn verify_password(hash: &str, password: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Parse an IP address string (IPv4 or IPv6) into a 16-byte array (IPv4-mapped IPv6 format).
/// Returns `None` if the address cannot be parsed so the caller can skip the ban.
fn parse_ip_to_bytes(ip: &str) -> Option<[u8; 16]> {
    use std::net::IpAddr;
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => Some(v4.to_ipv6_mapped().octets()),
        Ok(IpAddr::V6(v6)) => Some(v6.octets()),
        Err(_) => None,
    }
}

/// Compress `data` with zlib (fast level) if it exceeds 4 KiB.
///
/// Compressed frames are prefixed with `0x01`.  Raw frames always start with a
/// protobuf field tag (≥ `0x08`), so `0x01` is unambiguous as a compression flag.
/// The Edge decompresses by checking the first byte before decoding.
pub(crate) fn maybe_compress(data: Vec<u8>) -> Vec<u8> {
    const COMPRESS_THRESHOLD: usize = 4096;
    if data.len() <= COMPRESS_THRESHOLD {
        return data;
    }
    let mut out = Vec::with_capacity(data.len() / 2 + 1);
    out.push(0x01u8); // compression flag
    let mut enc = ZlibEncoder::new(&mut out, Compression::fast());
    if enc.write_all(&data).is_err() {
        return data; // fall back to raw on unexpected error
    }
    match enc.finish() {
        Ok(_) => out,
        Err(_) => data,
    }
}

/// Build a `ServerLimitsConfig` from the given `HubConfig`.
///
/// This free function is used both at startup (to initialise `HubState::live_limits`)
/// and inside the SIGHUP hot-reload handler (to compute the updated limits from the
/// newly loaded config before broadcasting them to all connected Edges).
///
/// Note: the `welcome_text_file` path is intentionally NOT read here because this
/// function is synchronous.  Callers that need the file-based welcome text should
/// overwrite `welcome_text` after calling this function (see the SIGHUP handler in
/// `server.rs` and `RpcHandler::handle_register`).
pub(crate) fn server_limits_from_config(config: &HubConfig) -> ServerLimitsConfig {
    let limits = &config.limits;
    let suggest = &config.suggest;
    let (suggest_version, suggest_version_v2) = suggest
        .parse_version()
        .map(|(v1, v2)| (Some(v1), Some(v2)))
        .unwrap_or((None, None));
    let welcome = config.auth.welcome_text.clone();
    ServerLimitsConfig {
        max_bandwidth: Some(limits.max_bandwidth),
        text_message_length: Some(limits.text_message_length),
        image_message_length: Some(limits.image_message_length),
        plugin_message_length: Some(limits.plugin_message_length),
        message_rate: Some(limits.message_rate),
        message_burst: Some(limits.message_burst),
        max_users: Some(limits.max_users),
        listeners_per_channel: Some(limits.listeners_per_channel),
        listeners_per_user: Some(limits.listeners_per_user),
        suggest_version,
        suggest_positional: suggest.positional,
        suggest_push_to_talk: suggest.push_to_talk,
        welcome_text: welcome,
        suggest_version_v2,
        max_users_per_channel: if limits.max_users_per_channel > 0 {
            Some(limits.max_users_per_channel)
        } else {
            None
        },
        allow_ping: Some(limits.allow_ping),
    }
}

// ==================== Edge→Hub Inbound Notification Sequencer ====================

/// Gap timeout for the Edge→Hub notification reorder buffer.
///
/// If a seq gap persists for longer than this duration (i.e., the missing packet may
/// have been dropped or reordered across pool slots), the sequencer skips ahead to
/// the earliest buffered seq rather than blocking indefinitely.
const EDGE_NOTIF_GAP_TIMEOUT: Duration = Duration::from_secs(2);

/// Per-edge sequencer for inbound Edge→Hub control notifications.
///
/// Holds out-of-order notifications in a `BTreeMap` reorder buffer until the missing
/// predecessor arrives (or the gap timeout fires), then flushes them in emission
/// order.  `expected_seq == 0` means "not yet initialised"—the first received seq
/// sets the baseline so Hub accepts any starting seq from the Edge.
struct EdgeInboundSequencer {
    expected_seq: u64,
    buffer: BTreeMap<u64, TypedRpcNotification>,
    gap_since: Option<Instant>,
}

impl EdgeInboundSequencer {
    fn new() -> Self {
        Self {
            expected_seq: 0,
            buffer: BTreeMap::new(),
            gap_since: None,
        }
    }

    /// Feed one envelope; return any notifications now ready for processing.
    fn feed(
        &mut self,
        seq: Option<u64>,
        notification: TypedRpcNotification,
    ) -> Vec<TypedRpcNotification> {
        let seq = match seq {
            // Unsequenced (legacy or unsequenced packet): pass through immediately.
            None => return vec![notification],
            Some(s) => s,
        };

        // First ever sequenced notification: initialise expected_seq from it.
        if self.expected_seq == 0 {
            self.expected_seq = seq;
        }

        if seq < self.expected_seq {
            // Duplicate or stale arrival after a gap skip — discard silently.
            return vec![];
        }

        if seq == self.expected_seq {
            // In-order delivery: emit and flush consecutive buffered entries.
            let mut out = vec![notification];
            self.expected_seq += 1;
            self.gap_since = None;
            while let Some(n) = self.buffer.remove(&self.expected_seq) {
                out.push(n);
                self.expected_seq += 1;
            }
            out
        } else {
            // Out-of-order: buffer and record gap start time.
            self.buffer.insert(seq, notification);
            if self.gap_since.is_none() {
                self.gap_since = Some(Instant::now());
            }
            vec![]
        }
    }

    /// Remaining time before the active gap times out, if any gap is active.
    fn gap_remaining(&self) -> Option<Duration> {
        self.gap_since
            .map(|t| EDGE_NOTIF_GAP_TIMEOUT.saturating_sub(t.elapsed()))
    }

    /// Skip to the earliest buffered seq after a gap timeout and flush from there.
    fn skip_gap(&mut self) -> Vec<TypedRpcNotification> {
        if let Some((&next_seq, _)) = self.buffer.iter().next() {
            warn!(
                "Edge→Hub sequencer: expected seq {} timed out, skipping to {} (edge notification gap)",
                self.expected_seq, next_seq
            );
            self.expected_seq = next_seq;
            self.gap_since = None;
            let mut out = vec![];
            while let Some(n) = self.buffer.remove(&self.expected_seq) {
                out.push(n);
                self.expected_seq += 1;
            }
            out
        } else {
            self.gap_since = None;
            vec![]
        }
    }
}

/// Long-running task that processes inbound Edge→Hub notifications for one edge
/// in strict emission order.
///
/// One task is spawned per registered Edge (`EdgeConnection::ensure_edge_notif_processor`).
/// The task owns an `EdgeInboundSequencer` and processes notifications serially so
/// Hub’s upper-layer handlers never observe out-of-order events from the same Edge,
/// regardless of which WebSocket pool slot delivered each message.
/// The task exits when the sender side of the channel is dropped (edge disconnected).
pub(crate) async fn run_edge_notif_processor(
    edge_id: u32,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<crate::server::EdgeNotifEnvelope>,
    rpc_handler: Arc<RpcHandler>,
) {
    let mut seq = EdgeInboundSequencer::new();

    loop {
        // Choose receive strategy: block normally when no gap is active, or wait
        // with a deadline when we’re buffering out-of-order notifications.
        let envelope = if let Some(remaining) = seq.gap_remaining() {
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(env)) => env,
                Ok(None) => break, // channel closed — edge disconnected
                Err(_) => {
                    // Gap timeout: skip missing seq and process whatever is buffered.
                    for n in seq.skip_gap() {
                        rpc_handler.handle_notification(n, edge_id).await;
                    }
                    warn!(
                        edge_id,
                        "Edge {} seq gap skipped — sending hub.forceFullSync to trigger resync",
                        edge_id
                    );
                    rpc_handler
                        .send_notification_to_edge(edge_id, "hub.forceFullSync", |_| {})
                        .await;
                    continue;
                }
            }
        } else {
            match rx.recv().await {
                Some(env) => env,
                None => break, // channel closed — edge disconnected
            }
        };

        for n in seq.feed(envelope.seq, envelope.notification) {
            rpc_handler.handle_notification(n, edge_id).await;
        }
    }

    debug!("Notification processor for edge {} exited", edge_id);
}
