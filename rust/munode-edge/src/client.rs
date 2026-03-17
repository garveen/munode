use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bytes::BytesMut;
use prost::Message;
use tokio::sync::{mpsc, RwLock};
use tracing::warn;

use munode_protocol::message_type::MessageType;
use munode_protocol::transport::encode_message;

use crate::bandwidth::BandwidthRecord;
use crate::crypto::CryptState;

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
    /// Whether this client supports Opus codec.
    pub opus_supported: bool,
    /// Channels this client is listening to (beyond their current channel).
    pub listening_channels: Vec<u32>,
    /// Per-channel volume adjustments for listened channels.
    /// Maps channel_id → volume factor (0.0–10.0, default 1.0).
    pub listening_volume_adjustments: HashMap<u32, f32>,
    /// SHA-256 hash of this user's texture blob (if any).
    /// Broadcast to peers so they can request the full texture via RequestBlob.
    pub texture_hash: Option<Vec<u8>>,
    /// SHA-256 hash of this user's comment blob (if comment is > 128 bytes).
    /// Broadcast to peers so they can request the full comment via RequestBlob.
    pub comment_hash: Option<Vec<u8>>,
    /// Client version number (from Version message).
    pub client_version: Option<u32>,
    /// Client release string (from Version message).
    pub client_release: String,
    /// Client OS string (from Version message).
    pub client_os: String,
    /// Client OS version string (from Version message).
    pub client_os_version: String,
    /// Positional audio context (game plugin context).
    /// When set, voice is only routed to users with the same context.
    pub plugin_context: Vec<u8>,
}

/// Manages all connected clients and their message senders.
pub struct ClientManager {
    clients: RwLock<HashMap<u32, ClientInfo>>,
    senders: RwLock<HashMap<u32, ClientSender>>,
    channel_users: RwLock<HashMap<u32, Vec<u32>>>,
    /// Per-session OCB2-AES128 cryptographic states.
    crypt_states: RwLock<HashMap<u32, Arc<Mutex<CryptState>>>>,
    /// Per-session voice bandwidth records. Keyed by session_id.
    bandwidth_records: RwLock<HashMap<u32, BandwidthRecord>>,
    /// Listening index: channel_id → Vec<session_id> of clients listening to
    /// that channel but whose primary channel is different.  This is maintained
    /// in sync with `clients.listening_channels` to provide O(1) lookup instead
    /// of the O(N clients) linear scan that `get_listening_sessions` previously did.
    listening_index: RwLock<HashMap<u32, Vec<u32>>>,
}

