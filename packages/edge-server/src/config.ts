import { readFileSync } from 'fs';
import { resolve } from 'path';
import { EdgeConfig } from './types.js';
// import { loadConfig } from '@munode/common';

/**
 * 加载 Edge Server 配置
 */
export function loadEdgeConfig(configPath?: string): EdgeConfig {
  const defaultConfig: EdgeConfig = {
     server_id: 1,
    name: 'Edge Server',
    mode: 'cluster',
    network: {
      host: '0.0.0.0',
      port: 64738,
      externalHost: 'localhost',
    },
    tls: {
      cert: '',
      key: '',
      ca: '',
      requireClientCert: false,
      rejectUnauthorized: false,
    },
    hubServer: {
      host: 'localhost',
      port: 64739,
      controlPort: 8443,
      tls: {
        rejectUnauthorized: false,
      },
      connectionType: 'websocket',
      reconnectInterval: 5000,
      heartbeatInterval: 30000,
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
      apiUrl: 'http://localhost:8080/api',
      apiKey: '',
      timeout: 5000,
      retry: 3,
      insecure: false,
      cacheTTL: 3600000, // 1 hour
      pullInterval: 300000, // 5 minutes
      trackSessions: true,
      allowCacheFallback: true,
    },
    capacity: 100,
    max_bandwidth: 1000000, // 1MB/s
    defaultChannel: 0,
    databasePath: './data/edge.db',
    logLevel: 'info',
    features: {
      geoip: true,
      banSystem: true,
      contextActions: true,
      userCache: true,
      packetPool: true,
      udpMonitor: true,
      certObfuscation: true,
    },
  };

  if (configPath) {
    try {
      const configFile = readFileSync(resolve(configPath), 'utf-8');
      const userConfig = JSON.parse(configFile);
      return { ...defaultConfig, ...userConfig };
    } catch (error) {
      console.warn(`Failed to load config from ${configPath}:`, error);
    }
  }

  return defaultConfig;
}

/**
 * 验证配置
 */
export function validateConfig(config: EdgeConfig): string[] {
  const errors: string[] = [];

  if (!config.server_id || config.server_id < 1) {
    errors.push('serverId must be a positive integer');
  }

  if (!config.name || config.name.trim().length === 0) {
    errors.push('name cannot be empty');
  }

  if (!config.network.host) {
    errors.push('network.host is required');
  }

  if (!config.network.port || config.network.port < 1 || config.network.port > 65535) {
    errors.push('network.port must be between 1 and 65535');
  }

  if (config.hubServer) {
    if (!config.hubServer.host) {
      errors.push('hubServer.host is required');
    }
    if (!config.hubServer.port || config.hubServer.port < 1 || config.hubServer.port > 65535) {
      errors.push('hubServer.port must be between 1 and 65535');
    }
  }

  return errors;
}
