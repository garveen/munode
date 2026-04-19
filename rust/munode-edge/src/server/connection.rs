//! Per-client TCP connection handler and associated helpers.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use anyhow::Result;
use bytes::BytesMut;
use prost::Message;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info, warn};
use munode_common::config::EdgeConfig;
use munode_common::permission as perm;
use munode_protocol::hubedge;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::decode_frame;
use crate::client::{ClientInfo, ClientSender, ClientState};
use crate::handler::{self, LoginHandler, LoginInfo};
use crate::hub_client::{HubClient, HubConnectionState};
use crate::state::EdgeState;
use crate::voice::{deliver_voice_tcp, inject_session_into_voice, wrap_udptunnel};

/// Idle timeout for client TCP connections. Connections that send no data for
/// this duration are considered zombie connections and are closed.
const CLIENT_IDLE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(120);


/// Result returned by the spawned login task on success.
pub(super) struct LoginTaskResult {
    session_id: u32,
    /// Data needed by the outer loop to send ServerSync / ServerConfig after
    /// transitioning the client state to `Ready`.
    login_info: LoginInfo,
    /// The `ClientSender` used during the login task, returned so the outer
    /// loop can call the final send methods on it.
    client_sender: ClientSender,
    /// EdgeConfig clone, needed to compose ServerSync / ServerConfig.
    config: EdgeConfig,
}

/// Arguments passed into the spawned login task.
pub(super) struct LoginTaskArgs {
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
    client_sender: ClientSender,
    config: EdgeConfig,
    peer_addr: SocketAddr,
    /// oneshot sender consumed by `register_close_signal`.
    close_tx: tokio::sync::oneshot::Sender<()>,
    username: String,
    password: String,
    tokens: Vec<String>,
    opus: bool,
    preconnect_self_mute: Option<bool>,
    preconnect_self_deaf: Option<bool>,
    client_version: Option<u32>,
    client_release: String,
    client_os: String,
    client_os_version: String,
    certificate_hash: Option<String>,
}

/// Performs the full authentication and login sequence for a new client.
///
/// This is spawned as an independent tokio task so the read loop of
/// `handle_client_connection` remains free to respond to TCP Ping messages
/// while potentially slow Hub RPCs are in flight.
///
/// Returns `Some(LoginTaskResult)` on success.  On failure the function sends a
/// Reject to the client, calls `remove_client` / `notify_user_left` if the
/// session was already registered, and returns `None`.
pub(super) async fn do_login_task(args: LoginTaskArgs) -> Option<LoginTaskResult> {
    let LoginTaskArgs {
        hub_client,
        edge_state,
        client_sender,
        config,
        peer_addr,
        close_tx,
        username,
        password,
        tokens,
        opus,
        preconnect_self_mute,
        preconnect_self_deaf,
        client_version,
        client_release,
        client_os,
        client_os_version,
        certificate_hash,
    } = args;

    // Allocate session ID from local Edge pool
    let sid = match edge_state.allocate_session_id().await {
        Some(sid) => sid,
        None => {
            error!("Failed to allocate session ID: pool exhausted or edge not registered");
            client_sender.send_raw(handler::encode_reject(
                Some(mumbleproto::reject::RejectType::ServerFull as i32),
                "Server is full (session pool exhausted)",
            ).into()).await;
            return None;
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

    // Authenticate via Hub (permit limits concurrent auth RPCs to avoid Hub overload)
    let _auth_permit = edge_state.auth_semaphore
        .acquire()
        .await
        .expect("auth semaphore closed");
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
            ).into()).await;
            return None;
        }
    };

    if !auth_result.success {
        let reason = auth_result.reason.clone().unwrap_or_else(|| "Authentication denied".to_string());
        info!("Authentication failed for {}: {}", username, reason);
        if auth_result.cert_required.unwrap_or(false) {
            let pd = mumbleproto::PermissionDenied {
                r#type: Some(mumbleproto::permission_denied::DenyType::MissingCertificate as i32),
                session: Some(sid),
                ..Default::default()
            };
            client_sender.send_message(MessageType::PermissionDenied, &pd).await;
        }
        client_sender.send_raw(handler::encode_reject(
            auth_result.reject_type.map(|t| t as i32)
                .or_else(|| if auth_result.cert_required.unwrap_or(false) {
                    Some(mumbleproto::reject::RejectType::NoCertificate as i32)
                } else { None }),
            &reason,
        ).into()).await;
        return None;
    }

    // Authentication succeeded — build and register the client.
    let channel_id = auth_result.channel_id.unwrap_or(config.server.default_channel);
    let display_name = auth_result.display_name.clone()
        .or(auth_result.username.clone())
        .unwrap_or(username.clone());

    info!(
        "User {} authenticated (session={}, user_id={:?}, channel={})",
        auth_result.username.as_deref().unwrap_or(&username),
        sid,
        auth_result.user_id,
        channel_id
    );
    debug!(
        session = sid,
        groups = ?auth_result.groups,
        "User groups assigned at login"
    );

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
        groups: auth_result.groups.clone(),
        opus_supported: opus,
        listening_channels: vec![],
        listening_volume_adjustments: HashMap::new(),
        texture_hash: None,
        comment_hash: None,
        client_version,
        client_release: client_release.clone(),
        client_os: client_os.clone(),
        client_os_version: client_os_version.clone(),
        plugin_context: vec![],
    };

    // Add client to manager first so permission queries can resolve user_id.
    edge_state.client_manager.add_client(client.clone(), client_sender.clone()).await;
    // Register the close signal so the main loop can force-disconnect on kick/ban.
    edge_state.client_manager.register_close_signal(sid, close_tx).await;

    // Helper: clean up and return None after the session is in the manager.
    macro_rules! fail {
        () => {{
            edge_state.client_manager.remove_client(sid).await;
            edge_state.free_session_id(sid).await;
            hub_client.notify_user_left(sid, None).await;
            return None;
        }};
    }

    // Check Speak permission for initial channel to determine suppress
    // (done AFTER add_client so hub_client.handle_permission_query gets the right user_id)
    if !auth_result.suppress.unwrap_or(false) {
        let can_speak = get_perm_cached(&hub_client, &edge_state, sid, channel_id, true).await
            & munode_common::permission::SPEAK != 0;
        if !can_speak {
            client.suppress = true;
            edge_state.client_manager.update_client(client.clone()).await;
        }
    }

    // Execute full login sequence (CryptSetup → CodecVersion → ChannelStates →
    // UserStates → ServerSync → ServerConfig).
    let login = LoginHandler::new(&client_sender, &config, &edge_state, &hub_client);
    let login_info = match login.execute_login(sid, &auth_result).await {
        Ok(info) => info,
        Err(e) => {
            info!("Login sequence failed for {} (session={}): {}", peer_addr, sid, e);
            fail!();
        }
    };

    // Broadcast updated codec version to all clients now that this client's
    // opus capability is registered.
    broadcast_codec_version(&edge_state).await;

    // NOTE: set_client_state(Ready) is now done by the outer connection loop
    // AFTER receiving this LoginTaskResult and BEFORE sending ServerSync.
    // This matches Murmur's ordering: state → Authenticated before ServerSync,
    // so UserState{channel_id} responses from the client are processed correctly.

    // Populate ninja channel permission cache for this client.
    {
        let ninja_channels = edge_state.ninja_channels.read().await.clone();
        if !ninja_channels.is_empty() {
            let mut visible_set = std::collections::HashSet::new();
            for &ch_id in &ninja_channels {
                let can_enter = get_perm_cached(&hub_client, &edge_state, sid, ch_id, false).await
                    & munode_common::permission::ENTER != 0;
                if can_enter {
                    visible_set.insert(ch_id);
                }
            }
            edge_state.ninja_visible_to.write().await.insert(sid, visible_set);
        }
    }

    // If suppress was set by permission check, notify the client itself.
    if client.suppress && !auth_result.suppress.unwrap_or(false) {
        let suppress_msg = mumbleproto::UserState {
            session: Some(sid),
            suppress: Some(true),
            ..Default::default()
        };
        client_sender.send_message(MessageType::UserState, &suppress_msg).await;
    }

    // Broadcast new user join to all other Ready clients.
    // NOTE: self_deaf/self_mute are intentionally excluded here, matching Murmur behaviour.
    // The preconnect state (self_deaf/self_mute) is applied separately via login_rx after the
    // client transitions to Ready, which then broadcasts it to ALL clients (including the new
    // user itself) with the correct actor field.
    let user_join_msg = mumbleproto::UserState {
        session: Some(client.session),
        user_id: if client.user_id > 0 { Some(client.user_id) } else { None },
        name: Some(client.username.clone()),
        channel_id: Some(client.channel_id),
        mute: if client.mute { Some(true) } else { None },
        deaf: if client.deaf { Some(true) } else { None },
        suppress: if client.suppress { Some(true) } else { None },
        priority_speaker: if client.priority_speaker { Some(true) } else { None },
        recording: if client.recording { Some(true) } else { None },
        hash: client.cert_hash.clone(),
        texture_hash: client.texture_hash.clone(),
        comment_hash: client.comment_hash.clone(),
        ..Default::default()
    };
    edge_state.client_manager.broadcast(
        MessageType::UserState,
        &user_join_msg,
        Some(sid),
    ).await;
    // Invalidate BroadcastCaches: a new user joined, routing targets changed.
    edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);

    // Restore persisted channel listeners for registered users.
    let user_id = client.user_id;
    if user_id > 0 {
        let saved_listeners = hub_client.load_channel_listeners(user_id).await;
        if !saved_listeners.is_empty() {
            let restore_state = mumbleproto::UserState {
                session: Some(sid),
                listening_channel_add: saved_listeners,
                ..Default::default()
            };
            handle_user_state_update(&edge_state, &hub_client, sid, &restore_state).await;
            debug!("Restored saved channel listeners for user {} (session {})", user_id, sid);
        }
    }

    info!("Client {} login task complete, outer loop will finalise (session={})", peer_addr, sid);
    Some(LoginTaskResult { session_id: sid, login_info, client_sender, config })
}

