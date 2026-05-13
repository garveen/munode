//! Per-client TCP connection handler and associated helpers.
mod helpers;
mod login;
mod user_state;
#[cfg(test)]
mod tests;

use helpers::{drain_writer, broadcast_text_message, broadcast_codec_version,
              strip_html_tags, encode_ip_address};
pub(crate) use helpers::{get_perm_cached, prefetch_whisper_permissions};
pub(crate) use helpers::get_perm_cached_outcome;
use login::{do_login_task, LoginTaskArgs, LoginTaskResult};
use user_state::{handle_user_state_update, handle_admin_user_state_update};

use std::net::SocketAddr;
use std::sync::Arc;
use anyhow::Result;
use bytes::BytesMut;
use prost::Message;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info, warn};
use munode_common::config::EdgeConfig;
use munode_common::permission as perm;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::decode_frame;
use crate::client::{ClientSender, ClientState};
use crate::handler::{self, LoginHandler};
use crate::hub_client::{HubClient, HubConnectionState};
use crate::state::EdgeState;
use crate::transport::TransportKind;
use crate::voice::{deliver_voice_tcp, inject_session_into_voice, wrap_udptunnel};
use crate::voice_target::{
    apply_voice_target_proto,
    clear_session_voice_targets,
    mumble_voice_target_to_proto,
};

/// Fallback idle timeout when `server.idle_timeout_secs = 0` (disabled) — effectively no
/// upper bound, but we still need a finite select! arm.  Set to a large value.
const CLIENT_IDLE_TIMEOUT_DISABLED: tokio::time::Duration = tokio::time::Duration::from_secs(3600);

/// Maximum time allowed for the TLS handshake to complete.  Without this, a
/// malicious peer that opens a TCP connection but never finishes the TLS
/// handshake (slow-loris) would hold a connection-semaphore permit and a
/// tokio task indefinitely.
const TLS_HANDSHAKE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(15);

/// Mumble 1.4.0 — the version that introduced the ChannelListener feature.
/// Encoded as `(major << 16) | (minor << 8) | patch`, i.e. 0x010400.
/// Used to send a warning text message to older clients when the server
/// has the ChannelListener feature enabled (matches Murmur's behaviour in
/// `c-implement/src/murmur/Messages.cpp`).
const CHANNEL_LISTENER_FEATURE_VERSION: u32 = (1 << 16) | (4 << 8);

