use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use prost::Message;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info, warn};

use munode_protocol::hubedge::*;

use crate::channel_store::ChannelRecord;
use crate::database::DbChannelRecord;
use crate::server::HubState;
use crate::session_manager::SessionInfo;

/// Sender type for pushing serialized packets to a specific edge.
pub type EdgeSender = mpsc::Sender<Vec<u8>>;

/// Information about a registered edge server.
#[derive(Debug, Clone)]
pub struct EdgeRegistration {
    pub server_id: u32,
    pub name: String,
    pub host: String,
    pub port: u32,
    pub capacity: u32,
    pub region: Option<String>,
}

/// Voice target storage entry.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct VoiceTargetEntry {
    edge_id: u32,
    client_session: u32,
    target_id: u32,
    config: Option<VoiceTargetConfigProto>,
    timestamp: i64,
}

/// Handles all incoming RPC requests from edges.
pub struct RpcHandler {
    state: Arc<HubState>,
    /// Registered edge info keyed by server_id.
    edge_registry: RwLock<HashMap<u32, EdgeRegistration>>,
    /// Voice targets keyed by (client_session, target_id).
    voice_targets: RwLock<HashMap<(u32, u32), VoiceTargetEntry>>,
}

impl RpcHandler {
    pub fn new(state: Arc<HubState>) -> Self {
        Self {
            state,
            edge_registry: RwLock::new(HashMap::new()),
            voice_targets: RwLock::new(HashMap::new()),
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

        debug!("RPC request: {} (id={})", method, request_id);

        let response = match method.as_str() {
            "edge.register" => self.handle_register(&request, &request_id).await,
            "edge.allocateSessionId" => self.handle_allocate_session_id(&request, &request_id).await,
            "edge.authenticateUser" => self.handle_authenticate_user(&request, &request_id, edge_server_id).await,
            "edge.fullSync" => self.handle_full_sync(&request, &request_id).await,
            "edge.handlePermissionQuery" => self.handle_permission_query(&request, &request_id).await,
            "edge.syncVoiceTarget" => self.handle_sync_voice_target(&request, &request_id).await,
            "edge.saveChannel" => self.handle_save_channel(&request, &request_id).await,
            _ => {
                warn!("Unknown RPC method: {}", method);
                Ok(self.make_error_packet(&request_id, -1, &format!("Unknown method: {}", method)))
            }
        };

        match response {
            Ok(packet) => {
                let data: Vec<u8> = packet.encode_to_vec();
                Ok(data)
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
                let challenge = generate_challenge();
                let result = EdgeRegisterResult {
                    success: false,
                    hub_server_id: None,
                    edge_list: vec![],
                    challenge: Some(challenge),
                    challenge_timeout: Some(30000),
                    error: None,
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
                    };
                    return Ok(self.make_response_packet(request_id, "edge.register", |r| {
                        r.edge_register = Some(result);
                    }));
                }
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
        };

        info!(
            "Edge registered: {} (id={}, {}:{})",
            registration.name, registration.server_id, registration.host, registration.port
        );

        self.edge_registry
            .write()
            .await
            .insert(params.server_id, registration);

        // Build edge list for response
        let edge_list: Vec<EdgeInfo> = self
            .edge_registry
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

        let result = EdgeRegisterResult {
            success: true,
            hub_server_id: Some(params.server_id),
            edge_list,
            challenge: None,
            challenge_timeout: None,
            error: None,
        };

        Ok(self.make_response_packet(request_id, "edge.register", |r| {
            r.edge_register = Some(result);
        }))
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

        // Check server password if set
        if let Some(server_pw) = &config.auth.server_password {
            if !server_pw.is_empty() && password != server_pw {
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
            // Look up user in database
            let db_user = self.state.database.find_user(username)?;
            if db_user.is_none() {
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

        // Look up or create user
        let db_user = self.state.database.find_user(username)?;
        let (user_id, channel_id) = match db_user {
            Some(u) => (u.id, u.last_channel),
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

        self.state.session_manager.add_session(session_info.clone()).await;

        info!(
            "User authenticated: {} (session={}, edge={}, channel={})",
            username, params.session_id, edge_server_id, channel_id
        );

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

        // Gather all channel links (deduplicated)
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

        // Gather all sessions
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

        // Build edge list
        let edges: Vec<EdgeInfoProto> = self
            .edge_registry
            .read()
            .await
            .values()
            .map(|e| EdgeInfoProto {
                server_id: e.server_id,
                name: e.name.clone(),
                host: e.host.clone(),
                port: e.port,
                region: e.region.clone(),
                current_load: 0,
                capacity: e.capacity,
            })
            .collect();

        let result = EdgeFullSyncResult {
            channels,
            channel_links,
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
        let _params = request.edge_handle_permission_query.as_ref()
            .context("Missing edge_handle_permission_query params")?;

        // TODO: Implement proper ACL-based permission checks.
        // Currently grants all permissions (0x7FFFFFFF) as a stub.
        // Production use requires checking user groups, channel ACLs, and inheritance.
        let result = EdgeHandlePermissionQueryResult {
            success: true,
            permissions: Some(0x7FFFFFFF),
            error: None,
        };

        Ok(self.make_response_packet(request_id, "edge.handlePermissionQuery", |r| {
            r.edge_handle_permission_query = Some(result);
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

        self.voice_targets
            .write()
            .await
            .insert((params.client_session, params.target_id), entry);

        // Broadcast to other edges
        // Build a JSON-compatible string from the voice target config
        let config_json = if let Some(cfg) = &params.config {
            let sessions: Vec<u32> = cfg.sessions.iter().map(|s| s.session).collect();
            let channels: Vec<serde_json::Value> = cfg.channels.iter().map(|c| {
                serde_json::json!({
                    "channel_id": c.channel_id,
                    "children": c.children,
                    "links": c.links,
                    "group": c.group,
                })
            }).collect();
            serde_json::json!({
                "sessions": sessions,
                "channels": channels,
            }).to_string()
        } else {
            "{}".to_string()
        };
        let sync_params = HubSyncVoiceTargetParams {
            edge_id: params.edge_id,
            client_session: params.client_session,
            target_id: params.target_id,
            config_json,
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

        let is_new = params.id.is_none();
        let channel_id = if is_new {
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
            let id = self.state.channel_store.create_channel_auto_id(ch.clone()).await;

            // Save to database
            let db_ch = DbChannelRecord {
                id,
                parent_id: params.parent_id,
                name: params.name.clone().unwrap_or_else(|| "New Channel".to_string()),
                description: params.description.clone().unwrap_or_default(),
                position: params.position.unwrap_or(0),
                max_users: params.max_users.unwrap_or(0),
                temporary: false,
                inherit_acl: params.inherit_acl.unwrap_or(true),
            };
            self.state.database.save_channel(&db_ch)?;

            // Broadcast channel created
            let proto = ChannelDataProto {
                channel_id: id,
                name: db_ch.name.clone(),
                parent_id: db_ch.parent_id,
                description: Some(db_ch.description),
                position: Some(db_ch.position),
                max_users: if db_ch.max_users > 0 { Some(db_ch.max_users) } else { None },
                temporary: Some(false),
                inherit_acl: Some(db_ch.inherit_acl),
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

                self.state.channel_store.update_channel(ch.clone()).await;

                // Save to database
                let db_ch = DbChannelRecord {
                    id: ch.id,
                    parent_id: ch.parent_id,
                    name: ch.name.clone(),
                    description: ch.description.clone(),
                    position: ch.position,
                    max_users: ch.max_users,
                    temporary: ch.temporary,
                    inherit_acl: ch.inherit_acl,
                };
                self.state.database.save_channel(&db_ch)?;

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

    // ==================== Notification Handlers ====================

    async fn on_user_left(&self, notification: &TypedRpcNotification) {
        // Parse from unknown_params_json
        if let Some(json_str) = &notification.unknown_params_json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                let session_id = v["session_id"].as_u64().unwrap_or(0) as u32;
                if session_id == 0 {
                    return;
                }

                if let Some(removed) = self.state.session_manager.remove_session(session_id).await {
                    info!("User left: {} (session={})", removed.username, session_id);

                    // Broadcast user removal to all edges
                    let remove_params = HubUserRemoveBroadcastParams {
                        session: session_id,
                        actor: None,
                        reason: v["reason"].as_str().map(String::from),
                        ban: None,
                        target_sessions: vec![],
                    };
                    self.broadcast_notification("hub.userRemoveBroadcast", |n| {
                        n.user_remove_broadcast = Some(remove_params);
                    })
                    .await;
                }
            }
        }
    }

    async fn on_user_remove(&self, notification: &TypedRpcNotification) {
        if let Some(json_str) = &notification.unknown_params_json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                let target_session = v["target_session"].as_u64().unwrap_or(0) as u32;
                if target_session == 0 {
                    return;
                }

                if let Some(removed) = self.state.session_manager.remove_session(target_session).await {
                    info!("User removed: {} (session={})", removed.username, target_session);

                    let remove_params = HubUserRemoveBroadcastParams {
                        session: target_session,
                        actor: v["actor_session"].as_u64().map(|v| v as u32),
                        reason: v["reason"].as_str().map(String::from),
                        ban: v["ban"].as_bool(),
                        target_sessions: vec![],
                    };
                    self.broadcast_notification("hub.userRemoveBroadcast", |n| {
                        n.user_remove_broadcast = Some(remove_params);
                    })
                    .await;
                }
            }
        }
    }

    async fn on_user_moved(&self, notification: &TypedRpcNotification) {
        if let Some(json_str) = &notification.unknown_params_json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                let session_id = v["session_id"].as_u64().unwrap_or(0) as u32;
                let channel_id = v["channel_id"].as_u64().unwrap_or(0) as u32;
                let edge_id = v["edge_id"].as_u64().unwrap_or(0) as u32;

                if session_id == 0 {
                    return;
                }

                self.state.session_manager.move_user_to_channel(session_id, channel_id).await;

                let moved_params = HubUserMovedParams {
                    session_id,
                    edge_id,
                    channel_id,
                    actor_session: None,
                };
                self.broadcast_notification("hub.userMoved", |n| {
                    n.user_moved = Some(moved_params);
                })
                .await;
            }
        }
    }

    async fn on_user_state_changed(&self, notification: &TypedRpcNotification) {
        if let Some(json_str) = &notification.unknown_params_json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                let session_id = v["session_id"].as_u64().unwrap_or(0) as u32;
                if session_id == 0 {
                    return;
                }

                // Update session state
                let sessions = &self.state.session_manager;
                if let Some(mut session) = sessions.get_session(session_id).await {
                    if let Some(mute) = v["self_mute"].as_bool() {
                        session.self_mute = mute;
                    }
                    if let Some(deaf) = v["self_deaf"].as_bool() {
                        session.self_deaf = deaf;
                    }
                    if let Some(mute) = v["mute"].as_bool() {
                        session.mute = mute;
                    }
                    if let Some(deaf) = v["deaf"].as_bool() {
                        session.deaf = deaf;
                    }
                    if let Some(suppress) = v["suppress"].as_bool() {
                        session.suppress = suppress;
                    }
                    if let Some(ps) = v["priority_speaker"].as_bool() {
                        session.priority_speaker = ps;
                    }
                    if let Some(rec) = v["recording"].as_bool() {
                        session.recording = rec;
                    }
                    sessions.add_session(session).await;
                }
            }
        }
    }

    /// Handle text message forwarding: relay to all other edges (not the sender).
    async fn on_text_message(&self, notification: &TypedRpcNotification, source_edge_id: u32) {
        if let Some(json_str) = &notification.unknown_params_json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                let actor = v["actor"].as_u64().unwrap_or(0) as u32;
                if actor == 0 {
                    return;
                }

                debug!("Forwarding text message from actor {} (edge {}) to other edges", actor, source_edge_id);

                // Forward to all edges except the source
                let forward_notification = TypedRpcNotification {
                    method: "hub.textMessageForward".to_string(),
                    timestamp: Some(current_millis() as i64),
                    unknown_params_json: Some(json_str.clone()),
                    ..Default::default()
                };

                let packet = EdgeHubPacket {
                    r#type: PacketType::RpcNotification as i32,
                    rpc_notification: Some(forward_notification),
                    ..Default::default()
                };
                let data = packet.encode_to_vec();

                let edges = self.state.edge_connections.read().await;
                for (edge_id, sender) in edges.iter() {
                    if *edge_id == source_edge_id {
                        continue;
                    }
                    if let Err(e) = sender.try_send(data.clone()) {
                        warn!("Failed to forward text message to edge {}: {}", edge_id, e);
                    }
                }
            }
        }
    }

    /// Handle channel state notification from an edge (channel create/edit request).
    async fn on_channel_state(&self, notification: &TypedRpcNotification) {
        if let Some(json_str) = &notification.unknown_params_json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                let channel_id = v["channel_id"].as_u64().map(|n| n as u32);
                let name = v["name"].as_str().map(String::from);
                let parent_id = v["parent_id"].as_u64().map(|n| n as u32);

                if let Some(ch_id) = channel_id {
                    // Update existing channel
                    if let Some(mut ch) = self.state.channel_store.get_channel(ch_id).await {
                        if let Some(n) = &name {
                            ch.name = n.clone();
                        }
                        if let Some(pid) = parent_id {
                            ch.parent_id = Some(pid);
                        }
                        if let Some(pos) = v["position"].as_i64() {
                            ch.position = pos as i32;
                        }
                        if let Some(desc) = v["description"].as_str() {
                            ch.description = desc.to_string();
                        }
                        self.state.channel_store.update_channel(ch).await;

                        // Broadcast to all edges
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
                    }
                }
            }
        }
    }

    /// Handle channel removal notification from an edge.
    async fn on_channel_remove(&self, notification: &TypedRpcNotification) {
        if let Some(json_str) = &notification.unknown_params_json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                let channel_id = v["channel_id"].as_u64().unwrap_or(0) as u32;
                if channel_id == 0 {
                    return; // Don't allow removing root channel
                }

                if let Some(removed) = self.state.channel_store.remove_channel(channel_id).await {
                    info!("Channel removed: {} (id={})", removed.name, channel_id);

                    // Delete from database
                    if let Err(e) = self.state.database.delete_channel(channel_id) {
                        warn!("Failed to delete channel {} from database: {}", channel_id, e);
                    }

                    // Broadcast to all edges
                    self.broadcast_notification("hub.channelRemoved", |n| {
                        n.channel_removed = Some(HubChannelRemovedParams { channel_id });
                    }).await;
                }
            }
        }
    }

    // ==================== Helpers ====================

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
        let edges = self.state.edge_connections.read().await;
        for (edge_id, sender) in edges.iter() {
            if let Err(e) = sender.try_send(data.clone()) {
                warn!("Failed to send notification to edge {}: {}", edge_id, e);
            }
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

        self.edge_registry.write().await.remove(&server_id);

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
fn generate_challenge() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let rng = SystemRandom::new();
    let mut buf = [0u8; 32];
    rng.fill(&mut buf).unwrap();
    hex_encode(&buf)
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

fn current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
