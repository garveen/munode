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
use crate::channel_store::ChannelStore;
use crate::database::Database;
use crate::edge_connection::EdgeConnection;
use crate::rpc_handler::{EdgeSender, RpcHandler};
use crate::session_manager::SessionManager;
use crate::topology_manager::TopologyManager;
use crate::auth_service::{AuthServiceHandle, run_auth_service_listener};
use crate::lua_auth::LuaAuthEngine;

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

/// Shared state for the hub server, accessible by all edge connections.
pub struct HubState {
    pub config: HubConfig,
    pub session_manager: SessionManager,
    pub channel_store: Arc<ChannelStore>,
    pub database: Arc<Database>,
    pub acl_manager: AclManager,
    pub edge_connections: RwLock<HashMap<u32, EdgeSender>>,
    /// Health records for each connected Edge, keyed by edge server_id.
    pub edge_health: RwLock<HashMap<u32, EdgeHealth>>,
    /// Cluster topology manager.
    pub topology: RwLock<TopologyManager>,
    /// External auth service handle.
    pub auth_service: AuthServiceHandle,
    /// Embedded Lua authentication engine (present when `auth.lua_script` is set).
    pub lua_engine: Option<Arc<LuaAuthEngine>>,
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

        let state = Arc::new(HubState {
            config: self.config.clone(),
            session_manager: SessionManager::new(),
            channel_store: channel_store.clone(),
            acl_manager: AclManager::new(database.clone(), channel_store.clone()),
            database,
            edge_connections: RwLock::new(HashMap::new()),
            edge_health: RwLock::new(HashMap::new()),
            topology: RwLock::new(TopologyManager::new()),
            auth_service: auth_service.clone(),
            lua_engine,
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
