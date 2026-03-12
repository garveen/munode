use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite;
use tracing::{debug, error, info, warn};

use munode_protocol::hubedge::*;

use crate::rpc_handler::RpcHandler;
use crate::server::{EdgeHealth, HubState};

/// Represents a single connected edge server.
pub struct EdgeConnection {
    state: Arc<HubState>,
    rpc_handler: Arc<RpcHandler>,
    /// The server_id once registered.
    server_id: Option<u32>,
}

impl EdgeConnection {
    pub fn new(state: Arc<HubState>, rpc_handler: Arc<RpcHandler>) -> Self {
        Self {
            state,
            rpc_handler,
            server_id: None,
        }
    }

    /// Run the connection loop for a WebSocket stream.
    pub async fn run(
        &mut self,
        ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        addr: std::net::SocketAddr,
    ) -> Result<()> {
        let (mut ws_write, mut ws_read) = ws_stream.split();

        // Channel for sending outgoing messages to this edge
        let (send_tx, mut send_rx) = mpsc::channel::<Vec<u8>>(256);

        // Writer task: forwards messages from send_rx to WebSocket
        let writer_handle = tokio::spawn(async move {
            while let Some(data) = send_rx.recv().await {
                if let Err(e) = ws_write
                    .send(tungstenite::Message::Binary(Bytes::from(data)))
                    .await
                {
                    error!("WebSocket write error for edge: {}", e);
                    break;
                }
            }
        });

        // Read loop
        loop {
            match ws_read.next().await {
                Some(Ok(msg)) => match msg {
                    tungstenite::Message::Binary(data) => {
                        if let Err(e) = self.handle_incoming(&data, &send_tx).await {
                            warn!("Error handling edge message from {}: {}", addr, e);
                        }
                    }
                    tungstenite::Message::Close(_) => {
                        info!("Edge {} sent close frame", addr);
                        break;
                    }
                    tungstenite::Message::Ping(data) => {
                        let pong = tungstenite::Message::Pong(data).into_data().to_vec();
                        let _ = send_tx.send(pong).await;
                    }
                    _ => {}
                },
                Some(Err(e)) => {
                    error!("WebSocket read error from edge {}: {}", addr, e);
                    break;
                }
                None => {
                    info!("WebSocket stream ended for edge {}", addr);
                    break;
                }
            }
        }

        writer_handle.abort();

        // Cleanup on disconnect
        if let Some(server_id) = self.server_id {
            self.state.edge_connections.write().await.remove(&server_id);
            self.state.edge_health.write().await.remove(&server_id);
            self.rpc_handler.cleanup_edge(server_id).await;
            info!("Edge {} (server_id={}) disconnected", addr, server_id);
        }

        Ok(())
    }

    /// Handle an incoming binary message from the edge.
    async fn handle_incoming(
        &mut self,
        data: &[u8],
        send_tx: &mpsc::Sender<Vec<u8>>,
    ) -> Result<()> {
        let packet = EdgeHubPacket::decode(data)
            .context("Failed to decode EdgeHubPacket")?;

        match PacketType::try_from(packet.r#type) {
            Ok(PacketType::RpcRequest) => {
                if let Some(request) = packet.rpc_request {
                    // Track server_id on registration
                    if request.method == "edge.register" {
                        if let Some(params) = &request.edge_register {
                            let sid = params.server_id;
                            self.server_id = Some(sid);
                            // Register sender channel so broadcast can reach this edge
                            self.state
                                .edge_connections
                                .write()
                                .await
                                .insert(sid, send_tx.clone());
                            // Initialise health record
                            self.state
                                .edge_health
                                .write()
                                .await
                                .insert(sid, EdgeHealth::new());
                        }
                    }

                    let edge_id = self.server_id.unwrap_or(0);
                    let response_data = self
                        .rpc_handler
                        .handle_request(request, edge_id)
                        .await?;
                    send_tx
                        .send(response_data)
                        .await
                        .context("Failed to send RPC response")?;

                    // After successful registration, send ninja config notification to the new edge
                    if edge_id != 0 && self.state.config.channel_ninja.enabled {
                        let ninja_channels = self.state.config.channel_ninja.ninja_channels.clone();
                        self.rpc_handler.send_notification_to_edge(edge_id, "hub.ninjaConfig", |n| {
                            let json = serde_json::json!({
                                "enabled": true,
                                "ninja_channels": ninja_channels
                            });
                            n.unknown_params_json = Some(json.to_string());
                        }).await;
                    }
                }
            }
            Ok(PacketType::RpcNotification) => {
                if let Some(notification) = packet.rpc_notification {
                    let edge_id = self.server_id.unwrap_or(0);
                    self.rpc_handler
                        .handle_notification(notification, edge_id)
                        .await;
                }
            }
            Ok(PacketType::Heartbeat) => {
                if let Some(heartbeat) = packet.heartbeat {
                    debug!(
                        "Heartbeat from edge {} (seq={})",
                        heartbeat.edge_id, heartbeat.sequence
                    );

                    // Update health record
                    let edge_id = heartbeat.edge_id;
                    let mut health_map = self.state.edge_health.write().await;
                    let health = health_map
                        .entry(edge_id)
                        .or_insert_with(EdgeHealth::new);
                    health.last_heartbeat = std::time::Instant::now();
                    if let Some(stats) = &heartbeat.stats {
                        health.user_count = stats.user_count;
                        health.channel_count = stats.channel_count;
                        health.uptime_seconds = stats.uptime_seconds.unwrap_or(0);
                    }
                    drop(health_map);

                    let ack = EdgeHubPacket {
                        r#type: PacketType::HeartbeatAck as i32,
                        heartbeat_ack: Some(HeartbeatAck {
                            edge_id: heartbeat.edge_id,
                            sequence: heartbeat.sequence,
                            hub_timestamp: current_millis() as i64,
                            config_update: None,
                            server_limits: Some(self.rpc_handler.build_server_limits()),
                        }),
                        ..Default::default()
                    };
                    let ack_data = ack.encode_to_vec();
                    send_tx
                        .send(ack_data)
                        .await
                        .context("Failed to send heartbeat ack")?;
                }
            }
            _ => {
                debug!("Unknown/unhandled packet type: {}", packet.r#type);
            }
        }

        Ok(())
    }
}

fn current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
