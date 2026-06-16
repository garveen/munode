//! Edge Web API — HTTP REST endpoints for observing the local Edge runtime.
//!
//! Endpoints:
//!   GET /api/endpoints            — List Edge Web API endpoints
//!   GET /api/status               — Local Edge runtime status and identity
//!   GET /api/stats                — Local client/channel/route statistics
//!   GET /api/sessions             — Unified local + remote session view
//!   GET /api/peers                — Known peer Edges with route and quality summary
//!   GET /api/connections          — Current inter-Edge connection snapshot
//!   GET /api/topology             — Local topology graph with inline quality summary
//!   GET /api/topology/matrix      — Matrix view of the local topology graph
//!   GET /api/dissemination        — Local source-rooted dissemination view
//!   GET /api/voice_targets        — Local cached voice-target configs and route cache
//!   GET /api/voice_targets/session/:id — Voice targets for one speaking session
//!   GET /api/diagnostics/peer-quality — Raw local UDP probe quality snapshots
//!   GET /api/health               — Liveness probe (always 200 OK)

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, atomic::Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode, header},
    middleware::{self, Next},
    response::{Json, Response},
    routing::get,
};
use munode_common::config::EdgeConfig;
use serde::Serialize;
use tracing::{info, warn};

use crate::peer_registry::{PeerEdgeInfo, PeerVoiceTcpPool};
use crate::state::{
    DisseminationSourceState, EdgeState, HopTransport, PeerQualitySnapshot, RouteCandidate,
    RouteDecision,
};
use crate::voice_target::{SessionWhisperRouteCache, VoiceTargetChannelConfig, VoiceTargetConfig};

type AppState = Arc<WebApiContext>;

#[derive(Clone)]
pub struct WebApiMetadata {
    pub configured_server_id: u32,
    pub name: String,
    pub external_host: String,
    pub client_port: u16,
    pub edge_port: u16,
    pub region: Option<String>,
    pub capacity: u32,
    pub web_api_host: String,
    pub web_api_port: u16,
    pub voice_routing_enabled: bool,
}

impl WebApiMetadata {
    pub fn from_config(config: &EdgeConfig) -> Self {
        Self {
            configured_server_id: config.server_id,
            name: config.name.clone(),
            external_host: config.network.external_host.clone(),
            client_port: config.network.external_port.unwrap_or(config.network.port),
            edge_port: config
                .network
                .edge_port
                .unwrap_or_else(|| config.network.port.saturating_add(1)),
            region: config.network.region.clone(),
            capacity: config.server.capacity,
            web_api_host: config.web_api.host.clone(),
            web_api_port: config.web_api.port,
            voice_routing_enabled: config.voice_routing.enabled,
        }
    }
}

struct WebApiContext {
    edge_state: Arc<EdgeState>,
    metadata: WebApiMetadata,
    api_token_required: bool,
    started_at: Instant,
}

