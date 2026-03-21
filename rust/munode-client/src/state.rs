//! Channel and user state maintained by the client.

use std::collections::HashMap;

/// Current connection lifecycle state.
///
/// Transitions:
/// ```text
/// Disconnected → Connecting → Connected → Authenticating → Ready → Disconnecting → Disconnected
/// ```
/// Any state can transition to `Disconnected` on error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    /// No active connection.
    Disconnected,
    /// TCP handshake in progress.
    Connecting,
    /// TCP/TLS connected; Version + Authenticate sent.
    Authenticating,
    /// ServerSync received — fully authenticated and ready.
    Ready,
    /// Graceful disconnect in progress.
    Disconnecting,
}

/// Channel information derived from `ChannelState` messages.
#[derive(Debug, Clone)]
pub struct Channel {
    pub channel_id: u32,
    pub parent: u32,
    pub name: String,
    pub description: Option<String>,
    pub temporary: bool,
    pub position: i32,
    /// Set of channel IDs this channel is linked to.
    pub links: Vec<u32>,
    pub max_users: u32,
}

/// User information derived from `UserState` messages.
#[derive(Debug, Clone)]
pub struct User {
    pub session: u32,
    pub user_id: Option<u32>,
    pub name: String,
    pub channel_id: u32,
    pub mute: bool,
    pub deaf: bool,
    pub suppress: bool,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub recording: bool,
    pub priority_speaker: bool,
    pub hash: Option<String>,
    pub comment: Option<String>,
    pub texture: Option<Vec<u8>>,
}

/// The current session's local state.
#[derive(Debug, Clone)]
pub struct SessionState {
    pub session: u32,
    pub user_id: Option<u32>,
    pub channel_id: u32,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub listening_channels: Vec<u32>,
}

/// Shared client state (protected by `RwLock`).
#[derive(Debug)]
pub struct ClientState {
    pub connection_state: ConnectionState,
    pub session: Option<SessionState>,
    pub channels: HashMap<u32, Channel>,
    pub users: HashMap<u32, User>,
    pub max_bandwidth: u32,
    pub welcome_text: Option<String>,
}

impl Default for ClientState {
    fn default() -> Self {
        Self {
            connection_state: ConnectionState::Disconnected,
            session: None,
            channels: HashMap::new(),
            users: HashMap::new(),
            max_bandwidth: 0,
            welcome_text: None,
        }
    }
}

impl ClientState {
    pub fn new() -> Self {
        Self::default()
    }

    // ── ChannelState handling ──────────────────────────────────────────────

    /// Apply a `ChannelState` message, returning whether this is a new channel.
    pub fn apply_channel_state(
        &mut self,
        msg: &munode_protocol::mumbleproto::ChannelState,
    ) -> bool {
        let channel_id = msg.channel_id();
        let is_new = !self.channels.contains_key(&channel_id);
        let existing = self.channels.get(&channel_id).cloned();

        // Compute updated links
        let links = if !msg.links_add.is_empty() || !msg.links_remove.is_empty() {
            let mut ls: Vec<u32> = existing.as_ref().map(|c| c.links.clone()).unwrap_or_default();
            for &id in &msg.links_add {
                if !ls.contains(&id) {
                    ls.push(id);
                }
            }
            ls.retain(|id| !msg.links_remove.contains(id));
            ls
        } else if !msg.links.is_empty() {
            msg.links.clone()
        } else {
            existing.as_ref().map(|c| c.links.clone()).unwrap_or_default()
        };

        let channel = Channel {
            channel_id,
            parent: msg.parent.unwrap_or_else(|| {
                existing.as_ref().map(|c| c.parent).unwrap_or(0)
            }),
            name: msg.name.clone().unwrap_or_else(|| {
                existing.as_ref().map(|c| c.name.clone()).unwrap_or_default()
            }),
            description: msg.description.clone().or_else(|| {
                existing.as_ref().and_then(|c| c.description.clone())
            }),
            temporary: msg.temporary.unwrap_or_else(|| {
                existing.as_ref().map(|c| c.temporary).unwrap_or(false)
            }),
            position: msg.position.unwrap_or_else(|| {
                existing.as_ref().map(|c| c.position).unwrap_or(0)
            }),
            links,
            max_users: msg.max_users.unwrap_or_else(|| {
                existing.as_ref().map(|c| c.max_users).unwrap_or(0)
            }),
        };
        self.channels.insert(channel_id, channel);
        is_new
    }

