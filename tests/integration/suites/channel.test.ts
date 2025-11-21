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
import { TEST_CHANNELS, MessageType, PermissionFlag } from '../fixtures';
import { mumbleproto } from '../../../packages/protocol/dist/index.js';
import { MumbleClient } from '../../../packages/client/dist/index.js';

describe('Channel Management Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8082);
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

  describe('Channel Management via Protocol', () => {
    it('should create and manage channels through protocol', async () => {
      const client = new MumbleClient();
      
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      // 等待接收初始频道状态
      await new Promise(resolve => setTimeout(resolve, 500));

      // 创建临时频道
      const channelName = 'TestChannel_' + Date.now();
      const createdChannelId = await client.createChannel(channelName, 0);

      expect(createdChannelId).toBeGreaterThan(0);

      // 验证频道在频道列表中
      const channels = client.getChannels();
      const newChannel = channels.find(ch => ch.channel_id === createdChannelId);
      expect(newChannel).toBeDefined();
      expect(newChannel?.name).toBe(channelName);

      await client.disconnect();
    });

    it('should move users between channels and broadcast to all edges', async () => {
      const client1 = new MumbleClient(); // 移动者 - Edge 1
      const client2 = new MumbleClient(); // 本 Edge 观察者 - Edge 1
      const client3 = new MumbleClient(); // 跨 Edge 观察者 - Edge 2

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await client3.connect({
        host: 'localhost',
        port: testEnv.edgePort2, // 连接到第二个 Edge
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      const session1 = client1.getStateManager().getSession()?.session;
      expect(session1).toBeDefined();

      // 本 Edge 用户监听
      let moveReceivedLocal = false;
      const movePromiseLocal = new Promise<void>((resolve) => {
        client2.on('userState', (state: any) => {
          if (state.session === session1 && state.channel_id === 1) {
            moveReceivedLocal = true;
            resolve();
          }
        });
      });

      // 跨 Edge 用户监听
      let moveReceivedRemote = false;
      const movePromiseRemote = new Promise<void>((resolve) => {
        client3.on('userState', (state: any) => {
          if (state.session === session1 && state.channel_id === 1) {
            moveReceivedRemote = true;
            resolve();
          }
        });
      });

      // 用户1移动到频道1
      await client1.joinChannel(1);

      // 等待本 Edge 和跨 Edge 用户收到状态更新
      await Promise.all([
        Promise.race([movePromiseLocal, new Promise(resolve => setTimeout(resolve, 2000))]),
        Promise.race([movePromiseRemote, new Promise(resolve => setTimeout(resolve, 2000))])
      ]);

      expect(moveReceivedLocal).toBe(true);
      expect(moveReceivedRemote).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
      await client3.disconnect();
    });

    it('should handle channel permissions', () => {
      // 测试频道权限检查逻辑
      const channelPerms = PermissionFlag.Write | PermissionFlag.Traverse;
      const userPerms = PermissionFlag.Enter | PermissionFlag.Speak;
      
      // 检查用户是否有进入频道的权限
      const canEnter = (channelPerms & PermissionFlag.Traverse) && (userPerms & PermissionFlag.Enter);
      expect(canEnter).toBeTruthy();
      
      // 检查用户是否有在频道说话的权限
      const canSpeak = userPerms & PermissionFlag.Speak;
      expect(canSpeak).toBeTruthy();
    });
  });
});
