use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

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

use crate::channel_store::ChannelRecord;
use crate::lua_auth::LuaAuthRequest;
use crate::server::HubState;
use crate::session_manager::SessionInfo;
use crate::topology_manager::{ArbitrationResult, LinkQuality, TopologyEdge};

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

use crate::server::{EdgeRegistration, VoiceTargetEntry};

/// Handles all incoming RPC requests from edges.
pub struct RpcHandler {
    state: Arc<HubState>,
    /// Pre-compiled username regex (cached from config at startup).
    username_regex: Option<Regex>,
    /// Pre-compiled channel name regex (cached from config at startup).
    channel_name_regex: Option<Regex>,
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

        let response = match method.as_str() {
            "edge.register" => self.handle_register(&request, &request_id).await,
            "edge.allocateSessionId" => self.handle_allocate_session_id(&request, &request_id).await,
            "edge.authenticateUser" => self.handle_authenticate_user(&request, &request_id, edge_server_id).await,
            "edge.reportSession" => self.handle_report_session(&request, &request_id, edge_server_id).await,
            "edge.fullSync" => self.handle_full_sync(&request, &request_id).await,
            "edge.handlePermissionQuery" => self.handle_permission_query(&request, &request_id).await,
            "edge.batchPermissionQuery" => self.handle_batch_permission_query(&request, &request_id).await,
            "edge.syncVoiceTarget" => self.handle_sync_voice_target(&request, &request_id).await,
            "edge.saveChannel" => self.handle_save_channel(&request, &request_id).await,
            "edge.handleACL" => self.handle_acl(&request, &request_id).await,
            "edge.saveACL" => self.handle_save_acl(&request, &request_id).await,
            "edge.getBanList" => self.handle_get_ban_list(&request_id).await,
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
            "edge.relayVoiceViaTcp" => self.handle_relay_voice_via_tcp(&request, &request_id).await,
            _ => {
                warn!("Unknown RPC method: {}", method);
                Ok(self.make_error_packet(&request_id, -1, &format!("Unknown method: {}", method)))
            }
        };

