use std::sync::Arc;

use anyhow::Result;
use bytes::BytesMut;
use prost::Message;
use sha1::{Digest as Sha1Digest, Sha1};
use tracing::debug;

use munode_common::config::EdgeConfig;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::encode_message;

use crate::channel_manager::ChannelData;
use crate::client::{ClientInfo, ClientSender};
use crate::crypto::CryptState;
use crate::hub_client::HubClient;
use crate::state::EdgeState;

/// Data returned by [`LoginHandler::execute_login`] that is needed to send the
/// final end-of-login messages (ServerSync, ServerConfig, SuggestConfig) from
/// the outer connection loop **after** the client state has been set to `Ready`.
///
/// Matching Murmur's pattern: state → Authenticated (≅ Ready) FIRST, then
/// ServerSync is sent.  This ensures that when the client responds with
/// `UserState{channel_id}` the server is already in the correct state.
#[derive(Debug)]
pub struct LoginInfo {
    /// Effective permissions on channel 0 (root) for this session, to be sent
    /// in `ServerSync.permissions`.  Allows the Mumble client to cache the
    /// value and to avoid spamming PermissionQuery on startup.
    pub root_permissions: u32,
}

/// Handles the Mumble protocol login sequence for a client.
///
/// After authentication succeeds, sends in order:
/// 1. CryptSetup (encryption keys) — **skipped** when `skip_crypt_setup = true`
/// 2. CodecVersion
/// 3. ChannelState (for all channels, BFS order)
/// 4. UserState (for all other users)
/// 5. Self UserState
///
/// The caller (outer connection loop) is responsible for sending:
/// 6. ServerSync  — after transitioning client state to `Ready`
/// 7. ServerConfig / SuggestConfig
pub struct LoginHandler<'a> {
    sender: &'a ClientSender,
    config: &'a EdgeConfig,
    edge_state: &'a Arc<EdgeState>,
    hub_client: &'a Arc<HubClient>,
    /// When `true`, the CryptSetup message is omitted from the login sequence.
    /// Set for WebTransport and WebSocket connections where transport-layer AEAD
    /// makes OCB2-AES128 redundant.
    pub skip_crypt_setup: bool,
}

impl<'a> LoginHandler<'a> {
    pub fn new(
        sender: &'a ClientSender,
        config: &'a EdgeConfig,
        edge_state: &'a Arc<EdgeState>,
        hub_client: &'a Arc<HubClient>,
    ) -> Self {
        Self {
            sender,
            config,
            edge_state,
            hub_client,
            skip_crypt_setup: false,
        }
    }

    /// Create a `LoginHandler` with `skip_crypt_setup` set.
    /// Used for WebTransport and WebSocket connections.
    pub fn new_no_crypt(
        sender: &'a ClientSender,
        config: &'a EdgeConfig,
        edge_state: &'a Arc<EdgeState>,
        hub_client: &'a Arc<HubClient>,
    ) -> Self {
        Self {
            sender,
            config,
            edge_state,
            hub_client,
            skip_crypt_setup: true,
        }
    }

