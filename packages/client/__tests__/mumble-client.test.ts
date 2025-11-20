/**
 * MumbleClient Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MumbleClient } from '../src/core/mumble-client.js';
import type { ClientConfig } from '../src/types/client-types.js';

describe('MumbleClient', () => {
  let client: MumbleClient;
  let config: Partial<ClientConfig>;

  beforeEach(() => {
    config = {
      host: 'localhost',
      port: 64738,
      username: 'test-user'
    };
    client = new MumbleClient(config);
  });

  afterEach(async () => {
    if (client.isConnected()) {
      await client.disconnect();
    }
  });

  describe('Initialization', () => {
    it('should create client instance', () => {
      expect(client).toBeInstanceOf(MumbleClient);
    });

    it('should not be connected initially', () => {
      expect(client.isConnected()).toBe(false);
    });

    it('should have required managers', () => {
      expect(client.getConnectionManager()).toBeDefined();
      expect(client.getAuthManager()).toBeDefined();
      expect(client.getStateManager()).toBeDefined();
      expect(client.getACLManager()).toBeDefined();
      expect(client.getPerformanceOptimizer()).toBeDefined();
    });
  });

  describe('Connection Management', () => {
    it('should handle connection lifecycle', async () => {
      // Mock connection for testing
      const mockConnect = vi.fn().mockResolvedValue(undefined);
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);

      // Note: In real implementation, these would be actual connection tests
      // For now, we test the interface
      expect(typeof client.connect).toBe('function');
      expect(typeof client.disconnect).toBe('function');
      expect(typeof client.isConnected).toBe('function');
    });
  });

  describe('Channel Operations', () => {
    it('should provide channel operation methods', () => {
      expect(typeof client.joinChannel).toBe('function');
      expect(typeof client.createChannel).toBe('function');
      expect(typeof client.deleteChannel).toBe('function');
      expect(client.getChannels()).toBeDefined();
    });

    it('should return empty channel list initially', () => {
      const channels = client.getChannels();
      expect(Array.isArray(channels)).toBe(true);
      expect(channels.length).toBe(0);
    });
  });

  describe('User Operations', () => {
    it('should provide user operation methods', () => {
      expect(typeof client.setSelfMute).toBe('function');
      expect(typeof client.setSelfDeaf).toBe('function');
      expect(typeof client.setRecording).toBe('function');
      expect(client.getUsers()).toBeDefined();
    });

    it('should return empty user list initially', () => {
      const users = client.getUsers();
      expect(Array.isArray(users)).toBe(true);
      expect(users.length).toBe(0);
    });
  });

  describe('Message Operations', () => {
    it('should provide message operation methods', () => {
      expect(typeof client.sendMessage).toBe('function');
    });
  });

  describe('ACL Operations', () => {
    it('should provide ACL operation methods', () => {
      expect(typeof client.queryACL).toBe('function');
      expect(typeof client.checkPermission).toBe('function');
      expect(typeof client.saveACL).toBe('function');
      expect(typeof client.addACLEntry).toBe('function');
      expect(typeof client.removeACLEntry).toBe('function');
      expect(typeof client.updateACLEntry).toBe('function');
      expect(typeof client.createChannelGroup).toBe('function');
      expect(typeof client.deleteChannelGroup).toBe('function');
      expect(typeof client.addUserToGroup).toBe('function');
      expect(typeof client.removeUserFromGroup).toBe('function');
    });
  });

  describe('Webhook Operations', () => {
    it('should provide webhook operation methods', () => {
      expect(typeof client.addWebhook).toBe('function');
      expect(typeof client.removeWebhook).toBe('function');
      expect(client.getWebhooks()).toBeDefined();
    });

    it('should return empty webhook map initially', () => {
      const webhooks = client.getWebhooks();
      expect(webhooks instanceof Map).toBe(true);
      expect(webhooks.size).toBe(0);
    });
  });

  describe('Voice Operations', () => {
    it('should provide voice operation methods', () => {
      expect(typeof client.addListeningChannel).toBe('function');
      expect(typeof client.removeListeningChannel).toBe('function');
      expect(typeof client.clearListeningChannels).toBe('function');
      expect(typeof client.setVoiceTarget).toBe('function');
      expect(typeof client.removeVoiceTarget).toBe('function');
      expect(typeof client.sendPluginData).toBe('function');
      expect(typeof client.registerContextAction).toBe('function');
      expect(typeof client.executeContextAction).toBe('function');
    });
  });

  describe('Event Handling', () => {
    it('should extend EventEmitter', () => {
      expect(typeof client.on).toBe('function');
      expect(typeof client.emit).toBe('function');
      expect(typeof client.removeListener).toBe('function');
    });
  });
});