use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use tokio::sync::{broadcast, mpsc, RwLock};

use munode_protocol::hubedge::ServerLimitsConfig;

use crate::channel_manager::ChannelManager;
use crate::client::ClientManager;

/// Sliding-window replay guard for ChaCha20-Poly1305 Edge-to-Edge voice packets.
///
/// Window size is 64 positions (one `u64` bitmask).  `bit i` set ⟺ counter
/// `(max_seen − i)` has already been authenticated and delivered.
///
/// Voice traffic at 50 fps gives ~1.3 s of reordering tolerance; any packet
/// arriving more than 64 counter ticks behind the frontier is rejected as
/// either a replay or unrecoverably stale.
struct ReplayWindow {
    max_seen: u64,
    initialized: bool,
    /// `bit 0` = max_seen was seen; `bit 1` = max_seen-1 was seen; etc.
    seen_mask: u64,
}

impl ReplayWindow {
    fn new() -> Self {
        Self { max_seen: 0, initialized: false, seen_mask: 0 }
    }

    const WINDOW: u64 = 64;

    /// Fast pre-check (no AEAD cost): returns `false` if the counter is
    /// definitely outside the acceptance window, saving an AEAD operation.
    #[inline]
    fn pre_check(&self, counter: u64) -> bool {
        if !self.initialized { return true; }
        if counter > self.max_seen { return true; }
        (self.max_seen - counter) < Self::WINDOW
    }

    /// Attempt to mark `counter` as seen.  Must be called only after AEAD
    /// authentication succeeds.  Returns `false` if the counter was already
    /// marked (replay attack) or is outside the window.
    #[inline]
    fn mark_seen(&mut self, counter: u64) -> bool {
        if !self.initialized {
            self.max_seen = counter;
            self.seen_mask = 1;
            self.initialized = true;
            return true;
        }
        if counter > self.max_seen {
            let shift = counter - self.max_seen;
            if shift >= Self::WINDOW {
                // Entire old window expired — reset bitmask.
                self.seen_mask = 1;
            } else {
                self.seen_mask = (self.seen_mask << shift) | 1;
            }
            self.max_seen = counter;
            true
        } else {
            let behind = self.max_seen - counter;
            if behind >= Self::WINDOW {
                return false; // too old
            }
            let mask = 1u64 << behind;
            if self.seen_mask & mask != 0 {
                false // already seen — replay
            } else {
                self.seen_mask |= mask;
                true
            }
        }
    }
}

/// ChaCha20-Poly1305 shared-key encryption for Edge-to-Edge UDP voice traffic.
///
/// All Edges in a cluster derive the same key from `hmac_secret`, so ciphertext
/// produced by one Edge can be verified and decrypted by any other Edge.  A
/// monotonic counter combined with the sender's Edge ID forms the 12-byte nonce,
/// ensuring per-sender uniqueness across the cluster lifetime.
pub struct EdgeCrypto {
    key: ring::aead::LessSafeKey,
    counter: AtomicU64,
    /// Per-sender replay prevention windows.
    ///
    /// Layout is `RwLock<HashMap<sender_id, Arc<Mutex<ReplayWindow>>>>` so that:
    /// - The read lock is held only long enough to clone the `Arc` (hot path).
    /// - The write lock is needed only for the first packet from a new sender (rare).
    /// - The per-sender `Mutex` is then acquired independently without holding the map lock.
    replay_windows: std::sync::RwLock<std::collections::HashMap<u32, Arc<std::sync::Mutex<ReplayWindow>>>>,
}

