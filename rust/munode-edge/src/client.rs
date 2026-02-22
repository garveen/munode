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
