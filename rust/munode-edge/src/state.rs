use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use arc_swap::ArcSwap;
use tokio::net::UdpSocket;
use tokio::sync::{Mutex, RwLock, broadcast};

use munode_protocol::hubedge::ServerLimitsConfig;

use crate::channel_manager::ChannelManager;
use crate::client::ClientManager;
use crate::edge_crypto::EdgeCrypto;
use crate::peer_registry::{PeerRegistry, PeerVoiceTcpPool};
use crate::voice_target::{SessionWhisperRouteCache, VoiceTargetConfig, WhisperRouteCacheEntry};

const TEST_EDGE_UDP_DROP_RATE_ENV: &str = "MUNODE_TEST_EDGE_UDP_DROP_RATE";
const TEST_EDGE_UDP_BLOCK_PEERS_ENV: &str = "MUNODE_TEST_EDGE_UDP_BLOCK_PEERS";
const TEST_EDGE_VOICE_TCP_BLOCK_PEERS_ENV: &str = "MUNODE_TEST_EDGE_VOICE_TCP_BLOCK_PEERS";

pub struct EdgeStateConfig<'a> {
    pub enable_hub_tcp_fallback: bool,
    pub consecutive_failure_threshold: u32,
    pub listeners_per_user: u32,
    pub listeners_per_channel: u32,
    pub allow_ping: bool,
    pub rolling_stats_window: u32,
    pub hmac_secret: Option<&'a str>,
    pub peer_voice_tcp_pool_size: usize,
    pub peer_quality_sample_window_size: usize,
    pub peer_quality_probe_timeout_secs: u64,
}

#[derive(Debug, Clone, Default)]
pub struct TestNetworkFaults {
    udp_drop_rate: u32,
    udp_block_peers: HashSet<u32>,
    voice_tcp_block_peers: HashSet<u32>,
}

impl TestNetworkFaults {
    pub fn from_env() -> Self {
        Self {
            udp_drop_rate: std::env::var(TEST_EDGE_UDP_DROP_RATE_ENV)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(0)
                .min(100),
            udp_block_peers: parse_test_peer_set_env(TEST_EDGE_UDP_BLOCK_PEERS_ENV),
            voice_tcp_block_peers: parse_test_peer_set_env(TEST_EDGE_VOICE_TCP_BLOCK_PEERS_ENV),
        }
    }

    pub fn udp_drop_rate(&self) -> u32 {
        self.udp_drop_rate
    }

    pub fn blocks_udp_to(&self, peer_edge_id: u32) -> bool {
        self.udp_block_peers.contains(&peer_edge_id)
    }

    pub fn blocks_voice_tcp_to(&self, peer_edge_id: u32) -> bool {
        self.voice_tcp_block_peers.contains(&peer_edge_id)
    }

    pub fn is_empty(&self) -> bool {
        self.udp_drop_rate == 0
            && self.udp_block_peers.is_empty()
            && self.voice_tcp_block_peers.is_empty()
    }

    pub fn udp_block_peers(&self) -> Vec<u32> {
        let mut peers: Vec<u32> = self.udp_block_peers.iter().copied().collect();
        peers.sort_unstable();
        peers
    }

    pub fn voice_tcp_block_peers(&self) -> Vec<u32> {
        let mut peers: Vec<u32> = self.voice_tcp_block_peers.iter().copied().collect();
        peers.sort_unstable();
        peers
    }
}