    /// Execute the pre-ServerSync portion of the login sequence.
    ///
    /// Sends: CryptSetup → CodecVersion → ChannelStates → UserStates (remote
    /// + local) → Self UserState.
    ///
    /// Does **not** send ServerSync / ServerConfig / SuggestConfig.  Those
    /// must be sent by the outer connection loop *after* the client state has
    /// been transitioned to `Ready`, matching Murmur's ordering (state set to
    /// Authenticated before ServerSync is transmitted).
    ///
    /// Returns [`LoginInfo`] with data required by the outer loop to compose
    /// the final end-of-login messages.
    pub async fn execute_login(
        &self,
        session_id: u32,
        auth_result: &munode_protocol::hubedge::EdgeAuthenticateUserResult,
    ) -> Result<LoginInfo> {
        debug!(session_id, "Login sequence started");

        // 1. Send CryptSetup and initialise OCB2 state for this session
        //    Skip for WebTransport / WebSocket: transport-layer AEAD covers encryption.
        if !self.skip_crypt_setup {
            debug!(session_id, "Step 1: sending CryptSetup");
            self.send_crypt_setup(session_id).await?;
        } else {
            debug!(
                session_id,
                "Step 1: skipping CryptSetup (non-TLS transport)"
            );
        }

        // 2. Send CodecVersion (Opus only)
        debug!(session_id, "Step 2: sending CodecVersion");
        self.send_codec_version().await?;

        // The initial login path no longer blocks on full-tree ACL evaluation.
        // Global lock/restricted icon state is backfilled asynchronously after
        // the client becomes Ready; here we only fetch the channel tree itself.
        debug!(session_id, "Step 3: fetching channel list");
        let channels = self.edge_state.channel_manager.get_channels_bfs().await;
        debug!(
            session_id,
            channel_count = channels.len(),
            "Fetched {} channels",
            channels.len()
        );
        let perm_map = std::collections::HashMap::new();

        // 3. Send channel tree (BFS order) without blocking on full-tree permission state.
        debug!(session_id, "Step 4: sending channel tree (BFS order)");
        self.send_channel_tree_with_perms(&channels, &perm_map)
            .await?;

        // 4. Send UserState for all remote users
        debug!(session_id, "Step 5: sending remote user states");
        self.send_remote_users(session_id).await?;

        // 5. Send self UserState
        debug!(session_id, "Step 6: sending self UserState");
        self.send_self_user_state(session_id, auth_result).await?;

        // 6. Send PermissionQuery for target channel + parent, matching Murmur's
        //    userEnterChannel → sendClientPermission() calls.  This lets the client
        //    immediately cache its permissions in the joined channel without waiting
        //    for a client-initiated PermissionQuery round-trip.
        let target_channel = auth_result
            .channel_id
            .unwrap_or(self.config.server.default_channel);
        debug!(
            session_id,
            target_channel, "Step 7: sending PermissionQuery for target channel + parent"
        );
        self.send_channel_permission_queries(session_id, target_channel)
            .await?;

        // Root permissions still need to be ready for ServerSync.
        let root_permissions = self
            .query_login_channel_permissions(session_id, 0)
            .await
            .unwrap_or(0);

        debug!(session_id, "Pre-ServerSync login sequence completed");
        Ok(LoginInfo { root_permissions })
    }

    async fn query_login_channel_permissions(
        &self,
        session_id: u32,
        channel_id: u32,
    ) -> Option<u32> {
        if let Some(cached) = self
            .edge_state
            .permission_cache
            .get(&(session_id, channel_id))
        {
            return Some(*cached);
        }

        let result = self
            .hub_client
            .handle_permission_query(session_id, channel_id)
            .await
            .ok()?;
        let permissions = result.permissions.unwrap_or(0);
        self.edge_state
            .permission_cache
            .insert((session_id, channel_id), permissions);
        Some(permissions)
    }

