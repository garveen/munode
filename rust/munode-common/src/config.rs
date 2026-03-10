use serde::Deserialize;

/// The main Edge server configuration.
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
    /// Client suggestion configuration.
    #[serde(default)]
    pub suggest: Option<EdgeSuggestConfig>,
    /// Logging level.
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

/// Client suggestion configuration for Edge.
#[derive(Debug, Clone, Deserialize)]
pub struct EdgeSuggestConfig {
    /// Suggested client version (numeric, e.g., 1340029 for 1.3.0.29).
    pub version: Option<u32>,
    /// Suggest positional audio.
    pub positional: Option<bool>,
    /// Suggest push-to-talk.
    pub push_to_talk: Option<bool>,
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
    /// When true, skip Hub relay for cross-edge voice; only direct UDP is used.
    /// Intended for integration tests that verify Edge-to-Edge direct connection.
    #[serde(default)]
    pub disable_hub_relay: bool,
    /// Maximum text message length in bytes (default: 5000).
    #[serde(default = "default_text_message_length")]
    pub text_message_length: u32,
    /// Maximum image message length in bytes (default: 131072).
    #[serde(default = "default_image_message_length")]
    pub image_message_length: u32,
    /// Maximum text messages per second per user (token bucket). 0 = unlimited.
    #[serde(default = "default_message_rate")]
    pub message_rate: f32,
    /// Token bucket burst size for text messages (default: 5).
    #[serde(default = "default_message_burst")]
    pub message_burst: u32,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            capacity: default_capacity(),
            max_bandwidth: default_max_bandwidth(),
            default_channel: 0,
            welcome_text: None,
            disable_hub_relay: false,
            text_message_length: default_text_message_length(),
            image_message_length: default_image_message_length(),
            message_rate: default_message_rate(),
            message_burst: default_message_burst(),
        }
    }
}

/// Load edge configuration from a TOML or JSON file (detected by extension).
pub fn load_edge_config(path: &str) -> Result<EdgeConfig, anyhow::Error> {
    let content = std::fs::read_to_string(path)?;
    let config: EdgeConfig = if path.ends_with(".json") {
        serde_json::from_str(&content)?
    } else {
        toml::from_str(&content)?
    };
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
    /// Server limits (message lengths, rate limits, user counts).
    #[serde(default)]
    pub limits: HubLimitsConfig,
    /// Auto-ban configuration.
    #[serde(default)]
    pub auto_ban: HubAutoBanConfig,
    /// Client suggestion configuration (sent to connecting clients).
    #[serde(default)]
    pub suggest: HubSuggestConfig,
    /// Validation rules for usernames and channel names.
    #[serde(default)]
    pub validation: HubValidationConfig,
    /// Logging level.
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

/// Validation rules configuration.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct HubValidationConfig {
    /// Regular expression that usernames must match.
    /// When set, authentication is rejected with InvalidUsername if the name doesn't match.
    /// Uses Rust `regex` crate syntax. Example: `^[a-zA-Z][a-zA-Z0-9_]{1,29}$`
    pub username_regex: Option<String>,
    /// Regular expression that channel names must match.
    /// When set, channel creation or rename is rejected with an error if the name doesn't match.
    /// Uses Rust `regex` crate syntax. Example: `^[a-zA-Z0-9 _-]{1,60}$`
    pub channel_name_regex: Option<String>,
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
    /// WebSocket port for the external auth service (optional).
    /// When set, the Hub starts an additional WS listener on this port
    /// that TypeScript auth service instances connect to.
    pub auth_service_port: Option<u16>,
}

impl Default for HubNetworkConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            control_port: default_hub_port(),
            auth_service_port: None,
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
    /// When true and an external auth service is connected, always delegate
    /// authentication to it, bypassing local DB lookups.
    /// When false (default), the auth service is only called if one is connected;
    /// otherwise local DB auth is used as a fallback.
    #[serde(default)]
    pub require_auth_service: bool,
    /// Optional HTTP endpoint URL for external authentication.
    /// When set, the Hub sends a POST request to this URL to authenticate users.
    /// Request body: `{ "username": "...", "password": "...", "tokens": [...], "server_id": N }`
    /// Expected response: `{ "success": true/false, "user_id": N, "username": "...", "groups": [...] }`
    /// If the HTTP call fails and `require_auth_service` is false, falls back to local DB auth.
    pub http_url: Option<String>,
    /// Timeout in milliseconds for HTTP authentication requests (default: 5000).
    #[serde(default = "default_auth_timeout")]
    pub http_timeout_ms: u64,
    /// Inline Lua 5.4 script for authentication.
    ///
    /// The script must define a global `authenticate(req)` function that receives a
    /// table with all client fields and returns a result table.
    ///
    /// Fields available in `req`:
    ///   username, password, session_id, tokens, server_id,
    ///   ip, ip_version, release, version, os, osversion, certificate_hash
    ///
    /// The `authenticate` function must return a table with at least `success` (bool).
    /// On success: `{ success=true, user_id=N, username="...", display_name="...", groups={...} }`
    /// On failure: `{ success=false, reason="...", reject_type=N }`
    ///
    /// The following globals are injected by the Hub:
    ///   `http_post(url, body_table [, headers_table])` → `{ status, ok, json, body }`
    ///
    /// Evaluated before `http_url` and local DB auth, after the WebSocket auth service.
    /// Write the script inline using TOML literal multi-line strings (''' ... ''').
    pub lua_script: Option<String>,
}

