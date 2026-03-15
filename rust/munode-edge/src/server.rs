use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use bytes::BytesMut;
use prost::Message;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info, trace, warn};

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

/// Permission bit flags matching the Mumble protocol ACL system.
/// These must match the values defined in munode-hub's acl_manager::permission.
mod perm {
    pub const WRITE: u32 = 0x1;
    pub const ENTER: u32 = 0x4;
    pub const SPEAK: u32 = 0x8;
    pub const LISTEN: u32 = 0x800;
}

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

        // Derive voice routing flags from the new voice_routing config, falling back
        // to the legacy `server.disable_hub_relay` for backwards compatibility.
        use munode_common::config::VoiceConnectionStrategy;
        let (allow_hub_relay, allow_direct_udp) = match &self.config.voice_routing.connection_strategy {
            VoiceConnectionStrategy::TcpOnly => (true, false),
            VoiceConnectionStrategy::DirectOnly => (false, true),
            VoiceConnectionStrategy::AutoFallback => {
                // Legacy override: disable_hub_relay forces DirectOnly behaviour.
                (!self.config.server.disable_hub_relay, true)
            }
        };
        let edge_state = EdgeState::new_with_config(
            channel_manager,
            client_manager,
            allow_hub_relay,
            allow_direct_udp,
            self.config.server.listeners_per_user,
            self.config.server.listeners_per_channel,
        );

        // Set up TLS
        let tls_acceptor = create_tls_acceptor(&self.config.tls)?;

        // Connect to Hub (create client first so UdpServer can reference it)
        let hub_client = HubClient::new(&self.config, edge_state.clone());
        let hub_handle = tokio::spawn({
            let hub_client = hub_client.clone();
            async move {
                if let Err(e) = hub_client.connect_and_run().await {
                    error!("Hub client error: {}", e);
                }
            }
        });

        // Start UDP server (needs hub_client for cross-edge relay)
        let udp_addr: SocketAddr = format!("{}:{}", self.config.network.host, self.config.network.port)
            .parse()?;
        let edge_port = self.config.network.edge_port.unwrap_or(self.config.network.port + 1);
        let edge_udp_addr: SocketAddr = format!("{}:{}", self.config.network.host, edge_port)
            .parse()?;
        let udp_server = UdpServer::new(udp_addr, edge_udp_addr, edge_state.clone(), hub_client.clone()).await?;
        let udp_handle = tokio::spawn(async move {
            if let Err(e) = udp_server.run().await {
                error!("UDP server error: {}", e);
            }
        });

        // Event listener: broadcast Hub notifications to local clients
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
        let event_handle = tokio::spawn({
            let state = edge_state.clone();
            let mut event_rx = edge_state.subscribe_events();
            let shutdown_tx = shutdown_tx.clone();
            async move {
                hub_event_listener(state, &mut event_rx, shutdown_tx).await;
            }
        });

        // Always start the control-relay server (every Edge acts as a relay for peers)
        let relay_port = if self.config.hub_server.relay_port > 0 {
            self.config.hub_server.relay_port
        } else {
            edge_port as u16 + 2
        };
        {
            let hub_host = self.config.hub_server.host.clone();
            let hub_port = self.config.hub_server.control_port;
            info!("Starting control relay server on port {}", relay_port);
            tokio::spawn(async move {
                crate::relay_server::run_relay_server(relay_port, hub_host, hub_port).await;
            });
        }

        // Start TLS server
        let listen_addr: SocketAddr = format!("{}:{}", self.config.network.host, self.config.network.port)
            .parse()?;
        let listener = TcpListener::bind(listen_addr).await?;
        info!("TLS server listening on {}", listen_addr);

        // Semaphore to cap concurrent connections at the configured capacity.
        // capacity = 0 means unlimited; use a large sentinel value in that case.
        let max_conn = if self.config.server.capacity > 0 {
            self.config.server.capacity as usize
        } else {
            10_000
        };
        let conn_semaphore = Arc::new(tokio::sync::Semaphore::new(max_conn));

        // Accept loop
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, peer_addr)) => {
                            // Reject the connection immediately if the server is at capacity.
                            let permit = match conn_semaphore.clone().try_acquire_owned() {
                                Ok(permit) => permit,
                                Err(_) => {
                                    warn!("Connection from {} rejected: server at capacity ({})", peer_addr, max_conn);
                                    drop(stream);
                                    continue;
                                }
                            };
                            let acceptor = tls_acceptor.clone();
                            let config = self.config.clone();
                            let hub = hub_client.clone();
                            let state = edge_state.clone();
                            tokio::spawn(async move {
                                // Hold the permit for the duration of the connection.
                                let _permit = permit;
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

        // Allow background tasks a moment to notice shutdown before aborting.
        // These tasks are stateless (no persistent data to flush), so abort is
        // acceptable as a fallback after a brief grace period.
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        udp_handle.abort();
        hub_handle.abort();
        event_handle.abort();

        Ok(())
    }
}

/// Idle timeout for client TCP connections. Connections that send no data for
/// this duration are considered zombie connections and are closed.
const CLIENT_IDLE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(120);

/// Handle a single Mumble client connection (TLS).
async fn handle_client_connection(
    stream: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    acceptor: TlsAcceptor,
    config: &EdgeConfig,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    // Disable Nagle's algorithm for real-time voice delivery
    stream.set_nodelay(true)?;

    // Only log after TLS handshake succeeds to avoid noise from healthcheck probes (nc -z)
    let tls_stream = acceptor.accept(stream).await?;

    info!("New TCP connection from {}", peer_addr);
    
    // Extract client certificate hash BEFORE splitting the stream
    // Mumble uses SHA-1 hash of the client certificate (not SHA-256)
    let certificate_hash: Option<String> = tls_stream
        .get_ref()
        .1 // Get the TLS session (ServerConnection)
        .peer_certificates()
        .and_then(|certs| certs.first())
        .map(|cert| {
            use sha1::{Sha1, Digest};
            let mut hasher = Sha1::new();
            hasher.update(cert.as_ref());
            let result = hasher.finalize();
            hex::encode(result)
        });
    
    if let Some(ref hash) = certificate_hash {
        info!("Client {} certificate hash: {}...", peer_addr, &hash[..16]);
    }
    
    let (mut reader, mut writer) = tokio::io::split(tls_stream);

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
            if let Err(e) = writer.flush().await {
                debug!("Flush error to client: {}", e);
                break;
            }
        }
    });

    let mut buf = BytesMut::with_capacity(8192);
    let mut session_id: Option<u32> = None;
    let mut client_state = ClientState::Connected;
    // Pre-connect state: sent by client before Authenticate message
    let mut preconnect_self_mute: Option<bool> = None;
    let mut preconnect_self_deaf: Option<bool> = None;
    // Client version info from Version message
    let mut client_version: Option<u32> = None;
    let mut client_release = String::new();
    let mut client_os = String::new();
    let mut client_os_version = String::new();
    // Per-client rate limiter for text messages.
    // Prefer hub-pushed limits over edge-local config (hub limits are set after registration).
    let hub_limits_snapshot = edge_state.hub_limits.read().await.clone();
    let (effective_message_rate, effective_message_burst) = hub_limits_snapshot
        .as_ref()
        .map(|l| (l.message_rate.unwrap_or(0.0), l.message_burst.unwrap_or(0)))
        .unwrap_or((config.server.message_rate, config.server.message_burst));
    let mut text_rate_limiter = if effective_message_rate > 0.0 {
        Some(munode_common::rate_limiter::TokenBucket::new(
            effective_message_rate,
            effective_message_burst,
        ))
    } else {
        None
    };

    'outer: loop {
        // Read data from TLS stream with idle timeout to drop zombie connections.
        let n = match tokio::time::timeout(CLIENT_IDLE_TIMEOUT, reader.read_buf(&mut buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                info!("Client {} connection error: {}", peer_addr, e);
                break 'outer;
            }
            Err(_) => {
                info!("Client {} idle timeout — closing connection", peer_addr);
                break 'outer;
            }
        };
        if n == 0 {
            info!("Client {} disconnected", peer_addr);
            break;
        }

        // Process all complete frames in the buffer
        loop {
            let frame = match decode_frame(&mut buf) {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(e) => {
                    warn!("Frame decode error from {}: {}", peer_addr, e);
                    break 'outer;
                }
            };
            match frame.message_type {
                MessageType::Version => {
                    // Parse client version message and save info
                    if let Ok(version_msg) = mumbleproto::Version::decode(&frame.payload[..]) {
                        client_version = version_msg.version;
                        // Truncate version strings to prevent log injection and excess memory use.
                        const MAX_VERSION_STR: usize = 256;
                        client_release = version_msg.release.unwrap_or_default();
                        client_release.truncate(MAX_VERSION_STR);
                        client_os = version_msg.os.unwrap_or_default();
                        client_os.truncate(MAX_VERSION_STR);
                        client_os_version = version_msg.os_version.unwrap_or_default();
                        client_os_version.truncate(MAX_VERSION_STR);
                        info!(
                            "Client {} version: v={:?} release={} os={} os_version={}",
                            peer_addr, client_version, client_release, client_os, client_os_version
                        );
                    }
                    let Ok(response) = handler::encode_version_response(&frame.payload, &peer_addr.to_string()) else {
                        continue;
                    };
                    client_sender.send_raw(response).await;
                }
                // Pre-connect UserState: client sends self_deaf/self_mute before Authenticate
                MessageType::UserState if client_state == ClientState::Connected => {
                    if let Ok(us) = mumbleproto::UserState::decode(&frame.payload[..]) {
                        if us.self_mute.is_some() { preconnect_self_mute = us.self_mute; }
                        if us.self_deaf.is_some() {
                            preconnect_self_deaf = us.self_deaf;
                            // self_deaf implies self_mute per Mumble protocol
                            if us.self_deaf == Some(true) { preconnect_self_mute = Some(true); }
                        }
                    }
                }
                MessageType::Authenticate if client_state == ClientState::Connected => {
                    let Ok(auth) = mumbleproto::Authenticate::decode(&frame.payload[..]) else { continue; };
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
                        // Drop sender so the writer task drains and flushes before exiting
                        drop(client_sender);
                        writer_handle.await.ok();
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
                            drop(client_sender);
                            writer_handle.await.ok();
                            return Ok(());
                        }
                    };

                    // Build client info for Hub (use data from Version message)
                    let client_info = hubedge::ClientInfo {
                        ip_address: peer_addr.ip().to_string(),
                        ip_version: if peer_addr.is_ipv4() { "IPv4" } else { "IPv6" }.to_string(),
                        release: client_release.clone(),
                        version: client_version,
                        os: client_os.clone(),
                        os_version: client_os_version.clone(),
                        certificate_hash: certificate_hash.clone(),
                    };

                    // Authenticate via Hub
                    let auth_result = match hub_client.authenticate_user(
                        sid, &username, &password, tokens, Some(client_info),
                        preconnect_self_mute, preconnect_self_deaf,
                    ).await {
                        Ok(result) => result,
                        Err(e) => {
                            error!("Authentication RPC failed: {}", e);
                            client_sender.send_raw(handler::encode_reject(
                                Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                                "Authentication failed",
                            )).await;
                            drop(client_sender);
                            writer_handle.await.ok();
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
                        // Drop sender so the writer task drains and flushes the Reject before exiting
                        drop(client_sender);
                        writer_handle.await.ok();
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

                    // Prefer display_name over username (matches JS implementation behaviour).
                    let display_name = auth_result.display_name.clone()
                        .or(auth_result.username.clone())
                        .unwrap_or(username.clone());

                    // Create local client (suppress will be recomputed after add)
                    let mut client = ClientInfo {
                        session: sid,
                        user_id: auth_result.user_id.unwrap_or(0),
                        username: display_name,
                        channel_id,
                        state: ClientState::Authenticated,
                        mute: auth_result.mute.unwrap_or(false),
                        deaf: auth_result.deaf.unwrap_or(false),
                        suppress: auth_result.suppress.unwrap_or(false),
                        self_mute: preconnect_self_mute.unwrap_or(auth_result.self_mute.unwrap_or(false)),
                        self_deaf: preconnect_self_deaf.unwrap_or(auth_result.self_deaf.unwrap_or(false)),
                        priority_speaker: auth_result.priority_speaker.unwrap_or(false),
                        recording: auth_result.recording.unwrap_or(false),
                        ip_address: peer_addr.ip().to_string(),
                        connected_at: std::time::Instant::now(),
                        last_active: std::time::Instant::now(),
                        cert_hash: certificate_hash.clone(),
                        groups: vec![],
                        opus_supported: opus,
                        listening_channels: vec![],
            listening_volume_adjustments: HashMap::new(),
            texture_hash: None,
            comment_hash: None,
                    };
                    // Add client to manager first so permission queries can resolve user_id
                    edge_state.client_manager.add_client(client.clone(), client_sender.clone()).await;

                    // Check Speak permission for initial channel to determine suppress
                    // (done AFTER add_client so hub_client.handle_permission_query gets the right user_id)
                    if !auth_result.suppress.unwrap_or(false) {
                        let can_speak = match hub_client.handle_permission_query(sid, channel_id).await {
                            Ok(r) => r.permissions.map(|p| p & perm::SPEAK != 0).unwrap_or(true),
                            Err(_) => true,
                        };
                        if !can_speak {
                            client.suppress = true;
                            edge_state.client_manager.update_client(client.clone()).await;
                        }
                    }

                    // Execute full login sequence
                    let login = LoginHandler::new(
                        &client_sender, config, &edge_state, &hub_client,
                    );
                    if let Err(e) = login.execute_login(sid, &auth_result, opus).await {
                        info!("Login sequence failed for {} (session={}): {}", peer_addr, sid, e);
                        break 'outer;
                    }

                    // Broadcast updated codec version to all clients now that this client's
                    // opus capability is registered
                    broadcast_codec_version(&edge_state).await;

                    client_state = ClientState::Ready;
                    edge_state.client_manager.set_client_state(sid, ClientState::Ready).await;

                    // Populate ninja channel permission cache for this client
                    {
                        let ninja_channels = edge_state.ninja_channels.read().await.clone();
                        if !ninja_channels.is_empty() {
                            let mut visible_set = std::collections::HashSet::new();
                            for &ch_id in &ninja_channels {
                                let can_enter = match hub_client.handle_permission_query(sid, ch_id).await {
                                    Ok(r) => r.permissions.map(|p| p & perm::ENTER != 0).unwrap_or(false),
                                    Err(_) => false,
                                };
                                if can_enter {
                                    visible_set.insert(ch_id);
                                }
                            }
                            edge_state.ninja_visible_to.write().await.insert(sid, visible_set);
                        }
                    }

                    // If suppress was set by permission check, notify the client itself
                    if client.suppress && !auth_result.suppress.unwrap_or(false) {
                        let suppress_msg = mumbleproto::UserState {
                            session: Some(sid),
                            suppress: Some(true),
                            ..Default::default()
                        };
                        client_sender.send_message(MessageType::UserState, &suppress_msg).await;
                    }

                    // If pre-connect self_deaf/self_mute was set, notify client and broadcast
                    if preconnect_self_deaf.is_some() || preconnect_self_mute.is_some() {
                        let preconnect_msg = mumbleproto::UserState {
                            session: Some(sid),
                            self_mute: preconnect_self_mute,
                            self_deaf: preconnect_self_deaf,
                            ..Default::default()
                        };
                        // Notify the client itself
                        client_sender.send_message(MessageType::UserState, &preconnect_msg).await;
                    }

                    // Broadcast new user to all other clients (use updated client state)
                    let user_state_msg = handler::build_user_state_msg(&client);
                    edge_state.client_manager.broadcast(
                        MessageType::UserState,
                        &user_state_msg,
                        Some(sid),
                    ).await;

                    info!("Client {} is now Ready (session={})", peer_addr, sid);
                }
                MessageType::Ping => {
                    let Ok(response) = handler::encode_ping_response(&frame.payload) else { continue; };
                    client_sender.send_raw(response).await;
                }
                MessageType::UserState if client_state == ClientState::Ready => {
                    let Ok(user_state) = mumbleproto::UserState::decode(&frame.payload[..]) else { continue; };
                    if let Some(sid) = session_id {
                        // Check if this targets another user (admin operation)
                        let target_sid = user_state.session.unwrap_or(sid);
                        if target_sid != sid && (user_state.mute.is_some() || user_state.deaf.is_some() || user_state.channel_id.is_some()) {
                            // Admin operation: apply to target session
                            handle_admin_user_state_update(&edge_state, &hub_client, sid, target_sid, &user_state).await;
                        } else {
                            handle_user_state_update(&edge_state, &hub_client, sid, &user_state).await;
                        }
                    }
                }
                MessageType::TextMessage if client_state == ClientState::Ready => {
                    let Ok(text_msg) = mumbleproto::TextMessage::decode(&frame.payload[..]) else { continue; };
                    if let Some(sid) = session_id {
                        // Check message length limit (in bytes, consistent with Mumble protocol)
                        let msg_len = text_msg.message.len() as u32;
                        let limit = config.server.text_message_length;
                        if limit > 0 && msg_len > limit {
                            warn!("Session {} sent text message too long ({} > {} bytes), dropping", sid, msg_len, limit);
                            let reject = mumbleproto::PermissionDenied {
                                r#type: Some(mumbleproto::permission_denied::DenyType::TextTooLong as i32),
                                reason: Some(format!("Message too long: {} > {} bytes", msg_len, limit)),
                                ..Default::default()
                            };
                            client_sender.send_message(MessageType::PermissionDenied, &reject).await;
                            continue;
                        }
                        // Apply rate limiting
                        if let Some(ref mut rl) = text_rate_limiter {
                            if !rl.try_consume() {
                                warn!("Session {} text message rate limited", sid);
                                let reject = mumbleproto::PermissionDenied {
                                    r#type: Some(mumbleproto::permission_denied::DenyType::Text as i32),
                                    reason: Some("Text message rate limit exceeded".to_string()),
                                    ..Default::default()
                                };
                                client_sender.send_message(MessageType::PermissionDenied, &reject).await;
                                continue;
                            }
                        }
                        debug!("TextMessage from session {}: {:?}", sid, text_msg.message);
                        // Local broadcast to clients on this edge
                        broadcast_text_message(&edge_state, sid, &text_msg).await;
                        // Forward to Hub for cross-edge delivery
                        hub_client.notify_text_message(sid, &text_msg).await;
                    }
                }
                MessageType::UdpTunnel if client_state == ClientState::Ready => {
                    // Voice data tunneled through TCP.
                    // Voice packet format: first byte is (voice_type << 5) | target
                    // target: 0 = normal broadcast, 1-30 = voice target (whisper), 31 = loopback
                    if let Some(sid) = session_id {
                        if let Some(client) = edge_state.client_manager.get_client(sid).await {
                            // Suppressed users cannot speak (except loopback)
                            let voice_target = if !frame.payload.is_empty() {
                                (frame.payload[0] & 0x1F) as u32
                            } else {
                                0
                            };

                            // Block suppressed users from speaking (except loopback target=31)
                            if client.suppress && voice_target != 31 {
                                // Silently drop the packet
                            } else if voice_target == 31 {
                                // Loopback: send back to the sender (inject session ID per protocol)
                                let forwarded = inject_session_into_voice(&frame.payload, sid);
                                let mut buf = BytesMut::new();
                                bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
                                bytes::BufMut::put_u32(&mut buf, forwarded.len() as u32);
                                bytes::BufMut::put_slice(&mut buf, &forwarded);
                                let data = buf.to_vec();
                                if let Some(sender_tx) = edge_state.client_manager.get_sender(sid).await {
                                    sender_tx.send_raw(data).await;
                                }
                            } else if voice_target >= 1 && voice_target <= 30 {
                                // Whisper/voice target: route to configured sessions/channels
                                let vt_config = {
                                    let cache = edge_state.voice_targets.read().await;
                                    cache.get(&sid).and_then(|m| m.get(&voice_target)).cloned()
                                };
                                if let Some(vt) = vt_config {
                                    let mut target_sessions: std::collections::HashSet<u32> = std::collections::HashSet::new();
                                    // Direct session targets
                                    for s in &vt.sessions {
                                        target_sessions.insert(*s);
                                    }
                                    // Channel targets: collect local sessions AND track remote channels
                                    let mut channel_target_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
                                    for ch_cfg in &vt.channels {
                                        let mut ch_ids = std::collections::HashSet::new();
                                        ch_ids.insert(ch_cfg.channel_id);
                                        if ch_cfg.links {
                                            let linked = edge_state.channel_manager.get_all_linked_channels(ch_cfg.channel_id).await;
                                            ch_ids.extend(linked);
                                        }
                                        if ch_cfg.children {
                                            fn collect_children(
                                                ch_id: u32,
                                                ch_ids: &mut std::collections::HashSet<u32>,
                                                children_map: &std::collections::HashMap<u32, Vec<u32>>,
                                            ) {
                                                if let Some(children) = children_map.get(&ch_id) {
                                                    for &child in children {
                                                        if ch_ids.insert(child) {
                                                            collect_children(child, ch_ids, children_map);
                                                        }
                                                    }
                                                }
                                            }
                                            let children_map = edge_state.channel_manager.get_all_children_map().await;
                                            collect_children(ch_cfg.channel_id, &mut ch_ids, &children_map);
                                        }
                                        channel_target_ids.extend(&ch_ids);
                                        for ch_id in ch_ids {
                                            let local_sessions = edge_state.client_manager.get_channel_sessions(ch_id).await;
                                            for s in local_sessions {
                                                if s != sid {
                                                    target_sessions.insert(s);
                                                }
                                            }
                                        }
                                    }
                                    // Build frame with sender session injected
                                    let forwarded = inject_session_into_voice(&frame.payload, sid);
                                    let mut buf = BytesMut::new();
                                    bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
                                    bytes::BufMut::put_u32(&mut buf, forwarded.len() as u32);
                                    bytes::BufMut::put_slice(&mut buf, &forwarded);
                                    // Wrap in Arc to share the frame buffer across target senders
                                    // without per-target heap allocation.
                                    let data = std::sync::Arc::new(buf.to_vec());
                                    // Send to local targets
                                    for target_session in &target_sessions {
                                        if let Some(target_client) = edge_state.client_manager.get_client(*target_session).await {
                                            if !target_client.deaf && !target_client.self_deaf {
                                                if let Some(sender) = edge_state.client_manager.get_sender(*target_session).await {
                                                    sender.send_raw((*data).clone()).await;
                                                }
                                            }
                                        }
                                    }
                                    // Send to remote edges via Hub relay
                                    // For session targets: relay those specific sessions
                                    // For channel targets: also relay to remote users in those channels
                                    let local_edge_id = edge_state.get_edge_id();
                                    let remote_users = edge_state.channel_manager.get_all_remote_users().await;
                                    let mut by_edge: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
                                    for ru in &remote_users {
                                        if ru.deaf || ru.self_deaf { continue; }
                                        if local_edge_id != 0 && ru.edge_id == local_edge_id { continue; }
                                        let in_session_target = target_sessions.contains(&ru.session_id);
                                        let in_channel_target = !channel_target_ids.is_empty() && channel_target_ids.contains(&ru.channel_id);
                                        if in_session_target || in_channel_target {
                                            by_edge.entry(ru.edge_id).or_default().push(ru.session_id);
                                        }
                                    }
                                    for (target_edge_id, _sessions_on_edge) in by_edge {
                                        // Relay format: standard Mumble server-to-client packet
                                        // [header][session_varint][seq][voice_data]
                                        // (matches TS hub relay format)
                                        let relay_payload = inject_session_into_voice(&frame.payload, sid);
                                        if edge_state.allow_hub_relay {
                                            hub_client.relay_voice_via_hub(target_edge_id, relay_payload).await;
                                        }
                                    }
                                }
                            } else {
                                // Normal broadcast (target=0): route to same channel + linked channels
                                let linked_channels = edge_state.channel_manager
                                    .get_all_linked_channels(client.channel_id)
                                    .await;

                                // Build frame once with sender session injected
                                let forwarded = inject_session_into_voice(&frame.payload, sid);
                                let mut buf = BytesMut::new();
                                bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
                                bytes::BufMut::put_u32(&mut buf, forwarded.len() as u32);
                                bytes::BufMut::put_slice(&mut buf, &forwarded);
                                // Wrap in Arc to share the frame buffer across target senders
                                // without per-target heap allocation.
                                let data = std::sync::Arc::new(buf.to_vec());

                                // Local clients in all linked channels
                                for ch_id in &linked_channels {
                                    let sessions = edge_state.client_manager.get_channel_sessions(*ch_id).await;
                                    for target_session in sessions {
                                        if target_session == sid {
                                            continue;
                                        }
                                        if let Some(target_client) = edge_state.client_manager.get_client(target_session).await {
                                            if target_client.deaf || target_client.self_deaf {
                                                continue;
                                            }
                                        }
                                        if let Some(sender) = edge_state.client_manager.get_sender(target_session).await {
                                            sender.send_raw((*data).clone()).await;
                                        }
                                    }
                                }

                                // Remote users (other edges) in any linked channel
                                let local_edge_id = edge_state.get_edge_id();
                                let remote_users = edge_state.channel_manager
                                    .get_remote_users_in_channels(&linked_channels)
                                    .await;
                                let mut by_edge: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
                                for ru in &remote_users {
                                    if !ru.deaf && !ru.self_deaf {
                                        if local_edge_id != 0 && ru.edge_id == local_edge_id { continue; }
                                        by_edge.insert(ru.edge_id, true);
                                    }
                                }
                                for target_edge_id in by_edge.into_keys() {
                                    debug!("edge={:?} TCP voice: relaying broadcast from session {} to edge {}", local_edge_id, sid, target_edge_id);
                                    // Relay format: standard Mumble server-to-client packet
                                    // [header][session_varint][seq][voice_data]
                                    let relay_payload = inject_session_into_voice(&frame.payload, sid);
                                    if edge_state.allow_hub_relay {
                                        hub_client.relay_voice_via_hub(target_edge_id, relay_payload).await;
                                    }
                                }
                            }
                        }
                    }
                }
                MessageType::VoiceTarget if client_state == ClientState::Ready => {
                    let Ok(vt) = mumbleproto::VoiceTarget::decode(&frame.payload[..]) else { continue; };
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

                            // Cache voice target locally for routing
                            {
                                use crate::state::{VoiceTargetChannelConfig, VoiceTargetConfig};
                                use std::collections::HashMap;
                                let mut vt_cache = edge_state.voice_targets.write().await;
                                let session_vts = vt_cache.entry(sid).or_insert_with(HashMap::new);
                                if vt.targets.is_empty() {
                                    session_vts.remove(&(target_id as u32));
                                } else {
                                    let mut vt_sessions = Vec::new();
                                    let mut vt_channels = Vec::new();
                                    for target in &vt.targets {
                                        for &s in &target.session {
                                            vt_sessions.push(s);
                                        }
                                        if let Some(ch_id) = target.channel_id {
                                            vt_channels.push(VoiceTargetChannelConfig {
                                                channel_id: ch_id,
                                                links: target.links.unwrap_or(false),
                                                children: target.children.unwrap_or(false),
                                                group: target.group.clone(),
                                            });
                                        }
                                    }
                                    session_vts.insert(target_id as u32, VoiceTargetConfig { sessions: vt_sessions, channels: vt_channels });
                                }
                            }

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
                    let Ok(stats) = mumbleproto::UserStats::decode(&frame.payload[..]) else { continue; };
                    if let Some(requester_sid) = session_id {
                        debug!("UserStats request for session {:?}", stats.session);
                        if let Some(target_session) = stats.session {
                            if let Some(target) = edge_state.client_manager.get_client(target_session).await {
                                // Fetch real crypto stats
                                let (good, late, lost, resync) =
                                    if let Some(cs) = edge_state.client_manager.get_crypt_state(target_session).await {
                                        let s = cs.lock().unwrap();
                                        (s.good, s.late, s.lost, s.resync)
                                    } else {
                                        (0, 0, 0, 0)
                                    };

                                let onlinesecs = target.connected_at.elapsed().as_secs() as u32;
                                let idlesecs = target.last_active.elapsed().as_secs() as u32;

                                // Encode IP address as bytes (IPv4 4 bytes, IPv6 16 bytes)
                                let addr_bytes = encode_ip_address(&target.ip_address);

                                let is_stats_only = stats.stats_only.unwrap_or(false);

                                let response = if is_stats_only {
                                    // stats_only=true: return only mutable stats, no certs/address
                                    mumbleproto::UserStats {
                                        session: Some(target_session),
                                        stats_only: Some(true),
                                        from_client: Some(mumbleproto::user_stats::Stats {
                                            good: Some(good),
                                            late: Some(late),
                                            lost: Some(lost),
                                            resync: Some(resync),
                                        }),
                                        from_server: Some(mumbleproto::user_stats::Stats {
                                            good: Some(good),
                                            late: Some(late),
                                            lost: Some(lost),
                                            resync: Some(resync),
                                        }),
                                        onlinesecs: Some(onlinesecs),
                                        idlesecs: Some(idlesecs),
                                        ..Default::default()
                                    }
                                } else {
                                    mumbleproto::UserStats {
                                        session: Some(target_session),
                                        stats_only: Some(false),
                                        from_client: Some(mumbleproto::user_stats::Stats {
                                            good: Some(good),
                                            late: Some(late),
                                            lost: Some(lost),
                                            resync: Some(resync),
                                        }),
                                        from_server: Some(mumbleproto::user_stats::Stats {
                                            good: Some(good),
                                            late: Some(late),
                                            lost: Some(lost),
                                            resync: Some(resync),
                                        }),
                                        address: Some(addr_bytes),
                                        onlinesecs: Some(onlinesecs),
                                        idlesecs: Some(idlesecs),
                                        opus: Some(target.opus_supported),
                                        strong_certificate: Some(target.cert_hash.is_some()),
                                        celt_versions: vec![-2147483637], // CELT 0.7.0 (Mumble standard)
                                        ..Default::default()
                                    }
                                };
                                client_sender.send_message(MessageType::UserStats, &response).await;
                            }
                        }
                        let _ = requester_sid;
                    }
                }
                MessageType::PermissionQuery if client_state == ClientState::Ready => {
                    let Ok(pq) = mumbleproto::PermissionQuery::decode(&frame.payload[..]) else { continue; };
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
                    // Client sending updated nonce for CryptSetup resync
                    let Ok(crypt) = mumbleproto::CryptSetup::decode(&frame.payload[..]) else { continue; };
                    debug!("CryptSetup resync from {}: has_client_nonce={}", peer_addr, crypt.client_nonce.is_some());
                    if let Some(sid) = session_id {
                        // Update decrypt IV if client provided their new nonce
                        if let Some(ref nonce_vec) = crypt.client_nonce {
                            if nonce_vec.len() == 16 {
                                let nonce: [u8; 16] = nonce_vec.as_slice().try_into().unwrap();
                                edge_state.client_manager.update_decrypt_iv(sid, &nonce).await;
                            }
                        }
                        // Respond with current server nonce
                        let server_nonce = edge_state.client_manager.get_encrypt_iv(sid).await;
                        let response = mumbleproto::CryptSetup {
                            key: None,
                            client_nonce: None,
                            server_nonce,
                        };
                        client_sender.send_message(MessageType::CryptSetup, &response).await;
                    }
                }
                MessageType::UserRemove if client_state == ClientState::Ready => {
                    // User-initiated kick/ban - forward to Hub
                    let Ok(user_remove) = mumbleproto::UserRemove::decode(&frame.payload[..]) else { continue; };
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
                    let Ok(ch_state) = mumbleproto::ChannelState::decode(&frame.payload[..]) else { continue; };
                    debug!("ChannelState from {}: channel_id={:?}, name={:?}", peer_addr, ch_state.channel_id, ch_state.name);

                    let hub = hub_client.clone();
                    let has_links = !ch_state.links_add.is_empty() || !ch_state.links_remove.is_empty();
                    if has_links {
                        // Link/unlink request - send via notification
                        if let Some(ch_id) = ch_state.channel_id {
                            hub.notify_channel_state(ch_id, ch_state.links_add, ch_state.links_remove).await;
                        }
                    } else {
                        tokio::spawn(async move {
                            if let Err(e) = hub.save_channel(
                                ch_state.channel_id,
                                ch_state.parent,
                                ch_state.name.as_deref(),
                                ch_state.description.as_deref(),
                                ch_state.position,
                                ch_state.max_users,
                            ).await {
                                warn!("Failed to forward ChannelState to Hub: {}", e);
                            }
                        });
                    }
                }
                MessageType::ChannelRemove if client_state == ClientState::Ready => {
                    // Client requesting channel removal - forward to Hub
                    let Ok(ch_remove) = mumbleproto::ChannelRemove::decode(&frame.payload[..]) else { continue; };
                    debug!("ChannelRemove from {}: channel_id={}", peer_addr, ch_remove.channel_id);

                    let hub = hub_client.clone();
                    tokio::spawn(async move {
                        hub.notify_channel_remove(ch_remove.channel_id).await;
                    });
                }
                MessageType::BanList if client_state == ClientState::Ready => {
                    // BanList query/update - forward to Hub
                    let Ok(ban_list) = mumbleproto::BanList::decode(&frame.payload[..]) else { continue; };
                    debug!("BanList from {}: query={:?}, {} entries", peer_addr, ban_list.query, ban_list.bans.len());
                    if ban_list.query.unwrap_or(false) {
                        // Check admin (Write) permission on root channel
                        let sid = session_id.unwrap_or(0);
                        let is_admin = match hub_client.handle_permission_query(sid, 0).await {
                            Ok(r) => r.permissions.map(|p| p & perm::WRITE != 0).unwrap_or(false),
                            Err(_) => false,
                        };
                        if !is_admin {
                            let pq = mumbleproto::PermissionDenied {
                                r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                channel_id: Some(0),
                                ..Default::default()
                            };
                            client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                        } else {
                        // Query: fetch ban list from Hub
                        let hub = hub_client.clone();
                        let sender = client_sender.clone();
                        tokio::spawn(async move {
                            if let Some(raw_data) = hub.rpc_get_ban_list().await {
                                if let Ok(ban_resp) = mumbleproto::BanList::decode(raw_data.as_slice()) {
                                    sender.send_message(MessageType::BanList, &ban_resp).await;
                                }
                            }
                        });
                        }
                    } else {
                        // Update: forward ban list to Hub
                        let raw = frame.payload.to_vec();
                        let hub = hub_client.clone();
                        tokio::spawn(async move {
                            hub.rpc_update_ban_list(&raw).await;
                        });
                    }
                }
                MessageType::Acl if client_state == ClientState::Ready => {
                    // ACL query/update - forward to Hub
                    let Ok(acl_msg) = mumbleproto::Acl::decode(&frame.payload[..]) else { continue; };
                    let is_query = acl_msg.query.unwrap_or(false);
                    debug!("ACL from {}: channel_id={}, query={}", peer_addr, acl_msg.channel_id, is_query);

                    let hub = hub_client.clone();
                    let sender = client_sender.clone();
                    let raw = frame.payload.to_vec();
                    let sid = session_id.unwrap_or(0);
                    let client_info = edge_state.client_manager.get_client(sid).await;
                    let uid = client_info.as_ref().map(|c| c.user_id).unwrap_or(0);
                    let uname = client_info.as_ref().map(|c| c.username.clone()).unwrap_or_default();
                    let ch_id = acl_msg.channel_id;
                    tokio::spawn(async move {
                        if let Some(raw_data) = hub.rpc_handle_acl(sid, uid, &uname, ch_id, is_query, &raw).await {
                            if let Ok(acl_resp) = mumbleproto::Acl::decode(raw_data.as_slice()) {
                                sender.send_message(MessageType::Acl, &acl_resp).await;
                            }
                        }
                    });
                }
                MessageType::PluginDataTransmission if client_state == ClientState::Ready => {
                    // Plugin data forwarding
                    let Ok(plugin) = mumbleproto::PluginDataTransmission::decode(&frame.payload[..]) else { continue; };
                    debug!("PluginData from {}: dataId={:?}", peer_addr, plugin.data_id);

                    // Enforce plugin message size limit
                    let plugin_limit = config.server.plugin_message_length;
                    let plugin_data_len = plugin.data.as_deref().map(|d| d.len()).unwrap_or(0) as u32;
                    if plugin_limit > 0 && plugin_data_len > plugin_limit {
                        debug!("PluginData from {} exceeds limit ({} > {})", peer_addr, plugin_data_len, plugin_limit);
                        // Silently drop oversized plugin messages (no PermissionDenied per Mumble protocol convention)
                        continue;
                    }

                    let hub = hub_client.clone();
                    let sid = session_id.unwrap_or(0);
                    let client_info = edge_state.client_manager.get_client(sid).await;
                    let uname = client_info.as_ref().map(|c| c.username.clone()).unwrap_or_default();
                    let edge_state_clone = edge_state.clone();
                    tokio::spawn(async move {
                        let data_bytes = plugin.data.clone().unwrap_or_default();
                        let data_id_str = plugin.data_id.clone().unwrap_or_default();

                        // Forward to Hub for cross-edge routing
                        hub.notify_plugin_data(
                            sid, &uname,
                            &data_id_str,
                            &data_bytes,
                            &plugin.receiver_sessions,
                        ).await;

                        // Also deliver locally to targeted sessions on this edge
                        if plugin.receiver_sessions.is_empty() {
                            // Broadcast: deliver to all local authenticated clients except sender
                            let all_clients = edge_state_clone.client_manager.get_all_clients().await;
                            for client in all_clients {
                                if client.session == sid { continue; }
                                let fwd = mumbleproto::PluginDataTransmission {
                                    sender_session: Some(sid),
                                    data_id: plugin.data_id.clone(),
                                    data: Some(data_bytes.clone()),
                                    receiver_sessions: vec![],
                                };
                                edge_state_clone.client_manager.send_to(
                                    client.session, MessageType::PluginDataTransmission, &fwd
                                ).await;
                            }
                        } else {
                            for &target_session in &plugin.receiver_sessions {
                                let fwd = mumbleproto::PluginDataTransmission {
                                    sender_session: Some(sid),
                                    data_id: plugin.data_id.clone(),
                                    data: Some(data_bytes.clone()),
                                    receiver_sessions: vec![target_session],
                                };
                                edge_state_clone.client_manager.send_to(
                                    target_session, MessageType::PluginDataTransmission, &fwd
                                ).await;
                            }
                        }
                    });
                }
                MessageType::QueryUsers if client_state == ClientState::Ready => {
                    let Ok(query) = mumbleproto::QueryUsers::decode(&frame.payload[..]) else { continue; };
                    debug!("QueryUsers from {}: ids={:?}, names={:?}", peer_addr, query.ids, query.names);
                    // Return matching users from local clients (deduplicated)
                    let mut result_ids = Vec::new();
                    let mut result_names = Vec::new();
                    let mut seen = std::collections::HashSet::new();
                    let all_clients = edge_state.client_manager.get_all_clients().await;
                    for req_id in &query.ids {
                        if let Some(client) = all_clients.iter().find(|c| c.user_id == *req_id) {
                            if seen.insert(client.user_id) {
                                result_ids.push(client.user_id);
                                result_names.push(client.username.clone());
                            }
                        }
                    }
                    for req_name in &query.names {
                        if let Some(client) = all_clients.iter().find(|c| c.username == *req_name) {
                            if seen.insert(client.user_id) {
                                result_ids.push(client.user_id);
                                result_names.push(client.username.clone());
                            }
                        }
                    }
                    let response = mumbleproto::QueryUsers {
                        ids: result_ids,
                        names: result_names,
                    };
                    client_sender.send_message(MessageType::QueryUsers, &response).await;
                }
                MessageType::RequestBlob if client_state == ClientState::Ready => {
                    // RequestBlob - request for user textures/comments or channel descriptions
                    let Ok(blob) = mumbleproto::RequestBlob::decode(&frame.payload[..]) else { continue; };
                    debug!("RequestBlob from {}: session_textures={:?}, session_comments={:?}, channel_descriptions={:?}",
                           peer_addr, blob.session_texture, blob.session_comment, blob.channel_description);
                    // Send empty responses for channel descriptions that were requested
                    for &channel_id in &blob.channel_description {
                        if let Some(ch) = edge_state.channel_manager.get_channel(channel_id).await {
                            if let Some(desc) = &ch.description {
                                if !desc.is_empty() {
                                    let msg = mumbleproto::ChannelState {
                                        channel_id: Some(channel_id),
                                        description: Some(desc.clone()),
                                        ..Default::default()
                                    };
                                    client_sender.send_message(MessageType::ChannelState, &msg).await;
                                }
                            }
                        }
                    }
                    // Send user texture blobs
                    for &target_session in &blob.session_texture {
                        if let Some(target_client) = edge_state.client_manager.get_client(target_session).await {
                            if target_client.user_id > 0 {
                                if let Some((_hash, data)) = hub_client.blob_get_user_texture(target_client.user_id).await {
                                    let msg = mumbleproto::UserState {
                                        session: Some(target_session),
                                        texture: Some(data),
                                        ..Default::default()
                                    };
                                    client_sender.send_message(MessageType::UserState, &msg).await;
                                }
                            }
                        }
                    }
                    // Send user comment blobs
                    for &target_session in &blob.session_comment {
                        if let Some(target_client) = edge_state.client_manager.get_client(target_session).await {
                            if target_client.user_id > 0 {
                                if let Some((_hash, data)) = hub_client.blob_get_user_comment(target_client.user_id).await {
                                    if let Ok(comment_str) = String::from_utf8(data) {
                                        let msg = mumbleproto::UserState {
                                            session: Some(target_session),
                                            comment: Some(comment_str),
                                            ..Default::default()
                                        };
                                        client_sender.send_message(MessageType::UserState, &msg).await;
                                    }
                                }
                            }
                        }
                    }
                }
                MessageType::UserList if client_state == ClientState::Ready => {
                    let Ok(msg) = mumbleproto::UserList::decode(&frame.payload[..]) else { continue; };
                    if msg.users.is_empty() {
                        // Query: send full registered user list from Hub
                        if let Some(raw) = hub_client.rpc_get_user_list().await {
                            if let Ok(user_list) = mumbleproto::UserList::decode(raw.as_slice()) {
                                client_sender.send_message(MessageType::UserList, &user_list).await;
                            }
                        }
                    } else {
                        // Update: forward to Hub (Hub enforces permissions server-side)
                        use prost::Message as _;
                        hub_client.rpc_update_user_list(&msg.encode_to_vec()).await;
                    }
                }
                MessageType::CodecVersion if client_state == ClientState::Ready => {
                    let Ok(cv) = mumbleproto::CodecVersion::decode(&frame.payload[..]) else { continue; };
                    if let Some(sid) = session_id {
                        // Update client's codec capability
                        if let Some(mut c) = edge_state.client_manager.get_client(sid).await {
                            c.opus_supported = cv.opus.unwrap_or(false);
                            edge_state.client_manager.update_client(c).await;
                        }
                        // Recompute and broadcast global codec preference
                        broadcast_codec_version(&edge_state).await;
                    }
                }
                other => {
                    debug!("Unhandled message type {:?} from {} (state={:?})", other, peer_addr, client_state);
                }            }
        }
    }

    // Cleanup
    if let Some(sid) = session_id {
        edge_state.client_manager.remove_client(sid).await;
        // Clean up ninja channel permission cache for this session
        edge_state.ninja_visible_to.write().await.remove(&sid);

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
    let mut suppress_changed = false;

    if let Some(mut client) = edge_state.client_manager.get_client(session_id).await {
        // 9.1 Channel move with permission check
        if let Some(target_channel_id) = user_state.channel_id {
            if client.channel_id != target_channel_id {
                // Check Enter permission on target channel via Hub
                let can_enter = match hub_client.handle_permission_query(session_id, target_channel_id).await {
                    Ok(r) => r.permissions.map(|p| p & perm::ENTER != 0).unwrap_or(true),
                    Err(_) => true, // Fail open if Hub unreachable
                };
                if can_enter {
                    // Check channel user limit (max_users from channel config)
                    let channel_full = if let Some(ch) = edge_state.channel_manager.get_channel(target_channel_id).await {
                        if ch.max_users > 0 {
                            let user_count = edge_state.client_manager.count_in_channel(target_channel_id).await;
                            user_count >= ch.max_users
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if channel_full {
                        debug!("Channel {} is full, denying move for session {}", target_channel_id, session_id);
                        if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                            let pq = mumbleproto::PermissionDenied {
                                r#type: Some(mumbleproto::permission_denied::DenyType::ChannelFull as i32),
                                channel_id: Some(target_channel_id),
                                reason: Some("Channel is full".to_string()),
                                ..Default::default()
                            };
                            sender.send_message(MessageType::PermissionDenied, &pq).await;
                        }
                        return;
                    }
                    debug!("User {} moving to channel {}", session_id, target_channel_id);
                    let saved_crypt = edge_state.client_manager.get_crypt_state(session_id).await;
                    let sender = edge_state.client_manager.get_sender(session_id).await;
                    edge_state.client_manager.remove_client(session_id).await;
                    client.channel_id = target_channel_id;
                    // Check Speak permission; suppress the user if they can't speak in the new channel
                    let can_speak = match hub_client.handle_permission_query(session_id, target_channel_id).await {
                        Ok(r) => r.permissions.map(|p| p & perm::SPEAK != 0).unwrap_or(true),
                        Err(_) => true,
                    };
                    let new_suppress = !can_speak;
                    suppress_changed = new_suppress != client.suppress;
                    client.suppress = new_suppress;
                    if let Some(sender) = sender {
                        edge_state.client_manager.add_client(client.clone(), sender).await;
                    }
                    // Preserve the UDP CryptState across the channel move so voice
                    // continues to work after the user returns to any channel.
                    if let Some(cs_arc) = saved_crypt {
                        edge_state.client_manager.restore_crypt_state(session_id, cs_arc).await;
                    }
                    needs_broadcast = true;
                    channel_moved = true;
                } else {
                    debug!("Channel move denied for session {} → channel {} (no Enter permission)", session_id, target_channel_id);
                    // Send permission denied back to client
                    if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                            channel_id: Some(target_channel_id),
                            ..Default::default()
                        };
                        sender.send_message(MessageType::PermissionDenied, &pq).await;
                    }
                    return;
                }
            }
        }

        // Self-deaf update: self_deaf=true implies self_mute=true (Mumble protocol coupling).
        if let Some(self_deaf) = user_state.self_deaf {
            client.self_deaf = self_deaf;
            if self_deaf {
                client.self_mute = true; // deaf always implies mute
            }
            needs_broadcast = true;
        }
        // Self-mute update: self_mute=false implies self_deaf=false.
        if let Some(self_mute) = user_state.self_mute {
            client.self_mute = self_mute;
            if !self_mute {
                client.self_deaf = false; // un-muting also clears deaf
            }
            needs_broadcast = true;
        }

        // 9.2 mute/deaf/suppress/priority_speaker are SERVER-ADMIN-only fields.
        // Per Murmur (Messages.cpp msgUserState), modifying these requires the
        // MuteDeafen ACL permission.  A client targeting its own session that
        // sends these fields (e.g. as part of its initial resumption state on
        // connect) must have that permission; regular users do not, so we
        // silently ignore them here.  Legitimate admin operations arrive through
        // handle_admin_user_state_update which carries proper permission checks.
        // Accepting these fields here would let a Mumble client trigger
        // spurious "Server opened mic/speaker" notifications on every connect.

        // 9.3 Recording flag (anyone can mark themselves as recording).
        // Only broadcast when the value actually changed — Murmur only sets
        // bBroadcast if `pDstServerUser->bRecording != msg.recording()`, so
        // a client resending `recording=false` on connect should NOT generate
        // a "User stopped recording" notification on other clients.
        if let Some(rec) = user_state.recording {
            if rec != client.recording {
                client.recording = rec;
                needs_broadcast = true;
            }
        }

        // 9.4 Listening channel add/remove
        let mut actually_added_channels: Vec<u32> = Vec::new();
        if !user_state.listening_channel_add.is_empty() || !user_state.listening_channel_remove.is_empty() {
            for &ch in &user_state.listening_channel_add {
                // Check per-user listener limit
                let per_user_limit = edge_state.listeners_per_user;
                if per_user_limit > 0 && client.listening_channels.len() as u32 >= per_user_limit {
                    debug!("Listener limit ({}) reached for session {}", per_user_limit, session_id);
                    if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(mumbleproto::permission_denied::DenyType::ChannelFull as i32),
                            channel_id: Some(ch),
                            reason: Some(format!(
                                "Listener limit reached: you may listen to at most {} channel(s) simultaneously",
                                per_user_limit
                            )),
                            ..Default::default()
                        };
                        sender.send_message(MessageType::PermissionDenied, &pq).await;
                    }
                    continue;
                }

                // Check per-channel listener limit
                let per_channel_limit = edge_state.listeners_per_channel;
                if per_channel_limit > 0 {
                    let listener_count = edge_state.client_manager
                        .get_listening_count(ch)
                        .await;
                    if listener_count >= per_channel_limit {
                        debug!("Channel {} listener limit ({}) reached", ch, per_channel_limit);
                        if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                            let pq = mumbleproto::PermissionDenied {
                                r#type: Some(mumbleproto::permission_denied::DenyType::ChannelFull as i32),
                                channel_id: Some(ch),
                                reason: Some(format!(
                                    "Channel listener limit reached: this channel allows at most {} listener(s)",
                                    per_channel_limit
                                )),
                                ..Default::default()
                            };
                            sender.send_message(MessageType::PermissionDenied, &pq).await;
                        }
                        continue;
                    }
                }

                // Check Listen permission (0x800) before adding
                let can_listen = match hub_client.handle_permission_query(session_id, ch).await {
                    Ok(r) => r.permissions.map(|p| p & perm::LISTEN != 0).unwrap_or(true),
                    Err(_) => true,
                };
                if !can_listen {
                    debug!("Listen denied for session {} on channel {}", session_id, ch);
                    if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                            channel_id: Some(ch),
                            ..Default::default()
                        };
                        sender.send_message(MessageType::PermissionDenied, &pq).await;
                    }
                    continue;
                }
                if !client.listening_channels.contains(&ch) {
                    client.listening_channels.push(ch);
                    actually_added_channels.push(ch);
                }
            }
            client.listening_channels.retain(|ch| !user_state.listening_channel_remove.contains(ch));
            // Remove volume adjustments for channels that were removed
            for &ch in &user_state.listening_channel_remove {
                client.listening_volume_adjustments.remove(&ch);
            }
            needs_broadcast = true;
        }

        // Volume adjustments for listened channels
        if !user_state.listening_volume_adjustment.is_empty() {
            for va in &user_state.listening_volume_adjustment {
                if let (Some(ch), Some(vol)) = (va.listening_channel, va.volume_adjustment) {
                    if vol == 1.0 {
                        client.listening_volume_adjustments.remove(&ch);
                    } else {
                        client.listening_volume_adjustments.insert(ch, vol);
                    }
                }
            }
            needs_broadcast = true;
        }

        // Texture / comment blob updates (upload to Hub and broadcast hash to peers)
        if let Some(texture_data) = &user_state.texture {
            if !texture_data.is_empty() {
                let uid = client.user_id;
                let data = texture_data.clone();
                if let Some(hash_hex) = hub_client.blob_set_user_texture(uid, data).await {
                    // Convert hex hash to bytes for the Mumble texture_hash field
                    if let Some(hash_bytes) = hex_to_bytes(&hash_hex) {
                        // Broadcast the hash to all connected clients so they can
                        // request the texture via RequestBlob.
                        let hash_msg = mumbleproto::UserState {
                            session: Some(session_id),
                            actor: Some(session_id),
                            texture_hash: Some(hash_bytes.clone()),
                            ..Default::default()
                        };
                        client.texture_hash = Some(hash_bytes);
                        edge_state.client_manager.update_client(client.clone()).await;
                        edge_state.client_manager.broadcast(MessageType::UserState, &hash_msg, None).await;
                    }
                }
            }
        }
        if let Some(comment) = &user_state.comment {
            let uid = client.user_id;
            let data = comment.as_bytes().to_vec();
            let data_len = data.len();
            if let Some(hash_hex) = hub_client.blob_set_user_comment(uid, data).await {
                if let Some(hash_bytes) = hex_to_bytes(&hash_hex) {
                    // Only broadcast comment_hash for long comments (> 128 bytes),
                    // matching the Mumble protocol convention.  Short comments are
                    // sent inline (comment field) rather than by reference.
                    if data_len > 128 {
                        let hash_msg = mumbleproto::UserState {
                            session: Some(session_id),
                            actor: Some(session_id),
                            comment_hash: Some(hash_bytes.clone()),
                            ..Default::default()
                        };
                        client.comment_hash = Some(hash_bytes);
                        edge_state.client_manager.update_client(client.clone()).await;
                        edge_state.client_manager.broadcast(MessageType::UserState, &hash_msg, None).await;
                    }
                }
            }
        }

        if needs_broadcast {
            edge_state.client_manager.update_client(client.clone()).await;

            // Build a targeted state-change message containing ONLY the changed fields
            // with their ACTUAL boolean values (including `false`).
            //
            // Using build_user_state_msg() here would be wrong: it omits false-valued
            // fields (returns None), so observers can never learn about state transitions
            // like self_mute going true→false (un-mute).
            let mut broadcast_msg = mumbleproto::UserState {
                session: Some(session_id),
                actor:   Some(session_id),
                ..Default::default()
            };

            if channel_moved {
                broadcast_msg.channel_id = Some(client.channel_id);
                // Only include suppress when it actually changed to avoid spurious
                // "Server removed server mute" notifications when moving to a channel
                // where the user already had (or still has) speak permission.
                if suppress_changed {
                    broadcast_msg.suppress = Some(client.suppress);
                }
            }

            // Propagate self_deaf with coupling: self_deaf=true ⇒ self_mute=true.
            if let Some(sd) = user_state.self_deaf {
                broadcast_msg.self_deaf = Some(sd);
                if sd { broadcast_msg.self_mute = Some(true); }
            }
            // self_mute may override the coupling value set above;
            // self_mute=false ⇒ self_deaf=false as well.
            if let Some(sm) = user_state.self_mute {
                broadcast_msg.self_mute = Some(sm);
                if !sm { broadcast_msg.self_deaf = Some(false); }
            }

            // mute/deaf/priority_speaker are not processed here (admin-only).
            if let Some(v) = user_state.recording {
                // Only include recording in the broadcast when the value
                // actually changed (change detection already skips no-ops above).
                if broadcast_msg.recording.is_none() {
                    broadcast_msg.recording = Some(v);
                }
            }

            if !actually_added_channels.is_empty() {
                broadcast_msg.listening_channel_add = actually_added_channels.clone();
            }
            if !user_state.listening_channel_remove.is_empty() {
                broadcast_msg.listening_channel_remove = user_state.listening_channel_remove.clone();
            }
            if !user_state.listening_volume_adjustment.is_empty() {
                broadcast_msg.listening_volume_adjustment = user_state.listening_volume_adjustment.clone();
            }

            edge_state.client_manager.broadcast(MessageType::UserState, &broadcast_msg, None).await;

            // Notify Hub of the CHANGED fields only so that other edges stay in
            // sync.  Previously we sent the full current state on every update
            // which caused other edges to build a delta that included
            // Some(false) for every default-off field, triggering spurious
            // "Server opened mic/speaker" / "Server granted priority speaker"
            // notifications on their local clients.
            if channel_moved {
                hub_client.notify_user_moved(session_id, client.channel_id, session_id).await;
            } else {
                let listening_channel_add = if !broadcast_msg.listening_channel_add.is_empty() {
                    broadcast_msg.listening_channel_add.clone()
                } else { vec![] };
                let listening_channel_remove = if !broadcast_msg.listening_channel_remove.is_empty() {
                    broadcast_msg.listening_channel_remove.clone()
                } else { vec![] };
                if broadcast_msg.self_mute.is_some()
                    || broadcast_msg.self_deaf.is_some()
                    || broadcast_msg.mute.is_some()
                    || broadcast_msg.deaf.is_some()
                    || broadcast_msg.priority_speaker.is_some()
                    || broadcast_msg.recording.is_some()
                    || !listening_channel_add.is_empty()
                    || !listening_channel_remove.is_empty()
                    || !broadcast_msg.listening_volume_adjustment.is_empty()
                {
                    hub_client.notify_user_state_changed(
                        session_id,
                        broadcast_msg.self_mute,
                        broadcast_msg.self_deaf,
                        broadcast_msg.mute,
                        broadcast_msg.deaf,
                        None,  // suppress not changed here
                        broadcast_msg.priority_speaker,
                        broadcast_msg.recording,
                        listening_channel_add,
                        listening_channel_remove,
                    ).await;
                }
            }
        }
    }
}

