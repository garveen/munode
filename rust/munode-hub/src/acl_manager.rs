use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::RwLock;
use tracing::debug;

use crate::channel_store::ChannelStore;
use crate::database::{ChannelGroupRecord, Database};

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

/// In-memory channel group — the authoritative source of truth for group
/// membership inside the Hub process.  All reads come from here; DB is only
/// touched on writes (write-through).
#[derive(Debug, Clone)]
pub struct ChannelGroup {
    /// DB row id — used internally when persisting member lists.
    pub id: i64,
    pub name: String,
    pub inherit: bool,
    pub inheritable: bool,
    /// User IDs explicitly added to this group.
    pub add: Vec<u32>,
    /// User IDs explicitly removed from (excluded from) this group.
    pub remove: Vec<u32>,
}

/// Maximum number of entries in the ACL permission cache.
///
/// With 2000 users × 500 channels = 1 million potential entries, an unbounded
/// cache is a memory leak.  When this limit is exceeded we perform a partial
/// eviction: guest/anonymous entries are removed first (they are likely stale
/// because each anonymous session gets a different negative user_id), then
/// remaining entries are trimmed to [`ACL_CACHE_EVICT_TARGET`].
const ACL_CACHE_MAX_SIZE: usize = 100_000;

/// Target entry count after partial eviction (75 % of max).
///
/// Retaining most of the registered-user entries avoids a sudden cold-cache
/// performance spike after every eviction cycle.
const ACL_CACHE_EVICT_TARGET: usize = ACL_CACHE_MAX_SIZE * 3 / 4;

/// ACL and channel-group manager.
///
/// Maintains the in-memory authoritative source of truth for both ACL entries
/// and channel groups (with embedded member lists).  The database is used
/// only for persistence (write-through on mutations, bulk load on startup).
/// All reads — permission checks, batch permission queries, ACL dialog data —
/// are served from the in-memory store with zero DB round-trips.
pub struct AclManager {
    db: Arc<Database>,
    channel_store: Arc<ChannelStore>,
    /// Computed-permission cache: (user_id, channel_id) → effective permission bits.
    cache: tokio::sync::RwLock<HashMap<(i32, u32), u32>>,
    /// ACL entries: channel_id → Vec<AclEntry>  (authoritative source of truth).
    acl_entries: RwLock<HashMap<u32, Vec<AclEntry>>>,
    /// Channel groups with embedded member lists: channel_id → Vec<ChannelGroup>.
    channel_groups: RwLock<HashMap<u32, Vec<ChannelGroup>>>,
}

impl AclManager {
    pub fn new(db: Arc<Database>, channel_store: Arc<ChannelStore>) -> Self {
        Self {
            db,
            channel_store,
            cache: tokio::sync::RwLock::new(HashMap::new()),
            acl_entries: RwLock::new(HashMap::new()),
            channel_groups: RwLock::new(HashMap::new()),
        }
    }

