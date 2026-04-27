//! Operations on a remote user identified by their session ID.

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use tokio::time::timeout;

use crate::client::MumbleClient;
use crate::events::ClientEvent;
use crate::state::User;

/// Handle for operations on a single remote user.
#[derive(Clone)]
pub struct UserRef<'a> {
    pub(crate) client: &'a MumbleClient,
    pub(crate) session: u32,
}

impl<'a> UserRef<'a> {
    /// The session ID this handle refers to.
    pub fn session_id(&self) -> u32 {
        self.session
    }

    /// Snapshot of the user's current state, if known.
    pub fn info(&self) -> Option<User> {
        self.client.user_info(self.session)
    }

    /// Move this user to another channel (admin / moderator).
    pub async fn move_to(&self, channel_id: u32) -> Result<()> {
        self.send_state(mumbleproto::UserState {
            channel_id: Some(channel_id),
            ..Default::default()
        })
    }

    /// Admin-mute this user.
    pub async fn set_mute(&self, mute: bool) -> Result<()> {
        self.send_state(mumbleproto::UserState {
            mute: Some(mute),
            ..Default::default()
        })
    }

    /// Admin-deafen this user.
    pub async fn set_deaf(&self, deaf: bool) -> Result<()> {
        self.send_state(mumbleproto::UserState {
            deaf: Some(deaf),
            ..Default::default()
        })
    }

    /// Set the suppressed flag.
    pub async fn set_suppress(&self, suppress: bool) -> Result<()> {
        self.send_state(mumbleproto::UserState {
            suppress: Some(suppress),
            ..Default::default()
        })
    }

    /// Mark / unmark this user as a priority speaker.
    pub async fn set_priority_speaker(&self, priority: bool) -> Result<()> {
        self.send_state(mumbleproto::UserState {
            priority_speaker: Some(priority),
            ..Default::default()
        })
    }

    /// Kick the user from the server.
    pub async fn kick(&self, reason: Option<&str>) -> Result<()> {
        let actor = self.client.session_id();
        self.client.send_proto(MessageType::UserRemove, &mumbleproto::UserRemove {
            session: self.session,
            actor,
            reason: reason.map(str::to_owned),
            ban: Some(false),
        })
    }

    /// Kick + ban the user (Mumble protocol semantics: `UserRemove { ban: true }`).
    pub async fn ban(&self, reason: Option<&str>) -> Result<()> {
        let actor = self.client.session_id();
        self.client.send_proto(MessageType::UserRemove, &mumbleproto::UserRemove {
            session: self.session,
            actor,
            reason: reason.map(str::to_owned),
            ban: Some(true),
        })
    }

    /// Send a private text message to this user.
    pub async fn send_text(&self, text: impl Into<String>) -> Result<()> {
        self.client.send_proto(MessageType::TextMessage, &mumbleproto::TextMessage {
            session: vec![self.session],
            message: text.into(),
            ..Default::default()
        })
    }

    /// Request `UserStats` for this user. The server's response will arrive
    /// as `ClientEvent::UserStats`.
    pub async fn request_stats(&self, stats_only: bool) -> Result<()> {
        self.client.send_proto(MessageType::UserStats, &mumbleproto::UserStats {
            session: Some(self.session),
            stats_only: Some(stats_only),
            ..Default::default()
        })
    }

    /// Block until a `UserStats` event for this user arrives or `wait` elapses.
    pub async fn fetch_stats(&self, wait: Duration) -> Result<mumbleproto::UserStats> {
        let mut sub = self.client.subscribe();
        self.request_stats(false).await?;
        let session = self.session;
        timeout(wait, async move {
            loop {
                match sub.recv().await {
                    Ok(ClientEvent::UserStats(s)) if s.session == Some(session) => return Ok(*s),
                    Ok(_) => continue,
                    Err(e) => return Err(anyhow!("event channel: {e}")),
                }
            }
        })
        .await
        .context("timeout waiting for UserStats")?
    }

    /// Request the server send the user's full texture blob.
    pub async fn request_texture(&self) -> Result<()> {
        self.client.send_proto(MessageType::RequestBlob, &mumbleproto::RequestBlob {
            session_texture: vec![self.session],
            ..Default::default()
        })
    }

    /// Request the server send the user's full comment blob.
    pub async fn request_comment(&self) -> Result<()> {
        self.client.send_proto(MessageType::RequestBlob, &mumbleproto::RequestBlob {
            session_comment: vec![self.session],
            ..Default::default()
        })
    }

    /// Send plugin data targeted at this user only.
    pub async fn send_plugin_data(&self, plugin_id: &str, data: &[u8]) -> Result<()> {
        self.client.send_proto(
            MessageType::PluginDataTransmission,
            &mumbleproto::PluginDataTransmission {
                sender_session: self.client.session_id(),
                receiver_sessions: vec![self.session],
                data: Some(data.to_vec()),
                data_id: Some(plugin_id.to_owned()),
            },
        )
    }

    fn send_state(&self, mut msg: mumbleproto::UserState) -> Result<()> {
        msg.session = Some(self.session);
        msg.actor = self.client.session_id();
        self.client.send_proto(MessageType::UserState, &msg)
    }
}
