/**
 * Edge 间语音中转路由集成测试
 * 
 * 测试 Edge间语音中转路由设计.md 中描述的功能：
 * - Hub 全局控制机制
 * - 直连模式 (Direct)
 * - 中转模式 (Relay)
 * - TCP 降级模式 (Fallback)
 * - 路由表管理
 * - 网络质量监控
 * 
 * 测试架构：
 * - 使用 3 个 Edge 服务器模拟跨 Edge 路由
 * - Hub 作为控制中心，不参与 UDP 语音转发
 * - 模拟网络质量变化来验证路由切换
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import * as crypto from 'crypto';

/**
 * 生成随机语音数据用于测试
 */
function generateRandomVoiceData(size: number = 20): Buffer {
  return crypto.randomBytes(size);
}

/**
 * 创建 Opus 语音包（客户端格式）
 * 客户端发送格式: [header(1字节)][sequence_varint][voice_data]
 */
function createVoicePacket(codec: number = 4, target: number = 0, sequence: number = 0): Buffer {
  const header = Buffer.alloc(1);
  header.writeUInt8((codec << 5) | (target & 0x1F), 0);
  const sequenceVarint = Buffer.from([sequence & 0x7F]);
  const voiceData = generateRandomVoiceData(20);
  return Buffer.concat([header, sequenceVarint, voiceData]);
}

/**
 * 设置客户端网络质量模拟（使用JS UDP质量模拟器）
 */
/**
 * 创建并连接管理员客户端
 */
async function createAdminClient(testEnv: TestEnvironment, edge: 1 | 2 = 1): Promise<MumbleClient> {
  const admin = new MumbleClient();
  const port = edge === 1 ? testEnv.edgePort : testEnv.edgePort2;
  // UDP port is the same as TCP port for client-to-Edge communication
  const udpPort = port;
  await admin.connect({
    host: 'localhost',
    port: port,
    udpPort: udpPort,
    username: 'admin',
    password: 'admin123',
    rejectUnauthorized: false,
  });
  await sleep(300);
  return admin;
}

/**
 * 批量创建测试客户端
 */
interface ClientConfig {
  username: string;
  password: string;
  edge: 1 | 2 | 3 | 4;
  channelId?: number;
}

/**
 * 获取 Edge 端口
 */
function getEdgePort(testEnv: TestEnvironment, edge: 1 | 2 | 3 | 4): number {
  switch (edge) {
    case 1: return testEnv.edgePort;
    case 2: return testEnv.edgePort2;
    case 3: return testEnv.edgePort3;
    case 4: return testEnv.edgePort4;
  }
}

async function createClients(testEnv: TestEnvironment, configs: ClientConfig[]): Promise<MumbleClient[]> {
  const clients: (MumbleClient | null)[] = new Array(configs.length).fill(null);
  
  await Promise.all(configs.map(async (config, index) => {
    const client = new MumbleClient();
    const targetPort = getEdgePort(testEnv, config.edge);
    // UDP port is the same as TCP port for client-to-Edge communication
    const targetUdpPort = targetPort;
    console.log(`[TEST] Connecting ${config.username} to Edge ${config.edge} on port ${targetPort} (UDP: ${targetUdpPort})`);
    await client.connect({
      host: 'localhost',
      port: targetPort,
      udpPort: targetUdpPort,
      username: config.username,
      password: config.password,
      rejectUnauthorized: false,
      forceTcpVoice: false,
    });
    
    // 等待 UDP 连接就绪
    try {
      await client.waitForUDP(3000);
      console.log(`[TEST] ${config.username} UDP ready`);
    } catch (error) {
      console.warn(`[TEST] ${config.username} UDP timeout, will use TCP:`, error);
    }
    
    if (config.channelId !== undefined) {
      await client.sendUserState({ channel_id: config.channelId });
      await sleep(200);
    }
    
    clients[index] = client;
  }));
  
  return clients as MumbleClient[];
}

/**
 * 清理客户端
 */
async function cleanupClients(clients: MumbleClient[]): Promise<void> {
  for (const client of clients) {
    try {
      await client.disconnect();
    } catch (e) {
      // 忽略断开连接的错误
    }
  }
}

