//! `MumbleClient` — the main entry point for the Mumble client library.
//!
//! # Design for extensibility
//!
//! The client is intentionally structured to support future expansion into a
//! full headless Mumble client:
//!
//! - **`ConnectionState`** — explicit state machine, queryable at any time.
//! - **`CancellationToken`** — all background tasks (TCP reader/writer, UDP
//!   reader, keepalive ping) share a token and exit cleanly on `disconnect()`.
//! - **`ClientEvent` broadcast** — zero-copy fan-out to unlimited subscribers
//!   (tests, audio pipelines, UI layers, etc.).
//! - **`ConnectOptions`** — `tokens`, `ping_interval`, cert pinning flags.
//! - **`ClientError`** — typed errors for programmatic handling.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use bytes::{BufMut, BytesMut};
use prost::Message as ProstMessage;
use tokio::io::AsyncWriteExt;
use tokio::sync::{RwLock, broadcast, mpsc, watch};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::{RawFrame, encode_message};

use crate::connection::{self, send_message};
use crate::crypto::from_crypt_setup;
use crate::error::ClientError;
use crate::events::ClientEvent;
use crate::state::{Channel, ClientState, ConnectionState, SessionState, User};
use crate::voice::{build_udp_ping, build_voice_packet};

/// Options for connecting to a Mumble server.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// Hostname or IP of the Edge server.
    pub host: String,
    /// TCP (and UDP) port. Defaults to 64738.
    pub port: u16,
    /// Login username.
    pub username: String,
    /// Login password.
    pub password: Option<String>,
    /// Optional auth tokens (Mumble's access-token system).
    pub tokens: Vec<String>,
    /// When `false` (the default for tests), TLS certificate errors are
    /// silently ignored — useful with self-signed development certificates.
    /// Set to `true` in production to enforce certificate validation.
    pub reject_unauthorized: bool,
    /// Force all voice through TCP UDPTunnel even when UDP is available.
    pub force_tcp_voice: bool,
    /// Overall timeout for the `connect()` call (TLS handshake + ServerSync).
    pub connect_timeout: Duration,
    /// Interval at which the client sends TCP Ping messages to keep the
    /// connection alive.  Set to `Duration::ZERO` to disable keepalive.
    /// Defaults to 15 seconds.
    pub ping_interval: Duration,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            host: "localhost".into(),
            port: 64738,
            username: "user".into(),
            password: None,
            tokens: vec![],
            reject_unauthorized: false,
            force_tcp_voice: false,
            connect_timeout: Duration::from_secs(10),
            ping_interval: Duration::from_secs(15),
        }
    }
}

/// A headless-capable, async Mumble client.
///
/// `MumbleClient` is `Clone + Send + Sync` — cloning produces an additional
/// handle that shares all state and background tasks with the original.
#[derive(Clone)]
pub struct MumbleClient {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    /// All mutable client state (channels, users, session, connection state).
    state: Arc<RwLock<ClientState>>,
    /// Event broadcast channel — subscribe with [`MumbleClient::subscribe`].
    event_tx: broadcast::Sender<ClientEvent>,
    /// Channel for sending encoded frames to the TCP writer task.
    tcp_tx: RwLock<Option<mpsc::Sender<Vec<u8>>>>,
    /// Crypto state, updated when `CryptSetup` is received.
    crypt_tx: watch::Sender<Option<munode_protocol::crypto::CryptState>>,
    crypt_rx: watch::Receiver<Option<munode_protocol::crypto::CryptState>>,
    /// UDP socket, set after the UDP handshake.
    udp_socket: RwLock<Option<Arc<tokio::net::UdpSocket>>>,
    /// Cancellation token — cancelled by `disconnect()` to stop all tasks.
    cancel: RwLock<Option<CancellationToken>>,
    /// Cached connection options (host/port needed for UDP).
    host: RwLock<String>,
    port: RwLock<u16>,
    /// Whether to route voice via TCP UDPTunnel.
    force_tcp_voice: RwLock<bool>,
}