    /// Send CryptSetup with generated encryption keys, and register the CryptState
    /// for this session in the ClientManager.
    ///
    /// Key assignment:
    /// - `key`           : 16-byte AES-128 key (shared secret)
    /// - `server_nonce`  : server's encrypt IV (server→client direction)
    /// - `client_nonce`  : client's encrypt IV = server's decrypt IV (client→server direction)
    async fn send_crypt_setup(&self, session_id: u32) -> Result<()> {
        let mut key = [0u8; 16];
        let mut client_nonce = [0u8; 16];
        let mut server_nonce = [0u8; 16];

        use ring::rand::{SecureRandom, SystemRandom};
        let rng = SystemRandom::new();
        rng.fill(&mut key)
            .map_err(|_| anyhow::anyhow!("RNG failed"))?;
        rng.fill(&mut client_nonce)
            .map_err(|_| anyhow::anyhow!("RNG failed"))?;
        rng.fill(&mut server_nonce)
            .map_err(|_| anyhow::anyhow!("RNG failed"))?;

        // Build and store CryptState for this session
        let mut crypt = CryptState::new();
        // encrypt_iv = server_nonce (server→client)
        // decrypt_iv = client_nonce (client→server, so server decrypts using this)
        crypt.set_key(&key, &server_nonce, &client_nonce);
        self.edge_state
            .client_manager
            .set_crypt_state(session_id, crypt)
            .await;

        let msg = mumbleproto::CryptSetup {
            key: Some(key.to_vec()),
            client_nonce: Some(client_nonce.to_vec()),
            server_nonce: Some(server_nonce.to_vec()),
        };
        self.send(MessageType::CryptSetup, &msg).await?;
        debug!("Sent CryptSetup for session {}", session_id);
        Ok(())
    }

    /// Send CodecVersion.
    /// This server only supports Opus; CELT is not supported.
    async fn send_codec_version(&self) -> Result<()> {
        let msg = mumbleproto::CodecVersion {
            alpha: 0,
            beta: 0,
            prefer_alpha: false,
            opus: Some(true),
        };
        self.send(MessageType::CodecVersion, &msg).await?;
        debug!("Sent CodecVersion (opus=true)");
        Ok(())
    }

    /// Send the full channel tree in BFS order.
    ///
    /// `perm_map` maps channel_id → (effective_permissions, is_enter_restricted) for the
    /// logging-in user (pre-fetched in a single batch RPC call to avoid N round trips).
    /// `can_enter` is derived from the ENTER bit; `is_enter_restricted` is a channel-level
    /// property indicating whether any ACL denies Enter for any user (mirrors Murmur's
    /// isChannelEnterRestricted()). Both fields are always set when perm_map is non-empty.
    async fn send_channel_tree_with_perms(
        &self,
        channels: &[crate::channel_manager::ChannelData],
        perm_map: &std::collections::HashMap<u32, (u32, bool)>,
    ) -> Result<()> {
        use munode_common::permission as perm;

        // Pass 1: Send all channels with their basic info
        for ch in channels {
            // Compute description_hash (SHA1) when description is non-empty,
            // so the client can request the full description via RequestBlob if needed.
            // Both None and empty string are treated as "no description" (matching Murmur's
            // `if (!c->qsDesc.isEmpty())` guard — empty descriptions are never sent).
            let (description, description_hash) = match ch.description.as_deref() {
                Some(desc) if !desc.is_empty() => {
                    let hash = Sha1::digest(desc.as_bytes());
                    (None, Some(hash.to_vec()))
                }
                _ => (None, None),
            };

            // Derive can_enter and is_enter_restricted from the pre-fetched data.
            // When the perm_map is empty (batch query failed) we fail open (can_enter=true).
            // Both fields are always sent (Some) when the map is populated, matching
            // Murmur which unconditionally calls set_is_enter_restricted() and set_can_enter().
            let (can_enter, is_enter_restricted) = if perm_map.is_empty() {
                (None, None)
            } else {
                let (perms, ch_restricted) = perm_map.get(&ch.id).copied().unwrap_or((0, false));
                let enter = perms & perm::ENTER != 0;
                // Populate enter_restricted_cache so AclUpdated events need no extra RPC.
                self.edge_state
                    .enter_restricted_cache
                    .insert(ch.id, ch_restricted);
                (Some(enter), Some(ch_restricted))
            };

            let msg = mumbleproto::ChannelState {
                channel_id: Some(ch.id),
                parent: ch.parent_id,
                name: Some(ch.name.clone()),
                description,
                description_hash,
                position: Some(ch.position),
                temporary: Some(ch.temporary),
                max_users: Some(ch.max_users),
                is_enter_restricted,
                can_enter,
                ..Default::default()
            };
            self.send(MessageType::ChannelState, &msg).await?;
        }

        // Pass 2: Send channel links
        for ch in channels {
            if !ch.links.is_empty() {
                let msg = mumbleproto::ChannelState {
                    channel_id: Some(ch.id),
                    links_add: ch.links.clone(),
                    ..Default::default()
                };
                self.send(MessageType::ChannelState, &msg).await?;
            }
        }

        debug!("Sent {} channels", channels.len());
        Ok(())
    }

