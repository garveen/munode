use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use tracing::info;

use crate::database::{BanRecord, Database, ip_matches_ban};

/// Thread-safe in-memory ban store.
///
/// This is the **authoritative source of truth** for ban data.  All IP checks
/// are served directly from the in-memory list (populated at startup via
/// [`load_from_db`]).  Mutations write through to both the in-memory list and
/// the database.
pub struct BanStore {
    bans: RwLock<Vec<BanRecord>>,
    db: Arc<Database>,
}

impl BanStore {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            bans: RwLock::new(Vec::new()),
            db,
        }
    }

    /// Load all ban records from the database into memory.
    ///
    /// Must be called once at startup before serving any requests.
    pub async fn load_from_db(&self) -> Result<()> {
        let db = self.db.clone();
        let bans = tokio::task::spawn_blocking(move || {
            db.load_bans().context("Failed to load bans from database")
        })
        .await
        .context("spawn_blocking join error")??;
        let count = bans.len();
        *self.bans.write().unwrap() = bans;
        info!("Loaded {} ban records from database", count);
        Ok(())
    }

    // ── Read-only in-memory accessors ──────────────────────────────────────

    /// Check if an IP address (as 16-byte IPv6-mapped) is currently banned.
    ///
    /// Returns the matching active [`BanRecord`] if banned, or `None` if not.
    /// Runs entirely in memory — no I/O.
    pub fn check_ip_banned(&self, ip_bytes: &[u8; 16]) -> Option<BanRecord> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let bans = self.bans.read().unwrap();
        for ban in bans.iter() {
            let is_active = ban.duration == 0
                || ban.start_time.saturating_add(ban.duration as i64) > now;
            if is_active && ip_matches_ban(ip_bytes, &ban.address, ban.mask) {
                return Some(ban.clone());
            }
        }
        None
    }

    /// Return all ban records.  In-memory, synchronous.
    pub fn get_all(&self) -> Vec<BanRecord> {
        self.bans.read().unwrap().clone()
    }

    // ── Write-through mutations ────────────────────────────────────────────

    /// Add a ban record.  Write-through.  Returns the new ban ID.
    pub async fn add_ban(&self, ban: &BanRecord) -> Result<i64> {
        let db = self.db.clone();
        let ban_owned = ban.clone();
        let id = tokio::task::spawn_blocking(move || db.add_ban(&ban_owned))
            .await
            .context("spawn_blocking join error")??;
        let mut stored = ban.clone();
        stored.id = id;
        self.bans.write().unwrap().push(stored);
        Ok(id)
    }

    /// Replace the entire ban list.  Write-through.
    pub async fn replace_bans(&self, bans: &[BanRecord]) -> Result<()> {
        let db = self.db.clone();
        let bans_owned = bans.to_vec();
        tokio::task::spawn_blocking(move || db.replace_bans(&bans_owned))
            .await
            .context("spawn_blocking join error")??;
        *self.bans.write().unwrap() = bans.to_vec();
        Ok(())
    }

    /// Delete a specific ban by ID.  Write-through.  Returns `true` if found.
    pub async fn delete_by_id(&self, id: i64) -> Result<bool> {
        let db = self.db.clone();
        let found = tokio::task::spawn_blocking(move || db.delete_ban_by_id(id))
            .await
            .context("spawn_blocking join error")??;
        if found {
            self.bans.write().unwrap().retain(|b| b.id != id);
        }
        Ok(found)
    }

    /// Remove all expired bans from memory and the database.  Returns count removed.
    pub async fn cleanup_expired(&self) -> u32 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let removed = {
            let mut bans = self.bans.write().unwrap();
            let before = bans.len();
            bans.retain(|b| b.duration == 0 || b.start_time.saturating_add(b.duration as i64) > now);
            (before - bans.len()) as u32
        };
        if removed > 0 {
            // Sync the cleanup to DB as well.
            let db = self.db.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(e) = db.cleanup_expired_bans() {
                    tracing::warn!("Failed to clean up expired bans in database: {}", e);
                }
            }).await.ok();
        }
        removed
    }
}
