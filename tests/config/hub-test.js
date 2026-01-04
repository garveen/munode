// @ts-check

/**
 * Hub Server Test Configuration
 * 
 * @type {import('../../packages/hub-server/src/config-schema.js').HubConfigInput}
 */
export default {
  server_id: 0,
  name: 'MuNode Hub Server (Test)',
  host: '127.0.0.1',
  port: 9080,
  control_port: 11080,
  
  tls: {
    cert: './tests/integration/certs/server.pem',
    key: './tests/integration/certs/server.key',
    ca: './tests/integration/certs/ca.pem',
    require_client_cert: false,
    reject_unauthorized: false,
  },
  
  connection: {
    type: 'smux',
    options: {
      max_stream_window_size: 262144,
      max_session_window_size: 524288,
      keepalive_interval: 30,
    },
  },
  
  database: {
    path: './data/hub-test.db',
    backup_dir: './data/backups-test',
    backup_interval: 86400,
    wal_mode: false,
  },
  
  blob_store: {
    enabled: true,
    path: './data/blobs-test',
  },
  
  registry: {
    heartbeat_interval: 30,
    timeout: 90,
    max_edges: 100,
    
    // HMAC challenge-response authentication for testing
    hmac_secret: 'test-hmac-secret-key-for-integration-tests',
    challenge_timeout: 60000,
    enable_auth: true,
  },
  
  web_api: {
    enabled: true,
    host: '127.0.0.1',
    port: 8180,
    cors: true,
  },
  
  auth: {
    // 使用 callback 进行认证，避免依赖外部 auth 服务器
    callback: async (request) => {
      const { username, password } = request;
      
      // admin 用户具有管理员权限
      if (username === 'admin') {
        return {
          success: true,
          user_id: 1,
          username: 'admin',
          displayName: 'admin',
          name: 'admin',
          groups: ['admin', 'user'],
        };
      }
      
      // ninja用户特殊处理
      if (username.startsWith('ninja_')) {
        const user_id = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 10000 + 100;
        return {
          success: true,
          user_id,
          username,
          displayName: username,
          groups: ['ninja', 'user'],
        };
      }
      
      // 其他用户作为普通用户
      if (username && username.length > 0) {
        // 使用用户名的哈希作为 user_id
        const user_id = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 10000 + 100;
        return {
          success: true,
          user_id,
          username,
          displayName: username,
          groups: ['user'],
        };
      }
      
      // 认证失败
      return {
        success: false,
        reason: 'Invalid username or password',
        rejectType: 2, // WrongUserPW
      };
    },
    cache_ttl: 300000,
    allow_cache_fallback: false,
  },
  
  allow_html: true,
  allow_recording: true,
  hide_cert_hashes: false,
  channel_ninja: false,
  log_level: 'debug',
  voice_routing: {
    enabled: true,
    shared_secret: 'test-shared-secret-for-udp-voice-handshake',
    hub_relay: {
      enable_tcp_fallback: false, // use edge-hub tcp websocket link for voice relay as last choice
    }
  },
};
