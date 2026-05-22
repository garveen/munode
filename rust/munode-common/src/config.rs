use anyhow::Context;
use serde::Deserialize;

/// Web API configuration for the Edge server.
#[derive(Debug, Clone, Deserialize)]
pub struct EdgeWebApiConfig {
    /// Enable the Web API HTTP server.
    #[serde(default)]
    pub enabled: bool,
    /// HTTP listening port for the Web API.
    #[serde(default = "default_edge_web_api_port")]
    pub port: u16,
    /// HTTP listening host for the Web API.
    #[serde(default = "default_host")]
    pub host: String,
    /// Optional bearer token required for every Web API request.  When set,
    /// each request must include `Authorization: Bearer <token>`.  Strongly
    /// recommended whenever the API listens on a non-loopback address: the
    /// API exposes per-session metadata (usernames, IPs, channel state) that
    /// must not leak to anonymous remote callers.
    ///
    /// Leaving this unset trusts every caller — appropriate only when `host`
    /// is bound to `127.0.0.1` / `::1` or to a private management interface.
    #[serde(default)]
    pub api_token: Option<String>,
}

impl Default for EdgeWebApiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_edge_web_api_port(),
            host: default_host(),
            api_token: None,
        }
    }
}

/// TLS mode for the browser WebSocket listener.
///
/// Controls whether the WebSocket listener itself terminates TLS, and what URL
/// scheme it advertises in the `GET /edge-info` discovery response.
///
/// | Mode     | Bind transport | Advertised scheme | Typical use |
/// |----------|----------------|-------------------|-------------|
/// | `plain`  | plain TCP      | `ws://`            | local dev, internal network |
/// | `proxy`  | plain TCP      | `wss://`           | behind nginx/Caddy TLS proxy |
/// | `native` | TLS (Edge terminates) | `wss://`  | direct internet, no proxy |
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WsTlsMode {
    /// Plain `ws://` — no TLS.  Only safe on loopback or private networks.
    Plain,
    /// Plain TCP bind, but advertise `wss://` because a TLS reverse proxy
    /// (nginx, Caddy, HAProxy, …) sits in front and handles the certificate.
    Proxy,
    /// Edge serves TLS directly.  Uses the WebTransport cert/key if set,
    /// otherwise falls back to the main `tls.cert` / `tls.key` pair.
    #[default]
    Native,
}

impl WsTlsMode {
    /// Returns `true` when the Edge should terminate TLS on the WS socket.
    pub fn is_native_tls(&self) -> bool {
        *self == WsTlsMode::Native
    }

    /// Returns the URL scheme browsers should use to connect.
    pub fn ws_scheme(&self) -> &'static str {
        match self {
            WsTlsMode::Plain => "ws",
            WsTlsMode::Proxy | WsTlsMode::Native => "wss",
        }
    }
}

