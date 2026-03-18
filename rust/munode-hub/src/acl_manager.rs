use std::collections::HashMap;
use std::sync::Arc;

use tracing::debug;

use crate::channel_store::ChannelStore;
use crate::database::Database;

/// Permission bit flags — defined in `munode_common::permission` and
/// re-exported here so that callers using `acl_manager::permission::*`
/// continue to work without changes.
pub use munode_common::permission;

/// An ACL entry loaded from the database.
#[derive(Debug, Clone)]
pub struct AclEntry {
    pub channel_id: u32,
    pub user_id: Option<i32>,
    pub group_name: Option<String>,
    pub apply_here: bool,
    pub apply_subs: bool,
    pub allow: u32,
    pub deny: u32,
}

/// Maximum number of entries in the ACL permission cache.
///
/// With 2000 users × 500 channels = 1 million potential entries, an unbounded
/// cache is a memory leak.  When this limit is exceeded we clear the whole cache
/// (simple eviction — adequate protection without a full LRU implementation).
const ACL_CACHE_MAX_SIZE: usize = 100_000;

/// ACL Manager responsible for computing effective permissions.
pub struct AclManager {
    db: Arc<Database>,
    channel_store: Arc<ChannelStore>,
    /// Permission cache: (user_id, channel_id) → effective permission bits.
    cache: tokio::sync::RwLock<HashMap<(i32, u32), u32>>,
}

impl AclManager {
    pub fn new(db: Arc<Database>, channel_store: Arc<ChannelStore>) -> Self {
        Self {
            db,
            channel_store,
            cache: tokio::sync::RwLock::new(HashMap::new()),
        }
    }

    /// Calculate effective permissions for a user on a channel.
    ///
    /// `user_id`: The user's ID (-1 for guest/unregistered).
    /// `channel_id`: The target channel.
    /// `groups`: The user's group memberships (from auth).
    pub async fn calculate_permissions(
        &self,
        user_id: i32,
        channel_id: u32,
        groups: &[String],
    ) -> u32 {
        // Check cache
        {
            let cache = self.cache.read().await;
            if let Some(&cached) = cache.get(&(user_id, channel_id)) {
                return cached;
            }
        }

        // SuperUser check: admin/superuser group gets all permissions
        if groups.iter().any(|g| g == "admin" || g == "superuser") {
            let result = permission::ALL;
            self.cache.write().await.insert((user_id, channel_id), result);
            return result;
        }

        // Build the channel chain from root to the target channel
        let chain = self.build_channel_chain(channel_id).await;

        // Walk the chain, accumulating permissions
        let mut granted = permission::DEFAULT;

        for &chain_channel_id in &chain {
            // Check if this channel inherits ACLs from parent
            let inherit_acl = self.channel_store.get_channel(chain_channel_id).await
                .map(|c| c.inherit_acl)
                .unwrap_or(true);

            if !inherit_acl && chain_channel_id != 0 {
                // Reset to defaults when inheritance is broken
                granted = permission::DEFAULT;
            }

            // Load ACLs for this channel
            let acls = match self.db.load_acls(chain_channel_id) {
                Ok(acls) => acls,
                Err(_) => continue,
            };

            for acl in &acls {
                // Check scope: apply_here for current channel, apply_subs for ancestors
                let is_target = chain_channel_id == channel_id;
                if is_target && !acl.apply_here {
                    continue;
                }
                if !is_target && !acl.apply_subs {
                    continue;
                }

                // Check if this ACL entry matches the user
                if !self.acl_matches_user(acl, user_id, groups) {
                    continue;
                }

                // Apply allow/deny
                granted |= acl.allow;
                granted &= !acl.deny;
            }
        }

        // Traverse gate: if user has neither Traverse nor Write, no access
        if granted & (permission::TRAVERSE | permission::WRITE) == 0 {
            granted = permission::NONE;
        }

        // Write implies all permissions except Speak and Whisper
        if granted & permission::WRITE != 0 {
            granted |= permission::ALL & !(permission::SPEAK | permission::WHISPER);
        }

        debug!(
            "Permissions for user {} on channel {}: 0x{:X}",
            user_id, channel_id, granted
        );

        // Cache result (with size guard to prevent unbounded growth)
        let mut cache = self.cache.write().await;
        if cache.len() > ACL_CACHE_MAX_SIZE {
            cache.clear();
            tracing::debug!("ACL cache cleared (exceeded {} entries)", ACL_CACHE_MAX_SIZE);
        }
        cache.insert((user_id, channel_id), granted);

        granted
    }

