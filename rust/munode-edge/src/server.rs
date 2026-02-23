use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use bytes::BytesMut;
use prost::Message;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info, warn};

use munode_common::config::EdgeConfig;
use munode_protocol::hubedge;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::decode_frame;

use crate::channel_manager::ChannelManager;
use crate::client::{ClientInfo, ClientManager, ClientSender, ClientState};
use crate::handler::{self, LoginHandler};
use crate::hub_client::{HubClient, HubConnectionState};
use crate::state::{EdgeEvent, EdgeState};
use crate::tls::create_tls_acceptor;
use crate::udp::UdpServer;

/// The main Edge server.
pub struct EdgeServer {
    config: EdgeConfig,
}

impl EdgeServer {
    pub fn new(config: EdgeConfig) -> Self {
        Self { config }
    }

    /// Run the edge server.
    pub async fn run(&self) -> Result<()> {
        // Create shared state
        let client_manager = ClientManager::new();
        let channel_manager = ChannelManager::new();
        let edge_state = EdgeState::new(channel_manager, client_manager);

        // Set up TLS
        let tls_acceptor = create_tls_acceptor(&self.config.tls)?;

        // Start UDP server
        let udp_addr: SocketAddr = format!("{}:{}", self.config.network.host, self.config.network.port)
            .parse()?;
        let udp_server = UdpServer::new(udp_addr, edge_state.clone()).await?;
        let udp_handle = tokio::spawn(async move {
            if let Err(e) = udp_server.run().await {
                error!("UDP server error: {}", e);
            }
        });

        // Connect to Hub
        let hub_client = HubClient::new(&self.config, edge_state.clone());
        let hub_handle = tokio::spawn({
            let hub_client = hub_client.clone();
            async move {
                if let Err(e) = hub_client.connect_and_run().await {
                    error!("Hub client error: {}", e);
                }
            }
        });

        // Event listener: broadcast Hub notifications to local clients
        let event_handle = tokio::spawn({
            let state = edge_state.clone();
            let mut event_rx = edge_state.subscribe_events();
            async move {
                hub_event_listener(state, &mut event_rx).await;
            }
        });

        // Start TLS server
        let listen_addr: SocketAddr = format!("{}:{}", self.config.network.host, self.config.network.port)
            .parse()?;
        let listener = TcpListener::bind(listen_addr).await?;
        info!("TLS server listening on {}", listen_addr);

        let (_shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        // Accept loop
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, peer_addr)) => {
                            let acceptor = tls_acceptor.clone();
                            let config = self.config.clone();
                            let hub = hub_client.clone();
                            let state = edge_state.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_client_connection(
                                    stream, peer_addr, acceptor, &config, hub, state,
                                ).await {
                                    debug!("Client connection error from {}: {}", peer_addr, e);
                                }
                            });
                        }
                        Err(e) => {
                            error!("Accept error: {}", e);
                        }
                    }
                }
                _ = shutdown_rx.recv() => {
                    info!("Shutting down edge server");
                    break;
                }
                _ = tokio::signal::ctrl_c() => {
                    info!("Received shutdown signal");
                    break;
                }
            }
        }

        udp_handle.abort();
        hub_handle.abort();
        event_handle.abort();

        Ok(())
    }
}

