use std::sync::Arc;

use anyhow::Result;
use bytes::BytesMut;
use prost::Message;
use tokio::io::AsyncWriteExt;
use tracing::{debug, info};

use munode_common::config::EdgeConfig;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::encode_message;

use crate::channel_manager::ChannelData;
use crate::client::ClientInfo;
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
pub struct LoginHandler<'a, W: AsyncWriteExt + Unpin> {
    writer: &'a mut W,
    config: &'a EdgeConfig,
    edge_state: &'a Arc<EdgeState>,
    _hub_client: &'a Arc<HubClient>,
}

impl<'a, W: AsyncWriteExt + Unpin> LoginHandler<'a, W> {
    pub fn new(
        writer: &'a mut W,
        config: &'a EdgeConfig,
        edge_state: &'a Arc<EdgeState>,
        hub_client: &'a Arc<HubClient>,
    ) -> Self {
        Self { writer, config, edge_state, _hub_client: hub_client }
    }

    /// Execute the full login sequence after authentication.
    pub async fn execute_login(
        &mut self,
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
    async fn send_crypt_setup(&mut self) -> Result<()> {
        let mut key = [0u8; 16];
        let mut client_nonce = [0u8; 16];
        let mut server_nonce = [0u8; 16];

        // Generate random keys using ring
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
    async fn send_codec_version(&mut self, opus: bool) -> Result<()> {
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
    async fn send_channel_tree(&mut self) -> Result<()> {
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
    async fn send_remote_users(&mut self, self_session: u32) -> Result<()> {
        let remote_users = self.edge_state.channel_manager.get_all_remote_users().await;
        let local_clients = self.edge_state.client_manager.get_all_clients().await;

        // Send remote users from other edges
        for user in &remote_users {
            if user.session_id == self_session {
                continue; // Skip self
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

        // Send local clients
        for client in &local_clients {
            if client.session == self_session {
                continue; // Skip self
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
        &mut self,
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
    async fn send_server_sync(&mut self, session_id: u32) -> Result<()> {
        let msg = mumbleproto::ServerSync {
            session: Some(session_id),
            max_bandwidth: Some(self.config.server.max_bandwidth),
            welcome_text: self.config.server.welcome_text.clone(),
            permissions: Some(0), // TODO: Calculate actual permissions
        };
        self.send(MessageType::ServerSync, &msg).await?;
        debug!("Sent ServerSync for session {}", session_id);
        Ok(())
    }

    /// Send ServerConfig.
    async fn send_server_config(&mut self) -> Result<()> {
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

    /// Encode and send a Mumble protocol message.
    async fn send<M: Message>(&mut self, msg_type: MessageType, message: &M) -> Result<()> {
        let mut buf = BytesMut::new();
        encode_message(msg_type, message, &mut buf);
        self.writer.write_all(&buf).await?;
        Ok(())
    }
}

/// Handle a Ping message: echo it back.
pub async fn handle_ping<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    payload: &[u8],
) -> Result<()> {
    let ping = mumbleproto::Ping::decode(payload)?;
    let mut buf = BytesMut::new();
    encode_message(MessageType::Ping, &ping, &mut buf);
    writer.write_all(&buf).await?;
    Ok(())
}

/// Handle a Version message from client: log it and respond with server version.
pub async fn handle_version<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    payload: &[u8],
    peer_addr: &str,
) -> Result<()> {
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
    writer.write_all(&buf).await?;
    Ok(())
}

/// Send a Reject message and return.
pub async fn send_reject<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    reject_type: Option<i32>,
    reason: &str,
) -> Result<()> {
    let msg = mumbleproto::Reject {
        r#type: reject_type,
        reason: Some(reason.to_string()),
    };
    let mut buf = BytesMut::new();
    encode_message(MessageType::Reject, &msg, &mut buf);
    writer.write_all(&buf).await?;
    Ok(())
}

/// Send a UserState broadcast to a writer.
pub async fn send_user_state<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    client: &ClientInfo,
) -> Result<()> {
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
    let mut buf = BytesMut::new();
    encode_message(MessageType::UserState, &msg, &mut buf);
    writer.write_all(&buf).await?;
    Ok(())
}

/// Send a UserRemove message.
pub async fn send_user_remove<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    session: u32,
    actor: Option<u32>,
    reason: Option<&str>,
    ban: Option<bool>,
) -> Result<()> {
    let msg = mumbleproto::UserRemove {
        session,
        actor,
        reason: reason.map(|s| s.to_string()),
        ban,
    };
    let mut buf = BytesMut::new();
    encode_message(MessageType::UserRemove, &msg, &mut buf);
    writer.write_all(&buf).await?;
    Ok(())
}

/// Send a ChannelState message.
pub async fn send_channel_state<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    channel: &ChannelData,
) -> Result<()> {
    let msg = mumbleproto::ChannelState {
        channel_id: Some(channel.id),
        parent: channel.parent_id,
        name: Some(channel.name.clone()),
        description: channel.description.clone(),
        position: Some(channel.position),
        temporary: Some(channel.temporary),
        max_users: Some(channel.max_users),
        ..Default::default()
    };
    let mut buf = BytesMut::new();
    encode_message(MessageType::ChannelState, &msg, &mut buf);
    writer.write_all(&buf).await?;
    Ok(())
}