    /// Check if a user has a specific permission on a channel.
    pub async fn has_permission(
        &self,
        user_id: i32,
        channel_id: u32,
        groups: &[String],
        perm: u32,
    ) -> bool {
        let effective = self.calculate_permissions(user_id, channel_id, groups).await;
        // Write implications are already expanded in calculate_permissions
        (effective & perm) != 0
    }

    /// Get all ACL entries for a channel (including inherited).
    pub fn get_channel_acls(&self, channel_id: u32) -> Vec<AclEntry> {
        self.db.load_acls(channel_id).unwrap_or_default()
    }

    /// Save ACL entries for a channel (replaces all existing).
    pub async fn save_acls(&self, channel_id: u32, entries: &[AclEntry]) -> anyhow::Result<()> {
        self.db.save_acls(channel_id, entries)?;
        self.invalidate_channel(channel_id).await;
        Ok(())
    }

    /// Invalidate cache entries for a specific channel and its descendants.
    ///
    /// When ACLs are updated for a channel, all cached permission results for
    /// that channel (and any child channels that inherit from it) are stale.
    /// This removes only the affected entries rather than clearing the whole cache.
    pub async fn invalidate_channel(&self, channel_id: u32) {
        // Collect descendant channel IDs (including the channel itself).
        let mut affected: std::collections::HashSet<u32> = std::collections::HashSet::new();
        affected.insert(channel_id);

        // Walk all channels to find descendants.
        let all_channels = self.channel_store.get_all_channels().await;
        // Iteratively expand until no new descendants are added.
        let mut changed = true;
        while changed {
            changed = false;
            for ch in &all_channels {
                if let Some(parent) = ch.parent_id {
                    if affected.contains(&parent) && affected.insert(ch.id) {
                        changed = true;
                    }
                }
            }
        }

        // Remove only cache entries whose channel_id is in the affected set.
        self.cache
            .write()
            .await
            .retain(|(_uid, cid), _| !affected.contains(cid));
    }

    /// Build the channel chain from root (channel 0) to the target channel.
    /// Returns [root, ..., parent, target].
    async fn build_channel_chain(&self, channel_id: u32) -> Vec<u32> {
        let mut chain = Vec::new();
        let mut current = channel_id;

        loop {
            chain.push(current);
            if current == 0 {
                break;
            }
            match self.channel_store.get_channel(current).await {
                Some(ch) => {
                    if let Some(parent) = ch.parent_id {
                        current = parent;
                    } else {
                        break;
                    }
                }
                None => break,
            }
        }

        chain.reverse(); // Root first
        chain
    }

