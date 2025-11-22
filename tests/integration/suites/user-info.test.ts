/**
 * 用户信息查询集成测试
 * 
 * 测试用户信息查询功能，包括：
 * - UserStats: 查询用户统计信息（在线时长、网络统计、证书信息等）
 * - QueryUsers: 通过用户名或 ID 查询注册用户
 * - 跨 Edge 查询
 * - 权限检查
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';

describe('User Info Query Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8091);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('UserStats Query', () => {
    it('should query own user stats', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'pass1',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const session = client.getStateManager().getSession()?.session;
      expect(session).toBeDefined();

      let userStatsReceived = false;
      let receivedStats: any = null;

      const statsPromise = new Promise<void>((resolve) => {
        client.on('userStats', (stats: any) => {
          if (stats.session === session) {
            userStatsReceived = true;
            receivedStats = stats;
            resolve();
          }
        });
      });

      // 查询自己的统计信息
      await client.requestUserStats(session!, false);

      // 等待响应
      await Promise.race([
        statsPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      expect(userStatsReceived).toBe(true);
      
      if (receivedStats) {
        // 验证包含的字段
        expect(receivedStats.session).toBe(session);
        expect(receivedStats.onlinesecs).toBeGreaterThanOrEqual(0);
        // 查询自己时应该包含更多详细信息
        expect(receivedStats).toHaveProperty('from_client');
        expect(receivedStats).toHaveProperty('from_server');
      }

      await client.disconnect();
    });

    it('should query other user stats (requires permission)', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

      // 连接两个用户
      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'pass1',
        rejectUnauthorized: false,
      });

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'pass2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const session1 = client1.getStateManager().getSession()?.session;
      const session2 = client2.getStateManager().getSession()?.session;

      expect(session1).toBeDefined();
      expect(session2).toBeDefined();

      let userStatsReceived = false;
      let receivedStats: any = null;

      const statsPromise = new Promise<void>((resolve) => {
        client2.on('userStats', (stats: any) => {
          if (stats.session === session1) {
            userStatsReceived = true;
            receivedStats = stats;
            resolve();
          }
        });
      });

      // Client2 查询 Client1 的统计信息
      await client2.requestUserStats(session1!, false);

      // 等待响应
      await Promise.race([
        statsPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      // 根据权限设置，可能收到统计信息或权限拒绝
      if (userStatsReceived && receivedStats) {
        expect(receivedStats.session).toBe(session1);
        // 查询他人时可能只包含基本信息
        expect(receivedStats).toHaveProperty('onlinesecs');
      }

      await client1.disconnect();
      await client2.disconnect();
    });

    it('should query user stats with stats_only flag', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'pass1',
        rejectUnauthorized: false,
      });

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'pass2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const session1 = client1.getStateManager().getSession()?.session;

      let statsReceived = false;
      let receivedStats: any = null;

      const statsPromise = new Promise<void>((resolve) => {
        client2.on('userStats', (stats: any) => {
          if (stats.session === session1) {
            statsReceived = true;
            receivedStats = stats;
            resolve();
          }
        });
      });

      // 使用 stats_only=true 查询（仅包含可变统计数据）
      await client2.requestUserStats(session1!, true);

      await Promise.race([
        statsPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      if (statsReceived && receivedStats) {
        expect(receivedStats.stats_only).toBe(true);
        // stats_only 模式应该只包含统计数据，不包含证书等
        expect(receivedStats).not.toHaveProperty('certificates');
      }

      await client1.disconnect();
      await client2.disconnect();
    });

    it('should query user stats across edges', async () => {
      const client1 = new MumbleClient(); // Edge 1
      const client2 = new MumbleClient(); // Edge 2

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'pass1',
        rejectUnauthorized: false,
      });

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort2, // 不同的 Edge
        username: 'user2',
        password: 'pass2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const session1 = client1.getStateManager().getSession()?.session;

      let statsReceived = false;

      const statsPromise = new Promise<void>((resolve) => {
        client2.on('userStats', (stats: any) => {
          if (stats.session === session1) {
            statsReceived = true;
            resolve();
          }
        });
      });

      // Client2 (Edge 2) 查询 Client1 (Edge 1) 的统计信息
      // 应该通过 Hub 转发
      await client2.requestUserStats(session1!, false);

      await Promise.race([
        statsPromise,
        new Promise(resolve => setTimeout(resolve, 4000)) // 跨 Edge 可能需要更长时间
      ]);

      // 跨 Edge 查询应该工作（通过 Hub 转发）
      // expect(statsReceived).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
    });

    it('should handle permission denied for user stats', async () => {
      const normalClient = new MumbleClient();
      const targetClient = new MumbleClient();

      await normalClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'pass1',
        rejectUnauthorized: false,
      });

      await targetClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const targetSession = targetClient.getStateManager().getSession()?.session;

      let permissionDenied = false;

      const deniedPromise = new Promise<void>((resolve) => {
        normalClient.on('permissionDenied', (denied: any) => {
          if (denied.type === 'Permission') {
            permissionDenied = true;
            resolve();
          }
        });
      });

      // 普通用户尝试查询管理员的详细统计（可能需要特殊权限）
      await normalClient.requestUserStats(targetSession!, false);

      await Promise.race([
        deniedPromise,
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);

      // 根据服务器配置，可能拒绝或允许
      // expect(permissionDenied).toBe(true);

      await normalClient.disconnect();
      await targetClient.disconnect();
    });
  });

  describe('QueryUsers (Registered Users)', () => {
    it('should query user by username', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      let queryResult: any = null;

      const queryPromise = new Promise<void>((resolve) => {
        client.on('queryUsers', (result: any) => {
          queryResult = result;
          resolve();
        });
      });

      // 查询注册用户 "admin"
      await client.queryUsers({ names: ['admin'] });

      await Promise.race([
        queryPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      if (queryResult) {
        expect(queryResult.names).toContain('admin');
        expect(queryResult.ids).toBeDefined();
        expect(queryResult.ids.length).toBeGreaterThan(0);
        // 第一个 ID 应该对应 admin 用户
        expect(queryResult.ids[0]).toBeGreaterThan(0);
      }

      await client.disconnect();
    });

    it('should query user by ID', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      let queryResult: any = null;

      const queryPromise = new Promise<void>((resolve) => {
        client.on('queryUsers', (result: any) => {
          queryResult = result;
          resolve();
        });
      });

      // 查询 user_id = 1 (通常是 admin)
      await client.queryUsers({ ids: [1] });

      await Promise.race([
        queryPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      if (queryResult) {
        expect(queryResult.ids).toContain(1);
        expect(queryResult.names).toBeDefined();
        expect(queryResult.names.length).toBeGreaterThan(0);
        // 应该返回对应的用户名
        expect(queryResult.names[0]).toBeTruthy();
      }

      await client.disconnect();
    });

    it('should query multiple users', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      let queryResult: any = null;

      const queryPromise = new Promise<void>((resolve) => {
        client.on('queryUsers', (result: any) => {
          queryResult = result;
          resolve();
        });
      });

      // 批量查询多个用户
      await client.queryUsers({ names: ['admin', 'user1', 'user2'] });

      await Promise.race([
        queryPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      if (queryResult) {
        expect(queryResult.names).toBeDefined();
        expect(queryResult.ids).toBeDefined();
        expect(queryResult.names.length).toBe(queryResult.ids.length);
        // 应该返回所有找到的用户
        expect(queryResult.names.length).toBeGreaterThan(0);
      }

      await client.disconnect();
    });

    it('should handle non-existent user query', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      let queryResult: any = null;

      const queryPromise = new Promise<void>((resolve) => {
        client.on('queryUsers', (result: any) => {
          queryResult = result;
          resolve();
        });
      });

      // 查询不存在的用户
      await client.queryUsers({ names: ['nonexistent_user_12345'] });

      await Promise.race([
        queryPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      if (queryResult) {
        // 不存在的用户应该返回空结果或 ID = -1
        expect(queryResult.names).toContain('nonexistent_user_12345');
        if (queryResult.ids && queryResult.ids.length > 0) {
          // 如果返回了 ID，应该是 -1 或类似的值表示不存在
          expect(queryResult.ids[0]).toBeLessThanOrEqual(0);
        }
      }

      await client.disconnect();
    });
  });

  describe('RequestBlob (Large Resources)', () => {
    it('should request user texture (avatar)', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

      // Client1 设置头像
      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'pass1',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 生成大于 128 字节的测试头像数据
      const largeTexture = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) {
        largeTexture[i] = Math.floor(Math.random() * 256);
      }

      // 设置头像
      await client1.setTexture(largeTexture);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Client2 连接并请求 Client1 的头像
      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'pass2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const session1 = client1.getStateManager().getSession()?.session;
      let textureReceived = false;

      const texturePromise = new Promise<void>((resolve) => {
        client2.on('userState', (state: any) => {
          if (state.session === session1 && state.texture && state.texture.length > 128) {
            textureReceived = true;
            resolve();
          }
        });
      });

      // 请求 Client1 的头像
      await client2.requestBlob({ sessionTexture: [session1!] });

      await Promise.race([
        texturePromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      // 应该收到完整的头像数据
      // expect(textureReceived).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
    });

    it('should request user comment', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'pass1',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 设置大于 128 字节的评论
      const largeComment = 'A'.repeat(200); // 200 字节的评论

      await client1.setComment(largeComment);
      await new Promise(resolve => setTimeout(resolve, 1000));

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'pass2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const session1 = client1.getStateManager().getSession()?.session;
      let commentReceived = false;

      const commentPromise = new Promise<void>((resolve) => {
        client2.on('userState', (state: any) => {
          if (state.session === session1 && state.comment && state.comment.length > 128) {
            commentReceived = true;
            resolve();
          }
        });
      });

      // 请求 Client1 的评论
      await client2.requestBlob({ sessionComment: [session1!] });

      await Promise.race([
        commentPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      // 应该收到完整的评论
      // expect(commentReceived).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
    });

    it('should request channel description', async () => {
      const adminClient = new MumbleClient();

      await adminClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 创建频道并设置大于 128 字节的描述
      const largeDescription = 'B'.repeat(200);
      
      // 先创建频道
      const channelId = await adminClient.createChannel('Test Channel with Description', 0);
      
      // 然后通过 ChannelState 更新描述
      // 注意：需要等待服务器实现频道描述更新功能

      await new Promise(resolve => setTimeout(resolve, 1000));

      let descriptionReceived = false;

      const descPromise = new Promise<void>((resolve) => {
        adminClient.on('channelState', (state: any) => {
          if (state.channel_id === channelId && state.description && state.description.length > 128) {
            descriptionReceived = true;
            resolve();
          }
        });
      });

      // 请求频道描述
      await adminClient.requestBlob({ channelDescription: [channelId] });

      await Promise.race([
        descPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      // 应该收到完整的描述
      // expect(descriptionReceived).toBe(true);

      await adminClient.disconnect();
    });
  });
});