impl EdgeCrypto {
    /// Derive an `EdgeCrypto` from the shared HMAC secret string.
    ///
    /// Returns `None` only if the underlying key construction fails (which
    /// should never occur for a valid 32-byte key from HMAC-SHA256).
    pub fn from_secret(secret: &str) -> Option<Self> {
        let key_material = ring::hmac::sign(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes()),
            b"munode-edge-udp-voice-key-v1",
        );
        // HMAC-SHA256 produces 32 bytes — exactly the ChaCha20-Poly1305 key size.
        let key_bytes = &key_material.as_ref()[..32];
        let unbound = ring::aead::UnboundKey::new(&ring::aead::CHACHA20_POLY1305, key_bytes).ok()?;
        Some(Self {
            key: ring::aead::LessSafeKey::new(unbound),
            counter: AtomicU64::new(0),
            replay_windows: std::sync::RwLock::new(std::collections::HashMap::new()),
        })
    }

    fn build_nonce(sender_edge_id: u32, counter: u64) -> ring::aead::Nonce {
        // 12-byte nonce: [sender_edge_id_BE(4)][counter_BE(8)]
        // Using all 12 bytes prevents nonce reuse even with a very high-frequency sender.
        let mut b = [0u8; 12];
        b[0..4].copy_from_slice(&sender_edge_id.to_be_bytes());
        b[4..12].copy_from_slice(&counter.to_be_bytes());
        ring::aead::Nonce::assume_unique_for_key(b)
    }

    /// Encrypt `plaintext` for the given sender Edge.
    ///
    /// Returns `(counter, ciphertext_with_poly1305_tag)`.  The caller embeds
    /// `counter` and `sender_edge_id` in the packet header so receivers can
    /// reconstruct the nonce.  Because all Edges share the same key, a
    /// ciphertext produced with empty `aad` can be sent to multiple peers
    /// without re-encryption (encrypt-once broadcast).
    ///
    /// Pass non-empty `aad` to bind the ciphertext to specific routing metadata
    /// (e.g. for relay packets, use `sender_edge_id ++ target_edge_id` as AAD to
    /// prevent an on-path attacker from redirecting the packet to a wrong destination).
    pub fn encrypt(&self, plaintext: &[u8], sender_edge_id: u32, aad: &[u8]) -> (u64, Vec<u8>) {
        let counter = self.counter.fetch_add(1, Ordering::Relaxed);
        let nonce = Self::build_nonce(sender_edge_id, counter);
        let mut buf = plaintext.to_vec();
        // Appends the 16-byte Poly1305 tag in-place.  Sealing can only fail on an
        // out-of-memory condition or a programming error — treat as unrecoverable.
        self.key
            .seal_in_place_append_tag(nonce, ring::aead::Aad::from(aad), &mut buf)
            .expect("EdgeCrypto::encrypt: AEAD sealing failed");
        (counter, buf)
    }

    /// Verify the Poly1305 tag, decrypt `ciphertext_with_tag`, and enforce
    /// replay prevention via a per-sender sliding counter window.
    ///
    /// `aad` must match what was passed to `encrypt` exactly (empty slice for
    /// direct-voice packets; `sender_edge_id ++ target_edge_id` for relay packets).
    ///
    /// Returns plaintext on success, or `None` if:
    /// - The AEAD tag is invalid (wrong key, tampered packet, AAD mismatch), OR
    /// - The counter has already been seen from this sender (replay), OR
    /// - The counter is outside the 64-position acceptance window (too old).
    ///
    /// Performance notes:
    /// - `pre_check` rejects obviously stale counters before the AEAD operation.
    /// - The read lock on `replay_windows` is held only for an Arc clone (~ns).
    /// - Per-sender Mutex is rarely contended because voice senders are sequential.
    pub fn decrypt(&self, sender_edge_id: u32, counter: u64, ciphertext: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        const TAG_LEN: usize = 16;
        if ciphertext.len() <= TAG_LEN {
            return None;
        }

        // ── Step 1: get (or create) the per-sender replay window ─────────────
        let window_arc: Arc<std::sync::Mutex<ReplayWindow>> = {
            // Fast path: sender already known — just clone the Arc under read lock.
            if let Ok(map) = self.replay_windows.read() {
                map.get(&sender_edge_id).cloned()
            } else {
                None
            }
        }
        .unwrap_or_else(|| {
            // Slow path (first packet from this sender): insert under write lock.
            let w = Arc::new(std::sync::Mutex::new(ReplayWindow::new()));
            if let Ok(mut map) = self.replay_windows.write() {
                map.entry(sender_edge_id).or_insert_with(|| w.clone()).clone()
            } else {
                // Poisoned map — skip replay check for this packet
                w
            }
        });

        // ── Step 2: cheap pre-check (no AEAD) ────────────────────────────────
        let pre_ok = window_arc.lock()
            .map(|w| w.pre_check(counter))
            .unwrap_or(true); // poisoned window → allow AEAD to decide
        if !pre_ok {
            return None; // obviously too old, skip expensive AEAD
        }

        // ── Step 3: AEAD authentication + decryption ─────────────────────────
        let nonce = Self::build_nonce(sender_edge_id, counter);
        let mut buf = ciphertext.to_vec();
        let plaintext = self.key
            .open_in_place(nonce, ring::aead::Aad::from(aad), &mut buf)
            .ok()?;
        let plaintext = plaintext.to_vec();

        // ── Step 4: confirm in replay window (mark as seen or detect duplicate) ─
        let accepted = window_arc.lock()
            .map(|mut w| w.mark_seen(counter))
            .unwrap_or(true); // poisoned window → accept (AEAD already succeeded)
        if !accepted {
            return None; // replay: counter was already used by this sender
        }

        Some(plaintext)
    }
}

