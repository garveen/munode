use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use bytes::BytesMut;
use prost::Message;
use tokio::sync::{mpsc, RwLock};
use tracing::warn;

use munode_protocol::message_type::MessageType;
use munode_protocol::transport::encode_message;

/// Client connection state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientState {
    Connected,
    Authenticated,
    Ready,
    Disconnected,
}

/// A handle for sending messages to a client's TLS connection.
#[derive(Clone)]
pub struct ClientSender {
    tx: mpsc::Sender<Vec<u8>>,
}

impl ClientSender {
    pub fn new(tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self { tx }
    }

    /// Send raw bytes to the client.
    pub async fn send_raw(&self, data: Vec<u8>) -> bool {
        self.tx.send(data).await.is_ok()
    }

    /// Encode and send a Mumble protocol message.
    pub async fn send_message<M: Message>(&self, msg_type: MessageType, message: &M) -> bool {
        let mut buf = BytesMut::new();
        encode_message(msg_type, message, &mut buf);
        self.send_raw(buf.to_vec()).await
    }
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

/// Manages all connected clients and their message senders.
pub struct ClientManager {
    clients: RwLock<HashMap<u32, ClientInfo>>,
    senders: RwLock<HashMap<u32, ClientSender>>,
    channel_users: RwLock<HashMap<u32, Vec<u32>>>,
}

impl ClientManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            clients: RwLock::new(HashMap::new()),
            senders: RwLock::new(HashMap::new()),
            channel_users: RwLock::new(HashMap::new()),
        })
    }

    /// Register a new client with a given session ID and sender.
    pub async fn add_client(&self, client: ClientInfo, sender: ClientSender) {
        let session = client.session;
        let channel_id = client.channel_id;
        self.senders.write().await.insert(session, sender);
        self.clients.write().await.insert(session, client);
        self.channel_users
            .write()
            .await
            .entry(channel_id)
            .or_default()
            .push(session);
    }

    /// Update a client's info (without changing the sender).
    pub async fn update_client(&self, client: ClientInfo) {
        let session = client.session;
        self.clients.write().await.insert(session, client);
    }

    /// Remove a client by session ID.
    pub async fn remove_client(&self, session: u32) -> Option<ClientInfo> {
        self.senders.write().await.remove(&session);
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

    /// Get a sender for a specific client.
    pub async fn get_sender(&self, session: u32) -> Option<ClientSender> {
        self.senders.read().await.get(&session).cloned()
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

    /// Broadcast a Mumble protocol message to all authenticated clients.
    pub async fn broadcast<M: Message>(&self, msg_type: MessageType, message: &M, exclude_session: Option<u32>) {
        let mut buf = BytesMut::new();
        encode_message(msg_type, message, &mut buf);
        let data = buf.to_vec();

        let senders = self.senders.read().await;
        let clients = self.clients.read().await;
        for (&session, sender) in senders.iter() {
            if Some(session) == exclude_session {
                continue;
            }
            if let Some(client) = clients.get(&session) {
                if client.state == ClientState::Ready {
                    if !sender.send_raw(data.clone()).await {
                        warn!("Failed to send broadcast to session {}", session);
                    }
                }
            }
        }
    }

    /// Broadcast a Mumble protocol message to clients in a specific channel.
    pub async fn broadcast_to_channel<M: Message>(
        &self,
        channel_id: u32,
        msg_type: MessageType,
        message: &M,
        exclude_session: Option<u32>,
    ) {
        let mut buf = BytesMut::new();
        encode_message(msg_type, message, &mut buf);
        let data = buf.to_vec();

        let sessions = self.get_channel_sessions(channel_id).await;
        let senders = self.senders.read().await;
        let clients = self.clients.read().await;
        for session in sessions {
            if Some(session) == exclude_session {
                continue;
            }
            if let Some(client) = clients.get(&session) {
                if client.state == ClientState::Ready {
                    if let Some(sender) = senders.get(&session) {
                        if !sender.send_raw(data.clone()).await {
                            warn!("Failed to send channel broadcast to session {}", session);
                        }
                    }
                }
            }
        }
    }

    /// Send a message to a specific client.
    pub async fn send_to<M: Message>(&self, session: u32, msg_type: MessageType, message: &M) -> bool {
        let mut buf = BytesMut::new();
        encode_message(msg_type, message, &mut buf);
        if let Some(sender) = self.senders.read().await.get(&session) {
            sender.send_raw(buf.to_vec()).await
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use munode_protocol::mumbleproto;

    fn make_test_client(session: u32, channel: u32) -> ClientInfo {
        ClientInfo {
            session,
            user_id: session * 10,
            username: format!("user{}", session),
            channel_id: channel,
            state: ClientState::Ready,
            mute: false,
            deaf: false,
            suppress: false,
            self_mute: false,
            self_deaf: false,
            priority_speaker: false,
            recording: false,
            ip_address: "127.0.0.1".to_string(),
            connected_at: Instant::now(),
            last_active: Instant::now(),
            cert_hash: None,
            groups: vec![],
        }
    }

    #[tokio::test]
    async fn test_add_remove_client() {
        let mgr = ClientManager::new();
        let (tx, _rx) = mpsc::channel(16);
        let sender = ClientSender::new(tx);

        let client = make_test_client(1, 0);
        mgr.add_client(client, sender).await;
        assert_eq!(mgr.client_count().await, 1);
        assert!(mgr.get_client(1).await.is_some());

        let removed = mgr.remove_client(1).await;
        assert!(removed.is_some());
        assert_eq!(mgr.client_count().await, 0);
    }

    #[tokio::test]
    async fn test_channel_sessions() {
        let mgr = ClientManager::new();
        let (tx1, _rx1) = mpsc::channel(16);
        let (tx2, _rx2) = mpsc::channel(16);

        mgr.add_client(make_test_client(1, 0), ClientSender::new(tx1)).await;
        mgr.add_client(make_test_client(2, 0), ClientSender::new(tx2)).await;

        let sessions = mgr.get_channel_sessions(0).await;
        assert_eq!(sessions.len(), 2);
        assert!(sessions.contains(&1));
        assert!(sessions.contains(&2));
    }

    #[tokio::test]
    async fn test_broadcast_sends_to_ready_clients() {
        let mgr = ClientManager::new();
        let (tx1, mut rx1) = mpsc::channel(16);
        let (tx2, mut rx2) = mpsc::channel(16);

        let mut c1 = make_test_client(1, 0);
        c1.state = ClientState::Ready;
        let mut c2 = make_test_client(2, 0);
        c2.state = ClientState::Ready;

        mgr.add_client(c1, ClientSender::new(tx1)).await;
        mgr.add_client(c2, ClientSender::new(tx2)).await;

        let ping = mumbleproto::Ping {
            timestamp: Some(12345),
            ..Default::default()
        };
        mgr.broadcast(MessageType::Ping, &ping, Some(1)).await;

        // rx1 should not receive (excluded)
        assert!(rx1.try_recv().is_err());
        // rx2 should receive
        let data = rx2.try_recv().unwrap();
        assert!(!data.is_empty());
    }

    #[tokio::test]
    async fn test_send_to_specific_client() {
        let mgr = ClientManager::new();
        let (tx, mut rx) = mpsc::channel(16);

        let client = make_test_client(1, 0);
        mgr.add_client(client, ClientSender::new(tx)).await;

        let ping = mumbleproto::Ping {
            timestamp: Some(42),
            ..Default::default()
        };
        let sent = mgr.send_to(1, MessageType::Ping, &ping).await;
        assert!(sent);

        let data = rx.try_recv().unwrap();
        assert!(!data.is_empty());
    }

    #[tokio::test]
    async fn test_update_client() {
        let mgr = ClientManager::new();
        let (tx, _rx) = mpsc::channel(16);
        let sender = ClientSender::new(tx);

        let mut client = make_test_client(1, 0);
        mgr.add_client(client.clone(), sender).await;

        client.self_mute = true;
        mgr.update_client(client).await;

        let updated = mgr.get_client(1).await.unwrap();
        assert!(updated.self_mute);
    }
}