/// WebTransport listener configuration.
///
/// When `enabled = true`, the Edge starts a WebTransport (QUIC/HTTP3) listener on
/// the given host+port.  Browser-based Mumble clients connect via
/// `https://<external_host>:<external_port>` using the WebTransport API.
///
/// WebTransport uses the same Mumble wire format as TCP/TLS (`[type:u16][len:u32][payload]`)
/// on a single bidirectional QUIC stream.  OCB2-AES128 UDP encryption is **skipped** because
/// QUIC provides TLS 1.3 AEAD for every datagram; no CryptSetup message is sent.
///
/// When `ws_fallback_enabled = true`, an additional plain WebSocket listener is started on
/// `ws_fallback_port`.  This serves browsers whose WebTransport support is blocked by
/// enterprise proxies.  The same frame format is used over WebSocket binary messages.
#[derive(Debug, Clone, Deserialize)]
pub struct WebtransportConfig {
    /// Enable the WebTransport listener.
    #[serde(default)]
    pub enabled: bool,
    /// Bind address for the WebTransport listener.
    #[serde(default = "default_host")]
    pub host: String,
    /// UDP/QUIC port for WebTransport (default: 64740).
    #[serde(default = "default_wt_port")]
    pub port: u16,
    /// External hostname advertised to connecting clients and reported to Hub.
    /// When unset, `network.external_host` is used.
    pub external_host: Option<String>,
    /// External port (e.g. after DNAT).  When unset, `port` is used.
    pub external_port: Option<u16>,
    /// Path to TLS certificate PEM file for WebTransport.
    /// When unset, the Edge's main TLS certificate (`tls.cert`) is used.
    /// **Note:** WebTransport requires a publicly-trusted certificate (or a short-lived
    /// self-signed cert with `serverCertificateHashes` in the browser API call).
    pub cert: Option<String>,
    /// Path to TLS private key PEM file for WebTransport.
    /// When unset, `tls.key` is used.
    pub key: Option<String>,
    /// Advertise the WebTransport endpoint in the Mumble `ServerConfig` message.
    /// Disable this to run a stealth WebTransport endpoint not visible to clients.
    #[serde(default = "default_true")]
    pub advertise: bool,
    /// Maximum bidirectional QUIC streams per connection.
    /// 4 = 1 control stream + 3 spare blob transfer streams (see §4.2 of the design doc).
    #[serde(default = "default_wt_max_streams")]
    pub max_streams: u64,
    /// How often to check for updated certificate files on disk (seconds).
    /// 0 = never reload. Default: 86400 (daily).
    #[serde(default = "default_cert_reload_interval")]
    pub cert_reload_interval_secs: u64,
    /// Enable the browser HTTP info + WebSocket listener.
    ///
    /// On a single TCP port this listener serves:
    ///   * `GET /edge-info` — discovery JSON for browser clients (returns the
    ///     resolved WebSocket URL, future WebTransport address, server name, …).
    ///   * WebSocket upgrade (`GET /mumble`) — Mumble frames inside binary
    ///     WebSocket messages (no OCB2; transport security expected to come
    ///     from a TLS reverse proxy in production).
    ///
    /// Default: `true` — required for browser clients to discover and connect.
    #[serde(default = "default_true")]
    pub ws_fallback_enabled: bool,
    /// Bind address for the browser HTTP/WebSocket listener.
    #[serde(default = "default_host")]
    pub ws_fallback_host: String,
    /// TCP port for the browser HTTP/WebSocket listener.
    /// When unset, defaults to `network.port + 2`. The same port number is also
    /// used for the WebTransport UDP/QUIC listener (UDP and TCP share port spaces).
    pub ws_fallback_port: Option<u16>,
    /// TLS mode for the WebSocket listener.
    ///
    /// - `"plain"` (default) — plain `ws://`, no TLS (dev / internal networks)
    /// - `"proxy"` — plain TCP bind but advertise `wss://` (TLS terminated by
    ///   an upstream reverse proxy such as nginx or Caddy)
    /// - `"native"` — Edge terminates TLS directly and serves `wss://`;
    ///   uses `webtransport.cert`/`key` when set, otherwise falls back to
    ///   the main `tls.cert`/`tls.key` pair
    #[serde(default)]
    pub ws_tls_mode: WsTlsMode,
}

impl Default for WebtransportConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: default_host(),
            port: default_wt_port(),
            external_host: None,
            external_port: None,
            cert: None,
            key: None,
            advertise: true,
            max_streams: default_wt_max_streams(),
            cert_reload_interval_secs: default_cert_reload_interval(),
            ws_fallback_enabled: true,
            ws_fallback_host: default_host(),
            ws_fallback_port: None,
            ws_tls_mode: WsTlsMode::Native,
        }
    }
}

impl WebtransportConfig {
    /// Resolve the effective TCP port for the browser HTTP/WebSocket listener.
    ///
    /// Returns the configured `ws_fallback_port` when set, otherwise falls back
    /// to `main_port + 2` so a single Edge instance occupies a contiguous slot
    /// of three TCP/UDP port numbers (`+0` Mumble, `+1` Edge-to-Edge,
    /// `+2` browser HTTP/WS and WebTransport UDP).
    pub fn effective_ws_port(&self, main_port: u16) -> u16 {
        self.ws_fallback_port
            .unwrap_or_else(|| main_port.saturating_add(2))
    }
}

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
    /// Voice routing configuration.
    #[serde(default)]
    pub voice_routing: EdgeVoiceRoutingConfig,
    /// Web API configuration.
    #[serde(default)]
    pub web_api: EdgeWebApiConfig,
    /// WebTransport (QUIC/HTTP3) listener configuration.
    #[serde(default)]
    pub webtransport: WebtransportConfig,
    /// Logging level.
    #[serde(default = "default_log_level")]
    pub log_level: String,
    /// Logging format: "text" (default) or "json" (structured JSON for log aggregation).
    #[serde(default = "default_log_format")]
    pub log_format: String,
}

