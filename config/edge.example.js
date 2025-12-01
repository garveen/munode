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
    host: '0.0.0.0',
    port: 64738,
    externalHost: 'edge.example.com', // Public hostname/IP
    region: 'asia-east', // Server region identifier
  },

  // Capacity limits
  capacity: 1000, // Maximum concurrent users
  max_bandwidth: 1000000, // bits per second (1 Mbps)

  // TLS/SSL configuration
  tls: {
    cert: './certs/edge-cert.pem',
    key: './certs/edge-key.pem',
    ca: './certs/ca.pem',
    requireClientCert: false,
    rejectUnauthorized: false,
  },

  // Hub server connection configuration
  hubServer: {
    host: 'hub.example.com',
    port: 64739,
    controlPort: 8443,
    tls: {
      ca: './certs/ca.pem',
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
  },

  // Logging configuration
  logLevel: 'info',
  logFile: './logs/edge.log',
};
