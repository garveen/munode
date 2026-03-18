use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use tokio::sync::{broadcast, mpsc, RwLock};

use munode_protocol::hubedge::ServerLimitsConfig;

use crate::channel_manager::ChannelManager;
use crate::client::ClientManager;

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
}

impl PeerRegistry {
    pub fn upsert(&mut self, edge_id: u32, info: PeerEdgeInfo) {
        self.peers.insert(edge_id, info);
    }

    pub fn remove(&mut self, edge_id: u32) {
        self.peers.remove(&edge_id);
    }

    pub fn get(&self, edge_id: u32) -> Option<&PeerEdgeInfo> {
        self.peers.get(&edge_id)
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
}

#[derive(Debug, Clone)]
pub struct VoiceTargetChannelConfig {
    pub channel_id: u32,
    pub links: bool,
    pub children: bool,
    pub group: Option<String>,
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
    pub next_hop_failures: RwLock<HashMap<u32, u32>>,
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
    /// Client-facing limits pushed from Hub on registration (and updated via heartbeat).
    /// When set, overrides Edge-local config for ServerSync/ServerConfig/rate limiting.
    pub hub_limits: RwLock<Option<ServerLimitsConfig>>,
    /// Test-only: percentage (0–100) of outbound Edge-to-Edge UDP packets to drop.
    /// When > 0, the UDP server will drop that fraction of packets before sending,
    /// simulating link degradation so that failure-fallback paths can be exercised.
    #[cfg(test)]
    pub test_udp_drop_rate: AtomicU32,
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
            next_hop_failures: RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user: 0,
            listeners_per_channel: 0,
            allow_ping: AtomicBool::new(true),
            rolling_stats_window: AtomicU32::new(120),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: RwLock::new(std::collections::HashMap::new()),
            voice_tcp_conns: RwLock::new(HashMap::new()),
            hub_limits: RwLock::new(None),
            #[cfg(test)]
            test_udp_drop_rate: AtomicU32::new(0),
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
            next_hop_failures: RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user,
            listeners_per_channel,
            allow_ping: AtomicBool::new(true),
            rolling_stats_window: AtomicU32::new(120),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: RwLock::new(std::collections::HashMap::new()),
            voice_tcp_conns: RwLock::new(HashMap::new()),
            hub_limits: RwLock::new(None),
            #[cfg(test)]
            test_udp_drop_rate: AtomicU32::new(0),
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
            consecutive_failure_threshold,
            next_hop_failures: RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user,
            listeners_per_channel,
            allow_ping: AtomicBool::new(allow_ping),
            rolling_stats_window: AtomicU32::new(rolling_stats_window),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: RwLock::new(std::collections::HashMap::new()),
            voice_tcp_conns: RwLock::new(HashMap::new()),
            hub_limits: RwLock::new(None),
            #[cfg(test)]
            test_udp_drop_rate: AtomicU32::new(0),
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candidate(decision: RouteDecision, cost: f32) -> RouteCandidate {
        RouteCandidate { decision, cost }
    }

    /// Returns the chosen RouteDecision from a candidate list given a failure map,
    /// mirroring the selection logic in udp.rs route_voice.
    fn select_candidate(
        candidates: &[RouteCandidate],
        failures: &HashMap<u32, u32>,
        threshold: u32,
    ) -> Option<RouteDecision> {
        let mut chosen = None;
        for candidate in candidates {
            // Determine which "next hop" edge ID this candidate uses
            let next_hop_id: Option<u32> = match &candidate.decision {
                RouteDecision::DirectUdp => None, // uses target directly; skip threshold
                RouteDecision::DirectTcp => None,
                RouteDecision::HubTcp => None,
                RouteDecision::RelayChain { hops, .. } => hops.first().copied(),
            };

            let fail_count = next_hop_id
                .and_then(|id| failures.get(&id).copied())
                .unwrap_or(0);

            if threshold == 0 || fail_count < threshold {
                chosen = Some(candidate.decision.clone());
                break;
            }
        }
        chosen.or_else(|| candidates.first().map(|c| c.decision.clone()))
    }