    /// Send UserState for all remote users.
    ///
    /// Boolean flags are only included when `true` to avoid spurious
    /// client-side notifications for new-to-client users.
    async fn send_remote_users(&self, self_session: u32) -> Result<()> {
        let remote_users = self.edge_state.channel_manager.get_all_remote_users().await;
        let local_clients = self.edge_state.client_manager.get_all_clients().await;

        // Build a set of local session IDs so we can skip them when iterating
        // remote_users. Normally local users should not be in remote_users (the
        // hub.userJoined handler now skips is_local users), but the initial
        // full_sync from Hub may still include sessions that belong to this edge
        // if Hub hasn't cleaned them up yet.
        let local_sessions: std::collections::HashSet<u32> =
            local_clients.iter().map(|c| c.session).collect();

        // Snapshot the ninja channel config and this client's visibility cache once,
        // before the loops, to avoid repeated lock acquisitions per user.
        // Note: There is a benign TOCTOU window between the two lock acquisitions; in
        // practice ninja_channels only changes on Hub config updates (rare), so a brief
        // inconsistency here is acceptable.
        let ninja_channels_snapshot: std::collections::HashSet<u32> = {
            self.edge_state
                .ninja_channels
                .read()
                .await
                .iter()
                .copied()
                .collect()
        };
        let ninja_visible_set: std::collections::HashSet<u32> =
            if ninja_channels_snapshot.is_empty() {
                std::collections::HashSet::new()
            } else {
                self.edge_state
                    .ninja_visible_to
                    .read()
                    .await
                    .get(&self_session)
                    .cloned()
                    .unwrap_or_default()
            };

        for user in &remote_users {
            if user.session_id == self_session {
                continue;
            }
            // Skip local users – they will be sent in the local_clients loop below.
            if local_sessions.contains(&user.session_id) {
                continue;
            }
            // Channel Ninja: skip users in ninja channels that this client cannot see
            if ninja_channels_snapshot.contains(&user.channel_id)
                && !ninja_visible_set.contains(&user.channel_id)
            {
                continue;
            }
            let msg = mumbleproto::UserState {
                session: Some(user.session_id),
                user_id: if user.user_id > 0 {
                    Some(user.user_id)
                } else {
                    None
                },
                name: Some(user.username.clone()),
                channel_id: Some(user.channel_id),
                mute: if user.mute { Some(true) } else { None },
                deaf: if user.deaf { Some(true) } else { None },
                suppress: if user.suppress { Some(true) } else { None },
                self_mute: if user.self_mute { Some(true) } else { None },
                self_deaf: if user.self_deaf { Some(true) } else { None },
                priority_speaker: if user.priority_speaker {
                    Some(true)
                } else {
                    None
                },
                recording: if user.recording { Some(true) } else { None },
                hash: user.cert_hash.clone(),
                listening_channel_add: user.listening_channels.clone(),
                ..Default::default()
            };
            self.send(MessageType::UserState, &msg).await?;
        }

        for client in local_clients
            .iter()
            .filter(|c| c.state == crate::client::ClientState::Ready)
        {
            if client.session == self_session {
                continue;
            }
            // Channel Ninja: skip users in ninja channels that this client cannot see
            if ninja_channels_snapshot.contains(&client.channel_id)
                && !ninja_visible_set.contains(&client.channel_id)
            {
                continue;
            }
            let listening_volume_adjustment: Vec<mumbleproto::user_state::VolumeAdjustment> =
                client
                    .listening_volume_adjustments
                    .iter()
                    .map(|(&ch, &vol)| mumbleproto::user_state::VolumeAdjustment {
                        listening_channel: Some(ch),
                        volume_adjustment: Some(vol),
                    })
                    .collect();
            let msg = mumbleproto::UserState {
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
                self_mute: if client.self_mute { Some(true) } else { None },
                self_deaf: if client.self_deaf { Some(true) } else { None },
                priority_speaker: if client.priority_speaker {
                    Some(true)
                } else {
                    None
                },
                recording: if client.recording { Some(true) } else { None },
                hash: client.cert_hash.clone(),
                listening_channel_add: client.listening_channels.clone(),
                listening_volume_adjustment,
                ..Default::default()
            };
            self.send(MessageType::UserState, &msg).await?;
        }

        debug!(
            "Sent {} remote + {} local user states",
            remote_users.len(),
            local_clients.len()
        );
        Ok(())
    }

