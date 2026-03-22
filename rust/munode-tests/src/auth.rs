//! Lightweight HTTP authentication server for integration tests.
//!
//! Authenticates users based on the `TEST_USERS` table — mirrors the
//! TypeScript `TestAuthServer` in `tests/integration/setup.ts`.

use std::net::SocketAddr;

use axum::{
    Json, Router,
    http::StatusCode,
    routing::{get, post},
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

use crate::users::find_user;

// ── Auth request / response types ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AuthRequest {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub tokens: Vec<String>,
    #[serde(default)]
    pub server_id: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ── Handler ────────────────────────────────────────────────────────────────

async fn auth_handler(Json(req): Json<AuthRequest>) -> (StatusCode, Json<AuthResponse>) {
    match find_user(&req.username) {
        Some(user) if user.password == req.password => {
            let resp = AuthResponse {
                success: true,
                user_id: Some(user.user_id),
                username: Some(user.username.to_string()),
                display_name: Some(user.username.to_string()),
                groups: Some(user.groups.iter().map(|s| s.to_string()).collect()),
                reason: None,
            };
            (StatusCode::OK, Json(resp))
        }
        _ => {
            let resp = AuthResponse {
                success: false,
                user_id: None,
                username: None,
                display_name: None,
                groups: None,
                reason: Some("Invalid credentials".to_string()),
            };
            (StatusCode::UNAUTHORIZED, Json(resp))
        }
    }
}

async fn health_handler() -> StatusCode {
    StatusCode::OK
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Start the test auth server on the given port.
///
/// Returns the `SocketAddr` the server bound to and a handle that shuts it
/// down when dropped.
pub async fn start_auth_server(port: u16) -> Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let app = Router::new()
        .route("/auth", post(auth_handler))
        .route("/health", get(health_handler));

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port)).await?;
    let addr = listener.local_addr()?;

    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    Ok((addr, handle))
}
