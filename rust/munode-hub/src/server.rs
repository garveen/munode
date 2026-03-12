use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use prost::Message;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use munode_common::config::HubConfig;
use munode_protocol::hubedge::*;

use crate::acl_manager::AclManager;
use crate::blob_store::BlobStore;
use crate::channel_store::ChannelStore;
use crate::database::Database;
use crate::edge_connection::EdgeConnection;
use crate::rpc_handler::{EdgeSender, RpcHandler};
use crate::session_manager::SessionManager;
use crate::topology_manager::TopologyManager;
use crate::auth_service::{AuthServiceHandle, run_auth_service_listener};
use crate::lua_auth::LuaAuthEngine;

/// Information about a registered edge server (keyed by server_id in HubState).
#[derive(Debug, Clone)]
pub struct EdgeRegistration {
    pub server_id: u32,
    /// Human-readable server name.
    pub name: String,
    /// Hostname or IP for Edge-to-Edge connections.
    pub host: String,
    /// Mumble client port.
    pub port: u32,
    /// Maximum number of concurrent users this edge supports.
    pub capacity: u32,
    /// Optional geographic region tag (e.g. "us-east", "eu-west").
    pub region: Option<String>,
    /// Optional proxy server port for peer control relay.
    /// When non-zero, this Edge accepts proxy WebSocket connections from peers.
    pub proxy_port: Option<u32>,
}

/// Health data for a connected Edge server.
#[derive(Debug, Clone)]
pub struct EdgeHealth {
    pub last_heartbeat: Instant,
    pub user_count: u32,
    pub channel_count: u32,
    pub uptime_seconds: u64,
}

impl EdgeHealth {
    pub fn new() -> Self {
        Self {
            last_heartbeat: Instant::now(),
            user_count: 0,
            channel_count: 0,
            uptime_seconds: 0,
        }
    }
}

/// Tracks failed auth attempts per IP for auto-ban.
#[derive(Debug, Default)]
pub struct FailedAuthTracker {
    /// IP address -> list of timestamps of failed attempts (within the configured window).
    attempts: HashMap<String, Vec<Instant>>,
}

impl FailedAuthTracker {
    /// Record a failed auth attempt from `ip`. Returns the current number of failed
    /// attempts within the configured time window.
    pub fn record_failure(&mut self, ip: &str, window_secs: u64) -> u32 {
        let now = Instant::now();
        let window = Duration::from_secs(window_secs);
        let entry = self.attempts.entry(ip.to_string()).or_default();
        // Purge stale entries outside the window
        entry.retain(|t| now.duration_since(*t) < window);
        entry.push(now);
        entry.len() as u32
    }

    /// Clear the failure count for an IP (after a successful login or ban).
    pub fn clear(&mut self, ip: &str) {
        self.attempts.remove(ip);
    }

    /// Purge all stale entries across all IPs.
    pub fn purge_stale(&mut self, window_secs: u64) {
        let now = Instant::now();
        let window = Duration::from_secs(window_secs);
        self.attempts.retain(|_, attempts| {
            attempts.retain(|t| now.duration_since(*t) < window);
            !attempts.is_empty()
        });
    }
}

/// Shared state for the hub server, accessible by all edge connections.
pub struct HubState {
    pub config: HubConfig,
    pub session_manager: SessionManager,
    pub channel_store: Arc<ChannelStore>,
    pub database: Arc<Database>,
    pub acl_manager: AclManager,
    /// Filesystem-backed blob storage.
    pub blob_store: Arc<BlobStore>,
    pub edge_connections: RwLock<HashMap<u32, EdgeSender>>,
    /// Health records for each connected Edge, keyed by edge server_id.
    pub edge_health: RwLock<HashMap<u32, EdgeHealth>>,
    /// Cluster topology manager.
    pub topology: RwLock<TopologyManager>,
    /// Registered edge info keyed by server_id (updated on edge.register).
    pub edge_registry: RwLock<HashMap<u32, EdgeRegistration>>,
    /// External auth service handle.
    pub auth_service: AuthServiceHandle,
    /// Embedded Lua authentication engine (present when `auth.lua_script` is set).
    pub lua_engine: Option<Arc<LuaAuthEngine>>,
    /// Failed authentication attempt tracker (for auto-ban).
    pub failed_auth_tracker: RwLock<FailedAuthTracker>,
    /// GeoIP lookup service (optional, present when `geoip.database_path` is set).
    pub geoip: Arc<crate::geoip::GeoIpService>,
    /// Server start time for uptime calculation.
    pub started_at: std::time::Instant,
}

