use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use tracing::info;

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

        // Add cert_hash to bans table if missing (migration from older schema)
        let bans_has_cert_hash: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('bans') WHERE name = 'cert_hash'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if !bans_has_cert_hash {
            conn.execute_batch(
                "ALTER TABLE bans ADD COLUMN cert_hash TEXT NOT NULL DEFAULT '';"
            )?;
            info!("Migrated bans table: added 'cert_hash' column");
        }

        // Add start_time to bans table if missing (TS schema uses 'start')
        let bans_has_start_time: bool = {
            let mut col_stmt = conn.prepare(
                "SELECT COUNT(*) FROM pragma_table_info('bans') WHERE name = 'start_time'"
            )?;
            col_stmt.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
        };
        if !bans_has_start_time {
            // Copy from 'start' column if present, otherwise default to 0
            let has_start: bool = {
                let mut s = conn.prepare(
                    "SELECT COUNT(*) FROM pragma_table_info('bans') WHERE name = 'start'"
                )?;
                s.query_row([], |row| row.get(0)).unwrap_or(0i64) > 0
            };
            if has_start {
                conn.execute_batch(
                    "ALTER TABLE bans ADD COLUMN start_time INTEGER NOT NULL DEFAULT 0;
                     UPDATE bans SET start_time = COALESCE(start, 0);"
                )?;
            } else {
                conn.execute_batch(
                    "ALTER TABLE bans ADD COLUMN start_time INTEGER NOT NULL DEFAULT 0;"
                )?;
            }
            info!("Migrated bans table: added 'start_time' column");
        }

        // Create blob storage tables
        Self::init_blob_tables(&conn)?;

        // Create schema_versions table (used by the migrate subcommand)
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_versions (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at INTEGER NOT NULL DEFAULT 0
            );"
        )?;

        Ok(())
    }

    // ── Migration tool support ─────────────────────────────────────────────

    /// Returns the highest applied schema version, or 0 if no migrations recorded.
    pub fn schema_version(&self) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let version: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_versions",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(version)
    }

    /// Return all applied migrations as `(version, description, applied_at_unix_secs)`.
    pub fn list_migrations(&self) -> Result<Vec<(u32, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT version, description, applied_at FROM schema_versions ORDER BY version"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// Record a migration as applied.
    fn record_migration(&self, conn: &rusqlite::Connection, version: u32, description: &str) -> Result<()> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        conn.execute(
            "INSERT OR REPLACE INTO schema_versions (version, description, applied_at) VALUES (?1, ?2, ?3)",
            params![version, description, now],
        )?;
        Ok(())
    }

    /// Apply all pending migrations (those with version > current schema version).
    ///
    /// Returns the list of applied migrations as `(version, description)`.
    pub fn apply_migrations(&self) -> Result<Vec<(u32, String)>> {
        let current = self.schema_version()?;
        let all_migrations = Self::defined_migrations();
        let pending: Vec<_> = all_migrations
            .into_iter()
            .filter(|(v, _, _)| *v > current)
            .collect();

        if pending.is_empty() {
            return Ok(vec![]);
        }

        let conn = self.conn.lock().unwrap();
        let mut applied = Vec::new();
        for (version, description, sql) in &pending {
            conn.execute_batch(sql)
                .with_context(|| format!("Migration v{} ({}) failed", version, description))?;
            self.record_migration(&conn, *version, description)?;
            applied.push((*version, description.to_string()));
            info!("Applied migration v{}: {}", version, description);
        }
        Ok(applied)
    }

    /// The canonical list of all database migrations.
    ///
    /// Each entry is `(version, description, sql)`.  Add new entries at the end.
    /// Versions must be monotonically increasing.
    fn defined_migrations() -> Vec<(u32, &'static str, &'static str)> {
        vec![
            (
                1,
                "Add ext_users table for external authentication",
                "CREATE TABLE IF NOT EXISTS ext_users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE
                );",
            ),
            (
                2,
                "Add user_blobs table for avatar/comment storage",
                "CREATE TABLE IF NOT EXISTS user_blobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    blob_type TEXT NOT NULL,
                    hash TEXT NOT NULL,
                    UNIQUE(user_id, blob_type)
                );",
            ),
            (
                3,
                "Add bans table with full schema",
                "CREATE TABLE IF NOT EXISTS bans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    address BLOB NOT NULL,
                    mask INTEGER NOT NULL DEFAULT 128,
                    name TEXT NOT NULL DEFAULT '',
                    cert_hash TEXT NOT NULL DEFAULT '',
                    reason TEXT NOT NULL DEFAULT '',
                    start_time INTEGER NOT NULL DEFAULT 0,
                    duration INTEGER NOT NULL DEFAULT 0
                );",
            ),
            (
                4,
                "Add schema_versions table",
                "CREATE TABLE IF NOT EXISTS schema_versions (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at INTEGER NOT NULL DEFAULT 0
                );",
            ),
        ]
    }

    // ── Backup support ─────────────────────────────────────────────────────

    /// Create an online backup of the database to `dest_path` using SQLite's
    /// backup API (via VACUUM INTO, which produces a clean, compacted copy).
    pub fn backup_to(&self, dest_path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(&format!("VACUUM INTO '{}'", dest_path.replace('\'', "''")))?;
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

    /// Check if an IP address (as 16-byte IPv6-mapped) is currently banned.
    /// Returns the matching active `BanRecord` if banned, or `None` if not banned.
    pub fn check_ip_banned(&self, ip_bytes: &[u8; 16]) -> Result<Option<BanRecord>> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        // Only load active (non-expired) bans from the database.
        // duration=0 means permanent; duration>0 bans must not have expired.
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, address, mask, name, cert_hash, reason, start_time, duration
               FROM bans
              WHERE duration = 0 OR (start_time + duration) > ?1"
        )?;
        let rows = stmt.query_map(params![now], |row| {
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

        for row in rows {
            let ban = row?;
            if ip_matches_ban(ip_bytes, &ban.address, ban.mask) {
                return Ok(Some(ban));
            }
        }
        Ok(None)
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

    /// Delete a specific ban by its row ID.  Returns `true` if a row was deleted.
    pub fn delete_ban_by_id(&self, id: i64) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute("DELETE FROM bans WHERE id = ?1", params![id])?;
        Ok(count > 0)
    }

    // ==================== Blob Storage (user_blobs hash mapping) ====================

    /// Initialise the user_blobs metadata table.
    /// Blob data itself is stored on the filesystem by `BlobStore`; the database only tracks
    /// which blob hash belongs to each user.
    fn init_blob_tables(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS user_blobs (
                user_id INTEGER NOT NULL,
                blob_type TEXT NOT NULL,
                blob_hash TEXT,
                PRIMARY KEY (user_id, blob_type)
            );"
        )?;
        Ok(())
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

    /// Associate `hash` with a user's blob type in the database.
    /// Call after storing the actual blob data via `BlobStore::put`.
    pub fn set_user_blob_hash(&self, user_id: u32, blob_type: &str, hash: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO user_blobs (user_id, blob_type, blob_hash) VALUES (?1, ?2, ?3)",
            params![user_id, blob_type, hash],
        )?;
        Ok(())
    }
}