/// Warning message sent to <1.4.0 clients when the ChannelListener feature
/// is enabled on the server.  Mirrors the text Murmur sends.
const CHANNEL_LISTENER_OLD_CLIENT_WARNING: &str =
    "[WARNING]: This server has the ChannelListener feature enabled but your client \
     version does not support it. This means that users might be listening to what you \
     are saying in your channel without you noticing! You can solve this issue by \
     upgrading to Mumble 1.4.0 or newer.";

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

    // Bound the TLS handshake duration so a peer that opens TCP but never
    // completes ClientHello cannot hold a connection slot forever (slow-loris).
    let mut tls_stream = match tokio::time::timeout(
        TLS_HANDSHAKE_TIMEOUT,
        acceptor.accept(stream),
    ).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            debug!("TLS handshake error from {}: {}", peer_addr, e);
            return Err(e.into());
        }
        Err(_) => {
            debug!("TLS handshake from {} timed out", peer_addr);
            anyhow::bail!("TLS handshake timeout");
        }
    };

    info!("New TCP connection from {}", peer_addr);
    
    // Extract client certificate hash BEFORE splitting the stream
    // Mumble uses SHA-1 hash of the client certificate (not SHA-256)
    let peer_cert_chain: Vec<Vec<u8>> = tls_stream
        .get_ref()
        .1 // Get the TLS session (ServerConnection)
        .peer_certificates()
        .map(|certs| certs.iter().map(|c| c.as_ref().to_vec()).collect())
        .unwrap_or_default();

    let certificate_hash: Option<String> = peer_cert_chain
        .first()
        .map(|der| {
            use sha1::{Sha1, Digest};
            let mut hasher = Sha1::new();
            hasher.update(der);
            hex::encode(hasher.finalize())
        });
    
    if let Some(ref hash) = certificate_hash {
        info!("Client {} certificate hash: {}...", peer_addr, &hash[..16]);
    }
    
    // Sniff the first post-TLS byte to distinguish HTTP/WS (ASCII uppercase) from
    // Mumble (\x00 — first byte of the Version message type u16 = 0).
    // When the WS fallback shares the main TLS port (ws_fallback_port = None), this
    // lets browsers connect via wss:// without needing a dedicated plain-text port.
    let mut sniff_byte: Option<u8> = None;
    #[cfg(feature = "ws-transport")]
    if config.webtransport.ws_fallback_enabled {
        let mut b = [0u8; 1];
        if let Ok(Ok(_)) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tls_stream.read_exact(&mut b),
        ).await {
            if crate::transport::ws::byte_looks_like_http(b[0]) {
                info!("HTTP/WS over TLS from {}", peer_addr);
                return crate::transport::ws::dispatch_tls_http(
                    b[0], tls_stream, peer_addr,
                    std::sync::Arc::new(config.clone()), hub_client, edge_state,
                ).await;
            }
            sniff_byte = Some(b[0]);
        }
    }

    let (reader_half, mut writer) = tokio::io::split(tls_stream);

    // Create per-client message sender channel
    let (send_tx, mut send_rx) = mpsc::channel::<bytes::Bytes>(4096);
    let client_sender = ClientSender::new(send_tx);

    // Notified when the writer task exits due to a TCP write/flush error (not clean close).
    // The read loop selects on this so half-open connections are detected promptly instead
    // of waiting for the 120-second idle timeout.
    let write_failed = std::sync::Arc::new(tokio::sync::Notify::new());
    let write_failed_notify = std::sync::Arc::clone(&write_failed);

    // Writer task: forwards messages from send_rx to TLS socket.
    // Batches pending messages with write_vectored + single flush to reduce syscalls.
    let writer_handle = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        loop {
            // Wait for the first message.
            let first = match send_rx.recv().await {
                Some(data) => data,
                None => break, // channel closed → client disconnected (clean)
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
                    write_failed_notify.notify_one();
                    break;
                }
            } else {
                let iov: Vec<std::io::IoSlice<'_>> =
                    pending.iter().map(|d| std::io::IoSlice::new(d.as_ref())).collect();
                if let Err(e) = writer.write_vectored(&iov).await {
                    debug!("Write error to client: {}", e);
                    write_failed_notify.notify_one();
                    break;
                }
            }

            if let Err(e) = writer.flush().await {
                debug!("Flush error to client: {}", e);
                write_failed_notify.notify_one();
                break;
            }
        }
    });

    run_connection_inner(
        match sniff_byte {
            Some(b) => Box::new(crate::transport::ws::PrefixedStream::new(
                bytes::Bytes::from(vec![b]), reader_half,
            )) as Box<dyn AsyncRead + Unpin + Send>,
            None => Box::new(reader_half),
        },
        client_sender,
        write_failed,
        writer_handle,
        peer_addr,
        certificate_hash,
        peer_cert_chain,
        TransportKind::Tls,
        config,
        hub_client,
        edge_state,
    ).await
}

