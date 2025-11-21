/**
 * 配置默认值测试
 */

import { describe, it, expect } from 'vitest';
import { applyConfigDefaults, CONFIG_DEFAULTS } from '../config-defaults.js';
import type { HubConfig } from '../types.js';

describe('Config Defaults', () => {
  const minimalConfig: HubConfig = {
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

  describe('applyConfigDefaults', () => {
    it('should apply default values for undefined config options', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.timeout).toBe(CONFIG_DEFAULTS.timeout);
      expect(config.maxUsers).toBe(CONFIG_DEFAULTS.maxUsers);
      expect(config.channelNestingLimit).toBe(CONFIG_DEFAULTS.channelNestingLimit);
      expect(config.bandwidth).toBe(CONFIG_DEFAULTS.bandwidth);
      expect(config.textMessageLength).toBe(CONFIG_DEFAULTS.textMessageLength);
      expect(config.allowHTML).toBe(CONFIG_DEFAULTS.allowHTML);
    });

    it('should not override explicitly set values', () => {
      const customConfig: HubConfig = {
        ...minimalConfig,
        timeout: 60,
        maxUsers: 500,
        allowHTML: false,
      };

      const config = applyConfigDefaults(customConfig);

      expect(config.timeout).toBe(60);
      expect(config.maxUsers).toBe(500);
      expect(config.allowHTML).toBe(false);
    });

    it('should apply default autoBan config when not provided', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.autoBan).toBeDefined();
      expect(config.autoBan?.attempts).toBe(10);
      expect(config.autoBan?.timeframe).toBe(120);
      expect(config.autoBan?.duration).toBe(300);
      expect(config.autoBan?.banSuccessfulConnections).toBe(true);
    });

    it('should merge partial autoBan config with defaults', () => {
      const customConfig: HubConfig = {
        ...minimalConfig,
        autoBan: {
          attempts: 5,
          timeframe: 120,
          duration: 300,
          banSuccessfulConnections: true,
        },
      };

      const config = applyConfigDefaults(customConfig);

      expect(config.autoBan?.attempts).toBe(5);
      expect(config.autoBan?.timeframe).toBe(120);
    });

    it('should apply default suggest config when not provided', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.suggest).toBeDefined();
      expect(config.suggest?.version).toBeUndefined();
      expect(config.suggest?.positional).toBeNull();
      expect(config.suggest?.pushToTalk).toBeNull();
    });

    it('should preserve original database config and add walMode default', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.database.path).toBe('./test.db');
      expect(config.database.walMode).toBe(false);
    });

    it('should apply regex defaults', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.usernameRegex).toBe(CONFIG_DEFAULTS.usernameRegex);
      expect(config.channelNameRegex).toBe(CONFIG_DEFAULTS.channelNameRegex);
    });

    it('should apply channel behavior defaults', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.defaultChannel).toBe(0);
      expect(config.rememberChannel).toBe(true);
      expect(config.rememberChannelDuration).toBe(0);
    });

    it('should apply message limit defaults', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.messageLimit).toBe(1);
      expect(config.messageBurst).toBe(5);
      expect(config.pluginMessageLimit).toBe(4);
      expect(config.pluginMessageBurst).toBe(15);
    });

    it('should apply listener limit defaults', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.listenersPerChannel).toBe(0);
      expect(config.listenersPerUser).toBe(0);
      expect(config.broadcastListenerVolumeAdjustments).toBe(false);
    });

    it('should apply advanced feature defaults', () => {
      const config = applyConfigDefaults(minimalConfig);

      expect(config.allowRecording).toBe(true);
      expect(config.sendVersion).toBe(true);
      expect(config.allowPing).toBe(true);
      expect(config.logDays).toBe(31);
    });
  });
});
