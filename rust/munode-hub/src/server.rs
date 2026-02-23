use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use prost::Message;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tracing::{error, info};

use munode_common::config::HubConfig;
use munode_protocol::hubedge::*;

use crate::acl_manager::AclManager;
use crate::channel_store::ChannelStore;
use crate::database::Database;
use crate::edge_connection::EdgeConnection;
use crate::rpc_handler::{EdgeSender, RpcHandler};
use crate::session_manager::SessionManager;

/// Shared state for the hub server, accessible by all edge connections.
pub struct HubState {
    pub config: HubConfig,
    pub session_manager: SessionManager,
    pub channel_store: Arc<ChannelStore>,
    pub database: Arc<Database>,
    pub acl_manager: AclManager,
    pub edge_connections: RwLock<HashMap<u32, EdgeSender>>,
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
        let state = Arc::new(HubState {
            config: self.config.clone(),
            session_manager: SessionManager::new(),
            channel_store: channel_store.clone(),
            acl_manager: AclManager::new(database.clone(), channel_store.clone()),
            database,
            edge_connections: RwLock::new(HashMap::new()),
        });

        // Load channels from database
        state.channel_store.load_from_db(&state.database).await?;

        // Create RPC handler
        let rpc_handler = Arc::new(RpcHandler::new(state.clone()));

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