    /// Remove a channel by ID.
    pub fn remove_channel(&mut self, channel_id: u32) {
        self.channels.remove(&channel_id);
    }

    // ── UserState handling ─────────────────────────────────────────────────

    /// Apply a `UserState` message, returning whether this is a new user.
    pub fn apply_user_state(
        &mut self,
        msg: &munode_protocol::mumbleproto::UserState,
    ) -> bool {
        let session = msg.session();
        let is_new = !self.users.contains_key(&session);
        let existing = self.users.get(&session).cloned();

        let user = User {
            session,
            user_id: msg.user_id,
            name: msg.name.clone().unwrap_or_else(|| {
                existing.as_ref().map(|u| u.name.clone()).unwrap_or_default()
            }),
            channel_id: msg.channel_id.unwrap_or_else(|| {
                existing.as_ref().map(|u| u.channel_id).unwrap_or(0)
            }),
            mute: msg.mute.unwrap_or_else(|| {
                existing.as_ref().map(|u| u.mute).unwrap_or(false)
            }),
            deaf: msg.deaf.unwrap_or_else(|| {
                existing.as_ref().map(|u| u.deaf).unwrap_or(false)
            }),
            suppress: msg.suppress.unwrap_or_else(|| {
                existing.as_ref().map(|u| u.suppress).unwrap_or(false)
            }),
            self_mute: msg.self_mute.unwrap_or_else(|| {
                existing.as_ref().map(|u| u.self_mute).unwrap_or(false)
            }),
            self_deaf: msg.self_deaf.unwrap_or_else(|| {
                existing.as_ref().map(|u| u.self_deaf).unwrap_or(false)
            }),
            recording: msg.recording.unwrap_or_else(|| {
                existing.as_ref().map(|u| u.recording).unwrap_or(false)
            }),
            priority_speaker: msg.priority_speaker.unwrap_or_else(|| {
                existing.as_ref().map(|u| u.priority_speaker).unwrap_or(false)
            }),
            hash: msg.hash.clone().or_else(|| {
                existing.as_ref().and_then(|u| u.hash.clone())
            }),
            comment: msg.comment.clone().or_else(|| {
                existing.as_ref().and_then(|u| u.comment.clone())
            }),
            texture: msg.texture.clone().or_else(|| {
                existing.as_ref().and_then(|u| u.texture.clone())
            }),
        };
        self.users.insert(session, user.clone());

        // Mirror session state if this is "us"
        if let Some(sess) = &mut self.session {
            if sess.session == session {
                sess.channel_id = user.channel_id;
                sess.self_mute = user.self_mute;
                sess.self_deaf = user.self_deaf;
            }
        }

        is_new
    }

    /// Remove a user by session ID.
    pub fn remove_user(&mut self, session: u32) {
        self.users.remove(&session);
    }

    /// Apply a `ServerSync` message to initialise the session state.
    pub fn apply_server_sync(
        &mut self,
        msg: &munode_protocol::mumbleproto::ServerSync,
    ) {
        let session = msg.session();
        let max_bandwidth = msg.max_bandwidth.unwrap_or(0);
        let welcome_text = msg.welcome_text.clone();

        self.max_bandwidth = max_bandwidth;
        self.welcome_text = welcome_text;
        self.connection_state = ConnectionState::Ready;

        // Build session from any UserState we may have already received
        let existing_user = self.users.get(&session).cloned();
        self.session = Some(SessionState {
            session,
            user_id: existing_user.as_ref().and_then(|u| u.user_id),
            channel_id: existing_user.as_ref().map(|u| u.channel_id).unwrap_or(0),
            self_mute: existing_user.as_ref().map(|u| u.self_mute).unwrap_or(false),
            self_deaf: existing_user.as_ref().map(|u| u.self_deaf).unwrap_or(false),
            listening_channels: vec![],
        });
    }
}
