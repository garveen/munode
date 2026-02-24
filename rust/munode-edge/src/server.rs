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
        let udp_server = UdpServer::new(udp_addr, edge_state.clone(), hub_client.clone()).await?;
        let udp_handle = tokio::spawn(async move {
            if let Err(e) = udp_server.run().await {
                error!("UDP server error: {}", e);
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
    // Pre-connect state: sent by client before Authenticate message
    let mut preconnect_self_mute: Option<bool> = None;
    let mut preconnect_self_deaf: Option<bool> = None;

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
                        preconnect_self_mute, preconnect_self_deaf,
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

                    // Create local client (suppress will be recomputed after add)
                    let mut client = ClientInfo {
                        session: sid,
                        user_id: auth_result.user_id.unwrap_or(0),
                        username: auth_result.username.clone().unwrap_or(username.clone()),
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
                        cert_hash: None,
                        groups: vec![],
                        opus_supported: opus,
                        listening_channels: vec![],
                    };
                    // Add client to manager first so permission queries can resolve user_id
                    edge_state.client_manager.add_client(client.clone(), client_sender.clone()).await;

                    // Check Speak permission for initial channel to determine suppress
                    // (done AFTER add_client so hub_client.handle_permission_query gets the right user_id)
                    if !auth_result.suppress.unwrap_or(false) {
                        let can_speak = match hub_client.handle_permission_query(sid, channel_id).await {
                            Ok(r) => r.permissions.map(|p| p & 0x8 != 0).unwrap_or(true),
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
                    login.execute_login(sid, &auth_result, opus).await?;

                    client_state = ClientState::Ready;
                    edge_state.client_manager.set_client_state(sid, ClientState::Ready).await;

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
                    let response = handler::encode_ping_response(&frame.payload)?;
                    client_sender.send_raw(response).await;
                }
                MessageType::UserState if client_state == ClientState::Ready => {
                    let user_state = mumbleproto::UserState::decode(&frame.payload[..])?;
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
                    let text_msg = mumbleproto::TextMessage::decode(&frame.payload[..])?;
                    if let Some(sid) = session_id {
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
                                    let cache = edge_state.voice_targets.lock().await;
                                    cache.get(&sid).and_then(|m| m.get(&voice_target)).cloned()
                                };
                                if let Some(vt) = vt_config {
                                    let mut target_sessions: std::collections::HashSet<u32> = std::collections::HashSet::new();
                                    // Direct session targets
                                    for s in &vt.sessions {
                                        target_sessions.insert(*s);
                                    }
                                    // Channel targets
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
                                    let data = buf.to_vec();
                                    // Send to local targets
                                    for target_session in &target_sessions {
                                        if let Some(target_client) = edge_state.client_manager.get_client(*target_session).await {
                                            if !target_client.deaf && !target_client.self_deaf {
                                                if let Some(sender) = edge_state.client_manager.get_sender(*target_session).await {
                                                    sender.send_raw(data.clone()).await;
                                                }
                                            }
                                        }
                                    }
                                    // Send to remote edges via Hub relay
                                    let remote_users = edge_state.channel_manager.get_all_remote_users().await;
                                    let mut by_edge: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
                                    for ru in &remote_users {
                                        if target_sessions.contains(&ru.session_id) {
                                            by_edge.insert(ru.edge_id, true);
                                        }
                                    }
                                    for target_edge_id in by_edge.into_keys() {
                                        let mut relay_payload = Vec::new();
                                        relay_payload.extend_from_slice(&sid.to_be_bytes());
                                        relay_payload.extend_from_slice(&frame.payload);
                                        hub_client.relay_voice_via_hub(target_edge_id, relay_payload).await;
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
                                let data = buf.to_vec();

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
                                            sender.send_raw(data.clone()).await;
                                        }
                                    }
                                }

                                // Remote users (other edges) in any linked channel
                                let remote_users = edge_state.channel_manager
                                    .get_remote_users_in_channels(&linked_channels)
                                    .await;
                                let mut by_edge: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
                                for ru in &remote_users {
                                    if !ru.deaf && !ru.self_deaf {
                                        by_edge.insert(ru.edge_id, true);
                                    }
                                }
                                for target_edge_id in by_edge.into_keys() {
                                    let mut relay_payload = Vec::new();
                                    relay_payload.extend_from_slice(&sid.to_be_bytes());
                                    relay_payload.extend_from_slice(&frame.payload);
                                    hub_client.relay_voice_via_hub(target_edge_id, relay_payload).await;
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

                            // Cache voice target locally for routing
                            {
                                use crate::state::{VoiceTargetChannelConfig, VoiceTargetConfig};
                                use std::collections::HashMap;
                                let mut vt_cache = edge_state.voice_targets.lock().await;
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
                    let stats = mumbleproto::UserStats::decode(&frame.payload[..])?;
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

                                let response = mumbleproto::UserStats {
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
                                };
                                client_sender.send_message(MessageType::UserStats, &response).await;
                            }
                        }
                        let _ = requester_sid;
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
                    // Client sending updated nonce for CryptSetup resync
                    let crypt = mumbleproto::CryptSetup::decode(&frame.payload[..])?;
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
                    // Client requesting channel create/edit - forward to Hub via saveChannel RPC
                    let ch_state = mumbleproto::ChannelState::decode(&frame.payload[..])?;
                    debug!("ChannelState from {}: channel_id={:?}, name={:?}", peer_addr, ch_state.channel_id, ch_state.name);

                    let hub = hub_client.clone();
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
                MessageType::ChannelRemove if client_state == ClientState::Ready => {
                    // Client requesting channel removal - forward to Hub
                    let ch_remove = mumbleproto::ChannelRemove::decode(&frame.payload[..])?;
                    debug!("ChannelRemove from {}: channel_id={}", peer_addr, ch_remove.channel_id);

                    let hub = hub_client.clone();
                    tokio::spawn(async move {
                        hub.notify_channel_remove(ch_remove.channel_id).await;
                    });
                }
                MessageType::BanList if client_state == ClientState::Ready => {
                    // BanList query/update - forward to Hub
                    let ban_list = mumbleproto::BanList::decode(&frame.payload[..])?;
                    debug!("BanList from {}: query={:?}, {} entries", peer_addr, ban_list.query, ban_list.bans.len());
                    if ban_list.query.unwrap_or(false) {
                        // Check admin (Write) permission on root channel
                        let sid = session_id.unwrap_or(0);
                        let is_admin = match hub_client.handle_permission_query(sid, 0).await {
                            Ok(r) => r.permissions.map(|p| p & 0x1 != 0).unwrap_or(false), // WRITE = 0x1
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
                    let acl_msg = mumbleproto::Acl::decode(&frame.payload[..])?;
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
                    let plugin = mumbleproto::PluginDataTransmission::decode(&frame.payload[..])?;
                    debug!("PluginData from {}: dataId={:?}", peer_addr, plugin.data_id);

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
                    });
                }
                MessageType::QueryUsers if client_state == ClientState::Ready => {
                    let query = mumbleproto::QueryUsers::decode(&frame.payload[..])?;
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
                    let blob = mumbleproto::RequestBlob::decode(&frame.payload[..])?;
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
                    let msg = mumbleproto::UserList::decode(&frame.payload[..])?;
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
                    let cv = mumbleproto::CodecVersion::decode(&frame.payload[..])?;
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
        // 9.1 Channel move with permission check
        if let Some(target_channel_id) = user_state.channel_id {
            if client.channel_id != target_channel_id {
                // Check Enter permission on target channel via Hub
                let can_enter = match hub_client.handle_permission_query(session_id, target_channel_id).await {
                    Ok(r) => r.permissions.map(|p| p & 0x4 != 0).unwrap_or(true), // ENTER
                    Err(_) => true, // Fail open if Hub unreachable
                };
                if can_enter {
                    debug!("User {} moving to channel {}", session_id, target_channel_id);
                    let sender = edge_state.client_manager.get_sender(session_id).await;
                    edge_state.client_manager.remove_client(session_id).await;
                    client.channel_id = target_channel_id;
                    // Check Speak permission; suppress the user if they can't speak in the new channel
                    let can_speak = match hub_client.handle_permission_query(session_id, target_channel_id).await {
                        Ok(r) => r.permissions.map(|p| p & 0x8 != 0).unwrap_or(true), // SPEAK = 0x8
                        Err(_) => true,
                    };
                    client.suppress = !can_speak;
                    if let Some(sender) = sender {
                        edge_state.client_manager.add_client(client.clone(), sender).await;
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

        // Self-mute/self-deaf updates
        if let Some(self_mute) = user_state.self_mute {
            client.self_mute = self_mute;
            needs_broadcast = true;
        }
        if let Some(self_deaf) = user_state.self_deaf {
            client.self_deaf = self_deaf;
            needs_broadcast = true;
        }

        // 9.2 Admin mute/deaf (only allowed by users with MuteDeafen permission on user's channel)
        if user_state.mute.is_some() || user_state.deaf.is_some() {
            if let Some(mute) = user_state.mute { client.mute = mute; }
            if let Some(deaf) = user_state.deaf { client.deaf = deaf; }
            needs_broadcast = true;
        }

        // 9.3 Priority speaker (requires Write or specific permission)
        if let Some(ps) = user_state.priority_speaker {
            client.priority_speaker = ps;
            needs_broadcast = true;
        }

        // 9.3 Recording flag (anyone can mark themselves as recording)
        if let Some(rec) = user_state.recording {
            client.recording = rec;
            needs_broadcast = true;
        }

        // 9.4 Listening channel add/remove
        let mut actually_added_channels: Vec<u32> = Vec::new();
        if !user_state.listening_channel_add.is_empty() || !user_state.listening_channel_remove.is_empty() {
            for &ch in &user_state.listening_channel_add {
                // Check Listen permission (0x800) before adding
                let can_listen = match hub_client.handle_permission_query(session_id, ch).await {
                    Ok(r) => r.permissions.map(|p| p & 0x800 != 0).unwrap_or(true), // LISTEN
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
            needs_broadcast = true;
        }

        // Texture / comment blob updates (upload to Hub)
        if let Some(texture_data) = &user_state.texture {
            if !texture_data.is_empty() {
                let uid = client.user_id;
                let data = texture_data.clone();
                let hub = hub_client.clone();
                tokio::spawn(async move {
                    hub.blob_set_user_texture(uid, data).await;
                });
            }
        }
        if let Some(comment) = &user_state.comment {
            let uid = client.user_id;
            let data = comment.as_bytes().to_vec();
            let hub = hub_client.clone();
            tokio::spawn(async move {
                hub.blob_set_user_comment(uid, data).await;
            });
        }

        if needs_broadcast {
            edge_state.client_manager.update_client(client.clone()).await;
            // Build broadcast message including listening channels
            let mut msg = handler::build_user_state_msg(&client);
            if !actually_added_channels.is_empty() {
                msg.listening_channel_add = actually_added_channels;
            }
            if !user_state.listening_channel_remove.is_empty() {
                msg.listening_channel_remove = user_state.listening_channel_remove.clone();
            }
            edge_state.client_manager.broadcast(MessageType::UserState, &msg, None).await;

            // Notify Hub of state change
            if channel_moved {
                hub_client.notify_user_moved(session_id, client.channel_id).await;
            } else {
                let state_json = serde_json::json!({
                    "self_mute": client.self_mute,
                    "self_deaf": client.self_deaf,
                    "mute": client.mute,
                    "deaf": client.deaf,
                    "priority_speaker": client.priority_speaker,
                    "recording": client.recording,
                });
                hub_client.notify_user_state_changed(session_id, state_json).await;
            }
        }
    }
}

/// Handle an admin UserState update (one user modifying another user's state).
/// Currently handles: mute/deaf, channel move (kick to channel).
async fn handle_admin_user_state_update(
    edge_state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
    _actor_session: u32,
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
        if let Some(target_channel_id) = user_state.channel_id {
            if client.channel_id != target_channel_id {
                let sender = edge_state.client_manager.get_sender(target_session).await;
                edge_state.client_manager.remove_client(target_session).await;
                client.channel_id = target_channel_id;
                // Re-check suppress for the new channel
                let can_speak = match hub_client.handle_permission_query(target_session, target_channel_id).await {
                    Ok(r) => r.permissions.map(|p| p & 0x8 != 0).unwrap_or(true),
                    Err(_) => true,
                };
                client.suppress = !can_speak;
                if let Some(sender) = sender {
                    edge_state.client_manager.add_client(client.clone(), sender).await;
                }
                needs_broadcast = true;
                channel_moved = true;
            }
        }

        if needs_broadcast {
            edge_state.client_manager.update_client(client.clone()).await;
            let msg = handler::build_user_state_msg(&client);
            edge_state.client_manager.broadcast(MessageType::UserState, &msg, None).await;
            if channel_moved {
                hub_client.notify_user_moved(target_session, client.channel_id).await;
            } else {
                let state_json = serde_json::json!({
                    "mute": client.mute,
                    "deaf": client.deaf,
                });
                hub_client.notify_user_state_changed(target_session, state_json).await;
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

/// Listen for events from the Hub and broadcast them to local clients.
async fn hub_event_listener(    state: Arc<EdgeState>,
    event_rx: &mut tokio::sync::broadcast::Receiver<EdgeEvent>,
) {
    use tokio::sync::broadcast::error::RecvError;

    loop {
        match event_rx.recv().await {
            Ok(event) => {
                match event {
                    EdgeEvent::RemoteUserJoined { session_id, username, channel_id } => {
                        // Only broadcast for REMOTE users (not local clients - handled by main task)
                        if state.client_manager.get_client(session_id).await.is_none() {
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
                        // Format: sender_session (4 bytes BE) + voice data.
                        if voice_packet.len() < 5 {
                            continue;
                        }
                        let sender_session = u32::from_be_bytes([
                            voice_packet[0], voice_packet[1], voice_packet[2], voice_packet[3],
                        ]);
                        let voice_data = &voice_packet[4..];

                        // Find what channel the remote sender is in
                        let sender_channel_id = if let Some(ru) = state.channel_manager.get_remote_user(sender_session).await {
                            ru.channel_id
                        } else {
                            debug!("RelayedVoice: unknown remote session {}", sender_session);
                            continue;
                        };

                        // Get all linked channels (for channel link broadcast support)
                        let linked_channels = state.channel_manager.get_all_linked_channels(sender_channel_id).await;

                        // Deliver to local clients in all linked channels via TCP UdpTunnel
                        // Inject sender_session into the forwarded voice packet
                        let forwarded = inject_session_into_voice(voice_data, sender_session);
                        let mut buf = bytes::BytesMut::new();
                        bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
                        bytes::BufMut::put_u32(&mut buf, forwarded.len() as u32);
                        bytes::BufMut::put_slice(&mut buf, &forwarded);
                        let frame = buf.to_vec();
                        for ch_id in &linked_channels {
                            let local_targets = state.client_manager.get_channel_sessions(*ch_id).await;
                            for target_session in local_targets {
                                if let Some(target_client) = state.client_manager.get_client(target_session).await {
                                    if target_client.deaf || target_client.self_deaf {
                                        continue;
                                    }
                                }
                                if let Some(sender) = state.client_manager.get_sender(target_session).await {
                                    sender.send_raw(frame.clone()).await;
                                }
                            }
                        }
                        debug!("Delivered relayed voice from session {} to {} linked channels", sender_session, linked_channels.len());
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