/// Handle a single Mumble client connection (TLS).
async fn handle_client_connection(
    stream: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    acceptor: TlsAcceptor,
    config: &EdgeConfig,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    info!("New TCP connection from {}", peer_addr);

    let tls_stream = acceptor.accept(stream).await?;
    let (mut reader, mut writer) = tokio::io::split(tls_stream);

    info!("TLS handshake complete with {}", peer_addr);

    // Create per-client message sender channel
    let (send_tx, mut send_rx) = mpsc::channel::<Vec<u8>>(256);
    let client_sender = ClientSender::new(send_tx);

    // Writer task: forwards messages from send_rx to TLS socket
    let writer_handle = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Some(data) = send_rx.recv().await {
            if let Err(e) = writer.write_all(&data).await {
                debug!("Write error to client: {}", e);
                break;
            }
        }
    });

    let mut buf = BytesMut::with_capacity(8192);
    let mut session_id: Option<u32> = None;
    let mut client_state = ClientState::Connected;

    loop {
        // Read data from TLS stream
        let n = reader.read_buf(&mut buf).await?;
        if n == 0 {
            info!("Client {} disconnected", peer_addr);
            break;
        }

        // Process all complete frames in the buffer
        while let Some(frame) = decode_frame(&mut buf)? {
            match frame.message_type {
                MessageType::Version => {
                    let response = handler::encode_version_response(&frame.payload, &peer_addr.to_string())?;
                    client_sender.send_raw(response).await;
                }
                MessageType::Authenticate if client_state == ClientState::Connected => {
                    let auth = mumbleproto::Authenticate::decode(&frame.payload[..])?;
                    let username = auth.username.clone().unwrap_or_default();
                    let password = auth.password.clone().unwrap_or_default();
                    let tokens: Vec<String> = auth.tokens.clone();
                    let opus = auth.opus.unwrap_or(false);

                    info!("Authentication request from {}: username={}", peer_addr, username);

                    // Check Hub connectivity
                    if hub_client.state().await != HubConnectionState::Registered {
                        warn!("Hub not connected, rejecting client {}", peer_addr);
                        client_sender.send_raw(handler::encode_reject(
                            Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                            "Server not ready, please try again later",
                        )).await;
                        writer_handle.abort();
                        return Ok(());
                    }

                    // Allocate session ID from Hub
                    let sid = match hub_client.allocate_session_id().await {
                        Ok(sid) => sid,
                        Err(e) => {
                            error!("Failed to allocate session ID: {}", e);
                            client_sender.send_raw(handler::encode_reject(
                                Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                                "Internal server error",
                            )).await;
                            writer_handle.abort();
                            return Ok(());
                        }
                    };

                    // Build client info for Hub
                    let client_info = hubedge::ClientInfo {
                        ip_address: peer_addr.ip().to_string(),
                        ip_version: if peer_addr.is_ipv4() { "IPv4" } else { "IPv6" }.to_string(),
                        release: String::new(),
                        version: None,
                        os: String::new(),
                        os_version: String::new(),
                        certificate_hash: None,
                    };

                    // Authenticate via Hub
                    let auth_result = match hub_client.authenticate_user(
                        sid, &username, &password, tokens, Some(client_info),
                    ).await {
                        Ok(result) => result,
                        Err(e) => {
                            error!("Authentication RPC failed: {}", e);
                            client_sender.send_raw(handler::encode_reject(
                                Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                                "Authentication failed",
                            )).await;
                            writer_handle.abort();
                            return Ok(());
                        }
                    };

                    if !auth_result.success {
                        let reason = auth_result.reason.clone().unwrap_or_else(|| "Authentication denied".to_string());
                        info!("Authentication failed for {}: {}", username, reason);
                        client_sender.send_raw(handler::encode_reject(
                            auth_result.reject_type.map(|t| t as i32),
                            &reason,
                        )).await;
                        writer_handle.abort();
                        return Ok(());
                    }

                    // Authentication succeeded
                    session_id = Some(sid);
                    let channel_id = auth_result.channel_id.unwrap_or(config.server.default_channel);

                    info!(
                        "User {} authenticated (session={}, user_id={:?}, channel={})",
                        auth_result.username.as_deref().unwrap_or(&username),
                        sid,
                        auth_result.user_id,
                        channel_id
                    );

                    // Create local client
                    let client = ClientInfo {
                        session: sid,
                        user_id: auth_result.user_id.unwrap_or(0),
                        username: auth_result.username.clone().unwrap_or(username.clone()),
                        channel_id,
                        state: ClientState::Authenticated,
                        mute: auth_result.mute.unwrap_or(false),
                        deaf: auth_result.deaf.unwrap_or(false),
                        suppress: auth_result.suppress.unwrap_or(false),
                        self_mute: auth_result.self_mute.unwrap_or(false),
                        self_deaf: auth_result.self_deaf.unwrap_or(false),
                        priority_speaker: auth_result.priority_speaker.unwrap_or(false),
                        recording: auth_result.recording.unwrap_or(false),
                        ip_address: peer_addr.ip().to_string(),
                        connected_at: std::time::Instant::now(),
                        last_active: std::time::Instant::now(),
                        cert_hash: None,
                        groups: vec![],
                    };
                    edge_state.client_manager.add_client(client.clone(), client_sender.clone()).await;

                    // Execute full login sequence
                    let login = LoginHandler::new(
                        &client_sender, config, &edge_state, &hub_client,
                    );
                    login.execute_login(sid, &auth_result, opus).await?;

                    client_state = ClientState::Ready;
                    edge_state.client_manager.set_client_state(sid, ClientState::Ready).await;

                    // Broadcast new user to all other clients
                    let user_state_msg = handler::build_user_state_msg(&client);
                    edge_state.client_manager.broadcast(
                        MessageType::UserState,
                        &user_state_msg,
                        Some(sid),
                    ).await;

                    info!("Client {} is now Ready (session={})", peer_addr, sid);
                }
                MessageType::Ping => {
                    let response = handler::encode_ping_response(&frame.payload)?;
                    client_sender.send_raw(response).await;
                }
                MessageType::UserState if client_state == ClientState::Ready => {
                    let user_state = mumbleproto::UserState::decode(&frame.payload[..])?;
                    if let Some(sid) = session_id {
                        handle_user_state_update(&edge_state, &hub_client, sid, &user_state).await;
                    }
                }
                MessageType::TextMessage if client_state == ClientState::Ready => {
                    let text_msg = mumbleproto::TextMessage::decode(&frame.payload[..])?;
                    if let Some(sid) = session_id {
                        debug!("TextMessage from session {}: {:?}", sid, text_msg.message);
                        broadcast_text_message(&edge_state, sid, &text_msg).await;
                    }
                }
                MessageType::UdpTunnel if client_state == ClientState::Ready => {
                    // Voice data tunneled through TCP - forward to all users in the same channel
                    if let Some(sid) = session_id {
                        if let Some(client) = edge_state.client_manager.get_client(sid).await {
                            // Forward voice data to all clients in the same channel
                            let mut buf = BytesMut::new();
                            bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
                            bytes::BufMut::put_u32(&mut buf, frame.payload.len() as u32);
                            bytes::BufMut::put_slice(&mut buf, &frame.payload);
                            let data = buf.to_vec();

                            let sessions = edge_state.client_manager.get_channel_sessions(client.channel_id).await;
                            for target_session in sessions {
                                if target_session == sid {
                                    continue;
                                }
                                if let Some(sender) = edge_state.client_manager.get_sender(target_session).await {
                                    sender.send_raw(data.clone()).await;
                                }
                            }
                        }
                    }
                }
                MessageType::VoiceTarget if client_state == ClientState::Ready => {
                    let vt = mumbleproto::VoiceTarget::decode(&frame.payload[..])?;
                    if let Some(sid) = session_id {
                        let target_id = vt.id.unwrap_or(0);
                        debug!("VoiceTarget from session {}: id={}", sid, target_id);

                        // Convert Mumble VoiceTarget to Hub config
                        if target_id >= 1 && target_id <= 30 {
                            let config = if vt.targets.is_empty() {
                                // Empty targets = delete the voice target
                                None
                            } else {
                                let mut sessions = Vec::new();
                                let mut channels = Vec::new();
                                for target in &vt.targets {
                                    if !target.session.is_empty() {
                                        for &s in &target.session {
                                            sessions.push(hubedge::VoiceTargetSession {
                                                session: s,
                                            });
                                        }
                                    }
                                    if let Some(ch_id) = target.channel_id {
                                        channels.push(hubedge::VoiceTargetChannel {
                                            channel_id: ch_id,
                                            links: Some(target.links.unwrap_or(false)),
                                            children: Some(target.children.unwrap_or(false)),
                                            group: target.group.clone(),
                                        });
                                    }
                                }
                                Some(hubedge::VoiceTargetConfigProto { sessions, channels })
                            };

                            // Sync to Hub (fire-and-forget)
                            let hub = hub_client.clone();
                            tokio::spawn(async move {
                                if let Err(e) = hub.sync_voice_target(sid, target_id as u32, config).await {
                                    warn!("Failed to sync VoiceTarget: {}", e);
                                }
                            });
                        }
                    }
                }
                MessageType::UserStats if client_state == ClientState::Ready => {
                    let stats = mumbleproto::UserStats::decode(&frame.payload[..])?;
                    if let Some(_sid) = session_id {
                        debug!("UserStats request for session {:?}", stats.session);
                        // Forward basic stats response back
                        if let Some(target_session) = stats.session {
                            if let Some(target) = edge_state.client_manager.get_client(target_session).await {
                                let response = mumbleproto::UserStats {
                                    session: Some(target_session),
                                    stats_only: Some(true),
                                    from_client: Some(mumbleproto::user_stats::Stats {
                                        good: Some(0),
                                        late: Some(0),
                                        lost: Some(0),
                                        resync: Some(0),
                                    }),
                                    from_server: Some(mumbleproto::user_stats::Stats {
                                        good: Some(0),
                                        late: Some(0),
                                        lost: Some(0),
                                        resync: Some(0),
                                    }),
                                    address: Some(target.ip_address.as_bytes().to_vec()),
                                    ..Default::default()
                                };
                                client_sender.send_message(MessageType::UserStats, &response).await;
                            }
                        }
                    }
                }
                MessageType::PermissionQuery if client_state == ClientState::Ready => {
                    let pq = mumbleproto::PermissionQuery::decode(&frame.payload[..])?;
                    if let Some(sid) = session_id {
                        let channel_id = pq.channel_id.unwrap_or(0);
                        debug!("PermissionQuery from session {} for channel {}", sid, channel_id);

                        // Forward to Hub
                        let hub = hub_client.clone();
                        let sender = client_sender.clone();
                        tokio::spawn(async move {
                            match hub.handle_permission_query(sid, channel_id).await {
                                Ok(result) => {
                                    let response = mumbleproto::PermissionQuery {
                                        channel_id: Some(channel_id),
                                        permissions: result.permissions,
                                        flush: Some(false),
                                    };
                                    sender.send_message(MessageType::PermissionQuery, &response).await;
                                }
                                Err(e) => {
                                    debug!("PermissionQuery failed: {}", e);
                                    // Return default permissions
                                    let response = mumbleproto::PermissionQuery {
                                        channel_id: Some(channel_id),
                                        permissions: Some(0),
                                        flush: Some(false),
                                    };
                                    sender.send_message(MessageType::PermissionQuery, &response).await;
                                }
                            }
                        });
                    }
                }
                MessageType::CryptSetup if client_state == ClientState::Ready => {
                    // Client is sending updated nonce for CryptSetup resync
                    let crypt = mumbleproto::CryptSetup::decode(&frame.payload[..])?;
                    debug!("CryptSetup resync from {}: has_client_nonce={}", peer_addr, crypt.client_nonce.is_some());
                    // Acknowledge with empty CryptSetup
                    let response = mumbleproto::CryptSetup {
                        key: None,
                        client_nonce: None,
                        server_nonce: None,
                    };
                    client_sender.send_message(MessageType::CryptSetup, &response).await;
                }
                MessageType::UserRemove if client_state == ClientState::Ready => {
                    // User-initiated kick/ban - forward to Hub
                    let user_remove = mumbleproto::UserRemove::decode(&frame.payload[..])?;
                    if let Some(sid) = session_id {
                        if let Some(client) = edge_state.client_manager.get_client(sid).await {
                            debug!("UserRemove from session {} targeting session {}", sid, user_remove.session);
                            hub_client.notify_user_remove(
                                sid,
                                client.user_id,
                                &client.username,
                                user_remove.session,
                                user_remove.reason.as_deref().unwrap_or(""),
                                user_remove.ban.unwrap_or(false),
                            ).await;
                        }
                    }
                }
                MessageType::ChannelState if client_state == ClientState::Ready => {
                    // Client requesting channel create/edit - forward to Hub
                    let ch_state = mumbleproto::ChannelState::decode(&frame.payload[..])?;
                    debug!("ChannelState from {}: channel_id={:?}, name={:?}", peer_addr, ch_state.channel_id, ch_state.name);
                    // TODO: Forward to Hub for channel create/edit
                }
                other => {
                    debug!("Unhandled message type {:?} from {} (state={:?})", other, peer_addr, client_state);
                }
            }
        }
    }

    // Cleanup
    if let Some(sid) = session_id {
        edge_state.client_manager.remove_client(sid).await;

        // Broadcast UserRemove to all remaining clients
        let remove_msg = handler::build_user_remove_msg(sid, None);
        edge_state.client_manager.broadcast(
            MessageType::UserRemove,
            &remove_msg,
            None,
        ).await;

        // Notify Hub that user disconnected
        hub_client.notify_user_left(sid, None).await;

        info!("Cleaned up session {} for {}", sid, peer_addr);
    }

    writer_handle.abort();
    Ok(())
}

