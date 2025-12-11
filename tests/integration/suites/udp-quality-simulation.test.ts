/**
 * UDP 质量模拟测试
 * 
 * 测试网络质量差的情况下的路由行为
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, sleep } from '../setup.js';
import type { TestEnvironment } from '../setup.js';
import { createClients, cleanupClients, createVoicePacket } from '../utils/test-helpers.js';
import { UDPQualitySimulator, NetworkScenarios } from '../utils/udp-quality-simulator.js';

describe('UDP Quality Simulation Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // 启动 4 个 Edge 进行完整路由测试
    testEnv = await setupTestEnvironment(9100, { 
      silent: false,
      startEdge2: true,
      startEdge3: true,
      startEdge4: true,
      reuse: false,
    });
    
    // setupTestEnvironment now waits for all Edge servers to be ready and connected to Hub
  }, 180000);

  afterAll(async () => {
    await testEnv?.cleanup();
    // cleanup() now checks port availability
  });

  describe('Network Quality Impact on Voice Delivery', () => {
    it('should deliver voice with good network quality', async () => {
      const clients = await createClients(testEnv, [
        { username: 'quality_test_e1', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'quality_test_e2', password: 'pass2', edge: 2, channelId: 0 },
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

      // 发送20个语音包
      for (let i = 0; i < 20; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }

      await sleep(2000);

      console.log(`[GOOD QUALITY] Sent 20, received ${receivedCount}`);

      // 良好网络质量下应该收到大部分包
      expect(receivedCount).toBeGreaterThan(18);

      await cleanupClients(clients);
    });

    it('should handle light packet loss gracefully', async () => {
      const clients = await createClients(testEnv, [
        { username: 'network_sim_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'network_sim_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);

      const [sender, receiver] = clients;
      
      // 获取发送方的 UDP socket
      const connectionManager = sender.getConnectionManager();
      const udpSocket = connectionManager.getUdpSocket();
      
      // UDP socket 必须存在才能进行模拟测试
      if (!udpSocket) {
        throw new Error('UDP socket not available - cannot test quality simulation');
      }
      
      // 模拟轻微丢包（2%）
      const simulator = new UDPQualitySimulator(NetworkScenarios.LIGHT_LOSS);
      simulator.start(udpSocket);
      console.log('[TEST] Started UDP quality simulation with LIGHT_LOSS');

      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;

      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });

      await sleep(1000);

      // 发送50个语音包
      for (let i = 0; i < 50; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(30);
      }

      await sleep(3000);

      // 停止模拟
      simulator.stop();
      console.log('[TEST] Stopped UDP quality simulation');

      console.log(`[LIGHT_LOSS] Sent 50, received ${receivedCount}`);

      // 2%丢包率下应该收到约48个包（允许一些误差）
      expect(receivedCount).toBeGreaterThan(45);
      expect(receivedCount).toBeLessThanOrEqual(50);

      await cleanupClients(clients);
    });

    it('should tolerate high latency', async () => {
      const clients = await createClients(testEnv, [
        { username: 'packet_loss_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'packet_loss_receiver', password: 'pass2', edge: 2, channelId: 0 },
      ]);

      const [sender, receiver] = clients;
      
      // 获取发送方的 UDP socket
      const connectionManager = sender.getConnectionManager();
      const udpSocket = connectionManager.getUdpSocket();
      
      // UDP socket 必须存在才能进行模拟测试
      if (!udpSocket) {
        throw new Error('UDP socket not available - cannot test quality simulation');
      }
      
      // 模拟高延迟（200ms + 50ms jitter）
      const simulator = new UDPQualitySimulator(NetworkScenarios.HIGH_LATENCY);
      simulator.start(udpSocket);
      console.log('[TEST] Started UDP quality simulation with HIGH_LATENCY');

      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;

      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });

      await sleep(1000);

      // 发送20个语音包
      const startTime = Date.now();
      for (let i = 0; i < 20; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(50);
      }

      // 等待更长时间以适应高延迟
      await sleep(5000);

      // 停止模拟
      simulator.stop();

      const totalTime = Date.now() - startTime;
      console.log(`[HIGH_LATENCY] Sent 20, received ${receivedCount}, took ${totalTime}ms`);

      // 高延迟下仍应收到大部分包，只是需要更长时间
      expect(receivedCount).toBeGreaterThan(17);

      await cleanupClients(clients);
    });

    it('should experience packet loss with poor quality', async () => {
      const clients = await createClients(testEnv, [
        { username: 'poor_direct_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'poor_direct_receiver', password: 'pass3', edge: 4, channelId: 0 },
      ]);

      const [sender, receiver] = clients;
      
      // 获取发送方的 UDP socket
      const connectionManager = sender.getConnectionManager();
      const udpSocket = connectionManager.getUdpSocket();
      
      // UDP socket 必须存在才能进行模拟测试
      if (!udpSocket) {
        throw new Error('UDP socket not available - cannot test quality simulation');
      }
      
      // 模拟严重质量问题（15%丢包，300ms延迟）
      const simulator = new UDPQualitySimulator(NetworkScenarios.POOR);
      simulator.start(udpSocket);
      console.log('[TEST] Started UDP quality simulation with POOR quality');

      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;

      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });

      await sleep(1000);

      // 发送100个语音包以观察丢包效果
      for (let i = 0; i < 100; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(30);
      }

      await sleep(6000);

      // 停止模拟
      simulator.stop();

      const lossRate = 1 - (receivedCount / 100);
      console.log(`[POOR_QUALITY] Sent 100, received ${receivedCount}, loss rate: ${(lossRate * 100).toFixed(1)}%`);

      // 模拟器已启动，期望看到丢包
      // 15%丢包率下应该收到约85个包（允许较大误差因为是随机的）
      expect(receivedCount).toBeGreaterThan(70);
      expect(receivedCount).toBeLessThan(100);

      await cleanupClients(clients);
    });

    it('should verify simulator can be dynamically adjusted', async () => {
      const clients = await createClients(testEnv, [
        { username: 'balance_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'balance_receiver', password: 'pass4', edge: 4, channelId: 0 },
      ]);

      const [sender, receiver] = clients;
      
      // 获取发送方的 UDP socket
      const connectionManager = sender.getConnectionManager();
      const udpSocket = connectionManager.getUdpSocket();
      
      // UDP socket 必须存在才能进行模拟测试
      if (!udpSocket) {
        throw new Error('UDP socket not available - cannot test quality simulation');
      }
      
      // 开始时使用良好质量
      const simulator = new UDPQualitySimulator(NetworkScenarios.GOOD);
      simulator.start(udpSocket);
      console.log('[TEST] Started with GOOD quality');

      let receivedCount = 0;
      const senderSession = sender.getStateManager().getSession()?.session || 0;

      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });

      await sleep(1000);

      // 第一阶段：良好质量发送20个包
      console.log('[TEST] Phase 1: GOOD quality');
      for (let i = 0; i < 20; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(30);
      }

      await sleep(1000);
      const phase1Count = receivedCount;
      console.log(`[TEST] Phase 1 received: ${phase1Count}/20`);

      // 第二阶段：切换到差质量
      simulator.updateConfig(NetworkScenarios.POOR);
      console.log('[TEST] Phase 2: POOR quality');

      for (let i = 20; i < 40; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(30);
      }

      await sleep(4000);
      const phase2Count = receivedCount - phase1Count;
      console.log(`[TEST] Phase 2 received: ${phase2Count}/20`);

      // 停止模拟
      simulator.stop();

      console.log(`[DYNAMIC] Phase 1: ${phase1Count}/20, Phase 2: ${phase2Count}/20`);

      // 第一阶段应该收到几乎所有包
      expect(phase1Count).toBeGreaterThan(18);
      
      // 第二阶段由于质量差，应该会丢失一些包
      // 15%丢包率下预期收到约17个包（允许较大误差）
      expect(phase2Count).toBeGreaterThan(10);
      expect(phase2Count).toBeLessThan(20);

      await cleanupClients(clients);
    });
  });
});