    /// Send the self UserState.
    ///
    /// Only includes boolean flags (mute, deaf, suppress, etc.) when they are
    /// explicitly `true`. Sending `false` would trigger spurious client-side
    /// notifications such as "recording ended" or "you were unmuted".
    ///
    /// Includes the certificate hash when available, matching Murmur's behaviour
    /// of including `hash` in the sendAll(mpus) broadcast during msgAuthenticate.
    async fn send_self_user_state(
        &self,
        session_id: u32,
        auth_result: &munode_protocol::hubedge::EdgeAuthenticateUserResult,
    ) -> Result<()> {
        let channel_id = auth_result
            .channel_id
            .unwrap_or(self.config.server.default_channel);
        // Prefer display_name over username (matches JS implementation behaviour).
        let display_name = auth_result
            .display_name
            .clone()
            .or(auth_result.username.clone())
            .unwrap_or_default();
        // Only include user_id for registered users (user_id > 0).
        // Sending user_id=0 would cause Mumble clients to treat the user as a
        // registered account with id=0 rather than as a guest.
        let user_id = auth_result.user_id.filter(|&id| id > 0);
        // Include cert hash, matching Murmur's `mpus.set_hash(uSource->qsHash)` in msgAuthenticate.
        let cert_hash = self
            .edge_state
            .client_manager
            .get_client(session_id)
            .await
            .and_then(|c| c.cert_hash.clone());
        let msg = mumbleproto::UserState {
            session: Some(session_id),
            actor: Some(session_id),
            user_id,
            name: Some(display_name),
            channel_id: Some(channel_id),
            mute: auth_result.mute.filter(|&v| v),
            deaf: auth_result.deaf.filter(|&v| v),
            suppress: auth_result.suppress.filter(|&v| v),
            self_mute: auth_result.self_mute.filter(|&v| v),
            self_deaf: auth_result.self_deaf.filter(|&v| v),
            priority_speaker: auth_result.priority_speaker.filter(|&v| v),
            recording: auth_result.recording.filter(|&v| v),
            hash: cert_hash,
            ..Default::default()
        };
        self.send(MessageType::UserState, &msg).await?;
        debug!("Sent self UserState for session {}", session_id);
        Ok(())
    }

