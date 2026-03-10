//! Hub Web API — HTTP REST endpoints for monitoring and management.
//!
//! Endpoints:
//!   GET /api/status      — Hub server status (uptime, version, …)
//!   GET /api/edges       — Connected Edge list with health summary
//!   GET /api/edges/:id   — Specific Edge details
//!   GET /api/stats       — Hub statistics (sessions, channels, …)
//!   GET /api/topology    — Network topology (edges and links)
//!   GET /api/health      — Liveness probe (always 200 OK)

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use serde::Serialize;
use tracing::{error, info};

use crate::server::HubState;

/// Shared state passed to axum handlers.
type AppState = Arc<HubState>;

/// Hub status response.
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
    let topo = state.topology.read().await;

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
    // Hold topo lock through the end of this function for a consistent read snapshot
    drop(topo);

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
        .with_state(state)
}

/// Start the Web API HTTP server.
///
/// Listens on `host:port` and runs until the process is shut down.
pub async fn run_web_api(host: &str, port: u16, state: Arc<HubState>) {
    let addr = format!("{}:{}", host, port);
    let router = build_router(state);

    info!("Hub Web API listening on http://{}", addr);

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Failed to bind Web API on {}: {}", addr, e);
            return;
        }
    };

    if let Err(e) = axum::serve(listener, router).await {
        error!("Web API server error: {}", e);
    }
}

