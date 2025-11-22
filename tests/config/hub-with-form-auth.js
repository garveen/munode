/**
 * Hub Server Configuration with Form-Based External Authentication (Test)
 * 
 * This configuration demonstrates the HTTP API-based authentication approach
 * using form-urlencoded content type (backward compatible).
 * 
 * @type {import('../../packages/hub-server/src/types.js').HubConfig}
 */
export default {
  server_id: 1,
  name: 'MuNode Hub Server with Form Auth',
  registerName: 'MuNode Server',
  host: '0.0.0.0',
  port: 50051,
  controlPort: 11080,
  
  tls: {
    cert: './certs/server.pem',
    key: './certs/server.key',
    ca: './certs/ca.pem',
    requireClientCert: true,
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
  
  registry: {
    heartbeatInterval: 30,
    timeout: 90,
    maxEdges: 100,
  },
  
  database: {
    path: './data/hub.db',
    backupDir: './data/backups',
    backupInterval: 86400,
    walMode: false,
  },
  
  blobStore: {
    enabled: true,
    path: './data/blobs',
  },
  
  webApi: {
    enabled: true,
    port: 8080,
    cors: true,
  },
  
  timeout: 30,
  maxUsers: 1000,
  channelNestingLimit: 10,
  channelCountLimit: 1000,
  bandwidth: 558000,
  textMessageLength: 5000,
  imageMessageLength: 131072,
  
  allowHTML: true,
  defaultChannel: 0,
  rememberChannel: true,
  allowRecording: true,
  hideCertHashes: false,
  
  autoBan: {
    attempts: 10,
    timeframe: 120,
    duration: 300,
    banSuccessfulConnections: true,
  },
  
  auth: {
    // Using HTTP API-based authentication (backward compatible)
    apiUrl: 'https://your-auth-server.com/api/v1/mumble/authenticate',
    apiKey: 'your-api-key-here',
    timeout: 5000,
    contentType: 'application/x-www-form-urlencoded', // Form-encoded requests
    
    headers: {
      authHeaderName: 'X-Token',
      authHeaderFormat: '{apiKey}',
    },
    
    responseFields: {
      successField: 'success',
      userIdField: 'user_id',
      usernameField: 'name',
      displayNameField: 'nickname',
      groupsField: 'groups',
      reasonField: 'reason',
    },
    
    cacheTTL: 300000,
    allowCacheFallback: true,
  },
  
  logLevel: 'info',
  logFile: './logs/hub.log',
  logDays: 31,
};
