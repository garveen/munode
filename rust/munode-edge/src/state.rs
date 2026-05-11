use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use arc_swap::ArcSwap;
use smallvec::SmallVec;
use tokio::sync::{broadcast, RwLock};

use munode_protocol::hubedge::ServerLimitsConfig;

use crate::channel_manager::ChannelManager;
use crate::client::ClientManager;
use crate::edge_crypto::EdgeCrypto;
use crate::peer_registry::{PeerRegistry, PeerVoiceTcpPool};

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

/// Cached local whisper route for one `(sender_session, target_id)` pair.
///
/// This is the fully materialized result of expanding a VoiceTarget against the
/// current local Edge state. It intentionally mirrors the transport-facing split
/// between direct whisper targets and channel shout targets.
#[derive(Debug, Clone)]
pub struct WhisperRouteCacheEntry {
    pub direct_sessions: SmallVec<[u32; 8]>,
    pub channel_sessions: SmallVec<[u32; 16]>,
    pub relay_edge_ids: SmallVec<[u32; 8]>,
}

/// Per-sender whisper cache state.
///
/// `topology_version` is compared against `EdgeState::topology_version` before a
/// cached target entry may be reused.
#[derive(Debug, Clone, Default)]
pub struct SessionWhisperRouteCache {
    pub topology_version: u64,
    pub targets: HashMap<u32, WhisperRouteCacheEntry>,
}

/// Convert a `HashMap<u32, VoiceTargetConfig>` to a `HotVoiceTargetMap` for storage in
/// `HotSlot::voice_targets`.
pub fn build_hot_vt_map(
    session_vts: &std::collections::HashMap<u32, VoiceTargetConfig>,
) -> crate::hot_slot::HotVoiceTargetMap {
    session_vts
        .iter()
        .map(|(&tid, vt)| {
            (tid, crate::hot_slot::HotVoiceTarget {
                sessions: vt.sessions.clone(),
                resolved_channels: vt.resolved_channels.clone(),
            })
        })
        .collect()
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
    pub actor_session: Option<u32>,
}