impl WebApiContext {
    fn source_edge_id(&self) -> u32 {
        let registered = self.edge_state.get_edge_id();
        if registered != 0 {
            registered
        } else {
            self.metadata.configured_server_id
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionScope {
    Local,
    Remote,
}

#[derive(Serialize)]
pub struct SessionEntry {
    pub session: u32,
    pub edge_id: u32,
    pub scope: SessionScope,
    pub user_id: u32,
    pub username: String,
    pub channel_id: u32,
    pub mute: bool,
    pub deaf: bool,
    pub suppress: bool,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub priority_speaker: bool,
    pub recording: bool,
    pub listening_channels: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opus_supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_release: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_transport: Option<LocalSessionTransportSummary>,
}

#[derive(Serialize)]
pub struct SessionListResponse {
    pub source_edge_id: u32,
    pub total: usize,
    pub local_count: usize,
    pub remote_count: usize,
    pub sessions: Vec<SessionEntry>,
    pub timestamp: u64,
}

#[derive(Serialize)]
pub struct LocalSessionTransportSummary {
    pub has_udp_addr: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udp_addr: Option<String>,
    pub has_crypt_state: bool,
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

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeLinkType {
    Direct,
    Relay,
    Unknown,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeRouteKind {
    DirectUdp,
    DirectTcp,
    RelayChain,
    HubTcp,
    Unknown,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeHopTransportEntry {
    Udp,
    Tcp,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityState {
    Reachable,
    Unknown,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct EdgeRelayHopEntry {
    pub edge_id: u32,
    pub transport: EdgeHopTransportEntry,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EdgeRouteCandidateEntry {
    pub route: EdgeRouteKind,
    pub link_type: EdgeLinkType,
    pub cost: f32,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub relay_hops: Vec<EdgeRelayHopEntry>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct KnownEdgeEntry {
    pub edge_id: u32,
    pub has_direct_peer_metadata: bool,
    pub known_via_route_table: bool,
    pub remote_session_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udp_addr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_port: Option<u16>,
    pub preferred_link_type: EdgeLinkType,
    pub preferred_route: EdgeRouteKind,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub preferred_relay_hops: Vec<EdgeRelayHopEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub route_candidates: Vec<EdgeRouteCandidateEntry>,
}

#[derive(Serialize)]
pub struct SelfEdgeInfo {
    pub configured_server_id: u32,
    pub edge_id: u32,
    pub is_registered: bool,
    pub name: String,
    pub external_host: String,
    pub client_port: u16,
    pub edge_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub capacity: u32,
    pub local_client_count: usize,
    pub channel_count: usize,
    pub accepting_connections: bool,
    pub web_api_host: String,
    pub web_api_port: u16,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub uptime_secs: u64,
    pub edge: SelfEdgeInfo,
    pub remote_client_count: usize,
    pub known_edge_count: usize,
    pub voice_routing_enabled: bool,
    pub topology_version: u64,
    pub timestamp: u64,
}

#[derive(Serialize)]
pub struct ClientStatsSummary {
    pub local: usize,
    pub remote: usize,
    pub total: usize,
}

#[derive(Serialize)]
pub struct RouteStatsSummary {
    pub known_edges: usize,
    pub direct_edges: usize,
    pub relay_edges: usize,
    pub hub_fallback_edges: usize,
    pub unknown_edges: usize,
    pub route_candidate_count: usize,
}

#[derive(Serialize)]
pub struct LimitStatsSummary {
    pub max_users: u32,
    pub max_bandwidth_bps: u32,
    pub listeners_per_user: u32,
    pub listeners_per_channel: u32,
    pub allow_ping: bool,
}

#[derive(Serialize)]
pub struct StatsResponse {
    pub clients: ClientStatsSummary,
    pub channel_count: usize,
    pub routes: RouteStatsSummary,
    pub limits: LimitStatsSummary,
    pub voice_routing_enabled: bool,
    pub accepting_connections: bool,
    pub topology_version: u64,
    pub timestamp: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PeerDiscoverySummary {
    pub has_direct_peer_metadata: bool,
    pub known_via_route_table: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PeerRouteSummary {
    pub kind: EdgeRouteKind,
    pub link_type: EdgeLinkType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub relay_hops: Vec<EdgeRelayHopEntry>,
    pub candidate_count: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PeerQualitySummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_rtt_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_loss: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jitter_ms: Option<f32>,
    pub sample_count: usize,
    pub rtt_sample_count: usize,
    pub probe_sample_count: usize,
    pub direct_voice_sample_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_probe_sent_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_pong_received_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report_average_rtt_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report_packet_loss: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report_jitter_ms: Option<f32>,
}

#[derive(Serialize)]
pub struct PeerEntry {
    pub edge_id: u32,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udp_addr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_port: Option<u16>,
    pub remote_session_count: usize,
    pub discovery: PeerDiscoverySummary,
    pub route: PeerRouteSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<PeerQualitySummary>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub route_candidates: Vec<EdgeRouteCandidateEntry>,
}

#[derive(Serialize)]
pub struct PeerListResponse {
    pub source_edge_id: u32,
    pub total: usize,
    pub peers: Vec<PeerEntry>,
    pub timestamp: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct VoiceTcpSlotEntry {
    pub slot: usize,
    pub connected: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct VoiceTcpConnectionSummary {
    pub outbound_pool_present: bool,
    pub configured_outbound_slots: usize,
    pub live_outbound_slots: usize,
    pub has_outbound_connection: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all_outbound_disconnected_since_ms: Option<u64>,
    pub outbound_disconnect_reported: bool,
    pub inbound_connection_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub outbound_slots: Vec<VoiceTcpSlotEntry>,
}

#[derive(Serialize)]
pub struct ConnectionEntry {
    pub edge_id: u32,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udp_addr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_port: Option<u16>,
    pub remote_session_count: usize,
    pub discovery: PeerDiscoverySummary,
    pub route: PeerRouteSummary,
    pub voice_tcp: VoiceTcpConnectionSummary,
}

#[derive(Serialize)]
pub struct ConnectionListResponse {
    pub source_edge_id: u32,
    pub total: usize,
    pub connections: Vec<ConnectionEntry>,
    pub timestamp: u64,
}

#[derive(Serialize)]
pub struct TopologyNode {
    pub edge_id: u32,
    pub label: String,
    pub is_self: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub session_count: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TopologyLinkEntry {
    pub source_edge_id: u32,
    pub target_edge_id: u32,
    pub state: ConnectivityState,
    pub route: PeerRouteSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<PeerQualitySummary>,
}

#[derive(Serialize)]
pub struct TopologyStats {
    pub node_count: usize,
    pub peer_count: usize,
    pub link_count: usize,
    pub direct_links: usize,
    pub relay_links: usize,
    pub hub_fallback_links: usize,
    pub unknown_links: usize,
    pub quality_observed_links: usize,
    pub route_candidate_count: usize,
}

#[derive(Serialize)]
pub struct TopologyResponse {
    pub source_edge_id: u32,
    pub nodes: Vec<TopologyNode>,
    pub links: Vec<TopologyLinkEntry>,
    pub stats: TopologyStats,
    pub timestamp: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TopologyMatrixCell {
    pub source_edge_id: u32,
    pub target_edge_id: u32,
    pub observed: bool,
    pub state: ConnectivityState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<PeerRouteSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<PeerQualitySummary>,
}

#[derive(Serialize)]
pub struct TopologyMatrixResponse {
    pub source_edge_id: u32,
    pub nodes: Vec<TopologyNode>,
    pub cells: Vec<TopologyMatrixCell>,
    pub timestamp: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DisseminationBranchBackupEntry {
    pub primary_child_edge_id: u32,
    pub backup_next_hops: Vec<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DisseminationSourceEntry {
    pub source_edge_id: u32,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub active_children: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub duplicate_children: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub branch_backups: Vec<DisseminationBranchBackupEntry>,
}

#[derive(Serialize)]
pub struct DisseminationResponse {
    pub edge_id: u32,
    pub route_epoch: u64,
    pub total_sources: usize,
    pub sources: Vec<DisseminationSourceEntry>,
    pub timestamp: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct VoiceTargetChannelEntry {
    pub channel_id: u32,
    pub children: bool,
    pub links: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct VoiceTargetResolvedChannelEntry {
    pub channel_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<String>>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct VoiceTargetConfigEntry {
    pub sessions: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub channels: Vec<VoiceTargetChannelEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub resolved_channels: Vec<VoiceTargetResolvedChannelEntry>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct VoiceTargetRouteCacheEntry {
    pub topology_version: u64,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub direct_sessions: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub channel_sessions: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub relay_edge_ids: Vec<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct VoiceTargetEntry {
    pub client_session: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<u32>,
    pub target_id: u32,
    pub config: VoiceTargetConfigEntry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_route: Option<VoiceTargetRouteCacheEntry>,
}

#[derive(Serialize)]
pub struct VoiceTargetListResponse {
    pub source_edge_id: u32,
    pub total: usize,
    pub voice_targets: Vec<VoiceTargetEntry>,
    pub timestamp: u64,
}

#[derive(Serialize)]
pub struct PeerQualityDiagnosticsEntry {
    pub edge_id: u32,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub has_direct_peer_metadata: bool,
    pub known_via_route_table: bool,
    pub preferred_link_type: EdgeLinkType,
    pub preferred_route: EdgeRouteKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_rtt_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_loss: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_probe_sent_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_pong_received_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report_average_rtt_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report_packet_loss: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report_jitter_ms: Option<f32>,
}

#[derive(Serialize)]
pub struct PeerQualityDiagnosticsResponse {
    pub source_edge_id: u32,
    pub total: usize,
    pub entries: Vec<PeerQualityDiagnosticsEntry>,
    pub timestamp: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApiAccessKind {
    Public,
    RequiresBearerToken,
}

impl ApiAccessKind {
    fn describe(self, api_token_required: bool) -> &'static str {
        match self {
            Self::Public => "public",
            Self::RequiresBearerToken => {
                if api_token_required {
                    "bearer_token"
                } else {
                    "public"
                }
            }
        }
    }
}

macro_rules! for_each_edge_data_route {
    ($apply:ident, $target:ident) => {{
        $apply!(
            $target,
            "GET",
            "/api/endpoints",
            "List Edge Web API endpoints",
            ApiAccessKind::RequiresBearerToken,
            get(handle_endpoints)
        );
        $apply!(
            $target,
            "GET",
            "/api/status",
            "Local Edge runtime status and identity",
            ApiAccessKind::RequiresBearerToken,
            get(handle_status)
        );
        $apply!(
            $target,
            "GET",
            "/api/stats",
            "Local client, channel, and route statistics",
            ApiAccessKind::RequiresBearerToken,
            get(handle_stats)
        );
        $apply!(
            $target,
            "GET",
            "/api/sessions",
            "Unified local and remote session view",
            ApiAccessKind::RequiresBearerToken,
            get(handle_sessions)
        );
        $apply!(
            $target,
            "GET",
            "/api/peers",
            "Known peer Edges with route and quality summary",
            ApiAccessKind::RequiresBearerToken,
            get(handle_peers)
        );
        $apply!(
            $target,
            "GET",
            "/api/connections",
            "Current inter-Edge UDP and voice TCP connection snapshot",
            ApiAccessKind::RequiresBearerToken,
            get(handle_connections)
        );
        $apply!(
            $target,
            "GET",
            "/api/topology",
            "Local topology graph with inline quality summary",
            ApiAccessKind::RequiresBearerToken,
            get(handle_topology)
        );
        $apply!(
            $target,
            "GET",
            "/api/topology/matrix",
            "Matrix view of the local topology graph",
            ApiAccessKind::RequiresBearerToken,
            get(handle_topology_matrix)
        );
        $apply!(
            $target,
            "GET",
            "/api/dissemination",
            "Local source-rooted dissemination view",
            ApiAccessKind::RequiresBearerToken,
            get(handle_dissemination)
        );
        $apply!(
            $target,
            "GET",
            "/api/voice_targets",
            "Local cached voice-target configs and route cache",
            ApiAccessKind::RequiresBearerToken,
            get(handle_voice_targets)
        );
        $apply!(
            $target,
            "GET",
            "/api/voice_targets/session/:id",
            "Voice targets for one speaking session",
            ApiAccessKind::RequiresBearerToken,
            get(handle_voice_targets_by_session)
        );
        $apply!(
            $target,
            "GET",
            "/api/diagnostics/peer-quality",
            "Raw local UDP probe quality snapshots",
            ApiAccessKind::RequiresBearerToken,
            get(handle_peer_quality_diagnostics)
        );
    }};
}

macro_rules! for_each_edge_public_route {
    ($apply:ident, $target:ident) => {{
        $apply!(
            $target,
            "GET",
            "/api/health",
            "Liveness probe",
            ApiAccessKind::Public,
            get(handle_health)
        );
    }};
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApiEndpointInfo {
    pub method: &'static str,
    pub path: &'static str,
    pub summary: &'static str,
    pub access: &'static str,
}

#[derive(Serialize)]
pub struct ApiEndpointListResponse {
    pub service: &'static str,
    pub total: usize,
    pub endpoints: Vec<ApiEndpointInfo>,
    pub timestamp: u64,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub timestamp: u64,
}

struct EdgeOverview {
    source_edge_id: u32,
    local_client_count: usize,
    remote_client_count: usize,
    channel_count: usize,
    edges: Vec<KnownEdgeEntry>,
    quality: HashMap<u32, PeerQualitySnapshot>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn edge_api_endpoints(api_token_required: bool) -> Vec<ApiEndpointInfo> {
    let mut endpoints = Vec::new();

    macro_rules! push_endpoint {
        ($endpoints:ident, $method:literal, $path:literal, $summary:literal, $access:expr, $handler:expr) => {
            $endpoints.push(ApiEndpointInfo {
                method: $method,
                path: $path,
                summary: $summary,
                access: $access.describe(api_token_required),
            });
        };
    }

    for_each_edge_data_route!(push_endpoint, endpoints);
    for_each_edge_public_route!(push_endpoint, endpoints);
    endpoints
}

fn edge_route_kind(decision: &RouteDecision) -> EdgeRouteKind {
    match decision {
        RouteDecision::DirectUdp => EdgeRouteKind::DirectUdp,
        RouteDecision::DirectTcp => EdgeRouteKind::DirectTcp,
        RouteDecision::RelayChain { .. } => EdgeRouteKind::RelayChain,
        RouteDecision::HubTcp => EdgeRouteKind::HubTcp,
    }
}

fn edge_link_type(route: EdgeRouteKind) -> EdgeLinkType {
    match route {
        EdgeRouteKind::DirectUdp | EdgeRouteKind::DirectTcp => EdgeLinkType::Direct,
        EdgeRouteKind::RelayChain | EdgeRouteKind::HubTcp => EdgeLinkType::Relay,
        EdgeRouteKind::Unknown => EdgeLinkType::Unknown,
    }
}

fn connectivity_state(route: EdgeRouteKind) -> ConnectivityState {
    match route {
        EdgeRouteKind::Unknown => ConnectivityState::Unknown,
        _ => ConnectivityState::Reachable,
    }
}

fn edge_hop_transport(transport: HopTransport) -> EdgeHopTransportEntry {
    match transport {
        HopTransport::Udp => EdgeHopTransportEntry::Udp,
        HopTransport::Tcp => EdgeHopTransportEntry::Tcp,
    }
}

fn relay_hops(decision: &RouteDecision) -> Vec<EdgeRelayHopEntry> {
    match decision {
        RouteDecision::RelayChain { hops, transports } => hops
            .iter()
            .copied()
            .zip(transports.iter().cloned())
            .map(|(edge_id, transport)| EdgeRelayHopEntry {
                edge_id,
                transport: edge_hop_transport(transport),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn route_candidate_entry(candidate: &RouteCandidate) -> EdgeRouteCandidateEntry {
    let route = edge_route_kind(&candidate.decision);
    EdgeRouteCandidateEntry {
        route,
        link_type: edge_link_type(route),
        cost: candidate.cost,
        relay_hops: relay_hops(&candidate.decision),
    }
}

fn build_known_edge_entries(
    my_edge_id: u32,
    peer_snapshot: Vec<(u32, PeerEdgeInfo)>,
    route_table: &HashMap<u32, Vec<RouteCandidate>>,
    remote_edge_counts: &HashMap<u32, usize>,
) -> Vec<KnownEdgeEntry> {
    let peer_map: HashMap<u32, PeerEdgeInfo> = peer_snapshot.into_iter().collect();
    let mut edge_ids = BTreeSet::new();

    for &edge_id in peer_map.keys() {
        if edge_id != my_edge_id {
            edge_ids.insert(edge_id);
        }
    }
    for &edge_id in route_table.keys() {
        if edge_id != my_edge_id {
            edge_ids.insert(edge_id);
        }
    }
    for &edge_id in remote_edge_counts.keys() {
        if edge_id != 0 && edge_id != my_edge_id {
            edge_ids.insert(edge_id);
        }
    }

    edge_ids
        .into_iter()
        .map(|edge_id| {
            let peer_info = peer_map.get(&edge_id);
            let candidates = route_table.get(&edge_id);
            let route_candidates = candidates
                .map(|items| items.iter().map(route_candidate_entry).collect())
                .unwrap_or_default();

            let (preferred_route, preferred_relay_hops) =
                if let Some(candidate) = candidates.and_then(|items| items.first()) {
                    (
                        edge_route_kind(&candidate.decision),
                        relay_hops(&candidate.decision),
                    )
                } else if peer_info.is_some() {
                    (EdgeRouteKind::DirectUdp, Vec::new())
                } else {
                    (EdgeRouteKind::Unknown, Vec::new())
                };

            KnownEdgeEntry {
                edge_id,
                has_direct_peer_metadata: peer_info.is_some(),
                known_via_route_table: candidates.is_some(),
                remote_session_count: remote_edge_counts.get(&edge_id).copied().unwrap_or(0),
                host: peer_info.map(|info| info.host.clone()),
                udp_addr: peer_info.map(|info| info.udp_addr.to_string()),
                relay_port: peer_info.map(|info| info.relay_port.unwrap_or(info.udp_addr.port())),
                preferred_link_type: edge_link_type(preferred_route),
                preferred_route,
                preferred_relay_hops,
                route_candidates,
            }
        })
        .collect()
}

fn edge_label(edge: &KnownEdgeEntry) -> String {
    edge.host
        .clone()
        .unwrap_or_else(|| format!("Edge {}", edge.edge_id))
}

fn preferred_cost(edge: &KnownEdgeEntry) -> Option<f32> {
    edge.route_candidates
        .first()
        .map(|candidate| candidate.cost)
}

fn peer_route_summary(edge: &KnownEdgeEntry) -> PeerRouteSummary {
    PeerRouteSummary {
        kind: edge.preferred_route,
        link_type: edge.preferred_link_type,
        cost: preferred_cost(edge),
        relay_hops: edge.preferred_relay_hops.clone(),
        candidate_count: edge.route_candidates.len(),
    }
}

fn peer_quality_summary(snapshot: &PeerQualitySnapshot) -> PeerQualitySummary {
    PeerQualitySummary {
        average_rtt_ms: snapshot.average_rtt_ms,
        packet_loss: snapshot.packet_loss,
        jitter_ms: snapshot.jitter_ms,
        sample_count: snapshot.sample_count,
        rtt_sample_count: snapshot.rtt_sample_count,
        probe_sample_count: snapshot.probe_sample_count,
        direct_voice_sample_count: snapshot.direct_voice_sample_count,
        last_probe_sent_ms: snapshot.last_probe_sent_ms,
        last_pong_received_ms: snapshot.last_pong_received_ms,
        last_report_ms: snapshot.last_report_ms,
        last_report_average_rtt_ms: snapshot.last_report_average_rtt_ms,
        last_report_packet_loss: snapshot.last_report_packet_loss,
        last_report_jitter_ms: snapshot.last_report_jitter_ms,
    }
}

fn peer_entry(edge: &KnownEdgeEntry, quality: Option<&PeerQualitySnapshot>) -> PeerEntry {
    PeerEntry {
        edge_id: edge.edge_id,
        label: edge_label(edge),
        host: edge.host.clone(),
        udp_addr: edge.udp_addr.clone(),
        relay_port: edge.relay_port,
        remote_session_count: edge.remote_session_count,
        discovery: PeerDiscoverySummary {
            has_direct_peer_metadata: edge.has_direct_peer_metadata,
            known_via_route_table: edge.known_via_route_table,
        },
        route: peer_route_summary(edge),
        quality: quality.map(peer_quality_summary),
        route_candidates: edge.route_candidates.clone(),
    }
}

fn voice_tcp_connection_summary(
    pool: Option<&Arc<PeerVoiceTcpPool>>,
    inbound_connection_count: usize,
) -> VoiceTcpConnectionSummary {
    match pool {
        Some(pool) => {
            let snapshot = pool.snapshot();
            VoiceTcpConnectionSummary {
                outbound_pool_present: true,
                configured_outbound_slots: snapshot.configured_slots,
                live_outbound_slots: snapshot.live_slots,
                has_outbound_connection: snapshot.has_live_connection,
                all_outbound_disconnected_since_ms: snapshot.all_disconnected_since_ms,
                outbound_disconnect_reported: snapshot.disconnect_reported,
                inbound_connection_count,
                outbound_slots: snapshot
                    .slot_states
                    .into_iter()
                    .enumerate()
                    .map(|(slot, connected)| VoiceTcpSlotEntry { slot, connected })
                    .collect(),
            }
        }
        None => VoiceTcpConnectionSummary {
            outbound_pool_present: false,
            configured_outbound_slots: 0,
            live_outbound_slots: 0,
            has_outbound_connection: false,
            all_outbound_disconnected_since_ms: None,
            outbound_disconnect_reported: false,
            inbound_connection_count,
            outbound_slots: Vec::new(),
        },
    }
}

fn connection_entry(
    edge_id: u32,
    edge: Option<&KnownEdgeEntry>,
    pool: Option<&Arc<PeerVoiceTcpPool>>,
    inbound_connection_count: usize,
) -> ConnectionEntry {
    let label = edge
        .map(edge_label)
        .unwrap_or_else(|| format!("Edge {}", edge_id));
    let discovery = edge.map_or(
        PeerDiscoverySummary {
            has_direct_peer_metadata: false,
            known_via_route_table: false,
        },
        |edge| PeerDiscoverySummary {
            has_direct_peer_metadata: edge.has_direct_peer_metadata,
            known_via_route_table: edge.known_via_route_table,
        },
    );
    let route = edge.map_or(
        PeerRouteSummary {
            kind: EdgeRouteKind::Unknown,
            link_type: EdgeLinkType::Unknown,
            cost: None,
            relay_hops: Vec::new(),
            candidate_count: 0,
        },
        peer_route_summary,
    );

    ConnectionEntry {
        edge_id,
        label,
        host: edge.and_then(|edge| edge.host.clone()),
        udp_addr: edge.and_then(|edge| edge.udp_addr.clone()),
        relay_port: edge.and_then(|edge| edge.relay_port),
        remote_session_count: edge.map_or(0, |edge| edge.remote_session_count),
        discovery,
        route,
        voice_tcp: voice_tcp_connection_summary(pool, inbound_connection_count),
    }
}

fn build_connection_entries(
    edges: &[KnownEdgeEntry],
    voice_tcp_conns: &HashMap<u32, Arc<PeerVoiceTcpPool>>,
    incoming_voice_tcp_connections: &HashMap<u32, usize>,
) -> Vec<ConnectionEntry> {
    let edge_map: HashMap<_, _> = edges.iter().map(|edge| (edge.edge_id, edge)).collect();
    let mut edge_ids = BTreeSet::new();

    for edge in edges {
        edge_ids.insert(edge.edge_id);
    }
    for &edge_id in voice_tcp_conns.keys() {
        edge_ids.insert(edge_id);
    }
    for &edge_id in incoming_voice_tcp_connections.keys() {
        edge_ids.insert(edge_id);
    }

    edge_ids
        .into_iter()
        .map(|edge_id| {
            connection_entry(
                edge_id,
                edge_map.get(&edge_id).copied(),
                voice_tcp_conns.get(&edge_id),
                incoming_voice_tcp_connections
                    .get(&edge_id)
                    .copied()
                    .unwrap_or(0),
            )
        })
        .collect()
}

fn peer_quality_diagnostics_entry(
    snapshot: PeerQualitySnapshot,
    edge: Option<&KnownEdgeEntry>,
) -> PeerQualityDiagnosticsEntry {
    PeerQualityDiagnosticsEntry {
        edge_id: snapshot.edge_id,
        label: edge
            .map(edge_label)
            .unwrap_or_else(|| format!("Edge {}", snapshot.edge_id)),
        host: edge.and_then(|entry| entry.host.clone()),
        has_direct_peer_metadata: edge.is_some_and(|entry| entry.has_direct_peer_metadata),
        known_via_route_table: edge.is_some_and(|entry| entry.known_via_route_table),
        preferred_link_type: edge
            .map(|entry| entry.preferred_link_type)
            .unwrap_or(EdgeLinkType::Unknown),
        preferred_route: edge
            .map(|entry| entry.preferred_route)
            .unwrap_or(EdgeRouteKind::Unknown),
        average_rtt_ms: snapshot.average_rtt_ms,
        packet_loss: snapshot.packet_loss,
        jitter_ms: snapshot.jitter_ms,
        rtt_samples_ms: snapshot.rtt_samples_ms,
        sample_count: snapshot.sample_count,
        rtt_sample_count: snapshot.rtt_sample_count,
        probe_sample_count: snapshot.probe_sample_count,
        direct_voice_sample_count: snapshot.direct_voice_sample_count,
        direct_voice_expected_packets: snapshot.direct_voice_expected_packets,
        direct_voice_received_packets: snapshot.direct_voice_received_packets,
        probes_sent: snapshot.probes_sent,
        pongs_received: snapshot.pongs_received,
        pending_ping_count: snapshot.pending_ping_count,
        next_seq: snapshot.next_seq,
        last_probe_sent_ms: snapshot.last_probe_sent_ms,
        last_pong_received_ms: snapshot.last_pong_received_ms,
        last_report_ms: snapshot.last_report_ms,
        last_report_average_rtt_ms: snapshot.last_report_average_rtt_ms,
        last_report_packet_loss: snapshot.last_report_packet_loss,
        last_report_jitter_ms: snapshot.last_report_jitter_ms,
    }
}

fn build_route_stats(edges: &[KnownEdgeEntry]) -> RouteStatsSummary {
    let mut direct_edges = 0;
    let mut relay_edges = 0;
    let mut hub_fallback_edges = 0;
    let mut unknown_edges = 0;

    for edge in edges {
        match edge.preferred_route {
            EdgeRouteKind::DirectUdp | EdgeRouteKind::DirectTcp => direct_edges += 1,
            EdgeRouteKind::RelayChain => relay_edges += 1,
            EdgeRouteKind::HubTcp => hub_fallback_edges += 1,
            EdgeRouteKind::Unknown => unknown_edges += 1,
        }
    }

    RouteStatsSummary {
        known_edges: edges.len(),
        direct_edges,
        relay_edges,
        hub_fallback_edges,
        unknown_edges,
        route_candidate_count: edges.iter().map(|edge| edge.route_candidates.len()).sum(),
    }
}

fn build_topology_stats(edges: &[KnownEdgeEntry]) -> TopologyStats {
    let routes = build_route_stats(edges);
    TopologyStats {
        node_count: edges.len() + 1,
        peer_count: edges.len(),
        link_count: edges.len(),
        direct_links: routes.direct_edges,
        relay_links: routes.relay_edges,
        hub_fallback_links: routes.hub_fallback_edges,
        unknown_links: routes.unknown_edges,
        quality_observed_links: 0,
        route_candidate_count: routes.route_candidate_count,
    }
}

fn build_self_edge_info(context: &WebApiContext, overview: &EdgeOverview) -> SelfEdgeInfo {
    SelfEdgeInfo {
        configured_server_id: context.metadata.configured_server_id,
        edge_id: overview.source_edge_id,
        is_registered: context.edge_state.get_edge_id() != 0,
        name: context.metadata.name.clone(),
        external_host: context.metadata.external_host.clone(),
        client_port: context.metadata.client_port,
        edge_port: context.metadata.edge_port,
        region: context.metadata.region.clone(),
        capacity: context.metadata.capacity,
        local_client_count: overview.local_client_count,
        channel_count: overview.channel_count,
        accepting_connections: context
            .edge_state
            .accepting_connections
            .load(Ordering::Relaxed),
        web_api_host: context.metadata.web_api_host.clone(),
        web_api_port: context.metadata.web_api_port,
    }
}

fn topology_node_self(context: &WebApiContext, overview: &EdgeOverview) -> TopologyNode {
    TopologyNode {
        edge_id: overview.source_edge_id,
        label: context.metadata.name.clone(),
        is_self: true,
        host: Some(context.metadata.external_host.clone()),
        region: context.metadata.region.clone(),
        session_count: overview.local_client_count,
    }
}

fn topology_node_peer(edge: &KnownEdgeEntry) -> TopologyNode {
    TopologyNode {
        edge_id: edge.edge_id,
        label: edge_label(edge),
        is_self: false,
        host: edge.host.clone(),
        region: None,
        session_count: edge.remote_session_count,
    }
}

fn topology_link(
    source_edge_id: u32,
    edge: &KnownEdgeEntry,
    quality: Option<&PeerQualitySnapshot>,
) -> TopologyLinkEntry {
    TopologyLinkEntry {
        source_edge_id,
        target_edge_id: edge.edge_id,
        state: connectivity_state(edge.preferred_route),
        route: peer_route_summary(edge),
        quality: quality.map(peer_quality_summary),
    }
}

fn build_topology_matrix(
    source_edge_id: u32,
    edges: &[KnownEdgeEntry],
    quality: &HashMap<u32, PeerQualitySnapshot>,
) -> Vec<TopologyMatrixCell> {
    let mut observed = HashMap::new();
    for edge in edges {
        observed.insert(
            (source_edge_id, edge.edge_id),
            TopologyMatrixCell {
                source_edge_id,
                target_edge_id: edge.edge_id,
                observed: true,
                state: connectivity_state(edge.preferred_route),
                route: Some(peer_route_summary(edge)),
                quality: quality.get(&edge.edge_id).map(peer_quality_summary),
            },
        );
    }

    let mut edge_ids = Vec::with_capacity(edges.len() + 1);
    edge_ids.push(source_edge_id);
    edge_ids.extend(edges.iter().map(|edge| edge.edge_id));

    let mut matrix = Vec::new();
    for &from in &edge_ids {
        for &to in &edge_ids {
            if from == to {
                continue;
            }

            if let Some(cell) = observed.get(&(from, to)) {
                matrix.push(cell.clone());
            } else {
                matrix.push(TopologyMatrixCell {
                    source_edge_id: from,
                    target_edge_id: to,
                    observed: false,
                    state: ConnectivityState::Unknown,
                    route: None,
                    quality: None,
                });
            }
        }
    }
    matrix
}

fn dissemination_source_entry(
    source_edge_id: u32,
    state: &DisseminationSourceState,
) -> DisseminationSourceEntry {
    let mut active_children = state.active_children.clone();
    active_children.sort_unstable();

    let mut duplicate_children = state.duplicate_children.clone();
    duplicate_children.sort_unstable();

    let mut branch_backups: Vec<_> = state
        .branch_backups
        .iter()
        .map(|(&primary_child_edge_id, backup_next_hops)| {
            let mut backup_next_hops = backup_next_hops.clone();
            backup_next_hops.sort_unstable();
            DisseminationBranchBackupEntry {
                primary_child_edge_id,
                backup_next_hops,
            }
        })
        .collect();
    branch_backups.sort_by_key(|entry| entry.primary_child_edge_id);

    DisseminationSourceEntry {
        source_edge_id,
        active_children,
        duplicate_children,
        branch_backups,
    }
}

fn build_dissemination_entries(
    routes: &HashMap<u32, DisseminationSourceState>,
) -> Vec<DisseminationSourceEntry> {
    let mut entries: Vec<_> = routes
        .iter()
        .map(|(&source_edge_id, state)| dissemination_source_entry(source_edge_id, state))
        .collect();
    entries.sort_by_key(|entry| entry.source_edge_id);
    entries
}

fn voice_target_channel_entry(channel: &VoiceTargetChannelConfig) -> VoiceTargetChannelEntry {
    VoiceTargetChannelEntry {
        channel_id: channel.channel_id,
        children: channel.children,
        links: channel.links,
        group: channel.group.clone(),
    }
}

fn voice_target_config_entry(config: &VoiceTargetConfig) -> VoiceTargetConfigEntry {
    let mut sessions = config.sessions.clone();
    sessions.sort_unstable();

    let mut channels: Vec<_> = config
        .channels
        .iter()
        .map(voice_target_channel_entry)
        .collect();
    channels.sort_by(|left, right| {
        (
            left.channel_id,
            left.children,
            left.links,
            left.group.as_deref(),
        )
            .cmp(&(
                right.channel_id,
                right.children,
                right.links,
                right.group.as_deref(),
            ))
    });

    let mut resolved_channels: Vec<_> = config
        .resolved_channels
        .iter()
        .map(|(&channel_id, groups)| {
            let mut groups = groups.clone();
            if let Some(items) = groups.as_mut() {
                items.sort();
            }
            VoiceTargetResolvedChannelEntry { channel_id, groups }
        })
        .collect();
    resolved_channels.sort_by_key(|entry| entry.channel_id);

    VoiceTargetConfigEntry {
        sessions,
        channels,
        resolved_channels,
    }
}

fn voice_target_route_cache_entry(
    topology_version: u64,
    route: &crate::voice_target::WhisperRouteCacheEntry,
) -> VoiceTargetRouteCacheEntry {
    let mut direct_sessions: Vec<_> = route.direct_sessions.iter().copied().collect();
    direct_sessions.sort_unstable();

    let mut channel_sessions: Vec<_> = route.channel_sessions.iter().copied().collect();
    channel_sessions.sort_unstable();

    let mut relay_edge_ids: Vec<_> = route.relay_edge_ids.iter().copied().collect();
    relay_edge_ids.sort_unstable();

    VoiceTargetRouteCacheEntry {
        topology_version,
        direct_sessions,
        channel_sessions,
        relay_edge_ids,
    }
}

fn build_voice_target_entries(
    session_edge_ids: &HashMap<u32, u32>,
    voice_targets: &HashMap<u32, HashMap<u32, VoiceTargetConfig>>,
    whisper_route_cache: &HashMap<u32, SessionWhisperRouteCache>,
) -> Vec<VoiceTargetEntry> {
    let mut entries = Vec::new();

    for (&client_session, targets) in voice_targets {
        let cached_session = whisper_route_cache.get(&client_session);

        for (&target_id, config) in targets {
            let cached_route = cached_session.and_then(|session_cache| {
                session_cache.targets.get(&target_id).map(|route| {
                    voice_target_route_cache_entry(session_cache.topology_version, route)
                })
            });

            entries.push(VoiceTargetEntry {
                client_session,
                edge_id: session_edge_ids.get(&client_session).copied(),
                target_id,
                config: voice_target_config_entry(config),
                cached_route,
            });
        }
    }

    entries.sort_by_key(|entry| (entry.client_session, entry.target_id));
    entries
}

async fn collect_voice_target_entries(context: &WebApiContext) -> Vec<VoiceTargetEntry> {
    let source_edge_id = context.source_edge_id();

    let local_clients = context.edge_state.client_manager.get_all_clients().await;
    let remote_users = context
        .edge_state
        .channel_manager
        .get_all_remote_users()
        .await;

    let mut session_edge_ids = HashMap::new();
    for client in local_clients {
        session_edge_ids.insert(client.session, source_edge_id);
    }
    for user in remote_users {
        if user.edge_id != 0 {
            session_edge_ids.insert(user.session_id, user.edge_id);
        }
    }

    let voice_targets = context.edge_state.voice_targets.read().await.clone();
    let whisper_route_cache = context
        .edge_state
        .whisper_route_cache
        .read()
        .unwrap()
        .clone();

    build_voice_target_entries(&session_edge_ids, &voice_targets, &whisper_route_cache)
}

async fn collect_overview(context: &WebApiContext) -> EdgeOverview {
    let source_edge_id = context.source_edge_id();
    let local_client_count = context
        .edge_state
        .client_manager
        .get_all_clients()
        .await
        .len();
    let remote_users = context
        .edge_state
        .channel_manager
        .get_all_remote_users()
        .await;
    let remote_client_count = remote_users.len();
    let channel_count = context
        .edge_state
        .channel_manager
        .get_all_channels()
        .await
        .len();
    let quality = context
        .edge_state
        .peer_quality_snapshots()
        .await
        .into_iter()
        .map(|snapshot| (snapshot.edge_id, snapshot))
        .collect();
    let peer_snapshot = context.edge_state.peer_registry.load().all_peers();
    let route_table = context.edge_state.route_table.load_full();

    let mut remote_edge_counts = HashMap::new();
    for user in remote_users {
        if user.edge_id != 0 && user.edge_id != source_edge_id {
            *remote_edge_counts.entry(user.edge_id).or_insert(0) += 1;
        }
    }

    let edges = build_known_edge_entries(
        source_edge_id,
        peer_snapshot,
        &route_table,
        &remote_edge_counts,
    );

    EdgeOverview {
        source_edge_id,
        local_client_count,
        remote_client_count,
        channel_count,
        edges,
        quality,
    }
}

async fn handle_status(State(context): State<AppState>) -> Json<StatusResponse> {
    let overview = collect_overview(context.as_ref()).await;
    Json(StatusResponse {
        status: "running",
        version: env!("CARGO_PKG_VERSION"),
        uptime_secs: context.started_at.elapsed().as_secs(),
        edge: build_self_edge_info(context.as_ref(), &overview),
        remote_client_count: overview.remote_client_count,
        known_edge_count: overview.edges.len(),
        voice_routing_enabled: context.metadata.voice_routing_enabled,
        topology_version: context.edge_state.topology_version.load(Ordering::Relaxed),
        timestamp: now_secs(),
    })
}

async fn handle_stats(State(context): State<AppState>) -> Json<StatsResponse> {
    let overview = collect_overview(context.as_ref()).await;
    Json(StatsResponse {
        clients: ClientStatsSummary {
            local: overview.local_client_count,
            remote: overview.remote_client_count,
            total: overview.local_client_count + overview.remote_client_count,
        },
        channel_count: overview.channel_count,
        routes: build_route_stats(&overview.edges),
        limits: LimitStatsSummary {
            max_users: context.edge_state.max_users.load(Ordering::Relaxed),
            max_bandwidth_bps: context.edge_state.max_bandwidth_bps.load(Ordering::Relaxed),
            listeners_per_user: context
                .edge_state
                .listeners_per_user
                .load(Ordering::Relaxed),
            listeners_per_channel: context
                .edge_state
                .listeners_per_channel
                .load(Ordering::Relaxed),
            allow_ping: context.edge_state.allow_ping.load(Ordering::Relaxed),
        },
        voice_routing_enabled: context.metadata.voice_routing_enabled,
        accepting_connections: context
            .edge_state
            .accepting_connections
            .load(Ordering::Relaxed),
        topology_version: context.edge_state.topology_version.load(Ordering::Relaxed),
        timestamp: now_secs(),
    })
}

async fn handle_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        timestamp: now_secs(),
    })
}

async fn handle_endpoints(State(context): State<AppState>) -> Json<ApiEndpointListResponse> {
    let endpoints = edge_api_endpoints(context.api_token_required);

    Json(ApiEndpointListResponse {
        service: "edge",
        total: endpoints.len(),
        endpoints,
        timestamp: now_secs(),
    })
}

async fn handle_sessions(State(context): State<AppState>) -> Json<SessionListResponse> {
    let local_all = context.edge_state.client_manager.get_all_clients().await;
    let remote_all = context
        .edge_state
        .channel_manager
        .get_all_remote_users()
        .await;

    let local_count = local_all.len();
    let remote_count = remote_all.len();
    let my_edge_id = context.source_edge_id();

    let mut sessions = Vec::with_capacity(local_count + remote_count);

    for c in local_all {
        let udp_addr = context
            .edge_state
            .udp_session_to_addr
            .get(&c.session)
            .map(|entry| entry.value().to_string());
        let has_crypt_state = context
            .edge_state
            .client_manager
            .get_crypt_state(c.session)
            .await
            .is_some();
        let ping_stats = context
            .edge_state
            .client_manager
            .get_ping_stats(c.session)
            .await
            .unwrap_or_default();

        sessions.push(SessionEntry {
            session: c.session,
            edge_id: my_edge_id,
            scope: SessionScope::Local,
            user_id: c.user_id,
            username: c.username,
            channel_id: c.channel_id,
            mute: c.mute,
            deaf: c.deaf,
            suppress: c.suppress,
            self_mute: c.self_mute,
            self_deaf: c.self_deaf,
            priority_speaker: c.priority_speaker,
            recording: c.recording,
            listening_channels: c.listening_channels,
            ip_address: Some(c.ip_address),
            opus_supported: Some(c.opus_supported),
            client_version: c.client_version,
            client_release: Some(c.client_release),
            client_os: Some(c.client_os),
            local_transport: Some(LocalSessionTransportSummary {
                has_udp_addr: udp_addr.is_some(),
                udp_addr,
                has_crypt_state,
                udp_packets: ping_stats.udp_packets,
                tcp_packets: ping_stats.tcp_packets,
                udp_ping_avg: ping_stats.udp_ping_avg,
                udp_ping_var: ping_stats.udp_ping_var,
                tcp_ping_avg: ping_stats.tcp_ping_avg,
                tcp_ping_var: ping_stats.tcp_ping_var,
                remote_good: ping_stats.remote_good,
                remote_late: ping_stats.remote_late,
                remote_lost: ping_stats.remote_lost,
                remote_resync: ping_stats.remote_resync,
            }),
        });
    }

    for u in remote_all {
        sessions.push(SessionEntry {
            session: u.session_id,
            edge_id: u.edge_id,
            scope: SessionScope::Remote,
            user_id: u.user_id,
            username: u.username,
            channel_id: u.channel_id,
            mute: u.mute,
            deaf: u.deaf,
            suppress: u.suppress,
            self_mute: u.self_mute,
            self_deaf: u.self_deaf,
            priority_speaker: u.priority_speaker,
            recording: u.recording,
            listening_channels: u.listening_channels,
            ip_address: None,
            opus_supported: None,
            client_version: None,
            client_release: None,
            client_os: None,
            local_transport: None,
        });
    }

    let total = sessions.len();
    Json(SessionListResponse {
        source_edge_id: my_edge_id,
        total,
        local_count,
        remote_count,
        sessions,
        timestamp: now_secs(),
    })
}

async fn handle_peers(State(context): State<AppState>) -> Json<PeerListResponse> {
    let overview = collect_overview(context.as_ref()).await;
    let peers: Vec<_> = overview
        .edges
        .iter()
        .map(|edge| peer_entry(edge, overview.quality.get(&edge.edge_id)))
        .collect();
    let total = peers.len();
    Json(PeerListResponse {
        source_edge_id: overview.source_edge_id,
        total,
        peers,
        timestamp: now_secs(),
    })
}

async fn handle_connections(State(context): State<AppState>) -> Json<ConnectionListResponse> {
    let overview = collect_overview(context.as_ref()).await;
    let voice_tcp_conns = context.edge_state.voice_tcp_conns.load_full();
    let incoming_voice_tcp_connections = context.edge_state.incoming_voice_tcp_connection_counts();
    let connections = build_connection_entries(
        &overview.edges,
        &voice_tcp_conns,
        &incoming_voice_tcp_connections,
    );
    let total = connections.len();

    Json(ConnectionListResponse {
        source_edge_id: overview.source_edge_id,
        total,
        connections,
        timestamp: now_secs(),
    })
}

async fn handle_topology(State(context): State<AppState>) -> Json<TopologyResponse> {
    let overview = collect_overview(context.as_ref()).await;
    let mut nodes = Vec::with_capacity(overview.edges.len() + 1);
    nodes.push(topology_node_self(context.as_ref(), &overview));
    nodes.extend(overview.edges.iter().map(topology_node_peer));
    let links = overview
        .edges
        .iter()
        .map(|edge| {
            topology_link(
                overview.source_edge_id,
                edge,
                overview.quality.get(&edge.edge_id),
            )
        })
        .collect();
    let mut stats = build_topology_stats(&overview.edges);
    stats.quality_observed_links = overview
        .edges
        .iter()
        .filter(|edge| overview.quality.contains_key(&edge.edge_id))
        .count();

    Json(TopologyResponse {
        source_edge_id: overview.source_edge_id,
        nodes,
        links,
        stats,
        timestamp: now_secs(),
    })
}

async fn handle_topology_matrix(State(context): State<AppState>) -> Json<TopologyMatrixResponse> {
    let overview = collect_overview(context.as_ref()).await;
    let mut nodes = Vec::with_capacity(overview.edges.len() + 1);
    nodes.push(topology_node_self(context.as_ref(), &overview));
    nodes.extend(overview.edges.iter().map(topology_node_peer));

    Json(TopologyMatrixResponse {
        source_edge_id: overview.source_edge_id,
        nodes,
        cells: build_topology_matrix(overview.source_edge_id, &overview.edges, &overview.quality),
        timestamp: now_secs(),
    })
}

async fn handle_dissemination(State(context): State<AppState>) -> Json<DisseminationResponse> {
    let routes = context.edge_state.dissemination_routes.load_full();
    let sources = build_dissemination_entries(&routes);

    Json(DisseminationResponse {
        edge_id: context.source_edge_id(),
        route_epoch: context
            .edge_state
            .dissemination_route_epoch
            .load(Ordering::Relaxed),
        total_sources: sources.len(),
        sources,
        timestamp: now_secs(),
    })
}

async fn handle_voice_targets(State(context): State<AppState>) -> Json<VoiceTargetListResponse> {
    let voice_targets = collect_voice_target_entries(context.as_ref()).await;
    let total = voice_targets.len();

    Json(VoiceTargetListResponse {
        source_edge_id: context.source_edge_id(),
        total,
        voice_targets,
        timestamp: now_secs(),
    })
}

async fn handle_voice_targets_by_session(
    State(context): State<AppState>,
    Path(session_id): Path<u32>,
) -> Json<VoiceTargetListResponse> {
    let mut voice_targets = collect_voice_target_entries(context.as_ref()).await;
    voice_targets.retain(|entry| entry.client_session == session_id);
    let total = voice_targets.len();

    Json(VoiceTargetListResponse {
        source_edge_id: context.source_edge_id(),
        total,
        voice_targets,
        timestamp: now_secs(),
    })
}

async fn handle_peer_quality_diagnostics(
    State(context): State<AppState>,
) -> Json<PeerQualityDiagnosticsResponse> {
    let overview = collect_overview(context.as_ref()).await;
    let known_edges: HashMap<_, _> = overview
        .edges
        .iter()
        .map(|edge| (edge.edge_id, edge))
        .collect();
    let mut snapshots: Vec<_> = overview.quality.into_values().collect();
    snapshots.sort_by_key(|snapshot| snapshot.edge_id);
    let entries: Vec<_> = snapshots
        .into_iter()
        .map(|snapshot| {
            let edge = known_edges.get(&snapshot.edge_id).copied();
            peer_quality_diagnostics_entry(snapshot, edge)
        })
        .collect();
    let total = entries.len();

    Json(PeerQualityDiagnosticsResponse {
        source_edge_id: overview.source_edge_id,
        total,
        entries,
        timestamp: now_secs(),
    })
}

fn data_routes() -> Router<AppState> {
    let mut router: Router<AppState> = Router::new();

    macro_rules! add_route {
        ($router:ident, $method:literal, $path:literal, $summary:literal, $access:expr, $handler:expr) => {
            $router = $router.route($path, $handler);
        };
    }

    for_each_edge_data_route!(add_route, router);
    router
}

fn public_routes() -> Router<AppState> {
    let mut router: Router<AppState> = Router::new();

    macro_rules! add_route {
        ($router:ident, $method:literal, $path:literal, $summary:literal, $access:expr, $handler:expr) => {
            $router = $router.route($path, $handler);
        };
    }

    for_each_edge_public_route!(add_route, router);
    router
}

/// Build the axum router for the Edge Web API.
pub fn build_router(
    state: Arc<EdgeState>,
    metadata: WebApiMetadata,
    api_token: Option<String>,
) -> Router {
    let app_state = Arc::new(WebApiContext {
        edge_state: state,
        metadata,
        api_token_required: api_token.is_some(),
        started_at: Instant::now(),
    });
    let router = data_routes().merge(public_routes());

    if let Some(token) = api_token {
        let auth_state = Arc::new(token);
        let protected = data_routes()
            .route_layer(middleware::from_fn_with_state(
                auth_state.clone(),
                require_bearer_token,
            ))
            .with_state(app_state.clone());
        let public = public_routes().with_state(app_state);
        return public.merge(protected);
    }

    router.with_state(app_state)
}

/// Bearer-token middleware.  Compares the `Authorization: Bearer …` header
/// against the configured token using a constant-time check so that timing
/// observations cannot reveal a prefix of the secret.
async fn require_bearer_token(
    State(expected): State<Arc<String>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if !constant_time_eq(header.as_bytes(), expected.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Start the Edge Web API HTTP server.
pub async fn run_web_api(
    host: &str,
    port: u16,
    state: Arc<EdgeState>,
    metadata: WebApiMetadata,
    api_token: Option<String>,
) -> anyhow::Result<()> {
    let addr = format!("{}:{}", host, port);
    let bound: std::net::IpAddr = host
        .parse()
        .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    let public_bind = !bound.is_loopback();
    if public_bind && api_token.as_deref().is_none_or(str::is_empty) {
        warn!(
            "Edge Web API is enabled on a non-loopback address ({}) without \
             web_api.api_token; session metadata, peer topology, and local UDP \
             quality diagnostics will be readable by every remote caller. Set \
             web_api.api_token or bind web_api.host to 127.0.0.1.",
            addr
        );
    }
    let token = api_token.filter(|t| !t.is_empty());
    let router = build_router(state, metadata, token);

    info!("Edge Web API listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to bind Edge Web API on {}: {}", addr, e))?;

    axum::serve(listener, router)
        .await
        .map_err(|e| anyhow::anyhow!("Edge Web API server error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectivityState, DisseminationBranchBackupEntry, EdgeLinkType, EdgeRouteCandidateEntry,
        EdgeRouteKind, VoiceTargetChannelEntry, VoiceTargetResolvedChannelEntry, VoiceTcpSlotEntry,
        build_connection_entries, build_dissemination_entries, build_known_edge_entries,
        build_route_stats, build_topology_matrix, build_voice_target_entries, edge_api_endpoints,
        edge_link_type,
    };
    use crate::peer_registry::{PeerEdgeInfo, PeerVoiceTcpPool};
    use crate::state::{DisseminationSourceState, HopTransport, RouteCandidate, RouteDecision};
    use crate::voice_target::{
        SessionWhisperRouteCache, VoiceTargetChannelConfig, VoiceTargetConfig,
        WhisperRouteCacheEntry,
    };
    use smallvec::smallvec;
    use std::collections::HashMap;
    use std::sync::{Arc, atomic::Ordering};
    use tokio::sync::mpsc;

    fn known_edge(
        edge_id: u32,
        preferred_route: EdgeRouteKind,
        route_candidates: Vec<EdgeRouteCandidateEntry>,
    ) -> super::KnownEdgeEntry {
        super::KnownEdgeEntry {
            edge_id,
            has_direct_peer_metadata: true,
            known_via_route_table: !route_candidates.is_empty(),
            remote_session_count: 0,
            host: Some(format!("edge-{}", edge_id)),
            udp_addr: Some(format!("10.0.0.{}:65000", edge_id)),
            relay_port: Some(65000 + edge_id as u16),
            preferred_link_type: edge_link_type(preferred_route),
            preferred_route,
            preferred_relay_hops: Vec::new(),
            route_candidates,
        }
    }

    #[test]
    fn build_known_edge_entries_prefers_route_table_route() {
        let peer_snapshot = vec![(
            2,
            PeerEdgeInfo {
                udp_addr: "10.0.0.2:65000".parse().unwrap(),
                host: "10.0.0.2".into(),
                relay_port: Some(7443),
            },
        )];
        let route_table = HashMap::from([(
            2,
            vec![RouteCandidate {
                decision: RouteDecision::DirectTcp,
                cost: 1.0,
            }],
        )]);
        let remote_counts = HashMap::from([(2, 3)]);

        let edges = build_known_edge_entries(1, peer_snapshot, &route_table, &remote_counts);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].preferred_route, EdgeRouteKind::DirectTcp);
        assert_eq!(edges[0].preferred_link_type, EdgeLinkType::Direct);
        assert_eq!(edges[0].remote_session_count, 3);
    }

    #[test]
    fn build_known_edge_entries_falls_back_to_direct_udp_for_peer_metadata() {
        let peer_snapshot = vec![(
            2,
            PeerEdgeInfo {
                udp_addr: "10.0.0.2:65000".parse().unwrap(),
                host: "10.0.0.2".into(),
                relay_port: None,
            },
        )];

        let edges = build_known_edge_entries(1, peer_snapshot, &HashMap::new(), &HashMap::new());

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].preferred_route, EdgeRouteKind::DirectUdp);
        assert_eq!(edges[0].preferred_link_type, EdgeLinkType::Direct);
        assert_eq!(edges[0].relay_port, Some(65000));
    }

    #[test]
    fn build_known_edge_entries_marks_relay_chain_routes() {
        let route_table = HashMap::from([(
            4,
            vec![RouteCandidate {
                decision: RouteDecision::RelayChain {
                    hops: vec![2, 3],
                    transports: vec![HopTransport::Udp, HopTransport::Tcp],
                },
                cost: 2.5,
            }],
        )]);

        let edges = build_known_edge_entries(1, Vec::new(), &route_table, &HashMap::new());

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].preferred_route, EdgeRouteKind::RelayChain);
        assert_eq!(edges[0].preferred_link_type, EdgeLinkType::Relay);
        assert_eq!(edges[0].preferred_relay_hops.len(), 2);
        assert_eq!(edges[0].preferred_relay_hops[0].edge_id, 2);
        assert_eq!(edges[0].preferred_relay_hops[1].edge_id, 3);
    }

    #[test]
    fn build_route_stats_splits_route_kinds() {
        let edges = vec![
            known_edge(
                2,
                EdgeRouteKind::DirectTcp,
                vec![EdgeRouteCandidateEntry {
                    route: EdgeRouteKind::DirectTcp,
                    link_type: EdgeLinkType::Direct,
                    cost: 1.0,
                    relay_hops: Vec::new(),
                }],
            ),
            known_edge(
                3,
                EdgeRouteKind::RelayChain,
                vec![EdgeRouteCandidateEntry {
                    route: EdgeRouteKind::RelayChain,
                    link_type: EdgeLinkType::Relay,
                    cost: 2.0,
                    relay_hops: Vec::new(),
                }],
            ),
            known_edge(
                4,
                EdgeRouteKind::HubTcp,
                vec![EdgeRouteCandidateEntry {
                    route: EdgeRouteKind::HubTcp,
                    link_type: EdgeLinkType::Relay,
                    cost: 9.0,
                    relay_hops: Vec::new(),
                }],
            ),
            known_edge(5, EdgeRouteKind::Unknown, Vec::new()),
        ];

        let stats = build_route_stats(&edges);
        assert_eq!(stats.known_edges, 4);
        assert_eq!(stats.direct_edges, 1);
        assert_eq!(stats.relay_edges, 1);
        assert_eq!(stats.hub_fallback_edges, 1);
        assert_eq!(stats.unknown_edges, 1);
        assert_eq!(stats.route_candidate_count, 3);
    }

    #[test]
    fn topology_matrix_marks_only_local_view_as_observed() {
        let edges = vec![
            known_edge(
                2,
                EdgeRouteKind::DirectTcp,
                vec![EdgeRouteCandidateEntry {
                    route: EdgeRouteKind::DirectTcp,
                    link_type: EdgeLinkType::Direct,
                    cost: 1.0,
                    relay_hops: Vec::new(),
                }],
            ),
            known_edge(3, EdgeRouteKind::Unknown, Vec::new()),
        ];

        let matrix = build_topology_matrix(1, &edges, &HashMap::new());

        let observed = matrix
            .iter()
            .find(|cell| cell.source_edge_id == 1 && cell.target_edge_id == 2)
            .unwrap();
        assert!(observed.observed);
        assert_eq!(observed.state, ConnectivityState::Reachable);
        assert_eq!(
            observed.route.as_ref().map(|route| route.kind),
            Some(EdgeRouteKind::DirectTcp)
        );

        let unknown_but_observed = matrix
            .iter()
            .find(|cell| cell.source_edge_id == 1 && cell.target_edge_id == 3)
            .unwrap();
        assert!(unknown_but_observed.observed);
        assert_eq!(unknown_but_observed.state, ConnectivityState::Unknown);

        let unobserved = matrix
            .iter()
            .find(|cell| cell.source_edge_id == 2 && cell.target_edge_id == 1)
            .unwrap();
        assert!(!unobserved.observed);
        assert_eq!(unobserved.state, ConnectivityState::Unknown);
        assert_eq!(unobserved.route, None);
    }

    #[test]
    fn build_dissemination_entries_sorts_sources_children_and_backups() {
        let routes = HashMap::from([
            (
                3,
                DisseminationSourceState {
                    active_children: vec![5, 2],
                    duplicate_children: vec![5, 4],
                    branch_backups: HashMap::from([(5, vec![9, 7]), (2, vec![6])]),
                },
            ),
            (1, DisseminationSourceState::default()),
        ]);

        let entries = build_dissemination_entries(&routes);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].source_edge_id, 1);
        assert_eq!(entries[1].source_edge_id, 3);
        assert_eq!(entries[1].active_children, vec![2, 5]);
        assert_eq!(entries[1].duplicate_children, vec![4, 5]);
        assert_eq!(
            entries[1].branch_backups,
            vec![
                DisseminationBranchBackupEntry {
                    primary_child_edge_id: 2,
                    backup_next_hops: vec![6],
                },
                DisseminationBranchBackupEntry {
                    primary_child_edge_id: 5,
                    backup_next_hops: vec![7, 9],
                },
            ]
        );
    }

    #[test]
    fn build_connection_entries_merges_known_edges_and_live_pool_state() {
        let edges = vec![known_edge(
            2,
            EdgeRouteKind::DirectTcp,
            vec![EdgeRouteCandidateEntry {
                route: EdgeRouteKind::DirectTcp,
                link_type: EdgeLinkType::Direct,
                cost: 1.0,
                relay_hops: Vec::new(),
            }],
        )];

        let live_pool = Arc::new(PeerVoiceTcpPool::new(2));
        let (tx, _rx) = mpsc::channel::<Vec<u8>>(1);
        *live_pool.senders[1].lock().unwrap() = Some(tx);
        live_pool.mark_connected();

        let stale_pool = Arc::new(PeerVoiceTcpPool::new(1));
        stale_pool
            .all_disconnected_since_ms
            .store(1_717_000_123_456, Ordering::Release);
        stale_pool
            .disconnect_reported
            .store(true, Ordering::Release);

        let voice_tcp_conns =
            HashMap::from([(2, Arc::clone(&live_pool)), (4, Arc::clone(&stale_pool))]);
        let incoming_voice_tcp_connections = HashMap::from([(2, 1usize), (4, 3usize)]);

        let connections =
            build_connection_entries(&edges, &voice_tcp_conns, &incoming_voice_tcp_connections);

        assert_eq!(connections.len(), 2);
        assert_eq!(connections[0].edge_id, 2);
        assert_eq!(connections[0].route.kind, EdgeRouteKind::DirectTcp);
        assert_eq!(connections[0].voice_tcp.inbound_connection_count, 1);
        assert_eq!(connections[0].voice_tcp.live_outbound_slots, 1);
        assert!(connections[0].voice_tcp.has_outbound_connection);
        assert_eq!(
            connections[0].voice_tcp.outbound_slots,
            vec![
                VoiceTcpSlotEntry {
                    slot: 0,
                    connected: false,
                },
                VoiceTcpSlotEntry {
                    slot: 1,
                    connected: true,
                },
            ]
        );

        assert_eq!(connections[1].edge_id, 4);
        assert_eq!(connections[1].label, "Edge 4");
        assert_eq!(connections[1].route.kind, EdgeRouteKind::Unknown);
        assert_eq!(connections[1].voice_tcp.inbound_connection_count, 3);
        assert_eq!(
            connections[1].voice_tcp.all_outbound_disconnected_since_ms,
            Some(1_717_000_123_456)
        );
        assert!(connections[1].voice_tcp.outbound_disconnect_reported);
    }

    #[test]
    fn build_voice_target_entries_includes_sorted_config_and_cached_route() {
        let session_edge_ids = HashMap::from([(10_001, 4)]);
        let voice_targets = HashMap::from([(
            10_001,
            HashMap::from([(
                7,
                VoiceTargetConfig {
                    sessions: vec![9, 4],
                    channels: vec![
                        VoiceTargetChannelConfig {
                            channel_id: 3,
                            links: false,
                            children: true,
                            group: Some("admins".into()),
                        },
                        VoiceTargetChannelConfig {
                            channel_id: 1,
                            links: true,
                            children: false,
                            group: None,
                        },
                    ],
                    resolved_channels: HashMap::from([
                        (5, Some(vec!["beta".into(), "alpha".into()])),
                        (2, None),
                    ]),
                },
            )]),
        )]);
        let whisper_route_cache = HashMap::from([(
            10_001,
            SessionWhisperRouteCache {
                topology_version: 42,
                targets: HashMap::from([(
                    7,
                    WhisperRouteCacheEntry {
                        direct_sessions: smallvec![9, 4],
                        channel_sessions: smallvec![12, 11],
                        relay_edge_ids: smallvec![8, 6],
                    },
                )]),
            },
        )]);

        let entries =
            build_voice_target_entries(&session_edge_ids, &voice_targets, &whisper_route_cache);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].client_session, 10_001);
        assert_eq!(entries[0].edge_id, Some(4));
        assert_eq!(entries[0].target_id, 7);
        assert_eq!(entries[0].config.sessions, vec![4, 9]);
        assert_eq!(
            entries[0].config.channels,
            vec![
                VoiceTargetChannelEntry {
                    channel_id: 1,
                    children: false,
                    links: true,
                    group: None,
                },
                VoiceTargetChannelEntry {
                    channel_id: 3,
                    children: true,
                    links: false,
                    group: Some("admins".into()),
                },
            ]
        );
        assert_eq!(
            entries[0].config.resolved_channels,
            vec![
                VoiceTargetResolvedChannelEntry {
                    channel_id: 2,
                    groups: None,
                },
                VoiceTargetResolvedChannelEntry {
                    channel_id: 5,
                    groups: Some(vec!["alpha".into(), "beta".into()]),
                },
            ]
        );

        let cached_route = entries[0]
            .cached_route
            .as_ref()
            .expect("missing cached route");
        assert_eq!(cached_route.topology_version, 42);
        assert_eq!(cached_route.direct_sessions, vec![4, 9]);
        assert_eq!(cached_route.channel_sessions, vec![11, 12]);
        assert_eq!(cached_route.relay_edge_ids, vec![6, 8]);
    }

    #[test]
    fn edge_api_endpoints_toggle_access_with_token() {
        let public = edge_api_endpoints(false);
        let public_status = public
            .iter()
            .find(|endpoint| endpoint.method == "GET" && endpoint.path == "/api/status")
            .expect("missing GET /api/status");
        assert_eq!(public_status.access, "public");

        let protected = edge_api_endpoints(true);
        let protected_status = protected
            .iter()
            .find(|endpoint| endpoint.method == "GET" && endpoint.path == "/api/status")
            .expect("missing GET /api/status");
        assert_eq!(protected_status.access, "bearer_token");

        let protected_connections = protected
            .iter()
            .find(|endpoint| endpoint.method == "GET" && endpoint.path == "/api/connections")
            .expect("missing GET /api/connections");
        assert_eq!(protected_connections.access, "bearer_token");

        let health = protected
            .iter()
            .find(|endpoint| endpoint.method == "GET" && endpoint.path == "/api/health")
            .expect("missing GET /api/health");
        assert_eq!(health.access, "public");
    }
}
