//! Server-wide / admin operations: bans, registered users, server info.

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use tokio::time::timeout;

use crate::client::MumbleClient;
use crate::domain::{Ban, RegisteredUser, ServerInformation};
use crate::events::ClientEvent;

/// Handle for server-wide / admin operations.
#[derive(Clone)]
pub struct Server<'a> {
    pub(crate) client: &'a MumbleClient,
}

impl<'a> Server<'a> {
    /// Snapshot of the most recently observed server information.
    pub fn information(&self) -> ServerInformation {
        self.client.server_info_snapshot()
    }

    // ── Bans ──────────────────────────────────────────────────────────────

    /// Send a `BanList` query to the server. The server's response will
    /// arrive as `ClientEvent::BanList`.
    pub async fn request_bans(&self) -> Result<()> {
        self.client.send_proto(MessageType::BanList, &mumbleproto::BanList {
            query: Some(true),
            ..Default::default()
        })
    }

    /// Query the ban list and wait for the response.
    pub async fn list_bans(&self, wait: Duration) -> Result<Vec<Ban>> {
        let mut sub = self.client.subscribe();
        self.request_bans().await?;
        timeout(wait, async move {
            loop {
                match sub.recv().await {
                    Ok(ClientEvent::BanList(messages)) => {
                        // The server returns one BanList containing all entries.
                        let bans = messages
                            .iter()
                            .flat_map(|m| m.bans.iter())
                            .map(Ban::from_proto)
                            .collect();
                        return Ok(bans);
                    }
                    Ok(_) => continue,
                    Err(e) => return Err(anyhow!("event channel: {e}")),
                }
            }
        })
        .await
        .context("timeout waiting for BanList")?
    }

    /// Replace the entire ban list with the given entries (Mumble protocol
    /// semantics: sending `BanList` with `query=false` overwrites the list).
    pub async fn save_bans(&self, bans: &[Ban]) -> Result<()> {
        self.client.send_proto(MessageType::BanList, &mumbleproto::BanList {
            bans: bans.iter().map(Ban::to_proto).collect(),
            query: Some(false),
        })
    }

    /// Low-level escape hatch: send a raw `BanList` protobuf message.
    pub async fn send_ban_list_proto(&self, msg: mumbleproto::BanList) -> Result<()> {
        self.client.send_proto(MessageType::BanList, &msg)
    }

    /// Append a single ban to the existing list (round-trip: list → push → save).
    pub async fn add_ban(&self, ban: Ban, wait: Duration) -> Result<()> {
        let mut current = self.list_bans(wait).await.unwrap_or_default();
        current.push(ban);
        self.save_bans(&current).await
    }

    /// Remove every ban whose IP address equals `ip` (round-trip).
    pub async fn remove_bans_by_address(
        &self,
        ip: std::net::IpAddr,
        wait: Duration,
    ) -> Result<usize> {
        let mut current = self.list_bans(wait).await.unwrap_or_default();
        let before = current.len();
        current.retain(|b| b.address != ip);
        let removed = before - current.len();
        if removed > 0 {
            self.save_bans(&current).await?;
        }
        Ok(removed)
    }

    // ── Registered users ──────────────────────────────────────────────────

    /// Request the list of registered users (`UserList` message).
    pub async fn request_registered_users(&self) -> Result<()> {
        self.client.send_proto(MessageType::UserList, &mumbleproto::UserList::default())
    }

    /// Query and await the registered user list.
    pub async fn list_registered_users(&self, wait: Duration) -> Result<Vec<RegisteredUser>> {
        let mut sub = self.client.subscribe();
        self.request_registered_users().await?;
        timeout(wait, async move {
            loop {
                match sub.recv().await {
                    Ok(ClientEvent::UserList(users)) => return Ok(users),
                    Ok(_) => continue,
                    Err(e) => return Err(anyhow!("event channel: {e}")),
                }
            }
        })
        .await
        .context("timeout waiting for UserList")?
    }