    /// Populate the in-memory store from the database.
    ///
    /// Must be called once during Hub startup after the DB is opened.  All
    /// subsequent reads are served from memory; writes go through
    /// [`save_acls`] / [`save_channel_groups`] which update both memory and DB.
    pub async fn load_all(&self) -> Result<()> {
        // --- ACL entries --- (DB call in spawn_blocking)
        let db = self.db.clone();
        let all_acls = tokio::task::spawn_blocking(move || db.load_all_acls())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))??;
        let mut acl_map: HashMap<u32, Vec<AclEntry>> = HashMap::new();
        for entry in all_acls {
            acl_map.entry(entry.channel_id).or_default().push(entry);
        }
        *self.acl_entries.write().await = acl_map;

        // --- Channel groups + member lists ---
        let db = self.db.clone();
        let (all_groups, members_map) = tokio::task::spawn_blocking(move || -> Result<_> {
            let all_groups: Vec<ChannelGroupRecord> = db.load_all_channel_groups()?;
            let group_ids: Vec<i64> = all_groups.iter().map(|g| g.id).collect();
            let members_map = db.get_channel_group_members_batch(&group_ids)?;
            Ok((all_groups, members_map))
        })
        .await
        .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))??;

        let mut groups_map: HashMap<u32, Vec<ChannelGroup>> = HashMap::new();
        for g in all_groups {
            let members = members_map.get(&g.id).cloned().unwrap_or_default();
            let add = members
                .iter()
                .filter(|(_, is_add)| *is_add)
                .map(|(uid, _)| *uid)
                .collect();
            let remove = members
                .iter()
                .filter(|(_, is_add)| !*is_add)
                .map(|(uid, _)| *uid)
                .collect();
            groups_map
                .entry(g.channel_id)
                .or_default()
                .push(ChannelGroup {
                    id: g.id,
                    name: g.name,
                    inherit: g.inherit,
                    inheritable: g.inheritable,
                    add,
                    remove,
                });
        }
        *self.channel_groups.write().await = groups_map;
        Ok(())
    }

    /// Calculate effective permissions for a user on a channel.
    ///
    /// `user_id`: The user's ID (-1 for guest/unregistered).
    /// `channel_id`: The target channel.
    /// `groups`: The user's group memberships (from auth).
    ///
    /// Channel-group memberships are resolved along the ancestor chain so that
    /// ACL entries referencing channel-group names work correctly regardless of
    /// whether the caller is on the `has_permission` path or the
    /// `handle_permission_query` path.
    pub async fn calculate_permissions(
        &self,
        user_id: i32,
        channel_id: u32,
        groups: &[String],
    ) -> u32 {
        // Check cache (skip for user_id=0: multiple sessions share id=0 but may
        // have different dynamic groups from Lua/HTTP auth, causing stale hits).
        if user_id != 0 {
            let cache = self.cache.read().await;
            if let Some(&cached) = cache.get(&(user_id, channel_id)) {
                return cached;
            }
        }

        // SuperUser check: admin/superuser group gets all permissions.
        // Only auth groups are checked here — channel groups cannot grant
        // superuser (matches Mumble/Murmur behaviour).
        if groups.iter().any(|g| g == "admin" || g == "superuser") {
            let result = permission::ALL;
            if user_id != 0 {
                self.cache_insert(user_id, channel_id, result).await;
            }
            return result;
        }

        // Build the channel chain from root to the target channel.
        // channel_store is fully in-memory; these async calls only acquire a
        // tokio RwLock with no blocking I/O.
        let chain = self.build_channel_chain(channel_id).await;

        // Snapshot inherit_acl flags (async, in-memory).
        let inherit_flags: Vec<bool> = {
            let mut flags = Vec::with_capacity(chain.len());
            for &cid in &chain {
                let inherit = self
                    .channel_store
                    .get_channel(cid)
                    .await
                    .map(|c| c.inherit_acl)
                    .unwrap_or(true);
                flags.push(inherit);
            }
            flags
        };

        // Resolve channel-group memberships along the ancestor chain.
        // This is the same logic used by handle_batch_permission_query in
        // rpc_handler/sync.rs.  Without it, ACL entries that reference a group
        // defined via ChannelGroup (rather than an auth-time group) are silently
        // ignored on the has_permission / calculate_permissions path.  Because
        // calculate_permissions_with_chain also reads from the shared cache
        // (keyed on (user_id, channel_id) only), a stale cache entry produced
        // by one path poisons the other — unifying the group resolution here
        // keeps both paths consistent.
        let mut effective_groups = groups.to_vec();
        if user_id > 0 {
            let channel_groups = self.channel_groups.read().await;
            let uid = user_id as u32;
            for &ancestor_id in &chain {
                if let Some(ancestor_groups) = channel_groups.get(&ancestor_id) {
                    for group in ancestor_groups {
                        if !group.inherit && ancestor_id != channel_id {
                            continue;
                        }
                        let is_added = group.add.contains(&uid);
                        let is_removed = group.remove.contains(&uid);
                        if is_added && !is_removed && !effective_groups.contains(&group.name) {
                            effective_groups.push(group.name.clone());
                        }
                    }
                }
            }
        }

        self.calculate_permissions_with_chain(
            user_id,
            channel_id,
            &effective_groups,
            &chain,
            &inherit_flags,
        )
        .await
    }

    /// Core permission calculation given a pre-built ancestor chain.
    ///
    /// Reads ACL entries directly from the in-memory store — no DB I/O,
    /// no `spawn_blocking`.  Used both by [`calculate_permissions`] (which
    /// builds the chain asynchronously) and by batch permission queries
    /// (which build all chains from a single channel-store snapshot).
    pub async fn calculate_permissions_with_chain(
        &self,
        user_id: i32,
        channel_id: u32,
        groups: &[String],
        chain: &[u32],
        inherit_flags: &[bool],
    ) -> u32 {
        // Cache check (skip for user_id=0: multiple sessions share id=0 but may
        // have different dynamic groups from Lua/HTTP auth, causing stale hits).
        if user_id != 0 {
            let cache = self.cache.read().await;
            if let Some(&cached) = cache.get(&(user_id, channel_id)) {
                return cached;
            }
        }
        // SuperUser fast path
        if groups.iter().any(|g| g == "admin" || g == "superuser") {
            let result = permission::ALL;
            if user_id != 0 {
                self.cache_insert(user_id, channel_id, result).await;
            }
            return result;
        }

        // Read ACLs from the in-memory store under a single short-lived async lock.
        let chain_acls: Vec<Vec<AclEntry>> = {
            let acl_map = self.acl_entries.read().await;
            chain
                .iter()
                .map(|&cid| acl_map.get(&cid).cloned().unwrap_or_default())
                .collect()
        };

        let mut granted = permission::DEFAULT;
        for (idx, &chain_channel_id) in chain.iter().enumerate() {
            let inherit_acl = inherit_flags.get(idx).copied().unwrap_or(true);
            let acls = &chain_acls[idx];
            if !inherit_acl && chain_channel_id != 0 {
                granted = permission::DEFAULT;
            }
            for acl in acls {
                let is_target = chain_channel_id == channel_id;
                if is_target && !acl.apply_here {
                    continue;
                }
                if !is_target && !acl.apply_subs {
                    continue;
                }
                if !Self::acl_matches_user(acl, user_id, groups) {
                    continue;
                }
                granted |= acl.allow;
                granted &= !acl.deny;
            }
        }
        if granted & (permission::TRAVERSE | permission::WRITE) == 0 {
            granted = permission::NONE;
        }
        if granted & permission::WRITE != 0 {
            granted |= permission::ALL & !(permission::SPEAK | permission::WHISPER);
        }
        debug!(
            "Permissions for user {} on channel {}: 0x{:X}",
            user_id, channel_id, granted
        );
        if user_id != 0 {
            self.cache_insert(user_id, channel_id, granted).await;
        }
        granted
    }

    /// Insert a permission result into the cache, performing partial eviction
    /// when the cache exceeds [`ACL_CACHE_MAX_SIZE`].
    ///
    /// Eviction strategy (avoids the cold-cache spike of a full clear):
    /// 1. Remove all guest/anonymous entries (user_id ≤ 0) — they are stale
    ///    because each anonymous session uses a unique negative user_id.
    /// 2. If still above [`ACL_CACHE_EVICT_TARGET`], remove arbitrary entries
    ///    until the target is reached.  Registered-user entries are kept warm.
    async fn cache_insert(&self, user_id: i32, channel_id: u32, value: u32) {
        let mut cache = self.cache.write().await;
        if cache.len() >= ACL_CACHE_MAX_SIZE {
            let before = cache.len();
            // Step 1: remove anonymous/guest entries first (likely stale).
            cache.retain(|(uid, _), _| *uid > 0);
            // Step 2: if still over target, trim arbitrarily.
            if cache.len() > ACL_CACHE_EVICT_TARGET {
                let to_remove = cache.len() - ACL_CACHE_EVICT_TARGET;
                let evict_keys: Vec<_> = cache.keys().take(to_remove).cloned().collect();
                for k in evict_keys {
                    cache.remove(&k);
                }
            }
            tracing::debug!(
                before,
                after = cache.len(),
                "ACL cache partially evicted (was full)"
            );
        }
        cache.insert((user_id, channel_id), value);
    }

    /// Check if a user has a specific permission on a channel.
    pub async fn has_permission(
        &self,
        user_id: i32,
        channel_id: u32,
        groups: &[String],
        perm: u32,
    ) -> bool {
        let effective = self
            .calculate_permissions(user_id, channel_id, groups)
            .await;
        // Write implications are already expanded in calculate_permissions
        (effective & perm) != 0
    }

    /// Get the ACL entries for a channel from the in-memory store.
    pub async fn get_channel_acls(&self, channel_id: u32) -> Vec<AclEntry> {
        self.acl_entries
            .read()
            .await
            .get(&channel_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Get the channel groups (with embedded member lists) for a channel.
    pub async fn get_channel_groups(&self, channel_id: u32) -> Vec<ChannelGroup> {
        self.channel_groups
            .read()
            .await
            .get(&channel_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Clone the entire ACL entry map for callers that need a snapshot
    /// (e.g. batch permission queries that iterate hundreds of channels).
    pub async fn acl_entries_snapshot(&self) -> HashMap<u32, Vec<AclEntry>> {
        self.acl_entries.read().await.clone()
    }

    /// Determine whether a channel is "enter-restricted" — i.e. whether any ACL
    /// entry that is **effectively applied** to the channel (directly or via
    /// inheritance through the ancestor chain) carries a `deny & ENTER` bit.
    ///
    /// This mirrors the ACL walk of [`calculate_permissions_with_chain`]: the
    /// `inherit_acl` flags are respected (a `false` flag on a non-root channel
    /// resets the effective start of the chain, discarding ancestor entries that
    /// can no longer propagate), and the `apply_here` / `apply_subs` filters are
    /// applied.  Unlike the per-user permission check, **no user/group matching
    /// is performed** — if *any* entry with `deny & ENTER` would apply to this
    /// channel for any user, the channel is considered enter-restricted.
    ///
    /// `acl_snapshot` should be obtained once via [`acl_entries_snapshot`] and
    /// reused across multiple calls to avoid repeated lock acquisitions.
    pub fn is_enter_restricted_with_chain(
        channel_id: u32,
        chain: &[u32],
        inherit_flags: &[bool],
        acl_snapshot: &HashMap<u32, Vec<AclEntry>>,
    ) -> bool {
        // Find the effective start index: the last non-root channel with
        // inherit_acl=false.  Entries from channels before that index are
        // discarded (identical to the `granted = DEFAULT` reset in the
        // permission calculation loop).
        let effective_start = chain
            .iter()
            .zip(inherit_flags.iter())
            .enumerate()
            .filter(|(_, (cid, inherit))| **cid != 0 && !**inherit)
            .map(|(idx, _)| idx)
            .next_back()
            .unwrap_or(0);

        for &cid in &chain[effective_start..] {
            let is_target = cid == channel_id;
            if let Some(acls) = acl_snapshot.get(&cid) {
                for acl in acls {
                    if is_target && !acl.apply_here {
                        continue;
                    }
                    if !is_target && !acl.apply_subs {
                        continue;
                    }
                    if acl.deny & permission::ENTER != 0 {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Clone the entire channel-group map for callers that need a snapshot.
    pub async fn channel_groups_snapshot(&self) -> HashMap<u32, Vec<ChannelGroup>> {
        self.channel_groups.read().await.clone()
    }

    /// Save ACL entries for a channel — write-through to both DB and in-memory.
    ///
    /// DB write uses `spawn_blocking` to avoid blocking the tokio executor thread.
    pub async fn save_acls(&self, channel_id: u32, entries: &[AclEntry]) -> anyhow::Result<()> {
        let db = self.db.clone();
        let entries_owned = entries.to_vec();
        tokio::task::spawn_blocking(move || db.save_acls(channel_id, &entries_owned))
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))??;
        {
            let mut map = self.acl_entries.write().await;
            if entries.is_empty() {
                map.remove(&channel_id);
            } else {
                map.insert(channel_id, entries.to_vec());
            }
        }
        self.invalidate_channel(channel_id).await;
        Ok(())
    }

    /// Save channel groups for a channel — write-through to both DB and in-memory.
    ///
    /// Replaces all existing groups and their member lists for the channel.
    /// DB writes use `spawn_blocking` to avoid blocking the tokio executor thread.
    pub async fn save_channel_groups(
        &self,
        channel_id: u32,
        groups: Vec<ChannelGroup>,
    ) -> anyhow::Result<()> {
        let db = self.db.clone();
        let db_records: Vec<ChannelGroupRecord> = groups
            .iter()
            .map(|g| ChannelGroupRecord {
                id: 0, // auto-assigned
                channel_id,
                name: g.name.clone(),
                inherit: g.inherit,
                inheritable: g.inheritable,
            })
            .collect();
        let groups_clone = groups.clone();
        // All DB work in one spawn_blocking to avoid multiple thread round-trips.
        let in_memory: Vec<ChannelGroup> =
            tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
                db.save_channel_groups(channel_id, &db_records)?;
                let mut result = Vec::with_capacity(groups_clone.len());
                for g in &groups_clone {
                    let gid = db.get_channel_group_id(channel_id, &g.name)?.unwrap_or(0);
                    let members: Vec<(u32, bool)> = g
                        .add
                        .iter()
                        .map(|&uid| (uid, true))
                        .chain(g.remove.iter().map(|&uid| (uid, false)))
                        .collect();
                    db.save_channel_group_members(gid, &members)?;
                    result.push(ChannelGroup {
                        id: gid,
                        name: g.name.clone(),
                        inherit: g.inherit,
                        inheritable: g.inheritable,
                        add: g.add.clone(),
                        remove: g.remove.clone(),
                    });
                }
                Ok(result)
            })
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))??;

        {
            let mut map = self.channel_groups.write().await;
            if in_memory.is_empty() {
                map.remove(&channel_id);
            } else {
                map.insert(channel_id, in_memory);
            }
        }
        self.invalidate_channel(channel_id).await;
        Ok(())
    }

    /// Remove all ACL entries and channel groups for a deleted channel.
    ///
    /// Must be called whenever a channel is permanently removed so that the
    /// in-memory store does not accumulate stale entries for non-existent channels.
    pub async fn remove_channel(&self, channel_id: u32) {
        self.acl_entries.write().await.remove(&channel_id);
        self.channel_groups.write().await.remove(&channel_id);
        self.invalidate_channel(channel_id).await;
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
                if let Some(parent) = ch.parent_id
                    && affected.contains(&parent)
                    && affected.insert(ch.id)
                {
                    changed = true;
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
    pub(crate) fn acl_matches_user(acl: &AclEntry, user_id: i32, groups: &[String]) -> bool {
        // Match by user_id
        if let Some(acl_user_id) = acl.user_id
            && acl_user_id > 0
            && acl_user_id == user_id
        {
            return true;
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
        let channel_store = Arc::new(ChannelStore::new(db.clone()));

        // Add root channel
        channel_store
            .create_channel(ChannelRecord {
                id: 0,
                parent_id: None,
                name: "Root".to_string(),
                description: String::new(),
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: HashSet::new(),
            })
            .await;

        // Add child channel
        channel_store
            .create_channel(ChannelRecord {
                id: 1,
                parent_id: Some(0),
                name: "General".to_string(),
                description: String::new(),
                position: 0,
                max_users: 50,
                temporary: false,
                inherit_acl: true,
                links: HashSet::new(),
            })
            .await;

        // Add grandchild channel
        channel_store
            .create_channel(ChannelRecord {
                id: 2,
                parent_id: Some(1),
                name: "SubGeneral".to_string(),
                description: String::new(),
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: HashSet::new(),
            })
            .await;

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
        mgr.load_all().await.unwrap();
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
        mgr.load_all().await.unwrap();

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
        })
        .await;

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
        mgr.load_all().await.unwrap();

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
        mgr.load_all().await.unwrap();

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
        mgr.load_all().await.unwrap();

        // Authenticated user (id=5) should have Register
        let perms = mgr.calculate_permissions(5, 0, &[]).await;
        assert_ne!(perms & permission::REGISTER, 0);

        // Guest (id=-1) should NOT have Register
        let perms = mgr.calculate_permissions(-1, 0, &[]).await;
        assert_eq!(perms & permission::REGISTER, 0);
    }

    /// Root has an ACL for a named auth group with `apply_subs=true`.
    /// The child channel has no ACL of its own (only inherits).
    /// A user who is in that auth group should get the inherited permission on the child.
    ///
    /// Uses [`permission::MAKE_CHANNEL`] because it is NOT in [`permission::DEFAULT`],
    /// so we can distinguish "granted by group ACL" from "everyone has this by default".
    #[tokio::test]
    async fn test_auth_group_inherited_to_child_without_own_acl() {
        let (db, cs) = setup().await;

        // Root: group "members" gets MAKE_CHANNEL + MUTE_DEAFEN, apply_subs=true
        let granted = permission::MAKE_CHANNEL | permission::MUTE_DEAFEN;
        db.save_acls(
            0,
            &[AclEntry {
                channel_id: 0,
                user_id: None,
                group_name: Some("members".to_string()),
                apply_here: true,
                apply_subs: true,
                allow: granted,
                deny: 0,
            }],
        )
        .unwrap();

        let mgr = AclManager::new(db, cs);
        mgr.load_all().await.unwrap();

        // --- User 5 is in group "members" ---
        let perms = mgr
            .calculate_permissions(5, 1, &["members".to_string()])
            .await;

        // Should inherit the granted permissions on child
        assert_ne!(
            perms & permission::MAKE_CHANNEL,
            0,
            "user in 'members' group should inherit MAKE_CHANNEL on child"
        );
        assert_ne!(
            perms & permission::MUTE_DEAFEN,
            0,
            "user in 'members' group should inherit MUTE_DEAFEN on child"
        );
        // DEFAULT permissions should still be present
        assert_ne!(perms & permission::SPEAK, 0);

        // Should also have the permissions on root (apply_here=true)
        let perms = mgr
            .calculate_permissions(5, 0, &["members".to_string()])
            .await;
        assert_ne!(
            perms & permission::MAKE_CHANNEL,
            0,
            "user in 'members' group should have MAKE_CHANNEL on root"
        );

        // --- User 6 is NOT in any group ---
        let perms = mgr.calculate_permissions(6, 1, &[]).await;
        // Should NOT get the group-granted permissions
        assert_eq!(
            perms & permission::MAKE_CHANNEL,
            0,
            "user not in group should NOT get MAKE_CHANNEL on child"
        );
        assert_eq!(
            perms & permission::MUTE_DEAFEN,
            0,
            "user not in group should NOT get MUTE_DEAFEN on child"
        );
        // DEFAULT permissions should still be present
        assert_ne!(perms & permission::SPEAK, 0);
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
        mgr.load_all().await.unwrap();
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

        assert!(mgr.has_permission(-1, 0, &[], permission::ENTER).await);
        assert!(!mgr.has_permission(-1, 0, &[], permission::KICK).await);
    }

    #[tokio::test]
    async fn test_cache_invalidation() {
        let (db, cs) = setup().await;
        let mgr = AclManager::new(db.clone(), cs.clone());

        // No ACLs yet: SPEAK should be permitted (DEFAULT grants it).
        let p1 = mgr.calculate_permissions(-1, 0, &[]).await;
        assert_ne!(p1 & permission::SPEAK, 0);

        // Add a deny-SPEAK ACL via the manager (updates in-memory + invalidates cache).
        mgr.save_acls(
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
        .await
        .unwrap();

        // After save_acls the cache is invalidated and the new ACL is in memory.
        let p2 = mgr.calculate_permissions(-1, 0, &[]).await;
        assert_eq!(p2 & permission::SPEAK, 0);
    }

    /// Verify that partial eviction keeps registered-user entries and removes
    /// guest entries when the cache overflows.  We directly manipulate
    /// `cache_insert` by pre-filling the cache to at least ACL_CACHE_MAX_SIZE
    /// using the internal write lock, then triggering one more insertion.
    #[tokio::test]
    async fn test_cache_partial_eviction_retains_registered_users() {
        let (db, cs) = setup().await;
        let mgr = AclManager::new(db, cs);

        // Pre-fill the cache to exactly ACL_CACHE_MAX_SIZE by directly writing
        // to the cache lock.  Half entries are registered users (uid > 0),
        // half are anonymous/guest (uid ≤ 0).
        {
            let mut cache = mgr.cache.write().await;
            for i in 0..(ACL_CACHE_MAX_SIZE as i32 / 2) {
                // registered user entries
                cache.insert((i + 1, 0), permission::DEFAULT);
                // anonymous/guest entries
                cache.insert((-i - 1, 0), permission::DEFAULT);
            }
            assert_eq!(cache.len(), ACL_CACHE_MAX_SIZE);
        }

        // Now insert one more entry via cache_insert — this triggers eviction.
        // user_id = 999_999 (registered), channel_id = 1 (unused so far).
        mgr.cache_insert(999_999, 1, permission::DEFAULT).await;

        let cache = mgr.cache.read().await;
        let len_after = cache.len();

        // After partial eviction + the new insertion, the cache should be
        // around the eviction target (75% of max), NOT zero.
        assert!(
            len_after > 0,
            "cache should not be empty after partial eviction"
        );
        assert!(
            len_after <= ACL_CACHE_EVICT_TARGET + 1,
            "cache should be at most EVICT_TARGET + 1 after eviction, got {}",
            len_after
        );

        // All remaining entries with user_id ≤ 0 (guest) should have been removed first.
        let has_guest = cache.keys().any(|(uid, _)| *uid <= 0);
        assert!(
            !has_guest,
            "no guest (uid ≤ 0) entries should survive eviction when registered-user entries exist"
        );

        // The newly inserted registered-user entry must be present.
        assert!(
            cache.contains_key(&(999_999, 1)),
            "the triggering insertion must be present after eviction"
        );
    }

    // -----------------------------------------------------------------------
    // Test: Write-revocation detection used by the ACL self-protection logic.
    //
    // After save_acls() replaces a channel's ACLs with ones that remove Write
    // from a specific user, has_permission(user_id, channel, WRITE) must
    // return false.  Confirming this is the precondition for the self-protection
    // code in rpc_handler that auto-reinserts Write|Traverse for the actor.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_has_permission_false_after_write_acl_removed() {
        let (db, cs) = setup().await;
        let mgr = AclManager::new(db.clone(), cs);

        // Give user 42 explicit Write on channel 1.
        mgr.save_acls(
            1,
            &[AclEntry {
                channel_id: 1,
                user_id: Some(42),
                group_name: None,
                apply_here: true,
                apply_subs: false,
                allow: permission::WRITE,
                deny: 0,
            }],
        )
        .await
        .unwrap();

        assert!(
            mgr.has_permission(42, 1, &[], permission::WRITE).await,
            "user 42 must have Write before ACL removal"
        );

        // Now overwrite with ACLs that no longer grant Write to user 42.
        mgr.save_acls(
            1,
            &[AclEntry {
                channel_id: 1,
                user_id: Some(99), // different user
                group_name: None,
                apply_here: true,
                apply_subs: false,
                allow: permission::WRITE,
                deny: 0,
            }],
        )
        .await
        .unwrap();

        assert!(
            !mgr.has_permission(42, 1, &[], permission::WRITE).await,
            "user 42 must NOT have Write after their ACL was replaced"
        );
    }

    // -----------------------------------------------------------------------
    // Test: self-protection ACL insertion restores Write after revocation.
    //
    // Simulates the full self-protection sequence from rpc_handler:
    //   1. Actor saves ACLs that accidentally revoke their own Write.
    //   2. has_permission returns false → self-protection is triggered.
    //   3. A Write|Traverse ACL is appended and saved.
    //   4. has_permission returns true again.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_self_protection_acl_restores_write() {
        let (db, cs) = setup().await;
        let mgr = AclManager::new(db.clone(), cs);
        let actor_user_id: i32 = 7;
        let channel_id: u32 = 1;

        // Initial state: actor has Write via an ACL entry.
        mgr.save_acls(
            channel_id,
            &[AclEntry {
                channel_id,
                user_id: Some(actor_user_id),
                group_name: None,
                apply_here: true,
                apply_subs: false,
                allow: permission::WRITE,
                deny: 0,
            }],
        )
        .await
        .unwrap();
        assert!(
            mgr.has_permission(actor_user_id, channel_id, &[], permission::WRITE)
                .await
        );

        // Actor saves new ACLs that inadvertently exclude themselves.
        mgr.save_acls(channel_id, &[]).await.unwrap(); // clear all, actor loses Write
        let lost_write = !mgr
            .has_permission(actor_user_id, channel_id, &[], permission::WRITE)
            .await;
        assert!(lost_write, "Write must be gone after clearing ACLs");

        // Self-protection: append Write|Traverse ACL for actor.
        let mut entries = mgr.get_channel_acls(channel_id).await;
        entries.push(AclEntry {
            channel_id,
            user_id: Some(actor_user_id),
            group_name: None,
            apply_here: true,
            apply_subs: false,
            allow: permission::WRITE | permission::TRAVERSE,
            deny: 0,
        });
        mgr.save_acls(channel_id, &entries).await.unwrap();

        assert!(
            mgr.has_permission(actor_user_id, channel_id, &[], permission::WRITE)
                .await,
            "Write must be restored after self-protection ACL insertion"
        );
        assert!(
            mgr.has_permission(actor_user_id, channel_id, &[], permission::TRAVERSE)
                .await,
            "Traverse must also be granted by the self-protection ACL"
        );
    }
}