/// Events broadcast within the Edge server.
#[derive(Debug, Clone)]
pub enum EdgeEvent {
    /// Hub registration and full sync completed.
    /// `disappeared_session_ids`: remote session IDs that were in the local
    /// cache *before* the sync but are absent from the fresh Hub snapshot —
    /// the event loop should send UserRemove for these to all local clients.
    HubRegistered { disappeared_session_ids: Vec<u32> },
    /// Deferred reconciliation after a Hub cold-restart grace period.
    ///
    /// Emitted by the grace-period timer in `hub_client` when `hub_was_empty`
    /// was set in the fullsync response.  Contains the session IDs that were in
    /// the pre-restart cache and are **still absent** after waiting for peer
    /// Edges to re-report.  The event listener sends `UserRemove` for each.
    HubReconcileDisappeared { session_ids: Vec<u32> },
    /// Hub connection lost.
    HubDisconnected,
    /// Hub is completely unreachable: both direct and relay connections failed.
    /// All connected clients should be disconnected and wait for Hub to recover.
    HubUnreachable,
    /// A remote user joined (from another Edge, synced via Hub).
    RemoteUserJoined { session_id: u32, username: String, channel_id: u32, is_ninja: bool },
    /// A remote user left.
    RemoteUserLeft { session_id: u32, channel_id: u32 },
    /// A remote user's state changed (mute, deaf, etc.).
    RemoteUserStateChanged {
        session_id: u32,
        delta: RemoteUserStateDelta,
        listening_channel_add: Vec<u32>,
        listening_channel_remove: Vec<u32>,
        actor_session: Option<u32>,
    },
    /// A remote user moved channels.
    RemoteUserMoved { session_id: u32, from_channel_id: u32, channel_id: u32, actor_session: u32 },
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
    /// Hub requested this Edge to shut down (cluster partition handling).
    ShutdownRequested {
        reason: String,
    },
    /// Hub ACL was updated for a channel; Edges should re-evaluate can_enter for all clients.
    /// `is_enter_restricted` is pre-computed by the Hub at ACL-save time and embedded in the
    /// notification so that Edges never need a separate RPC just for this channel-level flag.
    AclUpdated { channel_id: u32, is_enter_restricted: bool },
    /// All TCP voice connections to a peer Edge have been down for an extended period.
    /// The event listener should call `edge.reportPeerDisconnect` so that the Hub can
    /// run partition-arbitration logic and — if both sides report — broadcast `hub.peerLeft`
    /// and optionally shut down the smaller partition.
    PeerVoiceTcpFailed { peer_edge_id: u32 },
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
    /// Lock-free reads via ArcSwap; writes (peerJoined/peerLeft) use clone-modify-store.
    pub peer_registry: ArcSwap<PeerRegistry>,
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
    /// 0 = unlimited.  Updated atomically when Hub pushes a new `ServerLimitsConfig`.
    pub listeners_per_user: AtomicU32,
    /// Maximum number of listeners allowed in a single channel.
    /// 0 = unlimited.  Updated atomically when Hub pushes a new `ServerLimitsConfig`.
    pub listeners_per_channel: AtomicU32,
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
    /// Lock-free reads via ArcSwap; written atomically after full rebuild on routeTableUpdate.
    pub route_table: ArcSwap<std::collections::HashMap<u32, Vec<RouteCandidate>>>,
    /// Outbound TCP voice connection pools to peer Edges.
    /// Maps peer_edge_id → connection pool (N independent WebSocket connections).
    /// Populated on peerJoined; lock-free reads via ArcSwap.
    pub voice_tcp_conns: ArcSwap<HashMap<u32, Arc<PeerVoiceTcpPool>>>,
    /// Set of peer edge IDs for which a voice TCP connection manager task is running.
    /// Inserting an ID before spawning the task prevents duplicate reconnect tasks.
    /// Removing an ID (on hub.peerLeft) causes the reconnect loop to stop.
    pub voice_tcp_peers: RwLock<HashSet<u32>>,
    /// Number of parallel TCP voice connections to maintain to each peer Edge.
    /// Configured from `voice_routing.peer_voice_tcp_pool_size`.
    pub peer_voice_tcp_pool_size: usize,
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
    /// Local session ID allocator.
    /// Each Edge owns a range of 10,000 session IDs: edge_id * 10000 to (edge_id + 1) * 10000 - 1.
    /// This set tracks which IDs within the range are currently in use.
    /// Using RwLock because: reads are common (check availability), writes only on connect/disconnect.
    pub used_session_ids: RwLock<HashSet<u32>>,
    /// Monotonic counter for session ID allocation.  Ensures recently freed IDs are not
    /// immediately reused, making it easier to detect stale references in tests and clients.
    pub session_counter: AtomicU32,
    /// Limits the number of concurrent Hub authentication RPCs.
    ///
    /// Prevents a burst of simultaneous client connections (e.g. server restart) from
    /// overwhelming the Hub auth service.  32 permits = comfortable headroom for a fast
    /// connection burst while keeping Hub load bounded.
    pub auth_semaphore: tokio::sync::Semaphore,
    /// Cache of Hub permission query results: (session_id, channel_id) → permission bitmask.
    ///
    /// Eliminates redundant Hub RPC round-trips for repeated permission checks on the same
    /// (session, channel) pair.  The cache is invalidated on `AclUpdated` events (by channel)
    /// and cleared per-session on disconnect.
    pub permission_cache: dashmap::DashMap<(u32, u32), u32>,
    /// Cache of channel-level enter-restriction flags: channel_id → is_enter_restricted.
    ///
    /// `is_enter_restricted` is a pure channel property (independent of the viewer) that
    /// indicates whether any ACL entry effectively applied to the channel carries a
    /// `deny & Enter` bit.  Clients use it to display a lock icon regardless of their own
    /// permissions.  The value is populated at login time (from the batch permission query)
    /// and refreshed inline on every `AclUpdated` event from the Hub (which now embeds the
    /// pre-computed flag), so no separate RPC is ever needed just for this field.
    /// Entries are removed when a channel is deleted (`ChannelRemoved` event).
    pub enter_restricted_cache: dashmap::DashMap<u32, bool>,
    /// Monotonically increasing topology version counter.
    /// Incremented on every client join/leave/channel-move/deaf-change event so that
    /// per-sender `BroadcastCache` entries can detect staleness without holding any lock.
    pub topology_version: AtomicU64,
    /// Per-sender whisper route cache: `sender_session -> SessionWhisperRouteCache`.
    ///
    /// Unlike `voice_targets`, this cache stores the fully expanded LOCAL recipient
    /// sets for whisper traffic. Entries are validated against `topology_version`
    /// and explicitly removed when a sender rewrites or clears a VoiceTarget.
    pub whisper_route_cache: std::sync::RwLock<HashMap<u32, SessionWhisperRouteCache>>,
    /// Shared map session_id → UDP source address.
    ///
    /// Authoritative source for the "client supports UDP" decision used by the
    /// voice send path.  Mirrors Murmur's per-user `aiUdpFlag`:
    ///
    /// * Presence  → server sends voice to this client over UDP.
    /// * Absence   → server falls back to TCP (`UdpTunnel`).
    ///
    /// Populated by `UdpServer::register_client` on the first successfully
    /// decrypted UDP voice packet from the client, and explicitly cleared when
    /// the client falls back to sending voice over TCP `UdpTunnel` (which
    /// indicates that bidirectional UDP is no longer working) or on
    /// disconnect.  `UdpServer` clones this Arc on construction.
    pub udp_session_to_addr: Arc<dashmap::DashMap<u32, std::net::SocketAddr>>,
}

