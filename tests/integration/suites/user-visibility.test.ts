/**
 * 用户可见性集成测试
 * 
 * 测试用户登录后对其他用户的可见性，包括：
 * - 新用户登录后应该能看到已在线用户
 * - 确保 reportSession 在 fullSync 请求之前被调用
 * - 多用户并发登录时的可见性
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import type { UserState } from '../../../packages/protocol/src/index.js';

// Helper function for async delays
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('User Visibility Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8095);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('User Visibility on Login', () => {
    it('should see existing user when logging in after them', async () => {
      // 这个测试验证修复的核心问题：
      // 用户 A 登录很久后，用户 B 登录应该能看到用户 A
      
      const clientA = new MumbleClient();
      const clientB = new MumbleClient();
      
      // 用户 A 先登录
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      
      expect(clientA.isConnected()).toBe(true);
      
      // 等待一段时间，模拟 "用户 A 登录很久"
      // 这个等待时间确保 reportSession 有足够时间被处理
      await sleep(500);
      
      // 用户 B 登录
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });
      
      expect(clientB.isConnected()).toBe(true);
      
      // 给一点时间同步用户状态
      await sleep(200);
      
      // 用户 B 应该能看到用户 A
      const usersSeenByB = clientB.getUsers();
      const userAVisible = usersSeenByB.some(u => u.name === 'user1');
      
      expect(userAVisible).toBe(true);
      
      // 用户 A 也应该能看到用户 B（双向可见性）
      const usersSeenByA = clientA.getUsers();
      const userBVisible = usersSeenByA.some(u => u.name === 'user2');
      
      expect(userBVisible).toBe(true);
      
      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
    });

    it('should handle rapid consecutive logins', async () => {
      // 测试快速连续登录时的用户可见性
      const clients: MumbleClient[] = [];
      const userCredentials = [
        { username: 'user_edge1', password: 'user_password' },
        { username: 'user_edge2', password: 'user_password' },
        { username: 'user_state', password: 'user_password' },
      ];
      
      // 快速连续登录所有用户
      for (const cred of userCredentials) {
        const client = new MumbleClient();
        await client.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: cred.username,
          password: cred.password,
          rejectUnauthorized: false,
        });
        clients.push(client);
        // 非常短的间隔
        await sleep(100);
      }
      
      // 等待状态同步
      await sleep(500);
      
      // 验证每个用户都能看到所有其他用户
      for (let i = 0; i < clients.length; i++) {
        const users = clients[i].getUsers();
        
        // 应该能看到所有用户（包括自己）
        expect(users.length).toBeGreaterThanOrEqual(clients.length);
        
        // 检查能否看到其他所有用户
        for (const cred of userCredentials) {
          const visible = users.some(u => u.name === cred.username);
          expect(visible).toBe(true);
        }
      }
      
      // 清理
      for (const client of clients) {
        await client.disconnect();
      }
    });

    it('should see users across edges', async () => {
      // 测试跨 Edge 的用户可见性
      const clientEdge1 = new MumbleClient();
      const clientEdge2 = new MumbleClient();
      
      // 用户 A 连接到 Edge 1
      await clientEdge1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'sender_edge1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      
      // 等待 reportSession 被处理
      await sleep(500);
      
      // 用户 B 连接到 Edge 2
      await clientEdge2.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'sender_edge2',
        password: 'password1',
        rejectUnauthorized: false,
      });
      
      // 等待状态同步
      await sleep(500);
      
      // Edge 2 上的用户应该能看到 Edge 1 上的用户
      const usersOnEdge2 = clientEdge2.getUsers();
      
      const edge1UserVisible = usersOnEdge2.some(u => u.name === 'sender_edge1');
      
      // Edge 1 上的用户也应该能看到 Edge 2 上的用户
      const usersOnEdge1 = clientEdge1.getUsers();
      
      const edge2UserVisible = usersOnEdge1.some(u => u.name === 'sender_edge2');
      
      // Test both to see which one fails
      expect(edge1UserVisible).toBe(true);
      expect(edge2UserVisible).toBe(true);
      
      // 清理
      await clientEdge1.disconnect();
      await clientEdge2.disconnect();
    });
  });

  describe('User State Updates', () => {
    it('should broadcast user state changes to all connected users', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      
      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'receiver1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      
      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'receiver2',
        password: 'password2',
        rejectUnauthorized: false,
      });
      
      await sleep(200);
      
      // 获取 client2 的 session ID
      const client2Session = client2.getStateManager().getSession()?.session;
      expect(client2Session).toBeDefined();
      
      // 监听用户状态更新
      let userStateReceived = false;
      client1.on('userState', (userState: UserState) => {
        if (userState.session === client2Session && userState.self_mute !== undefined) {
          userStateReceived = true;
        }
      });
      
      // 用户 2 设置自己静音
      await client2.setSelfMute(true);
      
      await sleep(500);
      
      // 用户 1 应该收到用户 2 的状态更新
      expect(userStateReceived).toBe(true);
      
      await client1.disconnect();
      await client2.disconnect();
    });
  });
});
