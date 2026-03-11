use std::sync::Arc;

use anyhow::Result;
use bytes::BytesMut;
use prost::Message;
use tracing::{debug, info};

use munode_common::config::EdgeConfig;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::encode_message;

use crate::channel_manager::ChannelData;
use crate::client::{ClientInfo, ClientSender};
use crate::crypto::CryptState;
use crate::hub_client::HubClient;
use crate::state::EdgeState;

/// Handles the Mumble protocol login sequence for a client.
///
/// After authentication succeeds, sends in order:
/// 1. CryptSetup (encryption keys)
/// 2. CodecVersion
/// 3. ChannelState (for all channels, BFS order)
/// 4. UserState (for all other users)
/// 5. Self UserState
/// 6. ServerSync
/// 7. ServerConfig
pub struct LoginHandler<'a> {
    sender: &'a ClientSender,
    config: &'a EdgeConfig,
    edge_state: &'a Arc<EdgeState>,
    _hub_client: &'a Arc<HubClient>,
}

impl<'a> LoginHandler<'a> {
    pub fn new(
        sender: &'a ClientSender,
        config: &'a EdgeConfig,
        edge_state: &'a Arc<EdgeState>,
        hub_client: &'a Arc<HubClient>,
    ) -> Self {
        Self { sender, config, edge_state, _hub_client: hub_client }
    }

