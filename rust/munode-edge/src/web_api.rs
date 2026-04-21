//! Edge Web API — HTTP REST endpoints for monitoring local client sessions.
//!
//! Endpoints:
//!   GET /api/clients   — List all locally-connected client sessions
//!   GET /api/health    — Liveness probe (always 200 OK)

use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use axum::{
    extract::State,
    response::Json,
    routing::get,
    Router,
};
use serde::Serialize;
use tracing::info;

use crate::state::EdgeState;

type AppState = Arc<EdgeState>;

/// A single client entry as returned by the Web API.
#[derive(Serialize)]
pub struct ClientEntry {
    pub session: u32,
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
    pub ip_address: String,
    pub opus_supported: bool,
    pub client_version: Option<u32>,
    pub client_release: String,
    pub client_os: String,
    pub listening_channels: Vec<u32>,
}

/// Response for the client list endpoint.
#[derive(Serialize)]
pub struct ClientListResponse {
    pub clients: Vec<ClientEntry>,
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

/// `GET /api/clients` — list all locally-connected client sessions.
async fn handle_clients(State(state): State<AppState>) -> Json<ClientListResponse> {
    let all = state.client_manager.get_all_clients().await;
    let clients = all
        .into_iter()
        .map(|c| ClientEntry {
            session: c.session,
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
            ip_address: c.ip_address,
            opus_supported: c.opus_supported,
            client_version: c.client_version,
            client_release: c.client_release,
            client_os: c.client_os,
            listening_channels: c.listening_channels,
        })
        .collect();
    Json(ClientListResponse {
        clients,
        timestamp: now_secs(),
    })
}

async fn handle_health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

/// Build the axum router for the Edge Web API.
pub fn build_router(state: Arc<EdgeState>) -> Router {
    Router::new()
        .route("/api/clients", get(handle_clients))
        .route("/api/health", get(handle_health))
        .with_state(state)
}

/// Start the Edge Web API HTTP server.
pub async fn run_web_api(host: &str, port: u16, state: Arc<EdgeState>) -> anyhow::Result<()> {
    let addr = format!("{}:{}", host, port);
    let router = build_router(state);

    info!("Edge Web API listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to bind Edge Web API on {}: {}", addr, e))?;

    axum::serve(listener, router)
        .await
        .map_err(|e| anyhow::anyhow!("Edge Web API server error: {}", e))
}
