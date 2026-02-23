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
        // 1. Send CryptSetup
        self.send_crypt_setup().await?;

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

    /// Send CryptSetup with random encryption keys.
    async fn send_crypt_setup(&self) -> Result<()> {
        let mut key = [0u8; 16];
        let mut client_nonce = [0u8; 16];
        let mut server_nonce = [0u8; 16];

        use ring::rand::{SecureRandom, SystemRandom};
        let rng = SystemRandom::new();
        rng.fill(&mut key).map_err(|_| anyhow::anyhow!("RNG failed"))?;
        rng.fill(&mut client_nonce).map_err(|_| anyhow::anyhow!("RNG failed"))?;
        rng.fill(&mut server_nonce).map_err(|_| anyhow::anyhow!("RNG failed"))?;

        let msg = mumbleproto::CryptSetup {
            key: Some(key.to_vec()),
            client_nonce: Some(client_nonce.to_vec()),
            server_nonce: Some(server_nonce.to_vec()),
        };
        self.send(MessageType::CryptSetup, &msg).await?;
        debug!("Sent CryptSetup");
        Ok(())
    }

    /// Send CodecVersion.
    async fn send_codec_version(&self, opus: bool) -> Result<()> {
        let msg = mumbleproto::CodecVersion {
            alpha: -2147483637, // CELT 0.7.0
            beta: -2147483632,  // CELT 0.11.0
            prefer_alpha: true,
            opus: Some(opus),
        };
        self.send(MessageType::CodecVersion, &msg).await?;
        debug!("Sent CodecVersion");
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
    async fn send_remote_users(&self, self_session: u32) -> Result<()> {
        let remote_users = self.edge_state.channel_manager.get_all_remote_users().await;
        let local_clients = self.edge_state.client_manager.get_all_clients().await;

        for user in &remote_users {
            if user.session_id == self_session {
                continue;
            }
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
            self.send(MessageType::UserState, &msg).await?;
        }

        for client in &local_clients {
            if client.session == self_session {
                continue;
            }
            let msg = mumbleproto::UserState {
                session: Some(client.session),
                user_id: Some(client.user_id),
                name: Some(client.username.clone()),
                channel_id: Some(client.channel_id),
                mute: Some(client.mute),
                deaf: Some(client.deaf),
                suppress: Some(client.suppress),
                self_mute: Some(client.self_mute),
                self_deaf: Some(client.self_deaf),
                priority_speaker: Some(client.priority_speaker),
                recording: Some(client.recording),
                hash: client.cert_hash.clone(),
                ..Default::default()
            };
            self.send(MessageType::UserState, &msg).await?;
        }

        debug!("Sent {} remote + {} local user states", remote_users.len(), local_clients.len());
        Ok(())
    }

    /// Send the self UserState.
    async fn send_self_user_state(
        &self,
        session_id: u32,
        auth_result: &munode_protocol::hubedge::EdgeAuthenticateUserResult,
    ) -> Result<()> {
        let channel_id = auth_result.channel_id.unwrap_or(self.config.server.default_channel);
        let msg = mumbleproto::UserState {
            session: Some(session_id),
            user_id: Some(auth_result.user_id.unwrap_or(0)),
            name: Some(auth_result.username.clone().unwrap_or_default()),
            channel_id: Some(channel_id),
            mute: auth_result.mute,
            deaf: auth_result.deaf,
            suppress: auth_result.suppress,
            self_mute: auth_result.self_mute,
            self_deaf: auth_result.self_deaf,
            priority_speaker: auth_result.priority_speaker,
            recording: auth_result.recording,
            ..Default::default()
        };
        self.send(MessageType::UserState, &msg).await?;
        debug!("Sent self UserState for session {}", session_id);
        Ok(())
    }

    /// Send ServerSync.
    async fn send_server_sync(&self, session_id: u32) -> Result<()> {
        let msg = mumbleproto::ServerSync {
            session: Some(session_id),
            max_bandwidth: Some(self.config.server.max_bandwidth),
            welcome_text: self.config.server.welcome_text.clone(),
            permissions: Some(0),
        };
        self.send(MessageType::ServerSync, &msg).await?;
        debug!("Sent ServerSync for session {}", session_id);
        Ok(())
    }

    /// Send ServerConfig.
    async fn send_server_config(&self) -> Result<()> {
        let msg = mumbleproto::ServerConfig {
            max_bandwidth: Some(self.config.server.max_bandwidth),
            welcome_text: self.config.server.welcome_text.clone(),
            allow_html: Some(true),
            message_length: Some(5000),
            image_message_length: Some(131072),
            max_users: Some(self.config.server.capacity),
            recording_allowed: Some(true),
        };
        self.send(MessageType::ServerConfig, &msg).await?;
        debug!("Sent ServerConfig");
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
        version: Some(0x0001_0500), // 1.5.0
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
pub fn build_user_state_msg(client: &ClientInfo) -> mumbleproto::UserState {
    mumbleproto::UserState {
        session: Some(client.session),
        user_id: Some(client.user_id),
        name: Some(client.username.clone()),
        channel_id: Some(client.channel_id),
        mute: Some(client.mute),
        deaf: Some(client.deaf),
        suppress: Some(client.suppress),
        self_mute: Some(client.self_mute),
        self_deaf: Some(client.self_deaf),
        priority_speaker: Some(client.priority_speaker),
        recording: Some(client.recording),
        hash: client.cert_hash.clone(),
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
        };

        let msg = build_user_state_msg(&client);
        assert_eq!(msg.session(), 42);
        assert_eq!(msg.user_id(), 100);
        assert_eq!(msg.name(), "testuser");
        assert_eq!(msg.channel_id(), 1);
        assert_eq!(msg.self_mute(), true);
        assert_eq!(msg.hash(), "abc123");
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
