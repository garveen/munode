/**
 * PreConnect State 集成测试
 * 
 * 测试客户端在认证前设置的状态（self_mute, self_deaf等）是否：
 * 1. 正确传输到 Hub
 * 2. 保存到 Hub 的 session manager
 * 3. 广播给所有其他客户端
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';

// Helper function for async delays
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('PreConnect State Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8097);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Self Deaf/Mute State', () => {
    it('should preserve and broadcast self_deaf state set before authentication', async () => {
      const clientA = new MumbleClient();
      const clientB = new MumbleClient();
      
      // 用户 A 先登录，作为观察者
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      
      expect(clientA.isConnected()).toBe(true);
      
      // 等待用户 A 完全同步
      await sleep(500);
      
      const userStateUpdates: Array<{
        session?: number;
        self_deaf?: boolean;
        self_mute?: boolean;
      }> = [];
      
      clientA.on('userState', (state) => {
        userStateUpdates.push({
          session: state.session,
          self_deaf: state.self_deaf,
          self_mute: state.self_mute,
        });
      });
      
      // 用户 B 连接，并设置 self_deaf=true
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
        // PreConnect state: 客户端在认证前设置的状态
        preConnectState: {
          self_deaf: true,
        },
      });
      
      expect(clientB.isConnected()).toBe(true);
      
      // 等待状态广播
      await sleep(1000);
      
      // 验证用户 B 自己看到的状态
      const clientBSession = clientB.getStateManager().getSession();
      console.log(`[TEST] Client B session:`, clientBSession);
      expect(clientBSession).toBeDefined();
      expect(clientBSession?.self_deaf).toBe(true);
      expect(clientBSession?.self_mute).toBe(true); // self_deaf 应该自动设置 self_mute
      
      // 验证用户 A 收到的状态更新
      const clientBSessionId = clientBSession?.session;
      const userBStateUpdate = userStateUpdates.find(
        (update) => update.session === clientBSessionId
      );
      
      console.log(`[TEST] User state updates received by Client A:`, userStateUpdates);
      console.log(`[TEST] Client B state as seen by A:`, userBStateUpdate);
      
      expect(userBStateUpdate).toBeDefined();
      expect(userBStateUpdate?.self_deaf).toBe(true);
      expect(userBStateUpdate?.self_mute).toBe(true);
      
      // 验证用户 A 能在用户列表中看到用户 B 的正确状态
      const usersSeenByA = clientA.getUsers();
      const userBSeenByA = usersSeenByA.find((u) => u.name === 'user2');
      
      console.log(`[TEST] Users seen by A:`, usersSeenByA.map(u => ({
        name: u.name,
        session: u.session,
        self_deaf: u.self_deaf,
        self_mute: u.self_mute,
      })));
      
      expect(userBSeenByA).toBeDefined();
      expect(userBSeenByA?.self_deaf).toBe(true);
      expect(userBSeenByA?.self_mute).toBe(true);
      
      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
    });

    it('should preserve and broadcast self_mute state set before authentication', async () => {
      const clientA = new MumbleClient();
      const clientB = new MumbleClient();
      
      // 用户 A 先登录，作为观察者
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });
      
      expect(clientA.isConnected()).toBe(true);
      
      // 等待用户 A 完全同步
      await sleep(500);
      
      const userStateUpdates: Array<{
        session?: number;
        self_deaf?: boolean;
        self_mute?: boolean;
      }> = [];
      
      clientA.on('userState', (state) => {
        userStateUpdates.push({
          session: state.session,
          self_deaf: state.self_deaf,
          self_mute: state.self_mute,
        });
      });
      
      // 用户 B 连接，并设置 self_mute=true
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
        // PreConnect state: 客户端在认证前设置的状态
        preConnectState: {
          self_mute: true,
        },
      });
      
      expect(clientB.isConnected()).toBe(true);
      
      // 等待状态广播
      await sleep(1000);
      
      // 验证用户 B 自己看到的状态
      const clientBSession = clientB.getStateManager().getSession();
      expect(clientBSession).toBeDefined();
      expect(clientBSession?.self_mute).toBe(true);
      // self_mute 不会自动设置 self_deaf，默认为 false
      expect(clientBSession?.self_deaf).toBe(false);
      
      // 验证用户 A 能看到用户 B 的正确状态
      const usersSeenByA = clientA.getUsers();
      const userBSeenByA = usersSeenByA.find((u) => u.name === 'guest');
      
      expect(userBSeenByA).toBeDefined();
      expect(userBSeenByA?.self_mute).toBe(true);
      expect(userBSeenByA?.self_deaf).toBe(false);
      
      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
    });

    it('should handle both self_deaf and self_mute set to false', async () => {
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
      
      await sleep(500);
      
      // 用户 B 连接，明确设置 self_deaf=false, self_mute=false
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
        preConnectState: {
          self_deaf: false,
          self_mute: false,
        },
      });
      
      await sleep(1000);
      
      // 验证状态
      const clientBSession = clientB.getStateManager().getSession();
      expect(clientBSession?.self_deaf).toBe(false);
      expect(clientBSession?.self_mute).toBe(false);
      
      // 用户 A 看到的状态
      const usersSeenByA = clientA.getUsers();
      const userBSeenByA = usersSeenByA.find((u) => u.name === 'user2');
      
      expect(userBSeenByA?.self_deaf).toBe(false);
      expect(userBSeenByA?.self_mute).toBe(false);
      
      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
    });
  });

  describe('Cross-Edge PreConnect State', () => {
    it('should broadcast preconnect state across different edges', async () => {
      const clientEdge1 = new MumbleClient();
      const clientEdge2 = new MumbleClient();
      
      // 用户 A 连接到 Edge 1
      await clientEdge1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      
      await sleep(500);
      
      // 用户 B 连接到 Edge 2，设置 self_deaf
      await clientEdge2.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
        preConnectState: {
          self_deaf: true,
        },
      });
      
      await sleep(1000);
      
      // Edge 1 上的用户应该能看到 Edge 2 上用户的 self_deaf 状态
      const usersOnEdge1 = clientEdge1.getUsers();
      const edge2User = usersOnEdge1.find((u) => u.name === 'user2');
      
      expect(edge2User).toBeDefined();
      expect(edge2User?.self_deaf).toBe(true);
      expect(edge2User?.self_mute).toBe(true);
      
      // Edge 2 上的用户自己也应该看到正确的状态
      const clientEdge2Session = clientEdge2.getStateManager().getSession();
      expect(clientEdge2Session?.self_deaf).toBe(true);
      expect(clientEdge2Session?.self_mute).toBe(true);
      
      // 清理
      await clientEdge1.disconnect();
      await clientEdge2.disconnect();
    });
  });
});