impl Default for HubAuthConfig {
    fn default() -> Self {
        Self {
            allow_guest: true,
            default_channel: 0,
            welcome_text: None,
            server_password: None,
            require_auth_service: false,
            http_url: None,
            http_timeout_ms: default_auth_timeout(),
            lua_script: None,
        }
    }
}

/// Hub server limits configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HubLimitsConfig {
    /// Maximum number of users on the server. 0 = unlimited.
    #[serde(default = "default_max_users")]
    pub max_users: u32,
    /// Maximum number of users per channel. 0 = unlimited.
    #[serde(default)]
    pub max_users_per_channel: u32,
    /// Maximum text message length in bytes.
    #[serde(default = "default_text_message_length")]
    pub text_message_length: u32,
    /// Maximum image message length in bytes.
    #[serde(default = "default_image_message_length")]
    pub image_message_length: u32,
    /// Maximum text messages per second per user (token bucket). 0 = unlimited.
    #[serde(default = "default_message_rate")]
    pub message_rate: f32,
    /// Token bucket burst size for text messages.
    #[serde(default = "default_message_burst")]
    pub message_burst: u32,
}

impl Default for HubLimitsConfig {
    fn default() -> Self {
        Self {
            max_users: default_max_users(),
            max_users_per_channel: 0,
            text_message_length: default_text_message_length(),
            image_message_length: default_image_message_length(),
            message_rate: default_message_rate(),
            message_burst: default_message_burst(),
        }
    }
}

/// Auto-ban configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HubAutoBanConfig {
    /// Enable auto-ban.
    #[serde(default)]
    pub enabled: bool,
    /// Number of failed auth attempts before banning.
    #[serde(default = "default_auto_ban_attempts")]
    pub attempts: u32,
    /// Time window in seconds to count failed attempts.
    #[serde(default = "default_auto_ban_window")]
    pub time_window: u64,
    /// Ban duration in seconds. 0 = permanent.
    #[serde(default = "default_auto_ban_duration")]
    pub duration: u64,
}

impl Default for HubAutoBanConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            attempts: default_auto_ban_attempts(),
            time_window: default_auto_ban_window(),
            duration: default_auto_ban_duration(),
        }
    }
}

/// Client suggestion configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct HubSuggestConfig {
    /// Suggested client version (numeric, e.g., 1340029 for 1.3.0.29).
    pub version: Option<u32>,
    /// Suggest positional audio.
    pub positional: Option<bool>,
    /// Suggest push-to-talk.
    pub push_to_talk: Option<bool>,
}

impl Default for HubSuggestConfig {
    fn default() -> Self {
        Self {
            version: None,
            positional: None,
            push_to_talk: None,
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

/// Load hub configuration from a TOML or JSON file (detected by extension).
pub fn load_hub_config(path: &str) -> Result<HubConfig, anyhow::Error> {
    let content = std::fs::read_to_string(path)?;
    let config: HubConfig = if path.ends_with(".json") {
        serde_json::from_str(&content)?
    } else {
        toml::from_str(&content)?
    };
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
    558000
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
fn default_auth_timeout() -> u64 {
    5000
}
fn default_max_users() -> u32 {
    1000
}
fn default_text_message_length() -> u32 {
    5000
}
fn default_image_message_length() -> u32 {
    131072
}
fn default_message_rate() -> f32 {
    10.0
}
fn default_message_burst() -> u32 {
    5
}
fn default_auto_ban_attempts() -> u32 {
    10
}
fn default_auto_ban_window() -> u64 {
    120
}
fn default_auto_ban_duration() -> u64 {
    300
}