/// Handle a UserState update from a local client.
async fn handle_user_state_update(
    edge_state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
    session_id: u32,
    user_state: &mumbleproto::UserState,
) {
    let mut needs_broadcast = false;
    let mut channel_moved = false;

    if let Some(mut client) = edge_state.client_manager.get_client(session_id).await {
        // Self-mute/self-deaf updates
        if let Some(self_mute) = user_state.self_mute {
            client.self_mute = self_mute;
            needs_broadcast = true;
        }
        if let Some(self_deaf) = user_state.self_deaf {
            client.self_deaf = self_deaf;
            needs_broadcast = true;
        }

        // Channel move
        if let Some(channel_id) = user_state.channel_id {
            if client.channel_id != channel_id {
                debug!("User {} moving to channel {}", session_id, channel_id);
                // Get sender before removing (remove clears sender too)
                let sender = edge_state.client_manager.get_sender(session_id).await;
                edge_state.client_manager.remove_client(session_id).await;
                client.channel_id = channel_id;
                if let Some(sender) = sender {
                    edge_state.client_manager.add_client(client.clone(), sender).await;
                }
                needs_broadcast = true;
                channel_moved = true;
            }
        }

        if needs_broadcast {
            edge_state.client_manager.update_client(client.clone()).await;
            // Broadcast updated UserState to all clients
            let msg = handler::build_user_state_msg(&client);
            edge_state.client_manager.broadcast(MessageType::UserState, &msg, None).await;

            // Notify Hub of state change
            if channel_moved {
                hub_client.notify_user_moved(session_id, client.channel_id).await;
            } else {
                let state_json = serde_json::json!({
                    "self_mute": client.self_mute,
                    "self_deaf": client.self_deaf,
                });
                hub_client.notify_user_state_changed(session_id, state_json).await;
            }
        }
    }
}