/// Information about a peer Edge node.
#[derive(Debug, Clone)]
pub struct PeerEdgeInfo {
    /// Edge-to-Edge UDP endpoint (dedicated `edge_port`).
    pub udp_addr: SocketAddr,
    /// Hostname of the peer Edge (same as used for UDP routing).
    pub host: String,
    /// Control-relay port of the peer Edge.
    /// Every Edge exposes a relay server on this port; it transparently
    /// forwards WebSocket traffic to Hub on behalf of Edges that cannot reach
    /// Hub directly.  `None` means the relay port was not yet advertised.
    pub relay_port: Option<u16>,
}

/// Registry of known peer Edges, populated from `hub.peerJoined` notifications.
#[derive(Debug, Default)]
pub struct PeerRegistry {
    peers: HashMap<u32, PeerEdgeInfo>,
    /// Reverse index: UDP address → edge_id, used for O(1) probe-pong lookup.
    addr_to_id: HashMap<SocketAddr, u32>,
}

impl PeerRegistry {
    pub fn upsert(&mut self, edge_id: u32, info: PeerEdgeInfo) {
        // Remove stale reverse-index entry if the peer's address changed.
        if let Some(old) = self.peers.get(&edge_id) {
            self.addr_to_id.remove(&old.udp_addr);
        }
        self.addr_to_id.insert(info.udp_addr, edge_id);
        self.peers.insert(edge_id, info);
    }

    pub fn remove(&mut self, edge_id: u32) {
        if let Some(old) = self.peers.remove(&edge_id) {
            self.addr_to_id.remove(&old.udp_addr);
        }
    }

    pub fn get(&self, edge_id: u32) -> Option<&PeerEdgeInfo> {
        self.peers.get(&edge_id)
    }

    /// O(1) lookup of the edge ID for a given UDP address.
    /// Used by the probe-pong handler to avoid a linear scan over all peers.
    pub fn find_by_addr(&self, addr: SocketAddr) -> Option<u32> {
        self.addr_to_id.get(&addr).copied()
    }

    /// Collect all peers that have a relay_port advertised.
    /// Returns a snapshot `Vec<(peer_id, host, relay_port)>` so the caller
    /// does not need to hold the lock while iterating.
    pub fn relay_peers(&self) -> Vec<(u32, String, u16)> {
        self.peers
            .iter()
            .filter_map(|(id, info)| {
                info.relay_port.map(|p| (*id, info.host.clone(), p))
            })
            .collect()
    }

