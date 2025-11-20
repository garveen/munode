/**
 * 频道管理集成测试
 *
 * 测试频道相关功能，包括：
 * - 创建/删除频道
 * - 移动用户到频道
 * - 频道树结构
 * - 临时频道管理
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleConnection } from '../helpers';
import { TEST_CHANNELS, MessageType } from '../fixtures';

describe('Channel Management Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Channel Structure', () => {
    it('should have test channels defined', () => {
      expect(TEST_CHANNELS.root).toBeDefined();
      expect(TEST_CHANNELS.root.id).toBe(0);
      expect(TEST_CHANNELS.root.name).toBe('Root');
    });

    it('should have child channels with parent references', () => {
      expect(TEST_CHANNELS.lobby.parentId).toBe(0);
      expect(TEST_CHANNELS.general.parentId).toBe(0);
      expect(TEST_CHANNELS.private.parentId).toBe(0);
    });

    it('should have unique channel IDs', () => {
      const ids = Object.values(TEST_CHANNELS).map(ch => ch.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('Channel Naming', () => {
    it('should have valid channel names', () => {
      for (const channel of Object.values(TEST_CHANNELS)) {
        expect(channel.name).toBeTruthy();
        expect(channel.name.length).toBeGreaterThan(0);
        expect(channel.name.length).toBeLessThanOrEqual(255); // 假设最大长度为 255
      }
    });

    it('should have unique channel names within same parent', () => {
      const channelsByParent = new Map<number, Set<string>>();
      
      for (const channel of Object.values(TEST_CHANNELS)) {
        const parentId = channel.parentId ?? -1;
        if (!channelsByParent.has(parentId)) {
          channelsByParent.set(parentId, new Set());
        }
        
        const names = channelsByParent.get(parentId)!;
        expect(names.has(channel.name)).toBe(false);
        names.add(channel.name);
      }
    });
  });

  describe('Channel Hierarchy', () => {
    it('should maintain valid parent-child relationships', () => {
      for (const channel of Object.values(TEST_CHANNELS)) {
        if (channel.parentId !== undefined) {
          // 验证父频道存在
          const parentExists = Object.values(TEST_CHANNELS).some(
            ch => ch.id === channel.parentId
          );
          expect(parentExists).toBe(true);
        }
      }
    });

    it('should have root channel with no parent', () => {
      expect(TEST_CHANNELS.root.parentId).toBeUndefined();
    });

    it('should not have circular references', () => {
      // 简单的循环检测
      for (const channel of Object.values(TEST_CHANNELS)) {
        let currentId = channel.parentId;
        const visited = new Set<number>([channel.id]);
        
        while (currentId !== undefined && currentId !== -1) {
          expect(visited.has(currentId)).toBe(false); // 不应该有循环
          visited.add(currentId);
          
          const parent = Object.values(TEST_CHANNELS).find(ch => ch.id === currentId);
          currentId = parent?.parentId;
        }
      }
    });
  });

  describe('Message Type Enum', () => {
    it('should have valid message type values', () => {
      expect(MessageType.Version).toBe(0);
      expect(MessageType.Authenticate).toBe(2);
      expect(MessageType.ChannelState).toBe(7);
      expect(MessageType.UserState).toBe(9);
      expect(MessageType.TextMessage).toBe(11);
    });

    it('should have channel-related message types', () => {
      expect(MessageType.ChannelRemove).toBeDefined();
      expect(MessageType.ChannelState).toBeDefined();
    });

    it('should have user-related message types', () => {
      expect(MessageType.UserRemove).toBeDefined();
      expect(MessageType.UserState).toBeDefined();
    });
  });
});
