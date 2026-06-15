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

/// Parse a host string and port into a `SocketAddr`.
///
/// Handles both IPv4 (`0.0.0.0`) and bare IPv6 (`::`) addresses correctly by
/// wrapping IPv6 in brackets before parsing, e.g. `[::]:8090`.
pub(crate) fn parse_socket_addr(host: &str, port: u16) -> anyhow::Result<SocketAddr> {
    // If the host contains a colon but is not already bracketed it is an IPv6
    // address and must be wrapped: `::` → `[::]:port`.
    let addr_str = if host.contains(':') && !host.starts_with('[') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    };
    addr_str
        .parse::<SocketAddr>()
        .map_err(|e| anyhow::anyhow!("invalid address '{}': {}", addr_str, e))
}

/// The main Edge server.
pub(crate) mod connection;
mod event_listener;
mod proxy_protocol;

#[cfg(test)]
pub(crate) use event_listener::hub_event_listener;

pub struct EdgeServer {
    config: EdgeConfig,
    /// Path to the config file, used for hot-reload on SIGHUP.
    config_path: Option<String>,
    /// Handle for updating the active log-level filter at runtime.
    log_reload: Option<LogReloadHandle>,
}

impl EdgeServer {
    pub fn new(config: EdgeConfig) -> Self {
        Self {
            config,
            config_path: None,
            log_reload: None,
        }
    }

    /// Create a new EdgeServer with the config file path for hot-reload support.
    pub fn new_with_path(
        config: EdgeConfig,
        config_path: String,
        log_reload: LogReloadHandle,
    ) -> Self {
        Self {
            config,
            config_path: Some(config_path),
            log_reload: Some(log_reload),
        }
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
            crate::state::EdgeStateConfig {
                enable_hub_tcp_fallback: self.config.voice_routing.enable_hub_tcp_fallback,
                consecutive_failure_threshold: self
                    .config
                    .voice_routing
                    .consecutive_failure_threshold,
                listeners_per_user: self.config.server.listeners_per_user,
                listeners_per_channel: self.config.server.listeners_per_channel,
                allow_ping: self.config.server.allow_ping,
                rolling_stats_window: self.config.server.rolling_stats_window,
                hmac_secret: self.config.hub_server.hmac_secret.as_deref(),
                peer_voice_tcp_pool_size: self.config.voice_routing.peer_voice_tcp_pool_size
                    as usize,
                peer_quality_sample_window_size: self
                    .config
                    .voice_routing
                    .quality
                    .sample_window_size,
                peer_quality_probe_timeout_secs: self
                    .config
                    .voice_routing
                    .quality
                    .probe_timeout_secs,
                cluster_peer_access: self.config.cluster_peer_access.clone(),
            },
        );