    /// Returns all known peer edge IDs and their UDP addresses (for voice relay).
    pub fn all_udp_peers(&self) -> Vec<(u32, SocketAddr)> {
        self.peers
            .iter()
            .map(|(id, info)| (*id, info.udp_addr))
            .collect()
    }
}

/// A single voice target configuration (whisper/shout destinations).
#[derive(Debug, Clone)]
pub struct VoiceTargetConfig {
    pub sessions: Vec<u32>,
    pub channels: Vec<VoiceTargetChannelConfig>,
    /// Pre-computed expanded channel set, built once at config-write time.
    /// Maps channel_id → group filter (None = no filter, Some = user must be
    /// in at least one of the named groups). Rebuilt whenever the config
    /// changes OR when the channel link/tree structure changes.
    pub resolved_channels: HashMap<u32, Option<Vec<String>>>,
}

#[derive(Debug, Clone)]
pub struct VoiceTargetChannelConfig {
    pub channel_id: u32,
    pub links: bool,
    pub children: bool,
    pub group: Option<String>,
}

// ── VoiceTarget channel resolution helpers ────────────────────────────────

/// Recursively collect all descendant channel IDs into `out`.
pub fn collect_children_into(
    ch_id: u32,
    out: &mut HashSet<u32>,
    children_map: &HashMap<u32, Vec<u32>>,
) {
    if let Some(children) = children_map.get(&ch_id) {
        for &child in children {
            if out.insert(child) {
                collect_children_into(child, out, children_map);
            }
        }
    }
}

/// Expand a slice of `VoiceTargetChannelConfig` into a flat map of
/// `channel_id → group filter` by resolving `links` and `children` flags.
/// Multiple entries targeting the same channel are merged: a no-filter entry
/// wins over any group restriction (union semantics).
///
/// Resolution order (matches Mumble C++ server behaviour):
///   1. Start with the base channel.
///   2. If `links=true`, extend with all transitively linked channels.
///   3. If `children=true`, extend with all recursive sub-channels of EVERY
///      channel collected so far (base + links), not just the base channel.
/// An empty-string group is treated the same as no group (no filter).
pub async fn resolve_voice_target_channels(
    channels: &[VoiceTargetChannelConfig],
    channel_manager: &ChannelManager,
) -> HashMap<u32, Option<Vec<String>>> {
    let mut resolved: HashMap<u32, Option<Vec<String>>> = HashMap::new();
    for ch_cfg in channels {
        let mut ch_ids = HashSet::new();
        ch_ids.insert(ch_cfg.channel_id);
        if ch_cfg.links {
            let linked = channel_manager.get_all_linked_channels(ch_cfg.channel_id).await;
            ch_ids.extend(linked);
        }
        if ch_cfg.children {
            // Apply children expansion to all channels collected so far (base + linked).
            // This matches the Mumble C++ server which iterates the current set and
            // adds all recursive sub-channels of each channel in the set.
            let children_map = channel_manager.get_all_children_map().await;
            let snapshot: Vec<u32> = ch_ids.iter().copied().collect();
            for ch_id in snapshot {
                collect_children_into(ch_id, &mut ch_ids, &children_map);
            }
        }
        // Normalise: empty group string → no filter (same as omitting the group).
        let effective_group: Option<&str> = ch_cfg.group.as_deref().filter(|s| !s.is_empty());
        for ch_id in ch_ids {
            resolved
                .entry(ch_id)
                .and_modify(|existing| match (effective_group, existing.as_mut()) {
                    (None, _) => *existing = None,       // no-group overrides any restriction
                    (Some(_), None) => {}                // already unrestricted, keep
                    (Some(g), Some(groups)) => {
                        if !groups.iter().any(|e| e == g) {
                            groups.push(g.to_owned());
                        }
                    }
                })
                .or_insert_with(|| effective_group.map(|g| vec![g.to_owned()]));
        }
    }
    resolved
}

