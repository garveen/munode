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
    ///
    /// The `edge_id` parameter is reserved for future use (e.g., generating
    /// edge-scoped IDs or for routing hints).  It is currently not used in
    /// ID generation, which is a single global monotonic counter.
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

    /// Get all sessions belonging to a specific user.
    pub async fn get_sessions_by_user(&self, user_id: u32) -> Vec<SessionInfo> {
        self.sessions
            .read()
            .await
            .values()
            .filter(|s| s.user_id == user_id)
            .cloned()
            .collect()
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

    /// Return the total number of active sessions.
    pub async fn count_sessions(&self) -> usize {
        self.sessions.read().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_session(sid: u32, edge_id: u32, username: &str, channel_id: u32) -> SessionInfo {
        SessionInfo {
            session_id: sid,
            edge_id,
            user_id: sid * 10,
            username: username.to_string(),
            channel_id,
            groups: vec![],
            cert_hash: String::new(),
            mute: false,
            deaf: false,
            suppress: false,
            self_mute: false,
            self_deaf: false,
            priority_speaker: false,
            recording: false,
        }
    }

    #[tokio::test]
    async fn test_allocate_session_id() {
        let mgr = SessionManager::new();
        let id1 = mgr.allocate_session_id(1);
        let id2 = mgr.allocate_session_id(1);
        let id3 = mgr.allocate_session_id(2);
        assert_ne!(id1, id2);
        assert_ne!(id2, id3);
    }

    #[tokio::test]
    async fn test_add_remove_session() {
        let mgr = SessionManager::new();
        let session = make_session(1, 1, "alice", 0);
        mgr.add_session(session).await;

        assert!(mgr.get_session(1).await.is_some());
        assert_eq!(mgr.get_all_sessions().await.len(), 1);

        let removed = mgr.remove_session(1).await;
        assert!(removed.is_some());
        assert_eq!(removed.unwrap().username, "alice");
        assert!(mgr.get_session(1).await.is_none());
    }

    #[tokio::test]
    async fn test_get_sessions_by_edge() {
        let mgr = SessionManager::new();
        mgr.add_session(make_session(1, 1, "alice", 0)).await;
        mgr.add_session(make_session(2, 1, "bob", 0)).await;
        mgr.add_session(make_session(3, 2, "charlie", 0)).await;

        let edge1 = mgr.get_sessions_by_edge(1).await;
        assert_eq!(edge1.len(), 2);

        let edge2 = mgr.get_sessions_by_edge(2).await;
        assert_eq!(edge2.len(), 1);
    }

    #[tokio::test]
    async fn test_move_user_to_channel() {
        let mgr = SessionManager::new();
        mgr.add_session(make_session(1, 1, "alice", 0)).await;

        assert!(mgr.move_user_to_channel(1, 5).await);
        let session = mgr.get_session(1).await.unwrap();
        assert_eq!(session.channel_id, 5);

        assert!(!mgr.move_user_to_channel(99, 5).await);
    }

    #[tokio::test]
    async fn test_get_sessions_by_user() {
        let mgr = SessionManager::new();
        // Two sessions with the same user_id (100)
        let mut s1 = make_session(1, 1, "alice", 0);
        s1.user_id = 100;
        let mut s2 = make_session(2, 2, "alice", 0);
        s2.user_id = 100;
        // One session with a different user_id
        let mut s3 = make_session(3, 1, "bob", 0);
        s3.user_id = 200;
        mgr.add_session(s1).await;
        mgr.add_session(s2).await;
        mgr.add_session(s3).await;

        let user100 = mgr.get_sessions_by_user(100).await;
        assert_eq!(user100.len(), 2);

        let user200 = mgr.get_sessions_by_user(200).await;
        assert_eq!(user200.len(), 1);

        let user999 = mgr.get_sessions_by_user(999).await;
        assert_eq!(user999.len(), 0);
    }
}
