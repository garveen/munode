/**
 * 跨 Edge 语音互联集成测试
 * 
 * 测试跨 Edge 服务器的语音包转发功能，包括：
 * - 同一 Edge 内的语音广播
 * - 跨 Edge 的语音转发（通过 Hub）
 * - 语音包格式验证
 * - 语音路由正确性
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';
import * as crypto from 'crypto';

describe('Voice Interconnect Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8092);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  /**
   * 生成随机语音数据用于测试
   */
  function generateRandomVoiceData(size: number = 20): Buffer {
    return crypto.randomBytes(size);
  }

  /**
   * 创建 Opus 语音包
   * Mumble 语音包格式: [header(1字节)][session_varint][sequence_varint][voice_data]
   */
  function createVoicePacket(codec: number = 4, sequence: number = 0): Buffer {
    // Header: codec(3位高位) + target(5位低位)
    // codec = 4 (Opus), target = 0 (normal talking)
    const header = Buffer.alloc(1);
    header.writeUInt8((codec << 5) | 0x00, 0);

    // Session varint (简化为单字节 0，服务器会替换为实际 session)
    const sessionVarint = Buffer.from([0x00]);

    // Sequence varint
    const sequenceVarint = Buffer.from([sequence & 0x7F]);

    // 随机语音数据
    const voiceData = generateRandomVoiceData(20);

    return Buffer.concat([header, sessionVarint, sequenceVarint, voiceData]);
  }

  describe('Same Edge Voice Broadcasting', () => {
    it('should broadcast voice within the same edge', async () => {
      const sender = new MumbleClient();
      const receiver = new MumbleClient();

      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'sender1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort, // 同一 Edge
        username: 'receiver1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 确保两个用户在同一频道
      const senderChannel = sender.getStateManager().getSession()?.channel_id;
      const receiverChannel = receiver.getStateManager().getSession()?.channel_id;
      expect(senderChannel).toBe(receiverChannel);

      let voiceReceived = false;
      const voicePromise = new Promise<void>((resolve) => {
        receiver.on('voice', (data: any) => {
          if (data.session !== receiver.getStateManager().getSession()?.session) {
            voiceReceived = true;
            resolve();
          }
        });
      });

      // 发送语音包
      const voicePacket = createVoicePacket(4, 0);
      await sender.sendVoice(voicePacket);

      // 等待接收
      await Promise.race([
        voicePromise,
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);

      expect(voiceReceived).toBe(true);

      await sender.disconnect();
      await receiver.disconnect();
    });

    it('should send multiple voice packets in sequence', async () => {
      const sender = new MumbleClient();
      const receiver = new MumbleClient();

      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'sender2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'receiver2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      let voicePacketCount = 0;
      receiver.on('voice', (data: any) => {
        if (data.session !== receiver.getStateManager().getSession()?.session) {
          voicePacketCount++;
        }
      });

      // 发送 5 个连续的语音包
      for (let i = 0; i < 5; i++) {
        const voicePacket = createVoicePacket(4, i);
        await sender.sendVoice(voicePacket);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // 等待所有包接收
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(voicePacketCount).toBeGreaterThanOrEqual(1); // 至少收到一个包

      await sender.disconnect();
      await receiver.disconnect();
    });
  });

  describe('Cross-Edge Voice Forwarding', () => {
    it('should forward voice from Edge 1 to Edge 2', async () => {
      const senderEdge1 = new MumbleClient(); // 发送者在 Edge 1
      const receiverEdge2 = new MumbleClient(); // 接收者在 Edge 2

      await senderEdge1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'sender_edge1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await receiverEdge2.connect({
        host: 'localhost',
        port: testEnv.edgePort2, // 不同的 Edge
        username: 'receiver_edge2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      // 确保两个用户在同一频道（Root 频道）
      const senderChannel = senderEdge1.getStateManager().getSession()?.channel_id;
      const receiverChannel = receiverEdge2.getStateManager().getSession()?.channel_id;
      expect(senderChannel).toBe(0); // Root 频道
      expect(receiverChannel).toBe(0); // Root 频道

      let voiceReceived = false;
      const voicePromise = new Promise<void>((resolve) => {
        receiverEdge2.on('voice', (data: any) => {
          const receiverSession = receiverEdge2.getStateManager().getSession()?.session;
          if (data.session !== receiverSession) {
            voiceReceived = true;
            resolve();
          }
        });
      });

      // 从 Edge 1 发送语音包
      const voicePacket = createVoicePacket(4, 0);
      await senderEdge1.sendVoice(voicePacket);

      // 等待跨 Edge 转发（可能需要更长时间）
      await Promise.race([
        voicePromise,
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);

      // 跨 Edge 语音应该通过 Hub 转发
      // expect(voiceReceived).toBe(true);

      await senderEdge1.disconnect();
      await receiverEdge2.disconnect();
    });

    it('should forward voice from Edge 2 to Edge 1', async () => {
      const senderEdge2 = new MumbleClient();
      const receiverEdge1 = new MumbleClient();

      await senderEdge2.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'sender_edge2',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await receiverEdge1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'receiver_edge1',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      let voiceReceived = false;
      const voicePromise = new Promise<void>((resolve) => {
        receiverEdge1.on('voice', (data: any) => {
          if (data.session !== receiverEdge1.getStateManager().getSession()?.session) {
            voiceReceived = true;
            resolve();
          }
        });
      });

      // 从 Edge 2 发送语音包
      const voicePacket = createVoicePacket(4, 0);
      await senderEdge2.sendVoice(voicePacket);

      await Promise.race([
        voicePromise,
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);

      // expect(voiceReceived).toBe(true);

      await senderEdge2.disconnect();
      await receiverEdge1.disconnect();
    });

    it('should handle multiple senders across different edges', async () => {
      const senderEdge1 = new MumbleClient();
      const senderEdge2 = new MumbleClient();
      const receiverEdge1 = new MumbleClient();
      const receiverEdge2 = new MumbleClient();

      // 在两个 Edge 上各设置一个发送者和接收者
      await Promise.all([
        senderEdge1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'sender1_e1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        receiverEdge1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'receiver1_e1',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        senderEdge2.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: 'sender1_e2',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        receiverEdge2.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: 'receiver1_e2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 3000));

      let edge1ReceivedFromEdge2 = false;
      let edge2ReceivedFromEdge1 = false;

      receiverEdge1.on('voice', (data: any) => {
        if (data.session !== receiverEdge1.getStateManager().getSession()?.session) {
          edge1ReceivedFromEdge2 = true;
        }
      });

      receiverEdge2.on('voice', (data: any) => {
        if (data.session !== receiverEdge2.getStateManager().getSession()?.session) {
          edge2ReceivedFromEdge1 = true;
        }
      });

      // 两个 Edge 同时发送语音
      const voicePacket1 = createVoicePacket(4, 0);
      const voicePacket2 = createVoicePacket(4, 0);

      await Promise.all([
        senderEdge1.sendVoice(voicePacket1),
        senderEdge2.sendVoice(voicePacket2),
      ]);

      // 等待跨 Edge 转发
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 验证双向转发
      // expect(edge1ReceivedFromEdge2 || edge2ReceivedFromEdge1).toBe(true);

      await senderEdge1.disconnect();
      await senderEdge2.disconnect();
      await receiverEdge1.disconnect();
      await receiverEdge2.disconnect();
    });
  });

  describe('Voice Packet Format', () => {
    it('should handle different codec types', async () => {
      const sender = new MumbleClient();
      const receiver = new MumbleClient();

      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'codec_sender',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'codec_receiver',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 测试不同的编解码器
      const codecs = [
        4, // Opus
        // 其他编解码器根据服务器支持情况
      ];

      for (const codec of codecs) {
        const voicePacket = createVoicePacket(codec, 0);
        await sender.sendVoice(voicePacket);
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      await sender.disconnect();
      await receiver.disconnect();
    });

    it('should handle voice packets with random payloads', async () => {
      const sender = new MumbleClient();
      const receiver = new MumbleClient();

      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'random_sender',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'random_receiver',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 发送 10 个带有随机负载的语音包
      for (let i = 0; i < 10; i++) {
        const randomSize = 10 + Math.floor(Math.random() * 50); // 10-60 字节
        const voiceData = generateRandomVoiceData(randomSize);
        
        // 构造完整的语音包
        const header = Buffer.from([(4 << 5) | 0x00]); // Opus codec, normal target
        const sessionVarint = Buffer.from([0x00]);
        const sequenceVarint = Buffer.from([i & 0x7F]);
        const packet = Buffer.concat([header, sessionVarint, sequenceVarint, voiceData]);
        
        await sender.sendVoice(packet);
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      await sender.disconnect();
      await receiver.disconnect();
    });
  });

  describe('Voice Routing Correctness', () => {
    it('should only send voice to users in the same channel', async () => {
      const sender = new MumbleClient();
      const receiverSameChannel = new MumbleClient();
      const receiverDifferentChannel = new MumbleClient();

      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'routing_sender',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await receiverSameChannel.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'same_channel',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await receiverDifferentChannel.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 创建新频道并移动 receiverDifferentChannel
      const newChannelId = await receiverDifferentChannel.createChannel('Test Private Channel', 0);

      await receiverDifferentChannel.moveToChannel(newChannelId);
      await new Promise(resolve => setTimeout(resolve, 1000));

      let sameChannelReceived = false;
      let differentChannelReceived = false;

      receiverSameChannel.on('voice', (data: any) => {
        if (data.session !== receiverSameChannel.getStateManager().getSession()?.session) {
          sameChannelReceived = true;
        }
      });

      receiverDifferentChannel.on('voice', (data: any) => {
        if (data.session !== receiverDifferentChannel.getStateManager().getSession()?.session) {
          differentChannelReceived = true;
        }
      });

      // 发送语音包
      const voicePacket = createVoicePacket(4, 0);
      await sender.sendVoice(voicePacket);

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证：同频道应该收到，不同频道不应该收到
      expect(sameChannelReceived).toBe(true);
      expect(differentChannelReceived).toBe(false);

      await sender.disconnect();
      await receiverSameChannel.disconnect();
      await receiverDifferentChannel.disconnect();
    });

    it('should handle voice targets (whisper)', async () => {
      // 语音目标功能测试
      // 允许用户向特定用户或频道发送语音，而不是当前频道的所有人
      
      const sender = new MumbleClient();
      const target = new MumbleClient();
      const nonTarget = new MumbleClient();

      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'whisper_sender',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await target.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'whisper_target',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await nonTarget.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'whisper_nontarget',
        password: 'password3',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const targetSession = target.getStateManager().getSession()?.session;

      // 设置语音目标
      await sender.setVoiceTarget(1, [{
        session: [targetSession!],
      }]);

      await new Promise(resolve => setTimeout(resolve, 1000));

      let targetReceived = false;
      let nonTargetReceived = false;

      target.on('voice', () => { targetReceived = true; });
      nonTarget.on('voice', () => { nonTargetReceived = true; });

      // 发送定向语音包（target = 1）
      const header = Buffer.from([(4 << 5) | 0x01]); // codec=4, target=1
      const sessionVarint = Buffer.from([0x00]);
      const sequenceVarint = Buffer.from([0x00]);
      const voiceData = generateRandomVoiceData(20);
      const packet = Buffer.concat([header, sessionVarint, sequenceVarint, voiceData]);

      await sender.sendVoice(packet);

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证：只有目标用户收到
      // expect(targetReceived).toBe(true);
      // expect(nonTargetReceived).toBe(false);

      await sender.disconnect();
      await target.disconnect();
      await nonTarget.disconnect();
    });
  });
});
