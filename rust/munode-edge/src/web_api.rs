//! Edge Web API — HTTP REST endpoints for monitoring local client sessions.
//!
//! Endpoints:
//!   GET /api/clients         — List all locally-connected (local) client sessions
//!   GET /api/remote_clients  — List all remote client sessions (users on peer Edges)
//!   GET /api/all_clients     — List local + remote clients (with `is_local` flag)
//!   GET /api/health          — Liveness probe (always 200 OK)

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

/// A single remote client entry (user on a peer Edge).
#[derive(Serialize)]
pub struct RemoteClientEntry {
    pub session: u32,
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

/// A unified client entry with `is_local` flag, used by `/api/all_clients`.
#[derive(Serialize)]
pub struct AnyClientEntry {
    pub session: u32,
    /// The Edge this user is connected to. Equals this Edge's own ID for local users.
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
    /// `true` if the user is directly connected to this Edge, `false` if on a peer Edge.
    pub is_local: bool,
    // Extra fields only present for local users (omitted / null for remote).
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
}

/// Response for the client list endpoint.
#[derive(Serialize)]
pub struct ClientListResponse {
    pub clients: Vec<ClientEntry>,
    pub timestamp: u64,
}

/// Response for the remote client list endpoint.
#[derive(Serialize)]
pub struct RemoteClientListResponse {
    pub clients: Vec<RemoteClientEntry>,
    pub timestamp: u64,
}

/// Response for the combined all-clients endpoint.
#[derive(Serialize)]
pub struct AllClientListResponse {
    pub clients: Vec<AnyClientEntry>,
    /// Total number of clients across local + remote.
    pub total: usize,
    /// Number of clients directly connected to this Edge.
    pub local_count: usize,
    /// Number of clients connected to peer Edges.
    pub remote_count: usize,
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

/// `GET /api/remote_clients` — list remote users synced from peer Edges.
async fn handle_remote_clients(State(state): State<AppState>) -> Json<RemoteClientListResponse> {
    let all = state.channel_manager.get_all_remote_users().await;
    let clients = all
        .into_iter()
        .map(|u| RemoteClientEntry {
            session: u.session_id,
            edge_id: u.edge_id,
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
        })
        .collect();
    Json(RemoteClientListResponse {
        clients,
        timestamp: now_secs(),
    })
}

/// `GET /api/all_clients` — list local + remote clients with `is_local` flag.
async fn handle_all_clients(State(state): State<AppState>) -> Json<AllClientListResponse> {
    let local_all = state.client_manager.get_all_clients().await;
    let remote_all = state.channel_manager.get_all_remote_users().await;

    let local_count = local_all.len();
    let remote_count = remote_all.len();

    let my_edge_id = state.get_edge_id();

    let mut clients: Vec<AnyClientEntry> = local_all
        .into_iter()
        .map(|c| AnyClientEntry {
            session: c.session,
            edge_id: my_edge_id,
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
            is_local: true,
            ip_address: Some(c.ip_address),
            opus_supported: Some(c.opus_supported),
            client_version: c.client_version,
            client_release: Some(c.client_release),
            client_os: Some(c.client_os),
        })
        .collect();

    for u in remote_all {
        clients.push(AnyClientEntry {
            session: u.session_id,
            edge_id: u.edge_id,
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
            is_local: false,
            ip_address: None,
            opus_supported: None,
            client_version: None,
            client_release: None,
            client_os: None,
        });
    }

    let total = clients.len();
    Json(AllClientListResponse {
        clients,
        total,
        local_count,
        remote_count,
        timestamp: now_secs(),
    })
}

/// Build the axum router for the Edge Web API.
pub fn build_router(state: Arc<EdgeState>) -> Router {
    Router::new()
        .route("/api/clients", get(handle_clients))
        .route("/api/remote_clients", get(handle_remote_clients))
        .route("/api/all_clients", get(handle_all_clients))
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
