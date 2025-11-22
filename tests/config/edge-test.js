/**
 * Edge Server Test Configuration
 * 
 * @type {import('../../packages/edge-server/src/types.js').EdgeConfig}
 */
module.exports = {
  server_id: 1,
  name: 'MuNode Edge Server #1 (Test)',
  mode: 'cluster',
  
  network: {
    host: '0.0.0.0',
    port: 10080,
    externalHost: 'localhost',
    region: 'test',
  },
  
  capacity: 1000,
  max_bandwidth: 72000000,
  
  tls: {
    cert: './tests/integration/certs/server.pem',
    key: './tests/integration/certs/server.key',
    ca: './tests/integration/certs/ca.pem',
    requireClientCert: false,
    rejectUnauthorized: false,
  },
  
  hubServer: {
    host: '127.0.0.1',
    port: 9080,
    controlPort: 11080,
    tls: {
      ca: './tests/integration/certs/ca.pem',
      rejectUnauthorized: false,
    },
    connectionType: 'smux',
    reconnectInterval: 5000,
    heartbeatInterval: 10000,
    options: {
      maxStreamWindowSize: 262144,
      maxSessionWindowSize: 524288,
    },
  },
  
  peerServers: {
    enableP2P: false,
    connectionTimeout: 10000,
    maxConnections: 10,
  },
  
  relay: {
    enabled: false,
  },
  
  auth: {
    apiUrl: '',
    apiKey: '',
    timeout: 5000,
    retry: 3,
    insecure: true,
    cacheTTL: 300000,
    userCachePath: './data/users-test.json',
    pullInterval: 3600000,
    trackSessions: true,
    allowCacheFallback: true,
  },
  
  requiredGroups: [],
  
  udp: {
    enabled: true,
    bufferSize: 1024,
    stabilityCheck: {
      enabled: false,
    },
  },
  
  ban: {
    enabled: false,
    cacheTTL: 300000,
  },
  
  defaultChannel: 0,
  welcomeText: 'Welcome to MuNode Test Server!',
  maxTextMessageLength: 5000,
  maxImageMessageLength: 131072,
  
  features: {
    geoip: false,
    banSystem: false,
    contextActions: true,
    userCache: true,
    packetPool: true,
    udpMonitor: false,
    allowHtml: true,
  },
  
  logLevel: 'info',
  logFile: './logs/edge-test.log',
};