/// Handle a single Mumble client connection (TLS).
pub(super) async fn handle_client_connection(
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
    let (send_tx, mut send_rx) = mpsc::channel::<bytes::Bytes>(4096);
    let client_sender = ClientSender::new(send_tx);

    // Writer task: forwards messages from send_rx to TLS socket.
    // Batches pending messages with write_vectored + single flush to reduce syscalls.
    let writer_handle = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        loop {
            // Wait for the first message.
            let first = match send_rx.recv().await {
                Some(data) => data,
                None => break, // channel closed → client disconnected
            };

            let mut pending = vec![first];

            // Non-blocking drain: collect any already-queued messages.
            while let Ok(more) = send_rx.try_recv() {
                pending.push(more);
                if pending.len() >= 32 { break; }
            }

            if pending.len() == 1 {
                // Common case: single message — avoid building IoSlice vec.
                if let Err(e) = writer.write_all(&pending[0]).await {
                    debug!("Write error to client: {}", e);
                    break;
                }
            } else {
                let iov: Vec<std::io::IoSlice<'_>> =
                    pending.iter().map(|d| std::io::IoSlice::new(d.as_ref())).collect();
                if let Err(e) = writer.write_vectored(&iov).await {
                    debug!("Write error to client: {}", e);
                    break;
                }
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

    let auth_deadline = if config.server.auth_timeout_secs > 0 {
        Some(tokio::time::Instant::now() + tokio::time::Duration::from_secs(config.server.auth_timeout_secs))
    } else {
        None
    };

    // Per-connection close signal: fired by remove_client() when the client is
    // kicked or banned.  The read loop selects on this receiver so that the TCP
    // connection is closed immediately without waiting for the client to send
    // another packet.
    let (close_tx, mut close_rx) = tokio::sync::oneshot::channel::<()>();
    // The sender is registered with ClientManager after successful auth (below).
    // We wrap it in an Option so we can move it into register_close_signal exactly once.
    let mut close_tx_opt: Option<tokio::sync::oneshot::Sender<()>> = Some(close_tx);

    // Login task: spawned when Authenticate is received so that the read loop
    // remains free to respond to TCP Ping messages while Hub RPCs and the
    // login message burst are in flight.  Without this, Hub RPCs that take
    // longer than ~20 s cause the C++ client to hit its ping-timeout and
    // call serverConnectionClosed(), making the connection appear "frozen".
    //
    // login_rx  — oneshot receiver fed by the spawned task (Some(sid) = success)
    // login_abort — AbortHandle to cancel the task if close_rx fires first
    let mut login_rx: Option<tokio::sync::oneshot::Receiver<Option<LoginTaskResult>>> = None;
    let mut login_abort: Option<tokio::task::AbortHandle> = None;

    'outer: loop {
        // Read data from TLS stream with idle timeout to drop zombie connections.
        // Before authentication, also enforce the pre-auth connection timeout.
        let read_timeout = if client_state != ClientState::Ready {
            if let Some(deadline) = auth_deadline {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                remaining.min(CLIENT_IDLE_TIMEOUT)
            } else {
                CLIENT_IDLE_TIMEOUT
            }
        } else {
            CLIENT_IDLE_TIMEOUT
        };

        // --- Outer select: three branches when a login task is running
        //     (close | login-done | read), otherwise two branches (close | read).
        //
        // We take `login_recv` out of `login_rx` so the async block can hold an
        // *owned* Receiver instead of a borrow, avoiding lifetime conflicts with
        // the &mut close_rx in the same select!.  On the read branch we put it
        // back so subsequent iterations still see it.
        let n = if let Some(mut login_recv) = login_rx.take() {
            tokio::select! {
                biased;
                _ = &mut close_rx => {
                    debug!("Client {} force-disconnected (kicked/banned)", peer_addr);
                    if let Some(ab) = login_abort.take() { ab.abort(); }
                    break 'outer;
                }
                result = &mut login_recv => {
                    // Login task finished.
                    login_abort = None;
                    match result.ok().flatten() {
                        Some(task_result) => {
                            let sid = task_result.session_id;
                            session_id = Some(sid);

                            // ── Murmur-aligned ordering ──────────────────────────────────
                            // Transition to Ready FIRST (equivalent to Murmur setting
                            // sState = Authenticated before sending ServerSync).  This
                            // ensures that when the client responds to ServerSync with
                            // UserState{channel_id} the server is already in Ready state
                            // and the handler processes the message normally — no buffering
                            // patch needed.
                            edge_state.client_manager.set_client_state(sid, ClientState::Ready).await;
                            client_state = ClientState::Ready;
                            info!("Client {} is now Ready (session={})", peer_addr, sid);

                            // Send ServerSync now that state == Ready.
                            let login_handler = LoginHandler::new(
                                &task_result.client_sender,
                                &task_result.config,
                                &edge_state,
                                &hub_client,
                            );
                            if login_handler.send_server_sync(sid, task_result.login_info.root_permissions).await.is_err() {
                                break 'outer;
                            }
                            // Send ServerConfig / SuggestConfig.
                            if login_handler.send_server_config().await.is_err() {
                                break 'outer;
                            }

                            // Apply preconnect self_mute/self_deaf that arrived while
                            // the login RPC was in flight.
                            if preconnect_self_mute.is_some() || preconnect_self_deaf.is_some() {
                                let us = mumbleproto::UserState {
                                    self_mute: preconnect_self_mute,
                                    self_deaf: preconnect_self_deaf,
                                    ..Default::default()
                                };
                                // Sync to Hub + broadcast to ALL clients (including the new user).
                                handle_user_state_update(&edge_state, &hub_client, sid, &us).await;
                            }
                            // No channel_id buffering needed: the client sends
                            // UserState{channel_id} after receiving ServerSync, and by
                            // then the server is already in Ready state.
                        }
                        None => {
                            // Login failed; the task already cleaned up.
                            break 'outer;
                        }
                    }
                    // No data was read — restart loop so frame processing
                    // re-evaluates with the new client_state.
                    continue 'outer;
                }
                result = tokio::time::timeout(read_timeout, reader.read_buf(&mut buf)) => {
                    // TCP data arrived while login is still in progress.
                    // Put the receiver back so the next iteration sees it.
                    login_rx = Some(login_recv);
                    match result {
                        Ok(Ok(n)) => n,
                        Ok(Err(e)) => {
                            info!("Client {} connection error: {}", peer_addr, e);
                            break 'outer;
                        }
                        Err(_) => {
                            info!("Client {} idle timeout during login — closing connection", peer_addr);
                            break 'outer;
                        }
                    }
                }
            }
        } else {
            tokio::select! {
                // Check close signal first (biased) so kick/ban takes priority.
                biased;
                _ = &mut close_rx => {
                    debug!("Client {} force-disconnected (kicked/banned)", peer_addr);
                    break 'outer;
                }
                result = tokio::time::timeout(read_timeout, reader.read_buf(&mut buf)) => {
                    match result {
                        Ok(Ok(n)) => n,
                        Ok(Err(e)) => {
                            info!("Client {} connection error: {}", peer_addr, e);
                            break 'outer;
                        }
                        Err(_) => {
                            if client_state != ClientState::Ready {
                                if let Some(deadline) = auth_deadline {
                                    if tokio::time::Instant::now() >= deadline {
                                        info!("Client {} auth timeout — closing unauthenticated connection", peer_addr);
                                        let reject = mumbleproto::Reject {
                                            r#type: Some(mumbleproto::reject::RejectType::None as i32),
                                            reason: Some("Authentication timed out".to_string()),
                                            ..Default::default()
                                        };
                                        client_sender.send_message(MessageType::Reject, &reject).await;
                                        break 'outer;
                                    }
                                }
                            }
                            info!("Client {} idle timeout — closing connection", peer_addr);
                            break 'outer;
                        }
                    }
                }
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
                    client_sender.send_raw(response.into()).await;
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

                    info!("Authentication request from {}: username={}", peer_addr, username);

                    // --- Fast synchronous checks (no Hub RPCs) ---

                    // Check Hub connectivity
                    if hub_client.state().await != HubConnectionState::Registered {
                        warn!("Hub not connected, rejecting client {}", peer_addr);
                        client_sender.send_raw(handler::encode_reject(
                            Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                            "Server not ready, please try again later",
                        ).into()).await;
                        // Drop sender so the writer task drains and flushes before exiting
                        drop(client_sender);
                        writer_handle.await.ok();
                        return Ok(());
                    }

                    // Local session-count pre-check: fast reject before spending an RPC.
                    // max_users reflects the Hub-provided global limit (0 = unlimited).
                    // Note: this is a best-effort local check; the Hub enforces the
                    // authoritative global count in handle_authenticate_user.
                    {
                        let max_users = edge_state.max_users.load(std::sync::atomic::Ordering::Relaxed);
                        if max_users > 0 {
                            let local_count = edge_state.client_manager.client_count().await;
                            if local_count >= max_users as usize {
                                warn!(
                                    "Rejecting {} pre-auth: local session count ({}) >= max_users ({})",
                                    peer_addr, local_count, max_users
                                );
                                client_sender.send_raw(handler::encode_reject(
                                    Some(mumbleproto::reject::RejectType::ServerFull as i32),
                                    &format!("Server is full ({}/{})", local_count, max_users),
                                ).into()).await;
                                drop(client_sender);
                                writer_handle.await.ok();
                                return Ok(());
                            }
                        }
                    }

                    // --- Spawn the slow login work as a separate task ---
                    //
                    // This keeps the read loop alive so the server can continue
                    // responding to TCP Ping messages while Hub RPCs and the
                    // message burst are in flight.  The task sends back the
                    // allocated session_id (or None on failure) via the oneshot.
                    let (task_tx, task_rx) = tokio::sync::oneshot::channel::<Option<LoginTaskResult>>();
                    let task_args = LoginTaskArgs {
                        hub_client: hub_client.clone(),
                        edge_state: edge_state.clone(),
                        client_sender: client_sender.clone(),
                        config: config.clone(),
                        peer_addr,
                        close_tx: close_tx_opt.take().expect("close_tx used by login task"),
                        username: auth.username.unwrap_or_default(),
                        password: auth.password.unwrap_or_default(),
                        tokens: auth.tokens,
                        opus: auth.opus.unwrap_or(false),
                        preconnect_self_mute,
                        preconnect_self_deaf,
                        client_version,
                        client_release: client_release.clone(),
                        client_os: client_os.clone(),
                        client_os_version: client_os_version.clone(),
                        certificate_hash: certificate_hash.clone(),
                    };
                    let task = tokio::spawn(async move {
                        let result = do_login_task(task_args).await;
                        task_tx.send(result).ok();
                    });
                    login_abort = Some(task.abort_handle());
                    login_rx = Some(task_rx);
                    // Transition to Authenticated: the read loop will now process
                    // only Ping frames until the login task completes.
                    client_state = ClientState::Authenticated;
                }
                // The Mumble C++ client sends self_deaf/self_mute UserState AFTER Authenticate
                // (triggered asynchronously via Qt cross-thread signal), so the message arrives
                // while the login task is in flight and the state is Authenticated.
                // Capture these fields here with the same logic as the Connected pre-connect handler.
                // Note: channel_id is NOT buffered here.  ServerSync is now sent only after the
                // outer loop transitions to Ready, so any UserState{channel_id} from the client
                // arrives when the server is already in Ready state and is handled normally.
                MessageType::UserState if client_state == ClientState::Authenticated => {
                    if let Ok(us) = mumbleproto::UserState::decode(&frame.payload[..]) {
                        if us.self_mute.is_some() { preconnect_self_mute = us.self_mute; }
                        if us.self_deaf.is_some() {
                            preconnect_self_deaf = us.self_deaf;
                            // self_deaf implies self_mute per Mumble protocol
                            if us.self_deaf == Some(true) { preconnect_self_mute = Some(true); }
                        }
                    }
                }
                MessageType::Ping => {
                    let Ok(ping) = mumbleproto::Ping::decode(&frame.payload[..]) else { continue; };

                    // When the client is authenticated, save its reported stats and
                    // reply with the server's own crypt stats (matching Murmur's msgPing).
                    if let Some(sid) = session_id {
                        // Persist client-reported stats so UserStats can return them.
                        edge_state.client_manager.update_ping_stats(
                            sid,
                            ping.udp_packets.unwrap_or(0),
                            ping.tcp_packets.unwrap_or(0),
                            ping.udp_ping_avg.unwrap_or(0.0),
                            ping.udp_ping_var.unwrap_or(0.0),
                            ping.tcp_ping_avg.unwrap_or(0.0),
                            ping.tcp_ping_var.unwrap_or(0.0),
                            ping.good.unwrap_or(0),
                            ping.late.unwrap_or(0),
                            ping.lost.unwrap_or(0),
                            ping.resync.unwrap_or(0),
                        ).await;

                        // Reply with server-side crypt stats + echoed timestamp.
                        let (good, late, lost, resync) =
                            if let Some(cs) = edge_state.client_manager.get_crypt_state(sid).await {
                                let s = cs.lock().unwrap();
                                (s.good, s.late, s.lost, s.resync)
                            } else {
                                (0, 0, 0, 0)
                            };
                        let response = mumbleproto::Ping {
                            timestamp: ping.timestamp,
                            good: Some(good),
                            late: Some(late),
                            lost: Some(lost),
                            resync: Some(resync),
                            ..Default::default()
                        };
                        client_sender.send_message(MessageType::Ping, &response).await;
                    } else {
                        // Pre-auth: just echo the timestamp back.
                        let response = mumbleproto::Ping {
                            timestamp: ping.timestamp,
                            ..Default::default()
                        };
                        client_sender.send_message(MessageType::Ping, &response).await;
                    }
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
                            // Reject recording if server policy disallows it
                            if user_state.recording == Some(true) && !config.server.recording_allowed {
                                let pq = mumbleproto::PermissionDenied {
                                    r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                    reason: Some("Recording is not allowed on this server".to_string()),
                                    ..Default::default()
                                };
                                client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                continue;
                            }
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
                        // Strip HTML if not allowed
                        let mut text_msg = if !config.server.allow_html && text_msg.message.contains('<') {
                            let mut stripped = text_msg.clone();
                            stripped.message = strip_html_tags(&stripped.message);
                            stripped
                        } else {
                            text_msg
                        };
                        // Check TEXT_MESSAGE permission on each target channel and filter
                        // to only the channels where the sender has permission.
                        // PermissionDenied is sent only when ALL channels are denied.
                        if !text_msg.channel_id.is_empty() {
                            let mut permitted_channels: Vec<u32> = Vec::new();
                            let mut first_denied: Option<u32> = None;
                            for &ch_id in &text_msg.channel_id {
                                let has_perm = get_perm_cached(&hub_client, &edge_state, sid, ch_id, true).await
                                    & perm::TEXT_MESSAGE != 0;
                                if has_perm {
                                    permitted_channels.push(ch_id);
                                } else if first_denied.is_none() {
                                    first_denied = Some(ch_id);
                                }
                            }
                            if permitted_channels.is_empty() {
                                // No permitted channels at all — deny
                                let pq = mumbleproto::PermissionDenied {
                                    r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                    channel_id: first_denied,
                                    ..Default::default()
                                };
                                client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                continue;
                            }
                            // Replace channel list with only permitted channels
                            text_msg.channel_id = permitted_channels;
                        }
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
                        if !frame.payload.is_empty() {
                            // Reject CELT and Speex — this server is Opus-only.
                            let codec = frame.payload[0] >> 5;
                            if codec == 0 || codec == 2 || codec == 3 {
                                debug!(session = sid, codec, "Dropped non-Opus TCP voice packet");
                                continue;
                            }
                        }
                        if let Some(client) = edge_state.client_manager.get_client(sid).await {
                            let voice_target = if !frame.payload.is_empty() {
                                (frame.payload[0] & 0x1F) as u32
                            } else {
                                0
                            };

                            if client.suppress && voice_target != 31 {
                                // Suppressed users cannot speak — silently drop.
                            } else if voice_target == 31 {
                                // Loopback: send back to the sender (inject session ID per protocol)
                                let data = wrap_udptunnel(&inject_session_into_voice(&frame.payload, sid, 0));
                                if let Some(sender_tx) = edge_state.client_manager.get_sender(sid).await {
                                    sender_tx.send_raw(data).await;
                                }
                            } else if let Some(targets) = crate::routing::compute_voice_targets(
                                &frame.payload, sid, client.channel_id, &edge_state,
                            ).await {
                                // Shared routing: compute_voice_targets handles VoiceTarget
                                // lookup, channel expansion, and deaf filtering.
                                if targets.is_whisper {
                                    let data_whisper = wrap_udptunnel(&inject_session_into_voice(&frame.payload, sid, 2));
                                    let data_shout   = wrap_udptunnel(&inject_session_into_voice(&frame.payload, sid, 1));
                                    deliver_voice_tcp(&targets.direct_sessions, &data_whisper);
                                    deliver_voice_tcp(&targets.channel_sessions, &data_shout);
                                } else {
                                    let data = wrap_udptunnel(&inject_session_into_voice(&frame.payload, sid, 0));
                                    deliver_voice_tcp(&targets.local_sessions, &data);
                                }

                                // Relay to remote edges via Hub TCP fallback.
                                // The relay payload preserves the original voice_target_id so
                                // each receiving edge applies its own VoiceTarget config.
                                // Spawned as an independent task so the TCP read loop continues
                                // processing (Ping, UserState, etc.) without waiting for Hub RPC.
                                if !targets.relay_edge_ids.is_empty() && edge_state.enable_hub_tcp_fallback {
                                    let relay_payload: bytes::Bytes = inject_session_into_voice(
                                        &frame.payload, sid, voice_target as u8,
                                    ).into();
                                    let hub_relay = Arc::clone(&hub_client);
                                    let relay_ids = targets.relay_edge_ids.clone();
                                    tokio::spawn(async move {
                                        for target_edge_id in relay_ids {
                                            hub_relay.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                                        }
                                    });
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
                                use crate::state::{VoiceTargetChannelConfig, VoiceTargetConfig, resolve_voice_target_channels};
                                use std::collections::HashMap;
                                if vt.targets.is_empty() {
                                    let hot_map_opt = {
                                        let mut vt_cache = edge_state.voice_targets.write().await;
                                        if let Some(session_vts) = vt_cache.get_mut(&sid) {
                                            session_vts.remove(&(target_id as u32));
                                            if session_vts.is_empty() { None }
                                            else {
                                                Some(build_hot_vt_map(session_vts))
                                            }
                                        } else { None }
                                    };
                                    crate::hot_slot::get_hot_slot(sid).voice_targets.store(
                                        std::sync::Arc::new(hot_map_opt.map(std::sync::Arc::new)),
                                    );
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
                                    // Pre-compute expanded channel set outside the write lock
                                    let resolved = resolve_voice_target_channels(&vt_channels, &edge_state.channel_manager).await;
                                    let hot_map = {
                                        let mut vt_cache = edge_state.voice_targets.write().await;
                                        let session_vts = vt_cache.entry(sid).or_insert_with(HashMap::new);
                                        session_vts.insert(target_id as u32, VoiceTargetConfig {
                                            sessions: vt_sessions.clone(),
                                            channels: vt_channels,
                                            resolved_channels: resolved.clone(),
                                        });
                                        build_hot_vt_map(session_vts)
                                    };
                                    crate::hot_slot::get_hot_slot(sid).voice_targets.store(
                                        std::sync::Arc::new(Some(std::sync::Arc::new(hot_map))),
                                    );
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
                            let is_stats_only = stats.stats_only.unwrap_or(false);
                            let is_self = target_session == requester_sid;

                            // Full stats (stats_only=false) for a *different* user expose the IP
                            // address and other sensitive fields.  Require WRITE on the root
                            // channel (i.e. server admin) before proceeding.
                            if !is_stats_only && !is_self {
                                let has_perm = get_perm_cached(&hub_client, &edge_state, requester_sid, 0, false).await
                                    & perm::WRITE != 0;
                                if !has_perm {
                                    let pd = mumbleproto::PermissionDenied {
                                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                        channel_id: Some(0),
                                        ..Default::default()
                                    };
                                    client_sender.send_message(MessageType::PermissionDenied, &pd).await;
                                    continue;
                                }
                            }

                            if let Some(target) = edge_state.client_manager.get_client(target_session).await {
                                // from_client = server's local crypt stats (how server received from client).
                                // from_server = client-reported stats (how client received from server) —
                                //               stored in ClientInfo.remote_* from Ping messages.
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

                                // Fetch bandwidth stats: bytes-per-second in the last slot.
                                let bps_last =
                                    edge_state.client_manager.get_bandwidth_stats(target_session).await;
                                // Fetch ping stats (stored in per-session Mutex, not in ClientInfo).
                                let ping_stats = edge_state.client_manager
                                    .get_ping_stats(target_session).await
                                    .unwrap_or_default();

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
                                            good: Some(ping_stats.remote_good),
                                            late: Some(ping_stats.remote_late),
                                            lost: Some(ping_stats.remote_lost),
                                            resync: Some(ping_stats.remote_resync),
                                        }),
                                        udp_packets: Some(ping_stats.udp_packets),
                                        tcp_packets: Some(ping_stats.tcp_packets),
                                        udp_ping_avg: Some(ping_stats.udp_ping_avg),
                                        udp_ping_var: Some(ping_stats.udp_ping_var),
                                        tcp_ping_avg: Some(ping_stats.tcp_ping_avg),
                                        tcp_ping_var: Some(ping_stats.tcp_ping_var),
                                        onlinesecs: Some(onlinesecs),
                                        idlesecs: Some(idlesecs),
                                        bandwidth: Some(bps_last * 8), // bytes→bits per second
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
                                            good: Some(ping_stats.remote_good),
                                            late: Some(ping_stats.remote_late),
                                            lost: Some(ping_stats.remote_lost),
                                            resync: Some(ping_stats.remote_resync),
                                        }),
                                        udp_packets: Some(ping_stats.udp_packets),
                                        tcp_packets: Some(ping_stats.tcp_packets),
                                        udp_ping_avg: Some(ping_stats.udp_ping_avg),
                                        udp_ping_var: Some(ping_stats.udp_ping_var),
                                        tcp_ping_avg: Some(ping_stats.tcp_ping_avg),
                                        tcp_ping_var: Some(ping_stats.tcp_ping_var),
                                        address: Some(addr_bytes),
                                        onlinesecs: Some(onlinesecs),
                                        idlesecs: Some(idlesecs),
                                        bandwidth: Some(bps_last * 8), // bytes→bits per second
                                        opus: Some(target.opus_supported),
                                        strong_certificate: Some(target.cert_hash.is_some()),
                                        celt_versions: vec![],
                                        version: Some(mumbleproto::Version {
                                            version: target.client_version,
                                            release: if target.client_release.is_empty() { None } else { Some(target.client_release.clone()) },
                                            os: if target.client_os.is_empty() { None } else { Some(target.client_os.clone()) },
                                            os_version: if target.client_os_version.is_empty() { None } else { Some(target.client_os_version.clone()) },
                                        }),
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

                        // Forward to Hub (with local cache to skip redundant round-trips)
                        let hub = hub_client.clone();
                        let sender = client_sender.clone();
                        let state_pq = Arc::clone(&edge_state);
                        tokio::spawn(async move {
                            let perms = get_perm_cached(&hub, &*state_pq, sid, channel_id, true).await;
                            let response = mumbleproto::PermissionQuery {
                                channel_id: Some(channel_id),
                                permissions: Some(perms),
                                flush: Some(false),
                            };
                            sender.send_message(MessageType::PermissionQuery, &response).await;
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

                    if let Some(sid) = session_id {
                        let hub = hub_client.clone();
                        let has_links = !ch_state.links_add.is_empty() || !ch_state.links_remove.is_empty();
                        if has_links {
                            // Link/unlink request — requires LINK_CHANNEL on the source channel.
                            if let Some(ch_id) = ch_state.channel_id {
                                let has_link = get_perm_cached(&hub_client, &edge_state, sid, ch_id, false).await
                                    & perm::LINK_CHANNEL != 0;
                                if !has_link {
                                    let pq = mumbleproto::PermissionDenied {
                                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                        channel_id: Some(ch_id),
                                        ..Default::default()
                                    };
                                    client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                    continue;
                                }
                                hub.notify_channel_state(ch_id, ch_state.links_add, ch_state.links_remove).await;
                            }
                        } else {
                            let is_new = ch_state.channel_id.is_none();
                            let target_parent = if is_new {
                                ch_state.parent.unwrap_or(0)
                            } else {
                                // Edit: check WRITE on the channel being edited
                                ch_state.channel_id.unwrap_or(0)
                            };
                            let required_perm = if is_new { perm::MAKE_CHANNEL } else { perm::WRITE };
                            let has_perm = get_perm_cached(&hub_client, &edge_state, sid, target_parent, false).await
                                & required_perm != 0;
                            if !has_perm {
                                let pq = mumbleproto::PermissionDenied {
                                    r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                    channel_id: Some(target_parent),
                                    ..Default::default()
                                };
                                client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                continue;
                            }
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
                }
                MessageType::ChannelRemove if client_state == ClientState::Ready => {
                    // Client requesting channel removal - requires WRITE on the channel
                    let Ok(ch_remove) = mumbleproto::ChannelRemove::decode(&frame.payload[..]) else { continue; };
                    debug!("ChannelRemove from {}: channel_id={}", peer_addr, ch_remove.channel_id);

                    if let Some(sid) = session_id {
                        if ch_remove.channel_id == 0 {
                            // Root channel cannot be removed
                            continue;
                        }
                        let has_write = get_perm_cached(&hub_client, &edge_state, sid, ch_remove.channel_id, false).await
                            & perm::WRITE != 0;
                        if !has_write {
                            let pq = mumbleproto::PermissionDenied {
                                r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                channel_id: Some(ch_remove.channel_id),
                                ..Default::default()
                            };
                            client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                            continue;
                        }
                        let hub = hub_client.clone();
                        tokio::spawn(async move {
                            hub.notify_channel_remove(ch_remove.channel_id).await;
                        });
                    }
                }
                MessageType::BanList if client_state == ClientState::Ready => {
                    // BanList query/update — forward to Hub which enforces permissions
                    // authoritatively.  Actor info is passed so Hub can check WRITE (query)
                    // or BAN (update) on the root channel without a separate permission_query
                    // RPC, reducing the total round-trip count from 2 (pre-check + ban RPC)
                    // to 1 (ban RPC with embedded actor info).
                    let Ok(ban_list) = mumbleproto::BanList::decode(&frame.payload[..]) else { continue; };
                    debug!("BanList from {}: query={:?}, {} entries", peer_addr, ban_list.query, ban_list.bans.len());
                    let sid = session_id.unwrap_or(0);
                    let actor_user_id = edge_state.client_manager.get_client(sid).await
                        .map(|c| c.user_id).unwrap_or(0);
                    if ban_list.query.unwrap_or(false) {
                        let hub = hub_client.clone();
                        let sender = client_sender.clone();
                        tokio::spawn(async move {
                            match hub.rpc_get_ban_list(sid, actor_user_id).await {
                                Ok(raw_data) => {
                                    if let Ok(ban_resp) = mumbleproto::BanList::decode(raw_data.as_slice()) {
                                        sender.send_message(MessageType::BanList, &ban_resp).await;
                                    }
                                }
                                Err(true) => {
                                    // Hub explicitly denied: no WRITE on root channel
                                    let pq = mumbleproto::PermissionDenied {
                                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                        channel_id: Some(0),
                                        ..Default::default()
                                    };
                                    sender.send_message(MessageType::PermissionDenied, &pq).await;
                                }
                                Err(false) => {
                                    warn!("Failed to get ban list from Hub (session={})", sid);
                                }
                            }
                        });
                    } else {
                        let raw = frame.payload.to_vec();
                        let hub = hub_client.clone();
                        let sender = client_sender.clone();
                        tokio::spawn(async move {
                            match hub.rpc_update_ban_list(&raw, sid, actor_user_id).await {
                                Ok(()) => {}
                                Err(true) => {
                                    // Hub explicitly denied: no BAN on root channel
                                    let pq = mumbleproto::PermissionDenied {
                                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                        channel_id: Some(0),
                                        ..Default::default()
                                    };
                                    sender.send_message(MessageType::PermissionDenied, &pq).await;
                                }
                                Err(false) => {
                                    warn!("Failed to update ban list on Hub (session={})", sid);
                                }
                            }
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

                    // Permission gate: actor must have Write on the target channel OR on the root
                    // channel (mirrors Murmur's msgACL check — root-Write lets admins manage every
                    // channel even if a sub-channel creator denied them Write there).
                    let has_ch_write = get_perm_cached(&hub_client, &edge_state, sid, ch_id, false).await
                        & perm::WRITE != 0;
                    let has_write = if has_ch_write {
                        true
                    } else {
                        get_perm_cached(&hub_client, &edge_state, sid, 0, false).await & perm::WRITE != 0
                    };
                    if !has_write {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                            channel_id: Some(ch_id),
                            ..Default::default()
                        };
                        client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                        continue;
                    }

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
                    if let Some(sid) = session_id {
                        // Both query and update require REGISTER permission on root channel.
                        let has_register = get_perm_cached(&hub_client, &edge_state, sid, 0, false).await
                            & perm::REGISTER != 0;
                        if !has_register {
                            let pq = mumbleproto::PermissionDenied {
                                r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                channel_id: Some(0),
                                ..Default::default()
                            };
                            client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                            continue;
                        }
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
                // ContextAction: client clicked a registered context menu item.
                // Forward the action to Hub as a fire-and-forget notification so that
                // any registered callback (ICE replacement, Lua hook, etc.) is invoked.
                MessageType::ContextAction if client_state == ClientState::Ready => {
                    let Ok(ca) = mumbleproto::ContextAction::decode(&frame.payload[..]) else { continue; };
                    if let Some(sid) = session_id {
                        debug!(
                            session = sid,
                            action = ca.action.as_str(),
                            actor = ca.session.unwrap_or(0),
                            channel = ca.channel_id.unwrap_or(0),
                            "ContextAction received"
                        );
                        hub_client.notify_context_action(sid, ca).await;
                    }
                }
                MessageType::Authenticate if client_state == ClientState::Ready => {
                    // Token update while already authenticated: updating tokens requires new
                    // Hub RPCs (re-evaluate ACLs, broadcast ChannelState). Not yet supported.
                    debug!("Client {} sent Authenticate in Ready state (token update not yet supported)", peer_addr);
                }
                other => {
                    debug!("Unhandled message type {:?} from {} (state={:?})", other, peer_addr, client_state);
                }            }
        }
    }

    // Cleanup
    if let Some(sid) = session_id {
        // Save channel listeners before removing the client (so we still have access to the data).
        // Always persist even when the list is empty, so that a user who explicitly cleared all
        // listeners has that "no listeners" state saved (overwriting any previously stored state).
        if let Some(client) = edge_state.client_manager.get_client(sid).await {
            if client.user_id > 0 {
                let user_id = client.user_id;
                let channels = client.listening_channels.clone();
                hub_client.save_channel_listeners(user_id, channels).await;
            }
        }

        edge_state.client_manager.remove_client(sid).await;
        // Invalidate BroadcastCaches: a user left, routing targets changed.
        edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
        // Free the session ID back to the local pool
        edge_state.free_session_id(sid).await;
        // Clean up voice target cache for this session
        edge_state.voice_targets.write().await.remove(&sid);
        // Clean up permission cache for this session
        edge_state.permission_cache.retain(|&(s, _), _| s != sid);
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

    // Gracefully drain any pending outgoing messages (e.g. a Reject sent on auth
    // failure) before the TCP connection is closed.  Dropping the sender closes
    // the channel; the writer task will exit after flushing its queue.
    // A 5-second timeout prevents hanging forever when the socket is already dead.
    drop(client_sender);
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        writer_handle,
    ).await;
    Ok(())
}

/// Handle a UserState update from a local client.
pub(super) async fn handle_user_state_update(
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
                let can_enter = get_perm_cached(&hub_client, &edge_state, session_id, target_channel_id, true).await
                    & perm::ENTER != 0;
                if can_enter {
                    // Compute the effective user limit for the target channel before
                    // any locks are held, so we only need to pass it to the atomic move.
                    let effective_limit = if let Some(ch) = edge_state.channel_manager.get_channel(target_channel_id).await {
                        if ch.max_users > 0 {
                            ch.max_users
                        } else {
                            let hub_limits = edge_state.hub_limits.read().await;
                            hub_limits.as_ref().and_then(|l| {
                                if l.max_users_per_channel.unwrap_or(0) > 0 {
                                    l.max_users_per_channel
                                } else {
                                    None
                                }
                            }).unwrap_or(0)
                        }
                    } else {
                        0
                    };

                    // Check Speak permission before the atomic move so we know the
                    // suppress flag to set without holding any internal locks.
                    let can_speak = get_perm_cached(&hub_client, &edge_state, session_id, target_channel_id, true).await
                        & perm::SPEAK != 0;
                    let new_suppress = !can_speak;

                    debug!("User {} moving to channel {}", session_id, target_channel_id);

                    // Atomically check capacity and update channel membership.
                    // This replaces the previous non-atomic count_in_channel + move_client_to_channel
                    // pattern, which was susceptible to a TOCTOU race where multiple concurrent tasks
                    // could all observe "channel not full" and all complete the move, exceeding the limit.
                    match edge_state.client_manager.move_client_to_channel_checked(
                        session_id, target_channel_id, new_suppress, effective_limit,
                    ).await {
                        Ok(()) => {
                            suppress_changed = new_suppress != client.suppress;
                            client.channel_id = target_channel_id;
                            client.suppress = new_suppress;
                            needs_broadcast = true;
                            channel_moved = true;
                        }
                        Err(()) => {
                            // Atomic capacity check failed: channel is full.
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
                    }
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
                // Check per-user listener limit using the local clone's length;
                // add_listener_checked keeps sessions in sync so the length is accurate
                // even for channels added earlier in this same loop.
                let per_user_limit = edge_state.listeners_per_user.load(std::sync::atomic::Ordering::Relaxed);
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

                // Check Listen permission (0x800) before the atomic add.
                let can_listen = get_perm_cached(&hub_client, &edge_state, session_id, ch, true).await
                    & perm::LISTEN != 0;
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

                // Atomically check per-channel capacity and register the listener.
                // This replaces the previous non-atomic get_listening_count + deferred
                // update_client pattern, eliminating the TOCTOU race where multiple tasks
                // could both observe "channel has room" and both complete the add.
                let per_channel_limit = edge_state.listeners_per_channel.load(std::sync::atomic::Ordering::Relaxed);
                let added = edge_state.client_manager
                    .add_listener_checked(session_id, ch, per_channel_limit)
                    .await;

                if added {
                    // Keep the local client clone in sync so the per-user limit check
                    // above remains accurate for subsequent channels in this loop.
                    if !client.listening_channels.contains(&ch) {
                        client.listening_channels.push(ch);
                    }
                    actually_added_channels.push(ch);
                } else {
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

        // Positional audio plugin context update
        if let Some(ref ctx) = user_state.plugin_context {
            edge_state.client_manager.update_plugin_context(session_id, ctx.clone()).await;
        }

        // Texture / comment blob updates (upload to Hub and broadcast hash to peers)
        if let Some(texture_data) = &user_state.texture {
            // Enforce image_message_length limit on texture uploads
            let image_limit = edge_state.hub_limits.read().await
                .as_ref()
                .and_then(|l| l.image_message_length)
                .unwrap_or(0);
            if image_limit > 0 && texture_data.len() as u32 > image_limit {
                warn!("Session {} texture too large ({} > {} bytes), rejecting",
                      session_id, texture_data.len(), image_limit);
                if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::TextTooLong as i32),
                        reason: Some(format!("Texture too large: {} > {} bytes", texture_data.len(), image_limit)),
                        ..Default::default()
                    };
                    sender.send_message(MessageType::PermissionDenied, &pq).await;
                }
            } else if !texture_data.is_empty() {
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
            // Enforce image_message_length limit on comment uploads (same limit as Murmur)
            let image_limit = edge_state.hub_limits.read().await
                .as_ref()
                .and_then(|l| l.image_message_length)
                .unwrap_or(0);
            if image_limit > 0 && comment.len() as u32 > image_limit {
                warn!("Session {} comment too large ({} > {} bytes), rejecting",
                      session_id, comment.len(), image_limit);
                if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::TextTooLong as i32),
                        reason: Some(format!("Comment too large: {} > {} bytes", comment.len(), image_limit)),
                        ..Default::default()
                    };
                    sender.send_message(MessageType::PermissionDenied, &pq).await;
                }
            } else {
            let uid = client.user_id;
            let data = comment.as_bytes().to_vec();
            let data_len = data.len();
            if data_len > 128 {
                // Long comments: persist to blob store and broadcast the hash so
                // peers can request the full text via RequestBlob.
                if let Some(hash_hex) = hub_client.blob_set_user_comment(uid, data).await {
                    if let Some(hash_bytes) = hex_to_bytes(&hash_hex) {
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
            } else {
                // Short comments: broadcast inline immediately.  Also persist to
                // blob store for later retrieval, but don't gate the broadcast on it.
                let inline_msg = mumbleproto::UserState {
                    session: Some(session_id),
                    actor: Some(session_id),
                    comment: Some(comment.clone()),
                    ..Default::default()
                };
                client.comment_hash = None;
                edge_state.client_manager.update_client(client.clone()).await;
                edge_state.client_manager.broadcast(MessageType::UserState, &inline_msg, None).await;
                hub_client.blob_set_user_comment(uid, data).await;
            }
            } // end of else (size limit check)
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
            // Invalidate BroadcastCaches: channel/deaf/listener state changed.
            edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);

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
pub(super) async fn handle_admin_user_state_update(
    edge_state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
    actor_session: u32,
    target_session: u32,
    user_state: &mumbleproto::UserState,
) {
    if let Some(mut client) = edge_state.client_manager.get_client(target_session).await {
        let mut needs_broadcast = false;

        // Admin mute/deaf — requires MuteDeafen permission on the victim's channel
        if user_state.mute.is_some() || user_state.deaf.is_some() {
            let has_mute_deafen = get_perm_cached(&hub_client, &edge_state, actor_session, client.channel_id, false).await
                & perm::MUTE_DEAFEN != 0;
            if !has_mute_deafen {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        channel_id: Some(client.channel_id),
                        ..Default::default()
                    };
                    sender.send_message(MessageType::PermissionDenied, &pq).await;
                }
                return;
            }
            if let Some(mute) = user_state.mute {
                client.mute = mute;
                needs_broadcast = true;
            }
            if let Some(deaf) = user_state.deaf {
                client.deaf = deaf;
                needs_broadcast = true;
            }
        }

        // Admin channel move (drag user to another channel)
        let mut channel_moved = false;
        let mut suppress_changed = false;
        if let Some(target_channel_id) = user_state.channel_id {
            if client.channel_id != target_channel_id {
                // Check 1: actor needs Move permission in the victim's current channel
                // (mirrors Murmur: "!hasPermission(uSource, pDstServerUser->cChannel, ChanACL::Move)").
                let actor_can_move_out = get_perm_cached(&hub_client, &edge_state, actor_session, client.channel_id, false).await
                    & perm::MOVE != 0;
                if !actor_can_move_out {
                    if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                            channel_id: Some(client.channel_id),
                            ..Default::default()
                        };
                        sender.send_message(MessageType::PermissionDenied, &pq).await;
                    }
                    return;
                }

                // Check 2: actor has Move in the target channel OR victim has Enter there
                // (mirrors Murmur: "!hasPermission(uSource, c, Move) && !hasPermission(pDst, c, Enter)").
                let actor_can_move_in = get_perm_cached(&hub_client, &edge_state, actor_session, target_channel_id, false).await
                    & perm::MOVE != 0;
                let victim_can_enter = get_perm_cached(&hub_client, &edge_state, target_session, target_channel_id, false).await
                    & perm::ENTER != 0;
                if !actor_can_move_in && !victim_can_enter {
                    if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                            channel_id: Some(target_channel_id),
                            ..Default::default()
                        };
                        sender.send_message(MessageType::PermissionDenied, &pq).await;
                    }
                    return;
                }

                // Re-check suppress for the new channel
                let can_speak = get_perm_cached(&hub_client, &edge_state, target_session, target_channel_id, true).await
                    & perm::SPEAK != 0;
                let new_suppress = !can_speak;
                suppress_changed = new_suppress != client.suppress;
                client.channel_id = target_channel_id;
                client.suppress = new_suppress;
                // Move in-place: preserves close-signal, crypt-state, and bandwidth record
                // so the TCP read loop is not interrupted by the admin-initiated move.
                edge_state.client_manager.move_client_to_channel(target_session, target_channel_id, new_suppress).await;
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
            // Invalidate BroadcastCaches: admin changed channel/deaf state.
            edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
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
    } else if let Some(target_channel_id) = user_state.channel_id {
        // Target user is not on this edge — check if it is a known remote user and
        // forward the admin move to Hub so the owner edge can apply it.
        let remote_user = edge_state.channel_manager.get_remote_user(target_session).await;
        if let Some(remote) = remote_user {
            if remote.channel_id == target_channel_id {
                return; // already in target channel, nothing to do
            }

            // Permission check 1: actor must have Move in victim's current channel.
            let actor_can_move_out = get_perm_cached(&hub_client, &edge_state, actor_session, remote.channel_id, false).await
                & perm::MOVE != 0;
            if !actor_can_move_out {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        channel_id: Some(remote.channel_id),
                        ..Default::default()
                    };
                    sender.send_message(MessageType::PermissionDenied, &pq).await;
                }
                return;
            }

            // Permission check 2: actor has Move in target OR victim has Enter there.
            let actor_can_move_in = get_perm_cached(&hub_client, &edge_state, actor_session, target_channel_id, false).await
                & perm::MOVE != 0;
            let victim_can_enter = get_perm_cached(&hub_client, &edge_state, target_session, target_channel_id, false).await
                & perm::ENTER != 0;
            if !actor_can_move_in && !victim_can_enter {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        channel_id: Some(target_channel_id),
                        ..Default::default()
                    };
                    sender.send_message(MessageType::PermissionDenied, &pq).await;
                }
                return;
            }

            // Permissions OK: forward to Hub. Hub updates session state and broadcasts
            // hub.userMoved to all edges; the owner edge will apply the actual move.
            hub_client.notify_user_moved(target_session, target_channel_id, actor_session).await;
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
        // Collect all channels in the tree (including sub-channels recursively)
        let mut all_channel_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
        let mut to_visit: std::collections::VecDeque<u32> = text_msg.tree_id.iter().copied().collect();
        while let Some(ch_id) = to_visit.pop_front() {
            if all_channel_ids.insert(ch_id) {
                let children = edge_state.channel_manager.get_children(ch_id).await;
                for child in children {
                    to_visit.push_back(child);
                }
            }
        }
        for ch_id in all_channel_ids {
            edge_state.client_manager.broadcast_to_channel(
                ch_id,
                MessageType::TextMessage,
                &msg,
                Some(sender_session),
            ).await;
        }
    }
}

/// Broadcast CodecVersion (Opus-only) to all clients.
/// This server only supports Opus; CELT is not supported.
async fn broadcast_codec_version(edge_state: &Arc<EdgeState>) {
    let msg = mumbleproto::CodecVersion {
        alpha: 0,
        beta: 0,
        prefer_alpha: false,
        opus: Some(true),
    };
    edge_state.client_manager.broadcast(MessageType::CodecVersion, &msg, None).await;
}

/// Strip HTML tags from a string (simple tag removal for Mumble text messages).
fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
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

/// Decode a Mumble varint from a byte slice.
/// Returns (value, bytes_consumed) or None if insufficient data.
pub(crate) fn decode_mumble_varint(data: &[u8]) -> Option<(u32, usize)> {
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
/// Convert a `HashMap<u32, VoiceTargetConfig>` to a `HotVoiceTargetMap` for storage in
/// `HotSlot::voice_targets`.  Called after every VoiceTarget cache write so the routing
/// hot path can read voice-target configs without holding `EdgeState::voice_targets`.
fn build_hot_vt_map(
    session_vts: &std::collections::HashMap<u32, crate::state::VoiceTargetConfig>,
) -> crate::hot_slot::HotVoiceTargetMap {
    session_vts
        .iter()
        .map(|(&tid, vt)| {
            (tid, crate::hot_slot::HotVoiceTarget {
                sessions: vt.sessions.clone(),
                resolved_channels: vt.resolved_channels.clone(),
            })
        })
        .collect()
}

/// Query Hub for a permission bitmask with a local DashMap cache.
///
/// Returns the cached value if present; otherwise calls `handle_permission_query`
/// and stores the result.  On Hub error the result is **not cached** so the next
/// call retries; the caller receives `fail_open` (all bits set for open, 0 for closed).
pub(crate) async fn get_perm_cached(
    hub_client: &crate::hub_client::HubClient,
    edge_state: &crate::state::EdgeState,
    session: u32,
    channel: u32,
    fail_open: bool,
) -> u32 {
    if let Some(v) = edge_state.permission_cache.get(&(session, channel)) {
        return *v;
    }
    match hub_client.handle_permission_query(session, channel).await {
        Ok(r) => {
            let bitmask = r.permissions.unwrap_or(if fail_open { u32::MAX } else { 0 });
            edge_state.permission_cache.insert((session, channel), bitmask);
            bitmask
        }
        Err(_) => {
            if fail_open { u32::MAX } else { 0 }
        }
    }
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
    use crate::server::event_listener::hub_event_listener;
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
                proxy_protocol: false,
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
            client_version: None,
            client_release: String::new(),
            client_os: String::new(),
            client_os_version: String::new(),
            plugin_context: vec![],
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
        let (tx_a, mut rx_a) = mpsc::channel::<bytes::Bytes>(16);
        let (tx_b, mut rx_b) = mpsc::channel::<bytes::Bytes>(16);
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

        let (tx_a, mut rx_a) = mpsc::channel::<bytes::Bytes>(16);
        let (tx_b, mut rx_b) = mpsc::channel::<bytes::Bytes>(16);
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

        let (tx_a, mut rx_a) = mpsc::channel::<bytes::Bytes>(16);
        let (tx_b, mut rx_b) = mpsc::channel::<bytes::Bytes>(16);
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

        let (tx_a, mut rx_a) = mpsc::channel::<bytes::Bytes>(16);
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

        let (tx_a, mut rx_a) = mpsc::channel::<bytes::Bytes>(16);
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

        // Grant admin (session 1) MUTE_DEAFEN permission on channel 0.
        es.permission_cache.insert((1, 0), perm::MUTE_DEAFEN);

        let (tx_admin, mut rx_admin) = mpsc::channel::<bytes::Bytes>(16);
        let (tx_target, mut rx_target) = mpsc::channel::<bytes::Bytes>(16);
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
            let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);
            let hub_client = HubClient::new(&test_config(), es2.clone());
            hub_event_listener(es2, &mut rx, shutdown_tx, hub_client).await;
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
        let (tx_obs, mut rx_obs) = mpsc::channel::<bytes::Bytes>(16);
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

        let (tx_obs, mut rx_obs) = mpsc::channel::<bytes::Bytes>(16);
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

        let (tx_obs, mut rx_obs) = mpsc::channel::<bytes::Bytes>(16);
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

        let (tx_obs, mut rx_obs) = mpsc::channel::<bytes::Bytes>(16);
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

    // -----------------------------------------------------------------------
    // Test: admin channel-move is DENIED when Hub is unreachable.
    //
    // When the Hub cannot be reached, all permission queries fail with Err,
    // which our code maps to `false` (fail-closed).  The two Move/Enter checks
    // therefore both return false → PermissionDenied is sent to the actor and
    // the victim stays in its original channel.
    //
    // This test verifies the denial path of the two-step Move permission check
    // added to mirror Murmur's msgUserState behaviour:
    //   1. actor needs Move in victim's current channel   (check 1)
    //   2. actor needs Move OR victim needs Enter in target (check 2)
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_admin_move_denied_when_hub_unreachable() {
        let (es, hub) = test_edge_and_hub(); // HubClient has no real connection

        let (tx_admin, mut rx_admin) = mpsc::channel::<bytes::Bytes>(16);
        let (tx_victim, _rx_victim) = mpsc::channel::<bytes::Bytes>(16);

        // Admin in channel 0, victim starts in channel 0.
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_admin)).await;
        es.client_manager.add_client(ready_client(2, 0), ClientSender::new(tx_victim)).await;

        // Admin tries to drag victim to channel 1.
        let us = mumbleproto::UserState {
            session: Some(2),
            channel_id: Some(1),
            ..Default::default()
        };
        handle_admin_user_state_update(&es, &hub, 1, 2, &us).await;

        // Admin must receive PermissionDenied (not UserState).
        let raw = rx_admin.recv().await.expect("admin must receive a message");
        let mut buf = BytesMut::from(&raw[..]);
        let frame = decode_frame(&mut buf).unwrap().unwrap();
        assert_eq!(
            frame.message_type,
            MessageType::PermissionDenied,
            "admin must receive PermissionDenied when Hub is unreachable"
        );
        let pq = mumbleproto::PermissionDenied::decode(&frame.payload[..]).unwrap();
        assert_eq!(
            pq.r#type,
            Some(mumbleproto::permission_denied::DenyType::Permission as i32),
            "must be a generic Permission denial"
        );

        // Victim must NOT have been moved.
        let victim = es.client_manager.get_client(2).await.unwrap();
        assert_eq!(victim.channel_id, 0, "victim must remain in channel 0");
    }

    // -----------------------------------------------------------------------
    // Test: admin mute-only op still succeeds even when Hub is unreachable.
    //
    // The Move permission checks only run when channel_id is present in the
    // UserState message.  A pure mute/unmute operation (no channel_id) must
    // NOT be gated by Hub permission queries.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_admin_mute_without_move_succeeds_when_hub_unreachable() {
        let (es, hub) = test_edge_and_hub();

        // Grant admin (session 1) MUTE_DEAFEN permission on channel 0.
        es.permission_cache.insert((1, 0), perm::MUTE_DEAFEN);

        let (tx_admin, mut rx_admin) = mpsc::channel::<bytes::Bytes>(16);
        let (tx_victim, mut rx_victim) = mpsc::channel::<bytes::Bytes>(16);
        es.client_manager.add_client(ready_client(1, 0), ClientSender::new(tx_admin)).await;
        es.client_manager.add_client(ready_client(2, 0), ClientSender::new(tx_victim)).await;

        // Admin mutes victim (no channel_id → no Move perm check).
        let us = mumbleproto::UserState {
            session: Some(2),
            mute: Some(true),
            ..Default::default()
        };
        handle_admin_user_state_update(&es, &hub, 1, 2, &us).await;

        // Both admin and victim must receive UserState (not PermissionDenied).
        let msg_admin = decode_user_state(&rx_admin.recv().await.unwrap());
        assert_eq!(msg_admin.mute, Some(true), "admin: victim mute must propagate");

        let msg_victim = decode_user_state(&rx_victim.recv().await.unwrap());
        assert_eq!(msg_victim.mute, Some(true), "victim: must be notified of mute");

        let victim = es.client_manager.get_client(2).await.unwrap();
        assert!(victim.mute, "victim.mute must be updated");
    }
}

