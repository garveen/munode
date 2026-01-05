// @ts-check

/**
 * Edge Server Configuration
 *
 * This is the main configuration file for the MuNode Edge Server.
 * The Edge Server handles client connections and real-time voice/data transmission.
 *
 * @type {import('../packages/edge-server/src/types.js').EdgeConfig}
 */
export default {
  // ===== 基本信息 =====
  server_id: 1,
  name: 'MuNode Edge Server #1',
  mode: 'cluster',

  // ===== 网络配置 =====
  network: {
    host: '0.0.0.0',           // 实际监听的地址
    port: 64738,                // 实际监听的端口
    external_host: 'edge.example.com', // 用于其它edge连接的地址（公网地址/域名）
    external_port: 64738,        // 用于其它edge连接的端口（公网端口），如果未指定则使用port
    region: 'asia-east',        // Server region identifier
  },

  // ===== TLS/SSL 配置 =====
  tls: {
    cert: './data/certs/edge-cert.pem',
    key: './data/certs/edge-key.pem',
    ca: './data/certs/ca.pem',
  },

  // ===== Hub 服务器连接配置 =====
  hub_server: {
    host: 'hub.example.com',
    port: 64739,
    control_port: 8443,
    tls: {
      reject_unauthorized: false,
    },
    reconnect_interval: 5000, // milliseconds
    heartbeat_interval: 30000, // milliseconds

    // HMAC challenge-response authentication
    hmac_secret: 'change-this-to-a-secure-random-string', // Must match Hub's hmac_secret
    
    // Connection pool settings (for resilience)
    pool_size: 2,                // Number of connections in pool (1 for single connection)
  },

  // ===== 语音路由配置 =====
  voice_routing: {
    enabled: true,
    shared_secret: 'change-this-to-a-secure-random-string', // UDP 语音传输加密密钥（所有 Edge 必须相同）
    local_decision: {
      enabled: true,
      update_interval: 5000,
      quality_check_interval: 10000,
      direct_rtt_threshold: 100,
      direct_loss_threshold: 0.05,
    },
    relay: {
      enabled: true,
      max_relay_cpu_load: 0.8,
      max_relay_bandwidth: 10000,
      soft_limit_threshold: 0.7,
      hard_limit_threshold: 0.9,
      recovery_threshold: 0.6,
      priority: 5,
    },
    // probe: {
    //   enabled: true,
    //   update_interval: 5000,
    //   loss_window_size: 100,
    //   rtt_smooth_factor: 0.125,
    //   metrics_ttl: 30000,
    // },
    // fallback: {
    //   enable_tcp_fallback: false,
    //   tcp_fallback_delay: 2000,
    //   udp_recovery_check_interval: 5000,
    // },
  },

  // ===== 服务器设置 =====
  server: {
    capacity: 1000,              // 最大并发用户数
    max_bandwidth: 50000,         // bits per second (50 Kbps)
    default_channel: 0,           // 默认频道 ID
    welcome_text: 'Welcome to MuNode Edge Server!',
  },

  // ===== 客户端设置 =====
  client: {
    // suggest_version: 0x010204, // Suggest client version 1.2.4 (format: 0xMMmmpp)
    // suggest_positional: false, // Suggest disabling positional audio
    // suggest_push_to_talk: true,  // Suggest enabling push-to-talk
  },

  // ===== 功能开关 =====
  features: {
    geoip: true,
    allow_ping: true,
  },

  // ===== 日志配置 =====
  log_level: 'info',
};