    #[test]
    fn test_first_candidate_chosen_normally() {
        let candidates = vec![
            make_candidate(RouteDecision::DirectUdp, 30.0),
            make_candidate(RouteDecision::HubTcp, 150.0),
        ];
        let failures = HashMap::new();
        let chosen = select_candidate(&candidates, &failures, 2);
        assert_eq!(chosen, Some(RouteDecision::DirectUdp));
    }

    #[test]
    fn test_fallback_when_first_hop_over_threshold() {
        // RelayChain via hop 99 has 2 failures → skip it; fall through to HubTcp
        let candidates = vec![
            make_candidate(RouteDecision::RelayChain { hops: vec![99], transports: vec![HopTransport::Udp] }, 45.0),
            make_candidate(RouteDecision::HubTcp, 150.0),
        ];
        let mut failures = HashMap::new();
        failures.insert(99, 2u32); // at threshold (threshold=2 means >= 2 → skip)

        let chosen = select_candidate(&candidates, &failures, 2);
        assert_eq!(chosen, Some(RouteDecision::HubTcp));
    }

    #[test]
    fn test_still_uses_first_candidate_when_threshold_zero() {
        // threshold=0 means disabled — always pick first regardless of failure count
        let candidates = vec![
            make_candidate(RouteDecision::RelayChain { hops: vec![99], transports: vec![HopTransport::Udp] }, 45.0),
            make_candidate(RouteDecision::HubTcp, 150.0),
        ];
        let mut failures = HashMap::new();
        failures.insert(99, 999u32);

        let chosen = select_candidate(&candidates, &failures, 0);
        assert_eq!(chosen, Some(RouteDecision::RelayChain {
            hops: vec![99],
            transports: vec![HopTransport::Udp],
        }));
    }

    #[test]
    fn test_fallback_all_over_threshold_uses_first() {
        // Even if every candidate's hop is over threshold, pick the first (better than silence)
        let candidates = vec![
            make_candidate(RouteDecision::RelayChain { hops: vec![10], transports: vec![HopTransport::Udp] }, 30.0),
            make_candidate(RouteDecision::RelayChain { hops: vec![20], transports: vec![HopTransport::Udp] }, 50.0),
        ];
        let mut failures = HashMap::new();
        failures.insert(10, 5u32);
        failures.insert(20, 5u32);

        let chosen = select_candidate(&candidates, &failures, 2);
        // Falls back to first (better than silence)
        assert_eq!(chosen, Some(RouteDecision::RelayChain {
            hops: vec![10],
            transports: vec![HopTransport::Udp],
        }));
    }

    #[test]
    fn test_empty_candidates_returns_none() {
        let chosen = select_candidate(&[], &HashMap::new(), 2);
        assert_eq!(chosen, None);
    }

    #[test]
    fn test_direct_tcp_candidate_not_penalised_by_hop_failures() {
        // DirectTcp has no next_hop_id → never penalised by failure counter
        let candidates = vec![
            make_candidate(RouteDecision::DirectTcp, 52.0),
            make_candidate(RouteDecision::HubTcp, 150.0),
        ];
        let mut failures = HashMap::new();
        // Simulate all peers being "failed" — shouldn't affect DirectTcp
        for id in 0..10u32 { failures.insert(id, 99); }

        let chosen = select_candidate(&candidates, &failures, 2);
        assert_eq!(chosen, Some(RouteDecision::DirectTcp));
    }

    // ── test_udp_drop_rate field initialises to zero ─────────────────────────

    #[test]
    fn test_edge_state_drop_rate_starts_zero() {
        use std::sync::atomic::Ordering;
        let cm = crate::channel_manager::ChannelManager::new();
        let clm = crate::client::ClientManager::new();
        let state = EdgeState::new(cm, clm, true);
        assert_eq!(state.test_udp_drop_rate.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_edge_state_drop_rate_settable() {
        use std::sync::atomic::Ordering;
        let cm = crate::channel_manager::ChannelManager::new();
        let clm = crate::client::ClientManager::new();
        let state = EdgeState::new(cm, clm, true);
        state.test_udp_drop_rate.store(50, Ordering::Relaxed);
        assert_eq!(state.test_udp_drop_rate.load(Ordering::Relaxed), 50);
    }
}