fn default_log_format() -> String {
    "text".to_string()
}

/// Relay configuration for the Edge acting as a relay node.
#[derive(Debug, Clone, Deserialize)]
pub struct EdgeVoiceRelayConfig {
    /// Whether this Edge accepts Hub-mediated relay requests.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for EdgeVoiceRelayConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// Quality probing configuration for Edge-to-Edge UDP links.
#[derive(Debug, Clone, Deserialize)]
pub struct EdgeVoiceQualityConfig {
    /// Interval between active UDP probe pings to each peer Edge.
    #[serde(default = "default_quality_probe_interval_secs")]
    pub probe_interval_secs: u64,
    /// Interval between Edge → Hub quality reports.
    #[serde(default = "default_quality_report_interval_secs")]
    pub report_interval_secs: u64,
    /// Timeout after which an unanswered probe is counted as lost.
    #[serde(default = "default_quality_probe_timeout_secs")]
    pub probe_timeout_secs: u64,
    /// Rolling observation window size for local quality statistics.
    #[serde(default = "default_quality_sample_window_size")]
    pub sample_window_size: usize,
}

impl Default for EdgeVoiceQualityConfig {
    fn default() -> Self {
        Self {
            probe_interval_secs: default_quality_probe_interval_secs(),
            report_interval_secs: default_quality_report_interval_secs(),
            probe_timeout_secs: default_quality_probe_timeout_secs(),
            sample_window_size: default_quality_sample_window_size(),
        }
    }
}

/// Voice routing configuration for the Edge server.
#[derive(Debug, Clone, Deserialize)]
pub struct EdgeVoiceRoutingConfig {
    /// Enable voice routing (default: true).
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Whether to use Hub TCP relay as last resort when all other paths fail.
    #[serde(default = "default_true")]
    pub enable_hub_tcp_fallback: bool,
    /// Number of consecutive UDP send failures to a next-hop before skipping it and
    /// trying the next route candidate.  This provides fast local failover without
    /// waiting for the Hub to update the route table.  The counter is reset when a
    /// send succeeds or when a quality probe pong is received from that peer.
    /// Set to 0 to disable local failover (rely solely on Hub route table updates).
    #[serde(default = "default_consecutive_failure_threshold")]
    pub consecutive_failure_threshold: u32,
    /// Number of parallel TCP voice connections to maintain to each peer Edge.
    /// `1` disables pooling; values `> 1` spawn multiple independent connections
    /// for improved reliability — if one TCP path fails the others continue carrying
    /// voice until the failed connection reconnects.  Default: 2.
    #[serde(default = "default_peer_voice_tcp_pool_size")]
    pub peer_voice_tcp_pool_size: u32,
    /// UDP link-quality probe and reporting configuration.
    #[serde(default)]
    pub quality: EdgeVoiceQualityConfig,
    /// Relay node configuration.
    #[serde(default)]
    pub relay: EdgeVoiceRelayConfig,
}

impl Default for EdgeVoiceRoutingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            enable_hub_tcp_fallback: true,
            consecutive_failure_threshold: default_consecutive_failure_threshold(),
            peer_voice_tcp_pool_size: default_peer_voice_tcp_pool_size(),
            quality: EdgeVoiceQualityConfig::default(),
            relay: EdgeVoiceRelayConfig::default(),
        }
    }
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
    /// Enable PROXY Protocol support (v1 and v2) for connections behind nginx/HAProxy.
    /// When enabled, the real client IP is extracted from the PROXY Protocol header
    /// instead of the TCP peer address. Requires the upstream proxy to be configured
    /// to send PROXY Protocol headers. All direct (non-proxied) connections will be
    /// rejected when this is enabled.
    #[serde(default)]
    pub proxy_protocol: bool,
    /// Allow-list of TCP peer IP addresses that are permitted to send PROXY Protocol
    /// headers.  Connections from any other peer IP have their PROXY header parsing
    /// skipped (the TCP peer address is used directly).
    ///
    /// Each entry may be either a single IP (`"127.0.0.1"`, `"::1"`) or a CIDR block
    /// (`"10.0.0.0/8"`, `"fd00::/8"`).  An empty / unset list trusts every peer
    /// (unchanged behaviour, matching pre-hardening deployments).
    ///
    /// Strongly recommended whenever `proxy_protocol = true` and the listening port
    /// is reachable from networks other than the upstream proxy: without an allow-list
    /// a malicious direct client can spoof its source IP for logging, geoip, and
    /// audit-trail purposes by simply prefixing a forged PROXY header.
    #[serde(default)]
    pub trusted_proxy_ips: Vec<String>,
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

