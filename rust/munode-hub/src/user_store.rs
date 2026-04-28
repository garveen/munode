use std::sync::Arc;

use anyhow::{Context, Result};

use crate::database::Database;

/// User record returned by UserStore queries.
///
/// Does **not** include the password hash — that lives only in the database
/// and is fetched on demand at authentication time via [`UserStore::fetch_password_hash`].
#[derive(Debug, Clone)]
pub struct UserRecord {
    pub id: u32,
    pub username: String,
    pub last_channel: u32,
}

/// User store — thin async wrapper around the [`Database`] for user-related rows.
///
/// All reads are issued on demand (no in-memory cache): user records are
/// low-frequency (one DB call per new connection) and channel listeners are
/// consumed exactly once per login under a TTL, so a cache would only complicate
/// the consume-on-read semantics.  Password hashes are never held in memory.
pub struct UserStore {
    db: Arc<Database>,
}

/// TTL for persisted channel listeners.  Listeners saved more than this many
/// seconds ago are dropped instead of being restored on the next login.
pub const LISTENER_TTL_SECS: u64 = 30 * 60;

impl UserStore {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    // ── Database-direct reads (low-frequency: once per new connection) ──────

    /// Look up a user by username (case-insensitive).  Direct DB call.
    pub async fn find_by_name(&self, username: &str) -> Result<Option<UserRecord>> {
        let db = self.db.clone();
        let username_owned = username.to_string();
        let opt = tokio::task::spawn_blocking(move || db.find_user(&username_owned))
            .await
            .context("spawn_blocking join error")??;
        Ok(opt.map(|u| UserRecord { id: u.id, username: u.username, last_channel: u.last_channel }))
    }

    /// Get the last channel for a user.  Returns 0 on DB error or not found.  Direct DB call.
    pub async fn get_last_channel(&self, user_id: u32) -> u32 {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || db.get_user_last_channel(user_id))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(0)
    }

    /// Return all registered users.  Direct DB call.
    pub async fn list(&self) -> Result<Vec<UserRecord>> {
        let db = self.db.clone();
        let rows = tokio::task::spawn_blocking(move || db.list_users())
            .await
            .context("spawn_blocking join error")??;
        Ok(rows.into_iter()
            .map(|u| UserRecord { id: u.id, username: u.username, last_channel: u.last_channel })
            .collect())
    }

    /// Get the blob hash for a user's texture or comment.  Direct DB call.
    pub async fn get_blob_hash(&self, user_id: u32, blob_type: &str) -> Result<Option<String>> {
        let db = self.db.clone();
        let blob_type_owned = blob_type.to_string();
        tokio::task::spawn_blocking(move || db.get_user_blob_hash(user_id, &blob_type_owned))
            .await
            .context("spawn_blocking join error")?
    }

    // ── Database-only access (auth time only) ──────────────────────────────

    /// Fetch only the password hash from the database.
    ///
    /// Must run inside [`tokio::task::spawn_blocking`].  The returned value
    /// must never be stored beyond the current authentication request.
    pub fn fetch_password_hash(&self, user_id: u32) -> Result<Option<String>> {
        self.db.get_user_password_hash(user_id)
    }

    // ── Write mutations (direct DB) ────────────────────────────────────────

    /// Create a new registered user.  Returns the new user ID.
    pub async fn create(&self, username: &str, pw_hash: &str) -> Result<u32> {
        let db = self.db.clone();
        let username_owned = username.to_string();
        let pw_hash_owned = pw_hash.to_string();
        tokio::task::spawn_blocking(move || db.create_user(&username_owned, &pw_hash_owned))
            .await
            .context("spawn_blocking join error")?
    }

    /// Delete a registered user.  Returns `true` if the user existed.
    pub async fn delete(&self, user_id: u32) -> Result<bool> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || db.delete_user(user_id))
            .await
            .context("spawn_blocking join error")?
    }

    /// Rename a user.  Returns `true` if the user existed.
    pub async fn rename(&self, user_id: u32, new_name: &str) -> Result<bool> {
        let db = self.db.clone();
        let new_name_owned = new_name.to_string();
        tokio::task::spawn_blocking(move || db.rename_user(user_id, &new_name_owned))
            .await
            .context("spawn_blocking join error")?
    }

    /// Save user's last channel directly to DB.
    pub async fn save_last_channel(&self, user_id: u32, channel_id: u32) -> Result<()> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || db.save_user_last_channel(user_id, channel_id))
            .await
            .context("spawn_blocking join error")?
    }

    /// Ensure an externally-authenticated user exists in the DB for last_channel tracking.
    pub async fn upsert_ext_user(&self, user_id: u32, username: &str) -> Result<()> {
        let db = self.db.clone();
        let username_owned = username.to_string();
        tokio::task::spawn_blocking(move || db.upsert_ext_user(user_id, &username_owned))
            .await
            .context("spawn_blocking join error")?
    }

    /// Persist a user's channel listeners (replaces previous state, stamps the
    /// current time).  Empty `channel_ids` clears the saved listeners.
    pub async fn save_listeners(&self, user_id: u32, channel_ids: &[u32]) -> Result<()> {
        let db = self.db.clone();
        let ids = channel_ids.to_vec();
        tokio::task::spawn_blocking(move || db.save_channel_listeners(user_id, &ids))
            .await
            .context("spawn_blocking join error")??;
        Ok(())
    }

    /// Atomically consume the persisted channel listeners for a user.
    ///
    /// Reads the current set, deletes it from the database, and returns the
    /// channel IDs only when they were saved within `ttl_secs` seconds (and
    /// non-empty).  Restoration is strictly one-shot: the second call for the
    /// same user — including a concurrent multi-session login — receives an
    /// empty list, so a user already restored on session A is not restored
    /// again on session B.
    pub async fn consume_listeners(&self, user_id: u32, ttl_secs: u64) -> Result<Vec<u32>> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || db.consume_channel_listeners(user_id, ttl_secs))
            .await
            .context("spawn_blocking join error")?
    }

    /// Set the blob hash for a user's texture or comment.  Direct DB write.
    pub async fn set_blob_hash(&self, user_id: u32, blob_type: &str, hash: &str) -> Result<()> {
        let db = self.db.clone();
        let blob_type_owned = blob_type.to_string();
        let hash_owned = hash.to_string();
        tokio::task::spawn_blocking(move || db.set_user_blob_hash(user_id, &blob_type_owned, &hash_owned))
            .await
            .context("spawn_blocking join error")?
    }
}
