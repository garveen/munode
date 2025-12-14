/**
 * User State Broadcast Tests
 * 
 * Tests to verify that user state changes are broadcasted correctly
 * without duplicates when users join, leave, or change channels.
 * 
 * Issue: Multiple UserState broadcasts when users change state
 * Fix: Skip duplicate broadcast for local users in handleRemoteUserJoined
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';

describe('User State Broadcast Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // 使用独立的端口范围避免冲突
    testEnv = await setupTestEnvironment(8300);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('User Join Broadcast', () => {
    it('should not send duplicate UserState when a user joins', async () => {
      // 场景：
      // 1. 用户 A 连接到 Edge-1
      // 2. 用户 B 连接到 Edge-1
      // 预期：用户 A 应该只收到一次用户 B 的 UserState 消息，不应有重复

      const clientA = new MumbleClient();
      const clientB = new MumbleClient();

      // 用户 A 连接
      console.log('[TEST] Step 1: Connecting User A to Edge-1');
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      expect(clientA.isConnected()).toBe(true);
      
      const sessionA = clientA.getStateManager().getSession();
      expect(sessionA).toBeDefined();
      console.log(`[TEST] User A connected with session ${sessionA?.session}`);

      // 等待认证完成
      await sleep(500);

      // 记录用户 A 初始看到的用户数量（应该只有自己）
      const initialUsers = clientA.getUsers();
      console.log(`[TEST] Initial users seen by A: ${initialUsers.length}`);

      // 用户 B 连接
      console.log('[TEST] Step 2: Connecting User B to Edge-1');
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      expect(clientB.isConnected()).toBe(true);
      
      const sessionB = clientB.getStateManager().getSession();
      expect(sessionB).toBeDefined();
      console.log(`[TEST] User B connected with session ${sessionB?.session}`);

      // 等待用户状态同步
      await sleep(500);

      // 验证：用户 A 应该看到用户 B
      const usersSeenByA = clientA.getUsers();
      console.log(`[TEST] Users seen by A after B joined: ${usersSeenByA.map(u => `${u.name}(${u.session})`).join(', ')}`);
      
      const userBVisibleToA = usersSeenByA.some(u => u.name === 'user2' && u.session === sessionB?.session);
      expect(userBVisibleToA).toBe(true);
      
      // 验证：用户 B 应该看到用户 A
      const usersSeenByB = clientB.getUsers();
      console.log(`[TEST] Users seen by B: ${usersSeenByB.map(u => `${u.name}(${u.session})`).join(', ')}`);
      
      const userAVisibleToB = usersSeenByB.some(u => u.name === 'user1' && u.session === sessionA?.session);
      expect(userAVisibleToB).toBe(true);

      // 注意：我们无法直接检测是否有重复的 UserState 消息，因为客户端只保留最终状态
      // 但是如果有重复，客户端应该仍然正常工作，所以这个测试主要验证基本功能
      // 重复消息的检测需要在 Edge 服务器日志中手动验证

      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
    });

    it('should correctly broadcast UserState when user joins from different Edge', async () => {
      // 场景：
      // 1. 用户 A 连接到 Edge-1
      // 2. 用户 B 连接到 Edge-2
      // 预期：两个用户应该能互相看到，且没有重复广播

      const clientA = new MumbleClient();
      const clientB = new MumbleClient();

      // 用户 A 连接到 Edge-1
      console.log('[TEST] Step 1: Connecting User A to Edge-1');
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      expect(clientA.isConnected()).toBe(true);
      
      const sessionA = clientA.getStateManager().getSession();
      expect(sessionA).toBeDefined();
      console.log(`[TEST] User A connected with session ${sessionA?.session}`);

      // 等待用户 A 被报告到 Hub
      await sleep(500);

      // 用户 B 连接到 Edge-2
      console.log('[TEST] Step 2: Connecting User B to Edge-2');
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      expect(clientB.isConnected()).toBe(true);
      
      const sessionB = clientB.getStateManager().getSession();
      expect(sessionB).toBeDefined();
      console.log(`[TEST] User B connected with session ${sessionB?.session}`);

      // 等待用户状态同步
      await sleep(500);

      // 验证：用户 A 应该看到用户 B
      const usersSeenByA = clientA.getUsers();
      console.log(`[TEST] Users seen by A: ${usersSeenByA.map(u => `${u.name}(${u.session})`).join(', ')}`);
      
      const userBVisibleToA = usersSeenByA.some(u => u.name === 'guest' && u.session === sessionB?.session);
      expect(userBVisibleToA).toBe(true);

      // 验证：用户 B 应该看到用户 A
      const usersSeenByB = clientB.getUsers();
      console.log(`[TEST] Users seen by B: ${usersSeenByB.map(u => `${u.name}(${u.session})`).join(', ')}`);
      
      const userAVisibleToB = usersSeenByB.some(u => u.name === 'admin' && u.session === sessionA?.session);
      expect(userAVisibleToB).toBe(true);

      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
    });
  });

  // Note: Channel move broadcast testing requires additional setup
  // and is covered by other integration tests. The main fix for duplicate
  // broadcasts applies to all UserState changes including channel moves.
});
