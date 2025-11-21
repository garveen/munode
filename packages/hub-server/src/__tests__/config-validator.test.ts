/**
 * 配置验证测试
 */

import { describe, it, expect } from 'vitest';
import { validateHubConfig, ConfigValidationError } from '../config-validator.js';
import type { HubConfig } from '../types.js';

describe('Config Validator', () => {
  const validConfig: HubConfig = {
    server_id: 0,
    name: 'Test Hub',
    host: '127.0.0.1',
    port: 64738,
    tls: {
      cert: './certs/cert.pem',
      key: './certs/key.pem',
      requireClientCert: false,
      rejectUnauthorized: false,
    },
    registry: {
      heartbeatInterval: 30,
      timeout: 90,
      maxEdges: 100,
    },
    database: {
      path: './test.db',
      backupDir: './backups',
      backupInterval: 86400,
    },
    blobStore: {
      enabled: false,
      path: './blobs',
    },
    webApi: {
      enabled: false,
      port: 8080,
      cors: false,
    },
    logLevel: 'info',
  };

  describe('validateHubConfig', () => {
    it('should validate a valid config without errors', () => {
      expect(() => validateHubConfig(validConfig)).not.toThrow();
    });

    it('should reject negative server_id', () => {
      const config = { ...validConfig, server_id: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/server_id must be non-negative/);
    });

    it('should reject empty name', () => {
      const config = { ...validConfig, name: '' };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/name is required/);
    });

    it('should reject invalid port', () => {
      const config = { ...validConfig, port: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/port must be between/);
    });

    it('should reject invalid timeout', () => {
      const config = { ...validConfig, timeout: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/timeout must be positive/);
    });

    it('should reject invalid maxUsers', () => {
      const config = { ...validConfig, maxUsers: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/maxUsers must be at least 1/);
    });

    it('should accept maxUsersPerChannel = 0 (unlimited)', () => {
      const config = { ...validConfig, maxUsersPerChannel: 0 };
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should reject negative maxUsersPerChannel', () => {
      const config = { ...validConfig, maxUsersPerChannel: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/maxUsersPerChannel must be non-negative/);
    });

    it('should reject invalid channelNestingLimit', () => {
      const config = { ...validConfig, channelNestingLimit: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/channelNestingLimit must be at least 1/);
    });

    it('should reject invalid bandwidth', () => {
      const config = { ...validConfig, bandwidth: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/bandwidth must be positive/);
    });

    it('should reject invalid textMessageLength', () => {
      const config = { ...validConfig, textMessageLength: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/textMessageLength must be positive/);
    });

    it('should reject invalid messageLimit', () => {
      const config = { ...validConfig, messageLimit: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/messageLimit must be positive/);
    });

    it('should accept kdfIterations = -1 (auto)', () => {
      const config = { ...validConfig, kdfIterations: -1 };
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should reject invalid kdfIterations', () => {
      const config = { ...validConfig, kdfIterations: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/kdfIterations must be -1 \(auto\) or positive/);
    });

    it('should reject invalid usernameRegex', () => {
      const config = { ...validConfig, usernameRegex: '[invalid(' };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/Invalid usernameRegex/);
    });

    it('should reject invalid channelNameRegex', () => {
      const config = { ...validConfig, channelNameRegex: '[invalid(' };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/Invalid channelNameRegex/);
    });

    it('should reject invalid autoBan.attempts', () => {
      const config = {
        ...validConfig,
        autoBan: {
          attempts: 0,
          timeframe: 120,
          duration: 300,
          banSuccessfulConnections: true,
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/autoBan.attempts must be at least 1/);
    });

    it('should reject invalid autoBan.timeframe', () => {
      const config = {
        ...validConfig,
        autoBan: {
          attempts: 10,
          timeframe: 0,
          duration: 300,
          banSuccessfulConnections: true,
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/autoBan.timeframe must be positive/);
    });

    it('should reject invalid suggest.version format', () => {
      const config = {
        ...validConfig,
        suggest: {
          version: '1.4',
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/suggest.version must be in format/);
    });

    it('should accept valid suggest.version format', () => {
      const config = {
        ...validConfig,
        suggest: {
          version: '1.4.0',
        },
      };
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should reject negative defaultChannel', () => {
      const config = { ...validConfig, defaultChannel: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/defaultChannel must be non-negative/);
    });

    it('should accept rememberChannelDuration = 0 (permanent)', () => {
      const config = { ...validConfig, rememberChannelDuration: 0 };
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should reject negative rememberChannelDuration', () => {
      const config = { ...validConfig, rememberChannelDuration: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/rememberChannelDuration must be non-negative/);
    });

    it('should accept listenersPerChannel = 0 (unlimited)', () => {
      const config = { ...validConfig, listenersPerChannel: 0 };
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should reject negative listenersPerChannel', () => {
      const config = { ...validConfig, listenersPerChannel: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/listenersPerChannel must be non-negative/);
    });

    it('should reject invalid registry.heartbeatInterval', () => {
      const config = {
        ...validConfig,
        registry: {
          ...validConfig.registry,
          heartbeatInterval: 0,
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/registry.heartbeatInterval must be positive/);
    });

    it('should reject invalid database.backupInterval', () => {
      const config = {
        ...validConfig,
        database: {
          ...validConfig.database,
          backupInterval: 0,
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/database.backupInterval must be positive/);
    });

    it('should reject missing database.path', () => {
      const config = {
        ...validConfig,
        database: {
          ...validConfig.database,
          path: '',
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/database.path is required/);
    });

    it('should reject enabled blobStore without path', () => {
      const config = {
        ...validConfig,
        blobStore: {
          enabled: true,
          path: '',
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/blobStore.path is required when blobStore is enabled/);
    });

    it('should accept disabled blobStore without path', () => {
      const config = {
        ...validConfig,
        blobStore: {
          enabled: false,
          path: '',
        },
      };
      expect(() => validateHubConfig(config)).not.toThrow();
    });
  });
});