    /// Proactively send PermissionQuery messages for the user's destination channel
    /// and its immediate parent, matching Murmur's `sendClientPermission` calls
    /// inside `userEnterChannel` during the login sequence.
    ///
    /// This lets the Mumble client immediately cache the effective permissions for
    /// the joined channel (and its parent) without issuing a client-initiated
    /// PermissionQuery round-trip after ServerSync.
    async fn send_channel_permission_queries(
        &self,
        session_id: u32,
        target_channel_id: u32,
    ) -> Result<()> {
        // Target channel permissions
        if let Some(target_permissions) = self
            .query_login_channel_permissions(session_id, target_channel_id)
            .await
        {
            let pq = mumbleproto::PermissionQuery {
                channel_id: Some(target_channel_id),
                permissions: Some(target_permissions),
                flush: Some(false),
            };
            self.send(MessageType::PermissionQuery, &pq).await?;
        }

        // Parent channel permissions (Murmur also sends for c->cParent in userEnterChannel)
        if let Some(ch) = self
            .edge_state
            .channel_manager
            .get_channel(target_channel_id)
            .await
            && let Some(parent_id) = ch.parent_id
            && let Some(parent_permissions) = self
                .query_login_channel_permissions(session_id, parent_id)
                .await
        {
            let pq = mumbleproto::PermissionQuery {
                channel_id: Some(parent_id),
                permissions: Some(parent_permissions),
                flush: Some(false),
            };
            self.send(MessageType::PermissionQuery, &pq).await?;
        }

        Ok(())
    }

    /// Send ServerSync.
    ///
    /// `root_permissions` should be the user's effective permissions on channel 0
    /// (queried from Hub). The Mumble client caches this value as `pPermissions` and
    /// uses it to avoid sending repeated PermissionQuery messages for the root channel
    /// on every UI event during startup. Sending 0 here causes the client to think it
    /// has no permissions and to keep querying until an async reply arrives.
    pub async fn send_server_sync(&self, session_id: u32, root_permissions: u32) -> Result<()> {
        let hub_limits = self.edge_state.hub_limits.read().await;
        let max_bandwidth = hub_limits.as_ref().and_then(|l| l.max_bandwidth);
        let welcome = hub_limits
            .as_ref()
            .and_then(|l| l.welcome_text.clone())
            .or_else(|| self.config.server.welcome_text.clone())
            .unwrap_or_else(|| "Welcome to MuNode Server".to_string());
        drop(hub_limits);
        let msg = mumbleproto::ServerSync {
            session: Some(session_id),
            max_bandwidth,
            welcome_text: Some(welcome),
            permissions: Some(root_permissions.into()),
        };
        self.send(MessageType::ServerSync, &msg).await?;
        debug!("Sent ServerSync for session {}", session_id);
        Ok(())
    }

    /// Send ServerConfig.
    ///
    /// Note: `welcome_text` is intentionally omitted here; it is already sent
    /// in `ServerSync`. Including it again would cause duplicate MOTD
    /// notifications on some clients.
    pub async fn send_server_config(&self) -> Result<()> {
        let hub_limits = self.edge_state.hub_limits.read().await;
        let text_message_length = hub_limits
            .as_ref()
            .and_then(|l| l.text_message_length)
            .unwrap_or(self.config.server.text_message_length);
        let image_message_length = hub_limits
            .as_ref()
            .and_then(|l| l.image_message_length)
            .unwrap_or(self.config.server.image_message_length);
        let max_users = hub_limits
            .as_ref()
            .and_then(|l| l.max_users)
            .unwrap_or(self.config.server.capacity);
        let max_bandwidth = hub_limits
            .as_ref()
            .and_then(|l| l.max_bandwidth)
            .or_else(|| {
                let bw = self
                    .edge_state
                    .max_bandwidth_bps
                    .load(std::sync::atomic::Ordering::Relaxed);
                if bw > 0 { Some(bw) } else { None }
            });
        let suggest_version = hub_limits.as_ref().and_then(|l| l.suggest_version);
        let suggest_version_v2 = hub_limits.as_ref().and_then(|l| l.suggest_version_v2);
        let suggest_positional = hub_limits.as_ref().and_then(|l| l.suggest_positional);
        let suggest_push_to_talk = hub_limits.as_ref().and_then(|l| l.suggest_push_to_talk);
        drop(hub_limits);

        let msg = mumbleproto::ServerConfig {
            max_bandwidth,
            welcome_text: None,
            allow_html: Some(self.config.server.allow_html),
            message_length: Some(text_message_length),
            image_message_length: Some(image_message_length),
            max_users: Some(max_users),
            recording_allowed: Some(self.config.server.recording_allowed),
        };
        self.send(MessageType::ServerConfig, &msg).await?;
        debug!("Sent ServerConfig");

        // Send SuggestConfig if Hub provided suggestions
        // Only send if at least one field is set (matches murmur behavior)
        // Send both version_v1 (field 1) and version_v2 (field 4) for full client compatibility:
        //   - Old clients (< 1.5): use version field (v1) only
        //   - New clients (>= 1.5): prefer version_v2, fall back to version
        if suggest_version.is_some()
            || suggest_version_v2.is_some()
            || suggest_positional.is_some()
            || suggest_push_to_talk.is_some()
        {
            let suggest_msg = mumbleproto::SuggestConfig {
                version: suggest_version,
                positional: suggest_positional,
                push_to_talk: suggest_push_to_talk,
                version_v2: suggest_version_v2,
            };
            self.send(MessageType::SuggestConfig, &suggest_msg).await?;
            debug!("Sent SuggestConfig");
        }

        Ok(())
    }