impl ClientManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            clients: RwLock::new(HashMap::new()),
            senders: RwLock::new(HashMap::new()),
            channel_users: RwLock::new(HashMap::new()),
            crypt_states: RwLock::new(HashMap::new()),
            bandwidth_records: RwLock::new(HashMap::new()),
            listening_index: RwLock::new(HashMap::new()),
        })
    }

    /// Register a new client with a given session ID and sender.
    pub async fn add_client(&self, client: ClientInfo, sender: ClientSender) {
        let session = client.session;
        let channel_id = client.channel_id;
        // Update listening_index for any pre-configured listening channels
        if !client.listening_channels.is_empty() {
            let mut idx = self.listening_index.write().await;
            for &ch in &client.listening_channels {
                idx.entry(ch).or_default().push(session);
            }
        }
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
    /// Also keeps the listening_index in sync when listening_channels changes.
    pub async fn update_client(&self, client: ClientInfo) {
        let session = client.session;
        let new_listening = client.listening_channels.clone();
        {
            let mut clients = self.clients.write().await;
            let old_listening = clients
                .get(&session)
                .map(|c| c.listening_channels.clone())
                .unwrap_or_default();
            clients.insert(session, client);

            // Update listening_index for changed channels
            if old_listening != new_listening {
                drop(clients); // release write lock before taking listening_index write
                let mut idx = self.listening_index.write().await;
                // Remove from channels no longer listened to
                for ch in &old_listening {
                    if !new_listening.contains(ch) {
                        if let Some(sessions) = idx.get_mut(ch) {
                            sessions.retain(|&s| s != session);
                        }
                    }
                }
                // Add to newly listened channels
                for ch in &new_listening {
                    if !old_listening.contains(ch) {
                        idx.entry(*ch).or_default().push(session);
                    }
                }
                return;
            }
        }
    }

    /// Remove a client by session ID.
    pub async fn remove_client(&self, session: u32) -> Option<ClientInfo> {
        self.senders.write().await.remove(&session);
        self.crypt_states.write().await.remove(&session);
        self.bandwidth_records.write().await.remove(&session);
        let client = self.clients.write().await.remove(&session);
        if let Some(ref c) = client {
            if let Some(users) = self.channel_users.write().await.get_mut(&c.channel_id) {
                users.retain(|&s| s != session);
            }
            // Remove from listening_index
            if !c.listening_channels.is_empty() {
                let mut idx = self.listening_index.write().await;
                for ch in &c.listening_channels {
                    if let Some(sessions) = idx.get_mut(ch) {
                        sessions.retain(|&s| s != session);
                        // Remove the entry entirely when the Vec is empty to prevent
                        // unbounded growth of the listening_index map.
                        if sessions.is_empty() {
                            idx.remove(ch);
                        }
                    }
                }
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

    /// Batch voice dispatch target lookup for local UDP delivery.
    ///
    /// For each session in `channels` (excluding `exclude_session`), returns a tuple
    /// `(session, is_deaf, Option<Arc<Mutex<CryptState>>>)` in a **single pair of
    /// lock acquisitions** (`clients.read` + `crypt_states.read`), rather than the
    /// prior N×2 per-session lock pattern.
    ///
    /// The caller is responsible for the actual UDP send (which happens outside any lock).
    pub async fn get_channel_voice_targets(
        &self,
        channels: &[u32],
        exclude_session: u32,
    ) -> Vec<(u32, bool, Option<Arc<Mutex<CryptState>>>)> {
        let sessions: Vec<u32> = {
            let ch_users = self.channel_users.read().await;
            channels
                .iter()
                .flat_map(|ch| {
                    ch_users
                        .get(ch)
                        .map(|v| v.as_slice())
                        .unwrap_or(&[])
                        .iter()
                        .copied()
                })
                .filter(|&s| s != exclude_session)
                .collect()
        };

        if sessions.is_empty() {
            return Vec::new();
        }

        let clients = self.clients.read().await;
        let crypt_states = self.crypt_states.read().await;

        sessions
            .into_iter()
            .map(|s| {
                let is_deaf = clients
                    .get(&s)
                    .map(|c| c.deaf || c.self_deaf)
                    .unwrap_or(false);
                let cs = crypt_states.get(&s).cloned();
                (s, is_deaf, cs)
            })
            .collect()
    }

    /// Batch voice dispatch target lookup including listening clients.
    ///
    /// Like `get_channel_voice_targets` but also includes sessions listening to
    /// the given channels (via `listening_index`), excluding `exclude_session`.
    pub async fn get_channel_voice_targets_with_listeners(
        &self,
        channels: &[u32],
        exclude_session: u32,
    ) -> Vec<(u32, bool, Option<Arc<Mutex<CryptState>>>)> {
        let sessions: Vec<u32> = {
            let ch_users = self.channel_users.read().await;
            let listen_idx = self.listening_index.read().await;
            let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
            let mut result = Vec::new();
            for &ch in channels {
                // Channel members
                if let Some(members) = ch_users.get(&ch) {
                    for &s in members {
                        if s != exclude_session && seen.insert(s) {
                            result.push(s);
                        }
                    }
                }
                // Listeners for this channel (from index — O(listeners) not O(all clients))
                if let Some(listeners) = listen_idx.get(&ch) {
                    for &s in listeners {
                        if s != exclude_session && seen.insert(s) {
                            result.push(s);
                        }
                    }
                }
            }
            result
        };

        if sessions.is_empty() {
            return Vec::new();
        }

        let clients = self.clients.read().await;
        let crypt_states = self.crypt_states.read().await;

        sessions
            .into_iter()
            .map(|s| {
                let is_deaf = clients
                    .get(&s)
                    .map(|c| c.deaf || c.self_deaf)
                    .unwrap_or(false);
                let cs = crypt_states.get(&s).cloned();
                (s, is_deaf, cs)
            })
            .collect()
    }
    /// Store a CryptState for a session.
    pub async fn set_crypt_state(&self, session: u32, state: CryptState) {
        self.crypt_states
            .write()
            .await
            .insert(session, Arc::new(Mutex::new(state)));
    }

    /// Get the CryptState handle for a session (shared, lockable).
    pub async fn get_crypt_state(&self, session: u32) -> Option<Arc<Mutex<CryptState>>> {
        self.crypt_states.read().await.get(&session).cloned()
    }

    /// Restore a previously-saved CryptState Arc directly (used when re-adding a
    /// client after a channel move so the existing crypto session is preserved).
    pub async fn restore_crypt_state(&self, session: u32, state: Arc<Mutex<CryptState>>) {
        self.crypt_states.write().await.insert(session, state);
    }

    /// Update the decrypt IV for a session (called on CryptSetup resync).
    pub async fn update_decrypt_iv(&self, session: u32, client_nonce: &[u8; 16]) {
        if let Some(arc) = self.crypt_states.read().await.get(&session) {
            arc.lock().unwrap().update_decrypt_iv(client_nonce);
        }
    }

    /// Get the current encrypt IV for a session (to send in CryptSetup resync response).
    pub async fn get_encrypt_iv(&self, session: u32) -> Option<Vec<u8>> {
        self.crypt_states
            .read()
            .await
            .get(&session)
            .map(|arc| arc.lock().unwrap().encrypt_iv.to_vec())
    }

    /// Get all sessions that have a CryptState registered (i.e., have completed login).
    pub async fn get_authenticated_sessions(&self) -> Vec<u32> {
        self.crypt_states.read().await.keys().copied().collect()
    }

    /// Record a voice frame for the given session, returning `false` if it should
    /// be dropped because it exceeds `max_bytes_per_sec`.
    ///
    /// The bandwidth record is created with `window_secs` slots on first access.
    pub async fn record_voice_bytes(
        &self,
        session: u32,
        bytes: u32,
        max_bytes_per_sec: u32,
        window_secs: usize,
    ) -> bool {
        let mut records = self.bandwidth_records.write().await;
        let record = records
            .entry(session)
            .or_insert_with(|| BandwidthRecord::new(window_secs));
        // If `rolling_stats_window` was hot-reloaded to a different size,
        // recreate the record so it uses the updated window length.
        if record.window_secs() != crate::bandwidth::effective_window(window_secs) {
            *record = BandwidthRecord::new(window_secs);
        }
        record.add_frame(bytes, max_bytes_per_sec)
    }

    /// Return the bytes-per-second in the most recently completed second for a session.
    /// Returns `0` if no bandwidth data has been recorded.
    pub async fn get_bandwidth_stats(&self, session: u32) -> u32 {
        let records = self.bandwidth_records.read().await;
        match records.get(&session) {
            Some(r) => r.bytes_last_second(),
            None => 0,
        }
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

    /// Get all sessions that are currently listening to the given channel.
    /// Uses the O(1) listening_index for fast lookup instead of scanning all clients.
    pub async fn get_listening_sessions(&self, channel_id: u32) -> Vec<u32> {
        self.listening_index
            .read()
            .await
            .get(&channel_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Count how many local clients are currently listening to the given channel.
    pub async fn get_listening_count(&self, channel_id: u32) -> u32 {
        self.listening_index
            .read()
            .await
            .get(&channel_id)
            .map(|v| v.len() as u32)
            .unwrap_or(0)
    }

    /// Count how many local clients are currently in the given channel.
    pub async fn count_in_channel(&self, channel_id: u32) -> u32 {
        self.clients
            .read()
            .await
            .values()
            .filter(|c| c.channel_id == channel_id)
            .count() as u32
    }

    /// Update the plugin_context for a session.
    pub async fn update_plugin_context(&self, session_id: u32, ctx: Vec<u8>) {
        let mut clients = self.clients.write().await;
        if let Some(client) = clients.get_mut(&session_id) {
            client.plugin_context = ctx;
        }
    }

    /// Send a Reject message to all connected clients and close their connections.
    ///
    /// Used when Hub becomes completely unreachable (direct + relay both failed).
    /// After sending the message, all sender channels are dropped so the writer
    /// tasks exit and TLS connections are closed from the server side.
    pub async fn close_all_connections(&self, reason: &str) {
        use munode_protocol::mumbleproto;
        let reject = mumbleproto::Reject {
            r#type: Some(mumbleproto::reject::RejectType::None as i32),
            reason: Some(reason.to_string()),
        };
        let mut buf = BytesMut::new();
        encode_message(MessageType::Reject, &reject, &mut buf);
        let data = buf.to_vec();

        let mut senders = self.senders.write().await;
        for sender in senders.values() {
            // Best-effort send; ignore errors since we are about to drop the channel anyway.
            sender.send_raw(data.clone()).await;
        }
        // Dropping all senders causes the per-client writer tasks to receive None from
        // recv() and exit, which closes the write half of each TLS stream.  The client's
        // read half will then get EOF, the connection handler task will break out of its
        // read loop and run the normal cleanup path (remove_client, notify Hub, etc.).
        senders.clear();
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
            opus_supported: true,
            listening_channels: vec![],
            listening_volume_adjustments: HashMap::new(),
            texture_hash: None,
            comment_hash: None,
            client_version: None,
            client_release: String::new(),
            client_os: String::new(),
            client_os_version: String::new(),
            plugin_context: vec![],
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

    #[tokio::test]
    async fn test_record_voice_bytes_enforces_cap() {
        let mgr = ClientManager::new();
        let session = 42u32;
        let cap = 500u32;
        let frame_bytes = 100u32;

        // Loop sending small frames until the cap is exceeded.  All iterations
        // complete in microseconds, so no slot boundary is ever crossed and the
        // test is deterministic regardless of system load or scheduling jitter.
        let max_iters = cap / frame_bytes + 2; // slightly more than needed
        let mut accepted = 0u32;
        let mut dropped = false;
        for _ in 0..max_iters {
            if mgr.record_voice_bytes(session, frame_bytes, cap, 60).await {
                accepted += 1;
            } else {
                dropped = true;
                break;
            }
        }

        assert!(dropped, "cap of {cap} bps should have been exceeded within {max_iters} frames");
        // At most cap/frame_bytes frames should have been accepted before the cap was hit.
        assert!(
            accepted <= cap / frame_bytes,
            "accepted {accepted} frames before drop; expected at most {}",
            cap / frame_bytes
        );
    }

    #[tokio::test]
    async fn test_record_voice_bytes_no_cap() {
        let mgr = ClientManager::new();
        let session = 99u32;

        // cap = 0 means unlimited — all frames should be accepted.
        for _ in 0..10 {
            assert!(
                mgr.record_voice_bytes(session, 10_000, 0, 60).await,
                "unlimited cap should always accept"
            );
        }
    }

    #[tokio::test]
    async fn test_record_voice_bytes_window_resize() {
        use crate::bandwidth::effective_window;

        let mgr = ClientManager::new();
        let session = 7u32;

        // Seed an initial record with a 60-s window.
        mgr.record_voice_bytes(session, 100, 0, 60).await;

        // Verify the record has the expected window before resizing.
        {
            let records = mgr.bandwidth_records.read().await;
            assert_eq!(
                records.get(&session).expect("bandwidth record should exist after recording frames").window_secs(),
                effective_window(60),
                "initial window should be 60 slots"
            );
        }

        // Calling record_voice_bytes with a different window_secs should
        // recreate the BandwidthRecord with the new window size.
        mgr.record_voice_bytes(session, 100, 0, 120).await;

        {
            let records = mgr.bandwidth_records.read().await;
            assert_eq!(
                records.get(&session).expect("bandwidth record should exist after window resize").window_secs(),
                effective_window(120),
                "window should be updated to 120 slots after hot-reload"
            );
        }
    }
}
