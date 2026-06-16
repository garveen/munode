//! Hub Web API — HTTP REST endpoints for monitoring and management.
//!
//! Endpoints:
//!   GET /api/endpoints                      — List Hub Web API endpoints
//!   GET /api/status                         — Hub server status (uptime, version, …)
//!   GET /api/edges                          — Connected Edge list with health summary
//!   GET /api/edges/:id                      — Specific Edge details
//!   GET /api/stats                          — Hub statistics (sessions, channels, …)
//!   GET /api/topology                       — Network topology (edges and links)
//!   GET /api/dissemination                  — Authoritative per-Edge dissemination views
//!   GET /api/dissemination/edge/:id         — Dissemination view for a specific Edge
//!   GET /api/health                         — Liveness probe (always 200 OK)
//!   GET /api/clients                        — All active client sessions (Hub-wide view)
//!   GET /api/bans                           — List active ban records
//!   DELETE /api/bans/:id                    — Remove a ban record (manual unban)
//!   GET /api/voice_targets                  — All voice (whisper) targets in the cluster
//!   GET /api/voice_targets/session/:id      — Voice targets for a specific client session
//!   GET /metrics                            — Prometheus metrics endpoint

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    Router,
    extract::{Path, State},
    http::header,
    http::{Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{delete, get},
};
use serde::Serialize;
use serde_json::json;
use tracing::{error, info};

use crate::server::HubState;
use crate::topology_manager::SourceDisseminationPlan;

/// Shared state passed to axum handlers.
type AppState = Arc<HubState>;

/// Constant-time string comparison to prevent timing side-channel attacks on API keys.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    // XOR each byte pair; OR into accumulator so no early exit leaks timing info.
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Middleware that enforces API key authentication for write operations (non-GET requests).
///
/// Reads the key from `Authorization: Bearer <key>` header and compares it to
/// `config.web_api.api_key`.  If no key is configured, all write requests are
/// rejected with 403 Forbidden to prevent accidental open access.
async fn api_key_middleware(
    State(state): State<AppState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // Allow all read-only requests through without authentication.
    if request.method() == Method::GET || request.method() == Method::HEAD {
        return next.run(request).await;
    }

    match &state.config.web_api.api_key {
        None => {
            // No key configured — reject all write operations.
            (
                StatusCode::FORBIDDEN,
                axum::response::Json(json!({
                    "success": false,
                    "message": "API key not configured; write operations are disabled"
                })),
            )
                .into_response()
        }
        Some(configured_key) => {
            let provided_key = request
                .headers()
                .get("Authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "));
            if provided_key.is_some_and(|k| constant_time_eq(k, configured_key)) {
                next.run(request).await
            } else {
                (
                    StatusCode::UNAUTHORIZED,
                    axum::response::Json(json!({
                        "success": false,
                        "message": "Invalid or missing API key"
                    })),
                )
                    .into_response()
            }
        }
    }
}

#[derive(Serialize)]
pub struct VoiceTargetChannelInfo {
    pub channel_id: u32,
    pub children: bool,
    pub links: bool,
    pub group: Option<String>,
}

/// Serialised voice target configuration.
#[derive(Serialize)]
pub struct VoiceTargetConfigInfo {
    /// Session IDs that are direct whisper targets.
    pub sessions: Vec<u32>,
    /// Channel entries that are whisper targets.
    pub channels: Vec<VoiceTargetChannelInfo>,
}

/// A single voice target entry as returned by the web API.
#[derive(Serialize)]
pub struct VoiceTargetInfo {
    /// Edge that owns this client session.
    pub edge_id: u32,
    /// Session ID of the speaking client.
    pub client_session: u32,
    /// Whisper target slot ID (1–30 for Mumble).
    pub target_id: u32,
    /// Configured targets for this slot (absent when the slot is cleared).
    pub config: Option<VoiceTargetConfigInfo>,
    /// Unix timestamp in milliseconds when this slot was last updated.
    pub timestamp_ms: i64,
}

