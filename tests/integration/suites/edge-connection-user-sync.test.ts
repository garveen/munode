/**
 * Edge Connection User Synchronization Tests
 * 
 * Tests for issues related to user visibility and state synchronization
 * when edges connect at different times.
 * 
 * Issue 1: User B logging into Edge-2 cannot see User A on Edge-1
 * Issue 2: User state (self_mute/self_deaf) not properly synchronized
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';

describe('Edge Connection User Synchronization Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // 使用独立的端口范围避免冲突
    testEnv = await setupTestEnvironment(8200);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Issue 1: Sequential Edge Connection User Visibility', () => {
    it('User B on Edge-2 should see User A on Edge-1 when Edge-2 connects after User A', async () => {
      // 时序：
      // 1. Edge-1 连接到 Hub ✓ (已经在 setup 中完成)
      // 2. 用户 A 成功连接到 Edge-1
      // 3. Edge-2 连接到 Hub
      // 4. 用户 B 连接到 Edge-2
      // 预期：用户 B 能看到用户 A

      // 步骤 2: 用户 A 连接到 Edge-1
      const clientA = new MumbleClient();
      
      let clientAAuthenticated = false;
      clientA.on('authenticated', () => {
        clientAAuthenticated = true;
      });

      console.log(`[TEST] Step 2: Connecting User A to Edge-1 (port ${testEnv.edgePort})`);
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      expect(clientA.isConnected()).toBe(true);
      expect(clientAAuthenticated).toBe(true);
      
      const sessionA = clientA.getStateManager().getSession();
      expect(sessionA).toBeDefined();
      console.log(`[TEST] User A connected with session ${sessionA?.session}`);

      // 等待用户 A 被报告到 Hub
      await sleep(500);

      // 步骤 3: 启动 Edge-2 (在独立测试中，我们需要验证 Edge-2 连接后会收到现有用户)
      // 注意：在当前测试环境中，Edge-2 已经在 setup 中启动了
      // 我们需要验证即使 Edge-2 在用户 A 登录后才连接，用户 B 也能看到用户 A
      
      // 等待 Edge-2 同步
      await sleep(500);
      
      // 步骤 4: 用户 B 连接到 Edge-2
      const clientB = new MumbleClient();
      
      let clientBAuthenticated = false;
      clientB.on('authenticated', () => {
        clientBAuthenticated = true;
      });
      
      console.log(`[TEST] Step 4: Connecting User B to Edge-2 (port ${testEnv.edgePort2})`);
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      expect(clientB.isConnected()).toBe(true);
      expect(clientBAuthenticated).toBe(true);
      
      const sessionB = clientB.getStateManager().getSession();
      expect(sessionB).toBeDefined();
      console.log(`[TEST] User B connected with session ${sessionB?.session}`);

      // 等待用户状态同步
      await sleep(500);

      // 验证：用户 B 应该能看到用户 A
      const usersSeenByB = clientB.getUsers();
      console.log(`[TEST] Users seen by B: ${usersSeenByB.map(u => `${u.name}(${u.session})`).join(', ')}`);
      
      const userAVisibleToB = usersSeenByB.some(u => u.name === 'user1' && u.session === sessionA?.session);
      expect(userAVisibleToB).toBe(true);

      // 验证：用户 A 应该能看到用户 B
      const usersSeenByA = clientA.getUsers();
      console.log(`[TEST] Users seen by A: ${usersSeenByA.map(u => `${u.name}(${u.session})`).join(', ')}`);
      
      const userBVisibleToA = usersSeenByA.some(u => u.name === 'user2' && u.session === sessionB?.session);
      expect(userBVisibleToA).toBe(true);

      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
    });
  });

  describe('Issue 2: User State Synchronization', () => {
    it('User B should see correct self_mute and self_deaf state of User A', async () => {
      // 时序：
      // 1. 用户 A 连接到 Edge-1
      // 2. 用户 A 关闭自己的麦克风和扬声器 (self_mute=true, self_deaf=true)
      // 3. 用户 B 连接到 Edge-2
      // 预期：用户 B 看到用户 A 的状态是 self_mute=true, self_deaf=true

      // 步骤 1: 用户 A 连接到 Edge-1
      const clientA = new MumbleClient();
      
      console.log(`[TEST] Step 1: Connecting User A to Edge-1`);
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

      // 等待认证完成
      await sleep(300);

      // 步骤 2: 用户 A 设置自己为静音和耳聋
      console.log(`[TEST] Step 2: User A setting self_mute=true and self_deaf=true`);
      await clientA.setSelfMute(true);
      await sleep(100);
      await clientA.setSelfDeaf(true);
      
      // 等待状态更新被报告到 Hub
      await sleep(500);
      
      // 验证本地状态
      const stateA = clientA.getStateManager().getSession();
      console.log(`[TEST] User A local state: self_mute=${stateA?.self_mute}, self_deaf=${stateA?.self_deaf}`);
      expect(stateA?.self_mute).toBe(true);
      expect(stateA?.self_deaf).toBe(true);

      // 步骤 3: 用户 B 连接到 Edge-2
      const clientB = new MumbleClient();
      
      console.log(`[TEST] Step 3: Connecting User B to Edge-2`);
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

      // 等待用户列表同步
      await sleep(500);

      // 验证：用户 B 应该看到用户 A 的正确状态
      const usersSeenByB = clientB.getUsers();
      console.log(`[TEST] Users seen by B: ${JSON.stringify(usersSeenByB.map(u => ({ name: u.name, session: u.session, self_mute: u.self_mute, self_deaf: u.self_deaf })))}`);
      
      const userASeenByB = usersSeenByB.find(u => u.name === 'admin' && u.session === sessionA?.session);
      expect(userASeenByB).toBeDefined();
      
      console.log(`[TEST] User A as seen by B: self_mute=${userASeenByB?.self_mute}, self_deaf=${userASeenByB?.self_deaf}`);
      
      // 这是主要的测试断言
      expect(userASeenByB?.self_mute).toBe(true);
      expect(userASeenByB?.self_deaf).toBe(true);

      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
    });
  });
});