    /// Encode and send a Mumble protocol message via the client sender.
    async fn send<M: Message>(&self, msg_type: MessageType, message: &M) -> Result<()> {
        if !self.sender.send_message(msg_type, message).await {
            anyhow::bail!("Failed to send message to client");
        }
        Ok(())
    }
}

/// Handle a Ping message: encode response and send via sender.
pub fn encode_ping_response(payload: &[u8]) -> Result<Vec<u8>> {
    let ping = mumbleproto::Ping::decode(payload)?;
    let mut buf = BytesMut::new();
    encode_message(MessageType::Ping, &ping, &mut buf);
    Ok(buf.to_vec())
}

/// Encode the server's outgoing Version message (sent proactively right after TLS handshake).
pub fn encode_server_version() -> Vec<u8> {
    let server_version = mumbleproto::Version {
        version: Some(0x0001_0400), // 1.4.0 — 1.5.0+ triggers protobuf audio; we use legacy format
        release: Some("MuNode-Rust 0.1.0".into()),
        os: Some(std::env::consts::OS.into()),
        os_version: Some(String::new()),
    };
    let mut buf = BytesMut::new();
    encode_message(MessageType::Version, &server_version, &mut buf);
    buf.to_vec()
}

/// Encode a Reject message.
pub fn encode_reject(reject_type: Option<i32>, reason: &str) -> Vec<u8> {
    let msg = mumbleproto::Reject {
        r#type: reject_type,
        reason: Some(reason.to_string()),
    };
    let mut buf = BytesMut::new();
    encode_message(MessageType::Reject, &msg, &mut buf);
    buf.to_vec()
}

/// Build a UserState message from a ClientInfo.
///
/// Boolean flags are only included when `true` to avoid spurious
/// client-side notifications.
pub fn build_user_state_msg(client: &ClientInfo) -> mumbleproto::UserState {
    mumbleproto::UserState {
        session: Some(client.session),
        // Only include user_id for registered users (user_id > 0); guests should have None.
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
        self_mute: if client.self_mute { Some(true) } else { None },
        self_deaf: if client.self_deaf { Some(true) } else { None },
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
    }
}

/// Build a UserRemove message.
pub fn build_user_remove_msg(session: u32, reason: Option<&str>) -> mumbleproto::UserRemove {
    mumbleproto::UserRemove {
        session,
        actor: None,
        reason: reason.map(|s| s.to_string()),
        ban: None,
    }
}