        match response {
            Ok(packet) => {
                let data: Vec<u8> = packet.encode_to_vec();
                Ok(maybe_compress(data))
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
                    debug!(
                        edge_id = edge_server_id,
                        session_id = ca.session_id,
                        action = ca.action.action.as_str(),
                        actor = ca.action.session.unwrap_or(0),
                        channel = ca.action.channel_id.unwrap_or(0),
                        "ContextAction received from edge (no Hub-side processing yet)"
                    );
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
        let stale_sessions = self.state.session_manager
            .get_sessions_by_edge(params.server_id).await;
        if !stale_sessions.is_empty() {
            warn!(
                "Edge {} re-registered with {} stale session(s) — cleaning up",
                params.server_id, stale_sessions.len()
            );
            for session in &stale_sessions {
                self.state.session_manager.remove_session(session.session_id).await;
                let session_id = session.session_id;
                self.broadcast_notification("hub.userRemoveBroadcast", |n| {
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

        let mut server_limits = self.build_server_limits();
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

    async fn handle_allocate_session_id(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_allocate_session_id.as_ref()
            .context("Missing edge_allocate_session_id params")?;

        let session_id = self.state.session_manager.allocate_session_id(params.edge_id);

        let result = EdgeAllocateSessionIdResult { session_id };
        Ok(self.make_response_packet(request_id, "edge.allocateSessionId", |r| {
            r.edge_allocate_session_id = Some(result);
        }))
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
                    reject_type: Some(2), // InvalidUsername
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
                    // Prefer ext auth's channel, fall back to DB last_channel, then default
                    let channel_id = if let Some(ch) = resp.channel_id {
                        ch
                    } else if user_id > 0 {
                        let last_ch = self.state.user_store.get_last_channel(user_id).await;
                        if last_ch > 0 { last_ch } else { config.auth.default_channel }
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
                    };
                    self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user).await;
                    self.state.session_manager.add_session(session_info).await;

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
            && self.state.lua_engine.is_none()
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
        if let Some(lua_engine) = self.state.lua_engine.as_ref() {
            let engine = lua_engine.clone();
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

            match tokio::task::spawn_blocking(move || engine.authenticate_sync(lua_req)).await {
                Ok(Ok(resp)) => {
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
                        if last_ch > 0 { last_ch } else { config.auth.default_channel }
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
                    };
                    self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user).await;
                    self.state.session_manager.add_session(session_info).await;

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
                Ok(Err(e)) => {
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
                Err(e) => {
                    // spawn_blocking itself failed (task was cancelled)
                    warn!("Lua auth task failed for '{}': {}", username, e);
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
                        if last_ch > 0 { last_ch } else { config.auth.default_channel }
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
                    };
                    self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user).await;
                    self.state.session_manager.add_session(session_info).await;

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
                    reject_type: Some(1), // InvalidUsername
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
        // Argon2 is CPU-intensive; merge DB hash fetch + verify into a single
        // spawn_blocking call to avoid two thread-pool scheduling round-trips.
        let pw_ok: bool = if let Some(ref u) = db_user {
            let db = self.state.database.clone();
            let uid = u.id;
            let password_owned = password.to_string();
            tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
                let pw_hash_opt = db.get_user_password_hash(uid)?;
                Ok(match pw_hash_opt {
                    None => true, // user not in users table, no password required
                    Some(ref h) if h.is_empty() => true, // no password set
                    Some(ref pw_hash) => verify_password(pw_hash, &password_owned),
                })
            })
            .await
            .context("spawn_blocking join error for password verification")??
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
        };

        self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user).await;
        self.state.session_manager.add_session(session_info.clone()).await;

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

    /// Re-register an already-authenticated session after Hub restart / Edge reconnect.
    ///
    /// Unlike `edge.authenticateUser`, this path skips credential validation entirely
    /// and simply inserts the session into the session manager, then broadcasts
    /// `hub.userJoined` so all other Edges learn about the user.
    async fn handle_report_session(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        edge_server_id: u32,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_report_session.as_ref()
            .context("Missing edge_report_session params")?;
        let s = &params.session;

        let session_info = SessionInfo {
            session_id: s.session_id,
            edge_id: edge_server_id,
            user_id: s.user_id,
            username: s.username.clone(),
            channel_id: s.channel_id,
            groups: s.groups.clone(),
            cert_hash: s.cert_hash.clone().unwrap_or_default(),
            mute: s.mute.unwrap_or(false),
            deaf: s.deaf.unwrap_or(false),
            suppress: s.suppress.unwrap_or(false),
            self_mute: s.self_mute.unwrap_or(false),
            self_deaf: s.self_deaf.unwrap_or(false),
            priority_speaker: s.priority_speaker.unwrap_or(false),
            recording: s.recording.unwrap_or(false),
        };
        self.state.session_manager.add_session(session_info).await;

        info!(
            "Reported existing session: {} (session={}, edge={}, channel={})",
            s.username, s.session_id, edge_server_id, s.channel_id
        );

        // Broadcast hub.userJoined to all edges (including the reporting edge,
        // which ignores it for its own edge_id).
        self.broadcast_notification("hub.userJoined", |n| {
            n.user_joined = Some(HubUserJoinedParams {
                session_id: s.session_id,
                edge_id: edge_server_id,
                user_id: s.user_id,
                username: s.username.clone(),
                channel_id: s.channel_id,
                groups: s.groups.clone(),
                cert_hash: s.cert_hash.clone(),
                mute: s.mute,
                deaf: s.deaf,
                suppress: s.suppress,
                self_mute: s.self_mute,
                self_deaf: s.self_deaf,
                priority_speaker: s.priority_speaker,
                recording: s.recording,
            });
        }).await;

        let result = EdgeReportSessionResult { success: true, error: None };
        Ok(self.make_response_packet(request_id, "edge.reportSession", |r| {
            r.edge_report_session = Some(result);
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

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .build()?;

        let response = client
            .post(url)
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

    async fn handle_full_sync(
        &self,
        _request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        // Gather all channels
        let channels: Vec<ChannelDataProto> = self
            .state
            .channel_store
            .get_channels_bfs()
            .await
            .iter()
            .map(|ch| ChannelDataProto {
                channel_id: ch.id,
                name: ch.name.clone(),
                parent_id: ch.parent_id,
                description: if ch.description.is_empty() {
                    None
                } else {
                    Some(ch.description.clone())
                },
                position: Some(ch.position),
                max_users: if ch.max_users > 0 {
                    Some(ch.max_users)
                } else {
                    None
                },
                temporary: Some(ch.temporary),
                inherit_acl: Some(ch.inherit_acl),
                links: ch.links.iter().copied().collect(),
            })
            .collect();

        // Gather all channel links (deduplicated).
        // get_all_channels() returns an owned Vec<ChannelRecord>, so the internal
        // read-lock is released before we iterate — no lock is held during serialization.
        let mut link_set = std::collections::HashSet::new();
        let all_channels = self.state.channel_store.get_all_channels().await;
        let mut channel_links = Vec::new();
        for ch in &all_channels {
            for &target in &ch.links {
                let key = if ch.id < target {
                    (ch.id, target)
                } else {
                    (target, ch.id)
                };
                if link_set.insert(key) {
                    channel_links.push(ChannelLinkProto {
                        channel_id: key.0,
                        target_id: key.1,
                    });
                }
            }
        }

        // Gather all sessions.
        // get_all_sessions() returns an owned Vec<SessionInfo>, so the internal
        // read-lock is released before we map/serialize — no lock is held during serialization.
        let sessions: Vec<GlobalSessionProto> = self
            .state
            .session_manager
            .get_all_sessions()
            .await
            .iter()
            .map(|s| GlobalSessionProto {
                session_id: s.session_id,
                edge_id: s.edge_id,
                user_id: s.user_id,
                username: s.username.clone(),
                channel_id: s.channel_id,
                ip_address: None,
                cert_hash: if s.cert_hash.is_empty() {
                    None
                } else {
                    Some(s.cert_hash.clone())
                },
                connected_at: None,
                groups: s.groups.clone(),
                mute: Some(s.mute),
                deaf: Some(s.deaf),
                suppress: Some(s.suppress),
                self_mute: Some(s.self_mute),
                self_deaf: Some(s.self_deaf),
                priority_speaker: Some(s.priority_speaker),
                recording: Some(s.recording),
            })
            .collect();

        // Build edge list with current load computed from per-Edge health data.
        let health_map = self.state.edge_health.read().await;
        let edges: Vec<EdgeInfoProto> = self.state.edge_registry
            .read()
            .await
            .values()
            .map(|e| {
                // current_load is the number of active sessions on this Edge,
                // expressed as a per-mille value (0–1000) relative to capacity.
                let user_count = health_map
                    .get(&e.server_id)
                    .map(|h| h.user_count)
                    .unwrap_or(0);
                let current_load = if e.capacity > 0 {
                    ((user_count as u64 * 1000) / e.capacity as u64).min(1000) as u32
                } else {
                    0
                };
                EdgeInfoProto {
                    server_id: e.server_id,
                    name: e.name.clone(),
                    host: e.host.clone(),
                    port: e.port,
                    region: e.region.clone(),
                    current_load,
                    capacity: e.capacity,
                }
            })
            .collect();
        drop(health_map);

        let result = EdgeFullSyncResult {
            channels,
            channel_links,
            // ACLs and bans are intentionally omitted from the full-sync snapshot.
            // Edge nodes query ACL permissions on demand via `EdgePermissionQuery` RPCs
            // (evaluated by the Hub's AclManager).  Ban checks are performed by the Hub
            // during `EdgeAuthenticateUser`.  Pushing the full ACL/ban table to every
            // Edge would be wasteful and create stale-cache invalidation complexity.
            acls: vec![],
            bans: vec![],
            sessions,
            timestamp: current_millis() as i64,
            sequence: 0,
            edges,
        };

        Ok(self.make_response_packet(request_id, "edge.fullSync", |r| {
            r.edge_full_sync = Some(result);
        }))
    }

    async fn handle_permission_query(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_handle_permission_query.as_ref()
            .context("Missing edge_handle_permission_query params")?;

        // Look up user groups from the session
        let groups: Vec<String> = match self.state.session_manager
            .get_session(params.actor_session).await {
            Some(s) => s.groups.clone(),
            None => Vec::new(),
        };

        // Augment with in-memory channel group memberships along the ancestor chain.
        let user_id_u32 = params.actor_user_id;
        let mut effective_groups = groups;
        {
            let channel_snapshot = self.state.channel_store.get_parent_and_inherit_snapshot().await;
            let chain = build_ancestor_chain(&channel_snapshot, params.channel_id);
            let target_channel_id = params.channel_id;
            for &ancestor_id in &chain {
                for g in &self.state.acl_manager.get_channel_groups(ancestor_id) {
                    if !g.inherit && ancestor_id != target_channel_id {
                        continue;
                    }
                    let is_added = g.add.contains(&user_id_u32);
                    let is_removed = g.remove.contains(&user_id_u32);
                    if is_added && !is_removed && !effective_groups.contains(&g.name) {
                        effective_groups.push(g.name.clone());
                    }
                }
            }

            let inherit_flags: Vec<bool> = chain
                .iter()
                .map(|&cid| channel_snapshot.get(&cid).map(|(_, inh)| *inh).unwrap_or(true))
                .collect();

            // Calculate effective permissions using the ACL manager (reads from in-memory store).
            let permissions = self.state.acl_manager
                .calculate_permissions_with_chain(
                    params.actor_user_id as i32,
                    params.channel_id,
                    &effective_groups,
                    &chain,
                    &inherit_flags,
                )
                .await;

            let result = EdgeHandlePermissionQueryResult {
                success: true,
                permissions: Some(permissions),
                error: None,
            };

            return Ok(self.make_response_packet(request_id, "edge.handlePermissionQuery", |r| {
                r.edge_handle_permission_query = Some(result);
            }));
        }
    }

    async fn handle_batch_permission_query(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_batch_permission_query.as_ref()
            .context("Missing edge_batch_permission_query params")?;

        let user_id_u32 = params.actor_user_id;

        // [1] Single async lock: snapshot the entire (parent_id, inherit_acl) map.
        //     This replaces O(N × depth) individual get_channel() calls with one.
        let channel_snapshot = self.state.channel_store.get_parent_and_inherit_snapshot().await;

        // [2] Resolve base groups from the session (also one async call).
        let base_groups: Vec<String> = match self.state.session_manager
            .get_session(params.actor_session).await {
            Some(s) => s.groups.clone(),
            None => Vec::new(),
        };

        // [3] Build every ancestor chain synchronously from the in-memory snapshot.
        //     No lock acquisitions needed beyond step [1].
        let chains: Vec<Vec<u32>> = params.channel_ids
            .iter()
            .map(|&cid| build_ancestor_chain(&channel_snapshot, cid))
            .collect();

        // [4] Read channel groups from the in-memory store (single sync lock, replaces batch DB queries).
        let groups_snapshot = self.state.acl_manager.channel_groups_snapshot();

        // [5] Compute one entry per requested channel — entirely in-memory.
        let mut entries: Vec<ChannelPermissionEntry> = Vec::with_capacity(params.channel_ids.len());
        for (idx, &channel_id) in params.channel_ids.iter().enumerate() {
            let chain = &chains[idx];

            // Build inherit_flags from the snapshot (no lock).
            let inherit_flags: Vec<bool> = chain
                .iter()
                .map(|&cid| channel_snapshot.get(&cid).map(|(_, inherit)| *inherit).unwrap_or(true))
                .collect();

            // Accumulate extra group memberships from in-memory channel groups along the chain.
            let mut effective_groups = base_groups.clone();
            for &ancestor_id in chain {
                if let Some(ancestor_groups) = groups_snapshot.get(&ancestor_id) {
                    for g in ancestor_groups {
                        if !g.inherit && ancestor_id != channel_id {
                            continue;
                        }
                        let is_added = g.add.contains(&user_id_u32);
                        let is_removed = g.remove.contains(&user_id_u32);
                        if is_added && !is_removed && !effective_groups.contains(&g.name) {
                            effective_groups.push(g.name.clone());
                        }
                    }
                }
            }

            // Calculate permissions using the in-memory ACL data.
            let permissions = self.state.acl_manager
                .calculate_permissions_with_chain(
                    user_id_u32 as i32,
                    channel_id,
                    &effective_groups,
                    chain,
                    &inherit_flags,
                )
                .await;

            // Derive is_enter_restricted from the in-memory ACL entries.
            let is_enter_restricted = {
                use munode_common::permission;
                self.state.acl_manager
                    .get_channel_acls(channel_id)
                    .iter()
                    .any(|a| a.deny & permission::ENTER != 0)
            };

            entries.push(ChannelPermissionEntry {
                channel_id,
                permissions,
                is_enter_restricted: Some(is_enter_restricted),
            });
        }

        let result = EdgeBatchPermissionQueryResult {
            success: true,
            entries,
            error: None,
        };

        Ok(self.make_response_packet(request_id, "edge.batchPermissionQuery", |r| {
            r.edge_batch_permission_query = Some(result);
        }))
    }

    async fn handle_sync_voice_target(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_sync_voice_target.as_ref()
            .context("Missing edge_sync_voice_target params")?;

        // Store the voice target
        let entry = VoiceTargetEntry {
            edge_id: params.edge_id,
            client_session: params.client_session,
            target_id: params.target_id,
            config: params.config.clone(),
            timestamp: current_millis() as i64,
        };

        self.state.voice_targets
            .write()
            .await
            .insert((params.client_session, params.target_id), entry);

        // Broadcast to other edges
        let sync_params = HubSyncVoiceTargetParams {
            edge_id: params.edge_id,
            client_session: params.client_session,
            target_id: params.target_id,
            config: params.config.clone(),
            timestamp: current_millis() as i64,
        };
        self.broadcast_notification("hub.syncVoiceTarget", |n| {
            n.sync_voice_target = Some(sync_params);
        })
        .await;

        let result = EdgeSyncVoiceTargetResult {
            success: true,
            error: None,
        };

        Ok(self.make_response_packet(request_id, "edge.syncVoiceTarget", |r| {
            r.edge_sync_voice_target = Some(result);
        }))
    }

    async fn handle_save_channel(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_save_channel.as_ref()
            .context("Missing edge_save_channel params")?;

        // Validate channel name against configured regex (for create and rename).
        if let Some(channel_name) = &params.name {
            if let Some(re) = &self.channel_name_regex {
                if !re.is_match(channel_name) {
                    warn!("Rejecting channel name '{}': does not match configured channel_name_regex", channel_name);
                    return Ok(self.make_response_packet(request_id, "edge.saveChannel", |r| {
                        r.edge_save_channel = Some(EdgeSaveChannelResult {
                            success: false,
                            channel_id: None,
                            error: Some(format!(
                                "Invalid channel name: '{}' does not meet naming requirements",
                                channel_name
                            )),
                        });
                    }));
                }
            }
        }

        let is_new = params.id.is_none();
        let channel_id = if is_new {
            // Reject creating a permanent channel inside a temporary channel
            if let Some(parent_id) = params.parent_id {
                if let Some(parent_ch) = self.state.channel_store.get_channel(parent_id).await {
                    if parent_ch.temporary {
                        return Ok(self.make_response_packet(request_id, "edge.saveChannel", |r| {
                            r.edge_save_channel = Some(EdgeSaveChannelResult {
                                success: false,
                                channel_id: None,
                                error: Some("Cannot create a permanent channel inside a temporary channel".to_string()),
                            });
                        }));
                    }
                }
            }

            // Check channel count limit
            let count_limit = self.state.config.limits.channel_count_limit;
            if count_limit > 0 {
                let current_count = self.state.channel_store.count().await as u32;
                if current_count >= count_limit {
                    return Ok(self.make_response_packet(request_id, "edge.saveChannel", |r| {
                        r.edge_save_channel = Some(EdgeSaveChannelResult {
                            success: false,
                            channel_id: None,
                            error: Some(format!("Channel count limit ({}) reached", count_limit)),
                        });
                    }));
                }
            }

            // Check nesting depth limit
            let nesting_limit = self.state.config.limits.channel_nesting_limit;
            if nesting_limit > 0 {
                if let Some(parent_id) = params.parent_id {
                    let depth = {
                        let mut d = 1u32;
                        let mut cur = parent_id;
                        let channels = self.state.channel_store.get_all_channels().await;
                        let parent_map: std::collections::HashMap<u32, Option<u32>> =
                            channels.iter().map(|c| (c.id, c.parent_id)).collect();
                        while let Some(&Some(pid)) = parent_map.get(&cur) {
                            d += 1;
                            cur = pid;
                            if d > nesting_limit {
                                break;
                            }
                        }
                        d
                    };
                    if depth > nesting_limit {
                        return Ok(self.make_response_packet(request_id, "edge.saveChannel", |r| {
                            r.edge_save_channel = Some(EdgeSaveChannelResult {
                                success: false,
                                channel_id: None,
                                error: Some(format!("Channel nesting limit ({}) exceeded", nesting_limit)),
                            });
                        }));
                    }
                }
            }

            // Create new channel
            let ch = ChannelRecord {
                id: 0, // Will be assigned by create_channel
                name: params.name.clone().unwrap_or_else(|| "New Channel".to_string()),
                parent_id: params.parent_id,
                description: params.description.clone().unwrap_or_default(),
                position: params.position.unwrap_or(0),
                max_users: params.max_users.unwrap_or(0),
                temporary: false,
                inherit_acl: params.inherit_acl.unwrap_or(true),
                links: std::collections::HashSet::new(),
            };
            let id = self.state.channel_store.create_and_persist(ch.clone()).await
                .context("Failed to create and persist channel")?;

            // Broadcast channel created
            let proto = ChannelDataProto {
                channel_id: id,
                name: ch.name.clone(),
                parent_id: ch.parent_id,
                description: Some(ch.description.clone()),
                position: Some(ch.position),
                max_users: if ch.max_users > 0 { Some(ch.max_users) } else { None },
                temporary: Some(false),
                inherit_acl: Some(ch.inherit_acl),
                links: vec![],
            };
            self.broadcast_notification("hub.channelCreated", |n| {
                n.channel_created = Some(HubChannelCreatedParams { channel: proto });
            })
            .await;

            id
        } else {
            // Update existing channel
            let id = params.id.unwrap();
            if let Some(mut ch) = self.state.channel_store.get_channel(id).await {
                if let Some(name) = &params.name {
                    ch.name = name.clone();
                }
                if let Some(pos) = params.position {
                    ch.position = pos;
                }
                if let Some(max) = params.max_users {
                    ch.max_users = max;
                }
                if let Some(parent) = params.parent_id {
                    ch.parent_id = Some(parent);
                }
                if let Some(inherit) = params.inherit_acl {
                    ch.inherit_acl = inherit;
                }
                if let Some(desc) = &params.description {
                    ch.description = desc.clone();
                }

                self.state.channel_store.update_and_persist(ch.clone()).await
                    .context("Failed to update and persist channel")?;

                // Broadcast channel updated
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
                })
                .await;
            }
            id
        };

        let result = EdgeSaveChannelResult {
            success: true,
            channel_id: Some(channel_id),
            error: None,
        };

        Ok(self.make_response_packet(request_id, "edge.saveChannel", |r| {
            r.edge_save_channel = Some(result);
        }))
    }

    async fn handle_acl(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_handle_acl.as_ref()
            .context("Missing edge_handle_acl params")?;

        if params.query {
            // ACL query: return ACL entries for the channel (including inherited from parents).
            // This mirrors Murmur's sendACL behaviour: walk the chain from root to the target
            // channel, collect parent-channel ACLs that have apply_subs=true (marked inherited),
            // then append the target channel's own ACLs (marked not-inherited).
            let channel_id = params.channel_id;
            let inherit_acl = self.state.channel_store
                .get_channel(channel_id).await
                .map(|c| c.inherit_acl)
                .unwrap_or(true);

            // Build the chain [root, ..., parent] stopping at inheritance breaks.
            // inherit_acl on a channel means "this channel inherits ACLs from its parent".
            // When a channel has inherit_acl=false the chain stops there: ancestors above
            // that point do not contribute to this channel's (or its descendants') effective
            // ACLs, so they should not appear as "inherited" in the ACL dialog.
            let mut ancestor_chain: Vec<u32> = Vec::new();
            {
                let mut cur = channel_id;
                loop {
                    let ch = match self.state.channel_store.get_channel(cur).await {
                        Some(c) => c,
                        None => break,
                    };
                    if !ch.inherit_acl {
                        break; // cur does not inherit from its parent; stop here
                    }
                    match ch.parent_id {
                        Some(pid) => {
                            ancestor_chain.push(pid);
                            cur = pid;
                        }
                        None => break,
                    }
                }
                ancestor_chain.reverse(); // root first
            }

            // Collect ACL entries: inherited ones from ancestors first, then own.
            let mut acls_proto: Vec<munode_protocol::mumbleproto::acl::ChanAcl> = Vec::new();

            for &ancestor_id in &ancestor_chain {
                let ancestor_acls = self.state.acl_manager.get_channel_acls(ancestor_id);
                for a in &ancestor_acls {
                    if !a.apply_subs {
                        continue; // only include ACLs that propagate to sub-channels
                    }
                    acls_proto.push(munode_protocol::mumbleproto::acl::ChanAcl {
                        apply_here: Some(a.apply_here),
                        apply_subs: Some(a.apply_subs),
                        user_id: a.user_id.map(|id| id as u32),
                        group: a.group_name.clone(),
                        grant: Some(a.allow),
                        deny: Some(a.deny),
                        inherited: Some(true),
                    });
                }
            }

            // Own ACLs for the target channel (not inherited).
            let own_acls = self.state.acl_manager.get_channel_acls(channel_id);
            for a in &own_acls {
                acls_proto.push(munode_protocol::mumbleproto::acl::ChanAcl {
                    apply_here: Some(a.apply_here),
                    apply_subs: Some(a.apply_subs),
                    user_id: a.user_id.map(|id| id as u32),
                    group: a.group_name.clone(),
                    grant: Some(a.allow),
                    deny: Some(a.deny),
                    inherited: Some(false),
                });
            }

            // Load channel groups for this channel from the in-memory store.
            let groups_proto: Vec<munode_protocol::mumbleproto::acl::ChanGroup> =
                self.state.acl_manager.get_channel_groups(channel_id)
                    .iter()
                    .map(|g| munode_protocol::mumbleproto::acl::ChanGroup {
                        name: g.name.clone(),
                        inherited: Some(false),
                        inherit: Some(g.inherit),
                        inheritable: Some(g.inheritable),
                        add: g.add.clone(),
                        remove: g.remove.clone(),
                        inherited_members: vec![],
                    })
                    .collect();

            // Encode ACL data as raw bytes (Mumble ACL message format)
            let acl_msg = munode_protocol::mumbleproto::Acl {
                channel_id,
                inherit_acls: Some(inherit_acl),
                groups: groups_proto,
                acls: acls_proto,
                query: Some(true),
            };

            let raw = prost::Message::encode_to_vec(&acl_msg);

            let result = EdgeHandleAclResult {
                success: true,
                raw_data: Some(raw),
                error: None,
                channel_id: Some(params.channel_id),
                permission_denied: None,
            };
            Ok(self.make_response_packet(request_id, "edge.handleACL", |r| {
                r.edge_handle_acl = Some(result);
            }))
        } else {
            // ACL update: parse raw data and save
            let acl_msg: munode_protocol::mumbleproto::Acl =
                prost::Message::decode(params.raw_data.as_slice())
                    .context("Failed to decode ACL message")?;

            let entries: Vec<crate::acl_manager::AclEntry> = acl_msg.acls.iter().map(|a| {
                crate::acl_manager::AclEntry {
                    channel_id: params.channel_id,
                    user_id: a.user_id.map(|id| id as i32),
                    group_name: a.group.clone(),
                    apply_here: a.apply_here.unwrap_or(true),
                    apply_subs: a.apply_subs.unwrap_or(true),
                    allow: a.grant.unwrap_or(0),
                    deny: a.deny.unwrap_or(0),
                }
            }).collect();

            self.state.acl_manager.save_acls(params.channel_id, &entries).await?;

            // Save channel groups through the AclManager (write-through: DB + in-memory).
            let channel_groups: Vec<crate::acl_manager::ChannelGroup> = acl_msg.groups.iter().map(|g| {
                crate::acl_manager::ChannelGroup {
                    id: 0,
                    name: g.name.clone(),
                    inherit: g.inherit.unwrap_or(true),
                    inheritable: g.inheritable.unwrap_or(true),
                    add: g.add.clone(),
                    remove: g.remove.clone(),
                }
            }).collect();
            if let Err(e) = self.state.acl_manager.save_channel_groups(params.channel_id, channel_groups).await {
                warn!("Failed to save channel groups: {}", e);
            }

            // Update inherit_acl flag on channel if provided
            if let Some(inherit) = acl_msg.inherit_acls {
                if let Some(mut ch) = self.state.channel_store.get_channel(params.channel_id).await {
                    ch.inherit_acl = inherit;
                    self.state.channel_store.update_channel(ch).await;
                }
            }

            // Broadcast ACL update notification to all edges
            self.broadcast_notification("hub.aclUpdated", |n| {
                n.unknown_params_json = Some(
                    serde_json::json!({ "channel_id": params.channel_id }).to_string()
                );
            }).await;

            let result = EdgeHandleAclResult {
                success: true,
                raw_data: None,
                error: None,
                channel_id: Some(params.channel_id),
                permission_denied: None,
            };
            Ok(self.make_response_packet(request_id, "edge.handleACL", |r| {
                r.edge_handle_acl = Some(result);
            }))
        }
    }

    async fn handle_save_acl(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_save_acl.as_ref()
            .context("Missing edge_save_acl params")?;

        let channel_id = params.channel_id;
        let entries: Vec<crate::acl_manager::AclEntry> = params.acls.iter().map(|a| {
            crate::acl_manager::AclEntry {
                channel_id,
                user_id: a.user_id.map(|id| id as i32),
                group_name: a.group.clone(),
                apply_here: a.apply_here,
                apply_subs: a.apply_subs,
                allow: a.allow,
                deny: a.deny,
            }
        }).collect();

        self.state.acl_manager.save_acls(channel_id, &entries).await?;

        let result = EdgeSaveAclResult {
            success: true,
            acl_ids: vec![],
            error: None,
        };
        Ok(self.make_response_packet(request_id, "edge.saveACL", |r| {
            r.edge_save_acl = Some(result);
        }))
    }

    /// Handle edge.saveChannelListeners — persist a user's listening channels.
    async fn handle_save_channel_listeners(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = match &request.edge_save_channel_listeners {
            Some(p) => p,
            None => return Ok(self.make_error_packet(request_id, -1, "Missing edge_save_channel_listeners params")),
        };
        // Only save for registered users (user_id > 0); guests (user_id == 0) are skipped.
        if params.user_id > 0 {
            if let Err(e) = self.state.user_store.save_listeners(params.user_id, &params.channel_ids).await {
                warn!("Failed to save channel listeners for user {}: {}", params.user_id, e);
                return Ok(self.make_response_packet(request_id, "edge.saveChannelListeners", |r| {
                    r.edge_save_channel_listeners = Some(EdgeSaveChannelListenersResult {
                        success: false,
                        error: Some(e.to_string()),
                    });
                }));
            }
            debug!("Saved {} channel listeners for user {}", params.channel_ids.len(), params.user_id);
        }
        Ok(self.make_response_packet(request_id, "edge.saveChannelListeners", |r| {
            r.edge_save_channel_listeners = Some(EdgeSaveChannelListenersResult {
                success: true,
                error: None,
            });
        }))
    }

    /// Handle edge.loadChannelListeners — retrieve a user's persisted listening channels.
    async fn handle_load_channel_listeners(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = match &request.edge_load_channel_listeners {
            Some(p) => p,
            None => return Ok(self.make_error_packet(request_id, -1, "Missing edge_load_channel_listeners params")),
        };
        if params.user_id == 0 {
            // Guests have no persistent listeners.
            return Ok(self.make_response_packet(request_id, "edge.loadChannelListeners", |r| {
                r.edge_load_channel_listeners = Some(EdgeLoadChannelListenersResult {
                    success: true,
                    channel_ids: vec![],
                    error: None,
                });
            }));
        }
        let channel_ids = self.state.user_store.get_listeners(params.user_id);
        debug!("Loaded {} channel listeners for user {}", channel_ids.len(), params.user_id);
        Ok(self.make_response_packet(request_id, "edge.loadChannelListeners", |r| {
            r.edge_load_channel_listeners = Some(EdgeLoadChannelListenersResult {
                success: true,
                channel_ids,
                error: None,
            });
        }))
    }

    async fn handle_get_ban_list(
        &self,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let bans = self.state.ban_store.get_all();

        let ban_entries: Vec<munode_protocol::mumbleproto::ban_list::BanEntry> = bans.iter().map(|b| {
            munode_protocol::mumbleproto::ban_list::BanEntry {
                address: b.address.to_vec(),
                mask: b.mask,
                name: Some(b.name.clone()),
                hash: Some(b.cert_hash.clone()),
                reason: Some(b.reason.clone()),
                start: Some(b.start_time.to_string()),
                duration: Some(b.duration),
            }
        }).collect();

        let ban_list = munode_protocol::mumbleproto::BanList {
            bans: ban_entries,
            query: Some(false),
        };

        let raw = prost::Message::encode_to_vec(&ban_list);

        let result = EdgeHandleAclResult {
            success: true,
            raw_data: Some(raw),
            error: None,
            channel_id: None,
            permission_denied: None,
        };

        Ok(self.make_response_packet(request_id, "edge.getBanList", |r| {
            r.edge_handle_acl = Some(result);
        }))
    }

    async fn handle_update_ban_list(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_handle_acl.as_ref()
            .context("Missing ban list data (via edge_handle_acl.raw_data)")?;

        let ban_list: munode_protocol::mumbleproto::BanList =
            prost::Message::decode(params.raw_data.as_slice())
                .context("Failed to decode BanList message")?;

        let bans_data: Vec<crate::database::BanRecord> = ban_list.bans.iter().map(|b| {
            let mut address = [0u8; 16];
            let copy_len = b.address.len().min(16);
            address[..copy_len].copy_from_slice(&b.address[..copy_len]);

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;

            crate::database::BanRecord {
                id: 0,
                address,
                mask: b.mask,
                name: b.name.clone().unwrap_or_default(),
                cert_hash: b.hash.clone().unwrap_or_default(),
                reason: b.reason.clone().unwrap_or_default(),
                start_time: b.start.as_ref().and_then(|s| s.parse::<i64>().ok()).unwrap_or(now),
                duration: b.duration.unwrap_or(0),
            }
        }).collect();

        self.state.ban_store.replace_bans(&bans_data).await?;
        info!("Updated ban list: {} entries", bans_data.len());

        let result = EdgeHandleAclResult {
            success: true,
            raw_data: None,
            error: None,
            channel_id: None,
            permission_denied: None,
        };

        Ok(self.make_response_packet(request_id, "edge.updateBanList", |r| {
            r.edge_handle_acl = Some(result);
        }))
    }

    async fn handle_get_user_list(&self, request_id: &str) -> Result<EdgeHubPacket> {
        let users = self.state.user_store.list().await?;
        let user_list = munode_protocol::mumbleproto::UserList {
            users: users
                .iter()
                .map(|u| munode_protocol::mumbleproto::user_list::User {
                    user_id: u.id,
                    name: Some(u.username.clone()),
                    last_seen: None,
                    last_channel: if u.last_channel > 0 { Some(u.last_channel) } else { None },
                })
                .collect(),
        };
        let raw = prost::Message::encode_to_vec(&user_list);
        Ok(self.make_response_packet(request_id, "edge.getUserList", |r| {
            r.edge_handle_acl = Some(EdgeHandleAclResult {
                success: true,
                raw_data: Some(raw),
                error: None,
                channel_id: None,
                permission_denied: None,
            });
        }))
    }

    async fn handle_update_user_list(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_handle_acl.as_ref()
            .context("Missing user list data (via edge_handle_acl.raw_data)")?;
        let raw: &[u8] = &params.raw_data;
        let user_list: munode_protocol::mumbleproto::UserList =
            prost::Message::decode(raw).context("Failed to decode UserList message")?;

        let mut error_msg: Option<String> = None;
        for u in &user_list.users {
            if let Some(new_name) = &u.name {
                if new_name.is_empty() {
                    // Empty name = de-register
                    self.state.user_store.delete(u.user_id).await?;
                } else {
                    match self.state.user_store.rename(u.user_id, new_name).await {
                        Ok(false) => {
                            error_msg = Some(format!("User {} not found", u.user_id));
                        }
                        Err(e) => {
                            error_msg = Some(e.to_string());
                            break;
                        }
                        Ok(true) => {}
                    }
                }
            }
        }
        Ok(self.make_response_packet(request_id, "edge.updateUserList", |r| {
            r.edge_handle_acl = Some(EdgeHandleAclResult {
                success: error_msg.is_none(),
                raw_data: None,
                error: error_msg,
                channel_id: None,
                permission_denied: None,
            });
        }))
    }

    // ==================== Notification Handlers ====================

    async fn on_user_left(&self, notification: &TypedRpcNotification) {
        let params = notification.handle_user_left.as_ref();
        let session_id = params.map(|p| p.session_id).unwrap_or(0);
        let reason = params.and_then(|p| p.reason.clone());
        if session_id == 0 {
            return;
        }

        // Save last channel before removing session
        self.save_user_last_channel(session_id).await;

        if let Some(removed) = self.state.session_manager.remove_session(session_id).await {
            info!("User left: {} (session={})", removed.username, session_id);

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

        // Permission check: if initiated by a user (actor_session != 0),
        // the actor must have KICK (or BAN for ban operations) at the root channel.
        if p.actor_session != 0 {
            use munode_common::permission;
            let required = if p.ban { permission::BAN } else { permission::KICK };
            let groups: Vec<String> = match self.state.session_manager
                .get_session(p.actor_session)
                .await
            {
                Some(s) => s.groups.clone(),
                None => {
                    warn!(
                        actor_session = p.actor_session,
                        "kick/ban rejected: actor session not found"
                    );
                    return;
                }
            };
            if !self.state.acl_manager
                .has_permission(p.actor_user_id as i32, 0, &groups, required)
                .await
            {
                warn!(
                    actor_session = p.actor_session,
                    target_session,
                    "kick/ban rejected: actor lacks permission"
                );
                return;
            }
        }

        if let Some(removed) = self.state.session_manager.remove_session(target_session).await {
            info!("User removed: {} (session={})", removed.username, target_session);

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
        crate::server::broadcast_critical_excluding(&self.state, data, source_edge_id).await;
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

        crate::server::broadcast_critical_excluding(&self.state, data, source_edge_id).await;
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
                crate::server::notify(&self.state, edge_id, data).await;
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

    /// After a disconnect is confirmed by arbitration, detect network partitions
    /// and send hub.shutdownRequest to the smallest partition to prevent split-brain.
    async fn handle_partition_after_disconnect(&self) {
        let partitions = {
            let topo = self.state.topology.read().await;
            topo.detect_partitions()
        };

        if partitions.len() <= 1 {
            // No partition or single partition, nothing to do
            return;
        }

        // Build a per-edge user count map in O(M) first, then count per partition in O(N) total
        let all_sessions = self.state.session_manager.get_all_sessions().await;
        let mut users_per_edge: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
        for session in &all_sessions {
            *users_per_edge.entry(session.edge_id).or_insert(0) += 1;
        }

        let mut partition_user_counts: Vec<(std::collections::HashSet<u32>, usize)> = partitions
            .into_iter()
            .map(|partition| {
                let user_count: usize = partition
                    .iter()
                    .map(|edge_id| users_per_edge.get(edge_id).copied().unwrap_or(0))
                    .sum();
                (partition, user_count)
            })
            .collect();

        // Sort by user count ascending, so the smallest partition is first
        partition_user_counts.sort_by_key(|(_, count)| *count);

        // The smallest partition gets the shutdown request
        if let Some((smallest_partition, count)) = partition_user_counts.first() {
            warn!(
                "Cluster partition detected: sending hub.shutdownRequest to smallest partition ({} edges, {} users)",
                smallest_partition.len(), count
            );
            let shutdown_notif = TypedRpcNotification {
                method: "hub.shutdownRequest".to_string(),
                timestamp: Some(current_millis() as i64),
                force_disconnect: Some(HubForceDisconnectParams {
                    reason: format!(
                        "Network partition detected: your cluster partition ({} users) is smaller. Please reconnect.",
                        count
                    ),
                }),
                ..Default::default()
            };
            let shutdown_packet = EdgeHubPacket {
                r#type: PacketType::RpcNotification as i32,
                rpc_notification: Some(shutdown_notif),
                ..Default::default()
            };
            let shutdown_data = shutdown_packet.encode_to_vec();
            let edges = self.state.edge_connections.read().await;
            for edge_id in smallest_partition {
                if let Some(sender) = edges.get(edge_id) {
                    info!("Sending hub.shutdownRequest to edge {}", edge_id);
                    let _ = sender.send(shutdown_data.clone()).await;
                }
            }
        }
    }

    /// Broadcast a notification to all connected edges.
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
        crate::server::broadcast_critical(&self.state, data).await;
    }

    /// Build a ServerLimitsConfig from the current Hub configuration.
    /// This is sent to Edge on registration and via heartbeat ack when limits change.
    pub(crate) fn build_server_limits(&self) -> ServerLimitsConfig {
        let limits = &self.state.config.limits;
        let suggest = &self.state.config.suggest;
        let (suggest_version, suggest_version_v2) = suggest.parse_version()
            .map(|(v1, v2)| (Some(v1), Some(v2)))
            .unwrap_or((None, None));
        // Welcome text: inline config value only. The file variant is loaded
        // asynchronously by callers via `load_welcome_text()` to avoid blocking
        // the tokio executor with synchronous file I/O.
        let welcome = self.state.config.auth.welcome_text.clone();
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

    /// Check if a channel is temporary and empty, and if so delete it and broadcast.
    ///
    /// After deleting the channel, this method also checks the parent channel — if
    /// the parent is also temporary and is now empty (because all children were deleted),
    /// it is cleaned up too, walking up the tree until a non-empty or non-temporary
    /// ancestor is reached.
    async fn maybe_cleanup_temp_channel(&self, channel_id: u32) {
        // Walk up the ancestor chain, cleaning up empty temporary channels.
        let mut current_id = channel_id;
        loop {
            if current_id == 0 {
                return; // Never delete root channel
            }
            let ch = match self.state.channel_store.get_channel(current_id).await {
                Some(c) => c,
                None => return,
            };
            if !ch.temporary {
                return; // Reached a permanent channel — stop
            }
            // Keep channel if any session is in it
            let sessions = self.state.session_manager.get_all_sessions().await;
            if sessions.iter().any(|s| s.channel_id == current_id) {
                return;
            }
            // Keep channel if it still has sub-channels
            let has_children = self.state.channel_store
                .get_all_channels().await
                .iter()
                .any(|c| c.parent_id == Some(current_id));
            if has_children {
                return;
            }
            let parent_id = ch.parent_id;
            // Delete this empty temporary channel via the coordinated helper
            // (persists to DB, clears ACL/group memory, broadcasts to edges).
            info!("Deleting empty temporary channel {} ('{}')", current_id, ch.name);
            self.remove_channel_coordinated(current_id).await;
            // Continue to check the parent channel
            match parent_id {
                Some(pid) => current_id = pid,
                None => return,
            }
        }
    }

    /// Remove a channel from all in-memory stores, persist the deletion to the
    /// database, and broadcast `hub.channelRemoved` to all connected Edges.
    ///
    /// This is the single authoritative call site for channel removal — both
    /// the explicit admin delete path and the automatic temporary-channel
    /// cleanup loop must go through here, so that all stores stay consistent
    /// without the caller having to know about every downstream store.
    async fn remove_channel_coordinated(&self, channel_id: u32) {
        match self.state.channel_store.remove_and_persist(channel_id).await {
            Ok(Some(removed)) => {
                info!("Channel removed: {} (id={})", removed.name, channel_id);
            }
            Ok(None) => {
                // Already gone — still clean up memory and notify edges.
            }
            Err(e) => {
                warn!("Failed to remove channel {} from DB: {}", channel_id, e);
                // Proceed anyway: keep memory and edges consistent even if DB write failed.
            }
        }
        self.state.acl_manager.remove_channel(channel_id).await;
        self.broadcast_notification("hub.channelRemoved", |n| {
            n.channel_removed = Some(HubChannelRemovedParams { channel_id });
        }).await;
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

    /// Send a notification to a single specific edge.
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
        let edges = self.state.edge_connections.read().await;
        if let Some(sender) = edges.get(&edge_id) {
            if let Err(e) = sender.try_send(data) {
                warn!("Failed to send notification to edge {}: {}", edge_id, e);
            }
        }
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
            self.send_notification_to_edge(edge_id, "hub.routeTableUpdate", |n| {
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
    pub async fn cleanup_edge(&self, server_id: u32) {
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
            self.broadcast_notification("hub.userRemoveBroadcast", |n| {
                n.user_remove_broadcast = Some(remove_params);
            })
            .await;
        }

        self.state.edge_registry.write().await.remove(&server_id);

        // Remove from cluster topology
        self.state.topology.write().await.remove_edge(server_id);

        if !sessions.is_empty() {
            info!(
                "Cleaned up {} sessions for disconnected edge {}",
                sessions.len(),
                server_id
            );
        }
    }

    // ==================== Blob RPC Handlers ====================

    async fn handle_blob_put(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_put.as_ref().context("Missing blob_put params")?;
        match self.state.blob_store.put(&params.data) {
            Ok(hash) => Ok(self.make_response_packet(request_id, "blob.put", |r| {
                r.blob_put = Some(BlobPutResult { success: true, hash: Some(hash), error: None });
            })),
            Err(e) => Ok(self.make_response_packet(request_id, "blob.put", |r| {
                r.blob_put = Some(BlobPutResult { success: false, hash: None, error: Some(e.to_string()) });
            })),
        }
    }

    async fn handle_blob_get(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_get.as_ref().context("Missing blob_get params")?;
        match self.state.blob_store.get(&params.hash) {
            Ok(Some(data)) => Ok(self.make_response_packet(request_id, "blob.get", |r| {
                r.blob_get = Some(BlobGetResult { success: true, data: Some(data), error: None });
            })),
            Ok(None) => Ok(self.make_response_packet(request_id, "blob.get", |r| {
                r.blob_get = Some(BlobGetResult { success: false, data: None, error: Some("Not found".into()) });
            })),
            Err(e) => Ok(self.make_response_packet(request_id, "blob.get", |r| {
                r.blob_get = Some(BlobGetResult { success: false, data: None, error: Some(e.to_string()) });
            })),
        }
    }

    async fn handle_blob_get_user_texture(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_get_user_texture.as_ref().context("Missing blob_get_user_texture params")?;
        let hash_opt = self.state.user_store.get_blob_hash(params.user_id, "texture").await?;
        match hash_opt {
            Some(hash) => {
                match self.state.blob_store.get(&hash) {
                    Ok(Some(data)) => Ok(self.make_response_packet(request_id, "blob.getUserTexture", |r| {
                        r.blob_get_user_texture = Some(BlobGetUserTextureResult {
                            success: true, data: Some(data), hash: Some(hash.clone()), error: None,
                        });
                    })),
                    Ok(None) => Ok(self.make_response_packet(request_id, "blob.getUserTexture", |r| {
                        r.blob_get_user_texture = Some(BlobGetUserTextureResult {
                            success: false, data: None, hash: None, error: Some("Blob data not found".into()),
                        });
                    })),
                    Err(e) => Ok(self.make_response_packet(request_id, "blob.getUserTexture", |r| {
                        r.blob_get_user_texture = Some(BlobGetUserTextureResult {
                            success: false, data: None, hash: None, error: Some(e.to_string()),
                        });
                    })),
                }
            }
            None => Ok(self.make_response_packet(request_id, "blob.getUserTexture", |r| {
                r.blob_get_user_texture = Some(BlobGetUserTextureResult {
                    success: false, data: None, hash: None, error: Some("Not found".into()),
                });
            })),
        }
    }

    async fn handle_blob_get_user_comment(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_get_user_comment.as_ref().context("Missing blob_get_user_comment params")?;
        let hash_opt = self.state.user_store.get_blob_hash(params.user_id, "comment").await?;
        match hash_opt {
            Some(hash) => {
                match self.state.blob_store.get(&hash) {
                    Ok(Some(data)) => Ok(self.make_response_packet(request_id, "blob.getUserComment", |r| {
                        r.blob_get_user_comment = Some(BlobGetUserCommentResult {
                            success: true, data: Some(data), hash: Some(hash.clone()), error: None,
                        });
                    })),
                    Ok(None) => Ok(self.make_response_packet(request_id, "blob.getUserComment", |r| {
                        r.blob_get_user_comment = Some(BlobGetUserCommentResult {
                            success: false, data: None, hash: None, error: Some("Blob data not found".into()),
                        });
                    })),
                    Err(e) => Ok(self.make_response_packet(request_id, "blob.getUserComment", |r| {
                        r.blob_get_user_comment = Some(BlobGetUserCommentResult {
                            success: false, data: None, hash: None, error: Some(e.to_string()),
                        });
                    })),
                }
            }
            None => Ok(self.make_response_packet(request_id, "blob.getUserComment", |r| {
                r.blob_get_user_comment = Some(BlobGetUserCommentResult {
                    success: false, data: None, hash: None, error: Some("Not found".into()),
                });
            })),
        }
    }

    async fn handle_blob_set_user_texture(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_set_user_texture.as_ref().context("Missing blob_set_user_texture params")?;
        match self.state.blob_store.put(&params.data) {
            Ok(hash) => {
                match self.state.user_store.set_blob_hash(params.user_id, "texture", &hash).await {
                    Ok(()) => Ok(self.make_response_packet(request_id, "blob.setUserTexture", |r| {
                        r.blob_set_user_texture = Some(BlobSetUserTextureResult {
                            success: true, hash: Some(hash.clone()), error: None,
                        });
                    })),
                    Err(e) => Ok(self.make_response_packet(request_id, "blob.setUserTexture", |r| {
                        r.blob_set_user_texture = Some(BlobSetUserTextureResult {
                            success: false, hash: None, error: Some(e.to_string()),
                        });
                    })),
                }
            }
            Err(e) => Ok(self.make_response_packet(request_id, "blob.setUserTexture", |r| {
                r.blob_set_user_texture = Some(BlobSetUserTextureResult {
                    success: false, hash: None, error: Some(e.to_string()),
                });
            })),
        }
    }

    async fn handle_blob_set_user_comment(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_set_user_comment.as_ref().context("Missing blob_set_user_comment params")?;
        match self.state.blob_store.put(&params.data) {
            Ok(hash) => {
                match self.state.user_store.set_blob_hash(params.user_id, "comment", &hash).await {
                    Ok(()) => Ok(self.make_response_packet(request_id, "blob.setUserComment", |r| {
                        r.blob_set_user_comment = Some(BlobSetUserCommentResult {
                            success: true, hash: Some(hash.clone()), error: None,
                        });
                    })),
                    Err(e) => Ok(self.make_response_packet(request_id, "blob.setUserComment", |r| {
                        r.blob_set_user_comment = Some(BlobSetUserCommentResult {
                            success: false, hash: None, error: Some(e.to_string()),
                        });
                    })),
                }
            }
            Err(e) => Ok(self.make_response_packet(request_id, "blob.setUserComment", |r| {
                r.blob_set_user_comment = Some(BlobSetUserCommentResult {
                    success: false, hash: None, error: Some(e.to_string()),
                });
            })),
        }
    }

    // ==================== Cluster RPC Handlers ====================

    /// edge.join — Edge requests to join the cluster.
    async fn handle_cluster_join(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        edge_server_id: u32,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_join.as_ref().context("Missing edge_join params")?;
        let join_edge_id = if params.server_id != 0 { params.server_id } else { edge_server_id };

        let topo_edge = TopologyEdge {
            edge_id: join_edge_id,
            name: params.name.clone(),
            host: params.host.clone(),
            port: params.port,
            voice_port: params.voice_port,
            capacity: params.capacity,
            joined_at: std::time::Instant::now(),
            connected_peers: std::collections::HashSet::new(),
        };

        let peers_snapshot: Vec<PeerInfoProto> = {
            let mut topo = self.state.topology.write().await;
            topo.add_edge(topo_edge)
                .into_iter()
                .map(|p| PeerInfoProto {
                    id: p.edge_id,
                    name: p.name.clone(),
                    host: p.host.clone(),
                    port: p.port,
                    voice_port: p.voice_port,
                    cert_hash: None,
                })
                .collect()
        };

        // Notify existing edges about the new peer
        let notification = TypedRpcNotification {
            method: "hub.peerJoined".to_string(),
            timestamp: Some(current_millis() as i64),
            cluster_peer_joined: Some(HubClusterPeerJoinedParams {
                edge_id: join_edge_id,
                name: params.name.clone(),
                host: params.host.clone(),
                voice_port: params.voice_port,
            }),
            ..Default::default()
        };
        let notify_packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        let notify_data = notify_packet.encode_to_vec();

        let edge_connections = self.state.edge_connections.read().await;
        for (&eid, sender) in edge_connections.iter() {
            if eid != join_edge_id {
                let _ = sender.send(notify_data.clone()).await;
            }
        }

        info!("Edge {} ({}) joined cluster — {} peers", join_edge_id, params.name, peers_snapshot.len());

        Ok(self.make_response_packet(request_id, "edge.join", |r| {
            r.edge_join = Some(EdgeJoinResult {
                success: true,
                token: Some(format!("join-{}", join_edge_id)),
                peers: peers_snapshot,
                timeout: Some(30),
                error: None,
            });
        }))
    }

    /// edge.joinComplete — Edge confirms it has connected to peers.
    async fn handle_cluster_join_complete(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_join_complete.as_ref().context("Missing edge_join_complete params")?;
        {
            let mut topo = self.state.topology.write().await;
            topo.mark_join_complete(params.server_id, params.connected_peers.clone());
        }
        info!("Edge {} join complete, connected peers: {:?}", params.server_id, params.connected_peers);

        Ok(self.make_response_packet(request_id, "edge.joinComplete", |r| {
            r.edge_join_complete = Some(EdgeJoinCompleteResult { success: true, error: None });
        }))
    }

    /// edge.reportPeerDisconnect — Edge reports loss of connection to a peer.
    async fn handle_report_peer_disconnect(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_report_peer_disconnect.as_ref()
            .context("Missing edge_report_peer_disconnect params")?;

        let action = {
            let mut topo = self.state.topology.write().await;
            topo.arbitrate_disconnect(params.local_edge_id, params.remote_edge_id)
        };

        let action_str = match action {
            ArbitrationResult::BothReported { edge_id } => {
                warn!("Cluster: edge {} confirmed disconnected by arbitration", edge_id);
                // Notify all edges about the forced disconnection
                let notif = TypedRpcNotification {
                    method: "hub.peerLeft".to_string(),
                    timestamp: Some(current_millis() as i64),
                    cluster_peer_left: Some(HubClusterPeerLeftParams { edge_id }),
                    ..Default::default()
                };
                let packet = EdgeHubPacket {
                    r#type: PacketType::RpcNotification as i32,
                    rpc_notification: Some(notif),
                    ..Default::default()
                };
                let data = packet.encode_to_vec();
                {
                    let edges = self.state.edge_connections.read().await;
                    for sender in edges.values() {
                        let _ = sender.send(data.clone()).await;
                    }
                }

                // Detect network partitions and shut down smallest partition
                self.handle_partition_after_disconnect().await;

                "disconnect_confirmed".to_string()
            }
            ArbitrationResult::AwaitConfirmation => "await_confirmation".to_string(),
            ArbitrationResult::HubDecides => "hub_decides".to_string(),
        };

        Ok(self.make_response_packet(request_id, "edge.reportPeerDisconnect", |r| {
            r.edge_report_peer_disconnect = Some(EdgeReportPeerDisconnectResult { action: action_str });
        }))
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
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_relay_voice_via_tcp.as_ref()
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
        // params is a shared borrow (&EdgeRelayVoiceViaTcpParams), so a clone of
        // the voice payload is unavoidable here.  We place it directly into the
        // outgoing notification struct to keep the number of copies at one.
        let from_edge_id = params.from_edge_id;
        let timestamp = params.timestamp;

        // Forward the voice payload to the target edge via a typed protobuf notification
        let notif = TypedRpcNotification {
            method: "hub.relayVoicePacket".to_string(),
            timestamp: Some(current_millis() as i64),
            relay_voice_packet: Some(HubRelayVoicePacketParams {
                from_edge_id,
                voice_packet: params.voice_packet.clone(),
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

        let sent = {
            let edges = self.state.edge_connections.read().await;
            if let Some(sender) = edges.get(&target_edge_id) {
                sender.send(data).await.is_ok()
            } else {
                false
            }
        };

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
