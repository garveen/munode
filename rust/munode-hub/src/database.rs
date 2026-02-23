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
                description TEXT NOT NULL DEFAULT '',
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
                channel_id INTEGER NOT NULL,
                user_id INTEGER,
                group_name TEXT,
                apply_here INTEGER NOT NULL DEFAULT 1,
                apply_subs INTEGER NOT NULL DEFAULT 1,
                allow INTEGER NOT NULL DEFAULT 0,
                deny INTEGER NOT NULL DEFAULT 0
            );"
        )?;

        // Ensure root channel exists (id=0, name="Root")
        let root_exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM channels WHERE id = 0",
            [],
            |row| row.get(0),
        )?;

        if !root_exists {
            conn.execute(
                "INSERT INTO channels (id, parent_id, name, description, position, max_users, temporary, inherit_acl)
                 VALUES (0, NULL, 'Root', '', 0, 0, 0, 1)",
                [],
            )?;
            info!("Created root channel (id=0)");
        }

        Ok(())
    }

    /// Load all channels from the database.
    pub fn load_channels(&self) -> Result<Vec<DbChannelRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, name, description, position, max_users, temporary, inherit_acl FROM channels"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DbChannelRecord {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get::<_, String>(3).unwrap_or_default(),
                position: row.get(4)?,
                max_users: row.get(5)?,
                temporary: row.get::<_, i32>(6)? != 0,
                inherit_acl: row.get::<_, i32>(7)? != 0,
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
            "INSERT OR REPLACE INTO channels (id, parent_id, name, description, position, max_users, temporary, inherit_acl)
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

    /// Update the last channel for a user.
    pub fn save_user_last_channel(&self, user_id: u32, channel_id: u32) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET last_channel = ?1 WHERE id = ?2",
            params![channel_id, user_id],
        )?;
        Ok(())
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