/// Response for the voice targets list endpoint.
#[derive(Serialize)]
pub struct VoiceTargetListResponse {
    pub voice_targets: Vec<VoiceTargetInfo>,
    pub timestamp: u64,
}
#[derive(Serialize)]
pub struct StatusResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub uptime_secs: u64,
    pub timestamp: u64,
    pub edge_count: usize,
    pub session_count: usize,
}

/// Edge summary in the edge list.
#[derive(Serialize)]
pub struct EdgeSummary {
    pub id: u32,
    pub name: String,
    pub host: String,
    pub port: u32,
    pub region: Option<String>,
    pub capacity: u32,
    pub session_count: u32,
    pub last_heartbeat_secs: u64,
    pub is_online: bool,
}

/// Detailed Edge information.
#[derive(Serialize)]
pub struct EdgeDetail {
    pub id: u32,
    pub name: String,
    pub host: String,
    pub port: u32,
    pub region: Option<String>,
    pub capacity: u32,
    pub session_count: u32,
    pub channel_count: u32,
    pub uptime_secs: u64,
    pub last_heartbeat_secs: u64,
    pub is_online: bool,
    pub connected_peer_ids: Vec<u32>,
}

/// Hub statistics response.
#[derive(Serialize)]
pub struct StatsResponse {
    pub total_sessions: usize,
    pub total_channels: usize,
    pub total_edges: usize,
    pub timestamp: u64,
}

/// Topology link quality between two edges.
#[derive(Serialize)]
pub struct TopologyLink {
    pub from_edge_id: u32,
    pub to_edge_id: u32,
    pub rtt_ms: f64,
    pub packet_loss: f64,
    pub jitter_ms: f64,
    pub samples: u32,
    pub last_update_secs: u64,
}

/// Topology response.
#[derive(Serialize)]
pub struct TopologyResponse {
    pub edges: Vec<EdgeSummary>,
    pub links: Vec<TopologyLink>,
    pub timestamp: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DisseminationBranchBackupInfo {
    pub primary_child_edge_id: u32,
    pub backup_next_hops: Vec<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DisseminationSourceInfo {
    pub source_edge_id: u32,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub active_children: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub duplicate_children: Vec<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub branch_backups: Vec<DisseminationBranchBackupInfo>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct EdgeDisseminationInfo {
    pub edge_id: u32,
    pub name: String,
    pub source_count: usize,
    pub sources: Vec<DisseminationSourceInfo>,
}

#[derive(Serialize)]
pub struct DisseminationResponse {
    pub edges: Vec<EdgeDisseminationInfo>,
    pub timestamp: u64,
}

/// A single client entry as returned by the Hub Web API.
#[derive(Serialize)]
pub struct HubClientEntry {
    pub session_id: u32,
    pub edge_id: u32,
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
}

/// Response for the Hub-wide client list endpoint.
#[derive(Serialize)]
pub struct HubClientListResponse {
    pub clients: Vec<HubClientEntry>,
    pub timestamp: u64,
}

/// Health check response.
#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApiAccessKind {
    Public,
    RequiresApiKey,
}

impl ApiAccessKind {
    fn describe(self, api_key_configured: bool) -> &'static str {
        match self {
            Self::Public => "public",
            Self::RequiresApiKey => {
                if api_key_configured {
                    "bearer_api_key"
                } else {
                    "disabled_without_api_key"
                }
            }
        }
    }
}

macro_rules! for_each_hub_route {
    ($apply:ident, $target:ident) => {{
        $apply!(
            $target,
            "GET",
            "/api/endpoints",
            "List Hub Web API endpoints",
            ApiAccessKind::Public,
            get(handle_endpoints)
        );
        $apply!(
            $target,
            "GET",
            "/api/status",
            "Hub server status",
            ApiAccessKind::Public,
            get(handle_status)
        );
        $apply!(
            $target,
            "GET",
            "/api/edges",
            "Connected Edge list with health summary",
            ApiAccessKind::Public,
            get(handle_edges)
        );
        $apply!(
            $target,
            "GET",
            "/api/edges/:id",
            "Specific Edge details",
            ApiAccessKind::Public,
            get(handle_edge_detail)
        );
        $apply!(
            $target,
            "GET",
            "/api/stats",
            "Hub statistics",
            ApiAccessKind::Public,
            get(handle_stats)
        );
        $apply!(
            $target,
            "GET",
            "/api/topology",
            "Network topology",
            ApiAccessKind::Public,
            get(handle_topology)
        );
        $apply!(
            $target,
            "GET",
            "/api/dissemination",
            "Authoritative per-Edge dissemination views",
            ApiAccessKind::Public,
            get(handle_dissemination)
        );
        $apply!(
            $target,
            "GET",
            "/api/dissemination/edge/:id",
            "Dissemination view for a specific Edge",
            ApiAccessKind::Public,
            get(handle_dissemination_by_edge)
        );
        $apply!(
            $target,
            "GET",
            "/api/health",
            "Liveness probe",
            ApiAccessKind::Public,
            get(handle_health)
        );
        $apply!(
            $target,
            "GET",
            "/api/clients",
            "All active client sessions",
            ApiAccessKind::Public,
            get(handle_clients)
        );
        $apply!(
            $target,
            "GET",
            "/api/bans",
            "List active ban records",
            ApiAccessKind::Public,
            get(handle_bans)
        );
        $apply!(
            $target,
            "DELETE",
            "/api/bans/:id",
            "Remove a ban record",
            ApiAccessKind::RequiresApiKey,
            delete(handle_unban)
        );
        $apply!(
            $target,
            "GET",
            "/api/voice_targets",
            "All voice targets in the cluster",
            ApiAccessKind::Public,
            get(handle_voice_targets)
        );
        $apply!(
            $target,
            "GET",
            "/api/voice_targets/session/:id",
            "Voice targets for a specific client session",
            ApiAccessKind::Public,
            get(handle_voice_targets_by_session)
        );
        $apply!(
            $target,
            "GET",
            "/metrics",
            "Prometheus metrics endpoint",
            ApiAccessKind::Public,
            get(handle_metrics)
        );
    }};
}

/// A single Hub Web API endpoint descriptor.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApiEndpointInfo {
    pub method: &'static str,
    pub path: &'static str,
    pub summary: &'static str,
    pub access: &'static str,
}