/// The main Hub server.
pub struct HubServer {
    config: HubConfig,
}

impl HubServer {
    pub fn new(config: HubConfig) -> Self {
        Self { config }
    }

    /// Start the Hub server and listen for edge connections.
    pub async fn run(&self) -> Result<()> {
        // Open database
        let database = Arc::new(Database::open(&self.config.database.path)
            .context("Failed to open database")?);

        let channel_store = Arc::new(ChannelStore::new());

        // Open filesystem blob store
        let blob_store = Arc::new(BlobStore::open(&self.config.blob_store.path)
            .context("Failed to open blob store")?);

        // Create shared state
        let auth_service = AuthServiceHandle::new();

        // Initialise Lua auth engine if a script is configured.
        let lua_engine = if let Some(ref script) = self.config.auth.lua_script {
            match LuaAuthEngine::new(script) {
                Ok(engine) => {
                    info!("Lua auth engine initialised");
                    Some(Arc::new(engine))
                }
                Err(e) => {
                    return Err(e.context("Failed to initialise Lua auth engine"));
                }
            }
        } else {
            None
        };

        // Initialise GeoIP service (optional)
        let geoip = Arc::new(crate::geoip::GeoIpService::new(&self.config.geoip.database_path));
        if geoip.is_available() {
            info!("GeoIP service initialised from '{}'", &self.config.geoip.database_path);
        }

        let state = Arc::new(HubState {
            config: self.config.clone(),
            session_manager: SessionManager::new(),
            channel_store: channel_store.clone(),
            acl_manager: AclManager::new(database.clone(), channel_store.clone()),
            database,
            blob_store,
            edge_connections: RwLock::new(HashMap::new()),
            edge_health: RwLock::new(HashMap::new()),
            topology: RwLock::new(TopologyManager::new()),
            edge_registry: RwLock::new(HashMap::new()),
            auth_service: auth_service.clone(),
            lua_engine,
            failed_auth_tracker: RwLock::new(FailedAuthTracker::default()),
            geoip,
            started_at: std::time::Instant::now(),
        });

        // Load channels from database
        state.channel_store.load_from_db(&state.database).await?;

        // Create RPC handler
        let rpc_handler = Arc::new(RpcHandler::new(state.clone()));

        // Start auth service WS listener if port is configured
        if let Some(auth_port) = self.config.network.auth_service_port {
            let auth_addr = format!("{}:{}", self.config.network.host, auth_port);
            let auth_handle = auth_service.clone();
            tokio::spawn(async move {
                if let Err(e) = run_auth_service_listener(auth_addr, auth_handle).await {
                    error!("Auth service listener error: {}", e);
                }
            });
        }

        // Start Edge health check loop
        let health_state = state.clone();
        let health_rpc = rpc_handler.clone();
        let heartbeat_timeout = self.config.registry.heartbeat_timeout;
        tokio::spawn(async move {
            health_check_loop(health_state, health_rpc, heartbeat_timeout).await;
        });

        // Periodically clean up expired ban records (every 5 minutes)
        {
            let ban_db = state.database.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    match ban_db.cleanup_expired_bans() {
                        Ok(removed) if removed > 0 => {
                            tracing::info!("Cleaned up {} expired ban record(s)", removed);
                        }
                        Err(e) => {
                            tracing::warn!("Failed to clean up expired bans: {}", e);
                        }
                        _ => {}
                    }
                }
            });
        }

        // Start Web API if enabled
        if self.config.web_api.enabled {
            let web_state = state.clone();
            let web_host = self.config.web_api.host.clone();
            let web_port = self.config.web_api.port;
            tokio::spawn(async move {
                crate::web_api::run_web_api(&web_host, web_port, web_state).await;
            });
        }

        // Bind WebSocket listener
        let addr = format!(
            "{}:{}",
            self.config.network.host, self.config.network.control_port
        );
        let listener = TcpListener::bind(&addr)
            .await
            .context(format!("Failed to bind to {}", addr))?;

        info!("Hub server listening on ws://{}", addr);

        // Accept connections with graceful shutdown
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, addr)) => {
                            info!("Edge connecting from {}", addr);

                            let state = state.clone();
                            let rpc_handler = rpc_handler.clone();

                            tokio::spawn(async move {
                                match tokio_tungstenite::accept_async(stream).await {
                                    Ok(ws_stream) => {
                                        let mut conn = EdgeConnection::new(state, rpc_handler);
                                        if let Err(e) = conn.run(ws_stream, addr).await {
                                            error!("Edge connection error from {}: {}", addr, e);
                                        }
                                    }
                                    Err(e) => {
                                        error!("WebSocket handshake failed from {}: {}", addr, e);
                                    }
                                }
                            });
                        }
                        Err(e) => {
                            error!("Failed to accept connection: {}", e);
                        }
                    }
                }
                _ = tokio::signal::ctrl_c() => {
                    info!("Received Ctrl+C, shutting down Hub server...");
                    // Notify all edges
                    let edges = state.edge_connections.read().await;
                    for (edge_id, sender) in edges.iter() {
                        let notification = TypedRpcNotification {
                            method: "edge.forceDisconnect".to_string(),
                            timestamp: Some(current_millis() as i64),
                            force_disconnect: Some(HubForceDisconnectParams {
                                reason: "Hub server shutting down".to_string(),
                            }),
                            ..Default::default()
                        };
                        let packet = EdgeHubPacket {
                            r#type: PacketType::RpcNotification as i32,
                            rpc_notification: Some(notification),
                            ..Default::default()
                        };
                        let data = packet.encode_to_vec();
                        if let Err(e) = sender.send(data).await {
                            error!("Failed to notify edge {} of shutdown: {}", edge_id, e);
                        }
                    }
                    break;
                }
            }
        }

        info!("Hub server stopped");
        Ok(())
    }
}