/// A statically configured peer Edge for control-channel relay bootstrap.
///
/// Used when the local Edge cannot reach Hub at startup.  The peer Edge's
/// `/relay` WebSocket endpoint is tried as a transparent Hub relay before
/// falling back to a permanent error.
#[derive(Debug, Clone, Deserialize)]
pub struct StaticPeerConfig {
    /// Hostname or IP of the peer Edge.
    pub host: String,
    /// Legacy field name: port of the peer Edge's `/relay` WebSocket listener.
    ///
    /// In the current implementation the relay/voice WebSocket server listens
    /// on the peer's `network.edge_port`, so this value should normally be set
    /// to the peer Edge's `edge_port`.
    pub relay_port: u16,
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
    /// Number of parallel WebSocket connections to maintain to the Hub (connection pool).
    /// `1` (default) disables pooling.  Values `> 1` enable pool mode for improved
    /// resilience: RPC requests are distributed across connections in round-robin order,
    /// and Hub-to-Edge push notifications are only processed on the primary connection.
    #[serde(default = "default_pool_size")]
    pub pool_size: u32,
    /// Statically configured peer Edges used as relay fallback during Hub-unreachable
    /// startup. These act as seed peers and are tried **before**
    /// dynamically-discovered peers (from `hub.peerJoined` notifications).
    ///
    /// Each entry's `relay_port` should point at the peer Edge's actual
    /// `/relay` listener port, which in current builds is usually the peer's
    /// `network.edge_port`.
    #[serde(default)]
    pub static_peers: Vec<StaticPeerConfig>,
    /// Whether to connect to the Hub over TLS (`wss://` instead of `ws://`).
    /// Defaults to `false` (plain WebSocket) for backward compatibility.
    /// Enable this when the Hub is behind a TLS terminator or when Hub and Edge
    /// are on separate networks.
    #[serde(default)]
    pub tls: bool,
}