/// Build a ChannelState message from ChannelData.
pub fn build_channel_state_msg(channel: &ChannelData) -> mumbleproto::ChannelState {
    mumbleproto::ChannelState {
        channel_id: Some(channel.id),
        parent: channel.parent_id,
        name: Some(channel.name.clone()),
        description: channel.description.clone(),
        position: Some(channel.position),
        temporary: Some(channel.temporary),
        max_users: Some(channel.max_users),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::ClientState;
    use bytes::BytesMut;
    use munode_protocol::transport::decode_frame;
    use prost::Message;
    use std::collections::HashMap;

    #[test]
    fn test_encode_server_version() {
        let response = encode_server_version();

        let mut buf = BytesMut::from(&response[..]);
        let frame = decode_frame(&mut buf).unwrap().unwrap();
        assert_eq!(frame.message_type, MessageType::Version);

        let server_version = mumbleproto::Version::decode(&frame.payload[..]).unwrap();
        assert!(server_version.release().contains("MuNode-Rust"));
    }

    #[test]
    fn test_encode_ping_response() {
        let ping = mumbleproto::Ping {
            timestamp: Some(12345),
            ..Default::default()
        };
        let payload = ping.encode_to_vec();
        let response = encode_ping_response(&payload).unwrap();

        let mut buf = BytesMut::from(&response[..]);
        let frame = decode_frame(&mut buf).unwrap().unwrap();
        assert_eq!(frame.message_type, MessageType::Ping);

        let decoded = mumbleproto::Ping::decode(&frame.payload[..]).unwrap();
        assert_eq!(decoded.timestamp(), 12345);
    }

    #[test]
    fn test_encode_reject() {
        let data = encode_reject(
            Some(mumbleproto::reject::RejectType::AuthenticatorFail as i32),
            "Test rejection",
        );

        let mut buf = BytesMut::from(&data[..]);
        let frame = decode_frame(&mut buf).unwrap().unwrap();
        assert_eq!(frame.message_type, MessageType::Reject);

        let reject = mumbleproto::Reject::decode(&frame.payload[..]).unwrap();
        assert_eq!(reject.reason(), "Test rejection");
    }

    #[test]
    fn test_build_user_state_msg() {
        let client = ClientInfo {
            session: 42,
            user_id: 100,
            username: "testuser".to_string(),
            channel_id: 1,
            state: ClientState::Ready,
            mute: false,
            deaf: false,
            suppress: false,
            self_mute: true,
            self_deaf: false,
            priority_speaker: false,
            recording: false,
            ip_address: "127.0.0.1".to_string(),
            connected_at: std::time::Instant::now(),
            last_active: std::time::Instant::now(),
            cert_hash: Some("abc123".to_string()),
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
            client_cert_chain: vec![],
        };

        let msg = build_user_state_msg(&client);
        assert_eq!(msg.session(), 42);
        assert_eq!(msg.user_id(), 100);
        assert_eq!(msg.name(), "testuser");
        assert_eq!(msg.channel_id(), 1);
        assert_eq!(msg.self_mute, Some(true));
        assert_eq!(msg.hash(), "abc123");

        // false boolean fields must be None (not Some(false)) to avoid
        // spurious client notifications like "unmuted" or "recording ended"
        assert_eq!(msg.mute, None);
        assert_eq!(msg.deaf, None);
        assert_eq!(msg.suppress, None);
        assert_eq!(msg.self_deaf, None);
        assert_eq!(msg.priority_speaker, None);
        assert_eq!(msg.recording, None);
    }

    #[test]
    fn test_build_channel_state_msg() {
        let ch = ChannelData {
            id: 5,
            name: "Test Channel".to_string(),
            parent_id: Some(0),
            description: Some("A test channel".to_string()),
            position: 3,
            max_users: 50,
            temporary: true,
            inherit_acl: true,
            links: vec![],
        };

        let msg = build_channel_state_msg(&ch);
        assert_eq!(msg.channel_id(), 5);
        assert_eq!(msg.name(), "Test Channel");
        assert_eq!(msg.parent(), 0);
        assert_eq!(msg.position(), 3);
        assert!(msg.temporary());
    }
}
