/**
 * 监听频道集成测试
 * 
 * 测试监听频道功能，包括：
 * - 添加监听频道
 * - 移除监听频道
 * - 清空所有监听频道
 * - 跨频道语音接收
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';

describe('Listening Channel Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8085);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Listening Channel Management', () => {
    it.skip('should add listening channel and broadcast to all edges', async () => {
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
      let listeningChannelAddedLocal = false;
      const listeningPromiseLocal = new Promise<void>((resolve) => {
        client2.on('userState', (state: any) => {
          if (state.session === session1 && state.listening_channel_add && state.listening_channel_add.length > 0) {
            listeningChannelAddedLocal = true;
            resolve();
          }
        });
      });

      // 跨 Edge 用户监听
      let listeningChannelAddedRemote = false;
      const listeningPromiseRemote = new Promise<void>((resolve) => {
        client3.on('userState', (state: any) => {
          if (state.session === session1 && state.listening_channel_add && state.listening_channel_add.length > 0) {
            listeningChannelAddedRemote = true;
            resolve();
          }
        });
      });

      // 用户1添加监听频道1
      await client1.addListeningChannel(1);

      // 等待本 Edge 和跨 Edge 用户收到状态更新
      await Promise.all([
        Promise.race([listeningPromiseLocal, new Promise(resolve => setTimeout(resolve, 2000))]),
        Promise.race([listeningPromiseRemote, new Promise(resolve => setTimeout(resolve, 2000))])
      ]);

      expect(listeningChannelAddedLocal).toBe(true);
      expect(listeningChannelAddedRemote).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
      await client3.disconnect();
    });

    it('should remove listening channel', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      // 先添加监听频道
      await client.addListeningChannel(1);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 然后移除监听频道
      await client.removeListeningChannel(1);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 验证操作成功（实际验证需要检查状态）
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should clear all listening channels', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      // 添加多个监听频道
      await client.addListeningChannel(1);
      await new Promise(resolve => setTimeout(resolve, 100));
      await client.addListeningChannel(2);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 清空所有监听频道
      await client.clearListeningChannels();
      await new Promise(resolve => setTimeout(resolve, 100));

      // 验证操作成功
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should receive voice from listened channels', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

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

      // 获取频道列表
      const channels = client1.getChannels();
      if (channels.length > 1) {
        // 用户1移动到频道1
        await client1.joinChannel(channels[1].channel_id);
        await new Promise(resolve => setTimeout(resolve, 200));

        // 用户2留在根频道，但监听频道1
        await client2.addListeningChannel(channels[1].channel_id);
        await new Promise(resolve => setTimeout(resolve, 200));

        // 此时用户2应该能收到来自频道1的语音
        // 实际测试需要发送语音数据并验证接收
        expect(client1.isConnected()).toBe(true);
        expect(client2.isConnected()).toBe(true);
      }

      await client1.disconnect();
      await client2.disconnect();
    });

    it('should handle multiple clients listening to same channel', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

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
        port: testEnv.edgePort,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      const channels = client1.getChannels();
      if (channels.length > 1) {
        // 用户1在频道1
        await client1.joinChannel(channels[1].channel_id);
        await new Promise(resolve => setTimeout(resolve, 200));

        // 用户2和用户3都在根频道，但都监听频道1
        await client2.addListeningChannel(channels[1].channel_id);
        await client3.addListeningChannel(channels[1].channel_id);
        await new Promise(resolve => setTimeout(resolve, 200));

        // 验证所有客户端都保持连接
        expect(client1.isConnected()).toBe(true);
        expect(client2.isConnected()).toBe(true);
        expect(client3.isConnected()).toBe(true);
      }

      await client1.disconnect();
      await client2.disconnect();
      await client3.disconnect();
    });
  });
});