/// Server capacity and behavior configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    /// Maximum number of connected users.
    #[serde(default = "default_capacity")]
    pub capacity: u32,
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
    /// Maximum control messages per second per user (token bucket).  Mirrors
    /// Murmur's `messagelimit` and applies to TextMessage, UserState,
    /// ChannelState, ContextAction and UserStats.  0 = unlimited.
    #[serde(default = "default_message_rate")]
    pub message_rate: f32,
    /// Token bucket burst size for control messages (default: 5, matching
    /// Murmur's `messageburst`).
    #[serde(default = "default_message_burst")]
    pub message_burst: u32,
    /// Maximum plugin data message length in bytes (default: 1024). 0 = unlimited.
    #[serde(default = "default_plugin_message_length")]
    pub plugin_message_length: u32,
    /// Maximum plugin data messages per second per user (token bucket).
    /// Mirrors Murmur's `pluginmessagelimit`.  0 = unlimited.
    #[serde(default = "default_plugin_message_rate")]
    pub plugin_message_rate: f32,
    /// Token bucket burst size for plugin data messages (default: 15,
    /// matching Murmur's `pluginmessageburst`).
    #[serde(default = "default_plugin_message_burst")]
    pub plugin_message_burst: u32,
    /// Maximum number of channels a user can listen to simultaneously. 0 = unlimited.
    #[serde(default)]
    pub listeners_per_user: u32,
    /// Maximum number of listeners per channel. 0 = unlimited.
    #[serde(default)]
    pub listeners_per_channel: u32,
    /// Whether to respond to unauthenticated UDP ping probes (default: true).
    /// Set to false to prevent the server from being listed in public server browsers.
    #[serde(default = "default_true")]
    pub allow_ping: bool,
    /// Rolling statistics window size in seconds for voice quality metrics (default: 120).
    /// Controls how many seconds of OCB2 crypto stats are tracked per user.
    #[serde(default = "default_rolling_stats_window")]
    pub rolling_stats_window: u32,
    /// Maximum voice bandwidth per user in bits-per-second (default: 0 = use max_bandwidth).
    /// BandwidthRecord tracks per-user voice bandwidth usage in this sliding window.
    #[serde(default)]
    pub bandwidth_record_window: u32,
    /// Whether to allow users to record audio (default: true).
    /// When false, ServerConfig.recording_allowed is sent as false to clients,
    /// and any user who tries to set recording=true receives a PermissionDenied
    /// response (the request is rejected but the user is not disconnected).
    #[serde(default = "default_true")]
    pub recording_allowed: bool,
    /// Whether to allow HTML in text messages (default: true).
    /// When false, HTML tags are stripped from messages before forwarding.
    #[serde(default = "default_true")]
    pub allow_html: bool,
    /// Seconds a client has to complete authentication before being disconnected (default: 30).
    /// 0 = no pre-auth timeout (falls back to idle timeout).
    #[serde(default = "default_auth_timeout_secs")]
    pub auth_timeout_secs: u64,
    /// Idle timeout in seconds for authenticated client connections (default: 30).
    /// Mirrors Murmur's `timeout` setting.  Connections that send no data for this
    /// duration are considered zombie connections and are closed.  0 = no timeout.
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            capacity: default_capacity(),
            default_channel: 0,
            welcome_text: None,
            disable_hub_relay: false,
            text_message_length: default_text_message_length(),
            image_message_length: default_image_message_length(),
            message_rate: default_message_rate(),
            message_burst: default_message_burst(),
            plugin_message_length: default_plugin_message_length(),
            plugin_message_rate: default_plugin_message_rate(),
            plugin_message_burst: default_plugin_message_burst(),
            listeners_per_user: 0,
            listeners_per_channel: 0,
            allow_ping: true,
            rolling_stats_window: default_rolling_stats_window(),
            bandwidth_record_window: 0,
            recording_allowed: true,
            allow_html: true,
            auth_timeout_secs: default_auth_timeout_secs(),
            idle_timeout_secs: default_idle_timeout_secs(),
        }
    }
}

/// Load edge configuration from a TOML or JSON file (detected by extension).
pub fn load_edge_config(path: &str) -> Result<EdgeConfig, anyhow::Error> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read edge config file: {}", path))?;
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
    /// Web API configuration.
    #[serde(default)]
    pub web_api: HubWebApiConfig,
    /// Blob store configuration.
    #[serde(default)]
    pub blob_store: HubBlobStoreConfig,
    /// Voice routing policy configuration.
    #[serde(default)]
    pub voice_routing: HubVoiceRoutingConfig,
    /// Channel Ninja configuration.
    #[serde(default)]
    pub channel_ninja: HubChannelNinjaConfig,
    /// GeoIP configuration (optional IP geolocation).
    #[serde(default)]
    pub geoip: HubGeoIpConfig,
    /// Logging level.
    #[serde(default = "default_log_level")]
    pub log_level: String,
    /// Logging format: "text" (default) or "json" (structured JSON for log aggregation).
    #[serde(default = "default_log_format")]
    pub log_format: String,
}

/// Channel Ninja configuration.
///
/// When enabled, users who lack both Enter AND Listen permission on a channel
/// will not see that channel or its occupants.  This hides privileged channels
/// from unprivileged users entirely.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct HubChannelNinjaConfig {
    /// Enable Channel Ninja feature.
    #[serde(default)]
    pub enabled: bool,
    /// Channel IDs that are ninja channels.  Only used when `enabled` is true.
    #[serde(default)]
    pub ninja_channels: Vec<u32>,
}