/// Transport-agnostic Mumble connection loop.
///
/// Called by all transport entry points (TLS, WebTransport, WebSocket) once their
/// transport-specific setup is complete.
///
/// # Arguments
/// * `reader`           — incoming byte stream (implements `AsyncRead`)
/// * `client_sender`    — outgoing message channel to the writer task
/// * `write_failed`     — notified by the writer task on send errors
/// * `writer_handle`    — writer task handle (used for graceful drain on disconnect)
/// * `peer_addr`        — remote peer address for logging / rate limiting
/// * `certificate_hash` — TLS client certificate SHA-1 hash, if available
/// * `client_cert_chain` — raw DER-encoded TLS client certificates (may be empty)
/// * `transport_kind`   — which transport is in use (affects CryptSetup)
/// * `config`           — Edge configuration reference
/// * `hub_client`       — Hub RPC client
/// * `edge_state`       — shared Edge state
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_connection_inner(
    mut reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
    client_sender: ClientSender,
    write_failed: std::sync::Arc<tokio::sync::Notify>,
    writer_handle: tokio::task::JoinHandle<()>,
    peer_addr: SocketAddr,
    certificate_hash: Option<String>,
    client_cert_chain: Vec<Vec<u8>>,
    transport_kind: TransportKind,
    config: &EdgeConfig,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    // Mumble protocol: server sends Version first (immediately after TLS handshake),
    // then the client responds with its own Version + Authenticate.
    client_sender.send_raw(handler::encode_server_version().into()).await;

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
    // Per-client rate limiter for control-plane messages (TextMessage,
    // UserState, ChannelState, ContextAction, UserStats).  Mirrors Murmur's
    // single shared `leakyBucket` (see RATELIMIT macro in
    // c-implement/src/murmur/Messages.cpp).  Prefer hub-pushed limits over
    // edge-local config (hub limits are set after registration).
    let hub_limits_snapshot = edge_state.hub_limits.read().await.clone();
    let (effective_message_rate, effective_message_burst) = hub_limits_snapshot
        .as_ref()
        .map(|l| (l.message_rate.unwrap_or(0.0), l.message_burst.unwrap_or(0)))
        .unwrap_or((config.server.message_rate, config.server.message_burst));
    let mut control_rate_limiter = if effective_message_rate > 0.0 {
        Some(munode_common::rate_limiter::TokenBucket::new(
            effective_message_rate,
            effective_message_burst,
        ))
    } else {
        None
    };
    // Per-client rate limiter for PluginDataTransmission, mirroring Murmur's
    // dedicated `m_pluginMessageBucket` (`pluginmessagelimit` /
    // `pluginmessageburst`).  Plugin messages have a separate bucket because
    // they have a much larger burst budget than control messages.
    let mut plugin_rate_limiter = if config.server.plugin_message_rate > 0.0 {
        Some(munode_common::rate_limiter::TokenBucket::new(
            config.server.plugin_message_rate,
            config.server.plugin_message_burst,
        ))
    } else {
        None
    };

    // Idle timeout derived from config.  0 means "disabled" — use the large
    // sentinel value so the select! arm is always valid.
    let idle_timeout = if config.server.idle_timeout_secs > 0 {
        tokio::time::Duration::from_secs(config.server.idle_timeout_secs)
    } else {
        CLIENT_IDLE_TIMEOUT_DISABLED
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
                remaining.min(idle_timeout)
            } else {
                idle_timeout
            }
        } else {
            idle_timeout
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
                _ = write_failed.notified() => {
                    // TCP write failed while login was in progress — abort the login task
                    // and close immediately rather than waiting for the idle timeout.
                    debug!("Client {} TCP write failed during login, closing connection", peer_addr);
                    if let Some(ab) = login_abort.take() { ab.abort(); }
                    break 'outer;
                }
                result = &mut login_recv => {
                    // Login task finished.
                    login_abort = None;
                    match result.ok().flatten() {
                        Some(task_result) => {
                            // session_id was pre-allocated when Authenticate was received;
                            // task_result.session_id is the same value.
                            let sid = task_result.session_id;

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

                            // Restore persisted channel listeners now that the
                            // client is `Ready` — `broadcast` filters out
                            // non-Ready sessions, so deferring this until after
                            // the Ready transition is what actually delivers
                            // the restored `listening_channel_add` list to the
                            // user's own session.  Doing it earlier (inside
                            // do_login_task) caused other users to see the
                            // restored listeners while the user themselves did
                            // not.
                            //
                            // Version gate: only restore when the client is
                            // >= 1.4.0 — the version that introduced the
                            // ChannelListener feature.  Pre-1.4.0 clients
                            // cannot represent listener state in their UI and
                            // would mishandle the `listening_channel_add`
                            // field, so we skip restoration for them.
                            let supports_listeners = client_version
                                .map(|v| v >= CHANNEL_LISTENER_FEATURE_VERSION)
                                .unwrap_or(false);
                            if supports_listeners && !task_result.saved_listeners.is_empty() {
                                let restore_state = mumbleproto::UserState {
                                    session: Some(sid),
                                    listening_channel_add: task_result.saved_listeners,
                                    ..Default::default()
                                };
                                handle_user_state_update(&edge_state, &hub_client, sid, &restore_state).await;
                                debug!("Restored saved channel listeners for session {}", sid);
                            }

                            // ChannelListener feature warning for pre-1.4.0
                            // clients (matches Murmur's behaviour in
                            // c-implement/src/murmur/Messages.cpp): when the
                            // server has the feature enabled (per-channel /
                            // per-user listener limits both non-zero) but the
                            // client cannot represent listeners, warn the user
                            // that other people may be listening to their
                            // channel without their UI showing it.
                            let listeners_per_channel = edge_state
                                .listeners_per_channel
                                .load(std::sync::atomic::Ordering::Relaxed);
                            let listeners_per_user = edge_state
                                .listeners_per_user
                                .load(std::sync::atomic::Ordering::Relaxed);
                            let feature_enabled = listeners_per_channel != 0 && listeners_per_user != 0;
                            if feature_enabled
                                && client_version.unwrap_or(0) < CHANNEL_LISTENER_FEATURE_VERSION
                            {
                                let warn_msg = mumbleproto::TextMessage {
                                    actor: None,
                                    session: vec![sid],
                                    channel_id: vec![],
                                    tree_id: vec![],
                                    message: CHANNEL_LISTENER_OLD_CLIENT_WARNING.to_string(),
                                };
                                task_result.client_sender
                                    .send_message(MessageType::TextMessage, &warn_msg)
                                    .await;
                            }
                            // No channel_id buffering needed: the client sends
                            // UserState{channel_id} after receiving ServerSync, and by
                            // then the server is already in Ready state.
                        }
                        None => {
                            // Login failed.  The task removed the client from the manager
                            // (if it was added).  The cleanup block at the bottom handles
                            // free_session_id and notify_user_left via the pre-allocated
                            // session_id that is already set in the outer loop.
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
                _ = write_failed.notified() => {
                    // TCP write failed — close the connection immediately instead of
                    // waiting up to 120 s for the idle timeout to fire.
                    debug!("Client {} TCP write failed, closing connection", peer_addr);
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
                    // Parse and log the client's Version.  The server's own Version was
                    // already sent proactively at connection start (Mumble protocol: server
                    // speaks first), so no response is needed here.
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
                        drain_writer(writer_handle).await;
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
                                drain_writer(writer_handle).await;
                                return Ok(());
                            }
                        }
                    }

                    // --- Pre-allocate session ID so the outer loop tracks it immediately ---
                    //
                    // Allocating here (before spawning) means that if TCP drops while the
                    // login task is in flight, the cleanup block at the bottom of this
                    // function can call notify_user_left / free_session_id without waiting
                    // for the task, preventing ghost sessions.
                    let sid = match edge_state.allocate_session_id().await {
                        Some(s) => s,
                        None => {
                            error!("Failed to allocate session ID: pool exhausted or edge not registered");
                            client_sender.send_raw(handler::encode_reject(
                                Some(mumbleproto::reject::RejectType::ServerFull as i32),
                                "Server is full (session pool exhausted)",
                            ).into()).await;
                            // No session was allocated; cleanup block won't run (session_id still None).
                            break 'outer;
                        }
                    };
                    // Track the pre-allocated session ID in the outer loop immediately so
                    // the cleanup block handles free + notify regardless of how the task ends.
                    session_id = Some(sid);

                    // --- Spawn the slow login work as a separate task ---
                    //
                    // This keeps the read loop alive so the server can continue
                    // responding to TCP Ping messages while Hub RPCs and the
                    // message burst are in flight.  The task sends back the
                    // login result (or None on failure) via the oneshot.
                    let (task_tx, task_rx) = tokio::sync::oneshot::channel::<Option<LoginTaskResult>>();
                    let task_args = LoginTaskArgs {
                        session_id: sid,
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
                        client_cert_chain: client_cert_chain.clone(),
                        skip_crypt_setup: transport_kind.skip_crypt_setup(),
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
                        // Break early on send failure: the writer task has already exited
                        // (TCP dead). Without this, we would wait for the next read
                        // error or the 120 s idle timeout before cleaning up.
                        if !client_sender.send_message(MessageType::Ping, &response).await {
                            break 'outer;
                        }
                    } else {
                        // Pre-auth: just echo the timestamp back.
                        let response = mumbleproto::Ping {
                            timestamp: ping.timestamp,
                            ..Default::default()
                        };
                        if !client_sender.send_message(MessageType::Ping, &response).await {
                            break 'outer;
                        }
                    }
                }
                MessageType::UserState if client_state == ClientState::Ready => {
                    let Ok(user_state) = mumbleproto::UserState::decode(&frame.payload[..]) else { continue; };
                    if let Some(sid) = session_id {
                        // Apply shared control rate limit (Murmur RATELIMIT).  Silently
                        // drop excess messages — UserState mutations have no protocol
                        // ack the client expects, mirroring Murmur's `return`.
                        if let Some(ref mut rl) = control_rate_limiter {
                            if !rl.try_consume() {
                                debug!("Session {} UserState rate limited", sid);
                                continue;
                            }
                        }
                        // Check if this targets another user (admin operation)
                        let target_sid = user_state.session.unwrap_or(sid);
                        if target_sid != sid && (user_state.mute.is_some() || user_state.deaf.is_some() || user_state.channel_id.is_some() || user_state.comment.is_some() || user_state.suppress.is_some()) {
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
                        // Apply rate limiting (shared control bucket)
                        if let Some(ref mut rl) = control_rate_limiter {
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
                        // Tree channels: check TEXT_MESSAGE on each channel and deny on first failure.
                        // Murmur denies immediately when any tree channel lacks permission.
                        for &ch_id in &text_msg.tree_id {
                            let has_perm = get_perm_cached(&hub_client, &edge_state, sid, ch_id, true).await
                                & perm::TEXT_MESSAGE != 0;
                            if !has_perm {
                                let pq = mumbleproto::PermissionDenied {
                                    r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                    permission: Some(perm::TEXT_MESSAGE),
                                    channel_id: Some(ch_id),
                                    session: Some(sid),
                                    ..Default::default()
                                };
                                client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                // break out of the TextMessage handling; continue outer message loop
                                continue 'outer;
                            }
                        }
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
                                    permission: Some(perm::TEXT_MESSAGE),
                                    channel_id: first_denied,
                                    session: Some(sid),
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
                        // Mirror Murmur's `aiUdpFlag = 0`: when the client sends voice
                        // over TCP, bidirectional UDP is no longer working (e.g. NAT
                        // mapping expired, asymmetric firewall). Clear any cached UDP
                        // address so subsequent server→client voice falls back to TCP
                        // until the client re-establishes UDP by sending a fresh UDP
                        // voice packet (which `register_client` will re-record).
                        // Without this, the server keeps sending UDP packets to a
                        // stale address and the client appears to be able to hear but
                        // not be heard (or vice-versa).
                        edge_state.udp_session_to_addr.remove(&sid);

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

                            if (client.suppress || client.mute || client.self_mute) && voice_target != 31 {
                                // Suppressed/muted users cannot speak — silently drop.
                            } else if voice_target == 31 {
                                // Loopback: send back to the sender (inject session ID per protocol)
                                let data = wrap_udptunnel(&inject_session_into_voice(&frame.payload, sid, 0));
                                if let Some(sender_tx) = edge_state.client_manager.get_sender(sid).await {
                                    sender_tx.send_raw(data).await;
                                }
                            } else if let Some(targets) = crate::routing::compute_voice_targets(
                                &frame.payload, sid, client.channel_id, &edge_state, &hub_client,
                            ).await {
                                // Shared routing: compute_voice_targets handles VoiceTarget
                                // lookup, channel expansion, and deaf filtering.
                                for group in crate::voice::local_delivery_groups(&targets) {
                                    let data = wrap_udptunnel(&inject_session_into_voice(
                                        &frame.payload,
                                        sid,
                                        group.context,
                                    ));
                                    deliver_voice_tcp(group.sessions, &data);
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
                            let config = mumble_voice_target_to_proto(&vt);

                            apply_voice_target_proto(
                                &edge_state,
                                sid,
                                target_id as u32,
                                config.clone(),
                            )
                            .await;

                            if let Err(e) = hub_client
                                .sync_voice_target(sid, target_id as u32, config)
                                .await
                            {
                                warn!("Failed to sync VoiceTarget: {}", e);
                            }
                        }
                    }
                }
                MessageType::UserStats if client_state == ClientState::Ready => {
                    let Ok(stats) = mumbleproto::UserStats::decode(&frame.payload[..]) else { continue; };
                    if let Some(requester_sid) = session_id {
                        // Apply shared control rate limit (Murmur RATELIMIT).
                        if let Some(ref mut rl) = control_rate_limiter {
                            if !rl.try_consume() {
                                debug!("Session {} UserStats rate limited", requester_sid);
                                continue;
                            }
                        }
                        debug!("UserStats request for session {:?}", stats.session);
                        if let Some(target_session) = stats.session {
                            let is_stats_only = stats.stats_only.unwrap_or(false);
                            let is_self = target_session == requester_sid;

                            // Determine whether the requester has "extended" access:
                            // admins with Register permission on root can view full stats of
                            // any user.  Self-requests always get extended access.
                            // (Mirrors Murmur: HasPermission(root, client, ChanACL::Register))
                            let has_register = if !is_self {
                                get_perm_cached(&hub_client, &edge_state, requester_sid, 0, false).await
                                    & perm::REGISTER != 0
                            } else {
                                true
                            };
                            let is_extended = is_self || has_register;

                            // Non-extended users requesting stats for users in channels they
                            // cannot enter are denied — even for stats_only=true.
                            // (Mirrors Murmur: if !extended && !HasPermission(target.Channel(), EnterPermission))
                            if !is_extended {
                                if let Some(target) = edge_state.client_manager.get_client(target_session).await {
                                    let can_enter = get_perm_cached(&hub_client, &edge_state, requester_sid, target.channel_id, true).await
                                        & perm::ENTER != 0;
                                    if !can_enter {
                                        let pd = mumbleproto::PermissionDenied {
                                            r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                            permission: Some(perm::ENTER),
                                            channel_id: Some(target.channel_id),
                                            session: Some(requester_sid),
                                            ..Default::default()
                                        };
                                        client_sender.send_message(MessageType::PermissionDenied, &pd).await;
                                        continue;
                                    }
                                }
                            }

                            // Full stats (stats_only=false) for a *different* user expose the IP
                            // address and other sensitive fields.  Require extended access
                            // (self-request or Register permission on root channel).
                            if !is_stats_only && !is_extended {
                                let pd = mumbleproto::PermissionDenied {
                                    r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                    permission: Some(perm::REGISTER),
                                    channel_id: Some(0),
                                    session: Some(requester_sid),
                                    ..Default::default()
                                };
                                client_sender.send_message(MessageType::PermissionDenied, &pd).await;
                                continue;
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
                                        certificates: target.client_cert_chain.clone(),
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
                            let hub = hub_client.clone();
                            let actor_user_id = client.user_id;
                            let actor_username = client.username.clone();
                            let target_session = user_remove.session;
                            let reason = user_remove.reason.clone().unwrap_or_default();
                            let ban = user_remove.ban.unwrap_or(false);
                            tokio::spawn(async move {
                                if let Err(e) = hub.rpc_user_remove(sid, actor_user_id, &actor_username, target_session, &reason, ban).await {
                                    warn!("rpc_user_remove failed: {:#}", e);
                                }
                            });
                        }
                    }
                }
                MessageType::ChannelState if client_state == ClientState::Ready => {
                    // Client requesting channel create/edit - forward to Hub
                    let Ok(ch_state) = mumbleproto::ChannelState::decode(&frame.payload[..]) else { continue; };
                    debug!("ChannelState from {}: channel_id={:?}, name={:?}", peer_addr, ch_state.channel_id, ch_state.name);

                    if let Some(sid) = session_id {
                        // Apply shared control rate limit (Murmur RATELIMIT).
                        if let Some(ref mut rl) = control_rate_limiter {
                            if !rl.try_consume() {
                                debug!("Session {} ChannelState rate limited", sid);
                                continue;
                            }
                        }
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
                                        permission: Some(perm::LINK_CHANNEL),
                                        channel_id: Some(ch_id),
                                        session: Some(sid),
                                        ..Default::default()
                                    };
                                    client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                    continue;
                                }
                                // Also require LINK_CHANNEL on each target channel being added
                                // (mirrors Murmur: for each cid in LinksAdd, check LinkChannelPermission).
                                let mut denied_target: Option<u32> = None;
                                for &target_ch_id in &ch_state.links_add {
                                    let has_target_link = get_perm_cached(&hub_client, &edge_state, sid, target_ch_id, false).await
                                        & perm::LINK_CHANNEL != 0;
                                    if !has_target_link {
                                        denied_target = Some(target_ch_id);
                                        break;
                                    }
                                }
                                if let Some(denied_ch) = denied_target {
                                    let pq = mumbleproto::PermissionDenied {
                                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                        permission: Some(perm::LINK_CHANNEL),
                                        channel_id: Some(denied_ch),
                                        session: Some(sid),
                                        ..Default::default()
                                    };
                                    client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                    continue;
                                }
                                hub.rpc_channel_state(ch_id, ch_state.links_add, ch_state.links_remove).await;
                            }
                        } else {
                            let is_new = ch_state.channel_id.is_none();
                            let is_temp = ch_state.temporary.unwrap_or(false);
                            let target_parent = if is_new {
                                ch_state.parent.unwrap_or(0)
                            } else {
                                // Edit: check WRITE on the channel being edited
                                ch_state.channel_id.unwrap_or(0)
                            };
                            // Creating a temporary channel requires TEMP_CHANNEL permission;
                            // permanent channel creation requires MAKE_CHANNEL.
                            // Editing an existing channel requires WRITE.
                            let required_perm = if is_new {
                                if is_temp { perm::TEMP_CHANNEL } else { perm::MAKE_CHANNEL }
                            } else {
                                perm::WRITE
                            };
                            let has_perm = get_perm_cached(&hub_client, &edge_state, sid, target_parent, false).await
                                & required_perm != 0;
                            if !has_perm {
                                let pq = mumbleproto::PermissionDenied {
                                    r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                                    permission: Some(required_perm),
                                    channel_id: Some(target_parent),
                                    session: Some(sid),
                                    ..Default::default()
                                };
                                client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                continue;
                            }

                            // For new channel creation: unregistered users without a certificate
                            // cannot create channels (mirrors Murmur: MissingCertificate check).
                            if is_new {
                                let actor_info = edge_state.client_manager.get_client(sid).await;
                                let is_registered = actor_info.as_ref().map(|c| c.user_id > 0).unwrap_or(false);
                                let has_cert = actor_info.as_ref().map(|c| c.cert_hash.is_some()).unwrap_or(false);
                                if !is_registered && !has_cert {
                                    let pq = mumbleproto::PermissionDenied {
                                        r#type: Some(mumbleproto::permission_denied::DenyType::MissingCertificate as i32),
                                        session: Some(sid),
                                        ..Default::default()
                                    };
                                    client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                    continue;
                                }
                            }

                            // For channel edits with a parent change: detect illegal reparent
                            // (moving a channel into one of its own descendants creates a cycle).
                            // Walk up the parent chain of the proposed new parent; if we encounter
                            // the channel being moved, the reparent would create a loop.
                            if !is_new {
                                if let (Some(ch_id), Some(new_parent_id)) = (ch_state.channel_id, ch_state.parent) {
                                    let mut iter_id = Some(new_parent_id);
                                    let mut is_cycle = false;
                                    while let Some(current_id) = iter_id {
                                        if current_id == ch_id {
                                            is_cycle = true;
                                            break;
                                        }
                                        iter_id = edge_state.channel_manager.get_channel(current_id).await
                                            .and_then(|ch| ch.parent_id);
                                    }
                                    if is_cycle {
                                        let pq = mumbleproto::PermissionDenied {
                                            r#type: Some(mumbleproto::permission_denied::DenyType::Text as i32),
                                            reason: Some("Illegal channel reparent".to_string()),
                                            ..Default::default()
                                        };
                                        client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                                        continue;
                                    }
                                }
                            }

                            let sender_for_spawn = client_sender.clone();
                            let creator_session = if is_new { Some(sid) } else { None };
                            tokio::spawn(async move {
                                match hub.save_channel(
                                    ch_state.channel_id,
                                    ch_state.parent,
                                    ch_state.name.as_deref(),
                                    ch_state.description.as_deref(),
                                    ch_state.position,
                                    ch_state.max_users,
                                    if is_new { ch_state.temporary } else { None },
                                    creator_session,
                                ).await {
                                    Ok(result) if !result.success => {
                                        let pq = mumbleproto::PermissionDenied {
                                            r#type: Some(mumbleproto::permission_denied::DenyType::ChannelName as i32),
                                            reason: result.error,
                                            ..Default::default()
                                        };
                                        sender_for_spawn.send_message(MessageType::PermissionDenied, &pq).await;
                                    }
                                    Err(e) => {
                                        warn!("Failed to forward ChannelState to Hub: {}", e);
                                    }
                                    _ => {}
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
                                permission: Some(perm::WRITE),
                                channel_id: Some(ch_remove.channel_id),
                                session: Some(sid),
                                ..Default::default()
                            };
                            client_sender.send_message(MessageType::PermissionDenied, &pq).await;
                            continue;
                        }
                        let hub = hub_client.clone();
                        tokio::spawn(async move {
                            hub.rpc_channel_remove(ch_remove.channel_id).await;
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
                                        permission: Some(perm::WRITE),
                                        channel_id: Some(0),
                                        session: Some(sid),
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
                                        permission: Some(perm::BAN),
                                        channel_id: Some(0),
                                        session: Some(sid),
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
                            permission: Some(perm::WRITE),
                            channel_id: Some(ch_id),
                            session: Some(sid),
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
                    let Ok(mut plugin) = mumbleproto::PluginDataTransmission::decode(&frame.payload[..]) else { continue; };
                    debug!("PluginData from {}: dataId={:?}", peer_addr, plugin.data_id);

                    // Enforce plugin message size limit
                    let plugin_limit = config.server.plugin_message_length;
                    let plugin_data_len = plugin.data.as_deref().map(|d| d.len()).unwrap_or(0) as u32;
                    if plugin_limit > 0 && plugin_data_len > plugin_limit {
                        debug!("PluginData from {} exceeds limit ({} > {})", peer_addr, plugin_data_len, plugin_limit);
                        // Silently drop oversized plugin messages (no PermissionDenied per Mumble protocol convention)
                        continue;
                    }

                    // Per-session plugin-message rate limit (Murmur's
                    // `m_pluginMessageBucket`).  Silently drop excess messages,
                    // matching Murmur's behaviour for bucket overflow.
                    if let Some(ref mut rl) = plugin_rate_limiter {
                        if !rl.try_consume() {
                            debug!("PluginData from {} rate limited", peer_addr);
                            continue;
                        }
                    }

                    // Deduplicate the receiver list (mirrors Murmur's
                    // `uniqueReceivers QSet` in msgPluginDataTransmission).
                    // A duplicated id otherwise causes redundant per-edge
                    // forwarding work and a duplicate delivery to the local
                    // recipient.
                    if !plugin.receiver_sessions.is_empty() {
                        let mut seen = std::collections::HashSet::with_capacity(plugin.receiver_sessions.len());
                        plugin.receiver_sessions.retain(|s| seen.insert(*s));
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
                                permission: Some(perm::REGISTER),
                                channel_id: Some(0),
                                session: Some(sid),
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
                        // Apply shared control rate limit (Murmur RATELIMIT for ContextActionModify).
                        if let Some(ref mut rl) = control_rate_limiter {
                            if !rl.try_consume() {
                                debug!("Session {} ContextAction rate limited", sid);
                                continue;
                            }
                        }
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

        // remove_client returns the ClientInfo so we can use it for ninja filtering
        // below WITHOUT a second get_client call (which would always return None since
        // the session is already removed).
        let removed_client = edge_state.client_manager.remove_client(sid).await;
        // Invalidate BroadcastCaches: a user left, routing targets changed.
        edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
        // Free the session ID back to the local pool
        edge_state.free_session_id(sid).await;
        // Clean up voice target cache for this session
        clear_session_voice_targets(&edge_state, sid).await;
        // Clean up permission cache for this session
        edge_state.permission_cache.retain(|&(s, _), _| s != sid);
        // Clear cached UDP source address so the routing fast-path no longer
        // sends voice toward a now-dead UDP endpoint.
        edge_state.udp_session_to_addr.remove(&sid);
        // Capture the disconnected channel from the removed client record.
        // Previously this used get_client() AFTER remove_client(), which always
        // returned None (the session was already gone), causing ninja-channel
        // filtering to be silently skipped on every disconnect.
        let disconnected_channel_id = removed_client.as_ref().map(|c| c.channel_id);
        // Clean up ninja channel permission cache for this session
        edge_state.ninja_visible_to.write().await.remove(&sid);

        // Broadcast UserRemove to all remaining clients.
        // If the user was in a ninja channel, only send to observers who could see them.
        let remove_msg = handler::build_user_remove_msg(sid, None);
        let ninja_channels_snap = edge_state.ninja_channels.read().await.clone();
        if let Some(ch) = disconnected_channel_id {
            if ninja_channels_snap.contains(&ch) {
                let all_clients = edge_state.client_manager.get_all_clients().await;
                let visible_cache = edge_state.ninja_visible_to.read().await;
                for observer in &all_clients {
                    if observer.session == sid { continue; }
                    let can_see = visible_cache
                        .get(&observer.session)
                        .map(|set| set.contains(&ch))
                        .unwrap_or(false);
                    if can_see {
                        edge_state.client_manager.send_to(observer.session, MessageType::UserRemove, &remove_msg).await;
                    }
                }
            } else {
                edge_state.client_manager.broadcast(MessageType::UserRemove, &remove_msg, None).await;
            }
        } else {
            edge_state.client_manager.broadcast(MessageType::UserRemove, &remove_msg, None).await;
        }

        // Notify Hub that user disconnected (RPC: Hub removes session and broadcasts to other edges)
        hub_client.rpc_user_left(sid, None).await;

        info!("Cleaned up session {} for {}", sid, peer_addr);
    }

    // Abort the login task immediately on TCP disconnect.  Hub prevents ghost
    // sessions via `pending_auths`: the `handleUserLeft` notification sent in
    // the cleanup block above sets the cancel flag, and the Hub auth task
    // checks it before `session_manager.add_session`.
    if let Some(abort) = login_abort.take() {
        abort.abort();
    }
    drop(login_rx.take());

    // Gracefully drain any pending outgoing messages (e.g. a Reject sent on auth
    // failure) before the TCP connection is closed.  Dropping the sender closes
    // the channel; the writer task will exit after flushing its queue.
    // A bounded timeout + explicit abort prevents hanging forever (or leaking
    // the writer task) when the socket is already dead.
    drop(client_sender);
    drain_writer(writer_handle).await;
    Ok(())
}

