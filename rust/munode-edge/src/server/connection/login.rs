//! Login task: authentication sequence for new client connections.
use super::helpers::{broadcast_codec_version, get_perm_cached};
use crate::client::{ClientInfo, ClientSender, ClientState};
use crate::handler::{self, LoginHandler, LoginInfo};
use crate::hub_client::HubClient;
use crate::state::EdgeState;
use munode_common::config::EdgeConfig;
use munode_common::permission;
use munode_protocol::hubedge;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use tracing::{debug, error, info, warn};

pub(super) struct LoginTaskResult {
    pub(super) session_id: u32,
    /// Data needed by the outer loop to send ServerSync / ServerConfig after
    /// transitioning the client state to `Ready`.
    pub(super) login_info: LoginInfo,
    /// The `ClientSender` used during the login task, returned so the outer
    /// loop can call the final send methods on it.
    pub(super) client_sender: ClientSender,
    /// EdgeConfig clone, needed to compose ServerSync / ServerConfig.
    pub(super) config: EdgeConfig,
    /// Persisted channel listeners to restore once the client transitions to
    /// `Ready`.  Empty when the user is a guest, has no saved listeners, or the
    /// client version is below `MIN_CHANNEL_LISTENER_VERSION`.
    pub(super) saved_listeners: Vec<u32>,
}

/// Arguments passed into the spawned login task.
pub(super) struct LoginTaskArgs {
    /// Session ID pre-allocated by the outer loop before spawning.  The outer
    /// loop tracks this immediately, so TCP-disconnect cleanup can proceed
    /// without waiting for the task to return.
    pub(super) session_id: u32,
    pub(super) hub_client: Arc<HubClient>,
    pub(super) edge_state: Arc<EdgeState>,
    pub(super) client_sender: ClientSender,
    pub(super) config: EdgeConfig,
    pub(super) peer_addr: SocketAddr,
    /// oneshot sender consumed by `register_close_signal`.
    pub(super) close_tx: tokio::sync::oneshot::Sender<()>,
    pub(super) username: String,
    pub(super) password: String,
    pub(super) tokens: Vec<String>,
    pub(super) opus: bool,
    pub(super) preconnect_self_mute: Option<bool>,
    pub(super) preconnect_self_deaf: Option<bool>,
    pub(super) client_version: Option<u32>,
    pub(super) client_release: String,
    pub(super) client_os: String,
    pub(super) client_os_version: String,
    pub(super) certificate_hash: Option<String>,
    /// Raw DER-encoded client certificate chain from TLS handshake.
    pub(super) client_cert_chain: Vec<Vec<u8>>,
    /// When `true`, skip sending `CryptSetup` during the login sequence.
    /// Set for WebTransport and WebSocket transports that provide their own
    /// transport-layer encryption (QUIC TLS 1.3 / wss://).
    pub(super) skip_crypt_setup: bool,
}

struct ChannelAccessDisplayWorkerJob {
    session_id: u32,
    channel_ids: Vec<u32>,
    client_sender: ClientSender,
    edge_state: Arc<EdgeState>,
    hub_client: Arc<HubClient>,
}

#[derive(Clone)]
struct ChannelAccessDisplayWorker {
    tx: std::sync::mpsc::Sender<ChannelAccessDisplayWorkerJob>,
}

impl ChannelAccessDisplayWorker {
    fn shared() -> &'static Self {
        static WORKER: OnceLock<ChannelAccessDisplayWorker> = OnceLock::new();
        WORKER.get_or_init(Self::new)
    }

    fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<ChannelAccessDisplayWorkerJob>();
        std::thread::Builder::new()
            .name("edge-channel-access-display".to_string())
            .spawn(move || {
                apply_display_worker_priority();
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("failed to build edge display worker runtime");
                while let Ok(job) = rx.recv() {
                    runtime.block_on(process_channel_access_display_job(job));
                }
            })
            .expect("failed to spawn edge display worker thread");
        Self { tx }
    }

    fn enqueue(&self, job: ChannelAccessDisplayWorkerJob) -> bool {
        self.tx.send(job).is_ok()
    }
}

fn apply_display_worker_priority() {
    #[cfg(unix)]
    {
        // Alpine containers run on musl/Linux. Increasing niceness is the most
        // deployment-friendly way to lower priority without extra capabilities.
        let rc = unsafe { nix::libc::setpriority(nix::libc::PRIO_PROCESS, 0, 10) };
        if rc != 0 {
            let error = std::io::Error::last_os_error();
            warn!(%error, "channel access display worker could not lower its priority");
        } else {
            debug!("channel access display worker running at nice=10");
        }
    }
}