/// Check if `ip` (16-byte IPv6-mapped) is covered by a ban entry with address `ban_addr` and
/// prefix length `mask_len` (0–128). Values > 128 are clamped to 128 (i.e., exact-match) since
/// IPv6 addresses are 128 bits; callers must validate inputs at the boundary if strict checking is
/// needed.
pub fn ip_matches_ban(ip: &[u8; 16], ban_addr: &[u8; 16], mask_len: u32) -> bool {
    // Clamp mask to 128 — IPv6 has 128 bits; anything larger is treated as an exact match.
    let mask_bits = mask_len.min(128) as usize;
    let full_bytes = mask_bits / 8;
    let remainder = mask_bits % 8;

    // Compare full bytes
    if ip[..full_bytes] != ban_addr[..full_bytes] {
        return false;
    }

    // Compare the partial byte (if any): shift right to isolate the significant bits
    // (`remainder` = 1..7), then compare the resulting prefix.
    if remainder > 0 && full_bytes < 16 {
        let shift = 8 - remainder;
        let ip_prefix = ip[full_bytes] >> shift;
        let ban_prefix = ban_addr[full_bytes] >> shift;
        if ip_prefix != ban_prefix {
            return false;
        }
    }

    true
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

    #[test]
    fn test_ip_matches_ban_ipv4_exact() {
        // 192.168.1.5 mapped to IPv6: ::ffff:192.168.1.5
        let ip: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 192,168,1,5];
        let ban: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 192,168,1,5];
        assert!(ip_matches_ban(&ip, &ban, 128));
        // Different last byte
        let other: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 192,168,1,6];
        assert!(!ip_matches_ban(&other, &ban, 128));
    }

    #[test]
    fn test_ip_matches_ban_ipv4_cidr24() {
        // Ban 192.168.1.0/120 (IPv6-mapped /120 = IPv4 /24)
        let ban: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 192,168,1,0];
        let ip_in: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 192,168,1,99];
        let ip_out: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 192,168,2,1];
        assert!(ip_matches_ban(&ip_in, &ban, 120));
        assert!(!ip_matches_ban(&ip_out, &ban, 120));
    }

    #[test]
    fn test_ip_matches_ban_zero_mask() {
        // Mask 0 matches everything
        let ban: [u8; 16] = [0u8; 16];
        let ip: [u8; 16] = [1,2,3,4, 5,6,7,8, 9,10,11,12, 13,14,15,16];
        assert!(ip_matches_ban(&ip, &ban, 0));
    }

    #[test]
    fn test_check_ip_banned_active() {
        let db = temp_db();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let ip: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 10,0,0,1];
        let ban = BanRecord {
            id: 0, address: ip, mask: 128,
            name: "test".to_string(), cert_hash: "".to_string(),
            reason: "test ban".to_string(),
            start_time: now,
            duration: 3600, // 1 hour
        };
        db.add_ban(&ban).unwrap();
        let result = db.check_ip_banned(&ip).unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().reason, "test ban");
    }

    #[test]
    fn test_check_ip_banned_expired() {
        let db = temp_db();
        let past = 1000i64; // long past timestamp
        let ip: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 10,0,0,2];
        let ban = BanRecord {
            id: 0, address: ip, mask: 128,
            name: "test".to_string(), cert_hash: "".to_string(),
            reason: "expired ban".to_string(),
            start_time: past,
            duration: 60, // 60s, expired long ago
        };
        db.add_ban(&ban).unwrap();
        let result = db.check_ip_banned(&ip).unwrap();
        assert!(result.is_none(), "Expired ban should not block");
    }

    #[test]
    fn test_check_ip_banned_permanent() {
        let db = temp_db();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let ip: [u8; 16] = [0,0,0,0, 0,0,0,0, 0,0, 0xff,0xff, 10,0,0,3];
        let ban = BanRecord {
            id: 0, address: ip, mask: 128,
            name: "test".to_string(), cert_hash: "".to_string(),
            reason: "permanent ban".to_string(),
            start_time: now, duration: 0, // permanent
        };
        db.add_ban(&ban).unwrap();
        let result = db.check_ip_banned(&ip).unwrap();
        assert!(result.is_some(), "Permanent ban should always block");
    }
}
