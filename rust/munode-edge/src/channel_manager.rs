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
    pub listening_channels: Vec<u32>,
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
            listening_channels: vec![],
        }
    }
}

/// Manages channel hierarchy and remote user state on the Edge.
/// Channels and remote users are synced from the Hub.
pub struct ChannelManager {
    channels: RwLock<HashMap<u32, ChannelData>>,
    channel_children: RwLock<HashMap<u32, Vec<u32>>>,
    remote_users: RwLock<HashMap<u32, RemoteUser>>,
    /// Reverse index: channel_id → set of remote session IDs in that channel.
    ///
    /// Maintained in sync with `remote_users` so that `get_remote_users_in_channels`
    /// can run in O(|target_channels| × |sessions_per_channel|) instead of O(N) over
    /// all remote users.  This matters in large clusters where N can be thousands.
    channel_to_sessions: RwLock<HashMap<u32, std::collections::HashSet<u32>>>,
}

impl ChannelManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            channels: RwLock::new(HashMap::new()),
            channel_children: RwLock::new(HashMap::new()),
            remote_users: RwLock::new(HashMap::new()),
            channel_to_sessions: RwLock::new(HashMap::new()),
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
        let mut index = self.channel_to_sessions.write().await;
        users.clear();
        index.clear();
        for proto in sessions {
            let user = RemoteUser::from(proto);
            index.entry(user.channel_id).or_default().insert(user.session_id);
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
        let new_channel = user.channel_id;
        let mut users = self.remote_users.write().await;
        let mut index = self.channel_to_sessions.write().await;
        // Remove from the old channel bucket if the user already existed and moved.
        if let Some(old) = users.get(&sid) {
            if old.channel_id != new_channel {
                if let Some(set) = index.get_mut(&old.channel_id) {
                    set.remove(&sid);
                }
            }
        }
        index.entry(new_channel).or_default().insert(sid);
        users.insert(sid, user);
    }

    /// Remove a remote user.
    pub async fn remove_remote_user(&self, session_id: u32) -> Option<RemoteUser> {
        let mut users = self.remote_users.write().await;
        let mut index = self.channel_to_sessions.write().await;
        if let Some(user) = users.remove(&session_id) {
            if let Some(set) = index.get_mut(&user.channel_id) {
                set.remove(&session_id);
            }
            Some(user)
        } else {
            None
        }
    }

    /// Get a remote user.
    pub async fn get_remote_user(&self, session_id: u32) -> Option<RemoteUser> {
        self.remote_users.read().await.get(&session_id).cloned()
    }

    /// Get all remote users.
    pub async fn get_all_remote_users(&self) -> Vec<RemoteUser> {
        self.remote_users.read().await.values().cloned().collect()
    }

    /// Get remote users in a specific channel (on other edges).
    pub async fn get_remote_users_in_channel(&self, channel_id: u32) -> Vec<RemoteUser> {
        self.remote_users.read().await
            .values()
            .filter(|u| u.channel_id == channel_id)
            .cloned()
            .collect()
    }

    /// Get all channels reachable from `start_channel_id` via channel links (BFS).
    /// Returns the set of all linked channel IDs including the start channel itself.
    pub async fn get_all_linked_channels(&self, start_channel_id: u32) -> std::collections::HashSet<u32> {
        let channels = self.channels.read().await;
        let mut visited = std::collections::HashSet::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(start_channel_id);
        visited.insert(start_channel_id);
        while let Some(ch_id) = queue.pop_front() {
            if let Some(ch) = channels.get(&ch_id) {
                for &link_id in &ch.links {
                    if visited.insert(link_id) {
                        queue.push_back(link_id);
                    }
                }
            }
        }
        visited
    }

    /// Get remote users in any of the given channels.
    ///
    /// Uses the `channel_to_sessions` reverse index for O(|channels| × |sessions_per_channel|)
    /// performance instead of scanning all remote users.
    pub async fn get_remote_users_in_channels(&self, channel_ids: &std::collections::HashSet<u32>) -> Vec<RemoteUser> {
        let index = self.channel_to_sessions.read().await;
        let users = self.remote_users.read().await;
        let mut result = Vec::new();
        for &ch_id in channel_ids {
            if let Some(sessions) = index.get(&ch_id) {
                for &sid in sessions {
                    if let Some(user) = users.get(&sid) {
                        result.push(user.clone());
                    }
                }
            }
        }
        result
    }

    /// Get a snapshot of the children map.
    pub async fn get_all_children_map(&self) -> std::collections::HashMap<u32, Vec<u32>> {
        self.channel_children.read().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use munode_protocol::hubedge::{ChannelDataProto, ChannelLinkProto, GlobalSessionProto};

    fn make_channel_proto(id: u32, parent_id: Option<u32>, name: &str, pos: i32) -> ChannelDataProto {
        ChannelDataProto {
            channel_id: id,
            name: name.to_string(),
            parent_id,
            description: None,
            position: Some(pos),
            max_users: Some(100),
            temporary: Some(false),
            inherit_acl: Some(true),
            links: vec![],
        }
    }

    #[tokio::test]
    async fn test_load_channels() {
        let mgr = ChannelManager::new();
        let channels = vec![
            make_channel_proto(0, None, "Root", 0),
            make_channel_proto(1, Some(0), "General", 0),
            make_channel_proto(2, Some(0), "AFK", 1),
            make_channel_proto(3, Some(1), "Sub-channel", 0),
        ];
        mgr.load_channels(&channels, &[]).await;

        assert_eq!(mgr.get_all_channels().await.len(), 4);
        assert!(mgr.get_channel(0).await.is_some());
        assert!(mgr.get_channel(3).await.is_some());
    }

    #[tokio::test]
    async fn test_bfs_order() {
        let mgr = ChannelManager::new();
        let channels = vec![
            make_channel_proto(0, None, "Root", 0),
            make_channel_proto(1, Some(0), "A", 0),
            make_channel_proto(2, Some(0), "B", 1),
            make_channel_proto(3, Some(1), "A-sub", 0),
        ];
        mgr.load_channels(&channels, &[]).await;

        let bfs = mgr.get_channels_bfs().await;
        assert_eq!(bfs.len(), 4);
        assert_eq!(bfs[0].id, 0); // Root first
        assert_eq!(bfs[1].id, 1); // A (position 0)
        assert_eq!(bfs[2].id, 2); // B (position 1)
        assert_eq!(bfs[3].id, 3); // A-sub (child of A)
    }

    #[tokio::test]
    async fn test_channel_links() {
        let mgr = ChannelManager::new();
        let channels = vec![
            make_channel_proto(0, None, "Root", 0),
            make_channel_proto(1, Some(0), "A", 0),
            make_channel_proto(2, Some(0), "B", 1),
        ];
        let links = vec![
            ChannelLinkProto { channel_id: 1, target_id: 2 },
        ];
        mgr.load_channels(&channels, &links).await;

        let ch1 = mgr.get_channel(1).await.unwrap();
        assert!(ch1.links.contains(&2));
    }

    #[tokio::test]
    async fn test_remote_users() {
        let mgr = ChannelManager::new();
        let sessions = vec![
            GlobalSessionProto {
                session_id: 100,
                edge_id: 1,
                user_id: 10,
                username: "alice".to_string(),
                channel_id: 0,
                cert_hash: None,
                groups: vec![],
                mute: None,
                deaf: None,
                suppress: None,
                self_mute: None,
                self_deaf: None,
                priority_speaker: None,
                recording: None,
                ip_address: None,
                connected_at: None,
            },
        ];
        mgr.load_remote_users(&sessions).await;

        let user = mgr.get_remote_user(100).await.unwrap();
        assert_eq!(user.username, "alice");

        mgr.remove_remote_user(100).await;
        assert!(mgr.get_remote_user(100).await.is_none());
    }

    #[tokio::test]
    async fn test_upsert_and_remove_channel() {
        let mgr = ChannelManager::new();
        mgr.upsert_channel(ChannelData {
            id: 0,
            name: "Root".to_string(),
            parent_id: None,
            description: None,
            position: 0,
            max_users: 0,
            temporary: false,
            inherit_acl: true,
            links: vec![],
        }).await;

        mgr.upsert_channel(ChannelData {
            id: 1,
            name: "Test".to_string(),
            parent_id: Some(0),
            description: None,
            position: 0,
            max_users: 0,
            temporary: true,
            inherit_acl: true,
            links: vec![],
        }).await;

        assert_eq!(mgr.get_children(0).await.len(), 1);

        mgr.remove_channel(1).await;
        assert!(mgr.get_channel(1).await.is_none());
        assert_eq!(mgr.get_children(0).await.len(), 0);
    }
}