async fn process_channel_access_display_job(job: ChannelAccessDisplayWorkerJob) {
    match job
        .hub_client
        .batch_permission_query(job.session_id, &job.channel_ids)
        .await
    {
        Ok(result) if result.success => {
            for entry in result.entries {
                let is_enter_restricted = entry.is_enter_restricted.unwrap_or(false);
                job.edge_state
                    .permission_cache
                    .insert((job.session_id, entry.channel_id), entry.permissions);
                job.edge_state
                    .enter_restricted_cache
                    .insert(entry.channel_id, is_enter_restricted);

                let msg = mumbleproto::ChannelState {
                    channel_id: Some(entry.channel_id),
                    can_enter: Some(entry.permissions & permission::ENTER != 0),
                    is_enter_restricted: Some(is_enter_restricted),
                    ..Default::default()
                };
                if !job
                    .client_sender
                    .send_message(MessageType::ChannelState, &msg)
                    .await
                {
                    return;
                }
            }
        }
        Ok(result) => {
            debug!(
                session_id = job.session_id,
                channel_count = job.channel_ids.len(),
                error = result
                    .error
                    .as_deref()
                    .unwrap_or("unknown batch permission failure"),
                "background channel access display refresh failed"
            );
        }
        Err(error) => {
            debug!(
                session_id = job.session_id,
                channel_count = job.channel_ids.len(),
                %error,
                "background channel access display RPC failed"
            );
        }
    }
}

/// Backfill the client-visible channel lock/restricted state after login.
///
/// This path is cache-first on the Edge: warmed entries are sent immediately,
/// and only the remaining channels are queried from the Hub on a dedicated
/// low-priority Edge worker thread.
pub(super) fn spawn_channel_access_display_refresh(
    session_id: u32,
    client_sender: ClientSender,
    edge_state: Arc<EdgeState>,
    hub_client: Arc<HubClient>,
) {
    tokio::spawn(async move {
        let channels = edge_state.channel_manager.get_channels_bfs().await;
        let mut missing_channel_ids = Vec::new();

        for channel in &channels {
            let cached_permissions = edge_state
                .permission_cache
                .get(&(session_id, channel.id))
                .map(|value| *value);
            let cached_enter_restricted = edge_state
                .enter_restricted_cache
                .get(&channel.id)
                .map(|value| *value);

            match (cached_permissions, cached_enter_restricted) {
                (Some(permissions), Some(is_enter_restricted)) => {
                    let msg = mumbleproto::ChannelState {
                        channel_id: Some(channel.id),
                        can_enter: Some(permissions & permission::ENTER != 0),
                        is_enter_restricted: Some(is_enter_restricted),
                        ..Default::default()
                    };
                    if !client_sender
                        .send_message(MessageType::ChannelState, &msg)
                        .await
                    {
                        return;
                    }
                }
                _ => missing_channel_ids.push(channel.id),
            }
        }

        if missing_channel_ids.is_empty() {
            return;
        }

        if !ChannelAccessDisplayWorker::shared().enqueue(ChannelAccessDisplayWorkerJob {
            session_id,
            channel_ids: missing_channel_ids.clone(),
            client_sender,
            edge_state,
            hub_client,
        }) {
            debug!(
                session_id,
                channel_count = missing_channel_ids.len(),
                "channel access display worker unavailable; skipped background refresh"
            );
        }
    });
}