    /// Execute the full login sequence after authentication.
    pub async fn execute_login(
        &self,
        session_id: u32,
        auth_result: &munode_protocol::hubedge::EdgeAuthenticateUserResult,
        opus_supported: bool,
    ) -> Result<()> {
        // 1. Send CryptSetup and initialise OCB2 state for this session
        self.send_crypt_setup(session_id).await?;

        // 2. Send CodecVersion
        self.send_codec_version(opus_supported).await?;

        // 3. Send channel tree (BFS order)
        self.send_channel_tree().await?;

        // 4. Send UserState for all remote users
        self.send_remote_users(session_id).await?;

        // 5. Send self UserState
        self.send_self_user_state(session_id, auth_result).await?;

        // 6. Send ServerSync
        self.send_server_sync(session_id).await?;

        // 7. Send ServerConfig
        self.send_server_config().await?;

        Ok(())
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
        rng.fill(&mut key).map_err(|_| anyhow::anyhow!("RNG failed"))?;
        rng.fill(&mut client_nonce).map_err(|_| anyhow::anyhow!("RNG failed"))?;
        rng.fill(&mut server_nonce).map_err(|_| anyhow::anyhow!("RNG failed"))?;

        // Build and store CryptState for this session
        let mut crypt = CryptState::new();
        // encrypt_iv = server_nonce (server→client)
        // decrypt_iv = client_nonce (client→server, so server decrypts using this)
        crypt.set_key(&key, &server_nonce, &client_nonce);
        self.edge_state.client_manager.set_crypt_state(session_id, crypt).await;

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
    async fn send_codec_version(&self, opus: bool) -> Result<()> {
        let msg = mumbleproto::CodecVersion {
            alpha: -2147483637, // CELT 0.7.0
            beta: -2147483632,  // CELT 0.11.0
            // prefer_alpha must be false when opus=true; otherwise some Mumble clients
            // (especially older 1.3.x builds) use CELT Alpha even when Opus is available,
            // which prevents modern 1.4+ receivers from decoding the audio.
            prefer_alpha: !opus,
            opus: Some(opus),
        };
        self.send(MessageType::CodecVersion, &msg).await?;
        debug!("Sent CodecVersion (opus={}, prefer_alpha={})", opus, !opus);
        Ok(())
    }

    /// Send the full channel tree in BFS order.
    async fn send_channel_tree(&self) -> Result<()> {
        let channels = self.edge_state.channel_manager.get_channels_bfs().await;

        // Pass 1: Send all channels with their basic info
        for ch in &channels {
            let msg = mumbleproto::ChannelState {
                channel_id: Some(ch.id),
                parent: ch.parent_id,
                name: Some(ch.name.clone()),
                description: ch.description.clone(),
                position: Some(ch.position),
                temporary: Some(ch.temporary),
                max_users: Some(ch.max_users),
                ..Default::default()
            };
            self.send(MessageType::ChannelState, &msg).await?;
        }

        // Pass 2: Send channel links
        for ch in &channels {
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

        for user in &remote_users {
            if user.session_id == self_session {
                continue;
            }
            // Skip local users – they will be sent in the local_clients loop below.
            if local_sessions.contains(&user.session_id) {
                continue;
            }
            let msg = mumbleproto::UserState {
                session: Some(user.session_id),
                user_id: if user.user_id > 0 { Some(user.user_id) } else { None },
                name: Some(user.username.clone()),
                channel_id: Some(user.channel_id),
                mute: if user.mute { Some(true) } else { None },
                deaf: if user.deaf { Some(true) } else { None },
                suppress: if user.suppress { Some(true) } else { None },
                self_mute: if user.self_mute { Some(true) } else { None },
                self_deaf: if user.self_deaf { Some(true) } else { None },
                priority_speaker: if user.priority_speaker { Some(true) } else { None },
                recording: if user.recording { Some(true) } else { None },
                hash: user.cert_hash.clone(),
                ..Default::default()
            };
            self.send(MessageType::UserState, &msg).await?;
        }

        for client in &local_clients {
            if client.session == self_session {
                continue;
            }
            let msg = mumbleproto::UserState {
                session: Some(client.session),
                user_id: if client.user_id > 0 { Some(client.user_id) } else { None },
                name: Some(client.username.clone()),
                channel_id: Some(client.channel_id),
                mute: if client.mute { Some(true) } else { None },
                deaf: if client.deaf { Some(true) } else { None },
                suppress: if client.suppress { Some(true) } else { None },
                self_mute: if client.self_mute { Some(true) } else { None },
                self_deaf: if client.self_deaf { Some(true) } else { None },
                priority_speaker: if client.priority_speaker { Some(true) } else { None },
                recording: if client.recording { Some(true) } else { None },
                hash: client.cert_hash.clone(),
                ..Default::default()
            };
            self.send(MessageType::UserState, &msg).await?;
        }

        debug!("Sent {} remote + {} local user states", remote_users.len(), local_clients.len());
        Ok(())
    }

    /// Send the self UserState.
    ///
    /// Only includes boolean flags (mute, deaf, suppress, etc.) when they are
    /// explicitly `true`. Sending `false` would trigger spurious client-side
    /// notifications such as "recording ended" or "you were unmuted".
    async fn send_self_user_state(
        &self,
        session_id: u32,
        auth_result: &munode_protocol::hubedge::EdgeAuthenticateUserResult,
    ) -> Result<()> {
        let channel_id = auth_result.channel_id.unwrap_or(self.config.server.default_channel);
        // Prefer display_name over username (matches JS implementation behaviour).
        let display_name = auth_result.display_name.clone()
            .or(auth_result.username.clone())
            .unwrap_or_default();
        // Only include user_id for registered users (user_id > 0).
        // Sending user_id=0 would cause Mumble clients to treat the user as a
        // registered account with id=0 rather than as a guest.
        let user_id = auth_result.user_id.filter(|&id| id > 0);
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
            ..Default::default()
        };
        self.send(MessageType::UserState, &msg).await?;
        debug!("Sent self UserState for session {}", session_id);
        Ok(())
    }

    /// Send ServerSync.
    async fn send_server_sync(&self, session_id: u32) -> Result<()> {
        let welcome = self.config.server.welcome_text.clone()
            .unwrap_or_else(|| "Welcome to MuNode Server".to_string());
        let msg = mumbleproto::ServerSync {
            session: Some(session_id),
            max_bandwidth: Some(self.config.server.max_bandwidth),
            welcome_text: Some(welcome),
            permissions: Some(0),
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
    async fn send_server_config(&self) -> Result<()> {
        let msg = mumbleproto::ServerConfig {
            max_bandwidth: Some(self.config.server.max_bandwidth),
            welcome_text: None,
            allow_html: Some(true),
            message_length: Some(self.config.server.text_message_length),
            image_message_length: Some(self.config.server.image_message_length),
            max_users: Some(self.config.server.capacity),
            recording_allowed: Some(true),
        };
        self.send(MessageType::ServerConfig, &msg).await?;
        debug!("Sent ServerConfig");

        // Send SuggestConfig if any suggestions are configured
        if let Some(suggest) = self.config.suggest.as_ref() {
            if suggest.version.is_some() || suggest.positional.is_some() || suggest.push_to_talk.is_some() {
                let suggest_msg = mumbleproto::SuggestConfig {
                    version: suggest.version.clone(),
                    positional: suggest.positional,
                    push_to_talk: suggest.push_to_talk,
                };
                self.send(MessageType::SuggestConfig, &suggest_msg).await?;
                debug!("Sent SuggestConfig");
            }
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

/// Encode a Version response.
pub fn encode_version_response(payload: &[u8], peer_addr: &str) -> Result<Vec<u8>> {
    let version = mumbleproto::Version::decode(payload)?;
    info!(
        "Client {} version: {:?} release={:?}",
        peer_addr,
        version.version,
        version.release
    );

    let server_version = mumbleproto::Version {
        version: Some(0x0001_0400), // 1.4.0 — 1.5.0+ triggers protobuf audio; we use legacy format
        release: Some("MuNode-Rust 0.1.0".into()),
        os: Some(std::env::consts::OS.into()),
        os_version: Some(String::new()),
    };
    let mut buf = BytesMut::new();
    encode_message(MessageType::Version, &server_version, &mut buf);
    Ok(buf.to_vec())
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
        user_id: if client.user_id > 0 { Some(client.user_id) } else { None },
        name: Some(client.username.clone()),
        channel_id: Some(client.channel_id),
        mute: if client.mute { Some(true) } else { None },
        deaf: if client.deaf { Some(true) } else { None },
        suppress: if client.suppress { Some(true) } else { None },
        self_mute: if client.self_mute { Some(true) } else { None },
        self_deaf: if client.self_deaf { Some(true) } else { None },
        priority_speaker: if client.priority_speaker { Some(true) } else { None },
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
    use prost::Message;
    use munode_protocol::transport::decode_frame;
    use crate::client::ClientState;
    use bytes::BytesMut;

    #[test]
    fn test_encode_version_response() {
        let version = mumbleproto::Version {
            version: Some(0x0001_0300),
            release: Some("test-client".into()),
            os: Some("linux".into()),
            os_version: Some("6.0".into()),
        };
        let payload = version.encode_to_vec();
        let response = encode_version_response(&payload, "127.0.0.1:12345").unwrap();

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
            texture_hash: None,
            comment_hash: None,
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
        assert_eq!(msg.temporary(), true);
    }
}