/// Response for the endpoint discovery endpoint.
#[derive(Serialize)]
pub struct ApiEndpointListResponse {
    pub service: &'static str,
    pub total: usize,
    pub endpoints: Vec<ApiEndpointInfo>,
    pub timestamp: u64,
}

/// A single ban record as returned by the Web API.
#[derive(Serialize)]
pub struct BanEntry {
    pub id: i64,
    /// IP address in human-readable form (IPv4 or IPv6).
    pub address: String,
    /// CIDR prefix length.
    pub mask: u32,
    pub name: String,
    pub reason: String,
    /// Unix timestamp when the ban was created.
    pub start_time: i64,
    /// Duration in seconds. 0 = permanent.
    pub duration: u32,
    /// Whether the ban is currently active (not yet expired).
    pub active: bool,
}

/// Response for ban list endpoint.
#[derive(Serialize)]
pub struct BanListResponse {
    pub bans: Vec<BanEntry>,
    pub timestamp: u64,
}

/// Response for unban endpoint.
#[derive(Serialize)]
pub struct UnbanResponse {
    pub success: bool,
    pub message: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hub_api_endpoints(api_key_configured: bool) -> Vec<ApiEndpointInfo> {
    let mut endpoints = Vec::new();

    macro_rules! push_endpoint {
        ($endpoints:ident, $method:literal, $path:literal, $summary:literal, $access:expr, $handler:expr) => {
            $endpoints.push(ApiEndpointInfo {
                method: $method,
                path: $path,
                summary: $summary,
                access: $access.describe(api_key_configured),
            });
        };
    }

    for_each_hub_route!(push_endpoint, endpoints);
    endpoints
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn handle_status(State(state): State<AppState>) -> Json<StatusResponse> {
    let edge_count = state.edge_connections.read().await.len();
    let session_count = state.session_manager.count_sessions().await;
    let uptime_secs = state.started_at.elapsed().as_secs();

    Json(StatusResponse {
        status: "running",
        version: env!("CARGO_PKG_VERSION"),
        uptime_secs,
        timestamp: now_secs(),
        edge_count,
        session_count,
    })
}

async fn handle_edges(State(state): State<AppState>) -> Json<Vec<EdgeSummary>> {
    let health_map = state.edge_health.read().await;
    let edge_reg = state.edge_registry.read().await;

    let mut result = Vec::new();

    for (edge_id, reg) in edge_reg.iter() {
        let health = health_map.get(edge_id);
        let is_online = health.is_some();
        let last_heartbeat_secs = health
            .map(|h| h.last_heartbeat.elapsed().as_secs())
            .unwrap_or(u64::MAX);
        let session_count = health.map(|h| h.user_count).unwrap_or(0);

        result.push(EdgeSummary {
            id: *edge_id,
            name: reg.name.clone(),
            host: reg.host.clone(),
            port: reg.port,
            region: reg.region.clone(),
            capacity: reg.capacity,
            session_count,
            last_heartbeat_secs,
            is_online,
        });
    }

    Json(result)
}

async fn handle_edge_detail(
    State(state): State<AppState>,
    Path(edge_id): Path<u32>,
) -> Result<Json<EdgeDetail>, StatusCode> {
    let health_map = state.edge_health.read().await;
    let edge_reg = state.edge_registry.read().await;
    let topo = state.topology.read().await;

    let reg = match edge_reg.get(&edge_id) {
        Some(r) => r,
        None => return Err(StatusCode::NOT_FOUND),
    };

    let health = health_map.get(&edge_id);
    let is_online = health.is_some();
    let last_heartbeat_secs = health
        .map(|h| h.last_heartbeat.elapsed().as_secs())
        .unwrap_or(u64::MAX);

    let topo_edge = topo.get_edge(edge_id);
    let connected_peers: Vec<u32> = topo_edge
        .map(|e| e.connected_peers.iter().copied().collect())
        .unwrap_or_default();

    Ok(Json(EdgeDetail {
        id: edge_id,
        name: reg.name.clone(),
        host: reg.host.clone(),
        port: reg.port,
        region: reg.region.clone(),
        capacity: reg.capacity,
        session_count: health.map(|h| h.user_count).unwrap_or(0),
        channel_count: health.map(|h| h.channel_count).unwrap_or(0),
        uptime_secs: health.map(|h| h.uptime_seconds).unwrap_or(0),
        last_heartbeat_secs,
        is_online,
        connected_peer_ids: connected_peers,
    }))
}

async fn handle_stats(State(state): State<AppState>) -> Json<StatsResponse> {
    let total_sessions = state.session_manager.count_sessions().await;
    let total_channels = state.channel_store.count().await;
    let total_edges = state.edge_connections.read().await.len();

    Json(StatsResponse {
        total_sessions,
        total_channels,
        total_edges,
        timestamp: now_secs(),
    })
}

async fn handle_topology(State(state): State<AppState>) -> Json<TopologyResponse> {
    let health_map = state.edge_health.read().await;
    let edge_reg = state.edge_registry.read().await;
    let topo = state.topology.read().await;
    let now = std::time::Instant::now();

    let mut edges = Vec::new();
    for (edge_id, reg) in edge_reg.iter() {
        let health = health_map.get(edge_id);
        edges.push(EdgeSummary {
            id: *edge_id,
            name: reg.name.clone(),
            host: reg.host.clone(),
            port: reg.port,
            region: reg.region.clone(),
            capacity: reg.capacity,
            session_count: health.map(|h| h.user_count).unwrap_or(0),
            last_heartbeat_secs: health
                .map(|h| h.last_heartbeat.elapsed().as_secs())
                .unwrap_or(u64::MAX),
            is_online: health.is_some(),
        });
    }

    let mut links = Vec::new();
    for ((from, to), quality) in topo.get_link_qualities() {
        let last_update_secs = now.duration_since(quality.last_update).as_secs();
        links.push(TopologyLink {
            from_edge_id: *from,
            to_edge_id: *to,
            rtt_ms: quality.rtt_ms,
            packet_loss: quality.packet_loss,
            jitter_ms: quality.jitter_ms,
            samples: quality.samples,
            last_update_secs,
        });
    }

    Json(TopologyResponse {
        edges,
        links,
        timestamp: now_secs(),
    })
}

fn dissemination_source_info(plan: SourceDisseminationPlan) -> DisseminationSourceInfo {
    let mut active_children = plan.active_children;
    active_children.sort_unstable();

    let mut duplicate_children = plan.duplicate_children;
    duplicate_children.sort_unstable();

    let mut branch_backups: Vec<_> = plan
        .branch_backups
        .into_iter()
        .map(|(primary_child_edge_id, mut backup_next_hops)| {
            backup_next_hops.sort_unstable();
            DisseminationBranchBackupInfo {
                primary_child_edge_id,
                backup_next_hops,
            }
        })
        .collect();
    branch_backups.sort_by_key(|entry| entry.primary_child_edge_id);

    DisseminationSourceInfo {
        source_edge_id: plan.source_edge_id,
        active_children,
        duplicate_children,
        branch_backups,
    }
}

fn dissemination_edge_info(
    edge_id: u32,
    name: String,
    plans: Vec<SourceDisseminationPlan>,
) -> EdgeDisseminationInfo {
    let mut sources: Vec<_> = plans.into_iter().map(dissemination_source_info).collect();
    sources.sort_by_key(|entry| entry.source_edge_id);

    EdgeDisseminationInfo {
        edge_id,
        name,
        source_count: sources.len(),
        sources,
    }
}

async fn collect_dissemination_views(state: &AppState) -> Vec<EdgeDisseminationInfo> {
    let edge_reg = state.edge_registry.read().await;
    let topo = state.topology.read().await;

    let mut edge_ids: Vec<u32> = edge_reg.keys().copied().collect();
    edge_ids.sort_unstable();

    edge_ids
        .into_iter()
        .map(|edge_id| {
            let name = edge_reg
                .get(&edge_id)
                .map(|entry| entry.name.clone())
                .unwrap_or_else(|| format!("Edge {}", edge_id));
            let plans = topo.compute_dissemination_plan(edge_id, &state.config.voice_routing);
            dissemination_edge_info(edge_id, name, plans)
        })
        .collect()
}

async fn handle_dissemination(State(state): State<AppState>) -> Json<DisseminationResponse> {
    let edges = collect_dissemination_views(&state).await;
    Json(DisseminationResponse {
        edges,
        timestamp: now_secs(),
    })
}

async fn handle_dissemination_by_edge(
    State(state): State<AppState>,
    Path(edge_id): Path<u32>,
) -> Result<Json<EdgeDisseminationInfo>, StatusCode> {
    collect_dissemination_views(&state)
        .await
        .into_iter()
        .find(|entry| entry.edge_id == edge_id)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn handle_health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn handle_endpoints(State(state): State<AppState>) -> Json<ApiEndpointListResponse> {
    let endpoints = hub_api_endpoints(
        state
            .config
            .web_api
            .api_key
            .as_deref()
            .is_some_and(|key| !key.is_empty()),
    );

    Json(ApiEndpointListResponse {
        service: "hub",
        total: endpoints.len(),
        endpoints,
        timestamp: now_secs(),
    })
}

/// `GET /api/clients` — return all active client sessions across all Edges.
async fn handle_clients(State(state): State<AppState>) -> Json<HubClientListResponse> {
    let all = state.session_manager.get_all_sessions().await;
    let clients = all
        .into_iter()
        .map(|s| HubClientEntry {
            session_id: s.session_id,
            edge_id: s.edge_id,
            user_id: s.user_id,
            username: s.username,
            channel_id: s.channel_id,
            mute: s.mute,
            deaf: s.deaf,
            suppress: s.suppress,
            self_mute: s.self_mute,
            self_deaf: s.self_deaf,
            priority_speaker: s.priority_speaker,
            recording: s.recording,
            listening_channels: s.listening_channels,
        })
        .collect();
    Json(HubClientListResponse {
        clients,
        timestamp: now_secs(),
    })
}

// ── Voice Targets ─────────────────────────────────────────────────────────────

/// Convert a stored `VoiceTargetEntry` into the API response type.
fn entry_to_info(e: &crate::server::VoiceTargetEntry) -> VoiceTargetInfo {
    let config = e.config.as_ref().map(|c| VoiceTargetConfigInfo {
        sessions: c.sessions.iter().map(|s| s.session).collect(),
        channels: c
            .channels
            .iter()
            .map(|ch| VoiceTargetChannelInfo {
                channel_id: ch.channel_id,
                children: ch.children.unwrap_or(false),
                links: ch.links.unwrap_or(false),
                group: ch.group.clone(),
            })
            .collect(),
    });
    VoiceTargetInfo {
        edge_id: e.edge_id,
        client_session: e.client_session,
        target_id: e.target_id,
        config,
        timestamp_ms: e.timestamp,
    }
}

/// `GET /api/voice_targets` — return all whisper-target entries in the cluster.
async fn handle_voice_targets(State(state): State<AppState>) -> Json<VoiceTargetListResponse> {
    let map = state.voice_targets.read().await;
    let mut voice_targets: Vec<VoiceTargetInfo> = map.values().map(entry_to_info).collect();
    // Stable order: sort by (client_session, target_id).
    voice_targets.sort_by_key(|v| (v.client_session, v.target_id));
    Json(VoiceTargetListResponse {
        voice_targets,
        timestamp: now_secs(),
    })
}

/// `GET /api/voice_targets/session/:session_id` — return whisper targets for one session.
async fn handle_voice_targets_by_session(
    State(state): State<AppState>,
    Path(session_id): Path<u32>,
) -> impl IntoResponse {
    let map = state.voice_targets.read().await;
    let mut voice_targets: Vec<VoiceTargetInfo> = map
        .iter()
        .filter(|((client_session, _), _)| *client_session == session_id)
        .map(|(_, e)| entry_to_info(e))
        .collect();
    voice_targets.sort_by_key(|v| v.target_id);
    (
        StatusCode::OK,
        Json(VoiceTargetListResponse {
            voice_targets,
            timestamp: now_secs(),
        }),
    )
        .into_response()
}

/// Helper: convert raw IPv4-mapped-IPv6 bytes to a human-readable string.
fn bytes_to_ip_string(bytes: &[u8; 16]) -> String {
    // Check for IPv4-mapped IPv6 (::ffff:a.b.c.d)
    if bytes[..10] == [0u8; 10] && bytes[10] == 0xff && bytes[11] == 0xff {
        return format!("{}.{}.{}.{}", bytes[12], bytes[13], bytes[14], bytes[15]);
    }
    // Check for pure IPv4 in first 4 bytes (older storage format)
    if bytes[4..] == [0u8; 12] {
        return format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]);
    }
    // Full IPv6
    let octets: [u8; 16] = *bytes;
    let v6 = std::net::Ipv6Addr::from(octets);
    v6.to_string()
}

async fn handle_bans(State(state): State<AppState>) -> impl IntoResponse {
    let bans = state.ban_store.get_all();
    let now = now_secs() as i64;
    let entries: Vec<BanEntry> = bans
        .into_iter()
        .map(|b| {
            let active = if b.duration > 0 {
                now < b.start_time.saturating_add(b.duration as i64)
            } else {
                true // Permanent ban
            };
            BanEntry {
                id: b.id,
                address: bytes_to_ip_string(&b.address),
                mask: b.mask,
                name: b.name,
                reason: b.reason,
                start_time: b.start_time,
                duration: b.duration,
                active,
            }
        })
        .collect();
    (
        StatusCode::OK,
        Json(BanListResponse {
            bans: entries,
            timestamp: now_secs(),
        }),
    )
        .into_response()
}

async fn handle_unban(State(state): State<AppState>, Path(ban_id): Path<i64>) -> impl IntoResponse {
    match state.ban_store.delete_by_id(ban_id).await {
        Ok(true) => {
            info!("Ban {} removed via Web API", ban_id);
            (
                StatusCode::OK,
                Json(UnbanResponse {
                    success: true,
                    message: format!("Ban {} removed", ban_id),
                }),
            )
                .into_response()
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(UnbanResponse {
                success: false,
                message: format!("Ban {} not found", ban_id),
            }),
        )
            .into_response(),
        Err(e) => {
            error!("Failed to remove ban {}: {}", ban_id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UnbanResponse {
                    success: false,
                    message: format!("Internal error: {}", e),
                }),
            )
                .into_response()
        }
    }
}

