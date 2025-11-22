/**
 * Hub Server Configuration with External Authentication (Test)
 * 
 * This configuration demonstrates the callback-based authentication approach.
 * 
 * @type {import('../../packages/hub-server/src/types.js').HubConfig}
 */
export default {
  server_id: 1,
  name: 'MuNode Hub Server with External Auth',
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
  maxUsersPerChannel: 0,
  channelNestingLimit: 10,
  channelCountLimit: 1000,
  
  bandwidth: 558000,
  textMessageLength: 5000,
  imageMessageLength: 131072,
  messageLimit: 1,
  messageBurst: 5,
  pluginMessageLimit: 4,
  pluginMessageBurst: 15,
  
  allowHTML: true,
  forceExternalAuth: false,
  
  usernameRegex: '[ -=\\w\\[\\]\\{\\}\\(\\)\\@\\|\\.]+',
  channelNameRegex: '[ -=\\w\\#\\[\\]\\{\\}\\(\\)\\@\\|]+',
  
  defaultChannel: 0,
  rememberChannel: true,
  rememberChannelDuration: 0,
  
  allowRecording: true,
  sendVersion: true,
  allowPing: true,
  hideCertHashes: false,
  
  autoBan: {
    attempts: 10,
    timeframe: 120,
    duration: 300,
    banSuccessfulConnections: true,
  },
  
  suggest: {
    version: '1.4.0',
    positional: null,
    pushToTalk: null,
  },
  
  auth: {
    // Using callback-based authentication (recommended approach)
    callback: async (request) => {
      const { 
        username, 
        password, 
        tokens, 
        session_id, 
        server_id,
        ip_address,
        ip_version,
        release,
        version,
        os,
        os_version,
        certificate_hash 
      } = request;
      
      // Example authentication logic
      // In a real implementation, you would check against a database or external service
      
      // Test user credentials
      const validUsers = {
        'admin': { password: 'admin123', user_id: 1, groups: ['admin', 'user'] },
        'user1': { password: 'password1', user_id: 2, groups: ['user'] },
        'user2': { password: 'password2', user_id: 3, groups: ['user'] },
        'guest': { password: 'guest123', user_id: 4, groups: ['guest'] },
      };
      
      const user = validUsers[username];
      
      if (user && user.password === password) {
        return {
          success: true,
          user_id: user.user_id,
          username: username,
          displayName: username.charAt(0).toUpperCase() + username.slice(1),
          groups: user.groups,
        };
      }
      
      // Authentication failed
      return {
        success: false,
        reason: 'Invalid username or password',
        rejectType: 2, // WrongUserPW
      };
    },
    
    cacheTTL: 300000,
    allowCacheFallback: true,
  },
  
  logLevel: 'info',
  logFile: './logs/hub.log',
  logDays: 31,
};