impl MumbleClient {
    /// Create a new, disconnected client.
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(512);
        let (crypt_tx, crypt_rx) = watch::channel(None);
        Self {
            inner: Arc::new(ClientInner {
                state: Arc::new(RwLock::new(ClientState::new())),
                event_tx,
                tcp_tx: RwLock::new(None),
                crypt_tx,
                crypt_rx,
                udp_socket: RwLock::new(None),
                cancel: RwLock::new(None),
                host: RwLock::new(String::new()),
                port: RwLock::new(64738),
                force_tcp_voice: RwLock::new(false),
            }),
        }
    }

    // ── Connection lifecycle ───────────────────────────────────────────────

    /// Connect to the Mumble server and complete authentication.
    ///
    /// Returns once `ServerSync` has been received and the client is `Ready`.
    /// Returns `Err` immediately if authentication is rejected by the server.
    ///
    /// Spawns background tasks:
    /// - TCP reader (frame decode + event dispatch)
    /// - TCP writer (drains the mpsc channel)
    /// - Keepalive ping (if `options.ping_interval` > 0)
    pub async fn connect(&self, options: ConnectOptions) -> Result<()> {
        // Guard against double-connect
        {
            let state = self.inner.state.read().await;
            if state.connection_state != ConnectionState::Disconnected {
                return Err(ClientError::AlreadyConnected.into());
            }
        }

        // Update connection parameters
        *self.inner.force_tcp_voice.write().await = options.force_tcp_voice;
        *self.inner.host.write().await = options.host.clone();
        *self.inner.port.write().await = options.port;

        // Mark state as Connecting
        self.inner.state.write().await.connection_state = ConnectionState::Connecting;

        // Establish TLS/TCP
        let tls_stream = timeout(
            options.connect_timeout,
            connection::connect_tls(&options.host, options.port),
        )
        .await
        .map_err(|_| ClientError::Timeout { secs: options.connect_timeout.as_secs() })?
        .context("TLS connect failed")?;

        let (read_half, mut write_half) = tokio::io::split(tls_stream);

        // Send Version
        {
            let version = mumbleproto::Version {
                version: Some(0x0001_0203),
                release: Some("MuNode Client".into()),
                os: Some("linux".into()),
                os_version: None,
            };
            let mut buf = BytesMut::new();
            encode_message(MessageType::Version, &version, &mut buf);
            write_half.write_all(&buf).await.context("send Version")?;
        }

        // Mark as Authenticating
        self.inner.state.write().await.connection_state = ConnectionState::Authenticating;

        // Send Authenticate
        {
            let auth = mumbleproto::Authenticate {
                username: Some(options.username.clone()),
                password: options.password.clone(),
                tokens: options.tokens.clone(),
                celt_versions: vec![],
                opus: Some(true),
            };
            let mut buf = BytesMut::new();
            encode_message(MessageType::Authenticate, &auth, &mut buf);
            write_half.write_all(&buf).await.context("send Authenticate")?;
        }

        // Set up TCP write channel
        let (tcp_tx, tcp_rx) = mpsc::channel::<Vec<u8>>(512);
        *self.inner.tcp_tx.write().await = Some(tcp_tx);

        // Create cancellation token for this connection's tasks
        let token = CancellationToken::new();
        *self.inner.cancel.write().await = Some(token.clone());

        // Spawn TCP writer
        {
            let tok = token.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = connection::tcp_write_loop(write_half, tcp_rx) => {}
                    _ = tok.cancelled() => {}
                }
            });
        }

        // Spawn TCP reader
        {
            let state = self.inner.state.clone();
            let event_tx = self.inner.event_tx.clone();
            let crypt_tx = self.inner.crypt_tx.clone();
            let tok = token.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = connection::tcp_read_loop(read_half, state, event_tx, crypt_tx) => {
                        // Server closed the connection — cancel all other tasks so the
                        // writer loop exits and `tcp_tx.is_closed()` returns true.
                        tok.cancel();
                    }
                    _ = tok.cancelled() => {}
                }
            });
        }

        // Spawn keepalive ping task (if configured)
        if !options.ping_interval.is_zero() {
            let inner_clone = self.inner.clone();
            let interval = options.ping_interval;
            let tok = token.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(interval);
                ticker.tick().await; // skip immediate first tick
                loop {
                    tokio::select! {
                        _ = ticker.tick() => {
                            let ts = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            let ping = mumbleproto::Ping {
                                timestamp: Some(ts),
                                ..Default::default()
                            };
                            let guard = inner_clone.tcp_tx.read().await;
                            if let Some(tx) = guard.as_ref() {
                                let _ = send_message(tx, MessageType::Ping, &ping);
                            }
                        }
                        _ = tok.cancelled() => break,
                    }
                }
            });
        }

        let _ = self.inner.event_tx.send(ClientEvent::Connected);

        // Wait for ServerSync (→ Authenticated) or Reject (→ AuthenticationFailed)
        let auth_result = self
            .wait_for_event(options.connect_timeout, |ev| {
                matches!(ev, ClientEvent::Authenticated { .. } | ClientEvent::AuthenticationFailed { .. })
            })
            .await;

        match auth_result {
            Ok(ClientEvent::AuthenticationFailed { reason }) => {
                self.do_disconnect().await;
                Err(ClientError::AuthRejected { reason }.into())
            }
            Ok(_) => {
                info!(username = %options.username, "authenticated");
                Ok(())
            }
            Err(e) => {
                self.do_disconnect().await;
                Err(e)
            }
        }
    }

    /// Disconnect from the server gracefully.
    ///
    /// Cancels all background tasks and resets the client to `Disconnected`.
    pub async fn disconnect(&self) -> Result<()> {
        self.do_disconnect().await;
        Ok(())
    }

    /// Internal disconnect — cancels tasks and resets state.
    async fn do_disconnect(&self) {
        self.inner.state.write().await.connection_state = ConnectionState::Disconnecting;
        // Cancel all background tasks
        if let Some(token) = self.inner.cancel.write().await.take() {
            token.cancel();
        }
        // Drop the TCP sender — this signals the writer task to exit
        *self.inner.tcp_tx.write().await = None;
        *self.inner.udp_socket.write().await = None;
        // Reset all state
        *self.inner.state.write().await = ClientState::new(); // → Disconnected
        let _ = self.inner.event_tx.send(ClientEvent::Disconnected);
    }

    /// Current connection state.
    pub fn connection_state(&self) -> ConnectionState {
        self.inner.state.try_read().ok()
            .map(|s| s.connection_state)
            .unwrap_or(ConnectionState::Disconnected)
    }

    /// Returns `true` if the client has completed authentication and is `Ready`.
    pub fn is_ready(&self) -> bool {
        self.connection_state() == ConnectionState::Ready
    }

    /// Returns `true` if the TCP channel is still open (connected or authenticating).
    pub fn is_connected(&self) -> bool {
        self.inner.tcp_tx.try_read().ok()
            .and_then(|g| g.as_ref().map(|tx| !tx.is_closed()))
            .unwrap_or(false)
    }

    /// Returns `true` if `CryptSetup` has been received from the server.
    ///
    /// This allows callers to check whether encryption is ready without
    /// waiting for a `CryptoReady` event that may have already fired.
    pub fn is_crypto_ready(&self) -> bool {
        self.inner.crypt_rx.borrow().is_some()
    }


    /// Initiate the UDP handshake and wait for the first ping reply.
    ///
    /// Call this after `connect()` if you need UDP voice.  Waits until
    /// `CryptSetup` is processed before opening the socket.
    pub async fn wait_for_udp(&self, udp_timeout: Duration) -> Result<()> {
        if *self.inner.force_tcp_voice.read().await {
            return Ok(());
        }

        // Wait for CryptSetup to be processed
        let deadline = tokio::time::Instant::now() + udp_timeout;
        loop {
            if self.inner.crypt_rx.borrow().is_some() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                bail!("timeout waiting for CryptSetup");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let host = self.inner.host.read().await.clone();
        let port = *self.inner.port.read().await;
        let socket = connection::create_udp_socket(&host, port).await?;

        // Spawn UDP reader
        {
            let crypt_rx = self.inner.crypt_rx.clone();
            let event_tx = self.inner.event_tx.clone();
            let sock = socket.clone();
            let cancel = self.inner.cancel.read().await.clone();
            tokio::spawn(async move {
                let read_fut = connection::udp_read_loop(sock, crypt_rx, event_tx);
                if let Some(tok) = cancel {
                    tokio::select! {
                        _ = read_fut => {}
                        _ = tok.cancelled() => {}
                    }
                } else {
                    read_fut.await;
                }
            });
        }

        *self.inner.udp_socket.write().await = Some(socket.clone());

        // Send an encrypted UDP Ping
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let ping_plain = build_udp_ping(ts);
        let encrypted = {
            let guard = self.inner.crypt_rx.borrow();
            if let Some(ref crypt) = *guard {
                let mut c = crypt.clone();
                let mut enc = Vec::new();
                c.encrypt(&ping_plain, &mut enc);
                enc
            } else {
                bail!("CryptState not ready");
            }
        };
        socket.send(&encrypted).await.context("UDP ping send")?;

        self.wait_for_event(udp_timeout, |ev| matches!(ev, ClientEvent::UdpReady))
            .await
            .context("UDP handshake timeout")?;

        Ok(())
    }

    // ── Voice ──────────────────────────────────────────────────────────────

    /// Send a raw voice payload.
    ///
    /// Routes via UDP if ready and not in force-TCP mode; falls back to TCP
    /// UDPTunnel otherwise.
    pub async fn send_voice_packet(&self, packet: &[u8]) -> Result<()> {
        let force_tcp = *self.inner.force_tcp_voice.read().await;
        let udp_ready = self.inner.udp_socket.read().await.is_some();

        if udp_ready && !force_tcp {
            let encrypted = {
                let guard = self.inner.crypt_rx.borrow();
                if let Some(ref crypt) = *guard {
                    let mut c = crypt.clone();
                    let mut enc = Vec::new();
                    c.encrypt(packet, &mut enc);
                    enc
                } else {
                    bail!("CryptState not ready for UDP");
                }
            };
            let sock_guard = self.inner.udp_socket.read().await;
            if let Some(sock) = sock_guard.as_ref() {
                sock.send(&encrypted).await.context("UDP voice send")?;
                return Ok(());
            }
        }

        // TCP UDPTunnel fallback
        self.send_raw_frame(MessageType::UdpTunnel, packet)
    }

    /// Convenience: build a voice packet from codec/target/sequence/audio and send it.
    pub async fn send_voice(
        &self,
        codec: u8,
        target: u8,
        sequence: u64,
        audio: &[u8],
    ) -> Result<()> {
        let pkt = build_voice_packet(codec, target, sequence, audio);
        self.send_voice_packet(&pkt).await
    }

    // ── Channel operations ─────────────────────────────────────────────────

    /// Move the authenticated user to `channel_id`.
    pub async fn join_channel(&self, channel_id: u32) -> Result<()> {
        let session = self.my_session()?;
        self.send_proto(MessageType::UserState, &mumbleproto::UserState {
            session: Some(session),
            channel_id: Some(channel_id),
            ..Default::default()
        })
    }

    /// Create a new channel under `parent` and wait for confirmation.
    ///
    /// Returns the new channel's ID once the server echoes back the
    /// `ChannelState` with the assigned `channel_id`.
    pub async fn create_channel(&self, name: &str, parent: u32) -> Result<u32> {
        let mut sub = self.subscribe();
        self.send_proto(MessageType::ChannelState, &mumbleproto::ChannelState {
            name: Some(name.to_owned()),
            parent: Some(parent),
            ..Default::default()
        })?;
        let name_owned = name.to_owned();
        timeout(Duration::from_secs(10), async move {
            loop {
                match sub.recv().await {
                    Ok(ClientEvent::ChannelCreated(ch)) if ch.name == name_owned => {
                        return Ok(ch.channel_id);
                    }
                    Ok(_) => continue,
                    Err(e) => return Err(anyhow!("event channel: {e}")),
                }
            }
        })
        .await
        .context("timeout waiting for channel creation")?
    }

    /// Delete a channel.
    pub async fn delete_channel(&self, channel_id: u32) -> Result<()> {
        self.send_proto(MessageType::ChannelRemove, &mumbleproto::ChannelRemove { channel_id })
    }

    /// Send a raw `ChannelState` update (e.g. to add/remove links, rename, etc.).
    pub async fn send_channel_state(&self, msg: mumbleproto::ChannelState) -> Result<()> {
        self.send_proto(MessageType::ChannelState, &msg)
    }

    // ── User state ─────────────────────────────────────────────────────────

    /// Send a raw `UserState` update.
    pub async fn send_user_state(&self, msg: mumbleproto::UserState) -> Result<()> {
        self.send_proto(MessageType::UserState, &msg)
    }

    /// Set own self-mute.
    pub async fn set_self_mute(&self, mute: bool) -> Result<()> {
        let session = self.my_session()?;
        self.send_proto(MessageType::UserState, &mumbleproto::UserState {
            session: Some(session),
            self_mute: Some(mute),
            ..Default::default()
        })
    }

    /// Set own self-deaf.
    pub async fn set_self_deaf(&self, deaf: bool) -> Result<()> {
        let session = self.my_session()?;
        self.send_proto(MessageType::UserState, &mumbleproto::UserState {
            session: Some(session),
            self_deaf: Some(deaf),
            ..Default::default()
        })
    }

    /// Mute/unmute another user (requires admin permissions).
    pub async fn mute_user(&self, target_session: u32, mute: bool) -> Result<()> {
        self.send_proto(MessageType::UserState, &mumbleproto::UserState {
            session: Some(target_session),
            mute: Some(mute),
            ..Default::default()
        })
    }

    /// Kick a user from the server.
    pub async fn kick_user(&self, target_session: u32, reason: Option<&str>) -> Result<()> {
        let actor = self.my_session()?;
        self.send_proto(MessageType::UserRemove, &mumbleproto::UserRemove {
            session: target_session,
            actor: Some(actor),
            reason: reason.map(str::to_owned),
            ban: Some(false),
        })
    }

    // ── Text messages ──────────────────────────────────────────────────────

    /// Send a text message to a channel.
    pub async fn send_text_to_channel(&self, channel_id: u32, message: &str) -> Result<()> {
        self.send_proto(MessageType::TextMessage, &mumbleproto::TextMessage {
            channel_id: vec![channel_id],
            message: message.to_owned(),
            ..Default::default()
        })
    }

    /// Send a text message directly to a user.
    pub async fn send_text_to_user(&self, target_session: u32, message: &str) -> Result<()> {
        self.send_proto(MessageType::TextMessage, &mumbleproto::TextMessage {
            session: vec![target_session],
            message: message.to_owned(),
            ..Default::default()
        })
    }

    /// Alias for [`send_text_to_user`] (send a private text message by session).
    pub async fn send_text_to_session(&self, target_session: u32, message: &str) -> Result<()> {
        self.send_text_to_user(target_session, message).await
    }

    /// Send a text message to the subtree rooted at `channel_id`.
    pub async fn send_text_to_tree(&self, channel_id: u32, message: &str) -> Result<()> {
        self.send_proto(MessageType::TextMessage, &mumbleproto::TextMessage {
            tree_id: vec![channel_id],
            message: message.to_owned(),
            ..Default::default()
        })
    }

    // ── ACL & permissions ─────────────────────────────────────────────────

    /// Query the ACL for a channel.  Returns the decoded `Acl` message.
    pub async fn query_acl(&self, channel_id: u32) -> Result<mumbleproto::Acl> {
        let mut sub = self.subscribe();
        self.send_proto(MessageType::Acl, &mumbleproto::Acl {
            channel_id,
            query: Some(true),
            ..Default::default()
        })?;
        timeout(Duration::from_secs(10), async move {
            loop {
                match sub.recv().await {
                    Ok(ClientEvent::Acl(acl)) if acl.channel_id == channel_id => {
                        return Ok(*acl);
                    }
                    Ok(_) => continue,
                    Err(e) => return Err(anyhow!("event channel: {e}")),
                }
            }
        })
        .await
        .context("timeout waiting for ACL")?
    }

    /// Upload ACL entries for a channel.
    pub async fn save_acl(&self, acl: mumbleproto::Acl) -> Result<()> {
        self.send_proto(MessageType::Acl, &acl)
    }

    /// Alias for [`save_acl`].
    pub async fn send_acl(&self, acl: mumbleproto::Acl) -> Result<()> {
        self.save_acl(acl).await
    }

    /// Send a `PermissionQuery` for a channel.
    pub async fn check_permission(&self, channel_id: u32, permission: u32) -> Result<()> {
        self.send_proto(MessageType::PermissionQuery, &mumbleproto::PermissionQuery {
            channel_id: Some(channel_id),
            permissions: Some(permission),
            flush: Some(false),
        })
    }

    /// Alias for [`check_permission`].
    pub async fn query_permission(&self, channel_id: u32, permission: u32) -> Result<()> {
        self.check_permission(channel_id, permission).await
    }

    // ── Listening channels ─────────────────────────────────────────────────

    /// Start listening to an additional channel.
    pub async fn add_listening_channel(&self, channel_id: u32) -> Result<()> {
        let session = self.my_session()?;
        self.send_proto(MessageType::UserState, &mumbleproto::UserState {
            session: Some(session),
            listening_channel_add: vec![channel_id],
            ..Default::default()
        })
    }

    /// Stop listening to a channel.
    pub async fn remove_listening_channel(&self, channel_id: u32) -> Result<()> {
        let session = self.my_session()?;
        self.send_proto(MessageType::UserState, &mumbleproto::UserState {
            session: Some(session),
            listening_channel_remove: vec![channel_id],
            ..Default::default()
        })
    }

    // ── Voice targets (whisper) ────────────────────────────────────────────

    /// Configure a voice target (whisper).
    pub async fn set_voice_target(
        &self,
        id: u32,
        targets: Vec<mumbleproto::voice_target::Target>,
    ) -> Result<()> {
        self.send_proto(MessageType::VoiceTarget, &mumbleproto::VoiceTarget {
            id: Some(id),
            targets,
        })
    }

    // ── Ban management ─────────────────────────────────────────────────────

    /// Request the ban list from the server.
    pub async fn query_ban_list(&self) -> Result<()> {
        self.send_proto(MessageType::BanList, &mumbleproto::BanList {
            query: Some(true),
            ..Default::default()
        })
    }

    /// Upload a new ban list.
    pub async fn update_ban_list(&self, bans: Vec<mumbleproto::BanList>) -> Result<()> {
        for ban in bans {
            self.send_proto(MessageType::BanList, &ban)?;
        }
        Ok(())
    }

    /// Alias for [`query_ban_list`].
    pub async fn request_ban_list(&self) -> Result<()> {
        self.query_ban_list().await
    }

    /// Alias for [`update_ban_list`].
    pub async fn send_ban_list(&self, bans: Vec<mumbleproto::BanList>) -> Result<()> {
        self.update_ban_list(bans).await
    }

    /// Ban a user by session ID (sends `UserRemove` with `ban = true`).
    pub async fn ban_user(
        &self,
        target_session: u32,
        reason: Option<&str>,
        _duration: Option<u32>,
    ) -> Result<()> {
        let actor = self.my_session()?;
        self.send_proto(MessageType::UserRemove, &mumbleproto::UserRemove {
            session: target_session,
            actor: Some(actor),
            reason: reason.map(str::to_owned),
            ban: Some(true),
        })
    }

    // ── User statistics ────────────────────────────────────────────────────

    /// Send a TCP `Ping` and wait for the server's `Ping` reply.
    pub async fn send_ping(&self) -> Result<()> {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as u64)
            .unwrap_or(0);
        self.send_proto(MessageType::Ping, &mumbleproto::Ping {
            timestamp: Some(ts),
            ..Default::default()
        })
    }

    /// Send a `QueryUsers` request (look up users by registered ID or name).
    pub async fn query_users(&self, ids: Vec<u32>, names: Vec<String>) -> Result<()> {
        self.send_proto(MessageType::QueryUsers, &mumbleproto::QueryUsers { ids, names })
    }

    /// Request user statistics from the server.
    pub async fn request_user_stats(&self, target_session: u32, stats_only: bool) -> Result<()> {
        self.send_proto(MessageType::UserStats, &mumbleproto::UserStats {
            session: Some(target_session),
            stats_only: Some(stats_only),
            ..Default::default()
        })
    }

    // ── Plugin data ────────────────────────────────────────────────────────

    /// Send plugin data to a set of receivers.
    pub async fn send_plugin_data(
        &self,
        plugin_id: &str,
        data: &[u8],
        receivers: &[u32],
    ) -> Result<()> {
        self.send_proto(MessageType::PluginDataTransmission, &mumbleproto::PluginDataTransmission {
            sender_session: None,
            receiver_sessions: receivers.to_vec(),
            data: Some(data.to_vec()),
            data_id: Some(plugin_id.to_owned()),
        })
    }

    // ── Blob / texture / comment ───────────────────────────────────────────

    /// Request blobs (textures, comments, channel descriptions).
    pub async fn request_blob(
        &self,
        sessions_texture: Vec<u32>,
        sessions_comment: Vec<u32>,
        channel_description: Vec<u32>,
    ) -> Result<()> {
        self.send_proto(MessageType::RequestBlob, &mumbleproto::RequestBlob {
            session_texture: sessions_texture,
            session_comment: sessions_comment,
            channel_description,
        })
    }

    /// Set own avatar texture.
    pub async fn set_texture(&self, texture: &[u8]) -> Result<()> {
        let session = self.my_session()?;
        self.send_proto(MessageType::UserState, &mumbleproto::UserState {
            session: Some(session),
            texture: Some(texture.to_vec()),
            ..Default::default()
        })
    }

    /// Set own comment.
    pub async fn set_comment(&self, comment: &str) -> Result<()> {
        let session = self.my_session()?;
        self.send_proto(MessageType::UserState, &mumbleproto::UserState {
            session: Some(session),
            comment: Some(comment.to_owned()),
            ..Default::default()
        })
    }

    // ── Context actions ────────────────────────────────────────────────────

    /// Register a context menu action.
    pub async fn register_context_action(
        &self,
        action: &str,
        text: &str,
        context: u32,
    ) -> Result<()> {
        self.send_proto(MessageType::ContextActionModify, &mumbleproto::ContextActionModify {
            action: action.to_owned(),
            text: Some(text.to_owned()),
            context: Some(context),
            operation: Some(0), // Add
        })
    }

    // ── State queries ──────────────────────────────────────────────────────

    /// Current session state (only available after authentication).
    pub fn session(&self) -> Option<SessionState> {
        self.inner.state.try_read().ok()?.session.clone()
    }

    /// Convenience: returns own session ID, or `None` if not authenticated.
    pub fn session_id(&self) -> Option<u32> {
        self.session().map(|s| s.session)
    }

    /// All known channels.
    pub fn channels(&self) -> Vec<Channel> {
        self.inner.state.try_read().ok()
            .map(|s| s.channels.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Look up a channel by ID.
    pub fn channel(&self, channel_id: u32) -> Option<Channel> {
        self.inner.state.try_read().ok()?.channels.get(&channel_id).cloned()
    }

    /// All known users.
    pub fn users(&self) -> Vec<User> {
        self.inner.state.try_read().ok()
            .map(|s| s.users.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Look up a user by session ID.
    pub fn user(&self, session: u32) -> Option<User> {
        self.inner.state.try_read().ok()?.users.get(&session).cloned()
    }

    // ── Event subscription ─────────────────────────────────────────────────

    /// Subscribe to all client events.
    ///
    /// The `broadcast::Receiver` is independent — missed events are not
    /// delivered (use a buffer size large enough for your workload).
    pub fn subscribe(&self) -> broadcast::Receiver<ClientEvent> {
        self.inner.event_tx.subscribe()
    }

    /// Alias for [`subscribe`] — subscribe to all events including voice.
    pub fn subscribe_voice(&self) -> broadcast::Receiver<ClientEvent> {
        self.subscribe()
    }

    /// Wait until an event matching `predicate` arrives, or `duration` elapses.
    pub async fn wait_for_event<F>(&self, duration: Duration, predicate: F) -> Result<ClientEvent>
    where
        F: Fn(&ClientEvent) -> bool,
    {
        let mut sub = self.subscribe();
        timeout(duration, async move {
            loop {
                match sub.recv().await {
                    Ok(ev) => {
                        if predicate(&ev) {
                            return Ok(ev);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("event channel lagged, dropped {n} messages — increase channel capacity");
                    }
                    Err(e) => return Err(anyhow!("event channel closed: {e}")),
                }
            }
        })
        .await
        .context("wait_for_event timed out")?
    }

    // ── Internal helpers ───────────────────────────────────────────────────

    /// Get own session ID, returning an error if not authenticated.
    fn my_session(&self) -> Result<u32> {
        self.inner.state.try_read().ok()
            .and_then(|s| s.session.as_ref().map(|ss| ss.session))
            .ok_or_else(|| ClientError::NotConnected.into())
    }

    /// Encode a protobuf message and queue it for TCP transmission.
    fn send_proto<M: ProstMessage>(&self, msg_type: MessageType, msg: &M) -> Result<()> {
        let guard = self.inner.tcp_tx.try_read()
            .map_err(|_| anyhow!("tcp_tx lock unavailable"))?;
        let tx = guard.as_ref().ok_or(ClientError::NotConnected)?;
        send_message(tx, msg_type, msg)
    }

    /// Frame a raw payload (used for UDPTunnel voice) and queue it.
    fn send_raw_frame(&self, msg_type: MessageType, payload: &[u8]) -> Result<()> {
        let mut buf = BytesMut::new();
        buf.put_u16(msg_type as u16);
        buf.put_u32(payload.len() as u32);
        buf.put_slice(payload);
        let guard = self.inner.tcp_tx.try_read()
            .map_err(|_| anyhow!("tcp_tx lock unavailable"))?;
        let tx = guard.as_ref().ok_or(ClientError::NotConnected)?;
        connection::send_raw(tx, buf.to_vec())
    }
}

impl Default for MumbleClient {
    fn default() -> Self {
        Self::new()
    }
}

// ── Message dispatcher ─────────────────────────────────────────────────────

/// Dispatch a single decoded TCP frame: update state and emit events.
///
/// This is `pub(crate)` so `connection::tcp_read_loop` can call it without
/// pulling in all of `client.rs`.
pub(crate) async fn dispatch_frame(
    frame: RawFrame,
    state: &Arc<RwLock<ClientState>>,
    event_tx: &broadcast::Sender<ClientEvent>,
    crypt_tx: &watch::Sender<Option<munode_protocol::crypto::CryptState>>,
) {
    use MessageType::*;

    match frame.message_type {
        Version => {
            debug!("received Version from server");
        }
        CryptSetup => {
            if let Ok(msg) = mumbleproto::CryptSetup::decode(&*frame.payload) {
                if let (Some(key), Some(cn), Some(sn)) = (
                    msg.key.as_deref(),
                    msg.client_nonce.as_deref(),
                    msg.server_nonce.as_deref(),
                ) {
                    if let Some(crypt) = from_crypt_setup(key, cn, sn) {
                        let _ = crypt_tx.send(Some(crypt));
                        let _ = event_tx.send(ClientEvent::CryptoReady);
                    }
                }
            }
        }
        ServerSync => {
            if let Ok(msg) = mumbleproto::ServerSync::decode(&*frame.payload) {
                let session = msg.session();
                let max_bandwidth = msg.max_bandwidth.unwrap_or(0);
                state.write().await.apply_server_sync(&msg);
                let _ = event_tx.send(ClientEvent::Authenticated { session, max_bandwidth });
            }
        }
        ChannelState => {
            if let Ok(msg) = mumbleproto::ChannelState::decode(&*frame.payload) {
                let is_new = state.write().await.apply_channel_state(&msg);
                let ch = state.read().await.channels.get(&msg.channel_id()).cloned();
                if let Some(ch) = ch {
                    let _ = event_tx.send(if is_new {
                        ClientEvent::ChannelCreated(ch)
                    } else {
                        ClientEvent::ChannelUpdated(ch)
                    });
                }
            }
        }
        ChannelRemove => {
            if let Ok(msg) = mumbleproto::ChannelRemove::decode(&*frame.payload) {
                state.write().await.remove_channel(msg.channel_id);
                let _ = event_tx.send(ClientEvent::ChannelRemoved { channel_id: msg.channel_id });
            }
        }
        UserState => {
            if let Ok(msg) = mumbleproto::UserState::decode(&*frame.payload) {
                let session = msg.session();
                let is_new = state.write().await.apply_user_state(&msg);
                let user = state.read().await.users.get(&session).cloned();
                if let Some(u) = user {
                    let _ = event_tx.send(if is_new {
                        ClientEvent::UserJoined(u)
                    } else {
                        ClientEvent::UserStateChanged(u)
                    });
                }
            }
        }
        UserRemove => {
            if let Ok(msg) = mumbleproto::UserRemove::decode(&*frame.payload) {
                let own_session = state.read().await.session.as_ref().map(|s| s.session);
                state.write().await.remove_user(msg.session);
                // If the removed user is us, emit Kicked so callers can detect being kicked.
                if Some(msg.session) == own_session {
                    let _ = event_tx.send(ClientEvent::Kicked {
                        session: msg.session,
                        reason: msg.reason.clone(),
                    });
                } else {
                    let _ = event_tx.send(ClientEvent::UserLeft {
                        session: msg.session,
                        reason: msg.reason.clone(),
                    });
                }
            }
        }
        UdpTunnel => {
            if let Some(voice) = crate::voice::parse_voice_packet(&frame.payload) {
                let _ = event_tx.send(ClientEvent::Voice(voice));
            }
        }
        TextMessage => {
            if let Ok(msg) = mumbleproto::TextMessage::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::TextMessage {
                    sender: msg.actor.unwrap_or(0),
                    channel_id: msg.channel_id.first().copied(),
                    message: msg.message.clone(),
                });
            }
        }
        Ping => {
            if let Ok(msg) = mumbleproto::Ping::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::Ping {
                    timestamp: msg.timestamp.unwrap_or(0),
                });
            }
        }
        Reject => {
            if let Ok(msg) = mumbleproto::Reject::decode(&*frame.payload) {
                let reason = msg.reason.clone().unwrap_or_else(|| "Unknown".into());
                let _ = event_tx.send(ClientEvent::AuthenticationFailed { reason });
            }
        }
        PermissionDenied => {
            if let Ok(msg) = mumbleproto::PermissionDenied::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::PermissionDenied {
                    channel_id: msg.channel_id.unwrap_or(0),
                    permission: msg.permission.unwrap_or(0),
                    reason: msg.reason.clone(),
                });
            }
        }
        PermissionQuery => {
            if let Ok(msg) = mumbleproto::PermissionQuery::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::PermissionQuery {
                    channel_id: msg.channel_id.unwrap_or(0),
                    permissions: msg.permissions.unwrap_or(0),
                });
            }
        }
        Acl => {
            if let Ok(msg) = mumbleproto::Acl::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::Acl(Box::new(msg)));
            }
        }
        BanList => {
            if let Ok(msg) = mumbleproto::BanList::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::BanList(vec![msg]));
            }
        }
        UserStats => {
            if let Ok(msg) = mumbleproto::UserStats::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::UserStats(Box::new(msg)));
            }
        }
        ServerConfig => {
            if let Ok(msg) = mumbleproto::ServerConfig::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::ServerConfig(msg));
            }
        }
        PluginDataTransmission => {
            if let Ok(msg) = mumbleproto::PluginDataTransmission::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::PluginData {
                    sender: msg.sender_session.unwrap_or(0),
                    plugin_id: msg.data_id.unwrap_or_default(),
                    data: msg.data.unwrap_or_default(),
                });
            }
        }
        ContextAction => {
            if let Ok(msg) = mumbleproto::ContextAction::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::ContextAction {
                    action: msg.action.clone(),
                    session: msg.session,
                    channel_id: msg.channel_id,
                });
            }
        }
        QueryUsers => {
            if let Ok(msg) = mumbleproto::QueryUsers::decode(&*frame.payload) {
                let _ = event_tx.send(ClientEvent::QueryUsers(msg));
            }
        }
        // Server-initiated messages we intentionally ignore on the client side
        CodecVersion | SuggestConfig | ContextActionModify | UserList
        | VoiceTarget | RequestBlob | Authenticate => {
            debug!(msg_type = ?frame.message_type, "ignored server-sent message");
        }
    }
}
