use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

use bytes::BytesMut;
use prost::Message;
use tokio::sync::{mpsc, oneshot, RwLock};
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

    /// Non-blocking send: enqueues `data` without waiting.
    ///
    /// Returns `false` if the channel is at capacity (the writer task is behind).
    /// Use this for broadcast operations where skipping a single slow client is
    /// preferable to blocking the caller's read loop — which would prevent it from
    /// responding to TCP Ping messages and cause Mumble's ping-timeout to fire.
    pub fn try_send_raw(&self, data: Vec<u8>) -> bool {
        self.tx.try_send(data).is_ok()
    }

    /// Clone the inner `mpsc::Sender` for storage in a [`crate::hot_slot::HotSlot`].
    pub fn clone_sender(&self) -> mpsc::Sender<Vec<u8>> {
        self.tx.clone()
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

/// Client-reported ping and statistics, updated on every TCP Ping message.
///
/// Stored in a per-session `std::sync::Mutex` so `update_ping_stats` only needs a
/// brief **read** lock on the global `sessions` map (to clone the `Arc`) rather than
/// a **write** lock.  With 400 clients each pinging every 5 s (≈80 writes/s), the
/// former write-lock approach was a frequent source of serialisation that delayed all
/// concurrent reads (voice routing, ping response, etc.).
#[derive(Debug, Default, Clone)]
pub struct PingStats {
    pub udp_packets: u32,
    pub tcp_packets: u32,
    pub udp_ping_avg: f32,
    pub udp_ping_var: f32,
    pub tcp_ping_avg: f32,
    pub tcp_ping_var: f32,
    pub remote_good: u32,
    pub remote_late: u32,
    pub remote_lost: u32,
    pub remote_resync: u32,
}

/// All per-session data stored in a single struct to allow a single RwLock
/// to cover all session-level state.  Previously 5 separate `RwLock<HashMap>`
/// fields caused 6 sequential write-lock acquisitions on `remove_client` and
/// up to 4 separate read-lock acquisitions on the voice hot path.
/// Consolidating to one lock cuts `remove_client` to 2 write locks and the
/// voice hot path to at most 3 read locks.
struct SessionEntry {
    info: ClientInfo,
    /// OCB2-AES128 per-session crypto state.  `None` until CryptSetup.
    crypt_state: Option<Arc<Mutex<CryptState>>>,
    /// Per-session voice bandwidth tracker (independent std::Mutex for lock-free
    /// concurrent per-session accounting without blocking other sessions).
    bandwidth: Arc<Mutex<BandwidthRecord>>,
    /// Kick/ban close-signal.  Sent to make the per-client TCP read loop exit.
    close_signal: Option<oneshot::Sender<()>>,
    /// Per-session ping statistics (updated on every Ping message).
    /// Using a dedicated Mutex allows `update_ping_stats` to hold only a read
    /// lock on `sessions` rather than a write lock, reducing contention.
    ping_stats: Arc<std::sync::Mutex<PingStats>>,
    /// Shared readiness flag.  Set to `true` by `set_client_state(Ready)`.
    /// The same Arc is stored in `ClientManager::sender_registry` so that
    /// `broadcast` can filter by readiness with a single `AtomicBool::load`
    /// — no lock acquisition of any kind.
    ready: Arc<AtomicBool>,
}

/// Manages all connected clients and their message senders.
///
/// Internal layout:
/// - `sessions`         — full per-session state (info, crypto, bw, close-signal)
/// - `sender_registry`  — lightweight send-only registry; `broadcast` reads this
///                        exclusively, so it never competes with `sessions` writes
/// - `channel_users`    — channel_id → member session IDs
/// - `listening_index`  — channel_id → listening session IDs
pub struct ClientManager {
    /// Full per-session state.  Only mutated on connect/disconnect/state-change.
    sessions: RwLock<HashMap<u32, SessionEntry>>,
    /// Lightweight per-session sender registry used exclusively by the broadcast
    /// and targeted-send paths.
    ///
    /// Keyed by session ID; value is `(sender, ready_flag)` where `ready_flag`
    /// is the **same** `Arc<AtomicBool>` stored in `SessionEntry::ready`.
    /// This lets `set_client_state` flip the flag without touching this map,
    /// and lets `broadcast` check readiness with a cheap `AtomicBool::load`
    /// while holding only the lightweight sync read lock.
    ///
    /// Using `std::sync::RwLock` (not async) means reads complete entirely
    /// synchronously — no suspend point, no competition with async state locks.
    sender_registry: std::sync::RwLock<HashMap<u32, (ClientSender, Arc<AtomicBool>)>>,
    /// channel_id → HashSet<session_id>: local clients in each channel.
    channel_users: RwLock<HashMap<u32, HashSet<u32>>>,
    /// channel_id → HashSet<session_id>: local clients *listening* to each channel
    /// (secondary listen, not primary channel).  Maintained in sync with
    /// `SessionEntry::info.listening_channels`.
    listening_index: RwLock<HashMap<u32, HashSet<u32>>>,
}

impl ClientManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: RwLock::new(HashMap::new()),
            sender_registry: std::sync::RwLock::new(HashMap::new()),
            channel_users: RwLock::new(HashMap::new()),
            listening_index: RwLock::new(HashMap::new()),
        })
    }

    /// Register a close-signal sender for a connected client.
    ///
    /// Once registered, [`send_close_signal`] will trigger the signal,
    /// causing the per-client read loop to break and the TCP connection to close.
    pub async fn register_close_signal(
        &self,
        session: u32,
        tx: oneshot::Sender<()>,
    ) {
        if let Some(entry) = self.sessions.write().await.get_mut(&session) {
            entry.close_signal = Some(tx);
        }
    }

    /// Fire the close signal for a session, causing the per-client read loop to
    /// break and the TCP connection to be closed from the server side.
    ///
    /// This is used for kick/ban scenarios. Regular `remove_client` (used for
    /// channel moves and natural disconnects) does NOT fire this signal.
    pub async fn send_close_signal(&self, session: u32) {
        if let Some(entry) = self.sessions.write().await.get_mut(&session) {
            if let Some(tx) = entry.close_signal.take() {
                let _ = tx.send(());
            }
        }
    }

    /// Register a new client with a given session ID and sender.
    pub async fn add_client(&self, client: ClientInfo, sender: ClientSender) {
        let session = client.session;
        let channel_id = client.channel_id;
        let listening = client.listening_channels.clone();
        // Capture voice-routing fields before `client` is moved into SessionEntry.
        let deaf = client.deaf;
        let self_deaf = client.self_deaf;
        let suppress = client.suppress;

        let initial_ready = client.state == ClientState::Ready;
        let ready_flag = Arc::new(AtomicBool::new(initial_ready));

        // Insert session entry — one write lock for all per-session state.
        {
            let mut sess = self.sessions.write().await;
            sess.insert(session, SessionEntry {
                info: client,
                crypt_state: None,
                bandwidth: Arc::new(Mutex::new(BandwidthRecord::new(0))),
                close_signal: None,
                ping_stats: Arc::new(std::sync::Mutex::new(PingStats::default())),
                ready: ready_flag.clone(),
            });
        }

        // Register sender in the lightweight broadcast registry (sync write, non-blocking).
        self.sender_registry.write().unwrap()
            .insert(session, (sender.clone(), ready_flag));

        // Register in HotSlot for lock-free voice-routing reads.
        crate::hot_slot::get_hot_slot(session).register(
            session, channel_id, deaf, self_deaf, suppress, sender.clone_sender(),
        );

        // Register in channel membership index.
        self.channel_users
            .write()
            .await
            .entry(channel_id)
            .or_default()
            .insert(session);

        // Register pre-configured listen channels in the index.
        if !listening.is_empty() {
            let mut idx = self.listening_index.write().await;
            for ch in listening {
                idx.entry(ch).or_default().insert(session);
            }
        }
    }

    /// Update a client's info (without changing the sender).
    /// Also keeps the listening_index in sync when listening_channels changes.
    pub async fn update_client(&self, client: ClientInfo) {
        let session = client.session;
        let new_listening = client.listening_channels.clone();
        // Capture hot fields before `client` is moved into SessionEntry.
        let new_deaf = client.deaf;
        let new_self_deaf = client.self_deaf;
        let new_suppress = client.suppress;
        let new_channel_id = client.channel_id;
        let old_listening = {
            let mut sess = self.sessions.write().await;
            let old = sess
                .get(&session)
                .map(|e| e.info.listening_channels.clone())
                .unwrap_or_default();
            if let Some(entry) = sess.get_mut(&session) {
                entry.info = client;
            }
            old
        };

        // Sync HotSlot for frequently-read voice-routing fields.
        {
            let slot = crate::hot_slot::get_hot_slot(session);
            if slot.is_active_for(session) {
                slot.deaf.store(new_deaf, std::sync::atomic::Ordering::Relaxed);
                slot.self_deaf.store(new_self_deaf, std::sync::atomic::Ordering::Relaxed);
                slot.suppress.store(new_suppress, std::sync::atomic::Ordering::Relaxed);
                slot.channel_id.store(new_channel_id, std::sync::atomic::Ordering::Relaxed);
            }
        }

        if old_listening != new_listening {
            let mut idx = self.listening_index.write().await;
            for ch in &old_listening {
                if !new_listening.contains(ch) {
                    if let Some(sessions) = idx.get_mut(ch) {
                        sessions.remove(&session);
                    }
                }
            }
            for ch in &new_listening {
                if !old_listening.contains(ch) {
                    idx.entry(*ch).or_default().insert(session);
                }
            }
        }
    }

    /// Move a client to a different channel without disturbing any other session state.
    ///
    /// Updates `channel_id` and `suppress` in-place within the existing
    /// `SessionEntry`, preserving the close-signal, crypt-state, and bandwidth
    /// record.  Returns `false` if the session is not found.
    pub async fn move_client_to_channel(
        &self,
        session: u32,
        new_channel: u32,
        new_suppress: bool,
    ) -> bool {
        let old_channel = {
            let mut sess = self.sessions.write().await;
            let Some(entry) = sess.get_mut(&session) else {
                return false;
            };
            let old = entry.info.channel_id;
            entry.info.channel_id = new_channel;
            entry.info.suppress = new_suppress;
            old
        };

        if old_channel != new_channel {
            let mut ch = self.channel_users.write().await;
            if let Some(users) = ch.get_mut(&old_channel) {
                users.remove(&session);
            }
            ch.entry(new_channel).or_default().insert(session);
        }

        // Sync HotSlot channel_id and suppress.
        {
            let slot = crate::hot_slot::get_hot_slot(session);
            if slot.is_active_for(session) {
                slot.channel_id.store(new_channel, std::sync::atomic::Ordering::Relaxed);
                slot.suppress.store(new_suppress, std::sync::atomic::Ordering::Relaxed);
            }
        }

        true
    }

    /// Attempt to move a client to a new channel, atomically checking the channel
    /// capacity limit as part of the membership update.
    ///
    /// Unlike the separate `count_in_channel` + `move_client_to_channel` pattern,
    /// this method performs the count check and the `channel_users` update within a
    /// single write-lock acquisition, eliminating the TOCTOU race where two
    /// concurrent tasks both observe "channel not full" and both complete the move.
    ///
    /// Returns `Ok(())` on success, or `Err(())` if `max_users > 0` and
    /// `channel_users[new_channel].len() >= max_users`.
    ///
    /// On capacity failure the sessions state is rolled back to its original values
    /// before returning, so the caller does not need to perform any cleanup.
    pub async fn move_client_to_channel_checked(
        &self,
        session: u32,
        new_channel: u32,
        new_suppress: bool,
        max_users: u32,
    ) -> Result<(), ()> {
        // Step 1: Update sessions (record new channel_id/suppress).
        // We save the old values so we can roll back if the capacity check fails.
        let (old_channel, old_suppress) = {
            let mut sess = self.sessions.write().await;
            let Some(entry) = sess.get_mut(&session) else {
                return Ok(()); // Session gone — nothing to do.
            };
            if entry.info.channel_id == new_channel {
                return Ok(()); // No-op move.
            }
            let old_ch = entry.info.channel_id;
            let old_sup = entry.info.suppress;
            entry.info.channel_id = new_channel;
            entry.info.suppress = new_suppress;
            (old_ch, old_sup)
        };

        // Step 2: Atomically check capacity and update channel membership.
        // Both the count check and the Vec push happen inside the same write lock,
        // so no other task can slip through between them.
        {
            let mut ch = self.channel_users.write().await;

            if max_users > 0 {
                let current_count = ch.get(&new_channel).map(|v| v.len() as u32).unwrap_or(0);
                if current_count >= max_users {
                    // Capacity exceeded: roll back the sessions update.
                    // The channel_users lock must be dropped first so that acquiring
                    // sessions.write() preserves the sessions → channel_users lock order.
                    drop(ch);
                    let mut sess = self.sessions.write().await;
                    if let Some(entry) = sess.get_mut(&session) {
                        // Only roll back if another task has not already moved the session
                        // to a different channel in the meantime.
                        if entry.info.channel_id == new_channel {
                            entry.info.channel_id = old_channel;
                            entry.info.suppress = old_suppress;
                        }
                    }
                    return Err(());
                }
            }

            if let Some(users) = ch.get_mut(&old_channel) {
                users.remove(&session);
            }
            ch.entry(new_channel).or_default().insert(session);
        }

        // Sync HotSlot channel_id and suppress after successful move.
        {
            let slot = crate::hot_slot::get_hot_slot(session);
            if slot.is_active_for(session) {
                slot.channel_id.store(new_channel, std::sync::atomic::Ordering::Relaxed);
                slot.suppress.store(new_suppress, std::sync::atomic::Ordering::Relaxed);
            }
        }

        Ok(())
    }

    /// Add a listener for `session` on `channel`, atomically checking the
    /// per-channel listener capacity limit.
    ///
    /// The `listening_index` update and the capacity check are performed within
    /// a single write-lock acquisition, preventing the TOCTOU race where two
    /// concurrent tasks both observe "channel has room" and both complete the add.
    ///
    /// `max_per_channel = 0` means no limit.
    ///
    /// Returns `true` if the listener was added (or was already present),
    /// `false` if the channel's listener limit was reached.
    ///
    /// On success, `sessions[session].listening_channels` is also updated so that
    /// a subsequent `update_client` call does not re-add or re-remove the channel.
    pub async fn add_listener_checked(
        &self,
        session: u32,
        channel: u32,
        max_per_channel: u32,
    ) -> bool {
        // Step 1: Atomically check per-channel limit and update listening_index.
        let newly_added = {
            let mut idx = self.listening_index.write().await;
            if max_per_channel > 0 {
                let count = idx.get(&channel).map(|v| v.len() as u32).unwrap_or(0);
                if count >= max_per_channel {
                    return false;
                }
            }
            let ch_sessions = idx.entry(channel).or_default();
            if ch_sessions.contains(&session) {
                false // Already listening — no-op.
            } else {
                ch_sessions.insert(session);
                true
            }
        };

        if newly_added {
            // Step 2: Mirror the add into sessions.listening_channels so that a later
            // update_client call sees old == new and does not attempt to re-sync the index.
            let mut sess = self.sessions.write().await;
            if let Some(entry) = sess.get_mut(&session) {
                if !entry.info.listening_channels.contains(&channel) {
                    entry.info.listening_channels.push(channel);
                }
            }
        }

        true
    }

    /// Remove a client by session ID.
    pub async fn remove_client(&self, session: u32) -> Option<ClientInfo> {
        // Clear HotSlot first so voice routing stops immediately.
        crate::hot_slot::get_hot_slot(session).clear();

        // One write lock for all per-session state.
        let entry = self.sessions.write().await.remove(&session);
        let entry = entry?;
        let info = entry.info;

        // Remove from sender registry (sync write, non-blocking).
        self.sender_registry.write().unwrap().remove(&session);

        // Update channel membership.
        {
            let mut ch = self.channel_users.write().await;
            if let Some(users) = ch.get_mut(&info.channel_id) {
                users.remove(&session);
            }
        }

        // Update listen index.
        if !info.listening_channels.is_empty() {
            let mut idx = self.listening_index.write().await;
            for ch in &info.listening_channels {
                if let Some(sessions) = idx.get_mut(ch) {
                    sessions.remove(&session);
                    if sessions.is_empty() {
                        idx.remove(ch);
                    }
                }
            }
        }

        Some(info)
    }

    /// Get a client by session ID.
    pub async fn get_client(&self, session: u32) -> Option<ClientInfo> {
        self.sessions.read().await.get(&session).map(|e| e.info.clone())
    }

    /// Get a sender for a specific client.
    pub async fn get_sender(&self, session: u32) -> Option<ClientSender> {
        self.sender_registry.read().unwrap().get(&session).map(|(s, _)| s.clone())
    }

    /// Get the number of connected clients.
    pub async fn client_count(&self) -> usize {
        self.sessions.read().await.len()
    }

    /// Get all sessions in a channel.
    pub async fn get_channel_sessions(&self, channel_id: u32) -> Vec<u32> {
        self.channel_users
            .read()
            .await
            .get(&channel_id)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Get all connected clients.
    pub async fn get_all_clients(&self) -> Vec<ClientInfo> {
        self.sessions.read().await.values().map(|e| e.info.clone()).collect()
    }

    /// Get all session IDs.
    pub async fn get_all_sessions(&self) -> Vec<u32> {
        self.sessions.read().await.keys().copied().collect()
    }

    /// Batch voice dispatch target lookup for local UDP delivery.
    ///
    /// For each session in `channels` (excluding `exclude_session`), returns a tuple
    /// `(session, is_deaf, Option<Arc<Mutex<CryptState>>>)` in a **single pair of
    /// lock acquisitions** (`channel_users.read` + `sessions.read`), rather than the
    /// prior N×2 per-session lock pattern.
    ///
    /// The caller is responsible for the actual UDP send (which happens outside any lock).
    pub async fn get_channel_voice_targets(
        &self,
        channels: &[u32],
        exclude_session: u32,
    ) -> Vec<(u32, bool, Option<Arc<Mutex<CryptState>>>)> {
        let session_ids: Vec<u32> = {
            let ch_users = self.channel_users.read().await;
            channels
                .iter()
                .flat_map(|ch| {
                    ch_users
                        .get(ch)
                        .into_iter()
                        .flatten()
                        .copied()
                })
                .filter(|&s| s != exclude_session)
                .collect()
        };

        if session_ids.is_empty() {
            return Vec::new();
        }

        let sess = self.sessions.read().await;
        session_ids
            .into_iter()
            .map(|s| {
                let e = sess.get(&s);
                let deaf = e.map(|e| e.info.deaf || e.info.self_deaf).unwrap_or(false);
                let cs = e.and_then(|e| e.crypt_state.clone());
                (s, deaf, cs)
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
        let session_ids: Vec<u32> = {
            let ch_users = self.channel_users.read().await;
            let listen_idx = self.listening_index.read().await;
            // DEBUG: print channel_users contents for queried channels
            let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
            let mut result = Vec::new();
            for &ch in channels {
                if let Some(members) = ch_users.get(&ch) {
                    for &s in members {
                        if s != exclude_session && seen.insert(s) {
                            result.push(s);
                        }
                    }
                }
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

        if session_ids.is_empty() {
            return Vec::new();
        }

        let sess = self.sessions.read().await;
        session_ids
            .into_iter()
            .map(|s| {
                let e = sess.get(&s);
                let deaf = e.map(|e| e.info.deaf || e.info.self_deaf).unwrap_or(false);
                let cs = e.and_then(|e| e.crypt_state.clone());
                (s, deaf, cs)
            })
            .collect()
    }

    /// Collect session IDs for all members and listeners in the given channels,
    /// **excluding** `exclude_session`, without reading the `sessions` map.
    ///
    /// Compared to [`get_channel_voice_targets_with_listeners`], this method holds
    /// only `channel_users.read()` + `listening_index.read()`, never `sessions.read()`.
    /// Callers that need per-session routing data (deaf flag, crypt state, sender)
    /// should read those atomically from `hot_slot::get_hot_slot(id)` after this call.
    pub async fn get_channel_session_ids_with_listeners(
        &self,
        channels: &[u32],
        exclude_session: u32,
    ) -> Vec<u32> {
        let ch_users = self.channel_users.read().await;
        let listen_idx = self.listening_index.read().await;
        let mut seen = std::collections::HashSet::new();
        let mut result = Vec::new();
        for &ch in channels {
            if let Some(members) = ch_users.get(&ch) {
                for &s in members {
                    if s != exclude_session && seen.insert(s) {
                        result.push(s);
                    }
                }
            }
            if let Some(listeners) = listen_idx.get(&ch) {
                for &s in listeners {
                    if s != exclude_session && seen.insert(s) {
                        result.push(s);
                    }
                }
            }
        }
        result
    }

    /// Store a CryptState for a session.
    pub async fn set_crypt_state(&self, session: u32, state: CryptState) {
        let cs = Arc::new(Mutex::new(state));
        // Update HotSlot so the UDP path sees the new crypt state immediately.
        crate::hot_slot::get_hot_slot(session)
            .crypt_state
            .store(Arc::new(Some(Arc::clone(&cs))));
        if let Some(entry) = self.sessions.write().await.get_mut(&session) {
            entry.crypt_state = Some(cs);
        }
    }

    /// Get the CryptState handle for a session (shared, lockable).
    pub async fn get_crypt_state(&self, session: u32) -> Option<Arc<Mutex<CryptState>>> {
        self.sessions.read().await.get(&session)?.crypt_state.clone()
    }

    /// Restore a previously-saved CryptState Arc directly (used when re-adding a
    /// client after a channel move so the existing crypto session is preserved).
    pub async fn restore_crypt_state(&self, session: u32, state: Arc<Mutex<CryptState>>) {
        // Update HotSlot so the UDP path sees the restored crypt state immediately.
        crate::hot_slot::get_hot_slot(session)
            .crypt_state
            .store(Arc::new(Some(Arc::clone(&state))));
        if let Some(entry) = self.sessions.write().await.get_mut(&session) {
            entry.crypt_state = Some(state);
        }
    }

    /// Update the decrypt IV for a session (called on CryptSetup resync).
    pub async fn update_decrypt_iv(&self, session: u32, client_nonce: &[u8; 16]) {
        if let Some(arc) = self.sessions.read().await.get(&session)
            .and_then(|e| e.crypt_state.clone())
        {
            arc.lock().unwrap().update_decrypt_iv(client_nonce);
        }
    }

    /// Get the current encrypt IV for a session (to send in CryptSetup resync response).
    pub async fn get_encrypt_iv(&self, session: u32) -> Option<Vec<u8>> {
        let cs_arc = self.sessions.read().await.get(&session)?.crypt_state.clone()?;
        Some(cs_arc.lock().unwrap().encrypt_iv.to_vec())
    }

    /// Get all sessions that have a CryptState registered (i.e., have completed login).
    pub async fn get_authenticated_sessions(&self) -> Vec<u32> {
        self.sessions
            .read()
            .await
            .iter()
            .filter_map(|(&s, e)| if e.crypt_state.is_some() { Some(s) } else { None })
            .collect()
    }

    /// Get sender info for the voice hot path in a single `sessions.read()`.
    ///
    /// Returns `(crypt_arc, channel_id, suppress)` for the given session, or `None`
    /// if the session does not exist or has no CryptState yet (pre-auth).
    /// Callers (e.g. `UdpServer::handle_known_client`) use this to avoid a second
    /// lock acquisition that the old `get_crypt_state` + `get_client` pattern required.
    pub async fn get_sender_voice_info(
        &self,
        session: u32,
    ) -> Option<(Arc<Mutex<CryptState>>, u32, bool, Arc<Mutex<BandwidthRecord>>)> {
        let sess = self.sessions.read().await;
        let entry = sess.get(&session)?;
        let cs = entry.crypt_state.clone()?;
        Some((cs, entry.info.channel_id, entry.info.suppress, entry.bandwidth.clone()))
    }

    /// Snapshot all candidates for UDP session identification in a single lock acquisition.
    ///
    /// Returns `(session_id, crypt_arc, channel_id, suppress, bw_arc)` for every session that
    /// has a CryptState but whose `session_id` is NOT in `already_mapped`.  Used by
    /// `UdpServer::try_identify_and_handle` to replace the prior `get_authenticated_sessions`
    /// + N×`get_crypt_state` pattern (N+1 lock acquisitions) with a single read.
    pub async fn get_udp_identification_candidates(
        &self,
        already_mapped: &std::collections::HashSet<u32>,
    ) -> Vec<(u32, Arc<Mutex<CryptState>>, u32, bool, Arc<Mutex<BandwidthRecord>>)> {
        self.sessions
            .read()
            .await
            .iter()
            .filter_map(|(&sid, e)| {
                if already_mapped.contains(&sid) { return None; }
                e.crypt_state.as_ref().map(|cs| (sid, Arc::clone(cs), e.info.channel_id, e.info.suppress, e.bandwidth.clone()))
            })
            .collect()
    }

    /// Record a voice frame for the given session, returning `false` if it should
    /// be dropped because it exceeds `max_bytes_per_sec`.
    ///
    /// The bandwidth Arc is pre-allocated when the session is added, so no write
    /// lock is ever needed here — only a brief read lock to clone the Arc.
    /// Concurrent callers for *different* sessions acquire independent per-session
    /// Mutexes, so they never block each other.
    pub async fn record_voice_bytes(
        &self,
        session: u32,
        bytes: u32,
        max_bytes_per_sec: u32,
        window_secs: usize,
    ) -> bool {
        // Brief read lock — clone the bandwidth Arc and release immediately.
        let record_arc = {
            let sess = self.sessions.read().await;
            sess.get(&session).map(|e| e.bandwidth.clone())
        };
        let record_arc = match record_arc {
            Some(arc) => arc,
            None => return true, // session gone — let packet through
        };
        // Global lock released; operate on the per-session Mutex independently.
        let mut record = match record_arc.lock() {
            Ok(g) => g,
            Err(_) => return true, // poisoned — allow packet through
        };
        if record.window_secs() != crate::bandwidth::effective_window(window_secs) {
            *record = BandwidthRecord::new(window_secs);
        }
        record.add_frame(bytes, max_bytes_per_sec)
    }

    /// Return the bytes-per-second in the most recently completed second for a session.
    /// Returns `0` if no bandwidth data has been recorded.
    pub async fn get_bandwidth_stats(&self, session: u32) -> u32 {
        let arc = self.sessions.read().await.get(&session).map(|e| e.bandwidth.clone());
        match arc {
            Some(r) => r.lock().map(|g| g.bytes_last_second()).unwrap_or(0),
            None => 0,
        }
    }

    /// Update ping / statistics from a client Ping message.
    ///
    /// Uses a **read** lock on `sessions` (to clone the per-session `Arc`) rather
    /// than a write lock, then updates the dedicated `PingStats` Mutex.  With
    /// hundreds of clients each pinging every 5 s, the former write-lock approach
    /// serialised all concurrent reads (voice routing, channel lookups, etc.).
    #[allow(clippy::too_many_arguments)]
    pub async fn update_ping_stats(
        &self,
        session: u32,
        udp_packets: u32,
        tcp_packets: u32,
        udp_ping_avg: f32,
        udp_ping_var: f32,
        tcp_ping_avg: f32,
        tcp_ping_var: f32,
        remote_good: u32,
        remote_late: u32,
        remote_lost: u32,
        remote_resync: u32,
    ) {
        // Brief read lock — just clone the Arc, no write needed.
        let arc = match self.sessions.read().await.get(&session) {
            Some(e) => e.ping_stats.clone(),
            None => return,
        };
        // Per-session std::sync::Mutex — never held across await points.
        if let Ok(mut p) = arc.lock() {
            p.udp_packets = udp_packets;
            p.tcp_packets = tcp_packets;
            p.udp_ping_avg = udp_ping_avg;
            p.udp_ping_var = udp_ping_var;
            p.tcp_ping_avg = tcp_ping_avg;
            p.tcp_ping_var = tcp_ping_var;
            p.remote_good = remote_good;
            p.remote_late = remote_late;
            p.remote_lost = remote_lost;
            p.remote_resync = remote_resync;
        }
    }

    /// Get a snapshot of ping statistics for a session.
    pub async fn get_ping_stats(&self, session: u32) -> Option<PingStats> {
        let arc = self.sessions.read().await.get(&session).map(|e| e.ping_stats.clone())?;
        arc.lock().ok().map(|p| p.clone())
    }

    /// Update client state.
    pub async fn set_client_state(&self, session: u32, state: ClientState) {
        let is_ready = state == ClientState::Ready;
        if let Some(entry) = self.sessions.write().await.get_mut(&session) {
            entry.info.state = state;
            // AtomicBool is shared with sender_registry — update it in place;
            // no write lock on sender_registry needed.
            entry.ready.store(is_ready, Ordering::Relaxed);
        }
    }

    /// Broadcast a Mumble protocol message to all authenticated clients.
    ///
    /// Uses `sender_registry` (a `std::sync::RwLock`) rather than the async
    /// `sessions` lock, so this method **never suspends on a lock** and never
    /// competes with state-mutation operations (`update_client`, `move_client`,
    /// etc.).  Each send is non-blocking (`try_send`): a slow client drops the
    /// frame instead of stalling the caller's read loop.
    pub async fn broadcast<M: Message>(&self, msg_type: MessageType, message: &M, exclude_session: Option<u32>) {
        let mut buf = BytesMut::new();
        encode_message(msg_type, message, &mut buf);
        let data = buf.to_vec();

        // Sync read lock — acquired and released synchronously, no await.
        // ready.load(Relaxed) is an atomic read; no additional lock needed.
        let targets: Vec<(u32, ClientSender)> = {
            let reg = self.sender_registry.read().unwrap();
            reg.iter()
                .filter(|&(&s, _)| Some(s) != exclude_session)
                .filter(|(_, (_, ready))| ready.load(Ordering::Relaxed))
                .map(|(&s, (sender, _))| (s, sender.clone()))
                .collect()
        };

        for (session, sender) in targets {
            if !sender.try_send_raw(data.clone()) {
                warn!("Dropped broadcast to session {} (send channel full)", session);
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

        let member_ids = self.get_channel_sessions(channel_id).await;

        // Sync read lock — no async suspension, no competition with state writes.
        let targets: Vec<(u32, ClientSender)> = {
            let reg = self.sender_registry.read().unwrap();
            member_ids.iter()
                .filter(|&&s| Some(s) != exclude_session)
                .filter_map(|&s| {
                    reg.get(&s)
                        .filter(|(_, ready)| ready.load(Ordering::Relaxed))
                        .map(|(sender, _)| (s, sender.clone()))
                })
                .collect()
        };

        for (session, sender) in targets {
            if !sender.try_send_raw(data.clone()) {
                warn!("Dropped channel broadcast to session {} (send channel full)", session);
            }
        }
    }

    /// Send a message to a specific client.
    pub async fn send_to<M: Message>(&self, session: u32, msg_type: MessageType, message: &M) -> bool {
        let mut buf = BytesMut::new();
        encode_message(msg_type, message, &mut buf);
        let sender = self.sender_registry.read().unwrap()
            .get(&session).map(|(s, _)| s.clone());
        if let Some(s) = sender {
            s.send_raw(buf.to_vec()).await
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
            .map(|s| s.iter().copied().collect())
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
    /// Uses the `channel_users` index for O(1) lookup.
    pub async fn count_in_channel(&self, channel_id: u32) -> u32 {
        self.channel_users
            .read()
            .await
            .get(&channel_id)
            .map(|v| v.len() as u32)
            .unwrap_or(0)
    }

    /// Update the plugin_context for a session.
    pub async fn update_plugin_context(&self, session_id: u32, ctx: Vec<u8>) {
        if let Some(entry) = self.sessions.write().await.get_mut(&session_id) {
            entry.info.plugin_context = ctx;
        }
    }

    /// Send a Reject message to all connected clients and close their connections.
    ///
    /// Used when Hub becomes completely unreachable (direct + relay both failed).
    pub async fn close_all_connections(&self, reason: &str) {
        use munode_protocol::mumbleproto;
        let reject = mumbleproto::Reject {
            r#type: Some(mumbleproto::reject::RejectType::None as i32),
            reason: Some(reason.to_string()),
        };
        let mut buf = BytesMut::new();
        encode_message(MessageType::Reject, &reject, &mut buf);
        let data = buf.to_vec();

        // Drain sender_registry synchronously (sync write lock, no await).
        // We send to these handles after releasing all locks.
        let senders: Vec<ClientSender> = self.sender_registry.write().unwrap()
            .drain()
            .map(|(_, (s, _))| s)
            .collect();

        // Consume close signals and clear session state (async write lock).
        {
            let mut sess = self.sessions.write().await;
            for entry in sess.values_mut() {
                let _ = entry.close_signal.take();
            }
            sess.clear();
        }

        // Send Reject outside all locks — non-blocking so we don't stall.
        for sender in senders {
            sender.try_send_raw(data.clone());
        }

        // Clear secondary indices so stale session IDs don't accumulate.
        self.channel_users.write().await.clear();
        self.listening_index.write().await.clear();
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
        let (tx, _rx) = mpsc::channel(16);
        let session = 42u32;
        mgr.add_client(make_test_client(session, 0), ClientSender::new(tx)).await;
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
        let (tx, _rx) = mpsc::channel(16);
        let session = 99u32;
        mgr.add_client(make_test_client(session, 0), ClientSender::new(tx)).await;

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
        let (tx, _rx) = mpsc::channel(16);
        let session = 7u32;
        mgr.add_client(make_test_client(session, 0), ClientSender::new(tx)).await;

        // Seed an initial record with a 60-s window.
        mgr.record_voice_bytes(session, 100, 0, 60).await;

        // Verify the record has the expected window before resizing.
        {
            let sess = mgr.sessions.read().await;
            assert_eq!(
                sess.get(&session).expect("session should exist")
                    .bandwidth.lock().unwrap().window_secs(),
                effective_window(60),
                "initial window should be 60 slots"
            );
        }

        // Calling record_voice_bytes with a different window_secs should
        // recreate the BandwidthRecord with the new window size.
        mgr.record_voice_bytes(session, 100, 0, 120).await;

        {
            let sess = mgr.sessions.read().await;
            assert_eq!(
                sess.get(&session).expect("session should exist after window resize")
                    .bandwidth.lock().unwrap().window_secs(),
                effective_window(120),
                "window should be updated to 120 slots after hot-reload"
            );
        }
    }
}
