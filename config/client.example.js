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
    reconnectDelay: 1000, // milliseconds
    reconnectMaxDelay: 30000, // milliseconds
    connectTimeout: 10000, // milliseconds
  },

  // Authentication configuration
  auth: {
    username: 'MuNodeClient',
    password: undefined, // Optional password
    tokens: [], // Optional access tokens
    certificate: undefined, // Path to client certificate
    key: undefined, // Path to client private key
  },

  // Audio configuration
  audio: {
    encoder: {
      codec: 'opus',
      bitrate: 64000, // bits per second
      frameSize: 20, // milliseconds (20ms at 48kHz)
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
      enabled: false,
      host: 'localhost',
      port: 8080,
      cors: true,
    },

    // WebSocket API
    websocket: {
      enabled: false,
      path: '/ws',
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
