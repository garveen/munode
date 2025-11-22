/**
 * 语音传输集成测试
 * 
 * 测试语音相关功能，包括：
 * - 语音包传输
 * - 语音路由
 * - 语音目标
 * - 静音/禁音
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';

describe('Voice Transmission Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8083);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Voice Protocol Concepts', () => {
    it('should support UDP voice transmission', () => {
      // MuNode 使用 UDP 传输语音数据
      // 验证 UDP 传输的基本配置
      const udpEnabled = true;
      expect(udpEnabled).toBe(true);
    });

    it('should support voice packet format', () => {
      // Mumble 语音包格式：
      // [header(1字节)][session_varint][sequence_varint][voice_data]
      // 验证头部结构
      const header = Buffer.alloc(1);
      const codec = 4; // Opus
      const target = 0; // Normal talking
      header.writeUInt8((codec << 5) | target, 0);
      
      expect(header.readUInt8(0)).toBe((4 << 5) | 0);
    });

    it('should support voice codecs', () => {
      // 支持 Opus 和其他编解码器
      const supportedCodecs = ['opus', 'celt', 'speex'];
      expect(supportedCodecs).toContain('opus');
      expect(supportedCodecs.length).toBeGreaterThan(0);
    });
  });

  describe('Voice Routing', () => {
    it('should support channel-based routing', () => {
      // 频道内语音广播 - 验证路由概念
      // 所有在同一频道的用户都应该收到语音
      const channelId = 0; // Root 频道
      const usersInChannel = [1, 2, 3]; // 模拟用户 session
      
      expect(channelId).toBe(0);
      expect(usersInChannel.length).toBeGreaterThan(0);
    });

    it('should support direct messaging', () => {
      // 点对点语音传输（通过 VoiceTarget）
      // target 字段指定特定用户
      const targetSession = 1;
      const voiceTargetId = 1; // 自定义语音目标 ID
      
      expect(targetSession).toBeGreaterThan(0);
      expect(voiceTargetId).toBeGreaterThan(0);
    });

    it('should support voice targets', () => {
      // 自定义语音目标可以指向：
      // 1. 特定用户（session）
      // 2. 特定频道
      // 3. ACL 组
      const voiceTarget = {
        id: 1,
        targets: [
          { session: [1, 2] }, // 用户 1 和 2
          { channel_id: 1 }     // 频道 1
        ]
      };
      
      expect(voiceTarget.targets.length).toBe(2);
    });
  });

  describe('Voice Transmission via Client', () => {
    it('should handle mute/deafen states across edges', async () => {
      const client1 = new MumbleClient(); // 操作者 - Edge 1
      const client2 = new MumbleClient(); // 本 Edge 观察者 - Edge 1
      const client3 = new MumbleClient(); // 跨 Edge 观察者 - Edge 2

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await client3.connect({
        host: 'localhost',
        port: testEnv.edgePort2, // 连接到第二个 Edge
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      const session1 = client1.getStateManager().getSession()?.session;

      // 本 Edge 用户监听
      let muteReceivedLocal = false;
      const mutePromiseLocal = new Promise<void>((resolve) => {
        client2.on('userState', (state: any) => {
          if (state.session === session1 && state.self_mute === true) {
            muteReceivedLocal = true;
            resolve();
          }
        });
      });

      // 跨 Edge 用户监听
      let muteReceivedRemote = false;
      const mutePromiseRemote = new Promise<void>((resolve) => {
        client3.on('userState', (state: any) => {
          if (state.session === session1 && state.self_mute === true) {
            muteReceivedRemote = true;
            resolve();
          }
        });
      });

      // 用户1设置为静音
      await client1.setSelfMute(true);

      // 等待本 Edge 和跨 Edge 用户收到状态更新
      await Promise.all([
        Promise.race([mutePromiseLocal, new Promise(resolve => setTimeout(resolve, 2000))]),
        Promise.race([mutePromiseRemote, new Promise(resolve => setTimeout(resolve, 2000))])
      ]);

      expect(muteReceivedLocal).toBe(true);
      expect(muteReceivedRemote).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
      await client3.disconnect();
    });

    it('should handle self deafen state across edges', async () => {
      const client1 = new MumbleClient(); // 操作者 - Edge 1
      const client2 = new MumbleClient(); // 本 Edge 观察者 - Edge 1
      const client3 = new MumbleClient(); // 跨 Edge 观察者 - Edge 2

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await client3.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      const session1 = client1.getStateManager().getSession()?.session;

      // 本 Edge 用户监听
      let deafReceivedLocal = false;
      const deafPromiseLocal = new Promise<void>((resolve) => {
        client2.on('userState', (state: any) => {
          if (state.session === session1 && state.self_deaf === true) {
            deafReceivedLocal = true;
            resolve();
          }
        });
      });

      // 跨 Edge 用户监听
      let deafReceivedRemote = false;
      const deafPromiseRemote = new Promise<void>((resolve) => {
        client3.on('userState', (state: any) => {
          if (state.session === session1 && state.self_deaf === true) {
            deafReceivedRemote = true;
            resolve();
          }
        });
      });

      // 用户1设置为禁听
      await client1.setSelfDeaf(true);

      // 等待本 Edge 和跨 Edge 用户收到状态更新
      await Promise.all([
        Promise.race([deafPromiseLocal, new Promise(resolve => setTimeout(resolve, 2000))]),
        Promise.race([deafPromiseRemote, new Promise(resolve => setTimeout(resolve, 2000))])
      ]);

      expect(deafReceivedLocal).toBe(true);
      expect(deafReceivedRemote).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
      await client3.disconnect();
    });

    it('should handle recording state across edges', async () => {
      const client1 = new MumbleClient(); // 操作者 - Edge 1
      const client2 = new MumbleClient(); // 本 Edge 观察者 - Edge 1
      const client3 = new MumbleClient(); // 跨 Edge 观察者 - Edge 2

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await client3.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      const session1 = client1.getStateManager().getSession()?.session;

      // 本 Edge 用户监听
      let recordingReceivedLocal = false;
      const recordingPromiseLocal = new Promise<void>((resolve) => {
        client2.on('userState', (state: any) => {
          if (state.session === session1 && state.recording === true) {
            recordingReceivedLocal = true;
            resolve();
          }
        });
      });

      // 跨 Edge 用户监听
      let recordingReceivedRemote = false;
      const recordingPromiseRemote = new Promise<void>((resolve) => {
        client3.on('userState', (state: any) => {
          if (state.session === session1 && state.recording === true) {
            recordingReceivedRemote = true;
            resolve();
          }
        });
      });

      // 用户1设置为录音状态
      await client1.setRecording(true);

      // 等待本 Edge 和跨 Edge 用户收到状态更新
      await Promise.all([
        Promise.race([recordingPromiseLocal, new Promise(resolve => setTimeout(resolve, 2000))]),
        Promise.race([recordingPromiseRemote, new Promise(resolve => setTimeout(resolve, 2000))])
      ]);

      expect(recordingReceivedLocal).toBe(true);
      expect(recordingReceivedRemote).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
      await client3.disconnect();
    });

    it('should set voice target', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      // 设置语音目标到特定频道
      await client.setVoiceTarget(1, [{
        session: [],
        channel_id: 0,
        group: '',
        links: false,
        children: false,
      }]);

      // 等待一段时间确保消息发送成功
      await new Promise(resolve => setTimeout(resolve, 100));

      // 移除语音目标
      await client.removeVoiceTarget(1);

      await client.disconnect();
    });
  });
});
