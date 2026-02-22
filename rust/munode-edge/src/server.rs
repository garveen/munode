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
use crate::client::{ClientInfo, ClientManager, ClientState};
use crate::handler::{self, LoginHandler};
use crate::hub_client::{HubClient, HubConnectionState};
use crate::state::EdgeState;
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
        let udp_server = UdpServer::new(udp_addr).await?;
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

    let mut buf = BytesMut::with_capacity(8192);
    let mut session_id: Option<u32> = None;
    let mut client_state = ClientState::Connected;
    let mut _version_received = false;

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
                    handler::handle_version(&mut writer, &frame.payload, &peer_addr.to_string()).await?;
                    _version_received = true;
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
                        handler::send_reject(
                            &mut writer,
                            Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                            "Server not ready, please try again later",
                        ).await?;
                        return Ok(());
                    }

                    // Allocate session ID from Hub
                    let sid = match hub_client.allocate_session_id().await {
                        Ok(sid) => sid,
                        Err(e) => {
                            error!("Failed to allocate session ID: {}", e);
                            handler::send_reject(
                                &mut writer,
                                Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                                "Internal server error",
                            ).await?;
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
                            handler::send_reject(
                                &mut writer,
                                Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                                "Authentication failed",
                            ).await?;
                            return Ok(());
                        }
                    };

                    if !auth_result.success {
                        let reason = auth_result.reason.clone().unwrap_or_else(|| "Authentication denied".to_string());
                        info!("Authentication failed for {}: {}", username, reason);
                        handler::send_reject(
                            &mut writer,
                            auth_result.reject_type.map(|t| t as i32),
                            &reason,
                        ).await?;
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
                        username: auth_result.username.clone().unwrap_or(username),
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
                    edge_state.client_manager.add_client(client).await;

                    // Execute full login sequence
                    let mut login = LoginHandler::new(
                        &mut writer, config, &edge_state, &hub_client,
                    );
                    login.execute_login(sid, &auth_result, opus).await?;

                    client_state = ClientState::Ready;
                    edge_state.client_manager.set_client_state(sid, ClientState::Ready).await;
                    info!("Client {} is now Ready (session={})", peer_addr, sid);
                }
                MessageType::Ping => {
                    handler::handle_ping(&mut writer, &frame.payload).await?;
                }
                MessageType::UserState if client_state == ClientState::Ready => {
                    let user_state = mumbleproto::UserState::decode(&frame.payload[..])?;
                    if let Some(sid) = session_id {
                        handle_user_state_update(&edge_state, sid, &user_state).await;
                    }
                }
                MessageType::TextMessage if client_state == ClientState::Ready => {
                    let text_msg = mumbleproto::TextMessage::decode(&frame.payload[..])?;
                    if let Some(sid) = session_id {
                        debug!("TextMessage from session {}: {:?}", sid, text_msg.message);
                        // TODO: Forward to Hub for broadcast to other edges
                        // For now, broadcast to local clients
                        broadcast_text_message(&edge_state, sid, &text_msg).await;
                    }
                }
                MessageType::UdpTunnel if client_state == ClientState::Ready => {
                    // Voice data tunneled through TCP
                    debug!("TCP voice packet from {} ({} bytes)", peer_addr, frame.payload.len());
                    // TODO: Route through VoiceRouter
                }
                MessageType::VoiceTarget if client_state == ClientState::Ready => {
                    let vt = mumbleproto::VoiceTarget::decode(&frame.payload[..])?;
                    debug!("VoiceTarget from {}: id={:?}", peer_addr, vt.id);
                    // TODO: Sync voice target to Hub
                }
                MessageType::UserStats if client_state == ClientState::Ready => {
                    debug!("UserStats request from {}", peer_addr);
                    // TODO: Return user statistics
                }
                MessageType::PermissionQuery if client_state == ClientState::Ready => {
                    let pq = mumbleproto::PermissionQuery::decode(&frame.payload[..])?;
                    debug!("PermissionQuery from {} for channel {:?}", peer_addr, pq.channel_id);
                    // TODO: Forward to Hub for permission check
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
        // TODO: Notify Hub that user disconnected
        info!("Cleaned up session {} for {}", sid, peer_addr);
    }

    Ok(())
}

/// Handle a UserState update from a local client.
async fn handle_user_state_update(
    edge_state: &Arc<EdgeState>,
    session_id: u32,
    user_state: &mumbleproto::UserState,
) {
    // Self-mute/self-deaf updates
    if let Some(self_mute) = user_state.self_mute {
        if let Some(mut client) = edge_state.client_manager.get_client(session_id).await {
            client.self_mute = self_mute;
            edge_state.client_manager.add_client(client).await;
        }
    }
    if let Some(self_deaf) = user_state.self_deaf {
        if let Some(mut client) = edge_state.client_manager.get_client(session_id).await {
            client.self_deaf = self_deaf;
            edge_state.client_manager.add_client(client).await;
        }
    }

    // Channel move
    if let Some(channel_id) = user_state.channel_id {
        if let Some(mut client) = edge_state.client_manager.get_client(session_id).await {
            if client.channel_id != channel_id {
                debug!("User {} moving to channel {}", session_id, channel_id);
                // TODO: Check permission via Hub
                // TODO: Notify Hub of channel move
                let _old_channel = client.channel_id;
                client.channel_id = channel_id;
                edge_state.client_manager.remove_client(session_id).await;
                edge_state.client_manager.add_client(client).await;
            }
        }
    }

    // TODO: Forward state changes to Hub for broadcast
}

/// Broadcast a text message to local clients.
async fn broadcast_text_message(
    _edge_state: &Arc<EdgeState>,
    sender_session: u32,
    text_msg: &mumbleproto::TextMessage,
) {
    // TODO: Implement proper message routing (channel, tree, session targets)
    // For now, just log
    debug!(
        "TextMessage from session {}: channels={:?}, sessions={:?}, tree={:?}",
        sender_session, text_msg.channel_id, text_msg.session, text_msg.tree_id
    );
}