/// Delta of boolean state fields for a remote user state change.
/// Only fields that actually changed carry `Some(value)`; unchanged fields are `None`.
#[derive(Debug, Clone, Default)]
pub struct RemoteUserStateDelta {
    pub self_mute: Option<bool>,
    pub self_deaf: Option<bool>,
    pub mute: Option<bool>,
    pub deaf: Option<bool>,
    pub suppress: Option<bool>,
    pub priority_speaker: Option<bool>,
    pub recording: Option<bool>,
}

/// Events broadcast within the Edge server.
#[derive(Debug, Clone)]
pub enum EdgeEvent {
    /// Hub registration and full sync completed.
    /// `disappeared_session_ids`: remote session IDs that were in the local
    /// cache *before* the sync but are absent from the fresh Hub snapshot —
    /// the event loop should send UserRemove for these to all local clients.
    HubRegistered { disappeared_session_ids: Vec<u32> },
    /// Hub connection lost.
    HubDisconnected,
    /// Hub is completely unreachable: both direct and relay connections failed.
    /// All connected clients should be disconnected and wait for Hub to recover.
    HubUnreachable,
    /// A remote user joined (from another Edge, synced via Hub).
    RemoteUserJoined { session_id: u32, username: String, channel_id: u32, is_ninja: bool },
    /// A remote user left.
    RemoteUserLeft { session_id: u32 },
    /// A remote user's state changed (mute, deaf, etc.).
    RemoteUserStateChanged {
        session_id: u32,
        delta: RemoteUserStateDelta,
        listening_channel_add: Vec<u32>,
        listening_channel_remove: Vec<u32>,
    },
    /// A remote user moved channels.
    RemoteUserMoved { session_id: u32, channel_id: u32, actor_session: u32 },
    /// A channel was created.
    ChannelCreated { channel_id: u32 },
    /// A channel was removed.
    ChannelRemoved { channel_id: u32 },
    /// A channel was updated. `links_add` / `links_remove` carry the link delta
    /// so that connected clients can be notified via ChannelState messages.
    ChannelUpdated { channel_id: u32, links_add: Vec<u32>, links_remove: Vec<u32> },
    /// A text message forwarded from another edge via Hub.
    TextMessageForward {
        actor: u32,
        message: String,
        channel_id: Vec<u32>,
        tree_id: Vec<u32>,
        session: Vec<u32>,
    },
    /// Plugin data forwarded from another edge via Hub.
    PluginDataBroadcast {
        sender_session: u32,
        data_id: String,
        data: Vec<u8>,
        target_sessions: Vec<u32>,
    },
    /// Voice packet relayed from another edge via Hub TCP.
    RelayedVoice {
        voice_packet: Vec<u8>,
    },
    /// Hub requested this Edge to shut down (cluster partition handling).
    ShutdownRequested {
        reason: String,
    },
    /// Hub ACL was updated for a channel; Edges should re-evaluate can_enter for all clients.
    AclUpdated { channel_id: u32 },
}

/// Default TTL cap for relay packets when no Hub-provided cap is available.
pub const DEFAULT_MAX_TTL: u32 = 4;

/// Transport layer for a hop in a relay chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HopTransport { Udp, Tcp }

/// Route decision for reaching a target Edge.
#[derive(Debug, Clone, PartialEq)]
pub enum RouteDecision {
    /// Direct UDP to target Edge.
    DirectUdp,
    /// Direct TCP (WebSocket /voice) to target Edge.
    DirectTcp,
    /// Multi-hop relay chain: hops = intermediate Edge IDs (not including source/dest),
    /// transports[i] = transport used to reach hops[i].
    RelayChain {
        hops: Vec<u32>,
        transports: Vec<HopTransport>,
    },
    /// Hub TCP relay (last resort).
    HubTcp,
}

/// Single route candidate with cost.
#[derive(Debug, Clone)]
pub struct RouteCandidate {
    pub decision: RouteDecision,
    pub cost: f32,
}

