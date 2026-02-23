use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

use tokio::sync::RwLock;

/// Information about an active session.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: u32,
    pub edge_id: u32,
    pub user_id: u32,
    pub username: String,
    pub channel_id: u32,
    pub groups: Vec<String>,
    pub cert_hash: String,
    pub mute: bool,
    pub deaf: bool,
    pub suppress: bool,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub priority_speaker: bool,
    pub recording: bool,
}

/// Manages globally-unique session IDs and tracks active sessions.
pub struct SessionManager {
    next_id: AtomicU32,
    sessions: RwLock<HashMap<u32, SessionInfo>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Allocate the next unique session ID.
    pub fn allocate_session_id(&self, _edge_id: u32) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Add a session to the registry.
    pub async fn add_session(&self, info: SessionInfo) {
        self.sessions.write().await.insert(info.session_id, info);
    }

    /// Remove a session by ID. Returns the removed session if it existed.
    pub async fn remove_session(&self, session_id: u32) -> Option<SessionInfo> {
        self.sessions.write().await.remove(&session_id)
    }

    /// Get a clone of a session by ID.
    pub async fn get_session(&self, session_id: u32) -> Option<SessionInfo> {
        self.sessions.read().await.get(&session_id).cloned()
    }

    /// Get all active sessions.
    pub async fn get_all_sessions(&self) -> Vec<SessionInfo> {
        self.sessions.read().await.values().cloned().collect()
    }

    /// Get all sessions belonging to a specific edge.
    pub async fn get_sessions_by_edge(&self, edge_id: u32) -> Vec<SessionInfo> {
        self.sessions
            .read()
            .await
            .values()
            .filter(|s| s.edge_id == edge_id)
            .cloned()
            .collect()
    }

    /// Move a user to a new channel. Returns true if the session was found and updated.
    pub async fn move_user_to_channel(&self, session_id: u32, channel_id: u32) -> bool {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            session.channel_id = channel_id;
            true
        } else {
            false
        }
    }
}