        if !edge_state.test_network_faults.is_empty() {
            info!(
                udp_drop_rate = edge_state.test_network_faults.udp_drop_rate(),
                udp_block_peers = ?edge_state.test_network_faults.udp_block_peers(),
                voice_tcp_block_peers = ?edge_state.test_network_faults.voice_tcp_block_peers(),
                "Edge test fault injection active"
            );
        }

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
        let udp_addr: SocketAddr =
            format!("{}:{}", self.config.network.host, self.config.network.port).parse()?;
        let edge_port = self
            .config
            .network
            .edge_port
            .unwrap_or(self.config.network.port + 1);
        let edge_udp_addr: SocketAddr =
            format!("{}:{}", self.config.network.host, edge_port).parse()?;
        let udp_server = Arc::new(
            UdpServer::new(
                udp_addr,
                edge_udp_addr,
                edge_state.clone(),
                hub_client.clone(),
                self.config.voice_routing.quality.clone(),
            )
            .await?,
        );
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
                event_listener::hub_event_listener(
                    state,
                    &mut event_rx,
                    shutdown_tx,
                    hub_client_for_events,
                )
                .await;
            }
        });

        // SIGHUP hot-reload task: reload the config file and apply hot-reloadable fields.
        #[cfg(unix)]
        {
            let config_path = self.config_path.clone();
            let reload_state = edge_state.clone();
            let log_reload = self.log_reload.clone();
            tokio::spawn(async move {
                use tokio::signal::unix::{SignalKind, signal};
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
                                warn!(
                                    "SIGHUP hot-reload failed — could not parse config '{}': {}",
                                    path, e
                                );
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
            let hub_client_clone = hub_client.clone();
            info!(
                "Starting edge WS server (relay+voice) on port {}",
                edge_port
            );
            tokio::spawn(async move {
                crate::relay_server::run_edge_ws_server(
                    edge_port,
                    hub_host,
                    hub_port,
                    relay_hmac_secret,
                    edge_state_clone,
                    hub_client_clone,
                )
                .await;
            });
        }

        // Optionally start the Edge Web API.
        if self.config.web_api.enabled {
            let web_api_host = self.config.web_api.host.clone();
            let web_api_port = self.config.web_api.port;
            let web_api_token = self.config.web_api.api_token.clone();
            let web_api_state = edge_state.clone();
            let web_api_metadata = crate::web_api::WebApiMetadata::from_config(&self.config);
            tokio::spawn(async move {
                if let Err(e) = crate::web_api::run_web_api(
                    &web_api_host,
                    web_api_port,
                    web_api_state,
                    web_api_metadata,
                    web_api_token,
                )
                .await
                {
                    error!("Edge Web API error: {}", e);
                }
            });
        }

        // Optionally start the WebTransport (QUIC/HTTP3) listener for browser clients.
        #[cfg(feature = "webtransport")]
        if self.config.webtransport.enabled {
            let wt_config = std::sync::Arc::new(self.config.clone());
            let wt_hub = hub_client.clone();
            let wt_state = edge_state.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::transport::webtransport::run_webtransport_listener(
                    wt_config, wt_hub, wt_state,
                )
                .await
                {
                    error!("WebTransport listener error: {}", e);
                }
            });
        }

        // Optionally start the WebSocket fallback listener.
        // Only bind a *separate* port when `ws_fallback_port` is explicitly set to
        // a different port than the main Mumble port.  By default, HTTP/WebSocket
        // connections are served on the main port via protocol sniffing in the
        // accept loop below (TLS ClientHello starts with 0x16; HTTP starts with an
        // ASCII uppercase letter).
        #[cfg(feature = "ws-transport")]
        if self.config.webtransport.ws_fallback_enabled {
            let ws_port = self
                .config
                .webtransport
                .effective_ws_port(self.config.network.port);
            if ws_port != self.config.network.port {
                let ws_config = std::sync::Arc::new(self.config.clone());
                let ws_hub = hub_client.clone();
                let ws_state = edge_state.clone();
                tokio::spawn(async move {
                    if let Err(e) =
                        crate::transport::ws::run_ws_listener(ws_config, ws_hub, ws_state).await
                    {
                        error!("WebSocket fallback listener error: {}", e);
                    }
                });
            }
        }

        // Start TLS server
        let listen_addr: SocketAddr =
            format!("{}:{}", self.config.network.host, self.config.network.port).parse()?;
        let listener = TcpListener::bind(listen_addr).await?;
        info!("TLS server listening on {}", listen_addr);

        // Semaphore to limit concurrent TCP connections for DoS protection only.
        // This is NOT the user-count limit — that is enforced by the Hub via
        // session_manager.count_sessions() in handle_authenticate_user.
        // Use a fixed large ceiling so that pre-auth connections (TLS handshake,
        // version exchange) do not consume slots intended for authenticated users.
        const MAX_TCP_CONNECTIONS: usize = 65_535;
        let conn_semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_TCP_CONNECTIONS));

        // Pre-parse the trusted-proxy allow-list once so the per-connection fast path
        // does not re-parse CIDR strings on every accept.  `None` means "trust every
        // peer" (legacy behaviour); `Some(empty)` would mean "trust no peer", which
        // we interpret the same as the legacy default to avoid breaking existing
        // configs that simply leave the field unset.
        let trusted_proxies: Option<Arc<[proxy_protocol::TrustedPeer]>> = if self
            .config
            .network
            .proxy_protocol
            && !self.config.network.trusted_proxy_ips.is_empty()
        {
            match proxy_protocol::parse_trusted_proxy_list(&self.config.network.trusted_proxy_ips) {
                Ok(list) => Some(Arc::from(list.into_boxed_slice())),
                Err(e) => {
                    return Err(anyhow::anyhow!(
                        "Invalid network.trusted_proxy_ips entry: {}",
                        e
                    ));
                }
            }
        } else {
            if self.config.network.proxy_protocol {
                warn!(
                    "network.proxy_protocol is enabled without network.trusted_proxy_ips; \
                         every TCP peer can spoof its source IP via a forged PROXY header. \
                         Configure trusted_proxy_ips to restrict this to your reverse proxy."
                );
            }
            None
        };

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
                            let udp = udp_server.clone();
                            let proxy_protocol = self.config.network.proxy_protocol;
                            let trusted_proxies = trusted_proxies.clone();

                            // Protocol sniff: peek the first byte to distinguish
                            // HTTP (ASCII uppercase first byte) from TLS ClientHello
                            // (first byte 0x16).  When HTTP is detected and the
                            // ws-transport feature + ws_fallback_enabled are active,
                            // dispatch directly to the HTTP/WS handler without TLS.
                            #[cfg(feature = "ws-transport")]
                            if config.webtransport.ws_fallback_enabled
                                && config.webtransport.effective_ws_port(config.network.port)
                                    == config.network.port
                            {
                                let mut peek1 = [0u8; 1];
                                match stream.peek(&mut peek1).await {
                                    Ok(1) if crate::transport::ws::byte_looks_like_http(peek1[0]) => {
                                        let ws_config = std::sync::Arc::new(config.clone());
                                        let ws_hub = hub.clone();
                                        let ws_state = state.clone();
                                        tokio::spawn(async move {
                                            let _permit = permit;
                                            if let Err(e) = crate::transport::ws::dispatch_connection(
                                                stream, peer_addr, ws_config, ws_hub, ws_state,
                                            ).await {
                                                debug!("HTTP/WS connection error from {}: {}", peer_addr, e);
                                            }
                                        });
                                        continue;
                                    }
                                    _ => {}
                                }
                            }
                            // When PROXY protocol is enabled with an explicit trusted-list,
                            // reject TCP peers outside the list before doing any per-connection
                            // work.  Without this gate a direct client could spoof its source IP
                            // via a forged PROXY header.
                            if proxy_protocol
                                && trusted_proxies.is_some()
                                && !proxy_protocol::peer_is_trusted_proxy(
                                    peer_addr.ip(), trusted_proxies.as_deref(),
                                )
                            {
                                debug!(
                                    "Connection from {} refused: PROXY protocol enabled but peer \
                                     is not in network.trusted_proxy_ips",
                                    peer_addr
                                );
                                drop(stream);
                                continue;
                            }
                            tokio::spawn(async move {
                                // Hold the permit for the duration of the connection.
                                let _permit = permit;
                                // Resolve the real client address from a PROXY Protocol
                                // header when the edge is behind nginx/HAProxy.
                                let mut stream = stream;
                                // Only honour PROXY headers from peers that match the
                                // configured trusted-proxy allow-list.  This prevents a
                                // direct client from spoofing its source IP by simply
                                // prefixing a forged PROXY header.
                                let peer_is_trusted = proxy_protocol
                                    && proxy_protocol::peer_is_trusted_proxy(
                                        peer_addr.ip(), trusted_proxies.as_deref(),
                                    );
                                let real_addr = if peer_is_trusted {
                                    // Bound the PROXY Protocol read so a peer that opens TCP
                                    // but never sends the PROXY header (slow-loris) cannot
                                    // hold a connection slot indefinitely.
                                    const PROXY_READ_TIMEOUT: tokio::time::Duration =
                                        tokio::time::Duration::from_secs(5);
                                    let parse_result = tokio::time::timeout(
                                        PROXY_READ_TIMEOUT,
                                        proxy_protocol::read_proxy_protocol_addr(&mut stream),
                                    ).await;
                                    match parse_result {
                                        Ok(Ok(Some(addr))) => addr,
                                        Ok(Ok(None)) => peer_addr, // UNKNOWN / LOCAL — fall back
                                        Ok(Err(e)) => {
                                            debug!(
                                                tcp_peer = %peer_addr,
                                                "PROXY Protocol parse error — dropping connection: {}",
                                                e
                                            );
                                            return;
                                        }
                                        Err(_) => {
                                            debug!(
                                                tcp_peer = %peer_addr,
                                                "PROXY Protocol read timed out — dropping connection"
                                            );
                                            return;
                                        }
                                    }
                                } else {
                                    peer_addr
                                };
                                if let Err(e) = connection::handle_client_connection(
                                    stream, real_addr, acceptor, &config, hub, state, udp,
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
        edge_state
            .client_manager
            .close_all_connections("Server shutting down")
            .await;

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
