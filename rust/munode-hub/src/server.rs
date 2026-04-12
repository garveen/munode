use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use prost::Message;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use munode_common::config::{HubConfig, load_hub_config};
use munode_common::logging::LogReloadHandle;
use munode_protocol::hubedge::*;

use crate::acl_manager::AclManager;
use crate::ban_store::BanStore;
use crate::blob_store::BlobStore;
use crate::channel_store::ChannelStore;
use crate::database::Database;
use crate::edge_connection::EdgeConnection;
use crate::rpc_handler::{EdgeSender, RpcHandler};
use crate::session_manager::SessionManager;
use crate::topology_manager::TopologyManager;
use crate::auth_service::{AuthServiceHandle, run_auth_service_listener};
use crate::lua_auth::LuaAuthEngine;
use crate::user_store::UserStore;

/// A single whisper-target slot as reported by an Edge via `EdgeSyncVoiceTarget`.
///
/// Stored in `HubState::voice_targets` for cluster-wide visibility (diagnostics,
/// web API).  The authoritative copy for local routing lives on each Edge.
#[derive(Debug, Clone)]
pub struct VoiceTargetEntry {
    pub edge_id: u32,
    pub client_session: u32,
    pub target_id: u32,
    pub config: Option<munode_protocol::hubedge::VoiceTargetConfigProto>,
    /// Unix timestamp (milliseconds) when this entry was last updated.
    pub timestamp: i64,
}

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
    /// Control-relay port for peer-to-peer relay connections.
    /// Every Edge exposes a relay server; `None` means the relay port was not
    /// advertised (older protocol version).
    pub relay_port: Option<u32>,
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
    /// In-memory user store (passwords excluded — never cached).
    pub user_store: UserStore,
    /// In-memory ban store.
    pub ban_store: BanStore,
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
    /// Cluster-wide voice (whisper) target snapshot, keyed by (client_session, target_id).
    ///
    /// Written by `RpcHandler::handle_sync_voice_target` on every `EdgeSyncVoiceTarget` RPC.
    /// Read by the web API to expose diagnostics.
    pub voice_targets: RwLock<HashMap<(u32, u32), VoiceTargetEntry>>,
    /// Live server-limits config pushed to Edges.
    ///
    /// Initialised from the startup config and updated in-place on SIGHUP hot-reload.
    /// All reads use the async `RwLock` so callers never block the runtime.
    pub live_limits: RwLock<ServerLimitsConfig>,
}

/// The main Hub server.
pub struct HubServer {
    config: HubConfig,
    /// Path to the TOML config file, used by the SIGHUP hot-reload task.
    config_path: Option<String>,
    /// Handle for dynamically reloading the active log-level filter at runtime.
    log_reload: Option<LogReloadHandle>,
}

impl HubServer {
    pub fn new(config: HubConfig) -> Self {
        Self { config, config_path: None, log_reload: None }
    }

    /// Create a Hub server with a known config file path and log-reload handle.
    ///
    /// Use this constructor from `main` so the SIGHUP hot-reload task can re-read
    /// the config file and push updated limits to all connected Edges at runtime.
    pub fn new_with_path(config: HubConfig, config_path: String, log_reload: LogReloadHandle) -> Self {
        Self { config, config_path: Some(config_path), log_reload: Some(log_reload) }
    }