    /// Save edits to registered users — delete entries by including a
    /// blank `name`; rename by setting a new `name`. Mirrors the C++
    /// UserList editor behaviour.
    pub async fn save_registered_users(&self, users: &[RegisteredUser]) -> Result<()> {
        self.client.send_proto(MessageType::UserList, &mumbleproto::UserList {
            users: users.iter().map(RegisteredUser::to_proto).collect(),
        })
    }

    /// Convenience: rename a single registered user.
    pub async fn rename_registered_user(&self, user_id: u32, new_name: &str) -> Result<()> {
        self.save_registered_users(&[RegisteredUser {
            user_id,
            name: Some(new_name.to_owned()),
            last_seen: None,
            last_channel: None,
        }])
        .await
    }

    /// Convenience: delete (un-register) a registered user.
    pub async fn unregister_user(&self, user_id: u32) -> Result<()> {
        self.save_registered_users(&[RegisteredUser {
            user_id,
            name: Some(String::new()),
            last_seen: None,
            last_channel: None,
        }])
        .await
    }

    // ── QueryUsers ────────────────────────────────────────────────────────

    /// Resolve user IDs ↔ names via `QueryUsers`. The response arrives as
    /// `ClientEvent::QueryUsers` (re-fired by the client).
    pub async fn query_users(&self, ids: Vec<u32>, names: Vec<String>) -> Result<()> {
        self.client.send_proto(MessageType::QueryUsers, &mumbleproto::QueryUsers { ids, names })
    }

    /// Resolve and wait for the `QueryUsers` response.
    pub async fn fetch_users(
        &self,
        ids: Vec<u32>,
        names: Vec<String>,
        wait: Duration,
    ) -> Result<mumbleproto::QueryUsers> {
        let mut sub = self.client.subscribe();
        self.query_users(ids, names).await?;
        timeout(wait, async move {
            loop {
                match sub.recv().await {
                    Ok(ClientEvent::QueryUsers(q)) => return Ok(q),
                    Ok(_) => continue,
                    Err(e) => return Err(anyhow!("event channel: {e}")),
                }
            }
        })
        .await
        .context("timeout waiting for QueryUsers")?
    }

    // ── Context actions ───────────────────────────────────────────────────

    /// Register a context-menu action with the server.
    pub async fn register_context_action(
        &self,
        action: &str,
        text: &str,
        context: u32,
    ) -> Result<()> {
        self.client.send_proto(
            MessageType::ContextActionModify,
            &mumbleproto::ContextActionModify {
                action: action.to_owned(),
                text: Some(text.to_owned()),
                context: Some(context),
                operation: Some(0), // Add
            },
        )
    }

    /// Unregister a previously registered context action.
    pub async fn unregister_context_action(&self, action: &str) -> Result<()> {
        self.client.send_proto(
            MessageType::ContextActionModify,
            &mumbleproto::ContextActionModify {
                action: action.to_owned(),
                text: None,
                context: None,
                operation: Some(1), // Remove
            },
        )
    }

    /// Trigger a context action (server→user direction is normally inbound,
    /// but the protocol allows the client to send one as well).
    pub async fn trigger_context_action(
        &self,
        action: &str,
        session: Option<u32>,
        channel_id: Option<u32>,
    ) -> Result<()> {
        self.client.send_proto(MessageType::ContextAction, &mumbleproto::ContextAction {
            action: action.to_owned(),
            session,
            channel_id,
        })
    }

    // ── Plugin data ───────────────────────────────────────────────────────

    /// Broadcast plugin data to a list of receivers (empty = all).
    pub async fn broadcast_plugin_data(
        &self,
        plugin_id: &str,
        data: &[u8],
        receivers: &[u32],
    ) -> Result<()> {
        self.client.send_proto(
            MessageType::PluginDataTransmission,
            &mumbleproto::PluginDataTransmission {
                sender_session: self.client.session_id(),
                receiver_sessions: receivers.to_vec(),
                data: Some(data.to_vec()),
                data_id: Some(plugin_id.to_owned()),
            },
        )
    }
}
