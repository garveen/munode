use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use tracing::info;

/// SHA-256 hex digest of arbitrary bytes.
fn sha256_hex(data: &[u8]) -> String {
    use ring::digest;
    let digest = digest::digest(&digest::SHA256, data);
    digest.as_ref().iter().map(|b| format!("{:02x}", b)).collect()
}

/// A user record from the database.
#[derive(Debug, Clone)]
pub struct UserRecord {
    pub id: u32,
    pub username: String,
    pub pw_hash: String,
    pub last_channel: u32,
    pub cert_hash: String,
}

/// Channel record from the database.
#[derive(Debug, Clone)]
pub struct DbChannelRecord {
    pub id: u32,
    pub parent_id: Option<u32>,
    pub name: String,
    pub description: String,
    pub position: i32,
    pub max_users: u32,
    pub temporary: bool,
    pub inherit_acl: bool,
}

/// A ban record from the database.
#[derive(Debug, Clone)]
pub struct BanRecord {
    pub id: i64,
    pub address: [u8; 16],
    pub mask: u32,
    pub name: String,
    pub cert_hash: String,
    pub reason: String,
    pub start_time: i64,
    pub duration: u32,
}

/// SQLite database wrapper for the Hub server.
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Open or create the SQLite database at the given path.
    pub fn open(path: &str) -> Result<Self> {
        // Ensure parent directory exists
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .context("Failed to create database directory")?;
            }
        }

        let conn = Connection::open(path)
            .context("Failed to open SQLite database")?;

        // Enable WAL mode for better concurrent read performance
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
        Ok(db)
    }

    /// Create the required tables if they don't exist, and ensure root channel exists.
    fn init_tables(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                pw_hash TEXT NOT NULL DEFAULT '',
                last_channel INTEGER NOT NULL DEFAULT 0,
                cert_hash TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS channels (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER,
                name TEXT NOT NULL,
                description_blob TEXT,
                position INTEGER NOT NULL DEFAULT 0,
                max_users INTEGER NOT NULL DEFAULT 0,
                temporary INTEGER NOT NULL DEFAULT 0,
                inherit_acl INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS channel_links (
                channel_id INTEGER NOT NULL,
                target_id INTEGER NOT NULL,
                PRIMARY KEY (channel_id, target_id)
            );

            CREATE TABLE IF NOT EXISTS acls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at DATETIME,
                updated_at DATETIME,
                deleted_at DATETIME,
                channel_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL DEFAULT -1,
                \"group\" TEXT,
                apply_here INTEGER NOT NULL DEFAULT 1,
                apply_subs INTEGER NOT NULL DEFAULT 1,
                allow INTEGER NOT NULL DEFAULT 0,
                deny INTEGER NOT NULL DEFAULT 0
            );"
        )?;

        // Migrate old schema: rename 'description' to 'description_blob' if needed
        let has_description_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('channels') WHERE name = 'description'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        let has_description_blob_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('channels') WHERE name = 'description_blob'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if has_description_col && !has_description_blob_col {
            conn.execute_batch(
                "ALTER TABLE channels RENAME COLUMN description TO description_blob;"
            )?;
            info!("Migrated channels table: renamed 'description' to 'description_blob'");
        }

        // Add 'temporary' column to channels if missing (TS schema doesn't have it)
        let has_temporary_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('channels') WHERE name = 'temporary'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if !has_temporary_col {
            conn.execute_batch(
                "ALTER TABLE channels ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0;"
            )?;
            info!("Migrated channels table: added 'temporary' column");
        }

        // Migrate channel_links: TS uses 'link_id', Rust expects 'target_id'
        let has_link_id_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('channel_links') WHERE name = 'link_id'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if has_link_id_col {
            conn.execute_batch(
                "ALTER TABLE channel_links RENAME COLUMN link_id TO target_id;"
            )?;
            info!("Migrated channel_links table: renamed 'link_id' to 'target_id'");
        }

        // Migrate users table: TS uses 'name'/'password_hash', Rust uses 'username'/'pw_hash'
        let has_name_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'name'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        let has_username_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'username'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if has_name_col && !has_username_col {
            conn.execute_batch(
                "ALTER TABLE users RENAME COLUMN name TO username;"
            )?;
            info!("Migrated users table: renamed 'name' to 'username'");
        }
        let has_pw_hash_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'pw_hash'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        let has_password_hash_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'password_hash'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if has_password_hash_col && !has_pw_hash_col {
            conn.execute_batch(
                "ALTER TABLE users RENAME COLUMN password_hash TO pw_hash;"
            )?;
            info!("Migrated users table: renamed 'password_hash' to 'pw_hash'");
        }
        // Add cert_hash if missing
        let has_cert_hash_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'cert_hash'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if !has_cert_hash_col {
            conn.execute_batch(
                "ALTER TABLE users ADD COLUMN cert_hash TEXT NOT NULL DEFAULT '';"
            )?;
            info!("Migrated users table: added 'cert_hash' column");
        }

        // Migrate old acls schema: rename 'group_name' to 'group' if needed
        let has_group_name_col: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('acls') WHERE name = 'group_name'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if has_group_name_col {
            // SQLite doesn't support RENAME COLUMN in older versions; recreate table
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS acls_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at DATETIME,
                    updated_at DATETIME,
                    deleted_at DATETIME,
                    channel_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL DEFAULT -1,
                    \"group\" TEXT,
                    apply_here INTEGER NOT NULL DEFAULT 1,
                    apply_subs INTEGER NOT NULL DEFAULT 1,
                    allow INTEGER NOT NULL DEFAULT 0,
                    deny INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO acls_new (id, channel_id, user_id, \"group\", apply_here, apply_subs, allow, deny)
                    SELECT id, channel_id, COALESCE(user_id, -1), group_name, apply_here, apply_subs, allow, deny FROM acls;
                DROP TABLE acls;
                ALTER TABLE acls_new RENAME TO acls;"
            )?;
            info!("Migrated acls table: renamed 'group_name' to '\"group\"'");
        }

        // Ensure root channel exists (id=0, name="Root")
        let root_exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM channels WHERE id = 0",
            [],
            |row| row.get(0),
        )?;

        if !root_exists {
            conn.execute(
                "INSERT INTO channels (id, parent_id, name, description_blob, position, max_users, temporary, inherit_acl)
                 VALUES (0, NULL, 'Root', '', 0, 0, 0, 1)",
                [],
            )?;
            info!("Created root channel (id=0)");
        }

        // Create bans table
        Self::init_bans_table(&conn)?;

        // Create blob storage tables
        Self::init_blob_tables(&conn)?;

        Ok(())
    }

    /// Load all channels from the database.
    pub fn load_channels(&self) -> Result<Vec<DbChannelRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, name, description_blob, position, max_users, temporary, inherit_acl FROM channels"
        )?;

        let rows = stmt.query_map([], |row| {
            let parent_id_raw: Option<i64> = row.get(1)?;
            let parent_id = parent_id_raw.and_then(|p| if p < 0 { None } else { Some(p as u32) });
            Ok(DbChannelRecord {
                id: row.get(0)?,
                parent_id,
                name: row.get(2)?,
                description: row.get::<_, String>(3).unwrap_or_default(),
                position: row.get(4)?,
                max_users: row.get(5)?,
                temporary: row.get::<_, i32>(6).unwrap_or(0) != 0,
                inherit_acl: row.get::<_, i32>(7).unwrap_or(1) != 0,
            })
        })?;

        let mut channels = Vec::new();
        for row in rows {
            channels.push(row?);
        }
        Ok(channels)
    }

    /// Load all channel links from the database.
    pub fn load_channel_links(&self) -> Result<Vec<(u32, u32)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT channel_id, target_id FROM channel_links")?;

        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?))
        })?;

        let mut links = Vec::new();
        for row in rows {
            links.push(row?);
        }
        Ok(links)
    }

    /// Save (insert or replace) a channel.
    pub fn save_channel(&self, ch: &DbChannelRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO channels (id, parent_id, name, description_blob, position, max_users, temporary, inherit_acl)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                ch.id,
                ch.parent_id,
                ch.name,
                ch.description,
                ch.position,
                ch.max_users,
                ch.temporary as i32,
                ch.inherit_acl as i32,
            ],
        )?;
        Ok(())
    }

    /// Add a bidirectional channel link to the database.
    pub fn add_channel_link(&self, ch1: u32, ch2: u32) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO channel_links (channel_id, target_id) VALUES (?1, ?2)",
            params![ch1, ch2],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO channel_links (channel_id, target_id) VALUES (?1, ?2)",
            params![ch2, ch1],
        )?;
        Ok(())
    }

    /// Remove a bidirectional channel link from the database.
    pub fn remove_channel_link(&self, ch1: u32, ch2: u32) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM channel_links WHERE (channel_id = ?1 AND target_id = ?2) OR (channel_id = ?2 AND target_id = ?1)",
            params![ch1, ch2],
        )?;
        Ok(())
    }

    /// Delete a channel by ID.
    pub fn delete_channel(&self, channel_id: u32) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM channels WHERE id = ?1", params![channel_id])?;
        conn.execute("DELETE FROM channel_links WHERE channel_id = ?1 OR target_id = ?1", params![channel_id])?;
        Ok(())
    }

    /// Find a user by username.
    pub fn find_user(&self, username: &str) -> Result<Option<UserRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, username, pw_hash, last_channel, cert_hash FROM users WHERE username = ?1"
        )?;

        let mut rows = stmt.query(params![username])?;
        if let Some(row) = rows.next()? {
            Ok(Some(UserRecord {
                id: row.get(0)?,
                username: row.get(1)?,
                pw_hash: row.get(2)?,
                last_channel: row.get(3)?,
                cert_hash: row.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Create a new registered user. Returns the new user ID.
    pub fn create_user(&self, username: &str, pw_hash: &str) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO users (username, pw_hash, last_channel, cert_hash) VALUES (?1, ?2, 0, '')",
            params![username, pw_hash],
        )?;
        Ok(conn.last_insert_rowid() as u32)
    }

    /// List all registered users.
    pub fn list_users(&self) -> Result<Vec<UserRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, username, pw_hash, last_channel, cert_hash FROM users ORDER BY id"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(UserRecord {
                id: row.get(0)?,
                username: row.get(1)?,
                pw_hash: row.get(2)?,
                last_channel: row.get(3)?,
                cert_hash: row.get(4)?,
            })
        })?;
        let mut users = Vec::new();
        for row in rows {
            users.push(row?);
        }
        Ok(users)
    }

    /// Rename a registered user. Returns false if the user was not found.
    pub fn rename_user(&self, user_id: u32, new_name: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE users SET username = ?1 WHERE id = ?2",
            params![new_name, user_id],
        )?;
        Ok(n > 0)
    }

    /// Delete a registered user (de-register).
    pub fn delete_user(&self, user_id: u32) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM users WHERE id = ?1", params![user_id])?;
        Ok(n > 0)
    }

    /// Update the last channel for a user.
    pub fn save_user_last_channel(&self, user_id: u32, channel_id: u32) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // Use INSERT OR REPLACE to handle both existing and new user rows
        conn.execute(
            "UPDATE users SET last_channel = ?1 WHERE id = ?2",
            params![channel_id, user_id],
        )?;
        // If no rows were updated (user not in DB), insert a minimal row
        if conn.changes() == 0 {
            conn.execute(
                "INSERT OR IGNORE INTO users (id, username, pw_hash, last_channel, cert_hash) VALUES (?1, '', '', ?2, '')",
                params![user_id, channel_id],
            )?;
        }
        Ok(())
    }

    /// Get the last channel for a user (by user_id). Returns 0 if not found.
    pub fn get_user_last_channel(&self, user_id: u32) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT last_channel FROM users WHERE id = ?1")?;
        let mut rows = stmt.query(params![user_id])?;
        if let Some(row) = rows.next()? {
            Ok(row.get::<_, u32>(0).unwrap_or(0))
        } else {
            Ok(0)
        }
    }

    /// Ensure an externally-authenticated user exists in the DB (creates if missing).
    /// This allows last_channel to be tracked for ext-auth users.
    pub fn upsert_ext_user(&self, user_id: u32, username: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO users (id, username, pw_hash, last_channel, cert_hash) VALUES (?1, ?2, '', 0, '')",
            params![user_id, username],
        )?;
        Ok(())
    }

    /// Load ACL entries for a specific channel.
    pub fn load_acls(&self, channel_id: u32) -> Result<Vec<crate::acl_manager::AclEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT channel_id, user_id, "group", apply_here, apply_subs, allow, deny
             FROM acls WHERE channel_id = ?1 AND deleted_at IS NULL"#
        )?;

        let rows = stmt.query_map(params![channel_id], |row| {
            let uid: i32 = row.get::<_, i32>(1).unwrap_or(-1);
            Ok(crate::acl_manager::AclEntry {
                channel_id: row.get(0)?,
                user_id: if uid == -1 { None } else { Some(uid) },
                group_name: row.get(2)?,
                apply_here: row.get::<_, i32>(3)? != 0,
                apply_subs: row.get::<_, i32>(4)? != 0,
                allow: row.get::<_, u32>(5).unwrap_or(0),
                deny: row.get::<_, u32>(6).unwrap_or(0),
            })
        })?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    /// Save ACL entries for a channel (replaces all existing entries for that channel).
    pub fn save_acls(&self, channel_id: u32, entries: &[crate::acl_manager::AclEntry]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM acls WHERE channel_id = ?1", params![channel_id])?;

        let mut stmt = conn.prepare(
            r#"INSERT INTO acls (channel_id, user_id, "group", apply_here, apply_subs, allow, deny)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#
        )?;

        for entry in entries {
            stmt.execute(params![
                channel_id,
                entry.user_id.unwrap_or(-1),
                entry.group_name,
                entry.apply_here as i32,
                entry.apply_subs as i32,
                entry.allow,
                entry.deny,
            ])?;
        }

        Ok(())
    }

    /// Load all ACL entries from the database.
    pub fn load_all_acls(&self) -> Result<Vec<crate::acl_manager::AclEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT channel_id, user_id, "group", apply_here, apply_subs, allow, deny FROM acls WHERE deleted_at IS NULL"#
        )?;

        let rows = stmt.query_map([], |row| {
            let uid: i32 = row.get::<_, i32>(1).unwrap_or(-1);
            Ok(crate::acl_manager::AclEntry {
                channel_id: row.get(0)?,
                user_id: if uid == -1 { None } else { Some(uid) },
                group_name: row.get(2)?,
                apply_here: row.get::<_, i32>(3)? != 0,
                apply_subs: row.get::<_, i32>(4)? != 0,
                allow: row.get::<_, u32>(5).unwrap_or(0),
                deny: row.get::<_, u32>(6).unwrap_or(0),
            })
        })?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    // ==================== Ban Management ====================

    /// Create bans table if not exists (called from init_tables).
    fn init_bans_table(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS bans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address BLOB NOT NULL,
                mask INTEGER NOT NULL DEFAULT 128,
                name TEXT NOT NULL DEFAULT '',
                cert_hash TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                start_time INTEGER NOT NULL,
                duration INTEGER NOT NULL DEFAULT 0
            );"
        )?;
        Ok(())
    }

    /// Load all ban records.
    pub fn load_bans(&self) -> Result<Vec<BanRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, address, mask, name, cert_hash, reason, start_time, duration FROM bans"
        )?;

        let rows = stmt.query_map([], |row| {
            let addr_blob: Vec<u8> = row.get(1)?;
            let mut address = [0u8; 16];
            let copy_len = addr_blob.len().min(16);
            address[..copy_len].copy_from_slice(&addr_blob[..copy_len]);

            Ok(BanRecord {
                id: row.get(0)?,
                address,
                mask: row.get(2)?,
                name: row.get(3)?,
                cert_hash: row.get(4)?,
                reason: row.get(5)?,
                start_time: row.get(6)?,
                duration: row.get(7)?,
            })
        })?;

        let mut bans = Vec::new();
        for row in rows {
            bans.push(row?);
        }
        Ok(bans)
    }

    /// Add a ban record.
    pub fn add_ban(&self, ban: &BanRecord) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO bans (address, mask, name, cert_hash, reason, start_time, duration)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                ban.address.to_vec(),
                ban.mask,
                ban.name,
                ban.cert_hash,
                ban.reason,
                ban.start_time,
                ban.duration,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Replace all bans (used for ban list updates from clients).
    pub fn replace_bans(&self, bans: &[BanRecord]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM bans", [])?;

        let mut stmt = conn.prepare(
            "INSERT INTO bans (address, mask, name, cert_hash, reason, start_time, duration)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        )?;

        for ban in bans {
            stmt.execute(params![
                ban.address.to_vec(),
                ban.mask,
                ban.name,
                ban.cert_hash,
                ban.reason,
                ban.start_time,
                ban.duration,
            ])?;
        }

        Ok(())
    }

    /// Remove expired bans.
    pub fn cleanup_expired_bans(&self) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let count = conn.execute(
            "DELETE FROM bans WHERE duration > 0 AND (start_time + duration) < ?1",
            params![now],
        )?;
        Ok(count as u32)
    }

    // ==================== Blob Storage ====================

    /// Initialise blob tables.
    fn init_blob_tables(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS blobs (
                hash TEXT PRIMARY KEY,
                data BLOB NOT NULL,
                created_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS user_blobs (
                user_id INTEGER NOT NULL,
                blob_type TEXT NOT NULL,
                blob_hash TEXT,
                PRIMARY KEY (user_id, blob_type),
                FOREIGN KEY (blob_hash) REFERENCES blobs(hash)
            );"
        )?;
        Ok(())
    }

    /// Store a blob and return its SHA-256 hex hash.
    /// If a blob with the same hash already exists, it is not re-inserted.
    pub fn put_blob(&self, data: &[u8]) -> Result<String> {
        let hash = sha256_hex(data);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO blobs (hash, data, created_at) VALUES (?1, ?2, ?3)",
            params![hash, data, now],
        )?;
        Ok(hash)
    }

    /// Retrieve a blob by its SHA-256 hex hash.
    pub fn get_blob(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT data FROM blobs WHERE hash = ?1")?;
        let mut rows = stmt.query(params![hash])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    /// Get the blob hash for a user's texture or comment.
    /// `blob_type` should be `"texture"` or `"comment"`.
    pub fn get_user_blob_hash(&self, user_id: u32, blob_type: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT blob_hash FROM user_blobs WHERE user_id = ?1 AND blob_type = ?2"
        )?;
        let mut rows = stmt.query(params![user_id, blob_type])?;
        if let Some(row) = rows.next()? {
            Ok(row.get(0)?)
        } else {
            Ok(None)
        }
    }

    /// Get the blob data for a user's texture or comment.
    pub fn get_user_blob(&self, user_id: u32, blob_type: &str) -> Result<Option<(String, Vec<u8>)>> {
        let hash = match self.get_user_blob_hash(user_id, blob_type)? {
            Some(h) => h,
            None => return Ok(None),
        };
        match self.get_blob(&hash)? {
            Some(data) => Ok(Some((hash, data))),
            None => Ok(None),
        }
    }

    /// Store a user's texture or comment blob.
    /// Stores the blob data and updates the user_blobs mapping.
    pub fn set_user_blob(&self, user_id: u32, blob_type: &str, data: &[u8]) -> Result<String> {
        let hash = self.put_blob(data)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO user_blobs (user_id, blob_type, blob_hash) VALUES (?1, ?2, ?3)",
            params![user_id, blob_type, hash],
        )?;
        Ok(hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Database {
        Database::open(":memory:").unwrap()
    }

    #[test]
    fn test_init_creates_root_channel() {
        let db = temp_db();
        let channels = db.load_channels().unwrap();
        assert!(channels.iter().any(|c| c.id == 0 && c.name == "Root"));
    }

    #[test]
    fn test_save_and_load_channel() {
        let db = temp_db();
        let ch = DbChannelRecord {
            id: 1,
            parent_id: Some(0),
            name: "General".to_string(),
            description: "A general channel".to_string(),
            position: 0,
            max_users: 50,
            temporary: false,
            inherit_acl: true,
        };
        db.save_channel(&ch).unwrap();

        let channels = db.load_channels().unwrap();
        assert!(channels.iter().any(|c| c.id == 1 && c.name == "General"));
    }

    #[test]
    fn test_delete_channel() {
        let db = temp_db();
        let ch = DbChannelRecord {
            id: 5,
            parent_id: Some(0),
            name: "ToDelete".to_string(),
            description: String::new(),
            position: 0,
            max_users: 0,
            temporary: true,
            inherit_acl: true,
        };
        db.save_channel(&ch).unwrap();
        db.delete_channel(5).unwrap();

        let channels = db.load_channels().unwrap();
        assert!(!channels.iter().any(|c| c.id == 5));
    }

    #[test]
    fn test_find_user_not_found() {
        let db = temp_db();
        let user = db.find_user("nonexistent").unwrap();
        assert!(user.is_none());
    }

    #[test]
    fn test_load_channel_links() {
        let db = temp_db();
        let links = db.load_channel_links().unwrap();
        assert!(links.is_empty());
    }
}