    /// Check if an ACL entry applies to a specific user.
    fn acl_matches_user(&self, acl: &AclEntry, user_id: i32, groups: &[String]) -> bool {
        // Match by user_id
        if let Some(acl_user_id) = acl.user_id {
            if acl_user_id > 0 && acl_user_id == user_id {
                return true;
            }
        }

        // Match by group
        if let Some(group) = &acl.group_name {
            match group.as_str() {
                "@all" | "all" => return true,
                "@auth" | "auth" => return user_id > 0,
                _ => return groups.iter().any(|g| g == group),
            }
        }

        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel_store::ChannelRecord;
    use std::collections::HashSet;

    async fn setup() -> (Arc<Database>, Arc<ChannelStore>) {
        let db = Arc::new(Database::open(":memory:").unwrap());
        let channel_store = Arc::new(ChannelStore::new());

        // Add root channel
        channel_store.create_channel(ChannelRecord {
            id: 0,
            parent_id: None,
            name: "Root".to_string(),
            description: String::new(),
            position: 0,
            max_users: 0,
            temporary: false,
            inherit_acl: true,
            links: HashSet::new(),
        }).await;

        // Add child channel
        channel_store.create_channel(ChannelRecord {
            id: 1,
            parent_id: Some(0),
            name: "General".to_string(),
            description: String::new(),
            position: 0,
            max_users: 50,
            temporary: false,
            inherit_acl: true,
            links: HashSet::new(),
        }).await;

        // Add grandchild channel
        channel_store.create_channel(ChannelRecord {
            id: 2,
            parent_id: Some(1),
            name: "SubGeneral".to_string(),
            description: String::new(),
            position: 0,
            max_users: 0,
            temporary: false,
            inherit_acl: true,
            links: HashSet::new(),
        }).await;

        (db, channel_store)
    }

    #[tokio::test]
    async fn test_default_permissions() {
        let (db, cs) = setup().await;
        let mgr = AclManager::new(db, cs);

        // Guest user should get default permissions
        let perms = mgr.calculate_permissions(-1, 0, &[]).await;
        assert_eq!(perms, permission::DEFAULT);
    }

    #[tokio::test]
    async fn test_admin_gets_all() {
        let (db, cs) = setup().await;
        let mgr = AclManager::new(db, cs);

        let perms = mgr
            .calculate_permissions(1, 0, &["admin".to_string()])
            .await;
        assert_eq!(perms, permission::ALL);
    }

    #[tokio::test]
    async fn test_acl_deny_speak() {
        let (db, cs) = setup().await;

        // Add ACL denying Speak on channel 1 for @all
        db.save_acls(
            1,
            &[AclEntry {
                channel_id: 1,
                user_id: None,
                group_name: Some("@all".to_string()),
                apply_here: true,
                apply_subs: true,
                allow: 0,
                deny: permission::SPEAK,
            }],
        )
        .unwrap();

        let mgr = AclManager::new(db, cs);
        let perms = mgr.calculate_permissions(-1, 1, &[]).await;
        assert_eq!(perms & permission::SPEAK, 0);
        // Other permissions should still be present
        assert_ne!(perms & permission::ENTER, 0);
    }

    #[tokio::test]
    async fn test_acl_inheritance() {
        let (db, cs) = setup().await;

        // Deny TextMessage on channel 1 for @all, apply_subs=true
        db.save_acls(
            1,
            &[AclEntry {
                channel_id: 1,
                user_id: None,
                group_name: Some("@all".to_string()),
                apply_here: true,
                apply_subs: true,
                allow: 0,
                deny: permission::TEXT_MESSAGE,
            }],
        )
        .unwrap();

        let mgr = AclManager::new(db, cs);

        // Channel 2 (child of 1) should inherit the deny
        let perms = mgr.calculate_permissions(-1, 2, &[]).await;
        assert_eq!(perms & permission::TEXT_MESSAGE, 0);
    }

    #[tokio::test]
    async fn test_acl_no_inherit() {
        let (db, cs) = setup().await;

        // Set channel 2 to NOT inherit ACLs
        cs.update_channel(ChannelRecord {
            id: 2,
            parent_id: Some(1),
            name: "SubGeneral".to_string(),
            description: String::new(),
            position: 0,
            max_users: 0,
            temporary: false,
            inherit_acl: false,
            links: HashSet::new(),
        }).await;

        // Deny SPEAK on channel 1
        db.save_acls(
            1,
            &[AclEntry {
                channel_id: 1,
                user_id: None,
                group_name: Some("@all".to_string()),
                apply_here: true,
                apply_subs: true,
                allow: 0,
                deny: permission::SPEAK,
            }],
        )
        .unwrap();

        let mgr = AclManager::new(db, cs);

        // Channel 2 should NOT inherit the deny (inherit_acl=false resets)
        let perms = mgr.calculate_permissions(-1, 2, &[]).await;
        assert_ne!(perms & permission::SPEAK, 0);
    }

    #[tokio::test]
    async fn test_specific_user_acl() {
        let (db, cs) = setup().await;

        // Grant MakeChannel to user 5 on channel 0
        db.save_acls(
            0,
            &[AclEntry {
                channel_id: 0,
                user_id: Some(5),
                group_name: None,
                apply_here: true,
                apply_subs: false,
                allow: permission::MAKE_CHANNEL,
                deny: 0,
            }],
        )
        .unwrap();

        let mgr = AclManager::new(db, cs);

        // User 5 should have MakeChannel
        let perms = mgr.calculate_permissions(5, 0, &[]).await;
        assert_ne!(perms & permission::MAKE_CHANNEL, 0);

        // User 10 should NOT have MakeChannel
        let perms = mgr.calculate_permissions(10, 0, &[]).await;
        assert_eq!(perms & permission::MAKE_CHANNEL, 0);
    }

    #[tokio::test]
    async fn test_auth_group() {
        let (db, cs) = setup().await;

        // Grant Register to @auth on channel 0
        db.save_acls(
            0,
            &[AclEntry {
                channel_id: 0,
                user_id: None,
                group_name: Some("@auth".to_string()),
                apply_here: true,
                apply_subs: false,
                allow: permission::REGISTER,
                deny: 0,
            }],
        )
        .unwrap();

        let mgr = AclManager::new(db, cs);

        // Authenticated user (id=5) should have Register
        let perms = mgr.calculate_permissions(5, 0, &[]).await;
        assert_ne!(perms & permission::REGISTER, 0);

        // Guest (id=-1) should NOT have Register
        let perms = mgr.calculate_permissions(-1, 0, &[]).await;
        assert_eq!(perms & permission::REGISTER, 0);
    }

    #[tokio::test]
    async fn test_write_implies_most() {
        let (db, cs) = setup().await;

        // Grant Write to user 1 on root
        db.save_acls(
            0,
            &[AclEntry {
                channel_id: 0,
                user_id: Some(1),
                group_name: None,
                apply_here: true,
                apply_subs: true,
                allow: permission::WRITE,
                deny: 0,
            }],
        )
        .unwrap();

        let mgr = AclManager::new(db, cs);
        let perms = mgr.calculate_permissions(1, 0, &[]).await;

        // Write should imply most permissions
        assert_ne!(perms & permission::ENTER, 0);
        assert_ne!(perms & permission::TRAVERSE, 0);
        assert_ne!(perms & permission::MOVE, 0);
        assert_ne!(perms & permission::KICK, 0);
    }

    #[tokio::test]
    async fn test_has_permission() {
        let (db, cs) = setup().await;
        let mgr = AclManager::new(db, cs);

        assert!(
            mgr.has_permission(-1, 0, &[], permission::ENTER).await
        );
        assert!(
            !mgr.has_permission(-1, 0, &[], permission::KICK).await
        );
    }

    #[tokio::test]
    async fn test_cache_invalidation() {
        let (db, cs) = setup().await;
        let mgr = AclManager::new(db.clone(), cs.clone());

        // Calculate and cache
        let p1 = mgr.calculate_permissions(-1, 0, &[]).await;
        assert_ne!(p1 & permission::SPEAK, 0);

        // Add deny ACL
        db.save_acls(
            0,
            &[AclEntry {
                channel_id: 0,
                user_id: None,
                group_name: Some("@all".to_string()),
                apply_here: true,
                apply_subs: false,
                allow: 0,
                deny: permission::SPEAK,
            }],
        )
        .unwrap();

        // Before invalidation, cache still has old value
        let cached = mgr.calculate_permissions(-1, 0, &[]).await;
        assert_ne!(cached & permission::SPEAK, 0); // Still cached

        // After invalidation
        mgr.invalidate_channel(0).await;
        let p2 = mgr.calculate_permissions(-1, 0, &[]).await;
        assert_eq!(p2 & permission::SPEAK, 0); // Now sees the deny
    }
}