/// Hub-side voice routing policy configuration.
///
/// Controls how the Hub mediates cross-Edge voice relay when Edges cannot
/// establish direct connections.
#[derive(Debug, Clone, Deserialize)]
pub struct HubVoiceRoutingConfig {
    /// Enable Hub-mediated voice relay (default: true).
    /// When false, `edge.relayVoiceViaTcp` RPC calls are rejected.
    #[serde(default = "default_true")]
    pub enable_hub_tcp_relay: bool,
    /// Maximum number of simultaneous relay streams per Edge pair.
    /// 0 = unlimited.
    #[serde(default)]
    pub max_relay_streams_per_pair: u32,
    /// Hard cap on total simultaneous relay streams on the Hub (0 = unlimited).
    #[serde(default)]
    pub max_total_relay_streams: u32,
    /// Cost factor applied to relay routes vs. direct routes when suggesting
    /// routing to Edges.  Higher values discourage relay use.
    #[serde(default = "default_relay_cost_factor")]
    pub relay_cost_factor: f32,
    /// RTT threshold (ms) below which direct routes are preferred over relay.
    #[serde(default = "default_direct_rtt_threshold")]
    pub direct_rtt_threshold: u32,
    /// Packet loss threshold (0.0–1.0) below which direct routes are preferred.
    #[serde(default = "default_direct_loss_threshold")]
    pub direct_loss_threshold: f32,
    /// Packet loss rate above which a link is considered degraded.
    #[serde(default = "default_degraded_packet_loss")]
    pub degraded_packet_loss: f64,
    /// Packet loss rate above which a link is removed from path calculation.
    #[serde(default = "default_failed_packet_loss")]
    pub failed_packet_loss: f64,
    /// RTT (ms) above which a link is considered degraded.
    #[serde(default = "default_degraded_rtt_ms")]
    pub degraded_rtt_ms: f64,
    /// RTT (ms) above which a link is removed from path calculation.
    #[serde(default = "default_failed_rtt_ms")]
    pub failed_rtt_ms: f64,
    /// Number of consecutive report cycles a recovered link must pass before being used.
    #[serde(default = "default_recovery_report_count")]
    pub recovery_report_count: u32,
    /// Minimum cost improvement (ms) before updating route table.
    #[serde(default = "default_min_improvement_ms")]
    pub min_improvement_ms: f32,
    /// Penalty per relay hop (ms).
    #[serde(default = "default_relay_hop_penalty_ms")]
    pub relay_hop_penalty_ms: f64,
    /// Maximum relay hops; chains longer than this fall back to HubTcp.
    #[serde(default = "default_max_relay_hops")]
    pub max_relay_hops: usize,
    /// Penalty (ms) for using Edge-to-Edge TCP vs UDP (accounts for connection overhead).
    #[serde(default = "default_edge_tcp_penalty_ms")]
    pub edge_tcp_penalty_ms: f64,
    /// Extra penalty (ms) for using HubTcp instead of DirectTcp.
    /// Hub relay is the last-resort path, so it should sort behind DirectTcp for
    /// the same destination even when route candidates are ordered purely by cost.
    #[serde(default = "default_hub_tcp_penalty_ms")]
    pub hub_tcp_penalty_ms: f64,
    /// Cluster-wide TTL cap for relay packets pushed to every Edge in `routeTableUpdate`.
    /// Edges clamp relay-packet TTL to this value.  Default 4.
    #[serde(default = "default_max_ttl")]
    pub max_ttl: u32,
}

impl Default for HubVoiceRoutingConfig {
    fn default() -> Self {
        Self {
            enable_hub_tcp_relay: true,
            max_relay_streams_per_pair: 0,
            max_total_relay_streams: 0,
            relay_cost_factor: default_relay_cost_factor(),
            direct_rtt_threshold: default_direct_rtt_threshold(),
            direct_loss_threshold: default_direct_loss_threshold(),
            degraded_packet_loss: default_degraded_packet_loss(),
            failed_packet_loss: default_failed_packet_loss(),
            degraded_rtt_ms: default_degraded_rtt_ms(),
            failed_rtt_ms: default_failed_rtt_ms(),
            recovery_report_count: default_recovery_report_count(),
            min_improvement_ms: default_min_improvement_ms(),
            relay_hop_penalty_ms: default_relay_hop_penalty_ms(),
            max_relay_hops: default_max_relay_hops(),
            edge_tcp_penalty_ms: default_edge_tcp_penalty_ms(),
            hub_tcp_penalty_ms: default_hub_tcp_penalty_ms(),
            max_ttl: default_max_ttl(),
        }
    }
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
    /// Path to a file containing the welcome text (MOTD).
    /// If both `welcome_text` and `welcome_text_file` are set, the file takes precedence.
    pub welcome_text_file: Option<String>,
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
            welcome_text_file: None,
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
    /// Maximum per-client bandwidth in bits per second. 0 = unlimited.
    #[serde(default = "default_max_bandwidth")]
    pub max_bandwidth: u32,
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
    /// Maximum plugin data message length in bytes (default: 1024). 0 = unlimited.
    #[serde(default = "default_plugin_message_length")]
    pub plugin_message_length: u32,
    /// Maximum number of channel listeners per channel. 0 = unlimited.
    #[serde(default)]
    pub listeners_per_channel: u32,
    /// Maximum number of channels a single user may listen to at once. 0 = unlimited.
    #[serde(default)]
    pub listeners_per_user: u32,
    /// Maximum channel nesting depth. 0 = unlimited.
    #[serde(default)]
    pub channel_nesting_limit: u32,
    /// Maximum total number of channels. 0 = unlimited.
    #[serde(default)]
    pub channel_count_limit: u32,
    /// Maximum number of simultaneous sessions allowed for the same non-anonymous user.
    /// When the limit is reached the oldest session is kicked to make room for the new one.
    /// 0 = unlimited. Default: 1.
    #[serde(default = "default_max_sessions_per_user")]
    pub max_sessions_per_user: u32,
    /// Whether to respond to unauthenticated UDP ping probes (default: true).
    /// Set to false to prevent the server from appearing in public server browsers.
    #[serde(default = "default_true")]
    pub allow_ping: bool,
}

