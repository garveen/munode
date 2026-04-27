//! Operations on a single channel identified by its channel ID.

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use tokio::time::timeout;

use crate::client::MumbleClient;
use crate::events::ClientEvent;
use crate::handles::Acl;
use crate::state::Channel;

/// Handle for operations targeting a single channel.
#[derive(Clone)]
pub struct ChannelRef<'a> {
    pub(crate) client: &'a MumbleClient,
    pub(crate) channel_id: u32,
}

impl<'a> ChannelRef<'a> {
    /// The channel ID this handle refers to.
    pub fn id(&self) -> u32 {
        self.channel_id
    }

    /// Current snapshot of channel state, if known.
    pub fn info(&self) -> Option<Channel> {
        self.client.channel_info(self.channel_id)
    }

    /// Move the connected user into this channel.
    pub async fn join(&self) -> Result<()> {
        self.client.me().move_to(self.channel_id).await
    }

    /// Create a new subchannel under this channel and return its id.
    pub async fn create_subchannel(&self, name: impl Into<String>) -> Result<u32> {
        self.client.create_channel(&name.into(), self.channel_id).await
    }

    /// Delete this channel.
    pub async fn delete(&self) -> Result<()> {
        self.client.send_proto(MessageType::ChannelRemove, &mumbleproto::ChannelRemove {
            channel_id: self.channel_id,
        })
    }

    /// Rename the channel.
    pub async fn rename(&self, name: impl Into<String>) -> Result<()> {
        self.send_state(mumbleproto::ChannelState {
            name: Some(name.into()),
            ..Default::default()
        })
    }

    /// Set channel position weight.
    pub async fn set_position(&self, position: i32) -> Result<()> {
        self.send_state(mumbleproto::ChannelState {
            position: Some(position),
            ..Default::default()
        })
    }

    /// Set the channel's user-count limit (`0` = server default).
    pub async fn set_max_users(&self, max_users: u32) -> Result<()> {
        self.send_state(mumbleproto::ChannelState {
            max_users: Some(max_users),
            ..Default::default()
        })
    }

    /// Set the channel description.
    pub async fn set_description(&self, description: impl Into<String>) -> Result<()> {
        self.send_state(mumbleproto::ChannelState {
            description: Some(description.into()),
            ..Default::default()
        })
    }

    /// Add a one-way link from this channel to another.
    pub async fn link(&self, other_id: u32) -> Result<()> {
        self.send_state(mumbleproto::ChannelState {
            links_add: vec![other_id],
            ..Default::default()
        })
    }

    /// Remove a link.
    pub async fn unlink(&self, other_id: u32) -> Result<()> {
        self.send_state(mumbleproto::ChannelState {
            links_remove: vec![other_id],
            ..Default::default()
        })
    }

    /// Remove every link from this channel.
    pub async fn unlink_all(&self) -> Result<()> {
        let links = self.info().map(|c| c.links).unwrap_or_default();
        if links.is_empty() {
            return Ok(());
        }
        self.send_state(mumbleproto::ChannelState {
            links_remove: links,
            ..Default::default()
        })
    }

    /// Send a text message into this channel.
    pub async fn send_text(&self, text: impl Into<String>) -> Result<()> {
        self.client.send_proto(MessageType::TextMessage, &mumbleproto::TextMessage {
            channel_id: vec![self.channel_id],
            message: text.into(),
            ..Default::default()
        })
    }

    /// Send a text message recursively to this channel and all its sub-channels.
    pub async fn send_text_tree(&self, text: impl Into<String>) -> Result<()> {
        self.client.send_proto(MessageType::TextMessage, &mumbleproto::TextMessage {
            tree_id: vec![self.channel_id],
            message: text.into(),
            ..Default::default()
        })
    }

    /// Begin listening to this channel (link as listener).
    pub async fn add_listener(&self) -> Result<()> {
        self.client.me().add_listener(self.channel_id).await
    }

    /// Stop listening to this channel.
    pub async fn remove_listener(&self) -> Result<()> {
        self.client.me().remove_listener(self.channel_id).await
    }

    /// Request the channel's full description blob from the server.
    pub async fn request_description(&self) -> Result<()> {
        self.client.send_proto(MessageType::RequestBlob, &mumbleproto::RequestBlob {
            channel_description: vec![self.channel_id],
            ..Default::default()
        })
    }

    /// Send a `PermissionQuery` for this channel.
    pub async fn query_permission(&self, mask: u32) -> Result<()> {
        self.client.send_proto(MessageType::PermissionQuery, &mumbleproto::PermissionQuery {
            channel_id: Some(self.channel_id),
            permissions: Some(mask),
            flush: Some(false),
        })
    }

    /// Send a permission query and await the server's response.
    pub async fn fetch_permission(&self, mask: u32, wait: Duration) -> Result<u32> {
        let mut sub = self.client.subscribe();
        self.query_permission(mask).await?;
        let id = self.channel_id;
        timeout(wait, async move {
            loop {
                match sub.recv().await {
                    Ok(ClientEvent::PermissionQuery { channel_id, permissions })
                        if channel_id == id =>
                    {
                        return Ok(permissions);
                    }
                    Ok(_) => continue,
                    Err(e) => return Err(anyhow!("event channel: {e}")),
                }
            }
        })
        .await
        .context("timeout waiting for PermissionQuery")?
    }

    /// Get the ACL editor handle for this channel.
    pub fn acl(&self) -> Acl<'a> {
        self.client.acl(self.channel_id)
    }

    fn send_state(&self, mut msg: mumbleproto::ChannelState) -> Result<()> {
        msg.channel_id = Some(self.channel_id);
        self.client.send_proto(MessageType::ChannelState, &msg)
    }
}