fn parse_test_peer_set_env(key: &str) -> HashSet<u32> {
    std::env::var(key)
        .ok()
        .into_iter()
        .flat_map(|value| {
            value
                .split(',')
                .map(str::to_owned)
                .collect::<Vec<_>>()
                .into_iter()
        })
        .filter_map(|token| {
            let trimmed = token.trim();
            if trimmed.is_empty() {
                None
            } else {
                trimmed.parse::<u32>().ok().filter(|edge_id| *edge_id != 0)
            }
        })
        .collect()
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

/// Per-peer local quality tracking state used by UDP probe reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerQualitySampleSource {
    Probe,
    DirectVoice,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PeerQualitySample {
    pub expected_packets: u32,
    pub received_packets: u32,
    pub rtt_ms: Option<f32>,
    pub source: PeerQualitySampleSource,
}

#[derive(Debug, Clone, Default)]
pub struct PeerQualityState {
    /// Pending ping sequences: seq → sent_ms.
    pub pending_pings: HashMap<u32, u64>,
    /// Completed rolling quality observations.
    pub samples: VecDeque<PeerQualitySample>,
    /// Rolling RTT samples sourced only from successful probe pongs.
    pub probe_rtt_samples: VecDeque<f32>,
    /// Next probe sequence number.
    pub next_seq: u32,
    /// Last accepted transport sequence from the direct peer voice stream.
    pub last_direct_voice_seq: Option<u16>,
    /// Last time a probe was sent to this peer.
    pub last_probe_sent_ms: Option<u64>,
    /// Last time a pong was received from this peer.
    pub last_pong_received_ms: Option<u64>,
    /// Last time a quality report for this peer was flushed upstream.
    pub last_report_ms: Option<u64>,
    /// Most recent reported average RTT.
    pub last_report_average_rtt_ms: Option<f32>,
    /// Most recent reported packet loss.
    pub last_report_packet_loss: Option<f32>,
    /// Most recent reported jitter.
    pub last_report_jitter_ms: Option<f32>,
}

impl PeerQualityState {
    fn push_sample(&mut self, sample: PeerQualitySample, sample_window_size: usize) {
        if sample.expected_packets == 0 {
            return;
        }

        self.samples.push_back(sample);
        while self.samples.len() > sample_window_size.max(1) {
            self.samples.pop_front();
        }
    }

    fn push_probe_rtt_sample(&mut self, rtt_ms: f32, sample_window_size: usize) {
        self.probe_rtt_samples.push_back(rtt_ms);
        while self.probe_rtt_samples.len() > sample_window_size.max(1) {
            self.probe_rtt_samples.pop_front();
        }
    }

    pub fn expire_stale_pings(
        &mut self,
        now_ms: u64,
        timeout_ms: u64,
        sample_window_size: usize,
    ) -> usize {
        let stale: Vec<u32> = self
            .pending_pings
            .iter()
            .filter_map(|(&seq, &sent_ms)| {
                now_ms
                    .saturating_sub(sent_ms)
                    .ge(&timeout_ms)
                    .then_some(seq)
            })
            .collect();

        let expired_count = stale.len();

        for seq in stale {
            self.pending_pings.remove(&seq);
            self.push_sample(
                PeerQualitySample {
                    expected_packets: 1,
                    received_packets: 0,
                    rtt_ms: None,
                    source: PeerQualitySampleSource::Probe,
                },
                sample_window_size,
            );
        }

        expired_count
    }

    pub fn record_probe_success(
        &mut self,
        seq: u32,
        now_ms: u64,
        sample_window_size: usize,
    ) -> bool {
        let Some(sent_ms) = self.pending_pings.remove(&seq) else {
            return false;
        };

        let rtt_ms = now_ms.saturating_sub(sent_ms) as f32;
        self.push_sample(
            PeerQualitySample {
                expected_packets: 1,
                received_packets: 1,
                rtt_ms: Some(rtt_ms),
                source: PeerQualitySampleSource::Probe,
            },
            sample_window_size,
        );
        self.push_probe_rtt_sample(rtt_ms, sample_window_size);
        self.last_pong_received_ms = Some(now_ms);
        true
    }

    pub fn record_direct_voice_packet(&mut self, seq: u16, sample_window_size: usize) {
        match self.last_direct_voice_seq {
            Some(previous_seq) => {
                let ahead = seq.wrapping_sub(previous_seq);
                if ahead != 0 && ahead < 0x8000 {
                    self.push_sample(
                        PeerQualitySample {
                            expected_packets: ahead as u32,
                            received_packets: 1,
                            rtt_ms: None,
                            source: PeerQualitySampleSource::DirectVoice,
                        },
                        sample_window_size,
                    );
                    self.last_direct_voice_seq = Some(seq);
                }
            }
            None => {
                self.push_sample(
                    PeerQualitySample {
                        expected_packets: 1,
                        received_packets: 1,
                        rtt_ms: None,
                        source: PeerQualitySampleSource::DirectVoice,
                    },
                    sample_window_size,
                );
                self.last_direct_voice_seq = Some(seq);
            }
        }
    }

    pub fn sample_count(&self) -> usize {
        self.samples
            .iter()
            .map(|sample| sample.expected_packets as usize)
            .sum()
    }

    pub fn probe_sample_count(&self) -> usize {
        self.samples
            .iter()
            .filter(|sample| sample.source == PeerQualitySampleSource::Probe)
            .count()
    }

    pub fn probe_success_count(&self) -> usize {
        self.samples
            .iter()
            .filter(|sample| {
                sample.source == PeerQualitySampleSource::Probe && sample.received_packets > 0
            })
            .count()
    }

    pub fn direct_voice_sample_count(&self) -> usize {
        self.samples
            .iter()
            .filter(|sample| sample.source == PeerQualitySampleSource::DirectVoice)
            .count()
    }

    pub fn direct_voice_totals(&self) -> (u32, u32) {
        self.samples
            .iter()
            .fold((0, 0), |(expected, received), sample| {
                if sample.source == PeerQualitySampleSource::DirectVoice {
                    (
                        expected.saturating_add(sample.expected_packets),
                        received.saturating_add(sample.received_packets),
                    )
                } else {
                    (expected, received)
                }
            })
    }

    pub fn rtt_sample_count(&self) -> usize {
        self.probe_rtt_samples.len()
    }

    pub fn rtt_samples_ms(&self) -> Vec<f32> {
        self.probe_rtt_samples.iter().copied().collect()
    }

    pub fn average_rtt_ms(&self) -> Option<f32> {
        let rtt_samples = self.rtt_samples_ms();
        if rtt_samples.is_empty() {
            None
        } else {
            Some(rtt_samples.iter().sum::<f32>() / rtt_samples.len() as f32)
        }
    }

    pub fn packet_loss(&self) -> Option<f32> {
        let (expected_packets, received_packets) =
            self.samples
                .iter()
                .fold((0u32, 0u32), |(expected, received), sample| {
                    (
                        expected.saturating_add(sample.expected_packets),
                        received.saturating_add(sample.received_packets),
                    )
                });

        if expected_packets == 0 {
            None
        } else {
            Some((1.0 - (received_packets as f32 / expected_packets as f32)).clamp(0.0, 1.0))
        }
    }

    pub fn jitter_ms(&self) -> Option<f32> {
        let rtt_samples = self.rtt_samples_ms();
        if rtt_samples.len() < 2 {
            return None;
        }

        let mut diffs = 0.0;
        let mut count = 0usize;
        let mut iter = rtt_samples.into_iter();
        let mut previous = iter.next()?;

        for current in iter {
            diffs += (current - previous).abs();
            count += 1;
            previous = current;
        }

        (count > 0).then_some(diffs / count as f32)
    }

    pub fn snapshot(&self, edge_id: u32) -> PeerQualitySnapshot {
        let rtt_samples_ms = self.rtt_samples_ms();
        let (direct_voice_expected_packets, direct_voice_received_packets) =
            self.direct_voice_totals();
        PeerQualitySnapshot {
            edge_id,
            average_rtt_ms: self.average_rtt_ms(),
            packet_loss: self.packet_loss(),
            jitter_ms: self.jitter_ms(),
            rtt_samples_ms,
            sample_count: self.sample_count(),
            rtt_sample_count: self.rtt_sample_count(),
            probe_sample_count: self.probe_sample_count(),
            direct_voice_sample_count: self.direct_voice_sample_count(),
            direct_voice_expected_packets,
            direct_voice_received_packets,
            probes_sent: self.probe_sample_count() as u32 + self.pending_pings.len() as u32,
            pongs_received: self.probe_success_count() as u32,
            pending_ping_count: self.pending_pings.len(),
            next_seq: self.next_seq,
            last_probe_sent_ms: self.last_probe_sent_ms,
            last_pong_received_ms: self.last_pong_received_ms,
            last_report_ms: self.last_report_ms,
            last_report_average_rtt_ms: self.last_report_average_rtt_ms,
            last_report_packet_loss: self.last_report_packet_loss,
            last_report_jitter_ms: self.last_report_jitter_ms,
        }
    }
}

/// Public snapshot of the locally held peer quality state.
#[derive(Debug, Clone, PartialEq)]
pub struct PeerQualitySnapshot {
    pub edge_id: u32,
    pub average_rtt_ms: Option<f32>,
    pub packet_loss: Option<f32>,
    pub jitter_ms: Option<f32>,
    pub rtt_samples_ms: Vec<f32>,
    pub sample_count: usize,
    pub rtt_sample_count: usize,
    pub probe_sample_count: usize,
    pub direct_voice_sample_count: usize,
    pub direct_voice_expected_packets: u32,
    pub direct_voice_received_packets: u32,
    pub probes_sent: u32,
    pub pongs_received: u32,
    pub pending_ping_count: usize,
    pub next_seq: u32,
    pub last_probe_sent_ms: Option<u64>,
    pub last_pong_received_ms: Option<u64>,
    pub last_report_ms: Option<u64>,
    pub last_report_average_rtt_ms: Option<f32>,
    pub last_report_packet_loss: Option<f32>,
    pub last_report_jitter_ms: Option<f32>,
}

const DEFAULT_PEER_QUALITY_SAMPLE_WINDOW_SIZE: u32 = 30;
const DEFAULT_PEER_QUALITY_PROBE_TIMEOUT_SECS: u32 = 3;

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
    RemoteUserJoined {
        session_id: u32,
        username: String,
        channel_id: u32,
        is_ninja: bool,
    },
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
    RemoteUserMoved {
        session_id: u32,
        from_channel_id: u32,
        channel_id: u32,
        actor_session: u32,
        suppress: Option<bool>,
    },
    /// A channel was created.
    ChannelCreated { channel_id: u32 },
    /// A channel was removed.
    ChannelRemoved { channel_id: u32 },
    /// A channel was updated. `links_add` / `links_remove` carry the link delta
    /// so that connected clients can be notified via ChannelState messages.
    ChannelUpdated {
        channel_id: u32,
        links_add: Vec<u32>,
        links_remove: Vec<u32>,
    },
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
    ShutdownRequested { reason: String },
    /// Hub ACL was updated for a channel; Edges should re-evaluate can_enter for all clients.
    /// `is_enter_restricted` is pre-computed by the Hub at ACL-save time and embedded in the
    /// notification so that Edges never need a separate RPC just for this channel-level flag.
    AclUpdated {
        channel_id: u32,
        is_enter_restricted: bool,
    },
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
pub enum HopTransport {
    Udp,
    Tcp,
}

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

/// Per-source dissemination view for the local Edge.
#[derive(Debug, Clone, Default)]
pub struct DisseminationSourceState {
    /// Steady-state downstream children for this source.
    pub active_children: Vec<u32>,
    /// Children whose primary branch should also emit duplicate traffic through
    /// one of the configured backups.
    pub duplicate_children: Vec<u32>,
    /// primary_child_edge_id -> backup next-hop edge IDs.
    pub branch_backups: HashMap<u32, Vec<u32>>,
}

/// Default packet width of the per-source rolling dedupe window.
pub const DEFAULT_DISSEMINATION_DEDUPE_WINDOW: u16 = 4096;

/// Fixed-size rolling dedupe window keyed by a wrapping 16-bit sequence space.
#[derive(Debug, Clone)]
pub struct RollingDedupeWindow {
    seq_hi: u16,
    bits: Box<[u64]>,
    window_size: u16,
    initialized: bool,
}

impl RollingDedupeWindow {
    pub fn new(window_size: u16) -> Self {
        let words = (window_size as usize).div_ceil(64);
        Self {
            seq_hi: 0,
            bits: vec![0u64; words.max(1)].into_boxed_slice(),
            window_size: window_size.max(64),
            initialized: false,
        }
    }

    #[inline]
    fn mark_seen(&mut self, offset: u16) {
        let idx = offset as usize;
        let word = idx / 64;
        let bit = idx % 64;
        if let Some(slot) = self.bits.get_mut(word) {
            *slot |= 1u64 << bit;
        }
    }

    #[inline]
    fn was_seen(&self, offset: u16) -> bool {
        let idx = offset as usize;
        let word = idx / 64;
        let bit = idx % 64;
        self.bits
            .get(word)
            .map(|slot| (slot & (1u64 << bit)) != 0)
            .unwrap_or(false)
    }

    fn shift_left(&mut self, shift: usize) {
        if shift == 0 {
            return;
        }
        if shift >= self.window_size as usize {
            for word in self.bits.iter_mut() {
                *word = 0;
            }
            return;
        }

        let word_shift = shift / 64;
        let bit_shift = shift % 64;
        let len = self.bits.len();

        if word_shift > 0 {
            for i in (0..len).rev() {
                self.bits[i] = if i >= word_shift {
                    self.bits[i - word_shift]
                } else {
                    0
                };
            }
        }

        if bit_shift > 0 {
            for i in (0..len).rev() {
                let upper = self.bits[i] << bit_shift;
                let carry = if i > 0 {
                    self.bits[i - 1] >> (64 - bit_shift)
                } else {
                    0
                };
                self.bits[i] = upper | carry;
            }
        }

        let total_bits = self.window_size as usize;
        let spare = len * 64 - total_bits;
        if spare > 0 {
            let keep_mask = u64::MAX >> spare;
            if let Some(last) = self.bits.last_mut() {
                *last &= keep_mask;
            }
        }
    }

    /// Returns true only for the first accepted packet in the window.
    pub fn accept(&mut self, seq: u16) -> bool {
        if !self.initialized {
            self.initialized = true;
            self.seq_hi = seq;
            self.mark_seen(0);
            return true;
        }

        let ahead = seq.wrapping_sub(self.seq_hi);
        if ahead != 0 && ahead < 0x8000 {
            self.shift_left(ahead as usize);
            self.seq_hi = seq;
            self.mark_seen(0);
            return true;
        }

        let behind = self.seq_hi.wrapping_sub(seq);
        if behind >= self.window_size {
            return false;
        }
        if self.was_seen(behind) {
            return false;
        }
        self.mark_seen(behind);
        true
    }
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
    /// Whether this Edge's local config allows Hub-mediated TCP relay as a last resort.
    pub enable_hub_tcp_fallback: bool,
    /// Whether Hub currently advertises that TCP relay is enabled.
    pub hub_tcp_relay_enabled: AtomicBool,
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
    /// Per-source source-rooted dissemination view pushed by Hub.
    /// Key = source_edge_id.
    pub dissemination_routes: ArcSwap<std::collections::HashMap<u32, DisseminationSourceState>>,
    /// Hub-pushed dissemination route epoch.
    pub dissemination_route_epoch: AtomicU64,
    /// Edge-global transport sequence allocator used by local source packets.
    pub transport_packet_seq: AtomicU32,
    /// Per-source rolling dedupe windows for source-rooted dissemination.
    pub dissemination_dedupe: std::sync::Mutex<HashMap<u32, RollingDedupeWindow>>,
    /// Outbound TCP voice connection pools to peer Edges.
    /// Maps peer_edge_id → connection pool (N independent WebSocket connections).
    /// Populated on peerJoined; lock-free reads via ArcSwap.
    pub voice_tcp_conns: ArcSwap<HashMap<u32, Arc<PeerVoiceTcpPool>>>,
    /// Current inbound `/voice` WebSocket connections keyed by peer edge ID.
    /// Tracks how many peer-to-peer voice streams this Edge is actively accepting
    /// from each remote Edge.
    pub incoming_voice_tcp_connections: std::sync::RwLock<HashMap<u32, usize>>,
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
    /// Cross-process fault injection loaded from environment variables at Edge startup.
    pub test_network_faults: TestNetworkFaults,
    /// Locally held UDP probe quality state keyed by peer edge ID.
    /// Shared between `udp.rs`, `cluster_voice.rs`, and the Web API for local observability.
    pub peer_quality: Arc<Mutex<HashMap<u32, PeerQualityState>>>,
    /// Rolling observation window size for peer-quality samples.
    pub peer_quality_sample_window_size: AtomicU32,
    /// Probe timeout used when converting unanswered pings into loss samples.
    pub peer_quality_probe_timeout_secs: AtomicU32,
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
    /// Shared client-facing UDP socket used for local voice delivery.
    ///
    /// Populated by `UdpServer::new` once the client UDP socket has been bound,
    /// so hot paths outside `udp.rs` can still honor the same UDP-first send
    /// semantics when forwarding voice to local clients.
    pub client_udp_socket: ArcSwap<Option<Arc<UdpSocket>>>,
    /// Shared edge-to-edge UDP socket used for source-rooted dissemination.
    pub edge_udp_socket: ArcSwap<Option<Arc<UdpSocket>>>,
}

impl EdgeState {
    pub fn new(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        enable_hub_tcp_fallback: bool,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(4096);
        let test_network_faults = TestNetworkFaults::from_env();
        Arc::new(Self {
            edge_id: AtomicU32::new(0),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: RwLock::new(HashMap::new()),
            peer_registry: ArcSwap::new(Arc::new(PeerRegistry::default())),
            enable_hub_tcp_fallback,
            hub_tcp_relay_enabled: AtomicBool::new(true),
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
            dissemination_routes: ArcSwap::new(Arc::new(std::collections::HashMap::new())),
            dissemination_route_epoch: AtomicU64::new(0),
            transport_packet_seq: AtomicU32::new(0),
            dissemination_dedupe: std::sync::Mutex::new(HashMap::new()),
            voice_tcp_conns: ArcSwap::new(Arc::new(HashMap::new())),
            incoming_voice_tcp_connections: std::sync::RwLock::new(HashMap::new()),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            peer_voice_tcp_pool_size: 2,
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            test_network_faults,
            peer_quality: Arc::new(Mutex::new(HashMap::new())),
            peer_quality_sample_window_size: AtomicU32::new(
                DEFAULT_PEER_QUALITY_SAMPLE_WINDOW_SIZE,
            ),
            peer_quality_probe_timeout_secs: AtomicU32::new(
                DEFAULT_PEER_QUALITY_PROBE_TIMEOUT_SECS,
            ),
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
            client_udp_socket: ArcSwap::new(Arc::new(None)),
            edge_udp_socket: ArcSwap::new(Arc::new(None)),
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
        let test_network_faults = TestNetworkFaults::from_env();
        Arc::new(Self {
            edge_id: AtomicU32::new(0),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: RwLock::new(HashMap::new()),
            peer_registry: ArcSwap::new(Arc::new(PeerRegistry::default())),
            enable_hub_tcp_fallback,
            hub_tcp_relay_enabled: AtomicBool::new(true),
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
            dissemination_routes: ArcSwap::new(Arc::new(std::collections::HashMap::new())),
            dissemination_route_epoch: AtomicU64::new(0),
            transport_packet_seq: AtomicU32::new(0),
            dissemination_dedupe: std::sync::Mutex::new(HashMap::new()),
            voice_tcp_conns: ArcSwap::new(Arc::new(HashMap::new())),
            incoming_voice_tcp_connections: std::sync::RwLock::new(HashMap::new()),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            peer_voice_tcp_pool_size: 2,
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            test_network_faults,
            peer_quality: Arc::new(Mutex::new(HashMap::new())),
            peer_quality_sample_window_size: AtomicU32::new(
                DEFAULT_PEER_QUALITY_SAMPLE_WINDOW_SIZE,
            ),
            peer_quality_probe_timeout_secs: AtomicU32::new(
                DEFAULT_PEER_QUALITY_PROBE_TIMEOUT_SECS,
            ),
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
            client_udp_socket: ArcSwap::new(Arc::new(None)),
            edge_udp_socket: ArcSwap::new(Arc::new(None)),
        })
    }

    /// Create EdgeState with full configuration including ping and stats settings.
    pub fn new_with_full_config(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        config: EdgeStateConfig<'_>,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(4096);
        let edge_crypto = config
            .hmac_secret
            .and_then(EdgeCrypto::from_secret)
            .map(Arc::new);
        let test_network_faults = TestNetworkFaults::from_env();
        Arc::new(Self {
            edge_id: AtomicU32::new(0),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: RwLock::new(HashMap::new()),
            peer_registry: ArcSwap::new(Arc::new(PeerRegistry::default())),
            enable_hub_tcp_fallback: config.enable_hub_tcp_fallback,
            hub_tcp_relay_enabled: AtomicBool::new(true),
            consecutive_failure_threshold: config.consecutive_failure_threshold,
            next_hop_failures: std::sync::RwLock::new(HashMap::new()),
            max_ttl: std::sync::atomic::AtomicU32::new(DEFAULT_MAX_TTL),
            listeners_per_user: AtomicU32::new(config.listeners_per_user),
            listeners_per_channel: AtomicU32::new(config.listeners_per_channel),
            allow_ping: AtomicBool::new(config.allow_ping),
            rolling_stats_window: AtomicU32::new(config.rolling_stats_window),
            ninja_channels: RwLock::new(vec![]),
            ninja_visible_to: RwLock::new(HashMap::new()),
            route_table: ArcSwap::new(Arc::new(std::collections::HashMap::new())),
            dissemination_routes: ArcSwap::new(Arc::new(std::collections::HashMap::new())),
            dissemination_route_epoch: AtomicU64::new(0),
            transport_packet_seq: AtomicU32::new(0),
            dissemination_dedupe: std::sync::Mutex::new(HashMap::new()),
            voice_tcp_conns: ArcSwap::new(Arc::new(HashMap::new())),
            incoming_voice_tcp_connections: std::sync::RwLock::new(HashMap::new()),
            voice_tcp_peers: RwLock::new(HashSet::new()),
            peer_voice_tcp_pool_size: config.peer_voice_tcp_pool_size.max(1),
            hub_limits: RwLock::new(None),
            max_bandwidth_bps: AtomicU32::new(0),
            max_users: AtomicU32::new(0),
            test_udp_drop_rate: AtomicU32::new(0),
            test_network_faults,
            peer_quality: Arc::new(Mutex::new(HashMap::new())),
            peer_quality_sample_window_size: AtomicU32::new(
                config.peer_quality_sample_window_size.max(1) as u32,
            ),
            peer_quality_probe_timeout_secs: AtomicU32::new(
                config.peer_quality_probe_timeout_secs.max(1) as u32,
            ),
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
            client_udp_socket: ArcSwap::new(Arc::new(None)),
            edge_udp_socket: ArcSwap::new(Arc::new(None)),
        })
    }

    /// Apply hot-reloadable config fields from a freshly loaded EdgeConfig.
    ///
    /// Fields that require a full restart (ports, TLS, Hub address) are ignored.
    /// Fields that can be applied immediately are updated atomically.
    pub fn apply_hot_config(&self, config: &munode_common::config::EdgeConfig) {
        self.allow_ping
            .store(config.server.allow_ping, Ordering::Relaxed);
        self.rolling_stats_window
            .store(config.server.rolling_stats_window, Ordering::Relaxed);
        self.peer_quality_sample_window_size.store(
            config.voice_routing.quality.sample_window_size.max(1) as u32,
            Ordering::Relaxed,
        );
        self.peer_quality_probe_timeout_secs.store(
            config.voice_routing.quality.probe_timeout_secs.max(1) as u32,
            Ordering::Relaxed,
        );
    }

    #[inline]
    pub fn hub_tcp_relay_allowed(&self) -> bool {
        self.enable_hub_tcp_fallback && self.hub_tcp_relay_enabled.load(Ordering::Relaxed)
    }

    #[inline]
    pub fn set_hub_tcp_relay_enabled(&self, enabled: bool) {
        self.hub_tcp_relay_enabled.store(enabled, Ordering::Relaxed);
    }

    #[inline]
    pub fn peer_quality_sample_window_size(&self) -> usize {
        self.peer_quality_sample_window_size
            .load(Ordering::Relaxed)
            .max(1) as usize
    }

    #[inline]
    pub fn peer_quality_probe_timeout_ms(&self) -> u64 {
        u64::from(
            self.peer_quality_probe_timeout_secs
                .load(Ordering::Relaxed)
                .max(1),
        ) * 1000
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

    /// Publish the client-facing UDP socket for shared local voice delivery.
    pub fn set_client_udp_socket(&self, socket: Arc<UdpSocket>) {
        self.client_udp_socket.store(Arc::new(Some(socket)));
    }

    /// Publish the edge-to-edge UDP socket for source-rooted dissemination.
    pub fn set_edge_udp_socket(&self, socket: Arc<UdpSocket>) {
        self.edge_udp_socket.store(Arc::new(Some(socket)));
    }

    /// Allocate the next edge-global transport sequence number.
    #[inline]
    pub fn next_transport_packet_seq(&self) -> u16 {
        self.transport_packet_seq.fetch_add(1, Ordering::Relaxed) as u16
    }

    /// Apply rolling duplicate suppression for one `(source_edge_id, seq)` pair.
    pub fn accept_disseminated_packet(&self, source_edge_id: u32, seq: u16) -> bool {
        match self.dissemination_dedupe.lock() {
            Ok(mut windows) => windows
                .entry(source_edge_id)
                .or_insert_with(|| RollingDedupeWindow::new(DEFAULT_DISSEMINATION_DEDUPE_WINDOW))
                .accept(seq),
            Err(_) => true,
        }
    }

    pub async fn observe_direct_peer_voice_packet(&self, ingress_peer: u32, seq: u16) {
        if ingress_peer == 0 {
            return;
        }

        let sample_window_size = self.peer_quality_sample_window_size();
        let mut quality = self.peer_quality.lock().await;
        let entry = quality.entry(ingress_peer).or_default();
        entry.record_direct_voice_packet(seq, sample_window_size);
    }

    pub fn note_incoming_voice_tcp_connected(&self, peer_edge_id: u32) {
        if peer_edge_id == 0 {
            return;
        }

        if let Ok(mut counts) = self.incoming_voice_tcp_connections.write() {
            *counts.entry(peer_edge_id).or_insert(0) += 1;
        }
    }

    pub fn note_incoming_voice_tcp_disconnected(&self, peer_edge_id: u32) {
        if peer_edge_id == 0 {
            return;
        }

        if let Ok(mut counts) = self.incoming_voice_tcp_connections.write() {
            let Some(count) = counts.get_mut(&peer_edge_id) else {
                return;
            };

            if *count > 1 {
                *count -= 1;
            } else {
                counts.remove(&peer_edge_id);
            }
        }
    }

    pub fn incoming_voice_tcp_connection_counts(&self) -> HashMap<u32, usize> {
        self.incoming_voice_tcp_connections
            .read()
            .map(|counts| counts.clone())
            .unwrap_or_default()
    }

    /// Snapshot the locally held UDP probe quality state for Web API consumers.
    pub async fn peer_quality_snapshots(&self) -> Vec<PeerQualitySnapshot> {
        let mut quality = self.peer_quality.lock().await;
        let mut snapshots: Vec<_> = quality
            .iter_mut()
            .map(|(&edge_id, state)| state.snapshot(edge_id))
            .collect();
        snapshots.sort_by_key(|snapshot| snapshot.edge_id);
        snapshots
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
        self.whisper_route_cache
            .write()
            .unwrap()
            .remove(&sender_session);
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
        crate::voice_target::recompute_all_session_voice_targets(self).await;
    }

    /// Recompute only the VoiceTarget entries whose `links=true` roots may be affected
    /// by a channel link change.
    pub async fn recompute_vt_channels_for_link_change(
        &self,
        channel_id: u32,
        old_links: &[u32],
        new_links: &[u32],
    ) {
        crate::voice_target::recompute_link_affected_voice_targets(
            self, channel_id, old_links, new_links,
        )
        .await;
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
            let offset = self
                .session_counter
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                % POOL_SIZE;
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
    use super::{EdgeState, PeerQualityState, RollingDedupeWindow};
    use crate::channel_manager::{ChannelData, ChannelManager};
    use crate::client::ClientManager;
    use crate::hot_slot::get_hot_slot;
    use crate::voice_target::{
        VoiceTargetChannelConfig, VoiceTargetConfig, WhisperRouteCacheEntry, build_hot_vt_map,
    };
    use smallvec::smallvec;
    use std::collections::HashMap;
    use std::sync::Arc;

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
        assert!(state.get_cached_whisper_route(10_001, 2, 7).is_none());
    }

    #[test]
    fn hub_tcp_relay_allowed_combines_local_and_hub_state() {
        let local_enabled = EdgeState::new(ChannelManager::new(), ClientManager::new(), true);
        assert!(local_enabled.hub_tcp_relay_allowed());
        local_enabled.set_hub_tcp_relay_enabled(false);
        assert!(!local_enabled.hub_tcp_relay_allowed());

        let local_disabled = EdgeState::new(ChannelManager::new(), ClientManager::new(), false);
        local_disabled.set_hub_tcp_relay_enabled(true);
        assert!(!local_disabled.hub_tcp_relay_allowed());
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

    #[test]
    fn rolling_dedupe_window_accepts_new_packets_and_rejects_duplicates() {
        let mut window = RollingDedupeWindow::new(64);

        assert!(window.accept(10));
        assert!(!window.accept(10));
        assert!(window.accept(11));
        assert!(window.accept(9));
        assert!(!window.accept(9));

        assert!(window.accept(u16::MAX));
        assert!(window.accept(0));
        assert!(!window.accept(0));
    }

    #[test]
    fn peer_quality_state_combines_probe_rtt_and_loss_in_one_window() {
        let mut quality = PeerQualityState::default();

        quality.pending_pings.insert(1, 100);
        assert!(quality.record_probe_success(1, 150, 32));

        quality.pending_pings.insert(2, 200);
        quality.expire_stale_pings(260, 40, 32);

        assert_eq!(quality.sample_count(), 2);
        assert_eq!(quality.rtt_sample_count(), 1);
        assert_eq!(quality.probe_sample_count(), 2);
        assert_eq!(quality.probe_success_count(), 1);
        assert_eq!(quality.average_rtt_ms(), Some(50.0));
        assert_eq!(quality.packet_loss(), Some(0.5));
    }

    #[test]
    fn peer_quality_state_uses_direct_voice_gaps_as_loss_signal() {
        let mut quality = PeerQualityState::default();

        quality.record_direct_voice_packet(10, 32);
        quality.record_direct_voice_packet(11, 32);
        quality.record_direct_voice_packet(14, 32);

        let (expected_packets, received_packets) = quality.direct_voice_totals();
        assert_eq!(expected_packets, 5);
        assert_eq!(received_packets, 3);
        assert_eq!(quality.direct_voice_sample_count(), 3);
        let loss = quality
            .packet_loss()
            .expect("direct voice loss should be computed");
        assert!((loss - 0.4).abs() < 0.0001);
    }

    #[test]
    fn peer_quality_state_keeps_probe_rtt_under_direct_voice_load() {
        let mut quality = PeerQualityState::default();

        quality.pending_pings.insert(1, 100);
        assert!(quality.record_probe_success(1, 150, 30));

        for seq in 200..240 {
            quality.record_direct_voice_packet(seq, 30);
        }

        assert_eq!(quality.rtt_sample_count(), 1);
        assert_eq!(quality.average_rtt_ms(), Some(50.0));
        assert!(quality.direct_voice_sample_count() >= 30);
    }

    #[tokio::test]
    async fn recompute_vt_channels_for_link_change_rebuilds_only_touched_sessions() {
        let channel_manager = ChannelManager::new();
        let state = EdgeState::new(channel_manager.clone(), ClientManager::new(), false);
        let affected_session = 81_002;
        let untouched_session = 81_010;

        for channel in [
            ChannelData {
                id: 1,
                name: "one".into(),
                parent_id: None,
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![2],
            },
            ChannelData {
                id: 2,
                name: "two".into(),
                parent_id: None,
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![1],
            },
            ChannelData {
                id: 10,
                name: "ten".into(),
                parent_id: None,
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![],
            },
        ] {
            channel_manager.upsert_channel(channel).await;
        }

        {
            let mut cache = state.voice_targets.write().await;
            cache.insert(
                affected_session,
                HashMap::from([(
                    1,
                    VoiceTargetConfig {
                        sessions: vec![],
                        channels: vec![VoiceTargetChannelConfig {
                            channel_id: 2,
                            links: true,
                            children: false,
                            group: None,
                        }],
                        resolved_channels: HashMap::from([(1, None), (2, None)]),
                    },
                )]),
            );
            cache.insert(
                untouched_session,
                HashMap::from([(
                    1,
                    VoiceTargetConfig {
                        sessions: vec![],
                        channels: vec![VoiceTargetChannelConfig {
                            channel_id: 10,
                            links: true,
                            children: false,
                            group: None,
                        }],
                        resolved_channels: HashMap::from([(10, None)]),
                    },
                )]),
            );
        }

        for session_id in [affected_session, untouched_session] {
            let hot_map = {
                let cache = state.voice_targets.read().await;
                build_hot_vt_map(cache.get(&session_id).expect("session vt cache missing"))
            };
            get_hot_slot(session_id)
                .voice_targets
                .store(Arc::new(Some(Arc::new(hot_map))));
        }

        let affected_before = {
            let guard = get_hot_slot(affected_session).voice_targets.load();
            (**guard)
                .as_ref()
                .expect("affected hot map missing")
                .clone()
        };
        let untouched_before = {
            let guard = get_hot_slot(untouched_session).voice_targets.load();
            (**guard)
                .as_ref()
                .expect("untouched hot map missing")
                .clone()
        };

        channel_manager
            .upsert_channel(ChannelData {
                id: 1,
                name: "one".into(),
                parent_id: None,
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![],
            })
            .await;
        channel_manager
            .upsert_channel(ChannelData {
                id: 2,
                name: "two".into(),
                parent_id: None,
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![],
            })
            .await;

        state
            .recompute_vt_channels_for_link_change(1, &[2], &[])
            .await;

        let affected_after = {
            let guard = get_hot_slot(affected_session).voice_targets.load();
            (**guard)
                .as_ref()
                .expect("affected hot map missing after recompute")
                .clone()
        };
        let untouched_after = {
            let guard = get_hot_slot(untouched_session).voice_targets.load();
            (**guard)
                .as_ref()
                .expect("untouched hot map missing after recompute")
                .clone()
        };

        let cache = state.voice_targets.read().await;
        let affected_resolved = &cache[&affected_session][&1].resolved_channels;
        let untouched_resolved = &cache[&untouched_session][&1].resolved_channels;
        assert_eq!(affected_resolved.len(), 1);
        assert!(affected_resolved.contains_key(&2));
        assert_eq!(untouched_resolved.len(), 1);
        assert!(untouched_resolved.contains_key(&10));
        assert!(!Arc::ptr_eq(&affected_before, &affected_after));
        assert!(Arc::ptr_eq(&untouched_before, &untouched_after));

        get_hot_slot(affected_session)
            .voice_targets
            .store(Arc::new(None));
        get_hot_slot(untouched_session)
            .voice_targets
            .store(Arc::new(None));
    }

    #[tokio::test]
    async fn recompute_all_vt_channels_refreshes_children_targets_after_channel_creation() {
        let channel_manager = ChannelManager::new();
        let state = EdgeState::new(channel_manager.clone(), ClientManager::new(), false);
        let session_id = 82_001;

        for channel in [
            ChannelData {
                id: 0,
                name: "root".into(),
                parent_id: None,
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![],
            },
            ChannelData {
                id: 1,
                name: "parent".into(),
                parent_id: Some(0),
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![],
            },
            ChannelData {
                id: 2,
                name: "child-a".into(),
                parent_id: Some(1),
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![],
            },
        ] {
            channel_manager.upsert_channel(channel).await;
        }

        {
            let mut cache = state.voice_targets.write().await;
            cache.insert(
                session_id,
                HashMap::from([(
                    1,
                    VoiceTargetConfig {
                        sessions: vec![],
                        channels: vec![VoiceTargetChannelConfig {
                            channel_id: 1,
                            links: false,
                            children: true,
                            group: None,
                        }],
                        resolved_channels: HashMap::from([(1, None), (2, None)]),
                    },
                )]),
            );
        }

        let initial_hot_map = {
            let cache = state.voice_targets.read().await;
            build_hot_vt_map(cache.get(&session_id).expect("session vt cache missing"))
        };
        get_hot_slot(session_id)
            .voice_targets
            .store(Arc::new(Some(Arc::new(initial_hot_map))));

        channel_manager
            .upsert_channel(ChannelData {
                id: 3,
                name: "child-b".into(),
                parent_id: Some(1),
                description: None,
                position: 0,
                max_users: 0,
                temporary: false,
                inherit_acl: true,
                links: vec![],
            })
            .await;

        state.recompute_all_vt_channels().await;

        let cache = state.voice_targets.read().await;
        let resolved = &cache[&session_id][&1].resolved_channels;
        assert_eq!(resolved.len(), 3);
        assert!(resolved.contains_key(&1));
        assert!(resolved.contains_key(&2));
        assert!(resolved.contains_key(&3));
        drop(cache);

        let hot_guard = get_hot_slot(session_id).voice_targets.load();
        let hot_map = (**hot_guard)
            .as_ref()
            .expect("hot voice target map missing after recompute");
        let hot_target = hot_map
            .get(&1)
            .expect("hot voice target missing after recompute");
        assert_eq!(hot_target.resolved_channels.len(), 3);
        assert!(hot_target.resolved_channels.contains_key(&1));
        assert!(hot_target.resolved_channels.contains_key(&2));
        assert!(hot_target.resolved_channels.contains_key(&3));

        get_hot_slot(session_id).voice_targets.store(Arc::new(None));
    }
}
