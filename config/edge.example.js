/**
 * Edge Server Configuration
 *
 * This is the main configuration file for the MuNode Edge Server.
 * The Edge Server handles client connections and real-time voice/data transmission.
 *
 * @type {import('../packages/edge-server/src/types.js').EdgeConfig}
 */
export default {
  // Server identification
  server_id: 1,
  name: 'MuNode Edge Server #1',
  mode: 'cluster',

  // Network configuration
  network: {
    host: '0.0.0.0',           // 实际监听的地址
    port: 64738,                // 实际监听的端口
    externalHost: 'edge.example.com', // 用于其它edge连接的地址（公网地址/域名）
    externalPort: 64738,        // 用于其它edge连接的端口（公网端口），如果未指定则使用port
    region: 'asia-east',        // Server region identifier
  },

  // Capacity limits
  capacity: 1000, // Maximum concurrent users
  max_bandwidth: 1000000, // bits per second (1 Mbps)

  // TLS/SSL configuration
  tls: {
    cert: './data/certs/edge-cert.pem',
    key: './data/certs/edge-key.pem',
    ca: './data/certs/ca.pem',
    requireClientCert: false,
    rejectUnauthorized: false,
  },

  // Hub server connection configuration
  hubServer: {
    host: 'hub.example.com',
    port: 64739,
    controlPort: 8443,
    tls: {
      ca: './data/certs/ca.pem',
      rejectUnauthorized: false,
    },
    connectionType: 'websocket', // 'websocket', 'grpc', 'smux', or 'kcp'
    reconnectInterval: 5000, // milliseconds
    heartbeatInterval: 30000, // milliseconds

    // HMAC challenge-response authentication
    hmacSecret: 'change-this-to-a-secure-random-string', // Must match Hub's hmacSecret
  },

  // Peer-to-peer server configuration
  peerServers: {
    enableP2P: false,
    connectionTimeout: 10000,
    maxConnections: 10,
  },

  // Relay configuration
  relay: {
    enabled: false,
    preferredRelay: undefined,
    fallbackRelays: [],
  },

  // Authentication configuration
  auth: {
    apiUrl: 'https://auth.example.com/api/mumble/authenticate',
    apiKey: 'your-secret-api-key',
    timeout: 5000,
    retry: 3,
    insecure: false, // Allow insecure HTTPS connections
    cacheTTL: 3600000, // 1 hour in milliseconds
    pullInterval: 300000, // 5 minutes
    trackSessions: true,
    allowCacheFallback: true,
  },

  // Server settings
  defaultChannel: 0, // Default channel ID
  welcomeText: 'Welcome to MuNode Edge Server!',
  maxTextMessageLength: 5000,
  maxImageMessageLength: 131072, // 128 KB

  // Client suggestions
  suggestVersion: undefined, // Suggested client version number
  suggestPositional: undefined, // Suggest positional audio
  suggestPushToTalk: undefined, // Suggest push-to-talk

  // Feature flags
  features: {
    geoip: true,
    banSystem: true,
    contextActions: true,
    packetPool: true,
    udpMonitor: true,
    allowHtml: true,
    allowPing: true, // 允许响应 UDP ping 请求（用于客户端服务器发现）
  },

  // Logging configuration
  logLevel: 'info',
  logFile: './logs/edge.log',
};