/// Shared state accessible by all components of the Edge server.
pub struct EdgeState {
    /// Our assigned edge ID (from Hub registration).
    /// Stored as an AtomicU32 for lock-free reads in the voice hot path.
    /// Value 0 means "not yet registered"; all real edge IDs are non-zero.
    pub edge_id: AtomicU32,
    /// Whether the Hub requires client certificates.
    pub cert_required: RwLock<bool>,
    /// Channel manager (channels + remote users synced from Hub).
    pub channel_manager: Arc<ChannelManager>,
    /// Local client manager (clients connected to this Edge).
    pub client_manager: Arc<ClientManager>,
    /// Event bus for internal notifications.
    pub event_tx: broadcast::Sender<EdgeEvent>,
    /// Voice target cache: session_id -> target_id -> VoiceTargetConfig.
    /// Uses RwLock because reads happen on every whisper voice packet and
    /// writes only occur when the client sends a VoiceTarget message (rare).
    pub voice_targets: RwLock<HashMap<u32, HashMap<u32, VoiceTargetConfig>>>,
    /// Registry of peer Edges and their UDP endpoints for direct voice routing.
    /// Uses RwLock because reads happen on every cross-edge voice packet and
    /// writes only occur on peerJoined / peerLeft notifications (rare).
    pub peer_registry: RwLock<PeerRegistry>,
    /// Whether Hub-mediated TCP relay is allowed for cross-Edge voice (last resort).
    pub enable_hub_tcp_fallback: bool,
    /// Number of consecutive send failures before skipping a next-hop.
    /// 0 means never skip (rely solely on Hub route table updates).
    pub consecutive_failure_threshold: u32,
    /// Per next-hop consecutive failure counter.
    /// Uses a sync `RwLock` (never `await`ed) with per-edge `AtomicU32` values so that
    /// the hot path only needs a *read* lock to do an atomic increment/reset, keeping
    /// write locks exclusively for new edge registrations (peerJoined) which are rare.
    pub next_hop_failures: std::sync::RwLock<HashMap<u32, std::sync::atomic::AtomicU32>>,
    /// Hub-pushed cluster-level TTL cap for relay packets.
    pub max_ttl: std::sync::atomic::AtomicU32,
    /// Maximum number of channels a single user may listen to simultaneously.
    /// 0 = unlimited.
    pub listeners_per_user: u32,
    /// Maximum number of listeners allowed in a single channel.
    /// 0 = unlimited.
    pub listeners_per_channel: u32,
    /// Whether to respond to unauthenticated UDP ping probes from clients.
    /// When false, the server won't echo back ping packets (prevents public listing).
    /// Stored as AtomicBool for lock-free reads in the UDP hot path and hot-reload.
    pub allow_ping: AtomicBool,
    /// Rolling statistics window size in seconds for per-session voice quality metrics.
    /// 0 uses the default window (360 seconds), matching the BandwidthRecord default.
    /// Stored as AtomicU32 for lock-free reads in the voice hot path and hot-reload.
    pub rolling_stats_window: AtomicU32,
    /// Channel Ninja: list of channel IDs that are hidden from unprivileged users.
    /// Users without both Enter (0x4) AND Listen (0x800) permission on the channel
    /// will not see its occupants.  Populated from Hub on registration.
    pub ninja_channels: RwLock<Vec<u32>>,
    /// Per-session ninja channel permission cache.
    /// session_id -> set of channel IDs the user has Enter permission on.
    /// Used for fast ninja visibility checks without Hub round-trips.
    pub ninja_visible_to: RwLock<HashMap<u32, std::collections::HashSet<u32>>>,
    /// Route table from Hub. Maps target_edge_id → ordered list of route candidates (best first).
    pub route_table: RwLock<std::collections::HashMap<u32, Vec<RouteCandidate>>>,
    /// Outbound TCP voice connections to peer Edges.
    /// Maps peer_edge_id → channel sender for binary frames to deliver over the /voice WebSocket.
    /// Populated when we successfully connect to a peer's /voice endpoint on peerJoined.
    pub voice_tcp_conns: RwLock<HashMap<u32, mpsc::Sender<Vec<u8>>>>,
    /// Set of peer edge IDs for which a voice TCP connection manager task is running.
    /// Inserting an ID before spawning the task prevents duplicate reconnect tasks.
    /// Removing an ID (on hub.peerLeft) causes the reconnect loop to stop.
    pub voice_tcp_peers: RwLock<HashSet<u32>>,
    /// Client-facing limits pushed from Hub on registration (and updated via heartbeat).
    /// When set, overrides Edge-local config for ServerSync/ServerConfig/rate limiting.
    pub hub_limits: RwLock<Option<ServerLimitsConfig>>,
    /// Maximum voice bandwidth per user in bits-per-second, mirrored from `hub_limits`
    /// as an `AtomicU32` for lock-free reads on the UDP voice hot path.
    /// 0 = unlimited.  Updated atomically whenever `hub_limits` is written.
    pub max_bandwidth_bps: AtomicU32,
    /// Maximum number of concurrent users, mirrored from `hub_limits` as an `AtomicU32`
    /// for lock-free reads in the UDP ping hot path.
    /// 0 = unlimited.  Updated atomically whenever `hub_limits` is written.
    pub max_users: AtomicU32,
    /// Percentage (0–100) of outbound Edge-to-Edge UDP packets to drop.
    /// Zero in production; set by `test-utils` feature tests to simulate link degradation.
    pub test_udp_drop_rate: AtomicU32,
    /// Whether this Edge is currently accepting new Mumble client connections.
    /// Set to `false` when Hub becomes unreachable for too long; restored to `true`
    /// when Hub reconnects and registration completes.
    pub accepting_connections: AtomicBool,
    /// ChaCha20-Poly1305 encryption state for Edge-to-Edge UDP voice traffic.
    ///
    /// `Some` when `hub_server.hmac_secret` is configured; `None` when the Edge
    /// runs without a shared secret (plaintext Edge-to-Edge mode for development).
    pub edge_crypto: Option<Arc<EdgeCrypto>>,
}