/// Handle an admin UserState update (one user modifying another user's state).
/// Currently handles: mute/deaf, channel move (kick to channel).
async fn handle_admin_user_state_update(
    edge_state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
    actor_session: u32,
    target_session: u32,
    user_state: &mumbleproto::UserState,
) {
    if let Some(mut client) = edge_state.client_manager.get_client(target_session).await {
        let mut needs_broadcast = false;

        // Admin mute/deaf
        if let Some(mute) = user_state.mute {
            client.mute = mute;
            needs_broadcast = true;
        }
        if let Some(deaf) = user_state.deaf {
            client.deaf = deaf;
            needs_broadcast = true;
        }

        // Admin channel move (drag user to another channel)
        let mut channel_moved = false;
        let mut suppress_changed = false;
        if let Some(target_channel_id) = user_state.channel_id {
            if client.channel_id != target_channel_id {
                let saved_crypt = edge_state.client_manager.get_crypt_state(target_session).await;
                let sender = edge_state.client_manager.get_sender(target_session).await;
                edge_state.client_manager.remove_client(target_session).await;
                client.channel_id = target_channel_id;
                // Re-check suppress for the new channel
                let can_speak = match hub_client.handle_permission_query(target_session, target_channel_id).await {
                    Ok(r) => r.permissions.map(|p| p & perm::SPEAK != 0).unwrap_or(true),
                    Err(_) => true,
                };
                let new_suppress = !can_speak;
                suppress_changed = new_suppress != client.suppress;
                client.suppress = new_suppress;
                if let Some(sender) = sender {
                    edge_state.client_manager.add_client(client.clone(), sender).await;
                }
                // Preserve the UDP CryptState across the admin-initiated channel move.
                if let Some(cs_arc) = saved_crypt {
                    edge_state.client_manager.restore_crypt_state(target_session, cs_arc).await;
                }
                needs_broadcast = true;
                channel_moved = true;
            }
        }

        if needs_broadcast {
            edge_state.client_manager.update_client(client.clone()).await;
            // Build targeted message; only include fields that were actually changed,
            // with their real boolean values (including false) so clients can observe
            // state transitions (e.g., admin un-muting a user).
            let mut broadcast_msg = mumbleproto::UserState {
                session: Some(target_session),
                actor:   Some(actor_session),
                ..Default::default()
            };
            if channel_moved {
                broadcast_msg.channel_id = Some(client.channel_id);
                if suppress_changed {
                    broadcast_msg.suppress = Some(client.suppress);
                }
            }
            if let Some(v) = user_state.mute  { broadcast_msg.mute  = Some(v); }
            if let Some(v) = user_state.deaf  { broadcast_msg.deaf  = Some(v); }
            edge_state.client_manager.broadcast(MessageType::UserState, &broadcast_msg, None).await;
            if channel_moved {
                hub_client.notify_user_moved(target_session, client.channel_id, actor_session).await;
            } else {
                hub_client.notify_user_state_changed(
                    target_session,
                    None,
                    None,
                    broadcast_msg.mute,
                    broadcast_msg.deaf,
                    None,
                    None,
                    None,
                    vec![],
                    vec![],
                ).await;
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

/// Recompute global codec preference and broadcast CodecVersion to all clients.
/// Opus is preferred; fallback to CELT if any client doesn't support Opus.
async fn broadcast_codec_version(edge_state: &Arc<EdgeState>) {
    let all_clients = edge_state.client_manager.get_all_clients().await;
    let all_opus = all_clients.iter().all(|c| c.opus_supported);
    let msg = mumbleproto::CodecVersion {
        alpha: -2147483637, // CELT 0.7.0
        beta: 0,
        prefer_alpha: !all_opus,
        opus: Some(all_opus),
    };
    edge_state.client_manager.broadcast(MessageType::CodecVersion, &msg, None).await;
}

/// Decode a hex string into bytes.  Returns `None` if the string is not valid hex.
fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    bytes
}

/// Encode a u32 as a Mumble varint (NOT protobuf varint).
/// Mumble varint format: 0x00-0x7F = 1 byte, 0x80-0x3FFF = 2 bytes (10xxxxxx), etc.
fn encode_mumble_varint(value: u32) -> Vec<u8> {
    if value < 0x80 {
        vec![value as u8]
    } else if value < 0x4000 {
        vec![((value >> 8) | 0x80) as u8, (value & 0xFF) as u8]
    } else if value < 0x200000 {
        vec![((value >> 16) | 0xC0) as u8, ((value >> 8) & 0xFF) as u8, (value & 0xFF) as u8]
    } else {
        vec![0xF0, ((value >> 24) & 0xFF) as u8, ((value >> 16) & 0xFF) as u8, ((value >> 8) & 0xFF) as u8, (value & 0xFF) as u8]
    }
}

/// Decode a Mumble varint from a byte slice.
/// Returns (value, bytes_consumed) or None if insufficient data.
fn decode_mumble_varint(data: &[u8]) -> Option<(u32, usize)> {
    if data.is_empty() { return None; }
    let v = data[0];
    if (v & 0x80) == 0x00 {
        Some((v as u32, 1))
    } else if (v & 0xC0) == 0x80 {
        if data.len() < 2 { return None; }
        Some((((v & 0x3F) as u32) << 8 | data[1] as u32, 2))
    } else if (v & 0xE0) == 0xC0 {
        if data.len() < 3 { return None; }
        Some((((v & 0x1F) as u32) << 16 | (data[1] as u32) << 8 | data[2] as u32, 3))
    } else if (v & 0xF0) == 0xF0 {
        if data.len() < 5 { return None; }
        Some((
            ((data[1] as u32) << 24) | ((data[2] as u32) << 16) | ((data[3] as u32) << 8) | data[4] as u32,
            5,
        ))
    } else {
        None
    }
}

/// Inject sender session ID into a voice packet for forwarding.
/// Client sends: [header(1B)][sequence_varint][audio_data]
/// Server forwards: [header(1B)][sender_session_varint][sequence_varint][audio_data]
fn inject_session_into_voice(payload: &[u8], sender_session: u32) -> Vec<u8> {
    if payload.is_empty() {
        return Vec::new();
    }
    let header = payload[0];
    let session_varint = encode_mumble_varint(sender_session);
    let mut result = Vec::with_capacity(1 + session_varint.len() + payload.len() - 1);
    result.push(header);
    result.extend_from_slice(&session_varint);
    result.extend_from_slice(&payload[1..]);
    result
}

/// Encode an IP address string into bytes (4 bytes for IPv4, 16 bytes for IPv6).
fn encode_ip_address(addr: &str) -> Vec<u8> {
    if let Ok(ip) = addr.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => v4.octets().to_vec(),
            std::net::IpAddr::V6(v6) => v6.octets().to_vec(),
        }
    } else {
        // Fallback: encode as UTF-8 bytes
        addr.as_bytes().to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel_manager::ChannelManager;
    use crate::client::{ClientInfo, ClientManager, ClientSender, ClientState};
    use crate::hub_client::HubClient;
    use crate::state::EdgeState;
    use bytes::BytesMut;
    use munode_common::config::{
        EdgeConfig, HubServerConfig, NetworkConfig, ServerConfig, TlsConfig,
    };
    use munode_protocol::message_type::MessageType;
    use munode_protocol::mumbleproto;
    use munode_protocol::transport::decode_frame;
    use prost::Message;
    use tokio::sync::mpsc;

    /// Construct a minimal `EdgeConfig` suitable for unit tests.
    fn test_config() -> EdgeConfig {
        EdgeConfig {
            server_id: 1,
            name: "test".to_string(),
            network: NetworkConfig {
                host: "127.0.0.1".to_string(),
                port: 64738,
                edge_port: None,
                external_host: "127.0.0.1".to_string(),
                external_port: None,
                region: None,
            },
            tls: TlsConfig {
                cert: "test.pem".to_string(),
                key: "test.key".to_string(),
                ca: None,
            },
            hub_server: HubServerConfig {
                host: "localhost".to_string(),
                control_port: 8080,
                reconnect_interval: 5000,
                heartbeat_interval: 10000,
                hmac_secret: None,
                pool_size: 1,
                relay_port: 0,
                static_peers: vec![],
                tls: false,
            },
            server: ServerConfig::default(),
            voice_routing: munode_common::config::EdgeVoiceRoutingConfig::default(),
            log_level: "info".to_string(),
            log_format: "text".to_string(),
        }
    }

    /// Build a `ClientInfo` that is already in the `Ready` state.
    fn ready_client(session: u32, channel: u32) -> ClientInfo {
        ClientInfo {
            session,
            user_id: session,
            username: format!("user{}", session),
            channel_id: channel,
            state: ClientState::Ready,
            mute: false,
            deaf: false,
            suppress: false,
            self_mute: false,
            self_deaf: false,
            priority_speaker: false,
            recording: false,
            ip_address: "127.0.0.1".to_string(),
            connected_at: std::time::Instant::now(),
            last_active: std::time::Instant::now(),
            cert_hash: None,
            groups: vec![],
            opus_supported: true,
            listening_channels: vec![],
            listening_volume_adjustments: HashMap::new(),
            texture_hash: None,
            comment_hash: None,
        }
    }

    /// Decode the first Mumble frame from raw bytes and return the UserState message.
    fn decode_user_state(data: &[u8]) -> mumbleproto::UserState {
        let mut buf = BytesMut::from(data);
        let frame = decode_frame(&mut buf)
            .expect("decode_frame ok")
            .expect("frame present");
        assert_eq!(frame.message_type, MessageType::UserState, "expected UserState frame");
        mumbleproto::UserState::decode(&frame.payload[..]).expect("decode UserState")
    }

    /// Build a minimal `EdgeState` + disconnected `HubClient` for unit tests.
    /// The HubClient has no active WebSocket so Hub notifications are silently dropped.
    fn test_edge_and_hub() -> (Arc<EdgeState>, Arc<HubClient>) {
        let channel_manager = ChannelManager::new();
        let client_manager = ClientManager::new();
        let edge_state = EdgeState::new(channel_manager, client_manager, false);
        let hub_client = HubClient::new(&test_config(), edge_state.clone());
        (edge_state, hub_client)
    }

    // -----------------------------------------------------------------------
    // Test: user self-mutes – broadcast includes self_mute=Some(true)
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_self_mute_broadcast_to_self_and_others() {
        let (es, hub) = test_edge_and_hub();

        // Register two Ready clients.
        let (tx_a, mut rx_a) = mpsc::channel::<Vec<u8>>(16);
        let (tx_b, mut rx_b) = mpsc::channel::<Vec<u8>>(16);
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_a)).await;
        es.client_manager.add_client(ready_client(2, 0), ClientSender::new(tx_b)).await;

        // User 1 mutes themselves.
        let us = mumbleproto::UserState { session: Some(1), self_mute: Some(true), ..Default::default() };
        handle_user_state_update(&es, &hub, 1, &us).await;

        // Both clients must receive self_mute=true.
        let msg_a = decode_user_state(&rx_a.recv().await.unwrap());
        assert_eq!(msg_a.session, Some(1));
        assert_eq!(msg_a.self_mute, Some(true), "self: must see self_mute=true");

        let msg_b = decode_user_state(&rx_b.recv().await.unwrap());
        assert_eq!(msg_b.session, Some(1));
        assert_eq!(msg_b.self_mute, Some(true), "observer: must see self_mute=true");

        // Internal state must be updated.
        let c = es.client_manager.get_client(1).await.unwrap();
        assert!(c.self_mute);
        assert!(!c.self_deaf);
    }

    // -----------------------------------------------------------------------
    // Test: user un-mutes – broadcast must carry self_mute=Some(false), not None
    // This is the critical regression: build_user_state_msg previously emitted
    // None for false fields, making the un-mute invisible to observers.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_self_unmute_broadcast_carries_false() {
        let (es, hub) = test_edge_and_hub();

        let (tx_a, mut rx_a) = mpsc::channel::<Vec<u8>>(16);
        let (tx_b, mut rx_b) = mpsc::channel::<Vec<u8>>(16);
        // Start with user 1 already muted.
        let mut client1 = ready_client(1, 0);
        client1.self_mute = true;
        es.client_manager.add_client(client1, ClientSender::new(tx_a)).await;
        es.client_manager.add_client(ready_client(2, 0), ClientSender::new(tx_b)).await;

        // User 1 un-mutes.
        let us = mumbleproto::UserState { session: Some(1), self_mute: Some(false), ..Default::default() };
        handle_user_state_update(&es, &hub, 1, &us).await;

        // CRITICAL: un-mute must deliver self_mute=Some(false), NOT None.
        let msg_a = decode_user_state(&rx_a.recv().await.unwrap());
        assert_eq!(msg_a.self_mute, Some(false), "self: self_mute must be Some(false) on un-mute");
        // Un-muting also clears deaf (coupling).
        assert_eq!(msg_a.self_deaf, Some(false), "self: un-muting must also clear self_deaf");

        let msg_b = decode_user_state(&rx_b.recv().await.unwrap());
        assert_eq!(msg_b.self_mute, Some(false), "observer: self_mute must be Some(false) on un-mute");
        assert_eq!(msg_b.self_deaf, Some(false), "observer: un-muting must also clear self_deaf");

        let c = es.client_manager.get_client(1).await.unwrap();
        assert!(!c.self_mute);
        assert!(!c.self_deaf);
    }

    // -----------------------------------------------------------------------
    // Test: self_deaf=true must imply self_mute=true (Mumble protocol rule)
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_self_deaf_implies_self_mute() {
        let (es, hub) = test_edge_and_hub();

        let (tx_a, mut rx_a) = mpsc::channel::<Vec<u8>>(16);
        let (tx_b, mut rx_b) = mpsc::channel::<Vec<u8>>(16);
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_a)).await;
        es.client_manager.add_client(ready_client(2, 0), ClientSender::new(tx_b)).await;

        // Client only sends self_deaf=true; self_mute is absent in the message.
        let us = mumbleproto::UserState { session: Some(1), self_deaf: Some(true), ..Default::default() };
        handle_user_state_update(&es, &hub, 1, &us).await;

        let msg_a = decode_user_state(&rx_a.recv().await.unwrap());
        assert_eq!(msg_a.self_deaf, Some(true),  "self: self_deaf must be true");
        assert_eq!(msg_a.self_mute, Some(true),  "self: self_deaf=true must imply self_mute=true");

        let msg_b = decode_user_state(&rx_b.recv().await.unwrap());
        assert_eq!(msg_b.self_deaf, Some(true),  "observer: self_deaf must be true");
        assert_eq!(msg_b.self_mute, Some(true),  "observer: self_deaf=true must imply self_mute=true");

        let c = es.client_manager.get_client(1).await.unwrap();
        assert!(c.self_deaf);
        assert!(c.self_mute, "client.self_mute must be set when self_deaf=true");
    }

    // -----------------------------------------------------------------------
    // Test: un-deafening (self_deaf=false) alone does NOT clear self_mute
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_un_deaf_does_not_clear_self_mute() {
        let (es, hub) = test_edge_and_hub();

        let (tx_a, mut rx_a) = mpsc::channel::<Vec<u8>>(16);
        // Start with user 1 both muted and deafened.
        let mut c1 = ready_client(1, 0);
        c1.self_mute = true;
        c1.self_deaf = true;
        es.client_manager.add_client(c1, ClientSender::new(tx_a)).await;

        // Un-deafen only.
        let us = mumbleproto::UserState { session: Some(1), self_deaf: Some(false), ..Default::default() };
        handle_user_state_update(&es, &hub, 1, &us).await;

        let msg = decode_user_state(&rx_a.recv().await.unwrap());
        assert_eq!(msg.self_deaf, Some(false), "self_deaf must be false");
        // self_mute was NOT touched – field should be absent (None).
        assert_eq!(msg.self_mute, None, "un-deaf alone must not change self_mute");

        let c = es.client_manager.get_client(1).await.unwrap();
        assert!(!c.self_deaf);
        assert!(c.self_mute, "self_mute must remain true after un-deaf");
    }

    // -----------------------------------------------------------------------
    // Test: recording flag change broadcasts Some(false) on recording stop
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_recording_flag_false_is_broadcast() {
        let (es, hub) = test_edge_and_hub();

        let (tx_a, mut rx_a) = mpsc::channel::<Vec<u8>>(16);
        let mut c1 = ready_client(1, 0);
        c1.recording = true;
        es.client_manager.add_client(c1, ClientSender::new(tx_a)).await;

        let us = mumbleproto::UserState { session: Some(1), recording: Some(false), ..Default::default() };
        handle_user_state_update(&es, &hub, 1, &us).await;

        let msg = decode_user_state(&rx_a.recv().await.unwrap());
        assert_eq!(msg.recording, Some(false), "recording=false must be explicitly broadcast");
    }

    // -----------------------------------------------------------------------
    // Test: admin mute/unmute of another user
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_admin_mute_and_unmute_broadcast_false() {
        let (es, hub) = test_edge_and_hub();

        let (tx_admin, mut rx_admin) = mpsc::channel::<Vec<u8>>(16);
        let (tx_target, mut rx_target) = mpsc::channel::<Vec<u8>>(16);
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_admin)).await;
        let mut target = ready_client(2, 0);
        target.mute = true;
        es.client_manager.add_client(target, ClientSender::new(tx_target)).await;

        // Admin (session 1) un-mutes user 2.
        let us = mumbleproto::UserState {
            session: Some(2),
            mute: Some(false),
            ..Default::default()
        };
        handle_admin_user_state_update(&es, &hub, 1, 2, &us).await;

        // Both admin and target must receive mute=Some(false).
        let msg_admin = decode_user_state(&rx_admin.recv().await.unwrap());
        assert_eq!(msg_admin.session, Some(2));
        assert_eq!(msg_admin.actor,   Some(1), "actor must be set to admin session");
        assert_eq!(msg_admin.mute,    Some(false), "admin: mute=false must be explicit");

        let msg_target = decode_user_state(&rx_target.recv().await.unwrap());
        assert_eq!(msg_target.mute, Some(false), "target: mute=false must be explicit");

        let c = es.client_manager.get_client(2).await.unwrap();
        assert!(!c.mute);
    }

    // -----------------------------------------------------------------------
    // Helper: fire hub_event_listener as a background task.
    // Returns the EdgeState whose event channel we can emit into.
    async fn run_event_listener_task(es: Arc<EdgeState>) -> Arc<EdgeState> {
        let es2 = es.clone();
        tokio::spawn(async move {
            let mut rx = es2.subscribe_events();
            let (shutdown_tx, _shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
            hub_event_listener(es2, &mut rx, shutdown_tx).await;
        });
        // Give the background task a moment to subscribe before the first emit.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        es
    }

    // Helper: build a RemoteUser (all-false booleans, default state).
    fn remote_user(session: u32, channel: u32) -> crate::channel_manager::RemoteUser {
        crate::channel_manager::RemoteUser {
            session_id: session,
            edge_id: 99,
            user_id: session,
            username: format!("remote{}", session),
            channel_id: channel,
            cert_hash: None,
            groups: vec![],
            mute: false,
            deaf: false,
            suppress: false,
            self_mute: false,
            self_deaf: false,
            priority_speaker: false,
            recording: false,
            listening_channels: vec![],
        }
    }

    // -----------------------------------------------------------------------
    // Regression: when a normal (unmuted) user RECONNECTS, RemoteUserJoined
    // must NOT include Some(false) for any bool field. The Mumble client
    // interprets every present bool field as a change notification, so
    // omitting false values prevents spurious "userX unmuted / stopped
    // recording / ..." messages.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_remote_user_joined_no_false_booleans() {
        let (es, _hub) = test_edge_and_hub();

        // One local observer.
        let (tx_obs, mut rx_obs) = mpsc::channel::<Vec<u8>>(16);
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_obs)).await;

        // Remote user (all defaults – nothing true).
        es.channel_manager.upsert_remote_user(remote_user(10, 0)).await;
        let es = run_event_listener_task(es).await;

        es.emit(EdgeEvent::RemoteUserJoined {
            session_id: 10,
            username: "remote10".to_string(),
            channel_id: 0,
            is_ninja: false,
        });

        let msg = decode_user_state(&rx_obs.recv().await.expect("must receive join announcement"));
        assert_eq!(msg.session, Some(10));
        assert_eq!(msg.name.as_deref(), Some("remote10"), "name must be set");

        // All boolean fields must be ABSENT (None) – not Some(false).
        assert_eq!(msg.mute,             None, "mute must be absent for default-false user");
        assert_eq!(msg.deaf,             None, "deaf must be absent");
        assert_eq!(msg.suppress,         None, "suppress must be absent");
        assert_eq!(msg.self_mute,        None, "self_mute must be absent (prevents 'user unmuted' notification)");
        assert_eq!(msg.self_deaf,        None, "self_deaf must be absent");
        assert_eq!(msg.priority_speaker, None, "priority_speaker must be absent");
        assert_eq!(msg.recording,        None, "recording must be absent (prevents 'user stopped recording' notification)");
    }

    // -----------------------------------------------------------------------
    // When a remote user joins WITH some true flags, those flags MUST appear.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_remote_user_joined_true_flags_are_included() {
        let (es, _hub) = test_edge_and_hub();

        let (tx_obs, mut rx_obs) = mpsc::channel::<Vec<u8>>(16);
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_obs)).await;

        let mut ru = remote_user(11, 0);
        ru.self_mute = true;
        ru.recording = true;
        es.channel_manager.upsert_remote_user(ru).await;
        let es = run_event_listener_task(es).await;

        es.emit(EdgeEvent::RemoteUserJoined {
            session_id: 11,
            username: "remote11".to_string(),
            channel_id: 0,
            is_ninja: false,
        });

        let msg = decode_user_state(&rx_obs.recv().await.unwrap());
        assert_eq!(msg.self_mute, Some(true),  "self_mute=true must be present");
        assert_eq!(msg.recording, Some(true),  "recording=true must be present");
        assert_eq!(msg.self_deaf, None,         "unset flags must remain absent");
    }

    // -----------------------------------------------------------------------
    // Regression: RemoteUserStateChanged must only broadcast fields present
    // in the delta, not ALL current state. Broadcasting all state would send
    // Some(false) for every default-off field on every state update.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_remote_user_state_changed_only_broadcasts_delta() {
        use crate::state::RemoteUserStateDelta;

        let (es, _hub) = test_edge_and_hub();

        let (tx_obs, mut rx_obs) = mpsc::channel::<Vec<u8>>(16);
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_obs)).await;
        es.channel_manager.upsert_remote_user(remote_user(12, 0)).await;
        let es = run_event_listener_task(es).await;

        // Only self_mute changed – all other fields are absent in the delta.
        let delta = RemoteUserStateDelta {
            self_mute: Some(true),
            ..Default::default()
        };
        es.emit(EdgeEvent::RemoteUserStateChanged {
            session_id: 12,
            delta,
            listening_channel_add: vec![],
            listening_channel_remove: vec![],
        });

        let msg = decode_user_state(&rx_obs.recv().await.unwrap());
        assert_eq!(msg.session,   Some(12));
        assert_eq!(msg.self_mute, Some(true), "changed field must be included");
        // All unchanged fields must be absent (None) – not Some(false).
        assert_eq!(msg.self_deaf,        None, "unchanged self_deaf must be absent");
        assert_eq!(msg.mute,             None, "unchanged mute must be absent");
        assert_eq!(msg.deaf,             None, "unchanged deaf must be absent");
        assert_eq!(msg.recording,        None, "unchanged recording must be absent");
        assert_eq!(msg.priority_speaker, None, "unchanged priority_speaker must be absent");
    }

    // -----------------------------------------------------------------------
    // When delta un-mutes a remote user, Some(false) must propagate.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_remote_user_state_changed_unmute_carries_false() {
        use crate::state::RemoteUserStateDelta;

        let (es, _hub) = test_edge_and_hub();

        let (tx_obs, mut rx_obs) = mpsc::channel::<Vec<u8>>(16);
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_obs)).await;
        let mut ru = remote_user(13, 0);
        ru.self_mute = false; // now false after update
        es.channel_manager.upsert_remote_user(ru).await;
        let es = run_event_listener_task(es).await;

        let delta = RemoteUserStateDelta {
            self_mute: Some(false), // explicit false = "just un-muted"
            ..Default::default()
        };
        es.emit(EdgeEvent::RemoteUserStateChanged {
            session_id: 13,
            delta,
            listening_channel_add: vec![],
            listening_channel_remove: vec![],
        });

        let msg = decode_user_state(&rx_obs.recv().await.unwrap());
        assert_eq!(msg.self_mute, Some(false), "un-mute delta must carry Some(false)");
        // Other fields still absent.
        assert_eq!(msg.recording, None);
    }
}

