/**
 * Edge Join Race Condition Tests
 * 
 * 测试 Edge 加入时的各种竞态条件
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, startEdgeServer, TestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { join } from 'path';
import * as fs from 'fs';
import { ChildProcess } from 'child_process';

// Helper function for async delays
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Get project root
const PROJECT_ROOT = join(__dirname, '../../../');

describe('Edge Join Race Condition Tests', () => {
  let testEnv: TestEnvironment;
  let lateEdgeProcess: ChildProcess | undefined;

  beforeAll(async () => {
    // 只启动 Hub 和 Edge 1
    testEnv = await setupTestEnvironment(8300, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      reuse: false,
      silent: false,
    });
  }, 60000);

  afterAll(async () => {
    if (lateEdgeProcess) {
      lateEdgeProcess.kill('SIGTERM');
      await sleep(1000);
    }
    await testEnv?.cleanup();
  });

  describe('Rapid user connections during edge join', () => {
    it('should handle user connecting while edge is joining', async () => {
      console.log('\n=== Test Start: User connecting during edge join ===\n');
      
      // Step 1: 用户 A 连接到 Edge 1
      console.log('Step 1: User A connects to Edge 1');
      const clientA = new MumbleClient();
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'edge_timing_userA',
        password: 'password1',
        rejectUnauthorized: false,
      });
      
      expect(clientA.isConnected()).toBe(true);
      console.log('User A connected');
      
      // Step 2: 开始启动 Edge 2（但不等待完成）
      console.log('Step 2: Starting Edge 2...');
      const edgeConfigPath = join(PROJECT_ROOT, 'tests/config/edge-test.js');
      const edgeConfigModule = await import(`file://${edgeConfigPath}?v=${Date.now()}`);
      const edgeConfig2 = { ...(edgeConfigModule.default || edgeConfigModule) };
      
      edgeConfig2.server_id = 2;
      edgeConfig2.network = edgeConfig2.network || {};
      edgeConfig2.network.port = testEnv.edgePort2;
      edgeConfig2.server = edgeConfig2.server || {};
      edgeConfig2.server.name = 'MuNode Edge Server 2 (Race Test)';
      edgeConfig2.server.serverId = 2;
      
      const certsDir = join(__dirname, '../certs');
      edgeConfig2.tls = {
        cert: join(certsDir, 'server.pem'),
        key: join(certsDir, 'server.key'),
        ca: join(certsDir, 'ca.pem'),
        requireClientCert: false,
        rejectUnauthorized: false
      };
      
      edgeConfig2.hubServer = edgeConfig2.hubServer || {};
      edgeConfig2.hubServer.host = '127.0.0.1';
      edgeConfig2.hubServer.port = testEnv.hubPort;
      edgeConfig2.hubServer.controlPort = testEnv.controlPort;
      
      edgeConfig2.auth = edgeConfig2.auth || {};
      delete edgeConfig2.auth.apiUrl;
      
      const tempEdgeConfigPath2 = join(PROJECT_ROOT, `tests/config/edge-test-race.js`);
      fs.writeFileSync(tempEdgeConfigPath2, `export default ${JSON.stringify(edgeConfig2, null, 2)};`);
      
      // 启动 Edge 2 但不等待
      const edge2Promise = startEdgeServer(tempEdgeConfigPath2, testEnv.edgePort2, 3, false);
      
      // Step 3: 在 Edge 2 启动过程中，立即尝试连接用户 B
      console.log('Step 3: User B tries to connect to Edge 2 while it is still starting...');
      await sleep(1000); // 给 Edge 2 一点启动时间，但不等它完全ready
      
      const clientB = new MumbleClient();
      let clientBConnected = false;
      
      // 尝试连接（可能会失败或需要重试）
      try {
        await clientB.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: 'edge_timing_userB',
          password: 'password2',
          rejectUnauthorized: false,
        });
        clientBConnected = true;
      } catch (error: any) {
        console.log('Initial connection failed (expected), will retry...', error.message);
      }
      
      // 等待 Edge 2 完全启动
      lateEdgeProcess = await edge2Promise;
      console.log('Edge 2 fully started');
      
      // 如果第一次连接失败，重试
      if (!clientBConnected) {
        await sleep(1000);
        await clientB.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: 'edge_timing_userB',
          password: 'password2',
          rejectUnauthorized: false,
        });
        clientBConnected = true;
      }
      
      expect(clientB.isConnected()).toBe(true);
      console.log('User B connected');
      
      // 等待状态同步
      await sleep(2000);
      
      // Step 4: 验证相互可见性
      console.log('\nStep 4: Verifying mutual visibility...');
      
      const usersSeenByB = clientB.getUsers();
      console.log('Users seen by B:', usersSeenByB.map(u => ({ name: u.name, session: u.session })));
      const userAVisibleToB = usersSeenByB.some(u => u.name === 'edge_timing_userA');
      
      const usersSeenByA = clientA.getUsers();
      console.log('Users seen by A:', usersSeenByA.map(u => ({ name: u.name, session: u.session })));
      const userBVisibleToA = usersSeenByA.some(u => u.name === 'edge_timing_userB');
      
      console.log(`User A visible to User B: ${userAVisibleToB}`);
      console.log(`User B visible to User A: ${userBVisibleToA}`);
      
      expect(userAVisibleToB).toBe(true);
      expect(userBVisibleToA).toBe(true);
      
      console.log('\n=== Test End ===\n');
      
      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
      
      setTimeout(() => {
        try {
          fs.unlinkSync(tempEdgeConfigPath2);
        } catch (error) {
          // ignore
        }
      }, 1000);
    }, 120000);
    
    it('should handle multiple users connecting simultaneously across edges', async () => {
      console.log('\n=== Test Start: Multiple simultaneous connections ===\n');
      
      const clients: MumbleClient[] = [];
      
      // 连接3个用户到 Edge 1
      for (let i = 1; i <= 3; i++) {
        const client = new MumbleClient();
        await client.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: `multi_user_e1_${i}`,
          password: `password${i}`,
          rejectUnauthorized: false,
        });
        clients.push(client);
        console.log(`User multi_user_e1_${i} connected to Edge 1`);
        await sleep(100); // 很短的间隔
      }
      
      // 等待一下确保都已报告
      await sleep(500);
      
      // 连接3个用户到 Edge 2 (Edge 2 should be running from previous test)
      for (let i = 1; i <= 3; i++) {
        const client = new MumbleClient();
        await client.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: `multi_user_e2_${i}`,
          password: `password${i}`,
          rejectUnauthorized: false,
        });
        clients.push(client);
        console.log(`User multi_user_e2_${i} connected to Edge 2`);
        await sleep(100); // 很短的间隔
      }
      
      // 等待状态同步
      await sleep(2000);
      
      // 验证每个用户都能看到所有其他用户
      console.log('\nVerifying all users can see each other...');
      for (let i = 0; i < clients.length; i++) {
        const users = clients[i].getUsers();
        console.log(`Client ${i+1} sees ${users.length} users:`, users.map(u => u.name));
        
        // 应该能看到所有7个用户（6个其他用户 + 自己）
        expect(users.length).toBeGreaterThanOrEqual(6);
      }
      
      console.log('\n=== Test End ===\n');
      
      // 清理
      for (const client of clients) {
        await client.disconnect();
      }
    }, 120000);
  });
});