impl EdgeState {
    pub fn new(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        enable_hub_tcp_fallback: bool,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            edge_id: AtomicU32::new(0),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: RwLock::new(HashMap::new()),
            peer_registry: RwLock::new(PeerRegistry::default()),
            enable_hub_tcp_fallback,
            consecutive_failure_threshold: 2,
            next_hop_failures: std::sync::RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user: 0,
            listeners_per_channel: 0,
            allow_ping: AtomicBool::new(true),
            rolling_stats_window: AtomicU32::new(120),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: RwLock::new(std::collections::HashMap::new()),
            voice_tcp_conns: RwLock::new(HashMap::new()),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            accepting_connections: AtomicBool::new(true),
            edge_crypto: None,
        })
    }

    /// Create EdgeState with explicit voice routing strategy flags and listener limits.
    pub fn new_with_config(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        enable_hub_tcp_fallback: bool,
        listeners_per_user: u32,
        listeners_per_channel: u32,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            edge_id: AtomicU32::new(0),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: RwLock::new(HashMap::new()),
            peer_registry: RwLock::new(PeerRegistry::default()),
            enable_hub_tcp_fallback,
            consecutive_failure_threshold: 2,
            next_hop_failures: std::sync::RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user,
            listeners_per_channel,
            allow_ping: AtomicBool::new(true),
            rolling_stats_window: AtomicU32::new(120),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: RwLock::new(std::collections::HashMap::new()),
            voice_tcp_conns: RwLock::new(HashMap::new()),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            accepting_connections: AtomicBool::new(true),
            edge_crypto: None,
        })
    }

    /// Create EdgeState with full configuration including ping and stats settings.
    pub fn new_with_full_config(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        enable_hub_tcp_fallback: bool,
        consecutive_failure_threshold: u32,
        listeners_per_user: u32,
        listeners_per_channel: u32,
        allow_ping: bool,
        rolling_stats_window: u32,
        hmac_secret: Option<&str>,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        let edge_crypto = hmac_secret
            .and_then(EdgeCrypto::from_secret)
            .map(Arc::new);
        Arc::new(Self {
            edge_id: AtomicU32::new(0),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: RwLock::new(HashMap::new()),
            peer_registry: RwLock::new(PeerRegistry::default()),
            enable_hub_tcp_fallback,
            consecutive_failure_threshold,
            next_hop_failures: std::sync::RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user,
            listeners_per_channel,
            allow_ping: AtomicBool::new(allow_ping),
            rolling_stats_window: AtomicU32::new(rolling_stats_window),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: RwLock::new(std::collections::HashMap::new()),
            voice_tcp_conns: RwLock::new(HashMap::new()),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            accepting_connections: AtomicBool::new(true),
            edge_crypto,
        })
    }

    /// Apply hot-reloadable config fields from a freshly loaded EdgeConfig.
    ///
    /// Fields that require a full restart (ports, TLS, Hub address) are ignored.
    /// Fields that can be applied immediately are updated atomically.
    pub fn apply_hot_config(&self, config: &munode_common::config::EdgeConfig) {
        self.allow_ping.store(config.server.allow_ping, Ordering::Relaxed);
        self.rolling_stats_window.store(config.server.rolling_stats_window, Ordering::Relaxed);
    }

    /// Get the current edge ID (0 = not yet registered with Hub).
    /// Lock-free: uses atomic load for hot-path reads.
    ///
    /// Memory ordering: `Acquire` pairs with the `Release` store in `set_edge_id`,
    /// guaranteeing that any state written before `set_edge_id` is visible to
    /// code that reads a non-zero edge_id (e.g., voice routing after registration).
    #[inline(always)]
    pub fn get_edge_id(&self) -> u32 {
        self.edge_id.load(Ordering::Acquire)
    }

    /// Set the edge ID after Hub registration.
    pub fn set_edge_id(&self, id: u32) {
        self.edge_id.store(id, Ordering::Release);
    }

    /// Get a receiver for edge events.
    pub fn subscribe_events(&self) -> broadcast::Receiver<EdgeEvent> {
        self.event_tx.subscribe()
    }

    /// Broadcast an event.
    pub fn emit(&self, event: EdgeEvent) {
        let _ = self.event_tx.send(event);
    }

    /// Recompute `resolved_channels` for every cached VoiceTarget configuration.
    /// Call this whenever the channel link/tree structure changes so that
    /// per-packet routing uses up-to-date expanded channel sets.
    pub async fn recompute_all_vt_channels(&self) {
        // Snapshot all (session, target, channels) under a read lock.
        let snapshots: Vec<(u32, u32, Vec<VoiceTargetChannelConfig>)> = {
            let cache = self.voice_targets.read().await;
            cache
                .iter()
                .flat_map(|(&sid, vts)| {
                    vts.iter()
                        .map(move |(&tid, vt)| (sid, tid, vt.channels.clone()))
                })
                .collect()
        };
        if snapshots.is_empty() {
            return;
        }
        // Re-resolve each config outside the lock (async channel_manager calls).
        let mut resolved_list = Vec::with_capacity(snapshots.len());
        for (sid, tid, channels) in &snapshots {
            let r = resolve_voice_target_channels(channels, &self.channel_manager).await;
            resolved_list.push((*sid, *tid, r));
        }
        // Write all results back under a single write lock.
        let mut cache = self.voice_targets.write().await;
        for (sid, tid, resolved) in resolved_list {
            if let Some(vt) = cache.get_mut(&sid).and_then(|m| m.get_mut(&tid)) {
                vt.resolved_channels = resolved;
            }
        }
    }
}