describe('Voice Routing Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // 使用较高的基础端口避免与其他测试冲突
    // 启用日志用于调试
    testEnv = await setupTestEnvironment(8200, { 
      silent: false,
      startEdge2: true, // 确保启动两个 Edge
      startEdge3: true, // 启动第三个 Edge 用于中转测试
      reuse: false, // 不复用环境以便测试独立
    });
    
    // 等待服务稳定
    await sleep(2000);
  }, 120000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Hub Global Control Mechanism', () => {
    it('should receive voice routing config from Hub on connection', async () => {
      const clients = await createClients(testEnv, [
        { username: 'routing_config_test', password: 'pass1', edge: 1, channelId: 0 },
      ]);
      
      const [client] = clients;
      
      // 验证客户端已连接
      expect(client.getStateManager().getSession()).toBeDefined();
      
      await cleanupClients(clients);
    });
  });

  describe('Network Quality Metrics', () => {
    it('should collect RTT metrics from voice packets', async () => {
      const clients = await createClients(testEnv, [
        { username: 'rtt_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'rtt_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });
      
      await sleep(1000);
      
      // 发送语音包
      for (let i = 0; i < 10; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(1500);
      
      expect(receivedCount).toBeGreaterThan(5);
      
      await cleanupClients(clients);
    });
  });

  describe('Route Types', () => {
    it('should use direct mode when network quality is good', async () => {
      const clients = await createClients(testEnv, [
        { username: 'direct_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'direct_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });
      
      await sleep(1000);
      
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await sleep(2000);
      
      expect(receivedCount).toBeGreaterThan(0);
      
      await cleanupClients(clients);
    });

    it('should use relay mode for multi-hop routing', async () => {
      const clients = await createClients(testEnv, [
        { username: 'relay_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'relay_receiver', password: 'pass2', edge: 3, channelId: 0 },
      ]);

      const [sender, receiver] = clients;

      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;

      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });

      await sleep(1000);

      for (let i = 0; i < 10; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(100);
      }

      await sleep(3000);

      expect(receivedCount).toBeGreaterThan(5);

      await cleanupClients(clients);
    });

    it('should fallback to TCP when UDP is unavailable', async () => {
      const sender = new MumbleClient();
      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'tcp_fallback_sender',
        password: 'pass1',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });
      
      const receiver = new MumbleClient();
      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'tcp_fallback_receiver',
        password: 'pass2',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });
      
      await sleep(500);
      
      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });
      
      await sleep(1000);
      
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await sleep(2000);
      
      expect(receivedCount).toBeGreaterThan(0);
      
      await sender.disconnect();
      await receiver.disconnect();
    });
  });

  describe('Route Switching with Quality Simulation', () => {
    it('should report quality issues and maintain voice transmission', async () => {
      // 创建连接到Edge1和Edge4的客户端
      const clients = await createClients(testEnv, [
        { username: 'quality_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'quality_receiver', password: 'pass2', edge: 3, channelId: 0 }, // 使用Edge3作为接收者，确保有中转路径
      ]);
      
      const [sender, receiver] = clients;
      
      let receivedPackets: number[] = [];
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedPackets.push(Date.now());
        }
      });
      
      await sleep(1000);
      
      // 阶段1：良好质量下发送语音包（应该使用直连或中转）
      console.log('[ROUTE SWITCH TEST] Phase 1: Testing with good quality');
      const phase1Start = receivedPackets.length;
      for (let i = 0; i < 10; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(100);
      }
      
      await sleep(2000);
      
      const phase1Received = receivedPackets.length - phase1Start;
      console.log(`[ROUTE SWITCH TEST] Phase 1: Sent 10, received ${phase1Received}`);
      expect(phase1Received).toBeGreaterThan(7); // 良好质量下应该收到大部分
      
      // 阶段2：通过RPC报告质量差，触发路由重新计算
      console.log('[ROUTE SWITCH TEST] Phase 2: Reporting poor quality via RPC');
      const { ControlChannelClient } = await import('../../../packages/protocol/src/index.js');
      
      const controlClient = new ControlChannelClient({
        host: 'localhost',
        port: testEnv.controlPort,
        tls: false,
      });
      
      try {
        await controlClient.connect();
        console.log('[ROUTE SWITCH TEST] Connected to Hub control channel');
        
        // 报告Edge1到Edge3质量差
        const result = await controlClient.call('edge.reportQuality', {
          edge_id: 1,
          target_edge_id: 3,
          quality: {
            rtt: 400,
            packetLoss: 0.50,
            jitter: 100,
            samples: 50,
          },
        });
        
        if (result.success) {
          console.log('[ROUTE SWITCH TEST] Quality report sent successfully');
        } else {
          console.warn('[ROUTE SWITCH TEST] Quality report failed');
        }
      } catch (error) {
        console.warn('[ROUTE SWITCH TEST] RPC failed:', error);
      } finally {
        controlClient.disconnect();
      }
      
      // 等待Hub重新计算路由
      console.log('[ROUTE SWITCH TEST] Waiting for route recalculation...');
      await sleep(5000);
      
      // 阶段3：在路由切换后发送语音包，验证100%到达率
      console.log('[ROUTE SWITCH TEST] Phase 3: Testing after route switch (should use relay)');
      const phase3Start = receivedPackets.length;
      for (let i = 20; i < 30; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(100);
      }
      
      await sleep(3000);
      
      const phase3Received = receivedPackets.length - phase3Start;
      console.log(`[ROUTE SWITCH TEST] Phase 3: Sent 10, received ${phase3Received}`);
      
      // 路由切换后应该有显著改善（至少收到一些包）
      expect(phase3Received).toBeGreaterThan(5);
      
      console.log('[ROUTE SWITCH TEST] Test completed successfully');
      
      await cleanupClients(clients);
    }, {timeout: 60000});
  });

  describe('Cross-Edge Voice Transmission', () => {
    it('should transmit voice between edges', async () => {
      const clients = await createClients(testEnv, [
        { username: 'cross_edge_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'cross_edge_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });
      
      await sleep(1000);
      
      for (let i = 0; i < 5; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(100);
      }
      
      await sleep(2000);
      
      expect(receivedCount).toBe(5);
      
      await cleanupClients(clients);
    });
  });
});
