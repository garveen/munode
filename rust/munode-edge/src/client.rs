use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::RwLock;

/// Client connection state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientState {
    Connected,
    Authenticated,
    Ready,
    Disconnected,
}

/// Information about a connected client.
#[derive(Debug, Clone)]
pub struct ClientInfo {
    pub session: u32,
    pub user_id: u32,
    pub username: String,
    pub channel_id: u32,
    pub state: ClientState,
    pub mute: bool,
    pub deaf: bool,
    pub suppress: bool,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub priority_speaker: bool,
    pub recording: bool,
    pub ip_address: String,
    pub connected_at: Instant,
    pub last_active: Instant,
    pub cert_hash: Option<String>,
    pub groups: Vec<String>,
}

/// Manages all connected clients.
pub struct ClientManager {
    clients: RwLock<HashMap<u32, ClientInfo>>,
    channel_users: RwLock<HashMap<u32, Vec<u32>>>,
}

impl ClientManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            clients: RwLock::new(HashMap::new()),
            channel_users: RwLock::new(HashMap::new()),
        })
    }

    /// Register a new client with a given session ID.
    pub async fn add_client(&self, client: ClientInfo) {
        let session = client.session;
        let channel_id = client.channel_id;
        self.clients.write().await.insert(session, client);
        self.channel_users
            .write()
            .await
            .entry(channel_id)
            .or_default()
            .push(session);
    }

    /// Remove a client by session ID.
    pub async fn remove_client(&self, session: u32) -> Option<ClientInfo> {
        let client = self.clients.write().await.remove(&session);
        if let Some(ref c) = client {
            if let Some(users) = self.channel_users.write().await.get_mut(&c.channel_id) {
                users.retain(|&s| s != session);
            }
        }
        client
    }

    /// Get a client by session ID.
    pub async fn get_client(&self, session: u32) -> Option<ClientInfo> {
        self.clients.read().await.get(&session).cloned()
    }

    /// Get the number of connected clients.
    pub async fn client_count(&self) -> usize {
        self.clients.read().await.len()
    }

    /// Get all sessions in a channel.
    pub async fn get_channel_sessions(&self, channel_id: u32) -> Vec<u32> {
        self.channel_users
            .read()
            .await
            .get(&channel_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Get all connected clients.
    pub async fn get_all_clients(&self) -> Vec<ClientInfo> {
        self.clients.read().await.values().cloned().collect()
    }

    /// Get all session IDs.
    pub async fn get_all_sessions(&self) -> Vec<u32> {
        self.clients.read().await.keys().copied().collect()
    }

    /// Update client state.
    pub async fn set_client_state(&self, session: u32, state: ClientState) {
        if let Some(client) = self.clients.write().await.get_mut(&session) {
            client.state = state;
        }
    }
}
