use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{debug, info};

use munode_protocol::hubedge::{ChannelDataProto, ChannelLinkProto, GlobalSessionProto};

/// Information about a channel, stored locally on the Edge.
#[derive(Debug, Clone)]
pub struct ChannelData {
    pub id: u32,
    pub name: String,
    pub parent_id: Option<u32>,
    pub description: Option<String>,
    pub position: i32,
    pub max_users: u32,
    pub temporary: bool,
    pub inherit_acl: bool,
    pub links: Vec<u32>,
}

impl From<&ChannelDataProto> for ChannelData {
    fn from(proto: &ChannelDataProto) -> Self {
        Self {
            id: proto.channel_id,
            name: proto.name.clone(),
            parent_id: proto.parent_id,
            description: proto.description.clone(),
            position: proto.position.unwrap_or(0),
            max_users: proto.max_users.unwrap_or(0),
            temporary: proto.temporary.unwrap_or(false),
            inherit_acl: proto.inherit_acl.unwrap_or(true),
            links: proto.links.clone(),
        }
    }
}

/// Information about a remote user (on another Edge), synced from Hub.
#[derive(Debug, Clone)]
pub struct RemoteUser {
    pub session_id: u32,
    pub edge_id: u32,
    pub user_id: u32,
    pub username: String,
    pub channel_id: u32,
    pub cert_hash: Option<String>,
    pub groups: Vec<String>,
    pub mute: bool,
    pub deaf: bool,
    pub suppress: bool,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub priority_speaker: bool,
    pub recording: bool,
}

impl From<&GlobalSessionProto> for RemoteUser {
    fn from(proto: &GlobalSessionProto) -> Self {
        Self {
            session_id: proto.session_id,
            edge_id: proto.edge_id,
            user_id: proto.user_id,
            username: proto.username.clone(),
            channel_id: proto.channel_id,
            cert_hash: proto.cert_hash.clone(),
            groups: proto.groups.clone(),
            mute: proto.mute.unwrap_or(false),
            deaf: proto.deaf.unwrap_or(false),
            suppress: proto.suppress.unwrap_or(false),
            self_mute: proto.self_mute.unwrap_or(false),
            self_deaf: proto.self_deaf.unwrap_or(false),
            priority_speaker: proto.priority_speaker.unwrap_or(false),
            recording: proto.recording.unwrap_or(false),
        }
    }
}

/// Manages channel hierarchy and remote user state on the Edge.
/// Channels and remote users are synced from the Hub.
pub struct ChannelManager {
    channels: RwLock<HashMap<u32, ChannelData>>,
    channel_children: RwLock<HashMap<u32, Vec<u32>>>,
    remote_users: RwLock<HashMap<u32, RemoteUser>>,
}

impl ChannelManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            channels: RwLock::new(HashMap::new()),
            channel_children: RwLock::new(HashMap::new()),
            remote_users: RwLock::new(HashMap::new()),
        })
    }

    /// Load channels from a fullSync response.
    pub async fn load_channels(&self, channels: &[ChannelDataProto], links: &[ChannelLinkProto]) {
        let mut ch_map = self.channels.write().await;
        let mut children_map = self.channel_children.write().await;
        ch_map.clear();
        children_map.clear();

        for proto in channels {
            let channel = ChannelData::from(proto);
            ch_map.insert(channel.id, channel.clone());

            if let Some(pid) = channel.parent_id {
                children_map.entry(pid).or_default().push(channel.id);
            }
        }

        // Apply link info
        for link in links {
            if let Some(ch) = ch_map.get_mut(&link.channel_id) {
                if !ch.links.contains(&link.target_id) {
                    ch.links.push(link.target_id);
                }
            }
        }

        info!("Loaded {} channels from Hub", ch_map.len());
    }

    /// Load remote users from a fullSync response.
    pub async fn load_remote_users(&self, sessions: &[GlobalSessionProto]) {
        let mut users = self.remote_users.write().await;
        users.clear();
        for proto in sessions {
            let user = RemoteUser::from(proto);
            users.insert(user.session_id, user);
        }
        info!("Loaded {} remote users from Hub", users.len());
    }

    /// Get a channel by ID.
    pub async fn get_channel(&self, id: u32) -> Option<ChannelData> {
        self.channels.read().await.get(&id).cloned()
    }

    /// Get all channels.
    pub async fn get_all_channels(&self) -> Vec<ChannelData> {
        self.channels.read().await.values().cloned().collect()
    }

    /// Get channels in BFS order starting from root (channel 0).
    pub async fn get_channels_bfs(&self) -> Vec<ChannelData> {
        let channels = self.channels.read().await;
        let children = self.channel_children.read().await;
        let mut result = Vec::new();
        let mut queue = std::collections::VecDeque::new();

        // Start from root channel (ID = 0)
        if let Some(root) = channels.get(&0) {
            result.push(root.clone());
            queue.push_back(0u32);
        }

        while let Some(parent_id) = queue.pop_front() {
            if let Some(child_ids) = children.get(&parent_id) {
                let mut sorted: Vec<_> = child_ids.iter()
                    .filter_map(|id| channels.get(id))
                    .cloned()
                    .collect();
                sorted.sort_by_key(|c| c.position);
                for ch in sorted {
                    queue.push_back(ch.id);
                    result.push(ch);
                }
            }
        }

        result
    }

    /// Get children of a channel.
    pub async fn get_children(&self, channel_id: u32) -> Vec<u32> {
        self.channel_children.read().await.get(&channel_id).cloned().unwrap_or_default()
    }

    /// Add or update a channel.
    pub async fn upsert_channel(&self, channel: ChannelData) {
        let id = channel.id;
        let parent_id = channel.parent_id;
        self.channels.write().await.insert(id, channel);
        if let Some(pid) = parent_id {
            let mut children = self.channel_children.write().await;
            let list = children.entry(pid).or_default();
            if !list.contains(&id) {
                list.push(id);
            }
        }
        debug!("Upserted channel {}", id);
    }

    /// Remove a channel.
    pub async fn remove_channel(&self, channel_id: u32) {
        if let Some(ch) = self.channels.write().await.remove(&channel_id) {
            if let Some(pid) = ch.parent_id {
                if let Some(children) = self.channel_children.write().await.get_mut(&pid) {
                    children.retain(|&id| id != channel_id);
                }
            }
        }
        self.channel_children.write().await.remove(&channel_id);
        debug!("Removed channel {}", channel_id);
    }

    /// Add or update a remote user.
    pub async fn upsert_remote_user(&self, user: RemoteUser) {
        let sid = user.session_id;
        self.remote_users.write().await.insert(sid, user);
    }

    /// Remove a remote user.
    pub async fn remove_remote_user(&self, session_id: u32) -> Option<RemoteUser> {
        self.remote_users.write().await.remove(&session_id)
    }

    /// Get a remote user.
    pub async fn get_remote_user(&self, session_id: u32) -> Option<RemoteUser> {
        self.remote_users.read().await.get(&session_id).cloned()
    }

    /// Get all remote users.
    pub async fn get_all_remote_users(&self) -> Vec<RemoteUser> {
        self.remote_users.read().await.values().cloned().collect()
    }
}
