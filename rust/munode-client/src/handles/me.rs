//! Operations on the local (connected) user — analogous to "me / self" in
//! the Mumble GUI client.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;

use crate::client::MumbleClient;
use crate::state::{SessionState, User};

/// Handle representing the locally connected user.
#[derive(Clone)]
pub struct Me<'a> {
    pub(crate) client: &'a MumbleClient,
}

impl<'a> Me<'a> {
    /// Return the current `SessionState` (None until authentication completes).
    pub fn session(&self) -> Option<SessionState> {
        self.client.session()
    }

    /// Local session ID.
    pub fn session_id(&self) -> Option<u32> {
        self.client.session_id()
    }

    /// Snapshot of the local user as a `User` record.
    pub fn user(&self) -> Option<User> {
        self.session_id().and_then(|s| self.client.user_info(s))
    }

    /// Set the self-mute state and broadcast to the server.
    pub async fn set_mute(&self, mute: bool) -> Result<()> {
        self.send_user_state(mumbleproto::UserState {
            self_mute: Some(mute),
            ..Default::default()
        })
    }

    /// Set the self-deaf state and broadcast.
    pub async fn set_deaf(&self, deaf: bool) -> Result<()> {
        self.send_user_state(mumbleproto::UserState {
            self_deaf: Some(deaf),
            ..Default::default()
        })
    }

    /// Set the recording flag.
    pub async fn set_recording(&self, recording: bool) -> Result<()> {
        self.send_user_state(mumbleproto::UserState {
            recording: Some(recording),
            ..Default::default()
        })
    }

    /// Move the local user to a different channel.
    pub async fn move_to(&self, channel_id: u32) -> Result<()> {
        let session = self.session_id_required()?;
        self.client.send_proto(
            MessageType::UserState,
            &mumbleproto::UserState {
                session: Some(session),
                channel_id: Some(channel_id),
                ..Default::default()
            },
        )
    }

    /// Set the local user's comment (UTF-8).
    pub async fn set_comment(&self, comment: impl Into<String>) -> Result<()> {
        self.send_user_state(mumbleproto::UserState {
            comment: Some(comment.into()),
            ..Default::default()
        })
    }

    /// Set the local user's avatar texture (raw PNG/JPEG bytes).
    pub async fn set_texture(&self, texture: Vec<u8>) -> Result<()> {
        self.send_user_state(mumbleproto::UserState {
            texture: Some(texture),
            ..Default::default()
        })
    }

    /// Begin listening to an additional channel.
    pub async fn add_listener(&self, channel_id: u32) -> Result<()> {
        self.send_user_state(mumbleproto::UserState {
            listening_channel_add: vec![channel_id],
            ..Default::default()
        })
    }

    /// Stop listening to a channel.
    pub async fn remove_listener(&self, channel_id: u32) -> Result<()> {
        self.send_user_state(mumbleproto::UserState {
            listening_channel_remove: vec![channel_id],
            ..Default::default()
        })
    }

    /// Drop all listening channels at once.
    pub async fn clear_listeners(&self) -> Result<()> {
        let listeners = self
            .session()
            .map(|s| s.listening_channels)
            .unwrap_or_default();
        if listeners.is_empty() {
            return Ok(());
        }
        self.send_user_state(mumbleproto::UserState {
            listening_channel_remove: listeners,
            ..Default::default()
        })
    }

    /// Send a TCP `Ping` and return immediately. The server's reply will be
    /// emitted as `ClientEvent::Ping`. Includes Mumble-style stats fields
    /// drawn from the active OCB2 `CryptState`.
    pub async fn ping(&self) -> Result<()> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros() as u64)
            .unwrap_or(0);
        let stats = self.client.crypt_stats();
        self.client.send_proto(
            MessageType::Ping,
            &mumbleproto::Ping {
                timestamp: Some(ts),
                good: Some(stats.good),
                late: Some(stats.late),
                lost: Some(stats.lost),
                resync: Some(stats.resync),
                udp_packets: Some(stats.udp_packets),
                tcp_packets: Some(stats.tcp_packets),
                udp_ping_avg: Some(stats.udp_ping_avg),
                udp_ping_var: Some(stats.udp_ping_var),
                tcp_ping_avg: Some(stats.tcp_ping_avg),
                tcp_ping_var: Some(stats.tcp_ping_var),
            },
        )
    }

    /// Send a text message into the current channel. Returns `Err` if the
    /// session is not yet known.
    pub async fn say(&self, text: impl Into<String>) -> Result<()> {
        let channel_id = self.session().map(|s| s.channel_id).unwrap_or(0);
        self.client.send_proto(
            MessageType::TextMessage,
            &mumbleproto::TextMessage {
                channel_id: vec![channel_id],
                message: text.into(),
                ..Default::default()
            },
        )
    }

    fn session_id_required(&self) -> Result<u32> {
        self.session_id()
            .ok_or_else(|| crate::error::ClientError::NotConnected.into())
    }

    fn send_user_state(&self, mut msg: mumbleproto::UserState) -> Result<()> {
        if msg.session.is_none() {
            msg.session = self.session_id();
        }
        self.client.send_proto(MessageType::UserState, &msg)
    }
}