/// Listen for events from the Hub and broadcast them to local clients.
async fn hub_event_listener(    state: Arc<EdgeState>,
    event_rx: &mut tokio::sync::broadcast::Receiver<EdgeEvent>,
    shutdown_tx: tokio::sync::mpsc::Sender<()>,
) {
    use tokio::sync::broadcast::error::RecvError;

    loop {
        match event_rx.recv().await {
            Ok(event) => {
                match event {
                    EdgeEvent::RemoteUserJoined { session_id, username, channel_id, is_ninja } => {
                        // Only broadcast for REMOTE users (not local clients - handled by main task)
                        if state.client_manager.get_client(session_id).await.is_none() {
                            if let Some(user) = state.channel_manager.get_remote_user(session_id).await {
                                // When announcing a newly-joined user we must NOT include Some(false)
                                // for boolean fields – the Mumble client interprets every present bool
                                // field as "this just changed to that value", triggering spurious
                                // notifications ("user unmuted", "user stopped recording", etc.).
                                // Only include a field when it is true (non-default).
                                // Also: only include user_id for registered users (user_id > 0);
                                // sending user_id=0 wrongly marks the guest as SuperUser.
                                let msg = mumbleproto::UserState {
                                    session: Some(user.session_id),
                                    user_id: if user.user_id > 0 { Some(user.user_id) } else { None },
                                    name: Some(user.username.clone()),
                                    channel_id: Some(user.channel_id),
                                    mute:             if user.mute             { Some(true) } else { None },
                                    deaf:             if user.deaf             { Some(true) } else { None },
                                    suppress:         if user.suppress         { Some(true) } else { None },
                                    self_mute:        if user.self_mute        { Some(true) } else { None },
                                    self_deaf:        if user.self_deaf        { Some(true) } else { None },
                                    priority_speaker: if user.priority_speaker { Some(true) } else { None },
                                    recording:        if user.recording        { Some(true) } else { None },
                                    hash: user.cert_hash.clone(),
                                    ..Default::default()
                                };
                                if is_ninja {
                                    // Channel Ninja: only send to clients who have Enter permission
                                    // Clients lacking both Enter+Listen permission won't see the user
                                    let local_clients = state.client_manager.get_all_clients().await;
                                    let visible_cache = state.ninja_visible_to.read().await;
                                    for client in local_clients {
                                        let can_see = visible_cache
                                            .get(&client.session)
                                            .map(|set| set.contains(&channel_id))
                                            .unwrap_or(false);
                                        if can_see {
                                            state.client_manager.send_to(client.session, MessageType::UserState, &msg).await;
                                        }
                                    }
                                } else {
                                    state.client_manager.broadcast(MessageType::UserState, &msg, None).await;
                                }
                            }
                        }
                        debug!("Broadcast remote user joined: {} (session {}, channel {}, ninja={})", username, session_id, channel_id, is_ninja);
                    }
                    EdgeEvent::RemoteUserLeft { session_id } => {
                        let msg = handler::build_user_remove_msg(session_id, None);
                        state.client_manager.broadcast(MessageType::UserRemove, &msg, None).await;
                        debug!("Broadcast remote user left: session {}", session_id);
                    }
                    EdgeEvent::RemoteUserStateChanged { session_id, delta, listening_channel_add, listening_channel_remove } => {
                        // Only forward fields that ACTUALLY changed (carried by delta).
                        // Broadcasting the full current state would include Some(false) for
                        // unchanged default-off fields, triggering spurious client notifications.
                        let mut msg = mumbleproto::UserState {
                            session: Some(session_id),
                            self_mute:        delta.self_mute,
                            self_deaf:        delta.self_deaf,
                            mute:             delta.mute,
                            deaf:             delta.deaf,
                            suppress:         delta.suppress,
                            priority_speaker: delta.priority_speaker,
                            recording:        delta.recording,
                            ..Default::default()
                        };
                        if !listening_channel_add.is_empty() {
                            msg.listening_channel_add = listening_channel_add;
                        }
                        if !listening_channel_remove.is_empty() {
                            msg.listening_channel_remove = listening_channel_remove;
                        }
                        state.client_manager.broadcast(MessageType::UserState, &msg, None).await;
                        debug!("Broadcast remote user state changed: session {}", session_id);
                    }
                    EdgeEvent::RemoteUserMoved { session_id, channel_id, actor_session } => {
                        let msg = mumbleproto::UserState {
                            session: Some(session_id),
                            channel_id: Some(channel_id),
                            actor: Some(actor_session),
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
                    EdgeEvent::ChannelUpdated { channel_id, links_add, links_remove } => {
                        if let Some(ch) = state.channel_manager.get_channel(channel_id).await {
                            let mut msg = handler::build_channel_state_msg(&ch);
                            msg.links_add = links_add;
                            msg.links_remove = links_remove;
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
                    EdgeEvent::HubUnreachable => {
                        warn!("Hub is unreachable (direct and relay both failed) — disconnecting all clients");
                        state.client_manager.close_all_connections(
                            "Server temporarily unavailable, please reconnect later",
                        ).await;
                    }
                    EdgeEvent::TextMessageForward { actor, message, channel_id, tree_id, session } => {
                        let msg = mumbleproto::TextMessage {
                            actor: Some(actor),
                            message,
                            channel_id,
                            tree_id,
                            session,
                        };
                        // Send to targeted sessions on this edge, or broadcast to channels
                        if !msg.session.is_empty() {
                            for &target_session in &msg.session {
                                state.client_manager.send_to(target_session, MessageType::TextMessage, &msg).await;
                            }
                        } else if !msg.channel_id.is_empty() {
                            for &ch_id in &msg.channel_id {
                                state.client_manager.broadcast_to_channel(ch_id, MessageType::TextMessage, &msg, None).await;
                            }
                        } else if !msg.tree_id.is_empty() {
                            for &ch_id in &msg.tree_id {
                                state.client_manager.broadcast_to_channel(ch_id, MessageType::TextMessage, &msg, None).await;
                            }
                        }
                        debug!("Forwarded text message from remote actor {}", actor);
                    }
                    EdgeEvent::PluginDataBroadcast { sender_session, data_id, data, target_sessions } => {
                        let msg = mumbleproto::PluginDataTransmission {
                            sender_session: Some(sender_session),
                            data_id: Some(data_id.clone()),
                            data: Some(data),
                            receiver_sessions: vec![],
                        };
                        for &target_session in &target_sessions {
                            state.client_manager.send_to(
                                target_session, MessageType::PluginDataTransmission, &msg
                            ).await;
                        }
                        debug!("Forwarded plugin data from session {}: {}", sender_session, data_id);
                    }
                    EdgeEvent::RelayedVoice { voice_packet } => {
                        // Voice relayed from another edge via Hub TCP.
                        // Standard Mumble server-to-client format:
                        //   [header(1B)][sender_session_varint][sequence_varint][voice_data]
                        // voice_packet already has session injected, so it can be sent directly to clients.
                        if voice_packet.len() < 2 {
                            continue;
                        }
                        let voice_target = (voice_packet[0] & 0x1F) as u32;

                        // Parse sender_session varint from offset 1
                        let sender_session = match decode_mumble_varint(&voice_packet[1..]) {
                            Some((s, _)) => s,
                            None => {
                                debug!("RelayedVoice: failed to parse sender session");
                                continue;
                            }
                        };

                        let my_edge_id = state.get_edge_id();

                        // Trace: log first 16 bytes of voice_packet to verify format
                        {
                            let hex: String = voice_packet.iter().take(16)
                                .map(|b| format!("{:02X}", b))
                                .collect::<Vec<_>>()
                                .join(" ");
                            trace!("edge={} RelayedVoice recv: len={} header=0x{:02X} target={} session={} bytes=[{}]",
                                my_edge_id, voice_packet.len(), voice_packet[0], voice_target, sender_session, hex);
                        }

                        // Build TCP UdpTunnel frame (voice_packet is already correctly formatted)
                        let frame = {
                            let mut buf = bytes::BytesMut::new();
                            bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
                            bytes::BufMut::put_u32(&mut buf, voice_packet.len() as u32);
                            bytes::BufMut::put_slice(&mut buf, &voice_packet);
                            buf.to_vec()
                        };

                        match voice_target {
                            31 => {
                                // Loopback — ignore cross-edge loopback
                                debug!("edge={} Ignoring relayed loopback from session {}", my_edge_id, sender_session);
                            }
                            0 => {
                                // PTT broadcast: deliver to all local clients in sender's linked channels
                                let sender_channel_id = if let Some(ru) = state.channel_manager.get_remote_user(sender_session).await {
                                    ru.channel_id
                                } else {
                                    debug!("edge={} RelayedVoice PTT: unknown remote session {}", my_edge_id, sender_session);
                                    continue;
                                };
                                let linked_channels = state.channel_manager.get_all_linked_channels(sender_channel_id).await;
                                let mut delivered = 0usize;
                                for ch_id in &linked_channels {
                                    let local_targets = state.client_manager.get_channel_sessions(*ch_id).await;
                                    for target_session in local_targets {
                                        if let Some(target_client) = state.client_manager.get_client(target_session).await {
                                            if target_client.deaf || target_client.self_deaf {
                                                continue;
                                            }
                                        }
                                        if let Some(sender_tx) = state.client_manager.get_sender(target_session).await {
                                            sender_tx.send_raw(frame.clone()).await;
                                            delivered += 1;
                                        }
                                    }
                                }
                                trace!("edge={} Delivered relayed broadcast from session {} to {} local clients in {} linked channels", my_edge_id, sender_session, delivered, linked_channels.len());
                            }
                            1..=30 => {
                                // Whisper: use synced VoiceTarget config for sender's session
                                let vt_config = {
                                    let cache = state.voice_targets.read().await;
                                    cache.get(&sender_session).and_then(|m| m.get(&voice_target)).cloned()
                                };
                                if let Some(vt) = vt_config {
                                    let mut target_sessions: std::collections::HashSet<u32> = std::collections::HashSet::new();
                                    for s in &vt.sessions {
                                        target_sessions.insert(*s);
                                    }
                                    for ch_cfg in &vt.channels {
                                        let mut ch_ids = std::collections::HashSet::new();
                                        ch_ids.insert(ch_cfg.channel_id);
                                        if ch_cfg.links {
                                            let linked = state.channel_manager.get_all_linked_channels(ch_cfg.channel_id).await;
                                            ch_ids.extend(linked);
                                        }
                                        for ch_id in ch_ids {
                                            let local_sessions = state.client_manager.get_channel_sessions(ch_id).await;
                                            for s in local_sessions {
                                                if s != sender_session {
                                                    target_sessions.insert(s);
                                                }
                                            }
                                        }
                                    }
                                    let mut delivered = 0usize;
                                    for target_session in &target_sessions {
                                        if let Some(target_client) = state.client_manager.get_client(*target_session).await {
                                            if target_client.deaf || target_client.self_deaf {
                                                continue;
                                            }
                                        }
                                        if let Some(sender_tx) = state.client_manager.get_sender(*target_session).await {
                                            sender_tx.send_raw(frame.clone()).await;
                                            delivered += 1;
                                        }
                                    }
                                    trace!("edge={} Delivered relayed whisper from session {} to {}/{} targets", my_edge_id, sender_session, delivered, target_sessions.len());
                                } else {
                                    debug!("edge={} RelayedVoice whisper: no VoiceTarget config for session {} target {}", my_edge_id, sender_session, voice_target);
                                }
                            }
                            _ => {}
                        }
                    }
                    EdgeEvent::ShutdownRequested { reason } => {
                        // Hub requests graceful shutdown due to cluster partition.
                        // Send ServerReject to all connected clients so they reconnect elsewhere.
                        warn!("Shutdown requested: {}", reason);
                        let reject_msg = mumbleproto::Reject {
                            r#type: Some(mumbleproto::reject::RejectType::None as i32),
                            reason: Some(format!("Server shutting down: {}", reason)),
                        };
                        let authenticated_sessions = state.client_manager.get_authenticated_sessions().await;
                        for session in authenticated_sessions {
                            state.client_manager.send_to(
                                session,
                                MessageType::Reject,
                                &reject_msg,
                            ).await;
                        }
                        // Give clients a moment to receive the reject, then exit gracefully
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                        warn!("Exiting due to hub shutdown request (cluster partition)");
                        // Signal the main accept loop to shut down gracefully.
                        let _ = shutdown_tx.send(()).await;
                        return;
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
