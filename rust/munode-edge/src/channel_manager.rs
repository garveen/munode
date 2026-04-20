use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use std::collections::BTreeMap;

use tokio::sync::RwLock;
use tracing::{debug, info};

use munode_protocol::hubedge::{ChannelDataProto, ChannelLinkProto, GlobalSessionProto};
use munode_protocol::edgepeersync::{
    EdgeSessionDelta, RemoteSessionProto,
};

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

/// Information about a remote user (on another Edge).
/// Supports both Hub-synced data (GlobalSessionProto) and
/// Edge-to-Edge peer-synced data (RemoteSessionProto).
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
    // Fields added by Edge Session Mesh (§5.3)
    pub texture_hash: Option<Vec<u8>>,
    pub comment_hash: Option<Vec<u8>>,
    pub listening_volume_adjustments: HashMap<u32, f32>,
    pub plugin_context: Vec<u8>,
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
            listening_channels: proto.listening_channels.clone(),
            texture_hash: None,
            comment_hash: None,
            listening_volume_adjustments: HashMap::new(),
            plugin_context: Vec::new(),
        }
    }
}

impl From<&RemoteSessionProto> for RemoteUser {
    fn from(proto: &RemoteSessionProto) -> Self {
        let lva: HashMap<u32, f32> = proto.listening_volume_adjustments
            .iter()
            .map(|a| (a.channel_id, a.volume_adjustment))
            .collect();
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
            listening_channels: proto.listening_channels.clone(),
            texture_hash: proto.texture_hash.clone(),
            comment_hash: proto.comment_hash.clone(),
            listening_volume_adjustments: lva,
            plugin_context: proto.plugin_context.clone().unwrap_or_default(),
        }
    }
}

/// Type alias for clarity: when used as a peer-synced session.
pub type RemoteSession = RemoteUser;

/// Synchronization state of a peer's session cache.
#[derive(Debug, Clone, PartialEq)]
pub enum PeerSyncState {
    /// Full snapshot sync in progress (or not yet started).
    Syncing,
    /// Full snapshot received; incremental deltas are being applied normally.
    Ready,
}

/// Per-peer Edge session cache, maintained by Edge-to-Edge session sync.
#[derive(Debug)]
pub struct PeerSessionCache {
    pub edge_id: u32,
    /// Next expected delta sequence number from this peer.
    pub expected_seq: u64,
    /// Current session snapshot for this peer.
    pub sessions: HashMap<u32, RemoteUser>,
    /// Out-of-order delta buffer (seq → delta).
    pub reorder_buf: BTreeMap<u64, EdgeSessionDelta>,
    /// When the current gap started (for triggering re-sync after timeout).
    pub gap_since: Option<Instant>,
    /// Whether this cache is fully synced and receiving deltas normally.
    pub sync_state: PeerSyncState,
}

