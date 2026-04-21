use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::{debug, error, info, warn};

use munode_common::config::EdgeConfig;
use munode_common::logging::LogReloadHandle;

use crate::channel_manager::ChannelManager;
use crate::client::ClientManager;
use crate::hub_client::HubClient;
use crate::state::EdgeState;
use crate::tls::create_tls_acceptor;
use crate::udp::UdpServer;

/// The main Edge server.

mod connection;
mod event_listener;
mod proxy_protocol;

pub struct EdgeServer {
    config: EdgeConfig,
    /// Path to the config file, used for hot-reload on SIGHUP.
    config_path: Option<String>,
    /// Handle for updating the active log-level filter at runtime.
    log_reload: Option<LogReloadHandle>,
}

impl EdgeServer {
    pub fn new(config: EdgeConfig) -> Self {
        Self { config, config_path: None, log_reload: None }
    }

    /// Create a new EdgeServer with the config file path for hot-reload support.
    pub fn new_with_path(config: EdgeConfig, config_path: String, log_reload: LogReloadHandle) -> Self {
        Self { config, config_path: Some(config_path), log_reload: Some(log_reload) }
    }

    /// Run the edge server.
    pub async fn run(&self) -> Result<()> {
        // Create shared state
        let client_manager = ClientManager::new();
        let channel_manager = ChannelManager::new();

        // Derive voice routing flags from the voice_routing config.
        let edge_state = EdgeState::new_with_full_config(
            channel_manager,
            client_manager,
            self.config.voice_routing.enable_hub_tcp_fallback,
            self.config.voice_routing.consecutive_failure_threshold,
            self.config.server.listeners_per_user,
            self.config.server.listeners_per_channel,
            self.config.server.allow_ping,
            self.config.server.rolling_stats_window,
            self.config.hub_server.hmac_secret.as_deref(),
            self.config.voice_routing.peer_voice_tcp_pool_size as usize,
        );

        // Set up TLS
        let tls_acceptor = create_tls_acceptor(&self.config.tls)?;

        // Connect to Hub (create client first so UdpServer can reference it)
        let hub_client = HubClient::new(&self.config, edge_state.clone());
        let hub_handle = tokio::spawn({
            let hub_client = hub_client.clone();
            async move {
                if let Err(e) = hub_client.connect_and_run().await {
                    error!("Hub client error: {}", e);
                }
            }
        });

        // Start UDP server (needs hub_client for cross-edge relay)
        let udp_addr: SocketAddr = format!("{}:{}", self.config.network.host, self.config.network.port)
            .parse()?;
        let edge_port = self.config.network.edge_port.unwrap_or(self.config.network.port + 1);
        let edge_udp_addr: SocketAddr = format!("{}:{}", self.config.network.host, edge_port)
            .parse()?;
        let udp_server = Arc::new(UdpServer::new(udp_addr, edge_udp_addr, edge_state.clone(), hub_client.clone()).await?);
        let udp_handle = tokio::spawn({
            let udp = Arc::clone(&udp_server);
            async move {
                if let Err(e) = udp.run().await {
                    error!("UDP server error: {}", e);
                }
            }
        });

        // Event listener: broadcast Hub notifications to local clients.
        // Uses a watch channel so any future task can also observe the shutdown signal.
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let event_handle = tokio::spawn({
            let state = edge_state.clone();
            let hub_client_for_events = hub_client.clone();
            let mut event_rx = edge_state.subscribe_events();
            let shutdown_tx = shutdown_tx.clone();
            async move {
                event_listener::hub_event_listener(state, &mut event_rx, shutdown_tx, hub_client_for_events).await;
            }
        });

        // SIGHUP hot-reload task: reload the config file and apply hot-reloadable fields.
        #[cfg(unix)]
        {
            let config_path = self.config_path.clone();
            let reload_state = edge_state.clone();
            let log_reload = self.log_reload.clone();
            tokio::spawn(async move {
                use tokio::signal::unix::{signal, SignalKind};
                let mut sighup = match signal(SignalKind::hangup()) {
                    Ok(s) => s,
                    Err(e) => {
                        warn!("Failed to register SIGHUP handler: {}", e);
                        return;
                    }
                };
                loop {
                    sighup.recv().await;
                    info!("SIGHUP received — attempting config hot-reload");
                    if let Some(ref path) = config_path {
                        match munode_common::config::load_edge_config(path) {
                            Ok(new_cfg) => {
                                reload_state.apply_hot_config(&new_cfg);
                                // Update the active log-level filter via the reload handle so
                                // the change takes effect immediately without re-initialising
                                // the global subscriber (which would be a no-op).
                                if let Some(ref lr) = log_reload {
                                    lr.reload_level(&new_cfg.log_level);
                                }
                                info!(
                                    allow_ping = new_cfg.server.allow_ping,
                                    rolling_stats_window = new_cfg.server.rolling_stats_window,
                                    log_level = %new_cfg.log_level,
                                    "Config hot-reload applied"
                                );
                            }
                            Err(e) => {
                                warn!("SIGHUP hot-reload failed — could not parse config '{}': {}", path, e);
                            }
                        }
                    } else {
                        warn!("SIGHUP received but no config path known; skipping hot-reload");
                    }
                }
            });
        }

        // Always start the edge WebSocket server (relay + voice) on edge_port
        {
            let hub_host = self.config.hub_server.host.clone();
            let hub_port = self.config.hub_server.control_port;
            let relay_hmac_secret = self.config.hub_server.hmac_secret.clone();
            let edge_state_clone = edge_state.clone();
            info!("Starting edge WS server (relay+voice) on port {}", edge_port);
            tokio::spawn(async move {
                crate::relay_server::run_edge_ws_server(
                    edge_port as u16,
                    hub_host,
                    hub_port,
                    relay_hmac_secret,
                    edge_state_clone,
                )
                .await;
            });
        }

        // Optionally start the Edge Web API.
        if self.config.web_api.enabled {
            let web_api_host = self.config.web_api.host.clone();
            let web_api_port = self.config.web_api.port;
            let web_api_state = edge_state.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::web_api::run_web_api(&web_api_host, web_api_port, web_api_state).await {
                    error!("Edge Web API error: {}", e);
                }
            });
        }

        // Start TLS server
        let listen_addr: SocketAddr = format!("{}:{}", self.config.network.host, self.config.network.port)
            .parse()?;
        let listener = TcpListener::bind(listen_addr).await?;
        info!("TLS server listening on {}", listen_addr);

        // Semaphore to limit concurrent TCP connections for DoS protection only.
        // This is NOT the user-count limit — that is enforced by the Hub via
        // session_manager.count_sessions() in handle_authenticate_user.
        // Use a fixed large ceiling so that pre-auth connections (TLS handshake,
        // version exchange) do not consume slots intended for authenticated users.
        const MAX_TCP_CONNECTIONS: usize = 65_535;
        let conn_semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_TCP_CONNECTIONS));

        // Accept loop
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, peer_addr)) => {
                            // Drop connection only under extreme TCP flood (DoS protection).
                            let permit = match conn_semaphore.clone().try_acquire_owned() {
                                Ok(permit) => permit,
                                Err(_) => {
                                    warn!("Connection from {} dropped: TCP connection limit reached", peer_addr);
                                    drop(stream);
                                    continue;
                                }
                            };
                            // Refuse new connections while Hub is unreachable.
                            if !edge_state.accepting_connections.load(std::sync::atomic::Ordering::Relaxed) {
                                debug!("Connection from {} refused: Hub is unreachable", peer_addr);
                                drop(stream);
                                continue;
                            }
                            let acceptor = tls_acceptor.clone();
                            let config = self.config.clone();
                            let hub = hub_client.clone();
                            let state = edge_state.clone();
                            let proxy_protocol = self.config.network.proxy_protocol;
                            tokio::spawn(async move {
                                // Hold the permit for the duration of the connection.
                                let _permit = permit;
                                // Resolve the real client address from a PROXY Protocol
                                // header when the edge is behind nginx/HAProxy.
                                let mut stream = stream;
                                let real_addr = if proxy_protocol {
                                    match proxy_protocol::read_proxy_protocol_addr(&mut stream).await {
                                        Ok(Some(addr)) => addr,
                                        Ok(None) => peer_addr, // UNKNOWN / LOCAL — fall back
                                        Err(e) => {
                                            debug!(
                                                tcp_peer = %peer_addr,
                                                "PROXY Protocol parse error — dropping connection: {}",
                                                e
                                            );
                                            return;
                                        }
                                    }
                                } else {
                                    peer_addr
                                };
                                if let Err(e) = connection::handle_client_connection(
                                    stream, real_addr, acceptor, &config, hub, state,
                                ).await {
                                    debug!("Client connection error from {}: {}", real_addr, e);
                                }
                            });
                        }
                        Err(e) => {
                            error!("Accept error: {}", e);
                        }
                    }
                }
                _ = shutdown_rx.wait_for(|v| *v) => {
                    info!("Shutting down edge server");
                    break;
                }
                _ = tokio::signal::ctrl_c() => {
                    info!("Received shutdown signal");
                    break;
                }
            }
        }

        // On SIGINT/ctrl-c the ShutdownRequested event path has not fired, so
        // clients have not yet been notified.  Broadcast a Reject to all
        // connected clients so they know to reconnect, then give tasks time
        // to drain their write buffers before we abort them.
        edge_state.client_manager.close_all_connections("Server shutting down").await;

        // Allow background tasks adequate time to notice the shutdown signal
        // and flush any in-flight messages before we force-abort them.
        // 3 seconds is sufficient for disconnect notifications to Hub and any
        // queued writes to be flushed to clients.
        tokio::time::sleep(tokio::time::Duration::from_millis(3000)).await;
        udp_handle.abort();
        hub_handle.abort();
        event_handle.abort();

        Ok(())
    }
}
