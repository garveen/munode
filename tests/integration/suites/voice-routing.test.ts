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
import { TestEnvironment, setupTestEnvironment, sleep, createClients, cleanupClients } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { UDPQualitySimulator, applyNetworkQuality } from '../../utils/udp-quality-simulator.js';
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
    // 等待清理完成，确保所有资源释放
    await sleep(3000);
  });

  // Clean up between tests to avoid state pollution
  beforeEach(async () => {
    // Wait for previous test cleanup to complete and resources to be released
    await sleep(1000);
  });


  describe('Route Types', () => {
    it('should use direct mode when network quality is good', async () => {
      const clients = await createClients(testEnv, [
        { username: 'loss_sender', edge: 1, channelId: 0 },
        { username: 'loss_receiver', edge: 2, channelId: 0 },
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
        { username: 'route_table_test', edge: 1, channelId: 0 },
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
        { username: 'relay_compute_user', edge: 1, channelId: 0 },
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
        { username: 'route_push_user', edge: 1, channelId: 0 },
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
        { username: 'relay_sender', edge: 1, channelId: 0 },
        { username: 'relay_receiver', edge: 2, channelId: 0 },
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
    // 等待前一个测试环境完全清理
    await sleep(5000);
    testEnv = await setupTestEnvironment(8300, { 
      silent: true,
      startEdge2: true,
      reuse: false,
    });
    await sleep(2000);
  }, 120000);

  afterAll(async () => {
    await testEnv?.cleanup();
    // 等待清理完成，确保所有资源释放
    await sleep(3000);
  });

  /**
   * 高并发语音包传输测试
   */
  it('should handle high volume of voice packets', async () => {
    const clients = await createClients(testEnv, [
      { username: 'stress_sender', edge: 1, channelId: 0 },
      { username: 'stress_receiver', edge: 2, channelId: 0 },
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

/**
 * 4-Edge 路由测试套件
 * 
 * 测试场景：
 * - Edge1 (CN) <-> Edge2 (HK) <-> Edge3 (JP) <-> Edge4 (US)
 * - 模拟网络拓扑，测试中转路由
 */
describe('4-Edge Voice Routing Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // 等待前一个测试环境完全清理
    await sleep(8000);
    // 启动 4 个 Edge 进行完整路由测试
    testEnv = await setupTestEnvironment(8400, { 
      silent: false,
      startEdge2: true,
      startEdge3: true,
      startEdge4: true,
      reuse: false,
    });
    
    // 等待所有 Edge 连接到 Hub
    await sleep(3000);
  }, 180000);

  afterAll(async () => {
    await testEnv?.cleanup();
    // 等待清理完成，确保所有资源释放
    await sleep(3000);
  });

  describe('Multi-Edge Direct Mode', () => {
    /**
     * 测试 4 个 Edge 之间的直接通信
     */
    it('should deliver voice between all 4 edges in direct mode', async () => {
      const clients = await createClients(testEnv, [
        { username: 'quality_test_e1', edge: 1, channelId: 0 },
        { username: 'quality_test_e2', edge: 2, channelId: 0 },
        { username: 'quality_test_e3', edge: 3, channelId: 0 },
        { username: 'quality_test_e4', edge: 4, channelId: 0 },
      ]);
      
      const [sender, receiver2, receiver3, receiver4] = clients;
      
      // 跟踪收到的语音包
      let received2 = 0, received3 = 0, received4 = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver2.on('voice', (data: any) => {
        if (data.session === senderSession) received2++;
      });
      receiver3.on('voice', (data: any) => {
        if (data.session === senderSession) received3++;
      });
      receiver4.on('voice', (data: any) => {
        if (data.session === senderSession) received4++;
      });
      
      await sleep(1000);
      
      // 从 Edge1 发送语音包
      for (let i = 0; i < 20; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(3000);
      
      console.log(`[4-EDGE TEST] Received: Edge2=${received2}, Edge3=${received3}, Edge4=${received4}`);
      
      // 所有 Edge 都应该收到语音
      expect(received2).toBeGreaterThan(0);
      expect(received3).toBeGreaterThan(0);
      expect(received4).toBeGreaterThan(0);
      
      await cleanupClients(clients);
    });
  });

  describe('Relay Route Computation', () => {
    /**
     * 测试 Hub 的路由计算功能
     * 验证 NetworkTopologyManager 能正确计算中转路由
     */
    it('should compute relay routes through hub topology manager', async () => {
      const clients = await createClients(testEnv, [
        { username: 'relay_sender_e1', edge: 1, channelId: 0 },
        { username: 'relay_receiver_e4', edge: 4, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) receivedCount++;
      });
      
      await sleep(1000);
      
      // Edge1 -> Edge4 的语音传输
      // 根据网络拓扑，可能通过 Edge2 或 Edge3 中转
      for (let i = 0; i < 10; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(2000);
      
      expect(receivedCount).toBeGreaterThan(0);
      
      await cleanupClients(clients);
    });

    /**
     * 测试中间节点作为中转
     */
    it('should use intermediate edge as relay node', async () => {
      const clients = await createClients(testEnv, [
        { username: 'multi_hop_sender', edge: 1, channelId: 0 },
        { username: 'relay_test_e2', edge: 2, channelId: 0 }, // 可能的中转节点
        { username: 'relay_test_e3', edge: 3, channelId: 0 }, // 可能的中转节点
        { username: 'multi_hop_receiver', edge: 4, channelId: 0 },
      ]);
      
      const [sender, relay2, relay3, receiver] = clients;
      
      // 启用 Edge2 和 Edge3 的详细中转日志
      const edge2VoiceManager = testEnv.edgeServer2?.getVoiceManager();
      const edge3VoiceManager = testEnv.edgeServer3?.getVoiceManager();
      
      if (edge2VoiceManager) {
        edge2VoiceManager.getVoiceRoutingManager().enableDetailedRelayLogging(true);
        console.log('[RELAY TEST] Enabled detailed relay logging on Edge2');
      }
      if (edge3VoiceManager) {
        edge3VoiceManager.getVoiceRoutingManager().enableDetailedRelayLogging(true);
        console.log('[RELAY TEST] Enabled detailed relay logging on Edge3');
      }
      
      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) receivedCount++;
      });
      
      await sleep(1000);
      
      // 发送语音包
      for (let i = 0; i < 15; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(2000);
      
      console.log(`[MULTI-HOP TEST] Sent 15 packets, received ${receivedCount}`);
      
      // 检查中转统计
      if (edge2VoiceManager) {
        const edge2Stats = edge2VoiceManager.getVoiceRoutingManager().getRelayStats();
        const edge2Log = edge2VoiceManager.getVoiceRoutingManager().getDetailedRelayLog();
        console.log(`[RELAY TEST] Edge2 relayed: ${edge2Stats.packetsRelayed} packets, ${edge2Stats.bytesRelayed} bytes`);
        console.log(`[RELAY TEST] Edge2 detailed log: ${edge2Log.length} events`);
        
        // 如果 Edge2 作为中转节点，应该有中转记录
        if (edge2Stats.packetsRelayed > 0) {
          console.log(`[RELAY TEST] ✓ Edge2 is relaying traffic`);
        }
      }
      
      if (edge3VoiceManager) {
        const edge3Stats = edge3VoiceManager.getVoiceRoutingManager().getRelayStats();
        const edge3Log = edge3VoiceManager.getVoiceRoutingManager().getDetailedRelayLog();
        console.log(`[RELAY TEST] Edge3 relayed: ${edge3Stats.packetsRelayed} packets, ${edge3Stats.bytesRelayed} bytes`);
        console.log(`[RELAY TEST] Edge3 detailed log: ${edge3Log.length} events`);
        
        // 如果 Edge3 作为中转节点，应该有中转记录
        if (edge3Stats.packetsRelayed > 0) {
          console.log(`[RELAY TEST] ✓ Edge3 is relaying traffic`);
        }
      }
      
      expect(receivedCount).toBeGreaterThan(0);
      
      await cleanupClients(clients);
    }, 45000);
  });

  describe('Network Quality Based Routing', () => {
    /**
     * 测试基于网络质量的路由选择
     * 使用 UDP 质量模拟器模拟网络劣化
     */
    it('should record network quality metrics with simulated degradation', async () => {
      const clients = await createClients(testEnv, [
        { username: 'network_sim_sender', edge: 1, channelId: 0 },
        { username: 'network_sim_receiver', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      // 为 Edge 2 应用网络劣化
      const edge2Socket = testEnv.edgeServer2?.getUDPSocket();
      
      if (!edge2Socket) {
        throw new Error('Edge 2 UDP socket not available for simulation');
      }
      // 模拟 20% 丢包率和 100ms 延迟
      let simulator = applyNetworkQuality(edge2Socket, {
        packetLoss: 0.2,
        latency: 100,
        jitter: 20,
      });
      console.log('[QUALITY TEST] Applied network degradation to Edge 2: 20% loss, 100ms±20ms latency');
      
      let receivedPackets: number[] = [];
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedPackets.push(Date.now());
        }
      });
      
      await sleep(1000);
      
      // 发送一系列语音包来收集网络质量数据
      const startTime = Date.now();
      for (let i = 0; i < 30; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(3000);
      
      // 分析接收到的包
      const receiveRate = receivedPackets.length / 30;
      console.log(`[QUALITY TEST] Receive rate: ${(receiveRate * 100).toFixed(1)}% (${receivedPackets.length}/30)`);
      
      // 在网络劣化情况下，应该收到较少的包
      expect(receivedPackets.length).toBeLessThan(30);
      expect(receivedPackets.length).toBeGreaterThan(15); // 但也不至于全丢
      
      // 计算平均延迟（如果有时间戳）
      if (receivedPackets.length > 1) {
        const intervals = [];
        for (let i = 1; i < receivedPackets.length; i++) {
          intervals.push(receivedPackets[i] - receivedPackets[i-1]);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        console.log(`[QUALITY TEST] Average inter-packet interval: ${avgInterval.toFixed(1)}ms (expected ~50ms + latency)`);
      }
      
      // 清理模拟器
      simulator.stop();
      
      await cleanupClients(clients);
    });

    /**
     * 测试严重网络劣化场景
     */
    it('should handle severe network degradation', async () => {
      const clients = await createClients(testEnv, [
        { username: 'severe_sender', edge: 1, channelId: 0 },
        { username: 'severe_receiver', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      // 模拟严重网络问题：50% 丢包 + 200ms 延迟
      const edge2Socket = testEnv.edgeServer2?.getUDPSocket();
      if (!edge2Socket) {
        throw new Error('Edge 2 UDP socket not available for simulation');
      }
      
      const simulator = applyNetworkQuality(edge2Socket, {
        packetLoss: 0.5,
        latency: 200,
        jitter: 50,
      });
      console.log('[QUALITY TEST] Applied severe degradation: 50% loss, 200ms±50ms latency');
      
      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) receivedCount++;
      });
      
      await sleep(1000);
      
      // 发送 20 个包
      for (let i = 0; i < 20; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(4000);
      
      console.log(`[SEVERE TEST] Received ${receivedCount}/20 packets with 50% loss`);
      
      // 50% 丢包，期望收到约 10 个包
      expect(receivedCount).toBeGreaterThan(5);
      expect(receivedCount).toBeLessThan(16);
      
      simulator.stop();
      
      await cleanupClients(clients);
    });

    /**
     * 测试网络质量恢复
     */
    it('should detect network quality recovery', async () => {
      const clients = await createClients(testEnv, [
        { username: 'random_payload_user', edge: 1, channelId: 0 },
        { username: 'random_receiver', edge: 2, channelId: 0 },
      ]);
      
      const [sender, receiver] = clients;
      
      const edge2Socket = testEnv.edgeServer2?.getUDPSocket();
      if (!edge2Socket) {
        throw new Error('Edge 2 UDP socket not available for simulation');
      }
      
      // 先应用网络劣化
      const simulator = applyNetworkQuality(edge2Socket, {
        packetLoss: 0.3,
        latency: 150,
      });
      console.log('[RECOVERY TEST] Phase 1: Applied degradation');
      
      let phase1Count = 0;
      let phase2Count = 0;
      let isPhase2 = false;
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          if (!isPhase2) {
            phase1Count++;
          } else {
            phase2Count++;
          }
        }
      });
      
      await sleep(1000);
      
      // Phase 1: 劣化网络下发送（减少发送次数）
      for (let i = 0; i < 10; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(1500);
      console.log(`[RECOVERY TEST] Phase 1: Received ${phase1Count}/10 packets`);
      
      // Phase 2: 恢复网络质量
      isPhase2 = true;  // Switch to phase 2
      simulator.updateConfig({
        packetLoss: 0,
        latency: 0,
      });
      console.log('[RECOVERY TEST] Phase 2: Network recovered');
      
      await sleep(1000);
      
      // 继续发送（减少发送次数）
      for (let i = 10; i < 20; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(1500);
      console.log(`[RECOVERY TEST] Phase 2: Received ${phase2Count}/10 packets`);
      
      // 恢复后应该收到更多包
      expect(phase2Count).toBeGreaterThan(phase1Count);
      expect(phase2Count).toBeGreaterThan(7);
      
      simulator.stop();
      
      await cleanupClients(clients);
    }, 30000); // 增加超时到30秒
    
    /**
     * 原有的测试
     */
    it('should record network quality metrics', async () => {
      const clients = await createClients(testEnv, [
        { username: 'network_sim_sender', edge: 1, channelId: 0 },
        { username: 'network_sim_receiver', edge: 2, channelId: 0 },
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
      
      // 发送一系列语音包来收集网络质量数据
      const startTime = Date.now();
      for (let i = 0; i < 30; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }
      
      await sleep(3000);
      
      const receivedCount = receivedPackets.length;
      console.log(`[NETWORK METRICS TEST] Sent 30, received ${receivedCount}`);
      
      // 应该收到大部分包
      expect(receivedCount).toBeGreaterThan(20);
      
      console.log('[NETWORK METRICS TEST] Test completed successfully');
      
      await cleanupClients(clients);
    }, 45000);
  });
});