impl Default for HubLimitsConfig {
    fn default() -> Self {
        Self {
            max_users: default_max_users(),
            max_users_per_channel: 0,
            max_bandwidth: default_max_bandwidth(),
            text_message_length: default_text_message_length(),
            image_message_length: default_image_message_length(),
            message_rate: default_message_rate(),
            message_burst: default_message_burst(),
            plugin_message_length: default_plugin_message_length(),
            listeners_per_channel: 0,
            listeners_per_user: 0,
            channel_nesting_limit: 0,
            channel_count_limit: 0,
            max_sessions_per_user: default_max_sessions_per_user(),
            allow_ping: true,
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
#[derive(Debug, Clone, Deserialize, Default)]
pub struct HubSuggestConfig {
    /// Suggested client version string (e.g. "1.3.4").
    /// Parsed to v1 (major<<16|minor<<8|patch) and v2 (major<<48|minor<<32|patch<<16) at send time.
    pub version: Option<String>,
    /// Suggest positional audio.
    pub positional: Option<bool>,
    /// Suggest push-to-talk.
    pub push_to_talk: Option<bool>,
}

impl HubSuggestConfig {
    /// Parse version string to (v1: u32, v2: u64).
    /// v1 format: major<<16 | minor<<8 | patch  (major up to 65535, minor/patch up to 255)
    /// v2 format: major<<48 | minor<<32 | patch<<16  (all components up to 65535)
    /// Matches C++ Version::toLegacyVersion() and Version::fromComponents() semantics.
    pub fn parse_version(&self) -> Option<(u32, u64)> {
        let s = self.version.as_deref()?;
        let parts: Vec<&str> = s.splitn(4, '.').collect();
        if parts.len() < 3 {
            return None;
        }
        let major = parts[0].parse::<u64>().ok()?;
        let minor = parts[1].parse::<u64>().ok()?;
        let patch = parts[2].parse::<u64>().ok()?;
        // Cap each component to its field width so bit-shifts never overflow.
        // v2 format: major(16) | minor(16) | patch(16) in the top 48 bits.
        // Silently cap at the maximum representable value; values beyond 65535
        // are not used in any known Mumble client version string.
        let major_capped = major.min(0xFFFF);
        let minor_capped = minor.min(0xFFFF);
        let patch_capped = patch.min(0xFFFF);
        // v2: full precision (16 bits each, top 48 bits of a u64)
        let v2: u64 = (major_capped << 48) | (minor_capped << 32) | (patch_capped << 16);
        // v1 legacy: major capped at u16::MAX, minor/patch capped at u8::MAX
        let v1: u32 = ((major_capped.min(0xFFFF) as u32) << 16)
            | ((minor_capped.min(0xFF) as u32) << 8)
            | (patch_capped.min(0xFF) as u32);
        Some((v1, v2))
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
            heartbeat_timeout: 30000,
        }
    }
}

/// Web API configuration for the Hub server.
#[derive(Debug, Clone, Deserialize)]
pub struct HubWebApiConfig {
    /// Enable the Web API HTTP server.
    #[serde(default)]
    pub enabled: bool,
    /// HTTP listening port for the Web API.
    #[serde(default = "default_web_api_port")]
    pub port: u16,
    /// HTTP listening host for the Web API.
    #[serde(default = "default_host")]
    pub host: String,
    /// Optional API key for write operations (POST, PUT, DELETE).
    /// If `None`, all write endpoints return 403 Forbidden — suitable for
    /// read-only deployments. Set a non-empty string to allow writes with
    /// `Authorization: Bearer <key>` authentication.
    #[serde(default)]
    pub api_key: Option<String>,
}

impl Default for HubWebApiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_web_api_port(),
            host: default_host(),
            api_key: None,
        }
    }
}