/// Performs the full authentication and login sequence for a new client.
///
/// This is spawned as an independent tokio task so the read loop of
/// `handle_client_connection` remains free to respond to TCP Ping messages
/// while potentially slow Hub RPCs are in flight.
///
/// The session ID is pre-allocated by the caller and passed in via
/// `LoginTaskArgs::session_id`.  The outer loop tracks it immediately so that
/// if the TCP connection drops while this task is in flight, the cleanup code
/// at the bottom of `handle_client_connection` can call `notify_user_left` and
/// `free_session_id` without waiting for this task.
///
/// Returns `Some(LoginTaskResult)` on success.  On failure the function sends a
/// Reject to the client, removes the client from the manager if it was added,
/// and returns `None`.  `free_session_id` and `notify_user_left` are NOT called
/// here — the outer loop handles them unconditionally via the cleanup block.
pub(super) async fn do_login_task(args: LoginTaskArgs) -> Option<LoginTaskResult> {
    let LoginTaskArgs {
        session_id: sid,
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
        client_cert_chain,
        skip_crypt_setup,
    } = args;

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
    let _auth_permit = edge_state
        .auth_semaphore
        .acquire()
        .await
        .expect("auth semaphore closed");
    let auth_result = match hub_client
        .authenticate_user(crate::hub_client::AuthenticateUserRequest {
            session_id: sid,
            username: &username,
            password: &password,
            tokens,
            client_info: Some(client_info),
            preconnect_self_mute,
            preconnect_self_deaf,
        })
        .await
    {
        Ok(result) => result,
        Err(e) => {
            error!("Authentication RPC failed: {:#}", e);
            client_sender
                .send_raw(
                    handler::encode_reject(
                        Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
                        "Authentication failed",
                    )
                    .into(),
                )
                .await;
            return None;
        }
    };

    if !auth_result.success {
        let reason = auth_result
            .reason
            .clone()
            .unwrap_or_else(|| "Authentication denied".to_string());
        info!("Authentication failed for {}: {}", username, reason);
        if auth_result.cert_required.unwrap_or(false) {
            let pd = mumbleproto::PermissionDenied {
                r#type: Some(mumbleproto::permission_denied::DenyType::MissingCertificate as i32),
                session: Some(sid),
                ..Default::default()
            };
            client_sender
                .send_message(MessageType::PermissionDenied, &pd)
                .await;
        }
        client_sender
            .send_raw(
                handler::encode_reject(
                    auth_result.reject_type.map(|t| t as i32).or_else(|| {
                        if auth_result.cert_required.unwrap_or(false) {
                            Some(mumbleproto::reject::RejectType::NoCertificate as i32)
                        } else {
                            None
                        }
                    }),
                    &reason,
                )
                .into(),
            )
            .await;
        return None;
    }

    // Authentication succeeded — build and register the client.
    let channel_id = auth_result
        .channel_id
        .unwrap_or(config.server.default_channel);
    let display_name = auth_result
        .display_name
        .clone()
        .or(auth_result.username.clone())
        .unwrap_or(username.clone());

    info!(
        username = auth_result.username.as_deref().unwrap_or(&username),
        session_id = sid,
        user_id = ?auth_result.user_id,
        channel_id,
        source_ip = %peer_addr.ip(),
        groups = ?auth_result.groups,
        "User authenticated"
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
        client_cert_chain,
    };

    // Add client to manager first so permission queries can resolve user_id.
    edge_state
        .client_manager
        .add_client(client.clone(), client_sender.clone())
        .await;
    // Register the close signal so the main loop can force-disconnect on kick/ban.
    edge_state
        .client_manager
        .register_close_signal(sid, close_tx)
        .await;

    // Helper: remove the client from the manager and return None.
    // free_session_id and notify_user_left are intentionally NOT called here;
    // they are handled unconditionally by the outer loop's cleanup block,
    // which always runs because session_id is pre-allocated and always Some.
    macro_rules! fail {
        () => {{
            edge_state.client_manager.remove_client(sid).await;
            return None;
        }};
    }

    // Check Speak permission for initial channel to determine suppress
    // (done AFTER add_client so hub_client.handle_permission_query gets the right user_id)
    if !auth_result.suppress.unwrap_or(false) {
        let can_speak = get_perm_cached(&hub_client, &edge_state, sid, channel_id, true).await
            & munode_common::permission::SPEAK
            != 0;
        if !can_speak {
            client.suppress = true;
            edge_state
                .client_manager
                .update_client(client.clone())
                .await;
        }
    }

    // Populate ninja channel permission cache for this client BEFORE send_remote_users
    // so that the initial user list is already filtered correctly.
    {
        let ninja_channels = edge_state.ninja_channels.read().await.clone();
        if !ninja_channels.is_empty() {
            let mut visible_set = std::collections::HashSet::new();
            for &ch_id in &ninja_channels {
                let perms = get_perm_cached(&hub_client, &edge_state, sid, ch_id, false).await;
                let can_see = perms
                    & (munode_common::permission::ENTER | munode_common::permission::LISTEN)
                    != 0;
                if can_see {
                    visible_set.insert(ch_id);
                }
            }
            edge_state
                .ninja_visible_to
                .write()
                .await
                .insert(sid, visible_set);
        }
    }

    // Execute full login sequence (CryptSetup → CodecVersion → ChannelStates →
    // UserStates → ServerSync → ServerConfig).
    let login = if skip_crypt_setup {
        LoginHandler::new_no_crypt(&client_sender, &config, &edge_state, &hub_client)
    } else {
        LoginHandler::new(&client_sender, &config, &edge_state, &hub_client)
    };
    let login_info = match login.execute_login(sid, &auth_result).await {
        Ok(info) => info,
        Err(e) => {
            info!(
                "Login sequence failed for {} (session={}): {}",
                peer_addr, sid, e
            );
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

    // If suppress was set by permission check, notify the client itself.
    if client.suppress && !auth_result.suppress.unwrap_or(false) {
        let suppress_msg = mumbleproto::UserState {
            session: Some(sid),
            suppress: Some(true),
            ..Default::default()
        };
        client_sender
            .send_message(MessageType::UserState, &suppress_msg)
            .await;
    }

    // Broadcast new user join to all other Ready clients.
    // NOTE: self_deaf/self_mute are intentionally excluded here, matching Murmur behaviour.
    // The preconnect state (self_deaf/self_mute) is applied separately via login_rx after the
    // client transitions to Ready, which then broadcasts it to ALL clients (including the new
    // user itself) with the correct actor field.
    let user_join_msg = mumbleproto::UserState {
        session: Some(client.session),
        user_id: if client.user_id > 0 {
            Some(client.user_id)
        } else {
            None
        },
        name: Some(client.username.clone()),
        channel_id: Some(client.channel_id),
        mute: if client.mute { Some(true) } else { None },
        deaf: if client.deaf { Some(true) } else { None },
        suppress: if client.suppress { Some(true) } else { None },
        priority_speaker: if client.priority_speaker {
            Some(true)
        } else {
            None
        },
        recording: if client.recording { Some(true) } else { None },
        hash: client.cert_hash.clone(),
        texture_hash: client.texture_hash.clone(),
        comment_hash: client.comment_hash.clone(),
        ..Default::default()
    };
    {
        let ninja_channels_snap = edge_state.ninja_channels.read().await.clone();
        if ninja_channels_snap.contains(&client.channel_id) {
            // Channel Ninja: only send join announcement to observers who can see this channel
            let all_clients = edge_state.client_manager.get_all_clients().await;
            let visible_cache = edge_state.ninja_visible_to.read().await;
            let observer_sessions: Vec<u32> = all_clients
                .iter()
                .filter(|observer| observer.session != sid)
                .filter(|observer| {
                    visible_cache
                        .get(&observer.session)
                        .map(|set| set.contains(&client.channel_id))
                        .unwrap_or(false)
                })
                .map(|observer| observer.session)
                .collect();
            edge_state
                .client_manager
                .broadcast_to_sessions(observer_sessions, MessageType::UserState, &user_join_msg)
                .await;
        } else {
            edge_state
                .client_manager
                .broadcast(MessageType::UserState, &user_join_msg, Some(sid))
                .await;
        }
    }
    // Invalidate BroadcastCaches: a new user joined, routing targets changed.
    edge_state
        .topology_version
        .fetch_add(1, std::sync::atomic::Ordering::Release);

    // If suppress was determined by the local ACL permission check (not from Hub auth response),
    // notify Hub and peer Edges about the correct suppress value.  Without this, the Hub session
    // would keep suppress=false (the auth-time value) and other edges would show this user as
    // unsuppressed even though they cannot speak.
    if client.suppress
        && !auth_result.suppress.unwrap_or(false)
        && let Err(e) = hub_client
            .rpc_user_state_changed(crate::hub_client::UserStateChangeRequest {
                session_id: sid,
                self_mute: None,
                self_deaf: None,
                mute: None,
                deaf: None,
                suppress: Some(true),
                priority_speaker: None,
                recording: None,
                listening_channel_add: vec![],
                listening_channel_remove: vec![],
                actor_session: None,
            })
            .await
    {
        warn!(
            "Failed to report suppress=true to Hub for session {}: {:#}",
            sid, e
        );
    }

    // Load persisted channel listeners for registered users.  Restoration is
    // deferred to the outer loop (after the client transitions to `Ready`) so
    // the broadcast actually reaches the user's own session — `broadcast`
    // filters out non-Ready clients, which previously caused others to see
    // the restored listeners while the user themselves did not.
    //
    // Restoration is performed for ALL client versions, matching Murmur's
    // behaviour (`m_dbWrapper.loadChannelListenersOf` in
    // c-implement/src/murmur/Messages.cpp): server-side state is restored
    // regardless of client capability, so other users continue to see the
    // user as listening to the same channels as before the disconnect.
    // For pre-1.4.0 clients (which do not understand the field) Murmur sends
    // an additional TextMessage warning — handled below after the client is
    // Ready.
    let user_id = client.user_id;
    let saved_listeners = if user_id > 0 {
        hub_client.load_channel_listeners(user_id).await
    } else {
        Vec::new()
    };

    info!(
        "Client {} login task complete, outer loop will finalise (session={})",
        peer_addr, sid
    );
    Some(LoginTaskResult {
        session_id: sid,
        login_info,
        client_sender,
        config,
        saved_listeners,
    })
}
