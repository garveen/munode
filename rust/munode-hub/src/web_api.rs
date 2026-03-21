//! Hub Web API — HTTP REST endpoints for monitoring and management.
//!
//! Endpoints:
//!   GET /api/status                         — Hub server status (uptime, version, …)
//!   GET /api/edges                          — Connected Edge list with health summary
//!   GET /api/edges/:id                      — Specific Edge details
//!   GET /api/stats                          — Hub statistics (sessions, channels, …)
//!   GET /api/topology                       — Network topology (edges and links)
//!   GET /api/health                         — Liveness probe (always 200 OK)
//!   GET /api/bans                           — List active ban records
//!   DELETE /api/bans/:id                    — Remove a ban record (manual unban)
//!   GET /api/voice_targets                  — All voice (whisper) targets in the cluster
//!   GET /api/voice_targets/session/:id      — Voice targets for a specific client session
//!   GET /metrics                            — Prometheus metrics endpoint

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Path, State},
    http::{Method, Request, StatusCode},
    http::header,
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{delete, get},
    Router,
};
use serde::Serialize;
use tracing::{error, info};

use crate::server::HubState;

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
            (StatusCode::FORBIDDEN, "API key not configured; write operations are disabled")
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
                (StatusCode::UNAUTHORIZED, "Invalid or missing API key").into_response()
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

/// Health check response.
#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
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

async fn handle_health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

// ── Voice Targets ─────────────────────────────────────────────────────────────

/// Convert a stored `VoiceTargetEntry` into the API response type.
fn entry_to_info(e: &crate::server::VoiceTargetEntry) -> VoiceTargetInfo {
    let config = e.config.as_ref().map(|c| VoiceTargetConfigInfo {
        sessions: c.sessions.iter().map(|s| s.session).collect(),
        channels: c.channels.iter().map(|ch| VoiceTargetChannelInfo {
            channel_id: ch.channel_id,
            children: ch.children.unwrap_or(false),
            links: ch.links.unwrap_or(false),
            group: ch.group.clone(),
        }).collect(),
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

async fn handle_unban(
    State(state): State<AppState>,
    Path(ban_id): Path<i64>,
) -> impl IntoResponse {
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
                e.id, safe_name, if e.is_online { 1 } else { 0 }
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
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        buf,
    )
        .into_response()
}

// ── Router ────────────────────────────────────────────────────────────────────

/// Build the axum router for the Web API.
pub fn build_router(state: Arc<HubState>) -> Router {
    Router::new()
        .route("/api/status", get(handle_status))
        .route("/api/edges", get(handle_edges))
        .route("/api/edges/:id", get(handle_edge_detail))
        .route("/api/stats", get(handle_stats))
        .route("/api/topology", get(handle_topology))
        .route("/api/health", get(handle_health))
        .route("/api/bans", get(handle_bans))
        .route("/api/bans/:id", delete(handle_unban))
        .route("/api/voice_targets", get(handle_voice_targets))
        .route("/api/voice_targets/session/:id", get(handle_voice_targets_by_session))
        .route("/metrics", get(handle_metrics))
        .layer(middleware::from_fn_with_state(state.clone(), api_key_middleware))
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

