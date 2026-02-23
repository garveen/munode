use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::time;
use tokio_tungstenite::tungstenite;
use tracing::{debug, error, info, warn};

use munode_common::config::{EdgeConfig, HubServerConfig};
use munode_protocol::hubedge::{
    self, EdgeAuthenticateUserParams, EdgeFullSyncParams,
    EdgeHubPacket, EdgeRegisterParams,
    PacketType, TypedRpcNotification, TypedRpcRequest, TypedRpcResponse,
};

use crate::channel_manager::{ChannelData, RemoteUser};
use crate::state::{EdgeEvent, EdgeState};

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
pub struct HubClient {
    config: HubServerConfig,
    server_id: u32,
    server_name: String,
    state: RwLock<HubConnectionState>,
    edge_state: Arc<EdgeState>,
    /// Pending RPC requests awaiting responses.
    pending: Mutex<HashMap<String, PendingRequest>>,
    /// Channel for sending packets to the WebSocket writer task.
    send_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    /// Counter for generating unique request IDs.
    request_counter: Mutex<u64>,
}

impl HubClient {
    pub fn new(
        config: &EdgeConfig,
        edge_state: Arc<EdgeState>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config: config.hub_server.clone(),
            server_id: config.server_id,
            server_name: config.name.clone(),
            state: RwLock::new(HubConnectionState::Disconnected),
            edge_state,
            pending: Mutex::new(HashMap::new()),
            send_tx: Mutex::new(None),
            request_counter: Mutex::new(0),
        })
    }

    pub async fn state(&self) -> HubConnectionState {
        *self.state.read().await
    }

    /// Get the current edge ID (our registered ID from Hub, or fallback to server_id).
    async fn edge_id(&self) -> u32 {
        self.edge_state.edge_id.read().await.unwrap_or(self.server_id)
    }

    /// Generate a unique request ID.
    async fn next_request_id(&self) -> String {
        let mut counter = self.request_counter.lock().await;
        *counter += 1;
        format!("{}-{}", current_millis(), *counter)
    }

    /// Connect to the Hub and run the main communication loop with reconnection.
    pub async fn connect_and_run(self: &Arc<Self>) -> Result<()> {
        loop {
            match self.try_connect().await {
                Ok(()) => {
                    info!("Hub connection closed normally");
                }
                Err(e) => {
                    error!("Hub connection error: {}", e);
                }
            }

            // Clean up state
            *self.state.write().await = HubConnectionState::Disconnected;
            *self.send_tx.lock().await = None;
            self.pending.lock().await.clear();
            self.edge_state.emit(EdgeEvent::HubDisconnected);

            let delay = Duration::from_millis(self.config.reconnect_interval);
            warn!("Reconnecting to Hub in {:?}", delay);
            time::sleep(delay).await;
        }
    }

    /// Attempt a single connection to the Hub.
    async fn try_connect(self: &Arc<Self>) -> Result<()> {
        *self.state.write().await = HubConnectionState::Connecting;

        let url = format!("ws://{}:{}", self.config.host, self.config.control_port);
        info!("Connecting to Hub at {}", url);

        let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
            .await
            .context("Failed to connect to Hub WebSocket")?;

        info!("WebSocket connected to Hub");
        *self.state.write().await = HubConnectionState::Connected;

        let (mut ws_write, mut ws_read) = ws_stream.split();

        // Channel for sending outgoing messages
        let (send_tx, mut send_rx) = mpsc::channel::<Vec<u8>>(256);
        *self.send_tx.lock().await = Some(send_tx);

        // Writer task: forwards messages from send_rx to WebSocket
        let writer_handle = tokio::spawn(async move {
            while let Some(data) = send_rx.recv().await {
                if let Err(e) = ws_write.send(tungstenite::Message::Binary(Bytes::from(data))).await {
                    error!("WebSocket write error: {}", e);
                    break;
                }
            }
        });

        // Register with Hub
        self.do_register().await?;

        // Request full sync
        self.do_full_sync().await?;

        *self.state.write().await = HubConnectionState::Registered;
        self.edge_state.emit(EdgeEvent::HubRegistered);
        info!("Edge registered with Hub successfully");

        // Start heartbeat loop
        let heartbeat_self = self.clone();
        let heartbeat_handle = tokio::spawn(async move {
            heartbeat_self.heartbeat_loop().await;
        });

        // Main read loop: process incoming messages
        loop {
            match ws_read.next().await {
                Some(Ok(msg)) => {
                    match msg {
                        tungstenite::Message::Binary(data) => {
                            if let Err(e) = self.handle_incoming(&data).await {
                                warn!("Error handling Hub message: {}", e);
                            }
                        }
                        tungstenite::Message::Close(_) => {
                            info!("Hub sent close frame");
                            break;
                        }
                        tungstenite::Message::Ping(data) => {
                            self.send_raw(tungstenite::Message::Pong(data).into_data().to_vec()).await.ok();
                        }
                        _ => {}
                    }
                }
                Some(Err(e)) => {
                    error!("WebSocket read error: {}", e);
                    break;
                }
                None => {
                    info!("WebSocket stream ended");
                    break;
                }
            }
        }

        heartbeat_handle.abort();
        writer_handle.abort();
        Ok(())
    }

    /// Send raw bytes through the WebSocket.
    async fn send_raw(&self, data: Vec<u8>) -> Result<()> {
        if let Some(tx) = self.send_tx.lock().await.as_ref() {
            tx.send(data).await.context("Send channel closed")?;
        }
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
        self.send_packet(&packet).await?;

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

    /// Handle incoming WebSocket message.
    async fn handle_incoming(&self, data: &[u8]) -> Result<()> {
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
                if let Some(notification) = packet.rpc_notification {
                    self.handle_notification(notification).await;
                }
            }
            Ok(PacketType::HeartbeatAck) => {
                debug!("Heartbeat ack received");
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
        debug!("Hub notification: {}", method);

        match method.as_str() {
            "hub.userJoined" => {
                if let Some(params) = &notification.user_joined {
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
                    };
                    info!("Remote user joined: {} (session {})", user.username, user.session_id);
                    self.edge_state.channel_manager.upsert_remote_user(user.clone()).await;
                    self.edge_state.emit(EdgeEvent::RemoteUserJoined {
                        session_id: user.session_id,
                        username: user.username,
                        channel_id: user.channel_id,
                    });
                }
            }
            "hub.userRemoveBroadcast" => {
                if let Some(params) = &notification.user_remove_broadcast {
                    info!("Remote user removed: session {}", params.session);
                    self.edge_state.channel_manager.remove_remote_user(params.session).await;
                    self.edge_state.emit(EdgeEvent::RemoteUserLeft {
                        session_id: params.session,
                    });
                }
            }
            "hub.userMoved" => {
                if let Some(params) = &notification.user_moved {
                    debug!("Remote user moved: session {} -> channel {}", params.session_id, params.channel_id);
                    if let Some(mut user) = self.edge_state.channel_manager.get_remote_user(params.session_id).await {
                        user.channel_id = params.channel_id;
                        self.edge_state.channel_manager.upsert_remote_user(user).await;
                    }
                    self.edge_state.emit(EdgeEvent::RemoteUserMoved {
                        session_id: params.session_id,
                        channel_id: params.channel_id,
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
                    debug!("Channel updated: {} (id {})", channel.name, channel.id);
                    self.edge_state.channel_manager.upsert_channel(channel).await;
                    self.edge_state.emit(EdgeEvent::ChannelUpdated { channel_id: ch_proto.channel_id });
                }
            }
            "edge.forceDisconnect" => {
                if let Some(params) = &notification.force_disconnect {
                    warn!("Hub forced disconnect: {}", params.reason);
                }
            }
            "edge.peerJoined" => {
                if let Some(params) = &notification.peer_joined {
                    info!("Peer edge joined: {} (id {})", params.name, params.id);
                }
            }
            "hub.textMessageForward" => {
                // Text message forwarded from another edge via Hub
                if let Some(json_str) = &notification.unknown_params_json {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                        let actor = v["actor"].as_u64().unwrap_or(0) as u32;
                        let message = v["message"].as_str().unwrap_or_default().to_string();
                        let channel_id: Vec<u32> = v["channel_id"].as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
                            .unwrap_or_default();
                        let tree_id: Vec<u32> = v["tree_id"].as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
                            .unwrap_or_default();
                        let session: Vec<u32> = v["session"].as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
                            .unwrap_or_default();

                        self.edge_state.emit(EdgeEvent::TextMessageForward {
                            actor,
                            message,
                            channel_id,
                            tree_id,
                            session,
                        });
                    }
                }
            }
            _ => {
                debug!("Unhandled notification: {}", method);
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
            host: self.config.host.clone(),
            port: self.config.control_port as u32,
            region: None,
            capacity: 1000,
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
        *self.edge_state.edge_id.write().await = result.hub_server_id;

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
            host: self.config.host.clone(),
            port: self.config.control_port as u32,
            region: None,
            capacity: 1000,
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

        *self.edge_state.edge_id.write().await = result.hub_server_id;
        info!("Registered with Hub via HMAC challenge-response");
        Ok(())
    }

    /// Request full sync from Hub (channels, users, ACLs).
    async fn do_full_sync(&self) -> Result<()> {
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

        // Load channels
        self.edge_state.channel_manager.load_channels(
            &result.channels,
            &result.channel_links,
        ).await;

        // Load remote users
        self.edge_state.channel_manager.load_remote_users(&result.sessions).await;

        info!(
            "Full sync complete: {} channels, {} sessions",
            result.channels.len(),
            result.sessions.len()
        );
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

            let packet = EdgeHubPacket {
                r#type: PacketType::Heartbeat as i32,
                heartbeat: Some(hubedge::Heartbeat {
                    edge_id: self.edge_id().await,
                    sequence,
                    stats: Some(hubedge::ServerStats {
                        user_count,
                        channel_count,
                        cpu_usage: None,
                        memory_usage_mb: None,
                        network_send_kbps: None,
                        network_recv_kbps: None,
                        uptime_seconds: None,
                    }),
                }),
                ..Default::default()
            };

            if let Err(e) = self.send_packet(&packet).await {
                warn!("Failed to send heartbeat: {}", e);
                break;
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
                self_mute: None,
                self_deaf: None,
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
        let edge_id = self.edge_id().await;
        let params_json = serde_json::json!({
            "session_id": session_id,
            "edge_id": edge_id,
            "reason": reason,
        });
        let notification = TypedRpcNotification {
            method: "hub.handleUserLeft".to_string(),
            timestamp: Some(current_millis() as i64),
            unknown_params_json: Some(params_json.to_string()),
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
        let edge_id = self.edge_id().await;
        let params_json = serde_json::json!({
            "edge_id": edge_id,
            "actor_session": actor_session,
            "actor_user_id": actor_user_id,
            "actor_username": actor_username,
            "target_session": target_session,
            "reason": reason,
            "ban": ban,
        });
        let notification = TypedRpcNotification {
            method: "hub.handleUserRemove".to_string(),
            timestamp: Some(current_millis() as i64),
            unknown_params_json: Some(params_json.to_string()),
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
    pub async fn notify_user_moved(&self, session_id: u32, channel_id: u32) {
        let edge_id = self.edge_id().await;
        let params_json = serde_json::json!({
            "session_id": session_id,
            "edge_id": edge_id,
            "channel_id": channel_id,
        });
        let notification = TypedRpcNotification {
            method: "hub.handleUserMoved".to_string(),
            timestamp: Some(current_millis() as i64),
            unknown_params_json: Some(params_json.to_string()),
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
    pub async fn notify_user_state_changed(&self, session_id: u32, user_state_json: serde_json::Value) {
        let edge_id = self.edge_id().await;
        let mut params = user_state_json;
        params["session_id"] = serde_json::json!(session_id);
        params["edge_id"] = serde_json::json!(edge_id);
        let notification = TypedRpcNotification {
            method: "hub.handleUserStateChanged".to_string(),
            timestamp: Some(current_millis() as i64),
            unknown_params_json: Some(params.to_string()),
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
        let edge_id = self.edge_id().await;

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
        let edge_id = self.edge_id().await;
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
        let edge_id = self.edge_id().await;
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

    /// Notify Hub about a channel removal request.
    pub async fn notify_channel_remove(&self, channel_id: u32) {
        let edge_id = self.edge_id().await;
        let params_json = serde_json::json!({
            "edge_id": edge_id,
            "channel_id": channel_id,
        });
        let notification = TypedRpcNotification {
            method: "hub.handleChannelRemove".to_string(),
            timestamp: Some(current_millis() as i64),
            unknown_params_json: Some(params_json.to_string()),
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
        let edge_id = self.edge_id().await;
        let params_json = serde_json::json!({
            "edge_id": edge_id,
            "actor": sender_session,
            "message": text_msg.message,
            "channel_id": text_msg.channel_id,
            "tree_id": text_msg.tree_id,
            "session": text_msg.session,
        });
        let notification = TypedRpcNotification {
            method: "hub.handleTextMessage".to_string(),
            timestamp: Some(current_millis() as i64),
            unknown_params_json: Some(params_json.to_string()),
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

