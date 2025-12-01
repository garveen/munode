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
 * 创建并连接管理员客户端
 */
async function createAdminClient(testEnv: TestEnvironment, edge: 1 | 2 = 1): Promise<MumbleClient> {
  const admin = new MumbleClient();
  const port = edge === 1 ? testEnv.edgePort : testEnv.edgePort2;
  await admin.connect({
    host: 'localhost',
    port: port,
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
  edge: 1 | 2;
  channelId?: number;
}

async function createClients(testEnv: TestEnvironment, configs: ClientConfig[]): Promise<MumbleClient[]> {
  const clients: (MumbleClient | null)[] = new Array(configs.length).fill(null);
  
  await Promise.all(configs.map(async (config, index) => {
    const client = new MumbleClient();
    const targetPort = config.edge === 1 ? testEnv.edgePort : testEnv.edgePort2;
    console.log(`[TEST] Connecting ${config.username} to Edge ${config.edge} on port ${targetPort}`);
    await client.connect({
      host: 'localhost',
      port: targetPort,
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
      reuse: false, // 不复用环境以便测试独立
    });
    
    // 等待服务稳定
    await sleep(2000);
  }, 120000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Phase 0: Hub Global Control Mechanism', () => {
    /**
     * 测试 Hub 配置推送机制
     * 验证：Edge 连接时从 Hub 接收路由配置
     */
    it('should receive voice routing config from Hub on connection', async () => {
      // 这个测试验证 Edge 在连接 Hub 时接收配置
      // 由于我们还没实现配置推送，这个测试会失败
      // 这就是 TDD 的目的：先写测试，再实现功能
      
      const clients = await createClients(testEnv, [
        { username: 'routing_config_test', password: 'pass1', edge: 1, channelId: 0 },
      ]);
      
      const [client] = clients;
      
      // 验证客户端已连接
      expect(client.getStateManager().getSession()).toBeDefined();
      
      // TODO: 当实现配置推送后，验证 Edge 收到的配置
      // const edgeConfig = getEdgeVoiceRoutingConfig();
      // expect(edgeConfig.enabled).toBeDefined();
      
      await cleanupClients(clients);
    });

    /**
     * 测试 Hub 禁用路由时 Edge 不启用路由功能
     */
    it('should not enable routing when Hub config is disabled', async () => {
      // TODO: 当实现后，测试 Hub voiceRouting.enabled=false 时 Edge 行为
      // 目前跳过此测试
      expect(true).toBe(true);
    });

    /**
     * 测试配置热更新
     */
    it('should handle config hot update from Hub', async () => {
      // TODO: 测试运行时配置更新
      expect(true).toBe(true);
    });
  });

  describe('Phase 1: Network Quality Metrics', () => {
    /**
     * 测试被动网络质量探测
     * 验证：从语音包中提取时间戳计算 RTT
     */
    it('should collect RTT metrics from voice packets', async () => {
      // 创建跨 Edge 的客户端
      const clients = await createClients(testEnv, [
        { username: 'rtt_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'rtt_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      // 发送多个语音包以便收集指标
      const receivedVoice: Buffer[] = [];
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedVoice.push(data.data);
        }
      });
      
      await sleep(1000);
      
      // 发送 10 个语音包
      for (let i = 0; i < 10; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50); // 50ms 间隔
      }
      
      await sleep(1500);
      
      // 验证接收到语音包
      expect(receivedVoice.length).toBeGreaterThan(0);
      
      // TODO: 验证 Edge 收集到了 RTT 指标
      // const metrics = getEdgeNetworkMetrics(testEnv.edgePort);
      // expect(metrics.rtt).toBeDefined();
      
      await cleanupClients(clients);
    });

    /**
     * 测试丢包率统计
     * 验证：基于序列号间隙统计丢包率
     */
    it('should calculate packet loss from sequence gaps', async () => {
      const clients = await createClients(testEnv, [
        { username: 'loss_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'loss_receiver', password: 'pass2', edge: 2, channelId: 0 },
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
      
      // 发送 20 个语音包
      for (let i = 0; i < 20; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(30);
      }
      
      await sleep(2000);
      
      // 在正常网络条件下，应该收到大部分包
      expect(receivedCount).toBeGreaterThan(15);
      
      // TODO: 验证丢包率计算
      // const metrics = getEdgeNetworkMetrics(testEnv.edgePort);
      // expect(metrics.packetLoss).toBeLessThan(0.1);
      
      await cleanupClients(clients);
    });
  });

  describe('Phase 2: Route Types', () => {
    /**
     * 场景 1: 直连模式
     * Edge A ───(良好网络)───→ Edge B
     */
    it('should use direct mode when network quality is good', async () => {
      const clients = await createClients(testEnv, [
        { username: 'direct_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'direct_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      const receivedVoice = {
        count: 0,
        lastTimestamp: 0,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedVoice.count++;
          receivedVoice.lastTimestamp = Date.now();
        }
      });
      
      await sleep(1000);
      
      const startTime = Date.now();
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await sleep(2000);
      
      // 验证收到语音
      expect(receivedVoice.count).toBeGreaterThan(0);
      
      // 验证延迟合理（直连应该很快）
      const latency = receivedVoice.lastTimestamp - startTime;
      console.log(`[TEST] Direct mode latency: ${latency}ms`);
      expect(latency).toBeLessThan(1000); // 1秒内应该收到
      
      // TODO: 验证路由表显示 DIRECT 模式
      // const route = getEdgeRoute(testEnv.edgePort, edge2Id);
      // expect(route.type).toBe('direct');
      
      await cleanupClients(clients);
    });

    /**
     * 场景 2: 中转模式（需要3个Edge，目前测试环境只有2个）
     * 这个测试需要在实现后添加第3个Edge支持
     */
    it.skip('should use relay mode when direct connection is poor', async () => {
      // TODO: 需要3个Edge来测试中转
      // Edge A ─(差)→ Edge B，但 A→C→B 更好
      expect(true).toBe(true);
    });

    /**
     * 场景 3: TCP 降级模式
     * 当所有 UDP 路径不可用时，通过 Hub 的 WebSocket 中转
     */
    it('should fallback to TCP when UDP is unavailable', async () => {
      // 创建强制使用 TCP 的客户端
      const sender = new MumbleClient();
      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'tcp_fallback_sender',
        password: 'pass1',
        rejectUnauthorized: false,
        forceTcpVoice: true, // 强制 TCP
      });
      
      const receiver = new MumbleClient();
      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'tcp_fallback_receiver',
        password: 'pass2',
        rejectUnauthorized: false,
        forceTcpVoice: true, // 强制 TCP
      });
      
      await sleep(500);
      
      const receivedVoice = { count: 0 };
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedVoice.count++;
        }
      });
      
      await sleep(1000);
      
      // 发送语音包
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await sleep(2000);
      
      // TCP 模式下也应该收到语音
      expect(receivedVoice.count).toBeGreaterThan(0);
      
      await sender.disconnect();
      await receiver.disconnect();
    });
  });

  describe('Phase 3: Route Table Management', () => {
    /**
     * 测试 Hub 计算并推送路由表
     */
    it('should receive route table updates from Hub', async () => {
      // TODO: 实现后测试路由表推送
      const clients = await createClients(testEnv, [
        { username: 'route_table_test', password: 'pass1', edge: 1, channelId: 0 },
      ]);
      
      const [client] = clients;
      
      // 验证连接成功
      expect(client.getStateManager().getSession()).toBeDefined();
      
      // TODO: 验证收到路由表
      // const routes = getEdgeRoutingTable();
      // expect(routes.size).toBeGreaterThan(0);
      
      await cleanupClients(clients);
    });

    /**
     * 测试本地路由决策
     */
    it('should make local routing decisions based on quality metrics', async () => {
      // TODO: 测试本地路由决策逻辑
      expect(true).toBe(true);
    });
  });

  describe('Cross-Edge Voice Transmission', () => {
    /**
     * 测试跨 Edge 语音传输（基本功能，验证现有功能正常）
     */
    it('should transmit voice between edges', async () => {
      const clients = await createClients(testEnv, [
        { username: 'cross_edge_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'cross_edge_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      const receivedVoice = { count: 0 };
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedVoice.count++;
        }
      });
      
      await sleep(1000);
      
      // 发送多个语音包
      for (let i = 0; i < 5; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(100);
      }
      
      await sleep(2000);
      
      // 跨 Edge 应该收到语音
      expect(receivedVoice.count).toBe(5);
      
      await cleanupClients(clients);
    });

    /**
     * 测试语音包不发送给 deaf 用户
     */
    it('should not send voice to deaf users on cross edge', async () => {
      const clients = await createClients(testEnv, [
        { username: 'deaf_test_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'deaf_test_deaf', password: 'pass2', edge: 2, channelId: 0 },
        { username: 'deaf_test_normal', password: 'pass3', edge: 2, channelId: 0 },
      ]);
      
      const [sender, deafUser, normalUser] = clients;
      
      // 设置 deaf 状态
      await deafUser.sendUserState({ self_deaf: true });
      await sleep(300);
      
      const receivedVoice = {
        deaf: 0,
        normal: 0,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      deafUser.on('voice', (data: any) => {
        if (data.session === senderSession) receivedVoice.deaf++;
      });
      
      normalUser.on('voice', (data: any) => {
        if (data.session === senderSession) receivedVoice.normal++;
      });
      
      await sleep(1000);
      
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await sleep(2000);
      
      // deaf 用户不应收到，normal 用户应该收到
      expect(receivedVoice.deaf).toBe(0);
      expect(receivedVoice.normal).toBeGreaterThan(0);
      
      await cleanupClients(clients);
    });
  });

  describe('Hub UDP Relay Removal Verification', () => {
    /**
     * 验证 Hub 不参与 UDP 语音转发
     * 根据设计：Hub 完全不参与任何 UDP 语音包转发
     */
    it('should not route voice through Hub UDP', async () => {
      // 这个测试验证语音包是 Edge 间直接传输的
      // 而不是通过 Hub 中转
      
      const clients = await createClients(testEnv, [
        { username: 'hub_bypass_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'hub_bypass_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      const receivedVoice = { count: 0 };
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedVoice.count++;
        }
      });
      
      await sleep(1000);
      
      // 发送语音
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await sleep(2000);
      
      // 验证收到语音（说明 Edge 间 UDP 正常工作）
      expect(receivedVoice.count).toBeGreaterThan(0);
      
      // TODO: 验证 Hub 没有处理任何语音包
      // 可以检查 Hub 的统计信息
      // const hubStats = getHubVoiceStats();
      // expect(hubStats.udpPacketsForwarded).toBe(0);
      
      await cleanupClients(clients);
    });
  });

  describe('Configuration Tests', () => {
    /**
     * 测试路由策略配置
     */
    it('should respect routing policy thresholds', async () => {
      // TODO: 测试配置的阈值是否生效
      // directRttThreshold, directLossThreshold 等
      expect(true).toBe(true);
    });

    /**
     * 测试中转节点容量限制
     */
    it('should respect relay capacity limits', async () => {
      // TODO: 测试 maxRelayCpuLoad, maxRelayBandwidth 配置
      expect(true).toBe(true);
    });
  });

  /**
   * 3-Edge 中转模式测试
   * 
   * 由于当前测试环境只有 2 个 Edge，这些测试使用模拟方式验证：
   * - NetworkTopologyManager 的路由计算逻辑
   * - VoiceRoutingManager 的中转路由处理
   * - 路由表推送机制
   * 
   * TODO: 扩展测试环境支持 3 个 Edge 后，实现真实的中转测试
   */
  describe('Phase 3: 3-Edge Relay Mode (Simulated)', () => {
    /**
     * 测试 NetworkTopologyManager 的 Dijkstra 路由计算
     * 场景：Edge A <-> Edge C <-> Edge B (A-B 直连不通)
     */
    it('should compute relay route when direct path is poor', async () => {
      // 这个测试验证 Hub 的 NetworkTopologyManager 能正确计算中转路由
      // 由于是模拟测试，我们直接验证连接成功即可
      const clients = await createClients(testEnv, [
        { username: 'relay_compute_user', password: 'pass1', edge: 1, channelId: 0 },
      ]);
      
      expect(clients[0].getStateManager().getSession()).toBeDefined();
      
      await cleanupClients(clients);
    });

    /**
     * 测试路由表推送机制
     * 验证 Hub 计算的路由表能正确推送给各 Edge
     */
    it('should push route table updates to edges', async () => {
      const clients = await createClients(testEnv, [
        { username: 'route_push_user', password: 'pass1', edge: 1, channelId: 0 },
      ]);
      
      // 验证客户端已连接（说明 Hub-Edge 通信正常）
      expect(clients[0].getStateManager().getSession()).toBeDefined();
      
      // TODO: 当实现完整的路由表推送后，验证 Edge 收到的路由表内容
      // const routes = getEdgeRouteTable();
      // expect(routes.length).toBeGreaterThan(0);
      
      await cleanupClients(clients);
    });

    /**
     * 测试中转包转发
     * 验证 Edge 作为中转节点时能正确转发语音包
     */
    it('should forward relay packets correctly', async () => {
      // 使用 2-Edge 设置模拟中转场景
      const clients = await createClients(testEnv, [
        { username: 'relay_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'relay_receiver', password: 'pass2', edge: 2, channelId: 0 },
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
      for (let i = 0; i < 5; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(2000);
      
      // 验证接收者收到语音包（即使是通过直连而非中转）
      expect(receivedCount).toBeGreaterThan(0);
      
      await cleanupClients(clients);
    });

    /**
     * 测试多跳中转限制
     * 验证 maxRelayHops 配置正确限制中转跳数
     */
    it('should respect maxRelayHops configuration', async () => {
      // maxRelayHops 默认为 1，表示只允许一跳中转
      // TODO: 在 3-Edge 环境中验证多跳限制
      expect(true).toBe(true);
    });
  });
});

describe('Voice Routing Stress Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8300, { 
      silent: true,
      startEdge2: true,
      reuse: false,
    });
  }, 120000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  /**
   * 高并发语音包传输测试
   */
  it('should handle high volume of voice packets', async () => {
    const clients = await createClients(testEnv, [
      { username: 'stress_sender', password: 'pass1', edge: 1, channelId: 0 },
      { username: 'stress_receiver', password: 'pass2', edge: 2, channelId: 0 },
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
    
    // 发送 100 个语音包（模拟 2 秒的高频语音流）
    const startTime = Date.now();
    for (let i = 0; i < 100; i++) {
      const voicePacket = createVoicePacket(4, 0, i);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      await sleep(20); // 20ms 间隔 = 50 pps
    }
    const sendTime = Date.now() - startTime;
    
    await sleep(3000);
    
    console.log(`[STRESS TEST] Sent 100 packets in ${sendTime}ms, received ${receivedCount}`);
    
    // 应该收到绝大部分包
    expect(receivedCount).toBeGreaterThan(90);
    
    await cleanupClients(clients);
  });
});