/// Blob store configuration for the Hub server.
#[derive(Debug, Clone, Deserialize)]
pub struct HubBlobStoreConfig {
    /// Base directory for blob files.
    /// Blobs are stored at `<path>/<hash[0..2]>/<hash>`.
    #[serde(default = "default_blob_store_path")]
    pub path: String,
}

impl Default for HubBlobStoreConfig {
    fn default() -> Self {
        Self {
            path: default_blob_store_path(),
        }
    }
}

/// Load hub configuration from a TOML or JSON file (detected by extension).
pub fn load_hub_config(path: &str) -> Result<HubConfig, anyhow::Error> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read hub config file: {}", path))?;
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
    10000
}
fn default_pool_size() -> u32 {
    1
}
fn default_heartbeat_timeout() -> u64 {
    30000
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
fn default_plugin_message_length() -> u32 {
    1024
}
fn default_message_rate() -> f32 {
    1.0
}
fn default_message_burst() -> u32 {
    5
}
fn default_plugin_message_rate() -> f32 {
    4.0
}
fn default_plugin_message_burst() -> u32 {
    15
}
fn default_max_sessions_per_user() -> u32 {
    1
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
fn default_web_api_port() -> u16 {
    8080
}
fn default_edge_web_api_port() -> u16 {
    8081
}
fn default_blob_store_path() -> String {
    "data/blobs".to_string()
}
fn default_relay_cost_factor() -> f32 {
    1.2
}
fn default_direct_rtt_threshold() -> u32 {
    200
}
fn default_direct_loss_threshold() -> f32 {
    0.05
}
fn default_consecutive_failure_threshold() -> u32 {
    2
}
fn default_degraded_packet_loss() -> f64 {
    0.10
}
fn default_failed_packet_loss() -> f64 {
    0.40
}
fn default_degraded_rtt_ms() -> f64 {
    150.0
}
fn default_failed_rtt_ms() -> f64 {
    500.0
}
fn default_recovery_report_count() -> u32 {
    3
}
fn default_min_improvement_ms() -> f32 {
    25.0
}
fn default_relay_hop_penalty_ms() -> f64 {
    5.0
}
fn default_max_relay_hops() -> usize {
    2
}
fn default_edge_tcp_penalty_ms() -> f64 {
    20.0
}
fn default_hub_tcp_penalty_ms() -> f64 {
    50.0
}
fn default_max_ttl() -> u32 {
    4
}
fn default_peer_voice_tcp_pool_size() -> u32 {
    2
}
fn default_quality_probe_interval_secs() -> u64 {
    1
}
fn default_quality_report_interval_secs() -> u64 {
    5
}
fn default_quality_probe_timeout_secs() -> u64 {
    3
}
fn default_quality_sample_window_size() -> usize {
    30
}

/// GeoIP configuration.
///
/// When a GeoLite2 database path is provided, the Hub will look up connecting
/// clients' geographic location and log it.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct HubGeoIpConfig {
    /// Path to the GeoLite2-City or GeoLite2-Country MMDB database file.
    /// If empty or not provided, GeoIP lookups are disabled.
    #[serde(default)]
    pub database_path: String,
    /// Whether to log geographic location for each connecting user.
    #[serde(default = "default_geoip_log")]
    pub log_location: bool,
}

fn default_geoip_log() -> bool {
    true
}

fn default_rolling_stats_window() -> u32 {
    120
}

fn default_auth_timeout_secs() -> u64 {
    30
}

fn default_idle_timeout_secs() -> u64 {
    30
}

fn default_wt_port() -> u16 {
    64740
}

fn default_wt_max_streams() -> u64 {
    4
}

fn default_cert_reload_interval() -> u64 {
    86400
}