impl PeerSessionCache {
    pub fn new(edge_id: u32) -> Self {
        Self {
            edge_id,
            expected_seq: 0,
            sessions: HashMap::new(),
            reorder_buf: BTreeMap::new(),
            gap_since: None,
            sync_state: PeerSyncState::Syncing,
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
    /// Per-peer session caches, populated by Edge-to-Edge session sync.
    pub peer_caches: RwLock<HashMap<u32, PeerSessionCache>>,
}

impl ChannelManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            channels: RwLock::new(HashMap::new()),
            channel_children: RwLock::new(HashMap::new()),
            remote_users: RwLock::new(HashMap::new()),
            channel_to_sessions: RwLock::new(HashMap::new()),
            peer_caches: RwLock::new(HashMap::new()),
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
            for &ch in &user.listening_channels {
                index.entry(ch).or_default().insert(user.session_id);
            }
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
        let new_listening = user.listening_channels.clone();
        let mut users = self.remote_users.write().await;
        let mut index = self.channel_to_sessions.write().await;
        // Remove from the old channel bucket if the user already existed and moved.
        if let Some(old) = users.get(&sid) {
            if old.channel_id != new_channel {
                if let Some(set) = index.get_mut(&old.channel_id) {
                    set.remove(&sid);
                }
            }
            // Remove from listening channel buckets that are no longer active.
            for &ch in &old.listening_channels {
                if !new_listening.contains(&ch) {
                    if let Some(set) = index.get_mut(&ch) {
                        set.remove(&sid);
                    }
                }
            }
        }
        index.entry(new_channel).or_default().insert(sid);
        // Add new listening channel entries.
        for &ch in &new_listening {
            index.entry(ch).or_default().insert(sid);
        }
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
            for &ch in &user.listening_channels {
                if let Some(set) = index.get_mut(&ch) {
                    set.remove(&session_id);
                }
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
    ///
    /// Lock ordering: snapshot session IDs under `channel_to_sessions` first, then release that
    /// lock before acquiring `remote_users`.  This prevents a deadlock with `upsert_remote_user`
    /// and `remove_remote_user`, which lock `remote_users` first then `channel_to_sessions`.
    pub async fn get_remote_users_in_channels(&self, channel_ids: &std::collections::HashSet<u32>) -> Vec<RemoteUser> {
        // Step 1: collect session IDs under the index lock, then release it.
        let mut session_ids = std::collections::HashSet::new();
        {
            let index = self.channel_to_sessions.read().await;
            for &ch_id in channel_ids {
                if let Some(sessions) = index.get(&ch_id) {
                    for &sid in sessions {
                        session_ids.insert(sid);
                    }
                }
            }
        } // index lock released here

        // Step 2: resolve session IDs to full user objects under the remote_users lock.
        let users = self.remote_users.read().await;
        let mut result = Vec::new();
        for sid in session_ids {
            if let Some(user) = users.get(&sid) {
                result.push(user.clone());
            }
        }
        result
    }

    /// Get a snapshot of the children map.
    pub async fn get_all_children_map(&self) -> std::collections::HashMap<u32, Vec<u32>> {
        self.channel_children.read().await.clone()
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Edge-to-Edge Session Mesh methods
    // ──────────────────────────────────────────────────────────────────────────

    /// Apply a full session snapshot received from a peer Edge during initial sync.
    /// Replaces the existing peer cache for `peer_id` and merges into `remote_users`.
    /// `seq_fence` is the seq number the snapshot was taken at; the caller must drain
    /// any buffered deltas with seq > seq_fence after calling this method.
    pub async fn apply_peer_snapshot(
        &self,
        peer_id: u32,
        seq_fence: u64,
        sessions: &[RemoteSessionProto],
    ) {
        // Build new per-peer session map.
        let new_sessions: HashMap<u32, RemoteUser> = sessions
            .iter()
            .map(|p| (p.session_id, RemoteUser::from(p)))
            .collect();

        // Update peer cache.
        {
            let mut caches = self.peer_caches.write().await;
            let cache = caches.entry(peer_id).or_insert_with(|| PeerSessionCache::new(peer_id));
            // Remove old sessions for this peer from global remote_users / index.
            let old_sessions = cache.sessions.keys().cloned().collect::<Vec<_>>();
            {
                let mut users = self.remote_users.write().await;
                let mut index = self.channel_to_sessions.write().await;
                for sid in old_sessions {
                    if let Some(old) = users.remove(&sid) {
                        Self::remove_from_index_inner(&mut index, &old);
                    }
                }
                // Insert new sessions into global maps.
                for user in new_sessions.values() {
                    Self::insert_into_index_inner(&mut index, user);
                    users.insert(user.session_id, user.clone());
                }
            }
            // Update cache.
            cache.sessions = new_sessions;
            cache.expected_seq = seq_fence + 1;
            cache.sync_state = PeerSyncState::Ready;
            cache.gap_since = None;
        }

        info!(peer_id, seq_fence, sessions_count = sessions.len(), "Applied peer session snapshot");
    }

    /// Apply an incremental session delta from a peer Edge.
    /// Returns `true` if the delta was applied, `false` if it was buffered (out-of-order).
    ///
    /// Caller must check `gap_since` after calling to detect stale gaps.
    pub async fn apply_peer_delta(&self, peer_id: u32, delta: EdgeSessionDelta) -> bool {
        let mut caches = self.peer_caches.write().await;
        let cache = caches.entry(peer_id).or_insert_with(|| PeerSessionCache::new(peer_id));

        // If still syncing, buffer all deltas.
        if cache.sync_state == PeerSyncState::Syncing {
            cache.reorder_buf.insert(delta.seq, delta);
            return false;
        }

        // Out of order: buffer and note gap start.
        if delta.seq != cache.expected_seq {
            if delta.seq > cache.expected_seq {
                debug!(peer_id, expected = cache.expected_seq, got = delta.seq, "Out-of-order delta — buffering");
                if cache.gap_since.is_none() {
                    cache.gap_since = Some(Instant::now());
                }
                cache.reorder_buf.insert(delta.seq, delta);
            }
            // delta.seq < expected → duplicate, discard
            return false;
        }

        // In order: apply this delta and any consecutive buffered ones.
        {
            let mut users = self.remote_users.write().await;
            let mut index = self.channel_to_sessions.write().await;
            Self::apply_delta_inner(cache, &mut users, &mut index, delta);
            // Drain consecutive buffered deltas.
            loop {
                let next_seq = cache.expected_seq;
                if let Some(buffered) = cache.reorder_buf.remove(&next_seq) {
                    Self::apply_delta_inner(cache, &mut users, &mut index, buffered);
                } else {
                    break;
                }
            }
        }

        cache.gap_since = None;
        true
    }

    /// Inner: apply a single delta to the per-peer cache and global maps.
    /// Must be called while holding write locks on `users` and `index`.
    fn apply_delta_inner(
        cache: &mut PeerSessionCache,
        users: &mut HashMap<u32, RemoteUser>,
        index: &mut HashMap<u32, std::collections::HashSet<u32>>,
        delta: EdgeSessionDelta,
    ) {
        cache.expected_seq = delta.seq + 1;
        if let Some(proto) = delta.user_joined {
            let user = RemoteUser::from(&proto);
            Self::insert_into_index_inner(index, &user);
            cache.sessions.insert(user.session_id, user.clone());
            users.insert(user.session_id, user);
        } else if let Some(left) = delta.user_left {
            if let Some(old) = cache.sessions.remove(&left.session_id) {
                Self::remove_from_index_inner(index, &old);
                users.remove(&old.session_id);
            }
        } else if let Some(proto) = delta.user_state {
            let user = RemoteUser::from(&proto);
            if let Some(old) = cache.sessions.get(&user.session_id) {
                Self::remove_from_index_inner(index, old);
            }
            Self::insert_into_index_inner(index, &user);
            cache.sessions.insert(user.session_id, user.clone());
            users.insert(user.session_id, user);
        } else if let Some(moved) = delta.user_moved {
            if let Some(old) = cache.sessions.get_mut(&moved.session_id) {
                Self::remove_from_index_inner(index, old);
                old.channel_id = moved.channel_id;
                Self::insert_into_index_inner(index, old);
                if let Some(u) = users.get_mut(&moved.session_id) {
                    u.channel_id = moved.channel_id;
                }
            }
        }
    }

    /// Remove all sessions from a peer that left/disconnected.
    pub async fn remove_peer_sessions(&self, peer_id: u32) {
        let mut caches = self.peer_caches.write().await;
        if let Some(cache) = caches.remove(&peer_id) {
            let mut users = self.remote_users.write().await;
            let mut index = self.channel_to_sessions.write().await;
            for (sid, user) in &cache.sessions {
                Self::remove_from_index_inner(&mut index, user);
                users.remove(sid);
            }
            info!(peer_id, removed = cache.sessions.len(), "Removed peer sessions");
        }
    }

    /// Set the sync state of a peer's cache.
    pub async fn set_peer_sync_state(&self, peer_id: u32, state: PeerSyncState) {
        let mut caches = self.peer_caches.write().await;
        let cache = caches.entry(peer_id).or_insert_with(|| PeerSessionCache::new(peer_id));
        cache.sync_state = state;
    }

    /// Check whether a peer's gap timer has exceeded the threshold.
    /// Returns `true` if re-sync should be triggered.
    pub async fn is_peer_gap_expired(&self, peer_id: u32, timeout: std::time::Duration) -> bool {
        let caches = self.peer_caches.read().await;
        caches.get(&peer_id)
            .and_then(|c| c.gap_since)
            .map(|t| t.elapsed() >= timeout)
            .unwrap_or(false)
    }

    /// Index helper: add a user's entries to the reverse channel-to-sessions index.
    fn insert_into_index_inner(
        index: &mut HashMap<u32, std::collections::HashSet<u32>>,
        user: &RemoteUser,
    ) {
        index.entry(user.channel_id).or_default().insert(user.session_id);
        for &ch in &user.listening_channels {
            index.entry(ch).or_default().insert(user.session_id);
        }
    }

    /// Index helper: remove a user's entries from the reverse channel-to-sessions index.
    fn remove_from_index_inner(
        index: &mut HashMap<u32, std::collections::HashSet<u32>>,
        user: &RemoteUser,
    ) {
        if let Some(set) = index.get_mut(&user.channel_id) {
            set.remove(&user.session_id);
        }
        for &ch in &user.listening_channels {
            if let Some(set) = index.get_mut(&ch) {
                set.remove(&user.session_id);
            }
        }
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
                listening_channels: vec![],
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
