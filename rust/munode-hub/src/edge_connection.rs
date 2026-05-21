use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite;
use tracing::{debug, error, info, warn};

use munode_protocol::hubedge::*;

use crate::rpc_handler::{EdgeSenderPool, RpcHandler};
use crate::server::{EdgeConnectionControl, EdgeHealth, EdgeNotifEnvelope, HubState};

/// Represents a single connected edge server.
pub struct EdgeConnection {
    state: Arc<HubState>,
    rpc_handler: Arc<RpcHandler>,
    connection_id: u64,
    /// The server_id once registered.
    server_id: Option<u32>,
    shutdown: Arc<tokio::sync::Notify>,
    control_server_id: Option<u32>,
    /// Clone of this connection's outbound sender, set after registration.
    /// Used to identify and remove this specific sender from the edge's pool
    /// on disconnect, without affecting other pool connections.
    own_sender: Option<mpsc::Sender<Vec<u8>>>,
}

impl EdgeConnection {
    pub fn new(state: Arc<HubState>, rpc_handler: Arc<RpcHandler>) -> Self {
        let connection_id = state
            .next_edge_connection_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self {
            state,
            rpc_handler,
            connection_id,
            server_id: None,
            shutdown: Arc::new(tokio::sync::Notify::new()),
            control_server_id: None,
            own_sender: None,
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
        let (send_tx, mut send_rx) = mpsc::channel::<Vec<u8>>(4096);
        // Graceful-shutdown signal for the writer task.
        let (writer_stop_tx, mut writer_stop_rx) = mpsc::channel::<()>(1);
        // Writer-to-reader failure signal: when the writer encounters a fatal send error
        // it notifies the reader so the read loop exits promptly without waiting for
        // the OS to surface the error on the receive side (may take minutes on a black-hole link).
        let (writer_fail_tx, writer_fail_rx) = tokio::sync::oneshot::channel::<()>();
        let shutdown = Arc::clone(&self.shutdown);
        let mut request_tasks = JoinSet::new();

        // Writer task: forwards messages from send_rx to WebSocket
        let writer_handle = tokio::spawn(async move {
            let mut fail_tx = Some(writer_fail_tx);
            loop {
                tokio::select! {
                    biased;
                    _ = writer_stop_rx.recv() => break,
                    msg = send_rx.recv() => {
                        match msg {
                            Some(data) => {
                                if let Err(e) = ws_write
                                    .send(tungstenite::Message::Binary(Bytes::from(data)))
                                    .await
                                {
                                    error!("WebSocket write error for edge: {}", e);
                                    if let Some(tx) = fail_tx.take() { let _ = tx.send(()); }
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
        });

        // Read loop
        let mut writer_fail = writer_fail_rx;
        let mut forced_shutdown = false;
        loop {
            tokio::select! {
                biased;
                _ = shutdown.notified() => {
                    info!(
                        "Hub requested edge connection shutdown for {} (connection_id={})",
                        addr,
                        self.connection_id
                    );
                    forced_shutdown = true;
                    break;
                }
                _ = &mut writer_fail => {
                    debug!("Hub edge_connection reader: writer failed, closing read loop for {}", addr);
                    break;
                }
                msg = ws_read.next() => {
                    match msg {
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            if let Err(e) = self.handle_incoming(&data, &send_tx, &mut request_tasks).await {
                                warn!("Error handling edge message from {}: {}", addr, e);
                            }
                        }
                        Some(Ok(tungstenite::Message::Close(_))) => {
                            info!("Edge {} sent close frame", addr);
                            break;
                        }
                        Some(Ok(tungstenite::Message::Ping(data))) => {
                            let pong = tungstenite::Message::Pong(data).into_data().to_vec();
                            let _ = send_tx.send(pong).await;
                        }
                        Some(Ok(_)) => {}
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
            }
        }

        if forced_shutdown {
            writer_handle.abort();
            let _ = writer_handle.await;
        } else {
            // Signal the writer task to stop and wait for it to drain its queue.
            let _ = writer_stop_tx.send(()).await;
            let _ = writer_handle.await;
        }
        request_tasks.abort_all();
        while let Some(joined) = request_tasks.join_next().await {
            if let Err(e) = joined {
                if !e.is_cancelled() {
                    warn!(
                        "Edge connection {} request task ended unexpectedly: {}",
                        self.connection_id, e
                    );
                }
            }
        }

        // Cleanup on disconnect.
        // Remove only this connection's sender from the pool.  Other pool connections
        // for the same edge remain active.  Cleanup runs only when the last sender
        // is removed (pool becomes empty), ensuring we don't destroy a healthy edge's
        // sessions just because one of its WebSocket connections dropped.
        if let Some(server_id) = self.server_id {
            self.unregister_connection_control().await;
            let should_cleanup = if let Some(our_sender) = &self.own_sender {
                let pool_is_empty = {
                    let mut connections = self.state.edge_connections.write().await;
                    let empty = connections
                        .get(&server_id)
                        .map(|pool| pool.remove(our_sender))
                        .unwrap_or(false);
                    if empty {
                        connections.remove(&server_id);
                    }
                    empty
                };
                pool_is_empty
            } else {
                // Never completed registration — nothing to clean up.
                false
            };

            if should_cleanup {
                self.state.edge_health.write().await.remove(&server_id);
                // The relay slot is permanently connected whenever relay peers
                // are available, so Hub never loses all connections for a
                // transiently-unreachable Edge.  When the pool truly empties
                // (Edge process terminated, all relay peers also gone) we
                // clean up immediately — no grace period is needed.
                self.rpc_handler.cleanup_edge(server_id).await;
            }
            info!("Edge {} (server_id={}) disconnected", addr, server_id);
        } else {
            self.unregister_connection_control().await;
        }

        Ok(())
    }

    /// Ensure a per-edge inbound notification processor task is running for `edge_id`.
    ///
    /// `reset` should be `true` when the Edge is registering for the first time in this
    /// connection session (i.e. there was no existing pool entry for it, meaning it either
    /// just started or fully disconnected before reconnecting).  In that case the Edge's
    /// outbound notification sequence counter has been reset to 0 and the old sequencer's
    /// `expected_seq` would discard every new notification as a duplicate — so we must
    /// create a fresh processor with a zeroed sequencer.
    ///
    /// When `reset` is `false` (additional pool slot from the same connection session),
    /// the existing processor is reused so that in-flight notifications already enqueued
    /// are not lost.  If no processor exists at all a new one is created regardless.
    async fn ensure_edge_notif_processor(&self, edge_id: u32, reset: bool) {
        let needs_new = reset || {
            let senders = self.state.edge_notif_senders.read().await;
            senders.get(&edge_id).map_or(true, |tx| tx.is_closed())
        };
        if needs_new {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<EdgeNotifEnvelope>();
            // Replacing the old sender drops it, which closes the old channel and causes
            // the previous processor task to exit (rx.recv() returns None).
            self.state
                .edge_notif_senders
                .write()
                .await
                .insert(edge_id, tx);
            let rpc_handler = Arc::clone(&self.rpc_handler);
            tokio::spawn(crate::rpc_handler::run_edge_notif_processor(
                edge_id,
                rx,
                rpc_handler,
            ));
            if reset {
                debug!(
                    "Spawned fresh notification processor for edge {} (sequence reset on reconnect)",
                    edge_id
                );
            } else {
                debug!(
                    "Spawned notification processor for edge {} (none existed)",
                    edge_id
                );
            }
        }
    }

    async fn register_connection_control(&mut self, server_id: u32) {
        if self.control_server_id == Some(server_id) {
            return;
        }

        if let Some(old_server_id) = self.control_server_id.replace(server_id) {
            let mut controls = self.state.edge_connection_controls.write().await;
            if let Some(entries) = controls.get_mut(&old_server_id) {
                entries.remove(&self.connection_id);
                if entries.is_empty() {
                    controls.remove(&old_server_id);
                }
            }
        }

        self.state
            .edge_connection_controls
            .write()
            .await
            .entry(server_id)
            .or_default()
            .insert(
                self.connection_id,
                EdgeConnectionControl {
                    shutdown: Arc::clone(&self.shutdown),
                },
            );
    }

    async fn unregister_connection_control(&mut self) {
        let Some(server_id) = self.control_server_id.take() else {
            return;
        };

        let mut controls = self.state.edge_connection_controls.write().await;
        if let Some(entries) = controls.get_mut(&server_id) {
            entries.remove(&self.connection_id);
            if entries.is_empty() {
                controls.remove(&server_id);
            }
        }
    }

    fn register_response_succeeded(response_data: &[u8]) -> Result<bool> {
        let packet = EdgeHubPacket::decode(response_data)
            .context("Failed to decode register response packet")?;
        let response = packet
            .rpc_response
            .context("Missing rpc_response in register packet")?;
        let register = response
            .edge_register
            .context("Missing edge_register result in register response")?;
        Ok(register.success)
    }

    async fn install_registered_sender(&mut self, edge_id: u32, send_tx: &mpsc::Sender<Vec<u8>>) {
        self.own_sender = Some(send_tx.clone());

        let reset_processor = {
            let mut connections = self.state.edge_connections.write().await;
            match connections.get(&edge_id) {
                Some(pool) => {
                    pool.add(send_tx.clone());
                    debug!(
                        "Pool slot for edge {} connected after successful register",
                        edge_id
                    );
                    false
                }
                None => {
                    connections.insert(edge_id, EdgeSenderPool::new(send_tx.clone()));
                    true
                }
            }
        };

        {
            let mut health = self.state.edge_health.write().await;
            if reset_processor {
                health.insert(edge_id, EdgeHealth::new());
            } else {
                health.entry(edge_id).or_insert_with(EdgeHealth::new);
            }
        }

        self.ensure_edge_notif_processor(edge_id, reset_processor)
            .await;
    }

    /// Handle an incoming binary message from the edge.
    async fn handle_incoming(
        &mut self,
        data: &[u8],
        send_tx: &mpsc::Sender<Vec<u8>>,
        request_tasks: &mut JoinSet<()>,
    ) -> Result<()> {
        let packet = EdgeHubPacket::decode(data).context("Failed to decode EdgeHubPacket")?;

        match PacketType::try_from(packet.r#type) {
            Ok(PacketType::RpcRequest) => {
                if let Some(request) = packet.rpc_request {
                    if request.method == "edge.register" {
                        if let Some(params) = &request.edge_register {
                            self.server_id = Some(params.server_id);
                            self.register_connection_control(params.server_id).await;
                        }
                    }

                    let edge_id = self.server_id.unwrap_or(0);
                    let ninja_enabled = edge_id != 0 && self.state.config.channel_ninja.enabled;
                    let ninja_channels = if ninja_enabled {
                        self.state.config.channel_ninja.ninja_channels.clone()
                    } else {
                        vec![]
                    };
                    let is_register = request.method == "edge.register";

                    if is_register {
                        match self
                            .rpc_handler
                            .handle_request(request, edge_id, self.connection_id)
                            .await
                        {
                            Ok(response_data) => {
                                match Self::register_response_succeeded(&response_data) {
                                    Ok(true) => {
                                        self.install_registered_sender(edge_id, send_tx).await;
                                    }
                                    Ok(false) => {}
                                    Err(e) => {
                                        warn!(
                                            "Failed to inspect edge.register response for edge {}: {:#}",
                                            edge_id, e
                                        );
                                    }
                                }
                                if send_tx.send(response_data).await.is_err() {
                                    debug!(
                                        "Edge {} connection closed before RPC response could be sent",
                                        edge_id
                                    );
                                }
                                if ninja_enabled {
                                    self.rpc_handler
                                        .send_notification_to_edge_unsequenced(
                                            edge_id,
                                            "hub.ninjaConfig",
                                            |n| {
                                                let json = serde_json::json!({
                                                    "enabled": true,
                                                    "ninja_channels": ninja_channels
                                                });
                                                n.unknown_params_json = Some(json.to_string());
                                            },
                                        )
                                        .await;
                                }
                            }
                            Err(e) => {
                                warn!("Unexpected RPC handler error for edge {}: {}", edge_id, e);
                            }
                        }
                        return Ok(());
                    }

                    let rpc_handler = Arc::clone(&self.rpc_handler);
                    let send_tx_clone = send_tx.clone();

                    // Spawn each RPC request as an independent task so that a slow handler
                    // (e.g. Argon2 authentication, ~100-300 ms) does not block subsequent
                    // messages from other clients sharing the same Edge→Hub connection.
                    let connection_id = self.connection_id;
                    request_tasks.spawn(async move {
                        match rpc_handler.handle_request(request, edge_id, connection_id).await {
                            Ok(response_data) => {
                                if send_tx_clone.send(response_data).await.is_err() {
                                    debug!(
                                        "Edge {} connection closed before RPC response could be sent",
                                        edge_id
                                    );
                                }
                            }
                            Err(e) => {
                                warn!("Unexpected RPC handler error for edge {}: {}", edge_id, e);
                            }
                        }
                        if is_register && ninja_enabled {
                            rpc_handler
                                .send_notification_to_edge_unsequenced(
                                    edge_id,
                                    "hub.ninjaConfig",
                                    |n| {
                                        let json = serde_json::json!({
                                            "enabled": true,
                                            "ninja_channels": ninja_channels
                                        });
                                        n.unknown_params_json = Some(json.to_string());
                                    },
                                )
                                .await;
                        }
                    });
                }
            }
            Ok(PacketType::RpcNotification) => {
                if let Some(notification) = packet.rpc_notification {
                    let edge_id = self.server_id.unwrap_or(0);
                    let envelope = EdgeNotifEnvelope {
                        seq: packet.edge_notification_seq,
                        notification,
                    };
                    let senders = self.state.edge_notif_senders.read().await;
                    if let Some(tx) = senders.get(&edge_id) {
                        if tx.send(envelope).is_err() {
                            warn!(
                                "Notification processor for edge {} died, dropping notification",
                                edge_id
                            );
                        }
                    } else {
                        // Edge hasn't registered yet (should not happen in practice
                        // since edge.register is always the first message).
                        warn!(
                            "No notification processor for edge {} (pre-registration), \
                             dropping notification",
                            edge_id
                        );
                    }
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
                    let health = health_map.entry(edge_id).or_insert_with(EdgeHealth::new);
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
