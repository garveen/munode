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
  registerName: 'MuNode Server', // Display name for root channel
  
  // Network configuration
  host: '0.0.0.0',
  port: 65000,
  controlPort: 11080, // Control channel port for Edge connections
  voicePort: 9089,    // Voice channel port (optional)
  
  // TLS/SSL configuration
  tls: {
    cert: './certs/hub-cert.pem',
    key: './certs/hub-key.pem',
    ca: './certs/ca.pem',
    requireClientCert: true,
    rejectUnauthorized: false,
  },
  
  // Connection configuration
  connection: {
    type: 'smux',
    options: {
      maxStreamWindowSize: 262144,
      maxSessionWindowSize: 524288,
      keepaliveInterval: 30,
    },
  },
  
  // Database configuration
  database: {
    path: './data/hub.db',
    backupDir: './data/backups',
    backupInterval: 86400, // seconds
    walMode: false, // SQLite Write-Ahead Logging mode
  },
  
  // Blob storage configuration (for avatars, textures, etc.)
  blobStore: {
    enabled: true,
    path: './data/blobs',
  },
  
  // Edge server registry configuration
  registry: {
    heartbeatInterval: 30, // seconds
    timeout: 90, // seconds
    maxEdges: 100,
  },
  
  // Web API configuration
  webApi: {
    enabled: false,
    port: 8080,
    cors: true,
  },
  
  // Server behavior
  timeout: 30, // Client timeout in seconds
  maxUsers: 1000,
  maxUsersPerChannel: 0, // 0 = unlimited
  channelNestingLimit: 10,
  channelCountLimit: 1000,
  
  // Bandwidth and message limits
  bandwidth: 558000, // bits per second per user
  textMessageLength: 5000,
  imageMessageLength: 131072, // 128 KB
  messageLimit: 1, // messages per second
  messageBurst: 5, // burst capacity
  pluginMessageLimit: 4,
  pluginMessageBurst: 15,
  
  // Security and authentication
  kdfIterations: -1, // -1 = auto benchmark
  allowHTML: true,
  forceExternalAuth: false,
  
  // Username and channel name validation
  usernameRegex: '[ -=\\w\\[\\]\\{\\}\\(\\)\\@\\|\\.]+',
  channelNameRegex: '[ -=\\w\\#\\[\\]\\{\\}\\(\\)\\@\\|]+',
  
  // Welcome message
  welcomeText: 'Welcome to MuNode Server!',
  // welcomeTextFile: './welcome.html', // Alternative: load from file
  
  // Auto-ban configuration
  autoBan: {
    attempts: 10,
    timeframe: 120, // seconds
    duration: 300, // seconds
    banSuccessfulConnections: true,
  },
  
  // Channel behavior
  defaultChannel: 0, // Default channel ID (0 = Root)
  rememberChannel: true,
  rememberChannelDuration: 0, // 0 = forever
  
  // Client suggestions
  suggest: {
    version: '1.4.0',
    positional: null, // null = don't suggest
    pushToTalk: null,
  },
  
  // Server registration (for public server list)
  // registerPassword: 'your-password',
  // registerHostname: 'mumble.example.com',
  // registerLocation: 'Global',
  // registerUrl: 'https://example.com',
  bonjour: false, // Zeroconf/Bonjour local network discovery
  
  // Advanced features
  listenersPerChannel: 0, // 0 = unlimited
  listenersPerUser: 0, // 0 = unlimited
  broadcastListenerVolumeAdjustments: false,
  allowRecording: true,
  sendVersion: true,
  allowPing: true,
  hideCertHashes: false,
  channelNinja: false, // Hide users in channels without view permission
  
  // Database log retention
  logDays: 31,
  
  // Authentication configuration
  auth: {
    // Option 1: Use a callback function for authentication (Recommended)
    // This gives you full control over the authentication logic
    // callback: async (request) => {
    //   const { username, password, tokens, session_id, server_id, 
    //           ip_address, ip_version, release, version, os, os_version, 
    //           certificate_hash } = request;
    //   
    //   // Your custom authentication logic here
    //   // Example: check against a database
    //   if (username === 'admin' && password === 'secret') {
    //     return {
    //       success: true,
    //       user_id: 1,
    //       username: 'admin',
    //       displayName: 'Administrator',
    //       groups: ['admin', 'user'],
    //     };
    //   }
    //   
    //   return {
    //     success: false,
    //     reason: 'Invalid credentials',
    //     rejectType: 2, // WrongUserPW
    //   };
    // },
    
    // Option 2: Use HTTP API for authentication (Backward compatible)
    // apiUrl: 'https://auth.example.com/api/mumble/authenticate',
    // apiKey: 'your-secret-api-key',
    // timeout: 5000,
    // contentType: 'application/json', // or 'application/x-www-form-urlencoded'
    // headers: {
    //   authHeaderName: 'Authorization',
    //   authHeaderFormat: 'Bearer {apiKey}',
    // },
    // responseFields: {
    //   successField: 'success',
    //   userIdField: 'user_id',
    //   usernameField: 'username',
    //   displayNameField: 'displayName',
    //   groupsField: 'groups',
    //   reasonField: 'reason',
    // },
    
    // Cache settings
    cacheTTL: 300000, // 5 minutes in milliseconds
    allowCacheFallback: false,
  },
  
  // Logging configuration
  logLevel: 'info',
  logFile: './logs/hub.log',
};