    /// Start the Hub server and listen for edge connections.
    pub async fn run(&self) -> Result<()> {
        // Open database
        let db_path = self.config.database.path.clone();
        let database = Arc::new(
            tokio::task::spawn_blocking(move || Database::open(&db_path))
                .await
                .context("spawn_blocking join error")?
                .context("Failed to open database")?,
        );

        let channel_store = Arc::new(ChannelStore::new(database.clone()));

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
            user_store: UserStore::new(database.clone()),
            ban_store: BanStore::new(database.clone()),
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
            voice_targets: RwLock::new(HashMap::new()),
            live_limits: RwLock::new(crate::rpc_handler::server_limits_from_config(&self.config)),
        });

        // Load channels from database
        state.channel_store.load_from_db().await?;

        // Populate the in-memory ACL + channel-group store from the database.
        // After this point all ACL reads are served from memory; DB is only
        // written to on mutations (write-through).
        state.acl_manager.load_all().await
            .context("Failed to load ACL entries and channel groups into memory")?;

        // Load users into memory (passwords excluded).
        state.user_store.load_from_db().await
            .context("Failed to load users into memory")?;

        // Load bans into memory.
        state.ban_store.load_from_db().await
            .context("Failed to load bans into memory")?;

        // Create RPC handler
        let rpc_handler = Arc::new(RpcHandler::new(state.clone()));

        // SIGHUP hot-reload: reload config from disk, update live_limits, and push
        // the new ServerLimitsConfig to all currently-connected Edges.
        #[cfg(unix)]
        {
            let reload_path = self.config_path.clone();
            let reload_state = state.clone();
            let log_reload_handle = self.log_reload.clone();
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
                    info!("SIGHUP received — reloading config and pushing limits to connected Edges");
                    let Some(ref path) = reload_path else {
                        warn!("SIGHUP received but no config path known; skipping hot-reload");
                        continue;
                    };
                    let path_clone = path.clone();
                    let load_result = tokio::task::spawn_blocking(move || load_hub_config(&path_clone)).await;
                    match load_result {
                        Ok(Ok(new_cfg)) => {
                            if let Some(ref lr) = log_reload_handle {
                                lr.reload_level(&new_cfg.log_level);
                            }
                            // Compute new limits from the reloaded config.
                            let mut new_limits = crate::rpc_handler::server_limits_from_config(&new_cfg);
                            // Optionally override welcome_text with file contents.
                            if let Some(ref file_path) = new_cfg.auth.welcome_text_file {
                                match tokio::fs::read_to_string(file_path).await {
                                    Ok(text) => { new_limits.welcome_text = Some(text.trim_end().to_string()); }
                                    Err(e) => { warn!("SIGHUP: failed to read welcome_text_file '{}': {}", file_path, e); }
                                }
                            }
                            // Update the live limits cache.
                            *reload_state.live_limits.write().await = new_limits.clone();
                            // Broadcast the new limits to all connected Edges.
                            let packet = EdgeHubPacket {
                                r#type: PacketType::RpcNotification as i32,
                                rpc_notification: Some(TypedRpcNotification {
                                    method: "hub.serverConfigUpdate".to_string(),
                                    timestamp: Some(current_millis() as i64),
                                    server_config_update: Some(new_limits),
                                    ..Default::default()
                                }),
                                ..Default::default()
                            };
                            let data = packet.encode_to_vec();
                            broadcast_critical(&reload_state, data).await;
                            info!(
                                log_level = %new_cfg.log_level,
                                "Hub config hot-reload applied and pushed to all connected Edges"
                            );
                        }
                        Ok(Err(e)) => {
                            warn!("SIGHUP hot-reload failed — could not parse config '{}': {}", path, e);
                        }
                        Err(e) => {
                            warn!("SIGHUP: spawn_blocking task panicked: {}", e);
                        }
                    }
                }
            });
        }

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
            let ban_state = state.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    let removed = ban_state.ban_store.cleanup_expired().await;
                    if removed > 0 {
                        tracing::info!("Cleaned up {} expired ban record(s)", removed);
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
                if let Err(e) = crate::web_api::run_web_api(&web_host, web_port, web_state).await {
                    error!("Web API failed: {}", e);
                }
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
                    // Build the shutdown packet once, then snapshot senders to avoid
                    // holding the read-lock across send().await calls.
                    let shutdown_data = {
                        let notification = TypedRpcNotification {
                            method: "edge.forceDisconnect".to_string(),
                            timestamp: Some(current_millis() as i64),
                            force_disconnect: Some(HubForceDisconnectParams {
                                reason: "Hub server shutting down".to_string(),
                            }),
                            ..Default::default()
                        };
                        EdgeHubPacket {
                            r#type: PacketType::RpcNotification as i32,
                            rpc_notification: Some(notification),
                            ..Default::default()
                        }.encode_to_vec()
                    };
                    broadcast_critical(&state, shutdown_data).await;
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

/// Broadcast a critical state-sync message to all edges with backpressure.
///
/// Snapshots the sender list before sending so the `edge_connections` read-lock
/// is held only for the brief map-clone, not during the per-edge `send().await`
/// calls.  Each edge gets up to a 2-second window; all edges are sent
/// concurrently via `join_all` so a slow edge does not delay the others.
pub async fn broadcast_critical(state: &HubState, data: Vec<u8>) {
    use futures_util::future::join_all;
    use tokio::time::{timeout, Duration};

    // Snapshot senders under the read-lock (clone is cheap — just Arc bumps).
    let senders: Vec<(u32, tokio::sync::mpsc::Sender<Vec<u8>>)> = {
        let edges = state.edge_connections.read().await;
        edges.iter().map(|(&id, tx)| (id, tx.clone())).collect()
    }; // read-lock released here

    let futures = senders.into_iter().map(|(edge_id, sender)| {
        let data = data.clone();
        async move {
            match timeout(Duration::from_secs(2), sender.send(data)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    tracing::warn!("broadcast_critical: edge {} channel closed: {}", edge_id, e);
                }
                Err(_) => {
                    tracing::warn!(
                        "broadcast_critical: edge {} send timeout — message dropped",
                        edge_id
                    );
                }
            }
        }
    });
    join_all(futures).await;
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

/// Broadcast a critical state-sync message to all edges **except** one, with backpressure.
///
/// Same semantics as [`broadcast_critical`] but skips the edge identified by
/// `exclude_edge_id`.  Used when forwarding a notification that originated on
/// one edge to all other edges (e.g. `hub.userStateBroadcast`).
pub async fn broadcast_critical_excluding(state: &HubState, data: Vec<u8>, exclude_edge_id: u32) {
    use futures_util::future::join_all;
    use tokio::time::{timeout, Duration};

    // Snapshot senders under the read-lock, excluding the source edge.
    let senders: Vec<(u32, tokio::sync::mpsc::Sender<Vec<u8>>)> = {
        let edges = state.edge_connections.read().await;
        edges
            .iter()
            .filter(|&(&id, _)| id != exclude_edge_id)
            .map(|(&id, tx)| (id, tx.clone()))
            .collect()
    }; // read-lock released here

    let futures = senders.into_iter().map(|(edge_id, sender)| {
        let data = data.clone();
        async move {
            match timeout(Duration::from_secs(2), sender.send(data)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    tracing::warn!(
                        "broadcast_critical_excluding: edge {} channel closed: {}",
                        edge_id,
                        e
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        "broadcast_critical_excluding: edge {} send timeout — message dropped",
                        edge_id
                    );
                }
            }
        }
    });
    join_all(futures).await;
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
            // Guard against the race where the Edge reconnected (and sent a fresh
            // heartbeat) between the snapshot above and this removal.  We re-check
            // the heartbeat timestamp under the *write* lock so no new heartbeat
            // can slip through after we decide to clean up.
            let should_clean = {
                let mut health_map = state.edge_health.write().await;
                match health_map.get(&edge_id) {
                    Some(h) if h.last_heartbeat.elapsed() > timeout => {
                        health_map.remove(&edge_id);
                        true
                    }
                    _ => false, // heartbeat was refreshed — do not clean up
                }
            };

            if should_clean {
                warn!("Edge {} heartbeat timeout — cleaning up", edge_id);
                state.edge_connections.write().await.remove(&edge_id);
                rpc_handler.cleanup_edge(edge_id).await;
            }
        }
    }
}
