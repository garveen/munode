/**
 * Hub 配置集成测试
 * 测试 Hub Server 的配置验证、默认值应用和运行时行为
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HubServer } from '@munode/hub-server';
import { 
  validateHubConfig, 
  applyConfigDefaults, 
  ConfigValidationError,
  CONFIG_DEFAULTS,
  DEFAULT_AUTO_BAN,
  DEFAULT_CLIENT_SUGGEST
} from '@munode/hub-server';
import type { HubConfig } from '@munode/hub-server';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

describe('Hub Configuration Integration Tests', () => {
  let tempDir: string;
  let testCertPath: string;
  let testKeyPath: string;

  beforeAll(async () => {
    // 创建临时目录和测试证书
    tempDir = path.join(tmpdir(), `munode-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    testCertPath = path.join(tempDir, 'test-cert.pem');
    testKeyPath = path.join(tempDir, 'test-key.pem');
    
    // 创建简单的自签名证书（用于测试）
    await fs.writeFile(testCertPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----');
    await fs.writeFile(testKeyPath, '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----');
  });

  afterAll(async () => {
    // 清理临时文件
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to cleanup temp dir:', error);
    }
  });

  /**
   * 创建最小有效配置
   */
  function getMinimalConfig(): HubConfig {
    return {
      server_id: 1,
      name: 'Test Hub',
      host: '127.0.0.1',
      port: 64738,
      tls: {
        cert: testCertPath,
        key: testKeyPath,
        requireClientCert: false,
        rejectUnauthorized: false,
      },
      registry: {
        heartbeatInterval: 30,
        timeout: 90,
        maxEdges: 100,
      },
      database: {
        path: path.join(tempDir, 'test.db'),
        backupDir: path.join(tempDir, 'backups'),
        backupInterval: 86400,
      },
      blobStore: {
        enabled: false,
        path: path.join(tempDir, 'blobs'),
      },
      webApi: {
        enabled: false,
        port: 8080,
        cors: false,
      },
      logLevel: 'info',
    };
  }

  describe('Configuration Validation', () => {
    it('should accept minimal valid configuration', () => {
      const config = getMinimalConfig();
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should reject configuration with negative server_id', () => {
      const config = { ...getMinimalConfig(), server_id: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/server_id must be non-negative/);
    });

    it('should reject configuration with empty name', () => {
      const config = { ...getMinimalConfig(), name: '' };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/name is required/);
    });

    it('should reject configuration with invalid port', () => {
      const config = { ...getMinimalConfig(), port: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/port must be between/);
    });

    it('should reject configuration with port > 65535', () => {
      const config = { ...getMinimalConfig(), port: 70000 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/port must be between/);
    });

    it('should reject configuration with invalid timeout', () => {
      const config = { ...getMinimalConfig(), timeout: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/timeout must be positive/);
    });

    it('should reject configuration with maxUsers = 0', () => {
      const config = { ...getMinimalConfig(), maxUsers: 0 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/maxUsers must be at least 1/);
    });

    it('should accept maxUsersPerChannel = 0 (unlimited)', () => {
      const config = { ...getMinimalConfig(), maxUsersPerChannel: 0 };
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should reject negative maxUsersPerChannel', () => {
      const config = { ...getMinimalConfig(), maxUsersPerChannel: -1 };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/maxUsersPerChannel must be non-negative/);
    });

    it('should reject invalid usernameRegex', () => {
      const config = { ...getMinimalConfig(), usernameRegex: '[invalid(' };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/Invalid usernameRegex/);
    });

    it('should reject invalid channelNameRegex', () => {
      const config = { ...getMinimalConfig(), channelNameRegex: '[invalid(' };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/Invalid channelNameRegex/);
    });

    it('should reject invalid autoBan configuration', () => {
      const config = {
        ...getMinimalConfig(),
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

    it('should reject invalid suggest.version format', () => {
      const config = {
        ...getMinimalConfig(),
        suggest: {
          version: '1.4', // 缺少 patch 版本
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/suggest.version must be in format/);
    });

    it('should accept valid suggest.version format', () => {
      const config = {
        ...getMinimalConfig(),
        suggest: {
          version: '1.4.0',
        },
      };
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should reject configuration without database config', () => {
      const config: any = { ...getMinimalConfig() };
      delete config.database;
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/database configuration is required/);
    });

    it('should reject configuration with enabled blobStore but no path', () => {
      const config = {
        ...getMinimalConfig(),
        blobStore: {
          enabled: true,
          path: '',
        },
      };
      expect(() => validateHubConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateHubConfig(config)).toThrow(/blobStore.path is required when blobStore is enabled/);
    });
  });

  describe('Configuration Defaults', () => {
    it('should apply default timeout value', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.timeout).toBe(CONFIG_DEFAULTS.timeout);
      expect(applied.timeout).toBe(30);
    });

    it('should apply default maxUsers value', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.maxUsers).toBe(CONFIG_DEFAULTS.maxUsers);
      expect(applied.maxUsers).toBe(1000);
    });

    it('should apply default bandwidth value', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.bandwidth).toBe(CONFIG_DEFAULTS.bandwidth);
      expect(applied.bandwidth).toBe(558000);
    });

    it('should not override explicitly set values', () => {
      const config = {
        ...getMinimalConfig(),
        timeout: 60,
        maxUsers: 500,
        bandwidth: 1000000,
      };
      const applied = applyConfigDefaults(config);
      
      expect(applied.timeout).toBe(60);
      expect(applied.maxUsers).toBe(500);
      expect(applied.bandwidth).toBe(1000000);
    });

    it('should apply default autoBan config when not provided', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.autoBan).toBeDefined();
      expect(applied.autoBan?.attempts).toBe(DEFAULT_AUTO_BAN.attempts);
      expect(applied.autoBan?.timeframe).toBe(DEFAULT_AUTO_BAN.timeframe);
      expect(applied.autoBan?.duration).toBe(DEFAULT_AUTO_BAN.duration);
    });

    it('should merge partial autoBan config with defaults', () => {
      const config = {
        ...getMinimalConfig(),
        autoBan: {
          attempts: 5,
          timeframe: 60,
          duration: 300,
          banSuccessfulConnections: false,
        },
      };
      const applied = applyConfigDefaults(config);
      
      expect(applied.autoBan?.attempts).toBe(5);
      expect(applied.autoBan?.timeframe).toBe(60);
      expect(applied.autoBan?.duration).toBe(300);
      expect(applied.autoBan?.banSuccessfulConnections).toBe(false);
    });

    it('should apply default suggest config when not provided', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.suggest).toBeDefined();
      expect(applied.suggest?.version).toBeUndefined();
      expect(applied.suggest?.positional).toBe(null);
      expect(applied.suggest?.pushToTalk).toBe(null);
    });

    it('should apply default regex patterns', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.usernameRegex).toBe(CONFIG_DEFAULTS.usernameRegex);
      expect(applied.channelNameRegex).toBe(CONFIG_DEFAULTS.channelNameRegex);
    });

    it('should apply default channel behavior settings', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.defaultChannel).toBe(CONFIG_DEFAULTS.defaultChannel);
      expect(applied.rememberChannel).toBe(CONFIG_DEFAULTS.rememberChannel);
      expect(applied.rememberChannelDuration).toBe(CONFIG_DEFAULTS.rememberChannelDuration);
    });

    it('should apply default listener limits', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.listenersPerChannel).toBe(CONFIG_DEFAULTS.listenersPerChannel);
      expect(applied.listenersPerUser).toBe(CONFIG_DEFAULTS.listenersPerUser);
      expect(applied.broadcastListenerVolumeAdjustments).toBe(CONFIG_DEFAULTS.broadcastListenerVolumeAdjustments);
    });

    it('should apply database WAL mode default', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(applied.database.walMode).toBe(CONFIG_DEFAULTS.walMode);
      expect(applied.database.walMode).toBe(false);
    });
  });

  describe('Hub Server Initialization with Config', () => {
    it('should initialize Hub Server with minimal config', () => {
      const config = getMinimalConfig();
      expect(() => new HubServer(config)).not.toThrow();
    });

    it('should initialize Hub Server with custom timeout', () => {
      const config = {
        ...getMinimalConfig(),
        timeout: 60,
      };
      const hub = new HubServer(config);
      expect(hub).toBeDefined();
      // 验证配置已应用（通过 hub.config 访问）
    });

    it('should initialize Hub Server with custom security settings', () => {
      const config = {
        ...getMinimalConfig(),
        serverPassword: 'test-password',
        kdfIterations: 100000,
        allowHTML: false,
      };
      const hub = new HubServer(config);
      expect(hub).toBeDefined();
    });

    it('should initialize Hub Server with autoBan config', () => {
      const config = {
        ...getMinimalConfig(),
        autoBan: {
          attempts: 5,
          timeframe: 60,
          duration: 600,
          banSuccessfulConnections: false,
        },
      };
      const hub = new HubServer(config);
      expect(hub).toBeDefined();
    });

    it('should initialize Hub Server with suggest config', () => {
      const config = {
        ...getMinimalConfig(),
        suggest: {
          version: '1.4.0',
          positional: true,
          pushToTalk: false,
        },
      };
      const hub = new HubServer(config);
      expect(hub).toBeDefined();
    });

    it('should reject initialization with invalid config', () => {
      const config = {
        ...getMinimalConfig(),
        port: -1, // 无效端口
      };
      expect(() => new HubServer(config)).toThrow(ConfigValidationError);
    });
  });

  describe('Configuration Edge Cases', () => {
    it('should handle zero values for unlimited settings', () => {
      const config = {
        ...getMinimalConfig(),
        maxUsersPerChannel: 0,
        listenersPerChannel: 0,
        listenersPerUser: 0,
        rememberChannelDuration: 0,
      };
      const applied = applyConfigDefaults(config);
      
      expect(applied.maxUsersPerChannel).toBe(0);
      expect(applied.listenersPerChannel).toBe(0);
      expect(applied.listenersPerUser).toBe(0);
      expect(applied.rememberChannelDuration).toBe(0);
      
      expect(() => validateHubConfig(applied)).not.toThrow();
    });

    it('should handle kdfIterations = -1 (auto benchmark)', () => {
      const config = {
        ...getMinimalConfig(),
        kdfIterations: -1,
      };
      const applied = applyConfigDefaults(config);
      
      expect(applied.kdfIterations).toBe(-1);
      expect(() => validateHubConfig(applied)).not.toThrow();
    });

    it('should handle large numeric values within limits', () => {
      const config = {
        ...getMinimalConfig(),
        maxUsers: 10000,
        channelCountLimit: 50000,
        bandwidth: 10000000,
        textMessageLength: 50000,
      };
      const applied = applyConfigDefaults(config);
      
      expect(applied.maxUsers).toBe(10000);
      expect(applied.channelCountLimit).toBe(50000);
      expect(applied.bandwidth).toBe(10000000);
      expect(applied.textMessageLength).toBe(50000);
      
      expect(() => validateHubConfig(applied)).not.toThrow();
    });

    it('should handle empty optional strings', () => {
      const config = {
        ...getMinimalConfig(),
        serverPassword: '',
        welcomeText: '',
        registerPassword: '',
      };
      const applied = applyConfigDefaults(config);
      
      // 空字符串应该被保留，不应该被替换为默认值
      expect(applied.serverPassword).toBe('');
      expect(applied.welcomeText).toBe('');
      expect(applied.registerPassword).toBe('');
      
      expect(() => validateHubConfig(applied)).not.toThrow();
    });

    it('should handle all boolean flags', () => {
      const config = {
        ...getMinimalConfig(),
        allowHTML: false,
        forceExternalAuth: true,
        rememberChannel: false,
        bonjour: true,
        broadcastListenerVolumeAdjustments: true,
        allowRecording: false,
        sendVersion: false,
        allowPing: false,
      };
      const applied = applyConfigDefaults(config);
      
      expect(applied.allowHTML).toBe(false);
      expect(applied.forceExternalAuth).toBe(true);
      expect(applied.rememberChannel).toBe(false);
      expect(applied.bonjour).toBe(true);
      expect(applied.broadcastListenerVolumeAdjustments).toBe(true);
      expect(applied.allowRecording).toBe(false);
      expect(applied.sendVersion).toBe(false);
      expect(applied.allowPing).toBe(false);
      
      expect(() => validateHubConfig(applied)).not.toThrow();
    });
  });

  describe('Configuration Warnings (Non-blocking)', () => {
    it('should log warning for allowHTML = true but not throw', () => {
      const config = {
        ...getMinimalConfig(),
        allowHTML: true,
      };
      // 应该生成警告但不抛出异常
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should log warning for missing serverPassword but not throw', () => {
      const config = getMinimalConfig();
      // 没有设置 serverPassword 应该生成警告但不抛出异常
      expect(() => validateHubConfig(config)).not.toThrow();
    });

    it('should log warning for low kdfIterations but not throw', () => {
      const config = {
        ...getMinimalConfig(),
        kdfIterations: 1000, // 低于推荐值 100000
      };
      // 应该生成警告但不抛出异常
      expect(() => validateHubConfig(config)).not.toThrow();
    });
  });

  describe('Full Configuration Scenarios', () => {
    it('should handle production-like configuration', () => {
      const config: HubConfig = {
        ...getMinimalConfig(),
        name: 'Production Hub',
        port: 64738,
        timeout: 60,
        serverPassword: 'secure-password',
        maxUsers: 5000,
        maxUsersPerChannel: 100,
        channelNestingLimit: 15,
        channelCountLimit: 10000,
        bandwidth: 1000000,
        textMessageLength: 10000,
        messageLimit: 2,
        messageBurst: 10,
        kdfIterations: 100000,
        allowHTML: false,
        forceExternalAuth: false,
        usernameRegex: '^[a-zA-Z0-9_-]{3,20}$',
        channelNameRegex: '^[a-zA-Z0-9 _-]{1,50}$',
        autoBan: {
          attempts: 5,
          timeframe: 60,
          duration: 3600,
          banSuccessfulConnections: false,
        },
        defaultChannel: 0,
        rememberChannel: true,
        rememberChannelDuration: 2592000, // 30天
        suggest: {
          version: '1.4.0',
          positional: true,
          pushToTalk: true,
        },
        listenersPerChannel: 50,
        listenersPerUser: 10,
        allowRecording: false,
        sendVersion: true,
        allowPing: true,
        logDays: 90,
        database: {
          ...getMinimalConfig().database,
          walMode: true,
        },
        blobStore: {
          enabled: true,
          path: path.join(tempDir, 'blobs'),
        },
        webApi: {
          enabled: true,
          port: 8080,
          cors: true,
        },
      };

      const applied = applyConfigDefaults(config);
      expect(() => validateHubConfig(applied)).not.toThrow();
      
      const hub = new HubServer(applied);
      expect(hub).toBeDefined();
    });

    it('should handle minimal configuration with all defaults', () => {
      const config = getMinimalConfig();
      const applied = applyConfigDefaults(config);
      
      expect(() => validateHubConfig(applied)).not.toThrow();
      
      const hub = new HubServer(applied);
      expect(hub).toBeDefined();
      
      // 验证所有默认值都已应用
      expect(applied.timeout).toBe(30);
      expect(applied.maxUsers).toBe(1000);
      expect(applied.bandwidth).toBe(558000);
      expect(applied.allowHTML).toBe(true);
      expect(applied.rememberChannel).toBe(true);
      expect(applied.bonjour).toBe(false);
    });

    it('should handle configuration with mixed custom and default values', () => {
      const config = {
        ...getMinimalConfig(),
        timeout: 90,
        maxUsers: 2000,
        // bandwidth 使用默认值
        // allowHTML 使用默认值
        autoBan: {
          attempts: 8,
          // 其他字段使用默认值
          timeframe: 120,
          duration: 300,
          banSuccessfulConnections: true,
        },
      };

      const applied = applyConfigDefaults(config);
      expect(() => validateHubConfig(applied)).not.toThrow();
      
      expect(applied.timeout).toBe(90); // 自定义
      expect(applied.maxUsers).toBe(2000); // 自定义
      expect(applied.bandwidth).toBe(558000); // 默认
      expect(applied.allowHTML).toBe(true); // 默认
      expect(applied.autoBan?.attempts).toBe(8); // 自定义
      expect(applied.autoBan?.timeframe).toBe(120); // 自定义
    });
  });

  describe('Configuration Persistence and Reload', () => {
    it('should save and load configuration with all values', async () => {
      const config: HubConfig = {
        ...getMinimalConfig(),
        timeout: 45,
        maxUsers: 1500,
        bandwidth: 800000,
        autoBan: {
          attempts: 7,
          timeframe: 90,
          duration: 450,
          banSuccessfulConnections: true,
        },
      };

      const configPath = path.join(tempDir, 'hub-config.json');
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      const loaded = JSON.parse(await fs.readFile(configPath, 'utf-8')) as HubConfig;
      const applied = applyConfigDefaults(loaded);

      expect(() => validateHubConfig(applied)).not.toThrow();
      expect(applied.timeout).toBe(45);
      expect(applied.maxUsers).toBe(1500);
      expect(applied.bandwidth).toBe(800000);
      expect(applied.autoBan?.attempts).toBe(7);
    });
  });
});
