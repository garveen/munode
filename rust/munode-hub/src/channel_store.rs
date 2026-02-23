use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::Result;
use tokio::sync::RwLock;
use tracing::info;

use crate::database::Database;

/// In-memory representation of a channel.
#[derive(Debug, Clone)]
pub struct ChannelRecord {
    pub id: u32,
    pub name: String,
    pub parent_id: Option<u32>,
    pub description: String,
    pub position: i32,
    pub max_users: u32,
    pub temporary: bool,
    pub inherit_acl: bool,
    pub links: HashSet<u32>,
}

/// Thread-safe channel tree store.
pub struct ChannelStore {
    channels: RwLock<HashMap<u32, ChannelRecord>>,
    next_id: AtomicU32,
}

impl ChannelStore {
    pub fn new() -> Self {
        Self {
            channels: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }

    /// Load channels and links from the database into memory.
    pub async fn load_from_db(&self, db: &Database) -> Result<()> {
        let db_channels = db.load_channels()?;
        let db_links = db.load_channel_links()?;

        let mut channels = self.channels.write().await;
        channels.clear();

        let mut max_id: u32 = 0;
        for ch in &db_channels {
            if ch.id > max_id {
                max_id = ch.id;
            }
            channels.insert(ch.id, ChannelRecord {
                id: ch.id,
                name: ch.name.clone(),
                parent_id: ch.parent_id,
                description: ch.description.clone(),
                position: ch.position,
                max_users: ch.max_users,
                temporary: ch.temporary,
                inherit_acl: ch.inherit_acl,
                links: HashSet::new(),
            });
        }

        // Apply links
        for (ch_id, target_id) in &db_links {
            if let Some(ch) = channels.get_mut(ch_id) {
                ch.links.insert(*target_id);
            }
            if let Some(ch) = channels.get_mut(target_id) {
                ch.links.insert(*ch_id);
            }
        }

        self.next_id.store(max_id + 1, Ordering::Relaxed);
        info!("Loaded {} channels from database", channels.len());
        Ok(())
    }

    /// Get a clone of a channel by ID.
    pub async fn get_channel(&self, id: u32) -> Option<ChannelRecord> {
        self.channels.read().await.get(&id).cloned()
    }

    /// Get all channels.
    pub async fn get_all_channels(&self) -> Vec<ChannelRecord> {
        self.channels.read().await.values().cloned().collect()
    }

    /// Get all channels in BFS order starting from the root (id=0).
    pub async fn get_channels_bfs(&self) -> Vec<ChannelRecord> {
        let channels = self.channels.read().await;
        let mut result = Vec::new();
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();

        // Start from root
        if channels.contains_key(&0) {
            queue.push_back(0u32);
            visited.insert(0u32);
        }

        while let Some(id) = queue.pop_front() {
            if let Some(ch) = channels.get(&id) {
                result.push(ch.clone());
                // Find children of this channel
                let mut children: Vec<&ChannelRecord> = channels
                    .values()
                    .filter(|c| c.parent_id == Some(id) && !visited.contains(&c.id))
                    .collect();
                children.sort_by_key(|c| (c.position, c.id));
                for child in children {
                    visited.insert(child.id);
                    queue.push_back(child.id);
                }
            }
        }

        result
    }

    /// Get links for a specific channel.
    pub async fn get_channel_links(&self, channel_id: u32) -> Vec<u32> {
        self.channels
            .read()
            .await
            .get(&channel_id)
            .map(|ch| ch.links.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Create a new channel and return its ID.
    /// If `auto_id` is true and `ch.id == 0`, a new ID is auto-assigned.
    pub async fn create_channel(&self, ch: ChannelRecord) -> u32 {
        let id = ch.id;
        self.channels.write().await.insert(id, ch);
        id
    }

    /// Create a new channel with an auto-assigned ID. Returns the new ID.
    pub async fn create_channel_auto_id(&self, mut ch: ChannelRecord) -> u32 {
        ch.id = self.next_channel_id();
        let id = ch.id;
        self.channels.write().await.insert(id, ch);
        id
    }

    /// Update an existing channel. Returns true if the channel existed.
    pub async fn update_channel(&self, ch: ChannelRecord) -> bool {
        let mut channels = self.channels.write().await;
        if channels.contains_key(&ch.id) {
            channels.insert(ch.id, ch);
            true
        } else {
            false
        }
    }

    /// Remove a channel by ID. Returns the removed channel if it existed.
    pub async fn remove_channel(&self, id: u32) -> Option<ChannelRecord> {
        let mut channels = self.channels.write().await;
        let removed = channels.remove(&id);

        // Clean up links referencing this channel
        if removed.is_some() {
            for ch in channels.values_mut() {
                ch.links.remove(&id);
            }
        }

        removed
    }

    /// Allocate the next channel ID.
    pub fn next_channel_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn make_channel(id: u32, parent_id: Option<u32>, name: &str, pos: i32) -> ChannelRecord {
        ChannelRecord {
            id,
            name: name.to_string(),
            parent_id,
            description: String::new(),
            position: pos,
            max_users: 100,
            temporary: false,
            inherit_acl: true,
            links: HashSet::new(),
        }
    }

    #[tokio::test]
    async fn test_create_and_get_channel() {
        let store = ChannelStore::new();
        let ch = make_channel(0, None, "Root", 0);
        store.create_channel(ch).await;

        let result = store.get_channel(0).await;
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "Root");
    }

    #[tokio::test]
    async fn test_update_channel() {
        let store = ChannelStore::new();
        store.create_channel(make_channel(1, Some(0), "Test", 0)).await;

        let mut ch = store.get_channel(1).await.unwrap();
        ch.name = "Updated".to_string();
        assert!(store.update_channel(ch).await);

        let result = store.get_channel(1).await.unwrap();
        assert_eq!(result.name, "Updated");
    }

    #[tokio::test]
    async fn test_remove_channel_cleans_links() {
        let store = ChannelStore::new();
        let mut ch1 = make_channel(1, Some(0), "A", 0);
        ch1.links.insert(2);
        let mut ch2 = make_channel(2, Some(0), "B", 1);
        ch2.links.insert(1);

        store.create_channel(ch1).await;
        store.create_channel(ch2).await;

        store.remove_channel(2).await;

        let ch1 = store.get_channel(1).await.unwrap();
        assert!(!ch1.links.contains(&2));
    }

    #[tokio::test]
    async fn test_bfs_order() {
        let store = ChannelStore::new();
        store.create_channel(make_channel(0, None, "Root", 0)).await;
        store.create_channel(make_channel(1, Some(0), "A", 0)).await;
        store.create_channel(make_channel(2, Some(0), "B", 1)).await;
        store.create_channel(make_channel(3, Some(1), "A-sub", 0)).await;

        let bfs = store.get_channels_bfs().await;
        assert_eq!(bfs.len(), 4);
        assert_eq!(bfs[0].id, 0);
        assert_eq!(bfs[1].id, 1);
        assert_eq!(bfs[2].id, 2);
        assert_eq!(bfs[3].id, 3);
    }

    #[tokio::test]
    async fn test_next_channel_id() {
        let store = ChannelStore::new();
        let id1 = store.next_channel_id();
        let id2 = store.next_channel_id();
        assert_ne!(id1, id2);
    }
}
