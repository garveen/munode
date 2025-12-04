/**
 * Edge Join Timing Integration Tests
 * 
 * 测试 Edge 在不同时机加入 Hub 时的用户可见性问题
 * 
 * 问题场景：
 * 1. Edge 1 加入 Hub
 * 2. 用户 A 连接到 Edge 1
 * 3. Edge 2 加入 Hub （此时 Edge 2 不知道用户 A 的存在）
 * 4. 用户 B 连接到 Edge 2
 * 5. A 和 B 之间应该能互相看到
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

describe('Edge Join Timing Integration Tests', () => {
  let testEnv: TestEnvironment;
  let lateEdgeProcess: ChildProcess | undefined;

  beforeAll(async () => {
    // 只启动 Hub 和 Edge 1，不启动 Edge 2
    testEnv = await setupTestEnvironment(8200, {
      startHub: true,
      startEdge: true,
      startEdge2: false, // 关键：不在初始化时启动 Edge 2
      startAuth: true,
      reuse: false, // 不重用，确保独立环境
      silent: false, // 输出日志以便调试
    });
  }, 60000);

  afterAll(async () => {
    // 清理晚启动的 Edge 2
    if (lateEdgeProcess) {
      lateEdgeProcess.kill('SIGTERM');
      await sleep(1000);
    }
    await testEnv?.cleanup();
  });

  describe('Edge joins after users are connected', () => {
    it('should see users when edge joins after users are already connected', async () => {
      console.log('\n=== Test Start: Edge joins after users are connected ===\n');
      
      // Step 1: Edge 1 已经在 beforeAll 中加入 Hub
      console.log('Step 1: Edge 1 is already connected to Hub');
      await sleep(500);
      
      // Step 2: 用户 A 连接到 Edge 1
      console.log('Step 2: User A connects to Edge 1');
      const clientA = new MumbleClient();
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'edge_timing_userA',
        password: 'password1',
        rejectUnauthorized: false,
      });
      
      expect(clientA.isConnected()).toBe(true);
      console.log('User A connected successfully');
      
      // 等待用户 A 的会话被 Hub 记录
      await sleep(1000);
      
      // Step 3: Edge 2 现在才加入 Hub
      console.log('Step 3: Edge 2 joins Hub NOW (after User A is already connected)');
      
      // 创建 Edge 2 配置
      const edgeConfigPath = join(PROJECT_ROOT, 'tests/config/edge-test.js');
      const edgeConfigModule = await import(`file://${edgeConfigPath}?v=${Date.now()}`);
      const edgeConfig2 = { ...(edgeConfigModule.default || edgeConfigModule) };
      
      // 配置 Edge 2
      edgeConfig2.server_id = 2;
      edgeConfig2.network = edgeConfig2.network || {};
      edgeConfig2.network.port = testEnv.edgePort2;
      edgeConfig2.server = edgeConfig2.server || {};
      edgeConfig2.server.name = 'MuNode Edge Server 2 (Late Join Test)';
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
      edgeConfig2.hubServer.controlPort = testEnv.controlPort; // 使用正确的控制端口
      
      edgeConfig2.auth = edgeConfig2.auth || {};
      delete edgeConfig2.auth.apiUrl;
      
      const tempEdgeConfigPath2 = join(PROJECT_ROOT, `tests/config/edge-test-late-join.js`);
      fs.writeFileSync(tempEdgeConfigPath2, `export default ${JSON.stringify(edgeConfig2, null, 2)};`);
      console.log(`Created temp edge config 2 at ${tempEdgeConfigPath2} with port ${testEnv.edgePort2}`);
      
      // 启动 Edge 2
      lateEdgeProcess = await startEdgeServer(tempEdgeConfigPath2, testEnv.edgePort2, 3, false);
      console.log('Edge 2 started and connected to Hub');
      
      // 等待 Edge 2 完全连接到 Hub 并同步状态
      await sleep(2000);
      
      // Step 4: 用户 B 连接到 Edge 2
      console.log('Step 4: User B connects to Edge 2');
      const clientB = new MumbleClient();
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'edge_timing_userB',
        password: 'password2',
        rejectUnauthorized: false,
      });
      
      expect(clientB.isConnected()).toBe(true);
      console.log('User B connected successfully');
      
      // 等待状态同步
      await sleep(1000);
      
      // Step 5: 验证相互可见性
      console.log('\nStep 5: Verifying mutual visibility...');
      
      // 用户 B 应该能看到用户 A
      const usersSeenByB = clientB.getUsers();
      console.log('Users seen by B:', usersSeenByB.map(u => ({ name: u.name, session: u.session })));
      const userAVisibleToB = usersSeenByB.some(u => u.name === 'edge_timing_userA');
      
      // 用户 A 应该能看到用户 B
      const usersSeenByA = clientA.getUsers();
      console.log('Users seen by A:', usersSeenByA.map(u => ({ name: u.name, session: u.session })));
      const userBVisibleToA = usersSeenByA.some(u => u.name === 'edge_timing_userB');
      
      console.log(`User A visible to User B: ${userAVisibleToB}`);
      console.log(`User B visible to User A: ${userBVisibleToA}`);
      
      // 断言：两个用户应该能互相看到
      expect(userAVisibleToB).toBe(true);
      expect(userBVisibleToA).toBe(true);
      
      console.log('\n=== Test End: Success ===\n');
      
      // 清理
      await clientA.disconnect();
      await clientB.disconnect();
      
      // 清理临时配置文件
      setTimeout(() => {
        try {
          fs.unlinkSync(tempEdgeConfigPath2);
        } catch (error) {
          // 忽略清理错误
        }
      }, 1000);
    }, 90000); // 增加超时时间以允许足够的启动和同步时间
  });
});
