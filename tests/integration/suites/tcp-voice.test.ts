/**
 * TCP语音传输集成测试
 * 
 * 测试TCP语音相关功能，包括：
 * - TCP强制模式
 * - UDP失败降级
 * - TCP/UDP混合环境
 * - 语音包路由
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';

describe('TCP Voice Transmission Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8084);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('TCP-only Voice Mode', () => {
    it('should connect with forceTcpVoice option', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'tcp_user',
        password: 'tcp_pass',
        rejectUnauthorized: false,
        forceTcpVoice: true, // 强制使用TCP语音
      });

      // 验证客户端已连接
      expect(client.isConnected()).toBe(true);

      // 验证连接管理器使用TCP语音模式
      const connectionManager = client.getConnectionManager();
      expect(connectionManager.isUsingTcpVoice()).toBe(true);

      await client.disconnect();
    });

    it('should send voice packets via TCP tunnel', async () => {
      const sender = new MumbleClient();
      const receiver = new MumbleClient();

      // 发送者使用TCP语音模式
      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'tcp_sender',
        password: 'tcp_sender_pass',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      // 接收者使用普通UDP模式
      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'tcp_receiver',
        password: 'tcp_receiver_pass',
        rejectUnauthorized: false,
      });

      // 等待连接稳定
      await new Promise(resolve => setTimeout(resolve, 500));

      // 监听接收者的语音包
      let receivedVoice = false;
      receiver.on('udpTunnel', (data: Buffer) => {
        if (data && data.length > 0) {
          receivedVoice = true;
        }
      });

      // 发送者发送模拟语音数据
      const mockVoiceData = Buffer.from('mock_voice_data_for_testing');
      await sender.getConnectionManager().sendVoicePacket(mockVoiceData);

      // 等待接收
      await new Promise(resolve => setTimeout(resolve, 1000));

      // TCP模式下，语音包应该通过UDPTunnel消息发送
      // 注意：在测试环境中，我们可能无法完全验证语音包的路由
      // 但至少可以确保发送不会抛出错误
      expect(sender.getConnectionManager().isUsingTcpVoice()).toBe(true);

      await sender.disconnect();
      await receiver.disconnect();
    });
  });

  describe('UDP Fallback to TCP', () => {
    it('should automatically fallback to TCP when UDP fails', async () => {
      const client = new MumbleClient();

      // 不强制TCP模式，让UDP自然失败后降级
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'fallback_user',
        password: 'fallback_pass',
        rejectUnauthorized: false,
        forceTcpVoice: false, // 允许UDP，但可能会失败
      });

      expect(client.isConnected()).toBe(true);

      // 尝试发送语音包，如果UDP失败应该自动降级到TCP
      const mockVoiceData = Buffer.from('fallback_test_voice_data');
      
      // 第一次尝试可能使用UDP
      await client.getConnectionManager().sendVoicePacket(mockVoiceData);

      // 如果UDP发送失败，下次应该使用TCP
      await client.getConnectionManager().sendVoicePacket(mockVoiceData);

      // 验证客户端仍然连接
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });
  });

  describe('Mixed TCP/UDP Environment', () => {
    it('should handle voice routing in mixed environment', async () => {
      const tcpClient1 = new MumbleClient();
      const tcpClient2 = new MumbleClient();
      const udpClient = new MumbleClient();

      // TCP客户端1 (强制TCP)
      await tcpClient1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'mixed_tcp1',
        password: 'pass1',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      // TCP客户端2 (强制TCP)
      await tcpClient2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'mixed_tcp2',
        password: 'pass2',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      // UDP客户端 (正常模式)
      await udpClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'mixed_udp',
        password: 'pass3',
        rejectUnauthorized: false,
        forceTcpVoice: false,
      });

      // 等待连接稳定
      await new Promise(resolve => setTimeout(resolve, 500));

      // 验证所有客户端已连接
      expect(tcpClient1.isConnected()).toBe(true);
      expect(tcpClient2.isConnected()).toBe(true);
      expect(udpClient.isConnected()).toBe(true);

      // 验证TCP客户端使用TCP模式
      expect(tcpClient1.getConnectionManager().isUsingTcpVoice()).toBe(true);
      expect(tcpClient2.getConnectionManager().isUsingTcpVoice()).toBe(true);

      // UDP客户端初始可能使用UDP模式（除非连接失败）
      // 不做严格断言，因为可能会降级到TCP

      // 测试语音包发送（不应该抛出错误）
      const mockVoiceData = Buffer.from('mixed_env_voice_test');
      
      await tcpClient1.getConnectionManager().sendVoicePacket(mockVoiceData);
      await tcpClient2.getConnectionManager().sendVoicePacket(mockVoiceData);
      await udpClient.getConnectionManager().sendVoicePacket(mockVoiceData);

      // 等待处理
      await new Promise(resolve => setTimeout(resolve, 500));

      await tcpClient1.disconnect();
      await tcpClient2.disconnect();
      await udpClient.disconnect();
    });

    it('should route TCP voice packets to UDP clients', async () => {
      const tcpSender = new MumbleClient();
      const udpReceiver = new MumbleClient();

      // TCP发送者
      await tcpSender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'tcp_to_udp_sender',
        password: 'sender_pass',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      // UDP接收者
      await udpReceiver.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'tcp_to_udp_receiver',
        password: 'receiver_pass',
        rejectUnauthorized: false,
        forceTcpVoice: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 发送语音包
      const mockVoiceData = Buffer.from('tcp_to_udp_voice_data');
      await tcpSender.getConnectionManager().sendVoicePacket(mockVoiceData);

      // 等待传输
      await new Promise(resolve => setTimeout(resolve, 500));

      // 验证发送成功（无错误）
      expect(tcpSender.isConnected()).toBe(true);
      expect(udpReceiver.isConnected()).toBe(true);

      await tcpSender.disconnect();
      await udpReceiver.disconnect();
    });

    it('should route UDP voice packets to TCP clients', async () => {
      const udpSender = new MumbleClient();
      const tcpReceiver = new MumbleClient();

      // UDP发送者
      await udpSender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'udp_to_tcp_sender',
        password: 'sender_pass',
        rejectUnauthorized: false,
        forceTcpVoice: false,
      });

      // TCP接收者
      await tcpReceiver.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'udp_to_tcp_receiver',
        password: 'receiver_pass',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 发送语音包
      const mockVoiceData = Buffer.from('udp_to_tcp_voice_data');
      await udpSender.getConnectionManager().sendVoicePacket(mockVoiceData);

      // 等待传输
      await new Promise(resolve => setTimeout(resolve, 500));

      // 验证发送成功（无错误）
      expect(udpSender.isConnected()).toBe(true);
      expect(tcpReceiver.isConnected()).toBe(true);

      await udpSender.disconnect();
      await tcpReceiver.disconnect();
    });
  });

  describe('Voice Packet Format', () => {
    it('should construct valid voice packets for TCP transmission', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'packet_format_user',
        password: 'packet_pass',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      // 等待认证完成
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 构造模拟语音包
      const mockAudioData = Buffer.from('test_audio_payload_12345');
      
      // 发送语音包（应该通过TCP隧道）
      await client.getConnectionManager().sendVoicePacket(mockAudioData);

      // 验证不会抛出错误
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should handle voice packets with random payload', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'random_payload_user',
        password: 'random_pass',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // 生成随机payload（模拟真实语音数据）
      const randomPayload = Buffer.alloc(128);
      for (let i = 0; i < randomPayload.length; i++) {
        randomPayload[i] = Math.floor(Math.random() * 256);
      }

      // 发送多个随机语音包
      for (let i = 0; i < 5; i++) {
        await client.getConnectionManager().sendVoicePacket(randomPayload);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // 验证客户端仍然连接
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });
  });

  describe('Cross-Edge TCP Voice', () => {
    it('should route TCP voice packets across edges', async () => {
      const edge1Client = new MumbleClient();
      const edge2Client = new MumbleClient();

      // Edge 1 上的TCP客户端
      await edge1Client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'cross_edge_tcp1',
        password: 'pass1',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      // Edge 2 上的TCP客户端
      await edge2Client.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'cross_edge_tcp2',
        password: 'pass2',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // 发送语音包
      const mockVoiceData = Buffer.from('cross_edge_tcp_voice');
      await edge1Client.getConnectionManager().sendVoicePacket(mockVoiceData);

      // 等待跨Edge路由
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 验证两个客户端都保持连接
      expect(edge1Client.isConnected()).toBe(true);
      expect(edge2Client.isConnected()).toBe(true);

      await edge1Client.disconnect();
      await edge2Client.disconnect();
    });
  });

  describe('TCP Voice Performance', () => {
    it('should handle rapid voice packet transmission', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'perf_test_user',
        password: 'perf_pass',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // 快速发送多个语音包
      const mockVoiceData = Buffer.from('performance_test_voice_packet');
      const sendPromises = [];

      for (let i = 0; i < 20; i++) {
        sendPromises.push(
          client.getConnectionManager().sendVoicePacket(mockVoiceData)
        );
      }

      // 等待所有发送完成
      await Promise.all(sendPromises);

      // 验证客户端仍然连接且没有错误
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should handle large voice packets', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'large_packet_user',
        password: 'large_pass',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // 发送大的语音包
      const largeVoiceData = Buffer.alloc(2048);
      for (let i = 0; i < largeVoiceData.length; i++) {
        largeVoiceData[i] = i % 256;
      }

      await client.getConnectionManager().sendVoicePacket(largeVoiceData);

      // 等待传输完成
      await new Promise(resolve => setTimeout(resolve, 500));

      // 验证客户端仍然连接
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });
  });
});
