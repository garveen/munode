use serde::Deserialize;

/// Edge server configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct EdgeConfig {
    /// Unique server ID for this edge.
    pub server_id: u32,
    /// Human-readable server name.
    pub name: String,
    /// Network configuration.
    pub network: NetworkConfig,
    /// TLS configuration.
    pub tls: TlsConfig,
    /// Hub server connection configuration.
    pub hub_server: HubServerConfig,
    /// Server capacity and limits.
    #[serde(default)]
    pub server: ServerConfig,
    /// Logging level.
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

/// Network binding configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct NetworkConfig {
    /// Bind address (default: 0.0.0.0).
    #[serde(default = "default_host")]
    pub host: String,
    /// Main port for client connections (TLS + UDP).
    #[serde(default = "default_port")]
    pub port: u16,
    /// Port for Edge-to-Edge connections (default: port + 1).
    pub edge_port: Option<u16>,
    /// External hostname for registration with Hub.
    #[serde(default = "default_host")]
    pub external_host: String,
    /// External port (for NAT).
    pub external_port: Option<u16>,
    /// Geographic region identifier.
    pub region: Option<String>,
}

/// TLS certificate configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct TlsConfig {
    /// Path to TLS certificate PEM file.
    pub cert: String,
    /// Path to TLS private key PEM file.
    pub key: String,
    /// Optional CA chain PEM file.
    pub ca: Option<String>,
}

/// Hub server connection configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HubServerConfig {
    /// Hub server hostname.
    pub host: String,
    /// Hub control port (WebSocket).
    pub control_port: u16,
    /// Reconnect interval in milliseconds.
    #[serde(default = "default_reconnect_interval")]
    pub reconnect_interval: u64,
    /// Heartbeat interval in milliseconds.
    #[serde(default = "default_heartbeat_interval")]
    pub heartbeat_interval: u64,
    /// Optional HMAC secret for authentication.
    pub hmac_secret: Option<String>,
}

/// Server capacity and behavior configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    /// Maximum number of connected users.
    #[serde(default = "default_capacity")]
    pub capacity: u32,
    /// Maximum bandwidth per user (kbps).
    #[serde(default = "default_max_bandwidth")]
    pub max_bandwidth: u32,
    /// Default channel ID for new users.
    #[serde(default)]
    pub default_channel: u32,
    /// Welcome text shown to connecting clients.
    pub welcome_text: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            capacity: default_capacity(),
            max_bandwidth: default_max_bandwidth(),
            default_channel: 0,
            welcome_text: None,
        }
    }
}

/// Load edge configuration from a JSON file.
pub fn load_edge_config(path: &str) -> Result<EdgeConfig, anyhow::Error> {
    let content = std::fs::read_to_string(path)?;
    let config: EdgeConfig = serde_json::from_str(&content)?;
    Ok(config)
}

/// Hub server configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HubConfig {
    /// Network binding.
    #[serde(default)]
    pub network: HubNetworkConfig,
    /// Database configuration.
    #[serde(default)]
    pub database: HubDatabaseConfig,
    /// Authentication configuration.
    #[serde(default)]
    pub auth: HubAuthConfig,
    /// Registry configuration (edge registration).
    #[serde(default)]
    pub registry: HubRegistryConfig,
    /// Logging level.
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

/// Hub network configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HubNetworkConfig {
    /// Bind address.
    #[serde(default = "default_host")]
    pub host: String,
    /// WebSocket control port for edge connections.
    #[serde(default = "default_hub_port")]
    pub control_port: u16,
}

impl Default for HubNetworkConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            control_port: default_hub_port(),
        }
    }
}

/// Hub database configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HubDatabaseConfig {
    /// Path to SQLite database file.
    #[serde(default = "default_db_path")]
    pub path: String,
}

impl Default for HubDatabaseConfig {
    fn default() -> Self {
        Self {
            path: default_db_path(),
        }
    }
}

/// Hub authentication configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HubAuthConfig {
    /// Allow guest/anonymous access.
    #[serde(default = "default_true")]
    pub allow_guest: bool,
    /// Default channel for new users.
    #[serde(default)]
    pub default_channel: u32,
    /// Welcome text.
    pub welcome_text: Option<String>,
    /// Server password (empty = no password).
    pub server_password: Option<String>,
}

impl Default for HubAuthConfig {
    fn default() -> Self {
        Self {
            allow_guest: true,
            default_channel: 0,
            welcome_text: None,
            server_password: None,
        }
    }
}

/// Hub registry configuration for edge authentication.
#[derive(Debug, Clone, Deserialize)]
pub struct HubRegistryConfig {
    /// HMAC secret for edge authentication.
    pub hmac_secret: Option<String>,
    /// Heartbeat timeout in milliseconds.
    #[serde(default = "default_heartbeat_timeout")]
    pub heartbeat_timeout: u64,
}

impl Default for HubRegistryConfig {
    fn default() -> Self {
        Self {
            hmac_secret: None,
            heartbeat_timeout: 90000,
        }
    }
}

/// Load hub configuration from a JSON file.
pub fn load_hub_config(path: &str) -> Result<HubConfig, anyhow::Error> {
    let content = std::fs::read_to_string(path)?;
    let config: HubConfig = serde_json::from_str(&content)?;
    Ok(config)
}

fn default_host() -> String {
    "0.0.0.0".to_string()
}
fn default_port() -> u16 {
    64738
}
fn default_hub_port() -> u16 {
    8443
}
fn default_reconnect_interval() -> u64 {
    5000
}
fn default_heartbeat_interval() -> u64 {
    30000
}
fn default_heartbeat_timeout() -> u64 {
    90000
}
fn default_capacity() -> u32 {
    1000
}
fn default_max_bandwidth() -> u32 {
    558
}
fn default_log_level() -> String {
    "info".to_string()
}
fn default_db_path() -> String {
    "data/munode.db".to_string()
}
fn default_true() -> bool {
    true
}
