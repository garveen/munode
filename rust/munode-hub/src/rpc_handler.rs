use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::password_hash::SaltString;
use flate2::Compression;
use flate2::write::ZlibEncoder;
use prost::Message;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{debug, info, trace, warn};

use munode_protocol::authservice::{AuthRequest as ExtAuthRequest};
use munode_protocol::hubedge::*;
use munode_protocol::mumbleproto;
use munode_common::config::HubConfig;
use munode_common::permission;

use crate::acl_manager::AclManager;
use crate::channel_store::ChannelRecord;
use crate::lua_auth::LuaAuthRequest;
use crate::server::HubState;
use crate::session_manager::SessionInfo;
use crate::topology_manager::{ArbitrationResult, LinkQuality, TopologyEdge};

mod blob;
mod admin;
mod channel;
mod cluster;
mod mutation;
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
/// (`pool_size > 1`).  When a send fails because a connection has died,
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
        senders.retain(|s| !s.same_channel(target));
        senders.is_empty()
    }

    /// Number of active senders currently in the pool.
    pub fn len(&self) -> usize {
        self.senders.lock().unwrap().len()
    }

    /// Try to send `data` non-blocking.  Falls back to the next sender if the
    /// current one is closed or full.  Closed senders are pruned in-place.
    ///
    /// Returns `true` if the data was accepted by at least one sender.
    pub fn try_send(&self, data: Vec<u8>) -> bool {
        let mut senders = self.senders.lock().unwrap();
        let mut i = 0;
        while i < senders.len() {
            match senders[i].try_send(data.clone()) {
                Ok(()) => return true,
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    // Connection dead — prune and try next (swap_remove keeps index valid)
                    senders.swap_remove(i);
                }
                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                    // Channel full — try next sender
                    i += 1;
                }
            }
        }
        false
    }

    /// Async send with backpressure.  Tries each sender in order, skipping
    /// closed ones.  Returns `true` if at least one send succeeded.
    ///
    /// Must NOT be called while holding the `edge_connections` lock.
    pub async fn send_async(&self, data: Vec<u8>) -> bool {
        // Snapshot under lock so the mutex is not held across `.await`.
        let snapshot: Vec<EdgeSender> = self.senders.lock().unwrap().clone();
        for sender in snapshot {
            match sender.send(data.clone()).await {
                Ok(()) => return true,
                Err(_) => continue, // closed, try next
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
    pub fn new(state: Arc<HubState>) -> Self {
        let username_regex = state.config.validation.username_regex.as_deref()
            .and_then(|p| match Regex::new(p) {
                Ok(re) => Some(re),
                Err(e) => {
                    warn!("Invalid username_regex '{}': {}", p, e);
                    None
                }
            });
        let channel_name_regex = state.config.validation.channel_name_regex.as_deref()
            .and_then(|p| match Regex::new(p) {
                Ok(re) => Some(re),
                Err(e) => {
                    warn!("Invalid channel_name_regex '{}': {}", p, e);
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
    ) -> Result<Vec<u8>> {
        let request_id = request.request_id.clone();
        let method = request.method.clone();

        // High-frequency voice relay requests are trace-level to avoid log flooding.
        if method == "edge.relayVoiceViaTcp" {
            trace!("RPC request: {} (id={})", method, request_id);
        } else {
            debug!("RPC request: {} (id={})", method, request_id);
        }

        let response = if method == "edge.relayVoiceViaTcp" {
            self.handle_relay_voice_via_tcp(request, &request_id).await
        } else {
            match method.as_str() {
            "edge.register" => self.handle_register(&request, &request_id).await,
            "edge.authenticateUser" => self.handle_authenticate_user(&request, &request_id, edge_server_id).await,
            "edge.reportSession" => self.handle_report_session(&request, &request_id, edge_server_id).await,
            "edge.fullSync" => self.handle_full_sync(&request, &request_id, edge_server_id).await,
            "edge.handlePermissionQuery" => self.handle_permission_query(&request, &request_id).await,
            "edge.batchPermissionQuery" => self.handle_batch_permission_query(&request, &request_id).await,
            "edge.syncVoiceTarget" => self.handle_sync_voice_target(&request, &request_id).await,
            "edge.getVoiceTargets" => self.handle_get_voice_targets(&request_id).await,
            "edge.saveChannel" => self.handle_save_channel(&request, &request_id).await,
            "edge.handleACL" => self.handle_acl(&request, &request_id).await,
            "edge.getBanList" => self.handle_get_ban_list(&request, &request_id).await,
            "edge.updateBanList" => self.handle_update_ban_list(&request, &request_id).await,
            "edge.getUserList" => self.handle_get_user_list(&request_id).await,
            "edge.updateUserList" => self.handle_update_user_list(&request, &request_id).await,
            "edge.saveChannelListeners" => self.handle_save_channel_listeners(&request, &request_id).await,
            "edge.loadChannelListeners" => self.handle_load_channel_listeners(&request, &request_id).await,
            "blob.put" => self.handle_blob_put(&request, &request_id).await,
            "blob.get" => self.handle_blob_get(&request, &request_id).await,
            "blob.getUserTexture" => self.handle_blob_get_user_texture(&request, &request_id).await,
            "blob.getUserComment" => self.handle_blob_get_user_comment(&request, &request_id).await,
            "blob.setUserTexture" => self.handle_blob_set_user_texture(&request, &request_id).await,
            "blob.setUserComment" => self.handle_blob_set_user_comment(&request, &request_id).await,
            "edge.join" => self.handle_cluster_join(&request, &request_id, edge_server_id).await,
            "edge.joinComplete" => self.handle_cluster_join_complete(&request, &request_id).await,
            "edge.reportPeerDisconnect" => self.handle_report_peer_disconnect(&request, &request_id).await,
            "edge.reportQuality" => self.handle_report_quality(&request, &request_id).await,
            "cluster.getStatus" => self.handle_cluster_get_status(&request_id).await,
            // State-mutation RPCs (converted from fire-and-forget notifications)
            "edge.userLeft"           => self.handle_user_left_rpc(&request, &request_id, edge_server_id).await,
            "edge.userMoved"          => self.handle_user_moved_rpc(&request, &request_id, edge_server_id).await,
            "edge.userStateChanged"   => self.handle_user_state_changed_rpc(&request, &request_id, edge_server_id).await,
            "edge.channelState"       => self.handle_channel_state_rpc(&request, &request_id).await,
            "edge.channelRemove"      => self.handle_channel_remove_rpc(&request, &request_id).await,
            "edge.userRemove"         => self.handle_user_remove_rpc(&request, &request_id).await,
            _ => {
                warn!("Unknown RPC method: {}", method);
                Ok(self.make_error_packet(&request_id, -1, &format!("Unknown method: {}", method)))
            }
            }
        };

        match response {
            Ok(packet) => {
                let data: Vec<u8> = packet.encode_to_vec();
                // Offload compression to a blocking thread to avoid stalling the Tokio worker.
                let compressed =
                    tokio::task::spawn_blocking(move || maybe_compress(data))
                        .await
                        .unwrap_or_else(|e| {
                            warn!("Compression task panicked: {}", e);
                            vec![]
                        });
                Ok(compressed)
            }
            Err(e) => {
                warn!("RPC handler error for {}: {}", method, e);
                let packet: EdgeHubPacket = self.make_error_packet(&request_id, -1, &e.to_string());
                let data = packet.encode_to_vec();
                Ok(data)
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
                if let Some(ca) = &notification.context_action {
                    if let Some(ref action) = ca.action {
                        debug!(
                            edge_id = edge_server_id,
                            session_id = ca.session_id,
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

    // ==================== RPC Handlers ====================

    async fn handle_register(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_register.as_ref()
            .context("Missing edge_register params")?;

        // Check HMAC challenge-response if configured
        if let Some(hmac_secret) = &self.state.config.registry.hmac_secret {
            if params.challenge_response.is_none() {
                // Send challenge to the edge
                let challenge = generate_challenge()?;
                let result = EdgeRegisterResult {
                    success: false,
                    hub_server_id: None,
                    edge_list: vec![],
                    challenge: Some(challenge),
                    challenge_timeout: Some(30000),
                    error: None,
                    server_limits: None,
                };
                return Ok(self.make_response_packet(request_id, "edge.register", |r| {
                    r.edge_register = Some(result);
                }));
            }

            // Verify the challenge-response
            if let (Some(challenge), Some(response)) =
                (&params.challenge, &params.challenge_response)
            {
                let expected = compute_hmac(hmac_secret, challenge, params.server_id);
                if *response != expected {
                    let result = EdgeRegisterResult {
                        success: false,
                        hub_server_id: None,
                        edge_list: vec![],
                        challenge: None,
                        challenge_timeout: None,
                        error: Some("HMAC verification failed".to_string()),
                        server_limits: None,
                    };
                    return Ok(self.make_response_packet(request_id, "edge.register", |r| {
                        r.edge_register = Some(result);
                    }));
                }
            }
        }

        // Clean up any stale sessions left over from a previous instance of this edge
        // (handles the case where the edge process restarted while Hub was still running).
        // We do NOT clean up sessions when Hub itself restarted, because in that case
        // Hub's session table is already empty.
        //
        // IMPORTANT: with the relay-slot pool design, the last pool slot (relay slot)
        // maintains Hub connectivity during direct-path outages.  When a direct slot
        // reconnects while the relay slot is still alive, `edge_connections` already
        // contains the relay slot's sender (pool.len() > 1).  In that case the edge
        // never truly disconnected — its sessions are still valid and must NOT be
        // broadcast as `userRemoveBroadcast` to other Edges.
        let is_additional_pool_slot = self.state.edge_connections.read().await
            .get(&params.server_id)
            .map(|pool| pool.len() > 1)
            .unwrap_or(false);

        let stale_sessions = self.state.session_manager
            .get_sessions_by_edge(params.server_id).await;
        if !stale_sessions.is_empty() {
            if is_additional_pool_slot {
                // Another pool slot (typically the relay slot) is already connected.
                // Sessions are still valid — the Edge is merely adding a new WS slot.
                debug!(
                    "Edge {} adding pool slot (pool size > 1): preserving {} existing session(s)",
                    params.server_id, stale_sessions.len()
                );
            } else {
                warn!(
                    "Edge {} re-registered with {} stale session(s) — cleaning up",
                    params.server_id, stale_sessions.len()
                );
                let reconnecting_edge_id = params.server_id;
                for session in &stale_sessions {
                    self.state.session_manager.remove_session(session.session_id).await;
                    let session_id = session.session_id;
                    // Exclude the re-registering edge from this broadcast: its local users are
                    // still connected and must not be kicked by the stale-session cleanup.
                    // Other edges need the notification so they can remove the ghost sessions
                    // from their own caches.  The re-registering edge will learn the authoritative
                    // state via do_full_sync + do_report_local_users.
                    self.broadcast_notification_excluding("hub.userRemoveBroadcast", reconnecting_edge_id, |n| {
                        n.user_remove_broadcast = Some(HubUserRemoveBroadcastParams {
                            session: session_id,
                            actor: None,
                            reason: Some("Edge reconnected - session cleanup".to_string()),
                            ban: None,
                            target_sessions: vec![],
                        });
                    }).await;
                }
                info!("Cleaned up {} stale session(s) for re-registering edge {}", stale_sessions.len(), params.server_id);
            }
        }

        // Register the edge
        let registration = EdgeRegistration {
            server_id: params.server_id,
            name: params.name.clone(),
            host: params.host.clone(),
            port: params.port,
            capacity: params.capacity,
            region: params.region.clone(),
            relay_port: None,
        };

        info!(
            "Edge registered: {} (id={}, {}:{})",
            registration.name, registration.server_id, registration.host, registration.port
        );

        self.state.edge_registry
            .write()
            .await
            .insert(params.server_id, registration);

        // Build edge list for response
        let edge_list: Vec<EdgeInfo> = self.state.edge_registry
            .read()
            .await
            .values()
            .map(|e| EdgeInfo {
                server_id: e.server_id,
                name: e.name.clone(),
                host: e.host.clone(),
                port: e.port,
                region: e.region.clone(),
                current_load: 0,
                capacity: e.capacity,
                certificate: String::new(),
                last_seen: current_millis() as i64,
            })
            .collect();

        let mut server_limits = self.build_server_limits().await;
        server_limits.welcome_text = self.load_welcome_text().await;
        let result = EdgeRegisterResult {
            success: true,
            hub_server_id: Some(params.server_id),
            edge_list,
            challenge: None,
            challenge_timeout: None,
            error: None,
            server_limits: Some(server_limits),
        };

        let response = self.make_response_packet(request_id, "edge.register", |r| {
            r.edge_register = Some(result);
        });

        // Push route tables to all edges so new edge and existing edges see each other
        self.push_route_tables_to_all().await;

        Ok(response)
    }

    /// Enforce the per-user concurrent session limit for a non-anonymous user.
    ///
    /// If `user_id == 0` (anonymous) or `max_sessions == 0` (unlimited), this is a no-op.
    /// Otherwise, all existing sessions for `user_id` are collected, sorted by session_id
    /// ascending (oldest first), and excess sessions are removed and broadcast-kicked until
    /// the remaining count is strictly below `max_sessions`.
    async fn kick_excess_sessions_for_user(&self, user_id: u32, max_sessions: u32) {
        if user_id == 0 || max_sessions == 0 {
            return;
        }
        let mut existing = self.state.session_manager.get_sessions_by_user(user_id).await;
        if existing.len() < max_sessions as usize {
            return;
        }
        // Sort by session_id ascending so the oldest (lowest ID) is kicked first.
        existing.sort_by_key(|s| s.session_id);
        let to_kick = existing.len() - max_sessions as usize + 1;
        for session in existing.into_iter().take(to_kick) {
            let ghost_session = session.session_id;
            self.state.session_manager.remove_session(ghost_session).await;
            self.broadcast_notification("hub.userRemoveBroadcast", |n| {
                n.user_remove_broadcast = Some(HubUserRemoveBroadcastParams {
                    session: ghost_session,
                    actor: None,
                    reason: Some("Replaced by new connection (session limit reached)".to_string()),
                    ban: None,
                    target_sessions: vec![],
                });
            }).await;
            info!(
                "Kicked oldest session {} for user_id={} due to max_sessions_per_user={}",
                ghost_session, user_id, max_sessions
            );
        }
    }

    async fn handle_authenticate_user(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        edge_server_id: u32,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_authenticate_user.as_ref()
            .context("Missing edge_authenticate_user params")?;

        let config = &self.state.config;
        let username = &params.username;
        let password = &params.password;

        // Register a cancel flag so `on_user_left` / `cleanup_edge` can abort this
        // auth task when the client disconnects while auth is in progress.
        // The flag is checked immediately before each `session_manager.add_session`
        // call to prevent ghost sessions from being created.
        let cancel = Arc::new(AtomicBool::new(false));
        self.state.pending_auths.write().await
            .insert(params.session_id, (cancel.clone(), edge_server_id));

        // ------------------------------------------------------------------
        // Step -1: Validation rules — reject if username doesn't match regex
        // ------------------------------------------------------------------
        if let Some(re) = &self.username_regex {
            if !re.is_match(username) {
                warn!("Rejecting username '{}': does not match configured username_regex", username);
                let result = EdgeAuthenticateUserResult {
                    success: false,
                    user_id: None, username: None, display_name: None,
                    groups: vec![],
                    reason: Some(format!("Invalid username: '{}' does not meet naming requirements", username)),
                    reject_type: Some(mumbleproto::reject::RejectType::InvalidUsername as u32),
                    channel_id: None,
                    mute: None, deaf: None, suppress: None,
                    self_mute: None, self_deaf: None,
                    priority_speaker: None, recording: None,
                    cert_required: None,
                };
                return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                    r.edge_authenticate_user = Some(result);
                }));
            }
        }

        // ------------------------------------------------------------------
        // Step 0: Auto-ban check — reject if IP has been auto-banned
        // ------------------------------------------------------------------
        let client_ip = params.client_info.as_ref()
            .map(|c| c.ip_address.clone())
            .unwrap_or_default();
        if config.auto_ban.enabled && !client_ip.is_empty() {
            // Periodically purge stale tracking entries
            self.state.failed_auth_tracker.write().await.purge_stale(config.auto_ban.time_window);

            // Check if this IP is currently in the ban list (in-memory, no I/O)
            if let Some(ip_bytes) = parse_ip_to_bytes(&client_ip) {
                if let Some(ban) = self.state.ban_store.check_ip_banned(&ip_bytes) {
                    warn!("Rejecting connection from banned IP {}: {}", client_ip, ban.reason);
                    let result = EdgeAuthenticateUserResult {
                        success: false,
                        user_id: None, username: None, display_name: None,
                        groups: vec![],
                        reason: Some(format!("You are banned: {}", ban.reason)),
                        reject_type: Some(2), // Banned
                        channel_id: None,
                        mute: None, deaf: None, suppress: None,
                        self_mute: None, self_deaf: None,
                        priority_speaker: None, recording: None,
                        cert_required: None,
                    };
                    return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                        r.edge_authenticate_user = Some(result);
                    }));
                }
            }
        }

        // ------------------------------------------------------------------
        // Step 0.5: Username uniqueness check — ghost detection
        // ------------------------------------------------------------------
        // Only reject or replace when the connecting client presents a certificate.
        // Certificate-less (guest) connections are allowed to share usernames because
        // there is no reliable identity signal to distinguish a ghost from a different
        // physical user who happens to pick the same name. UsernameInUse is only
        // meaningful when a cert-bearing client tries to connect and a session with a
        // *different* cert already holds the name.
        {
            let new_cert = params.client_info.as_ref()
                .and_then(|ci| ci.certificate_hash.clone())
                .unwrap_or_default();

            if !new_cert.is_empty() {
                // New client has a certificate — enforce uniqueness.
                let all_sessions = self.state.session_manager.get_all_sessions().await;
                if let Some(existing) = all_sessions.iter().find(|s| s.username.eq_ignore_ascii_case(username)) {
                    let ghost_session = existing.session_id;
                    if existing.cert_hash.is_empty() || existing.cert_hash.as_str() == new_cert.as_str() {
                        // No cert on old session, or same cert: ghost replacement.
                        self.state.session_manager.remove_session(ghost_session).await;
                        self.broadcast_notification("hub.userRemoveBroadcast", |n| {
                            n.user_remove_broadcast = Some(HubUserRemoveBroadcastParams {
                                session: ghost_session,
                                actor: None,
                                reason: Some("Ghost connection replaced".to_string()),
                                ban: None,
                                target_sessions: vec![],
                            });
                        }).await;
                        info!("Ghost session {} for user '{}' replaced by new cert connection", ghost_session, username);
                    } else {
                        // Different cert already holds this username — reject.
                        warn!("Rejecting cert user '{}': username already in use by session {} with different cert", username, ghost_session);
                        let result = EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None, username: None, display_name: None,
                            groups: vec![],
                            reason: Some(format!("Username '{}' is already in use", username)),
                            reject_type: Some(4), // UsernameInUse = 4 in Mumble reject enum
                            channel_id: None,
                            mute: None, deaf: None, suppress: None,
                            self_mute: None, self_deaf: None,
                            priority_speaker: None, recording: None,
                            cert_required: None,
                        };
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(result);
                        }));
                    }
                }
            }
            // If the new client has no certificate, allow them through regardless of name conflicts.
        }

        // ------------------------------------------------------------------
        // Step 0.6: Server capacity check — reject if max_users is reached
        // ------------------------------------------------------------------
        {
            let max_users = self.state.config.limits.max_users;
            if max_users > 0 {
                let current = self.state.session_manager.count_sessions().await;
                if current >= max_users as usize {
                    warn!(
                        "Rejecting user '{}': server at capacity ({}/{})",
                        username, current, max_users
                    );
                    let result = EdgeAuthenticateUserResult {
                        success: false,
                        user_id: None, username: None, display_name: None,
                        groups: vec![],
                        reason: Some(format!("Server is full ({}/{})", current, max_users)),
                        reject_type: Some(6), // ServerFull
                        channel_id: None,
                        mute: None, deaf: None, suppress: None,
                        self_mute: None, self_deaf: None,
                        priority_speaker: None, recording: None,
                        cert_required: None,
                    };
                    return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                        r.edge_authenticate_user = Some(result);
                    }));
                }
            }
        }

        // ------------------------------------------------------------------
        // Step 1: Try external auth service (if connected)
        // ------------------------------------------------------------------
        if self.state.auth_service.is_connected().await {
            let client_info = params.client_info.as_ref();
            let ext_request = ExtAuthRequest {
                request_id: request_id.to_string(),
                username: username.clone(),
                password: password.clone(),
                tokens: params.tokens.clone(),
                session_id: params.session_id,
                server_id: params.server_id,
                ip_address: client_info.map(|c| c.ip_address.clone()).unwrap_or_default(),
                ip_version: client_info.map(|c| c.ip_version.clone()).unwrap_or_default(),
                release: client_info.map(|c| c.release.clone()).unwrap_or_default(),
                version: client_info.and_then(|c| c.version),
                os: client_info.map(|c| c.os.clone()).unwrap_or_default(),
                os_version: client_info.map(|c| c.os_version.clone()).unwrap_or_default(),
                certificate_hash: client_info.and_then(|c| c.certificate_hash.clone()),
            };

            match self.state.auth_service.authenticate(ext_request).await {
                Some(resp) => {
                    if !resp.success {
                        // Per Mumble protocol: if the auth service didn't specify a
                        // reject type, default to WrongUserPW (3) so the client can
                        // prompt the user to re-enter credentials.
                        let reject_type = resp.reject_type.or(Some(3)); // WrongUserPW
                        // Track failed auth attempt for auto-ban (credential failure from ext service)
                        self.record_auth_failure(&client_ip).await;
                        let result = EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None,
                            username: None,
                            display_name: None,
                            groups: vec![],
                            reason: resp.reason.clone(),
                            reject_type,
                            channel_id: None,
                            mute: None, deaf: None, suppress: None,
                            self_mute: None, self_deaf: None,
                            priority_speaker: None, recording: None,
                            cert_required: resp.cert_required,
                        };
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(result);
                        }));
                    }

                    // External auth succeeded — create session from response.
                    let user_id = resp.user_id.unwrap_or(0);
                    let auth_username = resp.username.clone().unwrap_or_else(|| username.clone());
                    // Ensure ext-auth user exists in memory+DB so last_channel can be tracked.
                    if user_id > 0 {
                        let auth_username_owned = auth_username.clone();
                        if let Err(e) = self.state.user_store.upsert_ext_user(user_id, &auth_username_owned).await {
                            warn!("Failed to persist ext-auth user: {}", e);
                        }
                    }
                    // Prefer ext auth's channel, fall back to DB last_channel, then default.
                    // Validate that the chosen channel still exists; fall back to default if not.
                    let channel_id = if let Some(ch) = resp.channel_id {
                        ch
                    } else if user_id > 0 {
                        let last_ch = self.state.user_store.get_last_channel(user_id).await;
                        if last_ch > 0 && self.state.channel_store.get_channel(last_ch).await.is_some() {
                            last_ch
                        } else {
                            config.auth.default_channel
                        }
                    } else {
                        config.auth.default_channel
                    };

                    let session_info = SessionInfo {
                        session_id: params.session_id,
                        edge_id: edge_server_id,
                        user_id,
                        username: auth_username.clone(),
                        channel_id,
                        groups: resp.groups.clone(),
                        cert_hash: params
                            .client_info.as_ref()
                            .and_then(|ci| ci.certificate_hash.clone())
                            .unwrap_or_default(),
                        mute: params.mute.unwrap_or(false),
                        deaf: params.deaf.unwrap_or(false),
                        suppress: params.suppress.unwrap_or(false),
                        self_mute: params.self_mute.unwrap_or(false),
                        self_deaf: params.self_deaf.unwrap_or(false),
                        priority_speaker: params.priority_speaker.unwrap_or(false),
                        recording: params.recording.unwrap_or(false),
                        listening_channels: vec![],
                    };
                    self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user).await;
                    if cancel.load(Ordering::Relaxed) {
                        warn!("authenticate_user aborted for session {} (client disconnected during ext-service auth)", params.session_id);
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: false,
                                reason: Some("Client disconnected during authentication".into()),
                                reject_type: Some(1),
                                ..Default::default()
                            });
                        }));
                    }
                    self.state.session_manager.add_session(session_info).await;
                    // Second cancel check: handles the narrow race where the client disconnected
                    // after the first check but before add_session completed. If set, remove the
                    // just-added session to prevent a ghost entry from lingering in Hub.
                    if cancel.load(Ordering::Relaxed) {
                        self.state.session_manager.remove_session(params.session_id).await;
                        warn!("authenticate_user (ext-service): session {} added then immediately reverted (client disconnected)", params.session_id);
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: false,
                                reason: Some("Client disconnected during authentication".into()),
                                reject_type: Some(1),
                                ..Default::default()
                            });
                        }));
                    }

                    info!(
                        "User authenticated via ext service: {} (session={}, edge={}, channel={})",
                        auth_username, params.session_id, edge_server_id, channel_id
                    );

                    // Broadcast hub.userJoined
                    let cert_hash = params.client_info.as_ref()
                        .and_then(|ci| ci.certificate_hash.clone());
                    self.broadcast_notification("hub.userJoined", |n| {
                        n.user_joined = Some(HubUserJoinedParams {
                            session_id: params.session_id,
                            edge_id: edge_server_id,
                            user_id,
                            username: auth_username.clone(),
                            channel_id,
                            groups: resp.groups.clone(),
                            cert_hash,
                            mute: params.mute, deaf: params.deaf,
                            suppress: params.suppress, self_mute: params.self_mute,
                            self_deaf: params.self_deaf,
                            priority_speaker: params.priority_speaker,
                            recording: params.recording,
                            listening_channels: vec![],
                        });
                    }).await;

                    let result = EdgeAuthenticateUserResult {
                        success: true,
                        user_id: Some(user_id),
                        username: Some(auth_username),
                        display_name: resp.display_name.clone(),
                        groups: resp.groups,
                        reason: None,
                        reject_type: None,
                        channel_id: Some(channel_id),
                        mute: params.mute, deaf: params.deaf,
                        suppress: params.suppress, self_mute: params.self_mute,
                        self_deaf: params.self_deaf,
                        priority_speaker: params.priority_speaker,
                        recording: params.recording,
                        cert_required: resp.cert_required,
                    };
                    return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                        r.edge_authenticate_user = Some(result);
                    }));
                }
                None => {
                    // Auth service timed out or disconnected mid-request.
                    if config.auth.require_auth_service {
                        // Configured to require the auth service — reject.
                        let result = EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None, username: None, display_name: None,
                            groups: vec![],
                            reason: Some("Authentication service unavailable".to_string()),
                            reject_type: Some(8), // AuthenticatorFail
                            channel_id: None,
                            mute: None, deaf: None, suppress: None,
                            self_mute: None, self_deaf: None,
                            priority_speaker: None, recording: None,
                            cert_required: None,
                        };
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(result);
                        }));
                    }
                    // Otherwise fall through to local DB auth.
                    warn!(
                        "Auth service request timed out for user '{}'; falling back to local auth",
                        username
                    );
                }
            }
        } else if config.auth.require_auth_service
            && config.auth.http_url.is_none()
            && self.state.lua_engine.read().await.is_none()
        {
            // No WS service connected, no HTTP URL configured, no Lua script —
            // but an external auth service is required → reject.
            let result = EdgeAuthenticateUserResult {
                success: false,
                user_id: None, username: None, display_name: None,
                groups: vec![],
                reason: Some("Authentication service not connected".to_string()),
                reject_type: Some(8), // AuthenticatorFail
                channel_id: None,
                mute: None, deaf: None, suppress: None,
                self_mute: None, self_deaf: None,
                priority_speaker: None, recording: None,
                cert_required: None,
            };
            return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                r.edge_authenticate_user = Some(result);
            }));
        }

        // ------------------------------------------------------------------
        // Step 1.5: Lua script authentication (if configured)
        // ------------------------------------------------------------------
        let lua_engine_guard = self.state.lua_engine.read().await;
        if let Some(lua_engine) = lua_engine_guard.as_ref() {
            let engine = lua_engine.clone();
            drop(lua_engine_guard);
            let client_info = params.client_info.as_ref();
            let lua_req = LuaAuthRequest {
                username: username.clone(),
                password: password.clone(),
                session_id: params.session_id,
                tokens: params.tokens.clone(),
                server_id: params.server_id,
                ip: client_info.map(|c| c.ip_address.clone()).unwrap_or_default(),
                ip_version: client_info.map(|c| c.ip_version.clone()).unwrap_or_default(),
                release: client_info.map(|c| c.release.clone()).unwrap_or_default(),
                version: client_info.and_then(|c| c.version),
                os: client_info.map(|c| c.os.clone()).unwrap_or_default(),
                osversion: client_info.map(|c| c.os_version.clone()).unwrap_or_default(),
                certificate_hash: client_info.and_then(|c| c.certificate_hash.clone()),
            };

            match engine.authenticate(lua_req).await {
                Ok(resp) => {
                    if !resp.success {
                        // Track failed auth attempt for auto-ban (Lua auth credential failure)
                        self.record_auth_failure(&client_ip).await;
                        let result = EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None,
                            username: None,
                            display_name: None,
                            groups: vec![],
                            reason: resp.reason.clone(),
                            reject_type: resp.reject_type.or(Some(3)), // default WrongUserPW
                            channel_id: None,
                            mute: None, deaf: None, suppress: None,
                            self_mute: None, self_deaf: None,
                            priority_speaker: None, recording: None,
                            cert_required: None,
                        };
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(result);
                        }));
                    }

                    // Lua auth succeeded — create session.
                    let user_id = resp.user_id.unwrap_or(0);
                    let auth_username = resp.username.clone().unwrap_or_else(|| username.clone());
                    let groups = resp.groups.clone().unwrap_or_default();
                    if user_id > 0 {
                        let auth_username_owned = auth_username.clone();
                        if let Err(e) = self.state.user_store.upsert_ext_user(user_id, &auth_username_owned).await {
                            warn!("Failed to persist Lua-auth user: {}", e);
                        }
                    }
                    let channel_id = if user_id > 0 {
                        let last_ch = self.state.user_store.get_last_channel(user_id).await;
                        if last_ch > 0 && self.state.channel_store.get_channel(last_ch).await.is_some() {
                            last_ch
                        } else {
                            config.auth.default_channel
                        }
                    } else {
                        config.auth.default_channel
                    };

                    let session_info = SessionInfo {
                        session_id: params.session_id,
                        edge_id: edge_server_id,
                        user_id,
                        username: auth_username.clone(),
                        channel_id,
                        groups: groups.clone(),
                        cert_hash: params
                            .client_info.as_ref()
                            .and_then(|ci| ci.certificate_hash.clone())
                            .unwrap_or_default(),
                        mute: params.mute.unwrap_or(false),
                        deaf: params.deaf.unwrap_or(false),
                        suppress: params.suppress.unwrap_or(false),
                        self_mute: params.self_mute.unwrap_or(false),
                        self_deaf: params.self_deaf.unwrap_or(false),
                        priority_speaker: params.priority_speaker.unwrap_or(false),
                        recording: params.recording.unwrap_or(false),
                        listening_channels: vec![],
                    };
                    self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user).await;
                    if cancel.load(Ordering::Relaxed) {
                        warn!("authenticate_user aborted for session {} (client disconnected during Lua auth)", params.session_id);
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: false,
                                reason: Some("Client disconnected during authentication".into()),
                                reject_type: Some(1),
                                ..Default::default()
                            });
                        }));
                    }
                    self.state.session_manager.add_session(session_info).await;
                    // Second cancel check: handles the narrow race where the client disconnected
                    // after the first check but before add_session completed.
                    if cancel.load(Ordering::Relaxed) {
                        self.state.session_manager.remove_session(params.session_id).await;
                        warn!("authenticate_user (lua): session {} added then immediately reverted (client disconnected)", params.session_id);
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: false,
                                reason: Some("Client disconnected during authentication".into()),
                                reject_type: Some(1),
                                ..Default::default()
                            });
                        }));
                    }

                    info!(
                        "User authenticated via Lua script: {} (session={}, edge={}, channel={})",
                        auth_username, params.session_id, edge_server_id, channel_id
                    );

                    let cert_hash = params.client_info.as_ref()
                        .and_then(|ci| ci.certificate_hash.clone());
                    self.broadcast_notification("hub.userJoined", |n| {
                        n.user_joined = Some(HubUserJoinedParams {
                            session_id: params.session_id,
                            edge_id: edge_server_id,
                            user_id,
                            username: auth_username.clone(),
                            channel_id,
                            groups: groups.clone(),
                            cert_hash,
                            mute: params.mute, deaf: params.deaf,
                            suppress: params.suppress, self_mute: params.self_mute,
                            self_deaf: params.self_deaf,
                            priority_speaker: params.priority_speaker,
                            recording: params.recording,
                            listening_channels: vec![],
                        });
                    }).await;

                    let result = EdgeAuthenticateUserResult {
                        success: true,
                        user_id: Some(user_id),
                        username: Some(auth_username),
                        display_name: resp.display_name.clone(),
                        groups,
                        reason: None,
                        reject_type: None,
                        channel_id: Some(channel_id),
                        mute: params.mute, deaf: params.deaf,
                        suppress: params.suppress, self_mute: params.self_mute,
                        self_deaf: params.self_deaf,
                        priority_speaker: params.priority_speaker,
                        recording: params.recording,
                        cert_required: None,
                    };
                    return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                        r.edge_authenticate_user = Some(result);
                    }));
                }
                Err(e) => {
                    warn!("Lua auth error for '{}': {:#}; falling back to next auth method", username, e);
                    if config.auth.require_auth_service {
                        let result = EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None, username: None, display_name: None,
                            groups: vec![],
                            reason: Some(format!("Authentication script error: {e}")),
                            reject_type: Some(8), // AuthenticatorFail
                            channel_id: None,
                            mute: None, deaf: None, suppress: None,
                            self_mute: None, self_deaf: None,
                            priority_speaker: None, recording: None,
                            cert_required: None,
                        };
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(result);
                        }));
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Step 2: HTTP URL authentication (if configured)
        // ------------------------------------------------------------------
        if let Some(ref http_url) = config.auth.http_url.clone() {
            let client_info = params.client_info.as_ref();
            let http_result = self.authenticate_via_http(
                http_url,
                username,
                password,
                &params.tokens,
                params.server_id,
                params.session_id,
                client_info,
                config.auth.http_timeout_ms,
            ).await;

            match http_result {
                Ok(Some(resp)) => {
                    if !resp.success {
                        // Track failed auth attempt for auto-ban (HTTP auth credential failure)
                        self.record_auth_failure(&client_ip).await;
                        let result = EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None,
                            username: None,
                            display_name: None,
                            groups: vec![],
                            reason: resp.reason.clone(),
                            reject_type: resp.reject_type,
                            channel_id: None,
                            mute: None, deaf: None, suppress: None,
                            self_mute: None, self_deaf: None,
                            priority_speaker: None, recording: None,
                            cert_required: None,
                        };
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(result);
                        }));
                    }

                    // HTTP auth succeeded
                    let user_id = resp.user_id.unwrap_or(0);
                    let auth_username = resp.username.clone().unwrap_or_else(|| username.clone());
                    let groups = resp.groups.clone().unwrap_or_default();
                    // Ensure ext-auth user exists in memory+DB for last_channel tracking
                    if user_id > 0 {
                        let auth_username_owned = auth_username.clone();
                        if let Err(e) = self.state.user_store.upsert_ext_user(user_id, &auth_username_owned).await {
                            warn!("Failed to persist HTTP-auth user: {}", e);
                        }
                    }
                    // Fetch last_channel from DB for this user
                    let channel_id = if user_id > 0 {
                        let last_ch = self.state.user_store.get_last_channel(user_id).await;
                        if last_ch > 0 && self.state.channel_store.get_channel(last_ch).await.is_some() {
                            last_ch
                        } else {
                            config.auth.default_channel
                        }
                    } else {
                        config.auth.default_channel
                    };

                    let session_info = SessionInfo {
                        session_id: params.session_id,
                        edge_id: edge_server_id,
                        user_id,
                        username: auth_username.clone(),
                        channel_id,
                        groups: groups.clone(),
                        cert_hash: params
                            .client_info.as_ref()
                            .and_then(|ci| ci.certificate_hash.clone())
                            .unwrap_or_default(),
                        mute: params.mute.unwrap_or(false),
                        deaf: params.deaf.unwrap_or(false),
                        suppress: params.suppress.unwrap_or(false),
                        self_mute: params.self_mute.unwrap_or(false),
                        self_deaf: params.self_deaf.unwrap_or(false),
                        priority_speaker: params.priority_speaker.unwrap_or(false),
                        recording: params.recording.unwrap_or(false),
                        listening_channels: vec![],
                    };
                    self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user).await;
                    if cancel.load(Ordering::Relaxed) {
                        warn!("authenticate_user aborted for session {} (client disconnected during HTTP auth)", params.session_id);
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: false,
                                reason: Some("Client disconnected during authentication".into()),
                                reject_type: Some(1),
                                ..Default::default()
                            });
                        }));
                    }
                    self.state.session_manager.add_session(session_info).await;
                    // Second cancel check: handles the narrow race where the client disconnected
                    // after the first check but before add_session completed.
                    if cancel.load(Ordering::Relaxed) {
                        self.state.session_manager.remove_session(params.session_id).await;
                        warn!("authenticate_user (http): session {} added then immediately reverted (client disconnected)", params.session_id);
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: false,
                                reason: Some("Client disconnected during authentication".into()),
                                reject_type: Some(1),
                                ..Default::default()
                            });
                        }));
                    }

                    info!(
                        "User authenticated via HTTP: {} (session={}, edge={}, channel={})",
                        auth_username, params.session_id, edge_server_id, channel_id
                    );

                    let cert_hash = params.client_info.as_ref()
                        .and_then(|ci| ci.certificate_hash.clone());
                    self.broadcast_notification("hub.userJoined", |n| {
                        n.user_joined = Some(HubUserJoinedParams {
                            session_id: params.session_id,
                            edge_id: edge_server_id,
                            user_id,
                            username: auth_username.clone(),
                            channel_id,
                            groups: groups.clone(),
                            cert_hash,
                            mute: params.mute, deaf: params.deaf,
                            suppress: params.suppress, self_mute: params.self_mute,
                            self_deaf: params.self_deaf,
                            priority_speaker: params.priority_speaker,
                            recording: params.recording,
                            listening_channels: vec![],
                        });
                    }).await;

                    let result = EdgeAuthenticateUserResult {
                        success: true,
                        user_id: Some(user_id),
                        username: Some(auth_username),
                        display_name: resp.display_name.clone(),
                        groups,
                        reason: None,
                        reject_type: None,
                        channel_id: Some(channel_id),
                        mute: params.mute, deaf: params.deaf,
                        suppress: params.suppress, self_mute: params.self_mute,
                        self_deaf: params.self_deaf,
                        priority_speaker: params.priority_speaker,
                        recording: params.recording,
                        cert_required: None,
                    };
                    return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                        r.edge_authenticate_user = Some(result);
                    }));
                }
                Ok(None) => {
                    // HTTP auth returned no response (timeout/error)
                    if config.auth.require_auth_service {
                        let result = EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None, username: None, display_name: None,
                            groups: vec![],
                            reason: Some("Authentication service unavailable".to_string()),
                            reject_type: Some(8), // AuthenticatorFail
                            channel_id: None,
                            mute: None, deaf: None, suppress: None,
                            self_mute: None, self_deaf: None,
                            priority_speaker: None, recording: None,
                            cert_required: None,
                        };
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(result);
                        }));
                    }
                    warn!("HTTP auth request failed for user '{}'; falling back to local auth", username);
                }
                Err(e) => {
                    warn!("HTTP auth error for user '{}': {}; falling back to local auth", username, e);
                    if config.auth.require_auth_service {
                        let result = EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None, username: None, display_name: None,
                            groups: vec![],
                            reason: Some(format!("Authentication service error: {}", e)),
                            reject_type: Some(8), // AuthenticatorFail
                            channel_id: None,
                            mute: None, deaf: None, suppress: None,
                            self_mute: None, self_deaf: None,
                            priority_speaker: None, recording: None,
                            cert_required: None,
                        };
                        return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                            r.edge_authenticate_user = Some(result);
                        }));
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Step 3: Local DB authentication (fallback / default)
        // ------------------------------------------------------------------

        // Check server password if set
        if let Some(server_pw) = &config.auth.server_password {
            if !server_pw.is_empty() && password != server_pw {
                // Track failed attempt (wrong server password counts toward auto-ban)
                self.record_auth_failure(&client_ip).await;
                let result = EdgeAuthenticateUserResult {
                    success: false,
                    user_id: None,
                    username: None,
                    display_name: None,
                    groups: vec![],
                    reason: Some("Invalid server password".to_string()),
                    reject_type: Some(4), // WrongServerPW
                    channel_id: None,
                    mute: None,
                    deaf: None,
                    suppress: None,
                    self_mute: None,
                    self_deaf: None,
                    priority_speaker: None,
                    recording: None,
                    cert_required: None,
                };
                return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                    r.edge_authenticate_user = Some(result);
                }));
            }
        }

        // Check guest mode
        if !config.auth.allow_guest {
            let db_user = self.state.user_store.find_by_name(username).await?;
            if db_user.is_none() {
                // Track failed attempt (unknown username with no guest access counts toward auto-ban)
                self.record_auth_failure(&client_ip).await;
                let result = EdgeAuthenticateUserResult {
                    success: false,
                    user_id: None,
                    username: None,
                    display_name: None,
                    groups: vec![],
                    reason: Some("User not found and guest access is disabled".to_string()),
                    reject_type: Some(mumbleproto::reject::RejectType::InvalidUsername as u32),
                    channel_id: None,
                    mute: None,
                    deaf: None,
                    suppress: None,
                    self_mute: None,
                    self_deaf: None,
                    priority_speaker: None,
                    recording: None,
                    cert_required: None,
                };
                return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                    r.edge_authenticate_user = Some(result);
                }));
            }
        }

        // Look up user; verify password if they have one set
        let db_user = self.state.user_store.find_by_name(username).await?;
        // Argon2 is CPU-intensive; fetch the hash from DB (never cached) and verify off the executor.
        let pw_ok: bool = if let Some(ref u) = db_user {
            let db = self.state.database.clone();
            let uid = u.id;
            let pw_hash_opt = tokio::task::spawn_blocking(move || db.get_user_password_hash(uid))
                .await
                .context("spawn_blocking join error for fetch_password_hash")??;
            match pw_hash_opt {
                None => true, // user not in users table, no password required
                Some(ref h) if h.is_empty() => true, // no password set
                Some(pw_hash) => {
                    let password_owned = password.to_string();
                    tokio::task::spawn_blocking(move || verify_password(&pw_hash, &password_owned))
                        .await
                        .context("spawn_blocking join error for argon2 verify")?
                }
            }
        } else {
            true
        };

        let (user_id, channel_id) = match db_user {
            Some(ref u) => {
                // If user has a stored password hash, verify the supplied password
                if !pw_ok {
                    // Track failed auth attempt for auto-ban (via unified helper)
                    self.record_auth_failure(&client_ip).await;
                    let result = EdgeAuthenticateUserResult {
                        success: false,
                        user_id: None,
                        username: None,
                        display_name: None,
                        groups: vec![],
                        reason: Some("Wrong password".to_string()),
                        reject_type: Some(3), // WrongUserPW
                        channel_id: None,
                        mute: None,
                        deaf: None,
                        suppress: None,
                        self_mute: None,
                        self_deaf: None,
                        priority_speaker: None,
                        recording: None,
                        cert_required: None,
                    };
                    return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                        r.edge_authenticate_user = Some(result);
                    }));
                }
                (u.id, u.last_channel)
            }
            None => (0, config.auth.default_channel),
        };

        // If the restored channel no longer exists, fall back to default.
        let channel_id = if channel_id > 0
            && self.state.channel_store.get_channel(channel_id).await.is_none()
        {
            config.auth.default_channel
        } else {
            channel_id
        };

        // Create session
        let session_info = SessionInfo {
            session_id: params.session_id,
            edge_id: edge_server_id,
            user_id,
            username: username.clone(),
            channel_id,
            groups: vec![],
            cert_hash: params
                .client_info
                .as_ref()
                .and_then(|ci| ci.certificate_hash.clone())
                .unwrap_or_default(),
            mute: params.mute.unwrap_or(false),
            deaf: params.deaf.unwrap_or(false),
            suppress: params.suppress.unwrap_or(false),
            self_mute: params.self_mute.unwrap_or(false),
            self_deaf: params.self_deaf.unwrap_or(false),
            priority_speaker: params.priority_speaker.unwrap_or(false),
            recording: params.recording.unwrap_or(false),
            listening_channels: vec![],
        };

        self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user).await;
        if cancel.load(Ordering::Relaxed) {
            warn!("authenticate_user aborted for session {} (client disconnected during local DB auth)", params.session_id);
            return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                r.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                    success: false,
                    reason: Some("Client disconnected during authentication".into()),
                    reject_type: Some(1),
                    ..Default::default()
                });
            }));
        }
        self.state.session_manager.add_session(session_info.clone()).await;
        // Second cancel check: handles the narrow race where the client disconnected
        // after the first check but before add_session completed.
        if cancel.load(Ordering::Relaxed) {
            self.state.session_manager.remove_session(params.session_id).await;
            warn!("authenticate_user (local db): session {} added then immediately reverted (client disconnected)", params.session_id);
            return Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
                r.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                    success: false,
                    reason: Some("Client disconnected during authentication".into()),
                    reject_type: Some(1),
                    ..Default::default()
                });
            }));
        }

        // GeoIP lookup for this user's IP address
        if self.state.geoip.is_available() && self.state.config.geoip.log_location {
            let ip_str = params.client_info.as_ref()
                .map(|c| c.ip_address.as_str())
                .unwrap_or("");
            if let Ok(ip) = ip_str.parse::<std::net::IpAddr>() {
                if let Some(loc) = self.state.geoip.lookup(&ip) {
                    info!(
                        "User authenticated: {} (session={}, edge={}, channel={}, ip={}, country={}, city={})",
                        username, params.session_id, edge_server_id, channel_id,
                        ip_str,
                        loc.country_code.as_deref().unwrap_or("??"),
                        loc.city_name.as_deref().unwrap_or("unknown"),
                    );
                } else {
                    info!(
                        "User authenticated: {} (session={}, edge={}, channel={})",
                        username, params.session_id, edge_server_id, channel_id
                    );
                }
            } else {
                info!(
                    "User authenticated: {} (session={}, edge={}, channel={})",
                    username, params.session_id, edge_server_id, channel_id
                );
            }
        } else {
            info!(
                "User authenticated: {} (session={}, edge={}, channel={})",
                username, params.session_id, edge_server_id, channel_id
            );
        }

        // Broadcast hub.userJoined to all edges
        let cert_hash = params
            .client_info
            .as_ref()
            .and_then(|ci| ci.certificate_hash.clone());

        let joined_params = HubUserJoinedParams {
            session_id: params.session_id,
            edge_id: edge_server_id,
            user_id,
            username: username.clone(),
            channel_id,
            groups: vec![],
            cert_hash,
            mute: params.mute,
            deaf: params.deaf,
            suppress: params.suppress,
            self_mute: params.self_mute,
            self_deaf: params.self_deaf,
            priority_speaker: params.priority_speaker,
            recording: params.recording,
            listening_channels: vec![],
        };
        self.broadcast_notification("hub.userJoined", |n| {
            n.user_joined = Some(joined_params);
        })
        .await;

        let result = EdgeAuthenticateUserResult {
            success: true,
            user_id: Some(user_id),
            username: Some(username.clone()),
            display_name: None,
            groups: vec![],
            reason: None,
            reject_type: None,
            channel_id: Some(channel_id),
            mute: params.mute,
            deaf: params.deaf,
            suppress: params.suppress,
            self_mute: params.self_mute,
            self_deaf: params.self_deaf,
            priority_speaker: params.priority_speaker,
            recording: params.recording,
            cert_required: None,
        };

        Ok(self.make_response_packet(request_id, "edge.authenticateUser", |r| {
            r.edge_authenticate_user = Some(result);
        }))
    }

    ///
    /// Returns `Ok(Some(response))` on a successful HTTP call (response may indicate failure).
    /// Returns `Ok(None)` on timeout.
    /// Returns `Err(...)` on network or parsing errors.
    async fn authenticate_via_http(
        &self,
        url: &str,
        username: &str,
        password: &str,
        tokens: &[String],
        server_id: u32,
        session_id: u32,
        client_info: Option<&ClientInfo>,
        timeout_ms: u64,
    ) -> Result<Option<HttpAuthResponse>> {
        let body = HttpAuthRequest {
            username: username.to_string(),
            password: password.to_string(),
            tokens: tokens.to_vec(),
            server_id,
            session_id,
            ip: client_info.map(|c| c.ip_address.clone()).unwrap_or_default(),
            ip_version: client_info.map(|c| c.ip_version.clone()).unwrap_or_default(),
            release: client_info.map(|c| c.release.clone()).unwrap_or_default(),
            version: client_info.and_then(|c| c.version),
            os: client_info.map(|c| c.os.clone()).unwrap_or_default(),
            osversion: client_info.map(|c| c.os_version.clone()).unwrap_or_default(),
            certificate_hash: client_info.and_then(|c| c.certificate_hash.clone()),
        };

        // Reuse the shared client; apply the timeout at the request level so each
        // call can have its own deadline without rebuilding the connection pool.
        let response = self.http_client
            .post(url)
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .json(&body)
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                let mut auth_resp: HttpAuthResponse = resp.json().await?;
                // If the auth service didn't include a reject_type but auth failed,
                // infer an appropriate type from the HTTP status code.
                // Per Mumble protocol (murmur Messages.cpp): wrong credentials for a
                // known user → WrongUserPW (3); wrong server password → WrongServerPW (4).
                // A 401/403 from an HTTP auth service means "invalid credentials", so
                // use WrongUserPW (3) so the Mumble client prompts for a password retry.
                if !auth_resp.success && auth_resp.reject_type.is_none() {
                    auth_resp.reject_type = Some(
                        if status == reqwest::StatusCode::UNAUTHORIZED
                            || status == reqwest::StatusCode::FORBIDDEN
                        {
                            3 // WrongUserPW
                        } else {
                            3 // Default to WrongUserPW for any unspecified credential failure
                        },
                    );
                }
                Ok(Some(auth_resp))
            }
            Err(e) if e.is_timeout() => {
                warn!("HTTP auth timeout for user '{}'", username);
                Ok(None)
            }
            Err(e) => Err(e.into()),
        }
    }

    // ==================== Notification Handlers ====================

    async fn on_user_left(&self, notification: &TypedRpcNotification) {
        let params = notification.handle_user_left.as_ref();
        let session_id = params.map(|p| p.session_id).unwrap_or(0);
        let reason = params.and_then(|p| p.reason.clone());
        if session_id == 0 {
            return;
        }

        // Signal cancellation to any in-flight `authenticate_user` task for this
        // session.  This prevents ghost sessions when the Edge sends `handleUserLeft`
        // immediately on TCP disconnect (before the Hub auth RPC has completed).
        {
            let pending = self.state.pending_auths.read().await;
            if let Some((flag, _)) = pending.get(&session_id) {
                flag.store(true, Ordering::Relaxed);
                debug!("Auth cancel flag set for disconnecting session {}", session_id);
            }
        }

        // Save last channel before removing session
        self.save_user_last_channel(session_id).await;

        if let Some(removed) = self.state.session_manager.remove_session(session_id).await {
            info!("User left: {} (session={})", removed.username, session_id);

            // Purge all voice target slots for this session so the map does not
            // accumulate stale entries indefinitely.
            self.state.voice_targets.write().await
                .retain(|&(s, _), _| s != session_id);

            // Broadcast user removal to all edges
            let remove_params = HubUserRemoveBroadcastParams {
                session: session_id,
                actor: None,
                reason,
                ban: None,
                target_sessions: vec![],
            };
            self.broadcast_notification("hub.userRemoveBroadcast", |n| {
                n.user_remove_broadcast = Some(remove_params);
            })
            .await;

            // Clean up the old channel if it was temporary and is now empty
            self.maybe_cleanup_temp_channel(removed.channel_id).await;
        }
    }

    async fn on_user_remove(&self, notification: &TypedRpcNotification) {
        let p = match notification.handle_user_remove.as_ref() {
            Some(p) => p,
            None => return,
        };
        let target_session = p.target_session;
        if target_session == 0 {
            return;
        }

        // Permission check: actor must have Kick (or Ban for bans) permission
        // on the target's current channel.
        let required_perm = if p.ban { permission::BAN } else { permission::KICK };
        let (target_channel, actor_groups) = {
            let target_info = self.state.session_manager.get_session(target_session).await;
            let actor_info = if p.actor_session != 0 {
                self.state.session_manager.get_session(p.actor_session).await
            } else {
                None
            };
            (
                target_info.map(|s| s.channel_id).unwrap_or(0),
                actor_info.map(|s| s.groups.clone()).unwrap_or_default(),
            )
        };
        let allowed = self.state.acl_manager
            .has_permission(p.actor_user_id as i32, target_channel, &actor_groups, required_perm)
            .await;
        if !allowed {
            debug!(
                "UserRemove denied: actor={} (session={}) → target={}: no {} permission on channel {}",
                p.actor_username, p.actor_session, target_session,
                if p.ban { "Ban" } else { "Kick" },
                target_channel
            );
            return;
        }

        if let Some(removed) = self.state.session_manager.remove_session(target_session).await {
            info!("User removed: {} (session={})", removed.username, target_session);

            // Purge all voice target slots for this session.
            self.state.voice_targets.write().await
                .retain(|&(s, _), _| s != target_session);

            let remove_params = HubUserRemoveBroadcastParams {
                session: target_session,
                actor: if p.actor_session != 0 { Some(p.actor_session) } else { None },
                reason: if p.reason.is_empty() { None } else { Some(p.reason.clone()) },
                ban: Some(p.ban),
                target_sessions: vec![],
            };
            self.broadcast_notification("hub.userRemoveBroadcast", |n| {
                n.user_remove_broadcast = Some(remove_params);
            })
            .await;
        }
    }

    async fn on_user_moved(&self, notification: &TypedRpcNotification) {
        let p = match notification.handle_user_moved.as_ref() {
            Some(p) => p,
            None => return,
        };
        if p.session_id == 0 {
            return;
        }

        let old_channel_id = self.state.session_manager.get_session(p.session_id).await.map(|s| s.channel_id);
        self.state.session_manager.move_user_to_channel(p.session_id, p.channel_id).await;

        let moved_params = HubUserMovedParams {
            session_id: p.session_id,
            edge_id: p.edge_id,
            channel_id: p.channel_id,
            actor_session: p.actor_session,
        };
        self.broadcast_notification("hub.userMoved", |n| {
            n.user_moved = Some(moved_params);
        })
        .await;

        // Clean up the old channel if it was temporary and is now empty
        if let Some(old_ch) = old_channel_id {
            self.maybe_cleanup_temp_channel(old_ch).await;
        }
    }

    async fn on_user_state_changed(&self, notification: &TypedRpcNotification) {
        let p = match notification.handle_user_state_changed.as_ref() {
            Some(p) => p,
            None => return,
        };
        if p.session_id == 0 {
            return;
        }
        let source_edge_id = p.edge_id;

        // Update session state
        let sessions = &self.state.session_manager;
        if let Some(mut session) = sessions.get_session(p.session_id).await {
            if let Some(v) = p.self_mute { session.self_mute = v; }
            if let Some(v) = p.self_deaf { session.self_deaf = v; }
            if let Some(v) = p.mute      { session.mute = v; }
            if let Some(v) = p.deaf      { session.deaf = v; }
            if let Some(v) = p.suppress  { session.suppress = v; }
            if let Some(v) = p.priority_speaker { session.priority_speaker = v; }
            if let Some(v) = p.recording { session.recording = v; }
            for &ch in &p.listening_channel_add {
                if !session.listening_channels.contains(&ch) {
                    session.listening_channels.push(ch);
                }
            }
            session.listening_channels.retain(|ch| !p.listening_channel_remove.contains(ch));
            sessions.add_session(session).await;
        }

        // Broadcast state change to other edges
        let broadcast = HubUserStateBroadcastParams {
            session_id: p.session_id,
            edge_id: source_edge_id,
            self_mute: p.self_mute,
            self_deaf: p.self_deaf,
            mute: p.mute,
            deaf: p.deaf,
            suppress: p.suppress,
            priority_speaker: p.priority_speaker,
            recording: p.recording,
            listening_channel_add: p.listening_channel_add.clone(),
            listening_channel_remove: p.listening_channel_remove.clone(),
            actor_session: p.actor_session,
        };
        let forward = TypedRpcNotification {
            method: "hub.userStateBroadcast".to_string(),
            timestamp: Some(current_millis() as i64),
            user_state_broadcast: Some(broadcast),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(forward),
            ..Default::default()
        };
        let data = packet.encode_to_vec();
        crate::server::broadcast_critical_excluding_sequenced(&self.state, data, source_edge_id).await;
    }

    /// Handle text message forwarding: relay to all other edges (not the sender).
    async fn on_text_message(&self, notification: &TypedRpcNotification, source_edge_id: u32) {
        let p = match notification.handle_text_message.as_ref() {
            Some(p) => p,
            None => return,
        };
        if p.actor == 0 {
            debug!("Ignoring text message with invalid actor=0");
            return;
        }

        debug!("Forwarding text message from actor {} (edge {}) to other edges", p.actor, source_edge_id);

        // Forward to all edges except the source
        let forward_notification = TypedRpcNotification {
            method: "hub.textMessageForward".to_string(),
            timestamp: Some(current_millis() as i64),
            text_message_forward: Some(HubTextMessageForwardParams {
                actor: p.actor,
                message: p.message.clone(),
                channel_id: p.channel_id.clone(),
                tree_id: p.tree_id.clone(),
                session: p.session.clone(),
            }),
            ..Default::default()
        };

        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(forward_notification),
            ..Default::default()
        };
        let data = packet.encode_to_vec();

        crate::server::broadcast_critical_excluding_sequenced(&self.state, data, source_edge_id).await;
    }

    /// Handle channel state notification from an edge (channel create/edit request).
    async fn on_channel_state(&self, notification: &TypedRpcNotification) {
        let p = match notification.handle_channel_state.as_ref() {
            Some(p) => p,
            None => return,
        };
        {
                let channel_id = Some(p.channel_id);

                if let Some(ch_id) = channel_id {
                    // Handle links_add / links_remove first
                    let links_add: Vec<u32> = p.links_add.clone();
                    let links_remove: Vec<u32> = p.links_remove.clone();

                    for target_id in &links_add {
                        if let Err(e) = self.state.channel_store.add_link(ch_id, *target_id).await {
                            warn!("Failed to add channel link {} <-> {}: {}", ch_id, target_id, e);
                        }
                    }
                    for target_id in &links_remove {
                        if let Err(e) = self.state.channel_store.remove_link(ch_id, *target_id).await {
                            warn!("Failed to remove channel link {} <-> {}: {}", ch_id, target_id, e);
                        }
                    }

                    // Update regular channel fields if present
                    if let Some(mut ch) = self.state.channel_store.get_channel(ch_id).await {
                        if let Some(ref n) = p.name {
                            ch.name = n.clone();
                        }
                        if let Some(pid) = p.parent_id {
                            ch.parent_id = Some(pid);
                        }
                        if let Some(pos) = p.position {
                            ch.position = pos;
                        }
                        if let Some(ref desc) = p.description {
                            ch.description = desc.clone();
                        }
                        self.state.channel_store.update_channel(ch).await;
                    }

                    // Broadcast updated channel to all edges
                    if let Some(ch) = self.state.channel_store.get_channel(ch_id).await {
                        let proto = ChannelDataProto {
                            channel_id: ch.id,
                            name: ch.name,
                            parent_id: ch.parent_id,
                            description: Some(ch.description),
                            position: Some(ch.position),
                            max_users: if ch.max_users > 0 { Some(ch.max_users) } else { None },
                            temporary: Some(ch.temporary),
                            inherit_acl: Some(ch.inherit_acl),
                            links: ch.links.iter().copied().collect(),
                        };
                        self.broadcast_notification("hub.channelUpdated", |n| {
                            n.channel_updated = Some(HubChannelUpdatedParams { channel: proto });
                        }).await;
                    }

                    // For link changes, also broadcast the peer channels so both ends are synced
                    let all_peers: std::collections::HashSet<u32> = links_add.iter().chain(links_remove.iter()).copied().collect();
                    for peer_id in all_peers {
                        if let Some(peer) = self.state.channel_store.get_channel(peer_id).await {
                            let proto = ChannelDataProto {
                                channel_id: peer.id,
                                name: peer.name,
                                parent_id: peer.parent_id,
                                description: Some(peer.description),
                                position: Some(peer.position),
                                max_users: if peer.max_users > 0 { Some(peer.max_users) } else { None },
                                temporary: Some(peer.temporary),
                                inherit_acl: Some(peer.inherit_acl),
                                links: peer.links.iter().copied().collect(),
                            };
                            self.broadcast_notification("hub.channelUpdated", |n| {
                                n.channel_updated = Some(HubChannelUpdatedParams { channel: proto });
                            }).await;
                        }
                    }
                }
        }
    }

    /// Handle channel removal notification from an edge.
    async fn on_channel_remove(&self, notification: &TypedRpcNotification) {
        let channel_id = match notification.handle_channel_remove.as_ref() {
            Some(p) => p.channel_id,
            None => return,
        };
        if channel_id == 0 {
            return; // Don't allow removing root channel
        }

        self.remove_channel_coordinated(channel_id).await;
    }

    async fn on_plugin_data(&self, notification: &TypedRpcNotification, source_edge_id: u32) {
        if let Some(params) = &notification.plugin_data_transmission {
            debug!(
                "Plugin data from session {}: dataId={}, {} receivers",
                params.sender_session,
                params.data_id,
                params.receiver_sessions.len()
            );

            let target_sessions = if params.receiver_sessions.is_empty() {
                // Broadcast to all sessions
                self.state.session_manager.get_all_sessions().await
                    .iter()
                    .map(|s| s.session_id)
                    .collect::<Vec<_>>()
            } else {
                params.receiver_sessions.clone()
            };

            // Group by edge for efficient routing
            let mut edge_targets: HashMap<u32, Vec<u32>> = HashMap::new();
            for session_id in &target_sessions {
                if let Some(session) = self.state.session_manager.get_session(*session_id).await {
                    edge_targets
                        .entry(session.edge_id)
                        .or_default()
                        .push(*session_id);
                }
            }

            // Send to each edge
            for (edge_id, sessions) in edge_targets {
                if edge_id == source_edge_id {
                    continue; // Don't echo back to source
                }
                let broadcast_params = HubPluginDataBroadcastParams {
                    sender_session: params.sender_session,
                    data_id: params.data_id.clone(),
                    data: params.data.clone(),
                    target_sessions: sessions,
                };

                let notify = TypedRpcNotification {
                    method: "hub.pluginDataBroadcast".to_string(),
                    timestamp: Some(current_millis() as i64),
                    plugin_data_broadcast: Some(broadcast_params),
                    ..Default::default()
                };

                let packet = EdgeHubPacket {
                    r#type: PacketType::RpcNotification as i32,
                    rpc_notification: Some(notify),
                    ..Default::default()
                };

                let data = packet.encode_to_vec();
                crate::server::notify_sequenced(&self.state, edge_id, data).await;
            }
        }
    }

    /// Save user's last channel when they disconnect (for auto-restore on reconnect).
    async fn save_user_last_channel(&self, session_id: u32) {
        if let Some(session) = self.state.session_manager.get_session(session_id).await {
            if session.user_id > 0 {
                if let Err(e) = self.state.user_store.save_last_channel(
                    session.user_id, session.channel_id
                ).await {
                    warn!("Failed to save last channel for user {}: {}", session.user_id, e);
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

        let count = self.state.failed_auth_tracker.write().await
            .record_failure(client_ip, config.auto_ban.time_window);

        if count >= config.auto_ban.attempts {
            warn!("Auto-banning IP {} after {} failed attempts", client_ip, count);
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
                warn!("Auto-ban: unable to parse IP '{}', skipping DB entry", client_ip);
            }
            self.state.failed_auth_tracker.write().await.clear(client_ip);
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
    async fn broadcast_notification_excluding<F>(&self, method: &str, exclude_edge_id: u32, build: F)
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
        crate::server::broadcast_critical_excluding_sequenced(&self.state, data, exclude_edge_id).await;
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

    fn make_response_packet<F>(
        &self,
        request_id: &str,
        method: &str,
        build: F,
    ) -> EdgeHubPacket
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
    pub(crate) async fn send_notification_to_edge_unsequenced<F>(&self, edge_id: u32, method: &str, build: F)
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
        crate::server::notify(&self.state, edge_id, data).await;
    }

    /// Compute and push route tables to all connected edges.
    async fn push_route_tables_to_all(&self) {
        // Hold the topology read lock only for the Dijkstra computations; drop before
        // sending (which involves I/O and may block).  Multiple concurrent readers are
        // fine since this is a shared read lock — only topology writers are briefly
        // paused.  For typical cluster sizes (2–20 edges) the total computation time
        // is well under a millisecond.
        let edge_data: Vec<(u32, Vec<(u32, u32, Vec<u32>, f32)>)> = {
            let topo = self.state.topology.read().await;
            let config = &self.state.config.voice_routing;
            topo.get_all_edges()
                .iter()
                .map(|e| (e.edge_id, topo.compute_route_table(e.edge_id, config)))
                .collect()
        }; // lock released here

        for (edge_id, routes) in edge_data {
            if routes.is_empty() {
                continue;
            }
            let max_ttl_val = self.state.config.voice_routing.max_ttl;
            self.send_notification_to_edge_unsequenced(edge_id, "hub.routeTableUpdate", |n| {
                n.route_table_update = Some(HubRouteTableUpdateParams {
                    routes: routes.into_iter().map(|(target, rtype, relay_chain, cost)| {
                        let relay_transports = vec![0u32; relay_chain.len()]; // all UDP for now
                        HubRouteEntryProto {
                            target_edge_id: target,
                            route_type: rtype,
                            relay_chain,
                            relay_transports,
                            cost,
                        }
                    }).collect(),
                    max_ttl: Some(max_ttl_val),
                });
            }).await;
        }
    }

    fn make_error_packet(
        &self,
        request_id: &str,
        code: i32,
        message: &str,
    ) -> EdgeHubPacket {
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

    /// Remove all sessions for a disconnected edge.
    ///
    /// Called from the edge_connection task *after* the last pool slot has been
    /// removed from `edge_connections`.  Because there is an unavoidable window
    /// between "pool became empty" and the first line of this function, a fresh
    /// slot from the same Edge can race in and re-register before we run.  We
    /// therefore re-check `edge_connections` under a write lock before touching
    /// authoritative per-edge state (`edge_registry`, `topology`,
    /// `notification_seqs`, `edge_notif_senders`) and before broadcasting
    /// `hub.peerLeft`.  Session cleanup is still performed unconditionally so
    /// pre-reconnect ghosts are purged; the re-registering slot's
    /// `do_report_local_users` repopulates the authoritative list.
    ///
    /// See audit C2 / C5 in `docs/edge-hub-consistency-audit.md`.
    pub async fn cleanup_edge(&self, server_id: u32) {
        // Cancel any in-flight `authenticate_user` tasks owned by this edge so
        // that sessions mid-auth do not ghost after edge-level cleanup.
        {
            let pending = self.state.pending_auths.read().await;
            for (_sid, (flag, eid)) in pending.iter() {
                if *eid == server_id {
                    flag.store(true, Ordering::Relaxed);
                }
            }
        }

        let sessions = self.state.session_manager.get_sessions_by_edge(server_id).await;
        for session in &sessions {
            self.state.session_manager.remove_session(session.session_id).await;

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

        // Re-check that no new pool slot from the same edge has taken over
        // between the disconnect path removing the last sender and this
        // function running.  If one has, the edge is _not_ actually gone and
        // tearing down `edge_registry` / `topology` would delete the new
        // slot's freshly-installed state and cause every other edge to
        // receive a spurious `hub.peerLeft`.
        let edge_still_absent = {
            let connections = self.state.edge_connections.read().await;
            !connections.contains_key(&server_id)
        };
        if !edge_still_absent {
            debug!(
                "cleanup_edge({}): edge was re-registered concurrently, skipping registry/topology teardown",
                server_id
            );
            if !sessions.is_empty() {
                info!(
                    "Cleaned up {} pre-reconnect session(s) for edge {}",
                    sessions.len(),
                    server_id
                );
            }
            return;
        }

        self.state.edge_registry.write().await.remove(&server_id);

        // Remove from cluster topology
        self.state.topology.write().await.remove_edge(server_id);

        // Drop the per-edge inbound notification processor and sequence counter
        // so a later re-registration starts with a fresh state machine.
        self.state.edge_notif_senders.write().await.remove(&server_id);
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

    /// edge.reportQuality — Edge reports link quality to a peer.
    async fn handle_report_quality(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_report_quality.as_ref().context("Missing edge_report_quality params")?;
        let quality_proto = params.quality;
        let quality = LinkQuality {
            rtt_ms: quality_proto.rtt as f64,
            packet_loss: quality_proto.packet_loss as f64,
            jitter_ms: quality_proto.jitter as f64,
            samples: quality_proto.samples,
            last_update: std::time::Instant::now(),
        };
        {
            let mut topo = self.state.topology.write().await;
            topo.report_quality(params.edge_id, params.target_edge_id, quality);
        }

        self.push_route_tables_to_all().await;

        Ok(self.make_response_packet(request_id, "edge.reportQuality", |r| {
            r.edge_report_quality = Some(EdgeReportQualityResult { success: true });
        }))
    }

    /// cluster.getStatus — Returns current cluster topology status.
    async fn handle_cluster_get_status(&self, request_id: &str) -> Result<EdgeHubPacket> {
        let health_map = self.state.edge_health.read().await;
        let topo = self.state.topology.read().await;
        let now = std::time::Instant::now();

        let edges: Vec<ClusterEdgeStatusProto> = topo.get_all_edges()
            .into_iter()
            .map(|e| {
                let health = health_map.get(&e.edge_id);
                let last_seen_secs = health
                    .map(|h| now.duration_since(h.last_heartbeat).as_secs())
                    .unwrap_or(u64::MAX);
                let status = if last_seen_secs < 60 { "healthy" } else { "stale" };
                let client_count = health.map(|h| h.user_count).unwrap_or(0);

                ClusterEdgeStatusProto {
                    id: e.edge_id,
                    name: e.name.clone(),
                    host: e.host.clone(),
                    port: e.port,
                    client_count,
                    status: status.to_string(),
                    last_seen: health.map(|h| {
                        let secs_ago = now.duration_since(h.last_heartbeat).as_secs() as i64;
                        current_millis() as i64 - secs_ago * 1000
                    }),
                }
            })
            .collect();

        let edge_count = edges.len();
        info!("cluster.getStatus: {} edges in topology", edge_count);
        Ok(self.make_response_packet(request_id, "cluster.getStatus", |r| {
            r.cluster_get_status = Some(ClusterGetStatusResult { edges });
        }))
    }

    /// edge.relayVoiceViaTcp — Forward voice packet from source edge to target edge via Hub.
    async fn handle_relay_voice_via_tcp(
        &self,
        request: TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_relay_voice_via_tcp
            .context("Missing edge_relay_voice_via_tcp params")?;

        // Respect Hub voice routing policy: if relay is disabled, reject immediately.
        if !self.state.config.voice_routing.enable_hub_tcp_relay {
            return Ok(self.make_response_packet(request_id, "edge.relayVoiceViaTcp", |r| {
                r.edge_relay_voice_via_tcp = Some(EdgeRelayVoiceViaTcpResult {
                    success: false,
                    error: Some("Hub voice relay is disabled by configuration".to_string()),
                });
            }));
        }

        let target_edge_id = params.target_edge_id;
        let from_edge_id = params.from_edge_id;
        let timestamp = params.timestamp;

        // Forward the voice payload to the target edge via a typed protobuf notification
        let notif = TypedRpcNotification {
            method: "hub.relayVoicePacket".to_string(),
            timestamp: Some(current_millis() as i64),
            relay_voice_packet: Some(HubRelayVoicePacketParams {
                from_edge_id,
                voice_packet: params.voice_packet,
                timestamp,
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notif),
            ..Default::default()
        };
        let data = packet.encode_to_vec();

        // Clone the pool before releasing the read-lock so no await is held
        // under the lock.  relay_voice_via_tcp is on the hot path for Hub-relayed
        // voice; try_send avoids any blocking if the channel is momentarily full,
        // which is acceptable for voice (drop-on-overload semantics).
        let sent = {
            let edges = self.state.edge_connections.read().await;
            edges.get(&target_edge_id).cloned()
        }
        .map(|pool| pool.try_send(data))
        .unwrap_or(false);

        if !sent {
            debug!("Could not relay voice to edge {} (not connected)", target_edge_id);
        }

        Ok(self.make_response_packet(request_id, "edge.relayVoiceViaTcp", |r| {
            r.edge_relay_voice_via_tcp = Some(EdgeRelayVoiceViaTcpResult {
                success: sent,
                error: if sent { None } else { Some(format!("Edge {} not connected", target_edge_id)) },
            });
        }))
    }
}

/// Generate a random challenge string for HMAC authentication.
fn generate_challenge() -> Result<String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let rng = SystemRandom::new();
    let mut buf = [0u8; 32];
    rng.fill(&mut buf).map_err(|_| anyhow::anyhow!("RNG failed: system entropy unavailable"))?;
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
    rng.fill(&mut salt_bytes).map_err(|_| anyhow::anyhow!("RNG failed"))?;
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
    let (suggest_version, suggest_version_v2) = suggest.parse_version()
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
        Self { expected_seq: 0, buffer: BTreeMap::new(), gap_since: None }
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
        self.gap_since.map(|t| EDGE_NOTIF_GAP_TIMEOUT.saturating_sub(t.elapsed()))
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
                Ok(None) => break,      // channel closed — edge disconnected
                Err(_) => {
                    // Gap timeout: skip missing seq and process whatever is buffered.
                    for n in seq.skip_gap() {
                        rpc_handler.handle_notification(n, edge_id).await;
                    }
                    continue;
                }
            }
        } else {
            match rx.recv().await {
                Some(env) => env,
                None => break,          // channel closed — edge disconnected
            }
        };

        for n in seq.feed(envelope.seq, envelope.notification) {
            rpc_handler.handle_notification(n, edge_id).await;
        }
    }

    debug!("Notification processor for edge {} exited", edge_id);
}
