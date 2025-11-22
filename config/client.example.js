/**
 * Headless Mumble Client Configuration
 * 
 * This is the main configuration file for the MuNode Headless Client.
 * The client provides HTTP API and WebSocket interfaces for programmatic control.
 * 
 * @type {import('../packages/client/src/types/client-types.js').ClientConfig}
 */
export default {
  // Connection configuration
  connection: {
    host: 'localhost',
    port: 64738,
    autoReconnect: true,
    reconnectDelay: 5000, // milliseconds
    reconnectMaxDelay: 60000, // milliseconds
    connectTimeout: 10000, // milliseconds
  },
  
  // Authentication configuration
  auth: {
    username: 'HeadlessClient',
    password: '', // Optional password
    tokens: [], // Optional access tokens
    certificate: undefined, // Path to client certificate
    key: undefined, // Path to client private key
  },
  
  // Audio configuration
  audio: {
    encoder: {
      codec: 'opus',
      bitrate: 40000, // bits per second
      frameSize: 960, // samples (20ms at 48kHz)
      vbr: true, // Variable bitrate
    },
    decoder: {
      codecs: ['opus'],
      autoDetect: true,
    },
    inputSampleRate: 48000,
    outputSampleRate: 48000,
  },
  
  // API configuration
  api: {
    // HTTP API
    http: {
      enabled: true,
      host: '0.0.0.0',
      port: 3000,
      cors: true,
      auth: {
        enabled: false,
        token: '', // API authentication token
      },
    },
    
    // WebSocket API
    websocket: {
      enabled: true,
      port: 3001,
      path: '/ws',
      auth: {
        enabled: false,
        token: '', // WebSocket authentication token
      },
    },
  },
  
  // Webhook configuration
  webhooks: [
    // Example webhook configuration:
    // {
    //   url: 'https://example.com/webhook',
    //   events: ['user_connected', 'user_disconnected', 'message_received'],
    //   method: 'POST',
    //   headers: {
    //     'Authorization': 'Bearer your-token',
    //   },
    // },
  ],
  
  // Logging configuration
  logging: {
    level: 'info', // 'debug', 'info', 'warn', 'error'
    file: undefined, // Optional log file path
  },
};
