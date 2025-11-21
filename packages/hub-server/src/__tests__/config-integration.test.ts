/**
 * Integration test for HubServer with new configuration options
 */

import { describe, it, expect } from 'vitest';
import { applyConfigDefaults } from '../config-defaults.js';
import { validateHubConfig } from '../config-validator.js';
import type { HubConfig } from '../types.js';

describe('HubServer Configuration Integration', () => {
  const getTestConfig = (): HubConfig => ({
    server_id: 0,
    name: 'Test Hub',
    host: '127.0.0.1',
    port: 64738,
    tls: {
      cert: './test-cert.pem',
      key: './test-key.pem',
      requireClientCert: false,
      rejectUnauthorized: false,
    },
    registry: {
      heartbeatInterval: 30,
      timeout: 90,
      maxEdges: 100,
    },
    database: {
      path: ':memory:',
      backupDir: './test-backups',
      backupInterval: 86400,
    },
    blobStore: {
      enabled: false,
      path: './test-blobs',
    },
    webApi: {
      enabled: false,
      port: 8080,
      cors: false,
    },
    logLevel: 'error',
  });

  it('should accept minimal configuration with defaults', () => {
    const config = getTestConfig();
    const applied = applyConfigDefaults(config);
    
    expect(applied.timeout).toBe(30);
    expect(applied.maxUsers).toBe(1000);
    expect(applied.bandwidth).toBe(558000);
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with custom security settings', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      serverPassword: 'test-password',
      kdfIterations: 100000,
      allowHTML: false,
      usernameRegex: '^[a-zA-Z0-9_-]+$',
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.serverPassword).toBe('test-password');
    expect(applied.kdfIterations).toBe(100000);
    expect(applied.allowHTML).toBe(false);
    expect(applied.usernameRegex).toBe('^[a-zA-Z0-9_-]+$');
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with rate limiting', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      messageLimit: 2,
      messageBurst: 10,
      pluginMessageLimit: 8,
      pluginMessageBurst: 20,
      bandwidth: 1000000,
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.messageLimit).toBe(2);
    expect(applied.messageBurst).toBe(10);
    expect(applied.bandwidth).toBe(1000000);
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with auto-ban settings', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      autoBan: {
        attempts: 5,
        timeframe: 60,
        duration: 600,
        banSuccessfulConnections: false,
      },
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.autoBan?.attempts).toBe(5);
    expect(applied.autoBan?.timeframe).toBe(60);
    expect(applied.autoBan?.duration).toBe(600);
    expect(applied.autoBan?.banSuccessfulConnections).toBe(false);
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with channel behavior settings', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      defaultChannel: 5,
      rememberChannel: false,
      rememberChannelDuration: 86400,
      channelNestingLimit: 15,
      channelCountLimit: 5000,
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.defaultChannel).toBe(5);
    expect(applied.rememberChannel).toBe(false);
    expect(applied.rememberChannelDuration).toBe(86400);
    expect(applied.channelNestingLimit).toBe(15);
    expect(applied.channelCountLimit).toBe(5000);
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with client suggestions', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      suggest: {
        version: '1.4.0',
        positional: true,
        pushToTalk: false,
      },
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.suggest?.version).toBe('1.4.0');
    expect(applied.suggest?.positional).toBe(true);
    expect(applied.suggest?.pushToTalk).toBe(false);
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with welcome messages', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      welcomeText: 'Welcome to our server!',
      welcomeTextFile: './welcome.txt',
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.welcomeText).toBe('Welcome to our server!');
    expect(applied.welcomeTextFile).toBe('./welcome.txt');
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with listener limits', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      listenersPerChannel: 50,
      listenersPerUser: 10,
      broadcastListenerVolumeAdjustments: true,
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.listenersPerChannel).toBe(50);
    expect(applied.listenersPerUser).toBe(10);
    expect(applied.broadcastListenerVolumeAdjustments).toBe(true);
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with advanced features', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      allowRecording: false,
      sendVersion: false,
      allowPing: false,
      logDays: 90,
      database: {
        ...getTestConfig().database,
        walMode: true,
      },
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.allowRecording).toBe(false);
    expect(applied.sendVersion).toBe(false);
    expect(applied.allowPing).toBe(false);
    expect(applied.logDays).toBe(90);
    expect(applied.database.walMode).toBe(true);
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });

  it('should accept configuration with server registration', () => {
    const config: HubConfig = {
      ...getTestConfig(),
      registerPassword: 'reg-password',
      registerHostname: 'mumble.example.com',
      registerLocation: 'New York, USA',
      registerUrl: 'https://example.com',
      bonjour: true,
    };
    
    const applied = applyConfigDefaults(config);
    
    expect(applied.registerPassword).toBe('reg-password');
    expect(applied.registerHostname).toBe('mumble.example.com');
    expect(applied.registerLocation).toBe('New York, USA');
    expect(applied.registerUrl).toBe('https://example.com');
    expect(applied.bonjour).toBe(true);
    
    expect(() => validateHubConfig(applied)).not.toThrow();
  });
});