/// Broadcast a packet to all connected edges.
pub async fn broadcast(state: &HubState, data: Vec<u8>) {
    let edges = state.edge_connections.read().await;
    for (edge_id, sender) in edges.iter() {
        if let Err(e) = sender.try_send(data.clone()) {
            tracing::warn!("Failed to broadcast to edge {}: {}", edge_id, e);
        }
    }
}

/// Send a packet to a specific edge.
pub async fn notify(state: &HubState, edge_id: u32, data: Vec<u8>) {
    let edges = state.edge_connections.read().await;
    if let Some(sender) = edges.get(&edge_id) {
        if let Err(e) = sender.try_send(data) {
            tracing::warn!("Failed to notify edge {}: {}", edge_id, e);
        }
    }
}

fn current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Periodically check Edge heartbeat health; clean up timed-out edges.
async fn health_check_loop(
    state: Arc<HubState>,
    rpc_handler: Arc<RpcHandler>,
    heartbeat_timeout_ms: u64,
) {
    let check_interval = Duration::from_millis(heartbeat_timeout_ms);
    let timeout = Duration::from_millis(heartbeat_timeout_ms * 2);

    loop {
        tokio::time::sleep(check_interval).await;

        let timed_out: Vec<u32> = {
            let health = state.edge_health.read().await;
            health
                .iter()
                .filter(|(_, h)| h.last_heartbeat.elapsed() > timeout)
                .map(|(id, _)| *id)
                .collect()
        };

        for edge_id in timed_out {
            warn!("Edge {} heartbeat timeout — cleaning up", edge_id);
            state.edge_connections.write().await.remove(&edge_id);
            state.edge_health.write().await.remove(&edge_id);
            rpc_handler.cleanup_edge(edge_id).await;
        }
    }
}