/// Broadcast a text message to local clients.
async fn broadcast_text_message(
    edge_state: &Arc<EdgeState>,
    sender_session: u32,
    text_msg: &mumbleproto::TextMessage,
) {
    // Route based on target: channel, tree, or specific sessions
    let mut msg = text_msg.clone();
    msg.actor = Some(sender_session);

    if !text_msg.channel_id.is_empty() {
        // Send to users in specified channels
        for &channel_id in &text_msg.channel_id {
            edge_state.client_manager.broadcast_to_channel(
                channel_id,
                MessageType::TextMessage,
                &msg,
                Some(sender_session),
            ).await;
        }
    } else if !text_msg.session.is_empty() {
        // Send to specific sessions
        for &target_session in &text_msg.session {
            edge_state.client_manager.send_to(target_session, MessageType::TextMessage, &msg).await;
        }
    } else if !text_msg.tree_id.is_empty() {
        // Send to channel trees (for now, treat as broadcast)
        for &channel_id in &text_msg.tree_id {
            edge_state.client_manager.broadcast_to_channel(
                channel_id,
                MessageType::TextMessage,
                &msg,
                Some(sender_session),
            ).await;
        }
    }
}

/// Listen for events from the Hub and broadcast them to local clients.
async fn hub_event_listener(
    state: Arc<EdgeState>,
    event_rx: &mut tokio::sync::broadcast::Receiver<EdgeEvent>,
) {
    use tokio::sync::broadcast::error::RecvError;

    loop {
        match event_rx.recv().await {
            Ok(event) => {
                match event {
                    EdgeEvent::RemoteUserJoined { session_id, username, channel_id } => {
                        if let Some(user) = state.channel_manager.get_remote_user(session_id).await {
                            let msg = mumbleproto::UserState {
                                session: Some(user.session_id),
                                user_id: Some(user.user_id),
                                name: Some(user.username.clone()),
                                channel_id: Some(user.channel_id),
                                mute: Some(user.mute),
                                deaf: Some(user.deaf),
                                suppress: Some(user.suppress),
                                self_mute: Some(user.self_mute),
                                self_deaf: Some(user.self_deaf),
                                priority_speaker: Some(user.priority_speaker),
                                recording: Some(user.recording),
                                hash: user.cert_hash.clone(),
                                ..Default::default()
                            };
                            state.client_manager.broadcast(MessageType::UserState, &msg, None).await;
                        }
                        debug!("Broadcast remote user joined: {} (session {}, channel {})", username, session_id, channel_id);
                    }
                    EdgeEvent::RemoteUserLeft { session_id } => {
                        let msg = handler::build_user_remove_msg(session_id, None);
                        state.client_manager.broadcast(MessageType::UserRemove, &msg, None).await;
                        debug!("Broadcast remote user left: session {}", session_id);
                    }
                    EdgeEvent::RemoteUserMoved { session_id, channel_id } => {
                        let msg = mumbleproto::UserState {
                            session: Some(session_id),
                            channel_id: Some(channel_id),
                            ..Default::default()
                        };
                        state.client_manager.broadcast(MessageType::UserState, &msg, None).await;
                        debug!("Broadcast remote user moved: session {} -> channel {}", session_id, channel_id);
                    }
                    EdgeEvent::ChannelCreated { channel_id } => {
                        if let Some(ch) = state.channel_manager.get_channel(channel_id).await {
                            let msg = handler::build_channel_state_msg(&ch);
                            state.client_manager.broadcast(MessageType::ChannelState, &msg, None).await;
                        }
                        debug!("Broadcast channel created: {}", channel_id);
                    }
                    EdgeEvent::ChannelRemoved { channel_id } => {
                        let msg = mumbleproto::ChannelRemove { channel_id };
                        state.client_manager.broadcast(MessageType::ChannelRemove, &msg, None).await;
                        debug!("Broadcast channel removed: {}", channel_id);
                    }
                    EdgeEvent::ChannelUpdated { channel_id } => {
                        if let Some(ch) = state.channel_manager.get_channel(channel_id).await {
                            let msg = handler::build_channel_state_msg(&ch);
                            state.client_manager.broadcast(MessageType::ChannelState, &msg, None).await;
                        }
                        debug!("Broadcast channel updated: {}", channel_id);
                    }
                    EdgeEvent::HubRegistered => {
                        info!("Hub registered event received");
                    }
                    EdgeEvent::HubDisconnected => {
                        warn!("Hub disconnected - local clients will continue but some features unavailable");
                    }
                }
            }
            Err(RecvError::Lagged(count)) => {
                warn!("Event listener lagged behind by {} events", count);
            }
            Err(RecvError::Closed) => {
                info!("Event channel closed");
                break;
            }
        }
    }
}