// ── Prometheus Metrics ────────────────────────────────────────────────────────

/// Plain-text Prometheus metrics response.
///
/// Exports the following metrics:
///
/// | Name | Type | Description |
/// |------|------|-------------|
/// Escape a string for use as a Prometheus label value.
///
/// Prometheus label values may not contain unescaped backslashes, double quotes,
/// or newlines.  See the Prometheus data model exposition format specification.
fn prometheus_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

/// | `munode_hub_connected_edges` | gauge | Number of currently connected Edge nodes |
/// | `munode_hub_total_sessions` | gauge | Total user sessions across all Edges |
/// | `munode_hub_total_channels` | gauge | Total channels in the channel store |
/// | `munode_hub_uptime_seconds` | gauge | Hub server uptime in seconds |
async fn handle_metrics(State(state): State<AppState>) -> Response {
    let uptime = state.started_at.elapsed().as_secs();

    // Gather edge + session stats
    let edge_regs = state.edge_registry.read().await;
    let health_map = state.edge_health.read().await;
    let heartbeat_timeout = state.config.registry.heartbeat_timeout;
    let online_threshold = std::time::Duration::from_millis(heartbeat_timeout + 10_000);

    // Per-Edge snapshot: (id, name, is_online, user_count, channel_count, uptime_secs)
    struct EdgeSnapshot {
        id: u32,
        name: String,
        is_online: bool,
        user_count: u32,
        channel_count: u32,
        uptime_secs: u64,
    }
    let mut edge_snapshots: Vec<EdgeSnapshot> = edge_regs
        .iter()
        .map(|(id, reg)| {
            let health = health_map.get(id);
            let is_online = health
                .map(|h| h.last_heartbeat.elapsed() <= online_threshold)
                .unwrap_or(false);
            EdgeSnapshot {
                id: *id,
                name: reg.name.clone(),
                is_online,
                user_count: health.map(|h| h.user_count).unwrap_or(0),
                channel_count: health.map(|h| h.channel_count).unwrap_or(0),
                uptime_secs: health.map(|h| h.uptime_seconds).unwrap_or(0),
            }
        })
        .collect();
    edge_snapshots.sort_by_key(|e| e.id);

    let connected_edges: usize = edge_snapshots.iter().filter(|e| e.is_online).count();
    let total_sessions: u32 = edge_snapshots.iter().map(|e| e.user_count).sum();
    let total_channels = state.channel_store.count().await;

    drop(edge_regs);
    drop(health_map);

    let mut buf = String::with_capacity(2048);

    // Helper macro to write a gauge metric in Prometheus text format
    macro_rules! gauge {
        ($name:expr, $help:expr, $value:expr) => {
            buf.push_str(&format!(
                "# HELP {} {}\n# TYPE {} gauge\n{} {}\n",
                $name, $help, $name, $name, $value
            ));
        };
    }

    gauge!(
        "munode_hub_connected_edges",
        "Number of currently connected Edge nodes",
        connected_edges
    );
    gauge!(
        "munode_hub_total_sessions",
        "Total user sessions across all Edges",
        total_sessions
    );
    gauge!(
        "munode_hub_total_channels",
        "Total channels in the channel store",
        total_channels
    );
    gauge!(
        "munode_hub_uptime_seconds",
        "Hub server uptime in seconds",
        uptime
    );

    // Per-Edge metrics with labels
    if !edge_snapshots.is_empty() {
        // edge_user_count
        buf.push_str(
            "# HELP munode_hub_edge_user_count User session count per Edge node\n\
             # TYPE munode_hub_edge_user_count gauge\n",
        );
        for e in &edge_snapshots {
            let safe_name = prometheus_escape(&e.name);
            buf.push_str(&format!(
                "munode_hub_edge_user_count{{edge_id=\"{}\",edge_name=\"{}\"}} {}\n",
                e.id, safe_name, e.user_count
            ));
        }

        // edge_channel_count
        buf.push_str(
            "# HELP munode_hub_edge_channel_count Channel count reported by each Edge node\n\
             # TYPE munode_hub_edge_channel_count gauge\n",
        );
        for e in &edge_snapshots {
            let safe_name = prometheus_escape(&e.name);
            buf.push_str(&format!(
                "munode_hub_edge_channel_count{{edge_id=\"{}\",edge_name=\"{}\"}} {}\n",
                e.id, safe_name, e.channel_count
            ));
        }

        // edge_online
        buf.push_str(
            "# HELP munode_hub_edge_online Whether the Edge node is currently considered online (1=yes, 0=no)\n\
             # TYPE munode_hub_edge_online gauge\n",
        );
        for e in &edge_snapshots {
            let safe_name = prometheus_escape(&e.name);
            buf.push_str(&format!(
                "munode_hub_edge_online{{edge_id=\"{}\",edge_name=\"{}\"}} {}\n",
                e.id,
                safe_name,
                if e.is_online { 1 } else { 0 }
            ));
        }

        // edge_uptime_seconds
        buf.push_str(
            "# HELP munode_hub_edge_uptime_seconds Uptime of each Edge node in seconds\n\
             # TYPE munode_hub_edge_uptime_seconds gauge\n",
        );
        for e in &edge_snapshots {
            let safe_name = prometheus_escape(&e.name);
            buf.push_str(&format!(
                "munode_hub_edge_uptime_seconds{{edge_id=\"{}\",edge_name=\"{}\"}} {}\n",
                e.id, safe_name, e.uptime_secs
            ));
        }
    }

    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        buf,
    )
        .into_response()
}

