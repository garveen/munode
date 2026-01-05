// @ts-check

/**
 * Hub Server Configuration
 *
 * This is the main configuration file for the MuNode Hub Server.
 * The Hub Server manages the distributed Mumble server cluster.
 *
 * @type {import('../packages/hub-server/src/types.js').HubConfig}
 */
export default {
  // Server identification
  server_id: 0,
  name: 'MuNode Hub Server',
  register_name: 'MuNode Server', // Display name for root channel

  // Network configuration
  host: '0.0.0.0',
  port: 64739,
  control_port: 8443, // Control channel port for Edge connections

  // TLS/SSL configuration
  tls: {
    cert: './certs/hub-cert.pem',
    key: './certs/hub-key.pem',
    ca: './certs/ca.pem',
    require_client_cert: true,
    reject_unauthorized: false,
  },

  // Database configuration
  database: {
    path: './data/hub.db',
    backup_dir: './data/backups',
    backup_interval: 86400, // seconds
    wal_mode: false, // SQLite Write-Ahead Logging mode
  },

  // Blob storage configuration (for avatars, textures, etc.)
  blob_store: {
    enabled: true,
    path: './data/blobs',
  },

  // Edge server registry configuration
  registry: {
    heartbeat_interval: 30, // seconds
    timeout: 90, // seconds
    max_edges: 100,

    // HMAC challenge-response authentication
    hmac_secret: 'change-this-to-a-secure-random-string', // Shared secret for Edge authentication
    challenge_timeout: 60000, // Challenge timeout in milliseconds (60 seconds)
    enable_auth: true, // Enable HMAC authentication (default: true)
  },

  // Web API configuration
  web_api: {
    enabled: false,
    host: '127.0.0.1',
    port: 8080,
    cors: true,
  },

  // Server behavior
  timeout: 30, // Client timeout in seconds
  max_users: 1000,
  max_users_per_channel: 0, // 0 = unlimited
  channel_nesting_limit: 10,
  channel_count_limit: 1000,

  // Bandwidth and message limits
  bandwidth: 558000, // bits per second per user
  text_message_length: 5000,
  image_message_length: 131072, // 128 KB
  message_limit: 1, // messages per second
  message_burst: 5, // burst capacity
  plugin_message_limit: 4,
  plugin_message_burst: 15,

  // Security and authentication
  kdf_iterations: -1, // -1 = auto benchmark
  allow_html: true,
  force_external_auth: false,
  obfuscate: false,
  cert_required: false, // Require client certificate to connect (enforced by Edge servers after first auth)

  // Username and channel name validation
  username_regex: '[ -=\\w\\[\\]\\{\\}\\(\\)\\@\\|\\.]+',
  channel_name_regex: '[ -=\\w\\#\\[\\]\\{\\}\\(\\)\\@\\|]+',


  // Auto-ban configuration
  auto_ban: {
    attempts: 10,
    timeframe: 120, // seconds
    duration: 300, // seconds
    ban_successful_connections: true,
  },

  // Channel behavior
  default_channel: 0, // Default channel ID (0 = Root)
  remember_channel: true,
  remember_channel_duration: 0, // 0 = forever

  // Client suggestions
  suggest: {
    version: '1.4.0',
    positional: null, // null = don't suggest
    push_to_talk: null,
  },

  // Server registration (for public server list)
  // register_password: 'your-password',
  // register_hostname: 'mumble.example.com',
  // register_location: 'Global',
  // register_url: 'https://example.com',
  bonjour: false, // Zeroconf/Bonjour local network discovery

  // Advanced features
  listeners_per_channel: 0, // 0 = unlimited
  listeners_per_user: 0, // 0 = unlimited
  broadcast_listener_volume_adjustments: false,
  allow_recording: true,
  send_version: true,
  allow_ping: true,
  hide_cert_hashes: false,
  channel_ninja: false, // Hide users in channels without view permission
  ninja_channels: [], // Array of channel IDs that are ninja channels. Users without Enter/Listen permission cannot see users in these channels.

  // Database log retention
  log_days: 31,

  // Authentication configuration (optional)
  // Uncomment one of the following options to enable authentication:
  //
  // auth: {
  //   // Option 1: Use a callback function for authentication (Recommended)
  //   // This gives you full control over the authentication logic
  //   callback: async (request) => {
  //     const { username, password, tokens, session_id, server_id,
  //             ip_address, ip_version, release, version, os, os_version,
  //             certificate_hash } = request;
  //
  //     // Your custom authentication logic here
  //     // Example: check against a database
  //     if (username === 'admin' && password === 'secret') {
  //       return {
  //         success: true,
  //         user_id: 1,
  //         username: 'admin',
  //         displayName: 'Administrator',
  //         groups: ['admin', 'user'],
  //       };
  //     }
  //
  //     return {
  //       success: false,
  //       reason: 'Invalid credentials',
  //       rejectType: 2, // WrongUserPW
  //     };
  //   },
  //   cache_ttl: 300000, // optional
  //   allow_cache_fallback: false, // optional
  // },
  //
  // // OR Option 2: Use HTTP API for authentication
  // auth: {
  //   api_url: 'https://auth.example.com/api/mumble/authenticate',
  //   api_key: 'your-secret-api-key',
  //   timeout: 5000,
  //   content_type: 'application/json', // or 'application/x-www-form-urlencoded'
  //   method: 'POST', // or 'GET'
  //   cache_ttl: 300000,
  //   pull_interval: 60000,
  //   track_sessions: false,
  //   allow_cache_fallback: true,
  //   headers: {
  //     auth_header_name: 'Authorization',
  //     auth_header_format: 'Bearer {apiKey}',
  //   },
  //   response_fields: {
  //     success_field: 'success',
  //     user_id_field: 'user_id',
  //     username_field: 'username',
  //     display_name_field: 'displayName',
  //     groups_field: 'groups',
  //     reason_field: 'reason',
  //   },
  // },

  // Logging configuration
  log_level: 'info',
  log_file: './logs/hub.log',

  // Voice routing configuration (Edge-to-Edge relay routing feature)
  voice_routing: {
    enabled: false, // Global feature switch

    // Routing policy
    policy: {
      // Direct connection thresholds
      direct_rtt_threshold: 500, // Direct RTT limit (ms), default: 500
      direct_loss_threshold: 0.05, // Direct packet loss limit, default: 0.05

      // Relay conditions
      enable_relay: true, // Enable relay, default: true
      max_relay_hops: 1, // Maximum relay hops, default: 1
      relay_cost_factor: 1.2, // Relay cost factor, default: 1.2 (20% higher than direct)

      // Route switching
      route_switch_hysteresis: 5000, // Switching hysteresis time (ms), default: 5000
      route_switch_cost_delta: 0.3, // Switching cost difference threshold, default: 0.3 (30%)

      // Load balancing
      max_relay_load_per_edge: 0.7, // Maximum relay load per Edge, default: 0.7

      // Quality probing
      network_probe_interval: 10000, // Hub-side network probe interval (ms), default: 10000

      // Route table updates
      route_table_update_interval: 30000, // Hub pushes route table interval (ms), default: 30000
    },

    // Preferred relay nodes (optional, auto-selected if empty)
    preferred_relay_edges: [],

    // Hub relay configuration
    hub_relay: {
      enable_tcp_fallback: false, // use edge-hub tcp websocket link for voice relay as last choice
    },

    // Routing optimization debugging
    debug: {
      log_route_changes: false, // Log route changes
      log_quality_metrics: false, // Log quality metrics
      log_relay_stats: false, // Log relay statistics
    },
  },
};
