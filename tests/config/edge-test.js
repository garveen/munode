/**
 * Edge Server Test Configuration
 * 
 * @type {import('../../packages/edge-server/src/types.js').EdgeConfig}
 */
export default {
  // ===== 基本信息 =====
  server_id: 1,
  name: 'MuNode Edge Server #1 (Test)',
  mode: 'cluster',
  
  // ===== 网络配置 =====
  network: {
    host: '0.0.0.0',
    port: 10080,
    external_host: 'localhost',
    region: 'test',
  },
  
  // ===== TLS 配置 =====
  tls: {
    cert: './tests/integration/certs/server.pem',
    key: './tests/integration/certs/server.key',
    ca: './tests/integration/certs/ca.pem',
    require_client_cert: false,
    reject_unauthorized: false,
  },
  
  // ===== Hub 连接 =====
  hub_server: {
    host: '127.0.0.1',
    port: 9080,
    control_port: 11080,
    tls: {
      ca: './tests/integration/certs/ca.pem',
      reject_unauthorized: false,
    },
    connection_type: 'smux',
    reconnect_interval: 5000,
    heartbeat_interval: 10000,
    
    // HMAC authentication (must match Hub's hmacSecret)
    hmac_secret: 'test-hmac-secret-key-for-integration-tests',
    
    pool_size: 1,  // Use single connection for tests
    reconnection_timeout: 30000,
    
    options: {
      max_stream_window_size: 262144,
      max_session_window_size: 524288,
    },
  },
  
  // ===== 语音路由 =====
  voice_routing: {
    enabled: true,
    shared_secret: 'test-shared-secret-for-udp-voice-handshake',
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
  },
  
  // ===== 服务器设置 =====
  server: {
    capacity: 1000,
    max_bandwidth: 72000000,
    default_channel: 0,
    welcome_text: 'Welcome to MuNode Test Server!',
    timeout: 30,
  },
  
  // ===== 客户端设置 =====
  client: {
    max_text_message_length: 5000,
    max_image_message_length: 131072,
  },
  
  // ===== 功能开关 =====
  features: {
    geoip: false,
    ban_system: false,
    context_actions: true,
    packet_pool: true,
    udp_monitor: false,
    allow_html: true,
    allow_ping: true,
  },
  
  // ===== 日志 =====
  log_level: 'info',
};
