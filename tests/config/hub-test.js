/**
 * Hub Server Test Configuration
 * 
 * @type {import('../../packages/hub-server/src/types.js').HubConfig}
 */
module.exports = {
  server_id: 0,
  name: 'MuNode Hub Server (Test)',
  registerName: 'MuNode Test',
  host: '127.0.0.1',
  port: 9080,
  controlPort: 11080,
  voicePort: 9089,
  
  tls: {
    cert: './tests/integration/certs/server.pem',
    key: './tests/integration/certs/server.key',
    ca: './tests/integration/certs/ca.pem',
    requireClientCert: false,
    rejectUnauthorized: false,
  },
  
  connection: {
    type: 'smux',
    options: {
      maxStreamWindowSize: 262144,
      maxSessionWindowSize: 524288,
      keepaliveInterval: 30,
    },
  },
  
  database: {
    path: './data/hub-test.db',
    backupDir: './data/backups-test',
    backupInterval: 86400,
    walMode: false,
  },
  
  blobStore: {
    enabled: true,
    path: './data/blobs-test',
  },
  
  registry: {
    heartbeatInterval: 30,
    timeout: 90,
    maxEdges: 100,
  },
  
  webApi: {
    enabled: true,
    port: 8180,
    cors: true,
  },
  
  auth: {
    cacheTTL: 300000,
    allowCacheFallback: false,
  },
  
  allowHTML: true,
  allowRecording: true,
  hideCertHashes: false,
  channelNinja: false,
  logLevel: 'info',
};