// ── Router ────────────────────────────────────────────────────────────────────

/// Build the axum router for the Web API.
pub fn build_router(state: Arc<HubState>) -> Router {
    let mut router = Router::new();

    macro_rules! add_route {
        ($router:ident, $method:literal, $path:literal, $summary:literal, $access:expr, $handler:expr) => {
            $router = $router.route($path, $handler);
        };
    }

    for_each_hub_route!(add_route, router);

    router
        .layer(middleware::from_fn_with_state(
            state.clone(),
            api_key_middleware,
        ))
        .with_state(state)
}

/// Start the Web API HTTP server.
///
/// Listens on `host:port` and runs until the process is shut down.
/// Returns an error if binding fails so the caller can decide whether to abort.
pub async fn run_web_api(host: &str, port: u16, state: Arc<HubState>) -> anyhow::Result<()> {
    let addr = format!("{}:{}", host, port);
    let router = build_router(state);

    info!("Hub Web API listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to bind Web API on {}: {}", addr, e))?;

    axum::serve(listener, router)
        .await
        .map_err(|e| anyhow::anyhow!("Web API server error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::hub_api_endpoints;

    #[test]
    fn hub_api_endpoints_include_discovery_and_metrics_routes() {
        let endpoints = hub_api_endpoints(false);

        assert!(endpoints.iter().any(|endpoint| {
            endpoint.method == "GET"
                && endpoint.path == "/api/endpoints"
                && endpoint.access == "public"
        }));
        assert!(endpoints.iter().any(|endpoint| {
            endpoint.method == "GET"
                && endpoint.path == "/metrics"
                && endpoint.summary == "Prometheus metrics endpoint"
        }));
    }

    #[test]
    fn hub_api_endpoints_reflect_write_auth_mode() {
        let protected = hub_api_endpoints(true);
        let protected_delete = protected
            .iter()
            .find(|endpoint| endpoint.method == "DELETE" && endpoint.path == "/api/bans/:id")
            .expect("missing DELETE /api/bans/:id");
        assert_eq!(protected_delete.access, "bearer_api_key");

        let disabled = hub_api_endpoints(false);
        let disabled_delete = disabled
            .iter()
            .find(|endpoint| endpoint.method == "DELETE" && endpoint.path == "/api/bans/:id")
            .expect("missing DELETE /api/bans/:id");
        assert_eq!(disabled_delete.access, "disabled_without_api_key");
    }
}