impl EdgeState {
    pub fn new(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        enable_hub_tcp_fallback: bool,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(4096);
        Arc::new(Self {
            edge_id: AtomicU32::new(0),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: RwLock::new(HashMap::new()),
            peer_registry: ArcSwap::new(Arc::new(PeerRegistry::default())),
            enable_hub_tcp_fallback,
            consecutive_failure_threshold: 2,
            next_hop_failures: std::sync::RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user: AtomicU32::new(0),
            listeners_per_channel: AtomicU32::new(0),
            allow_ping: AtomicBool::new(true),
            rolling_stats_window: AtomicU32::new(120),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: ArcSwap::new(Arc::new(std::collections::HashMap::new())),
            voice_tcp_conns: ArcSwap::new(Arc::new(HashMap::new())),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            peer_voice_tcp_pool_size: 2,
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            accepting_connections: AtomicBool::new(true),
            edge_crypto: None,
            used_session_ids: RwLock::new(HashSet::new()),
            session_counter: AtomicU32::new(0),
            auth_semaphore: tokio::sync::Semaphore::new(32),
            permission_cache: dashmap::DashMap::new(),
            enter_restricted_cache: dashmap::DashMap::new(),
            topology_version: AtomicU64::new(0),
            whisper_route_cache: std::sync::RwLock::new(HashMap::new()),
            udp_session_to_addr: Arc::new(dashmap::DashMap::new()),
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
        let (event_tx, _) = broadcast::channel(4096);
        Arc::new(Self {
            edge_id: AtomicU32::new(0),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: RwLock::new(HashMap::new()),
            peer_registry: ArcSwap::new(Arc::new(PeerRegistry::default())),
            enable_hub_tcp_fallback,
            consecutive_failure_threshold: 2,
            next_hop_failures: std::sync::RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user: AtomicU32::new(listeners_per_user),
            listeners_per_channel: AtomicU32::new(listeners_per_channel),
            allow_ping: AtomicBool::new(true),
            rolling_stats_window: AtomicU32::new(120),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: ArcSwap::new(Arc::new(std::collections::HashMap::new())),
            voice_tcp_conns: ArcSwap::new(Arc::new(HashMap::new())),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            peer_voice_tcp_pool_size: 2,
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            accepting_connections: AtomicBool::new(true),
            edge_crypto: None,
            used_session_ids: RwLock::new(HashSet::new()),
            session_counter: AtomicU32::new(0),
            auth_semaphore: tokio::sync::Semaphore::new(32),
            permission_cache: dashmap::DashMap::new(),
            enter_restricted_cache: dashmap::DashMap::new(),
            topology_version: AtomicU64::new(0),
            whisper_route_cache: std::sync::RwLock::new(HashMap::new()),
            udp_session_to_addr: Arc::new(dashmap::DashMap::new()),
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
        peer_voice_tcp_pool_size: usize,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(4096);
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
            peer_registry: ArcSwap::new(Arc::new(PeerRegistry::default())),
            enable_hub_tcp_fallback,
            consecutive_failure_threshold,
            next_hop_failures: std::sync::RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user: AtomicU32::new(listeners_per_user),
            listeners_per_channel: AtomicU32::new(listeners_per_channel),
            allow_ping: AtomicBool::new(allow_ping),
            rolling_stats_window: AtomicU32::new(rolling_stats_window),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: ArcSwap::new(Arc::new(std::collections::HashMap::new())),
            voice_tcp_conns: ArcSwap::new(Arc::new(HashMap::new())),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            peer_voice_tcp_pool_size: peer_voice_tcp_pool_size.max(1),
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            accepting_connections: AtomicBool::new(true),
            edge_crypto,
            used_session_ids: RwLock::new(HashSet::new()),
            session_counter: AtomicU32::new(0),
            auth_semaphore: tokio::sync::Semaphore::new(32),
            permission_cache: dashmap::DashMap::new(),
            enter_restricted_cache: dashmap::DashMap::new(),
            topology_version: AtomicU64::new(0),
            whisper_route_cache: std::sync::RwLock::new(HashMap::new()),
            udp_session_to_addr: Arc::new(dashmap::DashMap::new()),
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

    /// Look up a cached local whisper route for the given sender/target pair.
    #[inline]
    pub fn get_cached_whisper_route(
        &self,
        sender_session: u32,
        target_id: u32,
        topology_version: u64,
    ) -> Option<WhisperRouteCacheEntry> {
        let cache = self.whisper_route_cache.read().unwrap();
        let session_cache = cache.get(&sender_session)?;
        if session_cache.topology_version != topology_version {
            return None;
        }
        session_cache.targets.get(&target_id).cloned()
    }

    /// Store or replace a cached local whisper route for one sender/target pair.
    pub fn store_cached_whisper_route(
        &self,
        sender_session: u32,
        target_id: u32,
        topology_version: u64,
        entry: WhisperRouteCacheEntry,
    ) {
        let mut cache = self.whisper_route_cache.write().unwrap();
        let session_cache = cache.entry(sender_session).or_default();
        if session_cache.topology_version != topology_version {
            session_cache.topology_version = topology_version;
            session_cache.targets.clear();
        }
        session_cache.targets.insert(target_id, entry);
    }

    /// Remove one cached whisper route for a sender.
    pub fn clear_cached_whisper_target(&self, sender_session: u32, target_id: u32) {
        let mut cache = self.whisper_route_cache.write().unwrap();
        if let Some(session_cache) = cache.get_mut(&sender_session) {
            session_cache.targets.remove(&target_id);
            if session_cache.targets.is_empty() {
                cache.remove(&sender_session);
            }
        }
    }

    /// Remove all cached whisper routes for a sender.
    pub fn clear_cached_whisper_session(&self, sender_session: u32) {
        self.whisper_route_cache.write().unwrap().remove(&sender_session);
    }

    /// Remove all cached whisper routes.
    pub fn clear_all_cached_whisper_routes(&self) {
        self.whisper_route_cache.write().unwrap().clear();
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
        // Sync updated configs into each session's HotSlot for lock-free routing.
        for (&sid, session_vts) in cache.iter() {
            let hot_map: crate::hot_slot::HotVoiceTargetMap = session_vts
                .iter()
                .map(|(&tid, vt)| {
                    (tid, crate::hot_slot::HotVoiceTarget {
                        sessions: vt.sessions.clone(),
                        resolved_channels: vt.resolved_channels.clone(),
                    })
                })
                .collect();
            crate::hot_slot::get_hot_slot(sid)
                .voice_targets
                .store(std::sync::Arc::new(Some(std::sync::Arc::new(hot_map))));
        }
    }

    /// Allocate a session ID from this Edge's local pool.
    ///
    /// Each Edge owns a range of 10,000 session IDs based on its edge_id:
    /// - Edge 1: 10,000 - 19,999
    /// - Edge 2: 20,000 - 29,999
    /// - Edge N: N*10,000 - (N+1)*10,000 - 1
    ///
    /// Returns `None` if all 10,000 slots in this Edge's range are currently in use,
    /// or if the Edge has not yet registered with Hub (edge_id == 0).
    pub async fn allocate_session_id(&self) -> Option<u32> {
        let edge_id = self.get_edge_id();
        if edge_id == 0 {
            return None; // Not registered yet
        }

        const POOL_SIZE: u32 = 10_000;
        let base = edge_id * POOL_SIZE;

        let mut used = self.used_session_ids.write().await;

        // Scan from the current counter position to avoid reusing recently freed IDs.
        // The counter wraps around the pool; a full scan is still bounded at POOL_SIZE.
        for _ in 0..POOL_SIZE {
            let offset = self.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % POOL_SIZE;
            let id = base + offset;
            if !used.contains(&id) {
                used.insert(id);
                return Some(id);
            }
        }

        // All 10,000 slots are in use
        None
    }

    /// Free a session ID, returning it to this Edge's local pool.
    pub async fn free_session_id(&self, session_id: u32) {
        self.used_session_ids.write().await.remove(&session_id);
    }

    /// Get the count of currently allocated session IDs.
    pub async fn session_id_count(&self) -> usize {
        self.used_session_ids.read().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::{EdgeState, WhisperRouteCacheEntry};
    use crate::channel_manager::ChannelManager;
    use crate::client::ClientManager;
    use smallvec::smallvec;

    #[test]
    fn whisper_cache_returns_only_matching_topology_version() {
        let state = EdgeState::new(ChannelManager::new(), ClientManager::new(), false);

        state.store_cached_whisper_route(
            10_001,
            3,
            7,
            WhisperRouteCacheEntry {
                direct_sessions: smallvec![20_001],
                channel_sessions: smallvec![20_002, 20_003],
                relay_edge_ids: smallvec![2, 3],
            },
        );

        let hit = state
            .get_cached_whisper_route(10_001, 3, 7)
            .expect("matching topology version should hit");
        assert_eq!(hit.direct_sessions.as_slice(), &[20_001]);
        assert_eq!(hit.channel_sessions.as_slice(), &[20_002, 20_003]);
        assert_eq!(hit.relay_edge_ids.as_slice(), &[2, 3]);

        assert!(state.get_cached_whisper_route(10_001, 3, 8).is_none());
    }

    #[test]
    fn whisper_cache_replaces_old_session_entries_on_version_change() {
        let state = EdgeState::new(ChannelManager::new(), ClientManager::new(), false);

        state.store_cached_whisper_route(
            10_001,
            1,
            5,
            WhisperRouteCacheEntry {
                direct_sessions: smallvec![30_001],
                channel_sessions: smallvec![30_002],
                relay_edge_ids: smallvec![4],
            },
        );
        state.store_cached_whisper_route(
            10_001,
            2,
            6,
            WhisperRouteCacheEntry {
                direct_sessions: smallvec![31_001],
                channel_sessions: smallvec![31_002],
                relay_edge_ids: smallvec![5],
            },
        );

        assert!(state.get_cached_whisper_route(10_001, 1, 6).is_none());
        let hit = state
            .get_cached_whisper_route(10_001, 2, 6)
            .expect("latest target should remain after version change");
        assert_eq!(hit.direct_sessions.as_slice(), &[31_001]);
        assert_eq!(hit.channel_sessions.as_slice(), &[31_002]);
        assert_eq!(hit.relay_edge_ids.as_slice(), &[5]);
    }

    #[test]
    fn whisper_cache_clears_target_and_session_entries() {
        let state = EdgeState::new(ChannelManager::new(), ClientManager::new(), false);

        for target_id in [1_u32, 2_u32] {
            state.store_cached_whisper_route(
                10_001,
                target_id,
                9,
                WhisperRouteCacheEntry {
                    direct_sessions: smallvec![40_000 + target_id],
                    channel_sessions: smallvec![50_000 + target_id],
                    relay_edge_ids: smallvec![target_id],
                },
            );
        }

        state.clear_cached_whisper_target(10_001, 1);
        assert!(state.get_cached_whisper_route(10_001, 1, 9).is_none());
        assert!(state.get_cached_whisper_route(10_001, 2, 9).is_some());

        state.clear_cached_whisper_session(10_001);
        assert!(state.get_cached_whisper_route(10_001, 2, 9).is_none());
    }

    #[test]
    fn whisper_cache_can_be_cleared_globally() {
        let state = EdgeState::new(ChannelManager::new(), ClientManager::new(), false);

        for (sender_session, target_id, version) in [(10_001_u32, 1_u32, 4_u64), (10_002, 2, 5)] {
            state.store_cached_whisper_route(
                sender_session,
                target_id,
                version,
                WhisperRouteCacheEntry {
                    direct_sessions: smallvec![sender_session + 1],
                    channel_sessions: smallvec![sender_session + 2],
                    relay_edge_ids: smallvec![2],
                },
            );
        }

        state.clear_all_cached_whisper_routes();

        assert!(state.get_cached_whisper_route(10_001, 1, 4).is_none());
        assert!(state.get_cached_whisper_route(10_002, 2, 5).is_none());
    }
}

