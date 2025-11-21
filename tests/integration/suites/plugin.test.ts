/**
 * 插件功能集成测试
 * 
 * 测试插件相关功能，包括：
 * - 插件数据传输
 * - 上下文操作注册
 * - 上下文操作执行
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';

describe('Plugin Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8087);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Plugin Data Transmission', () => {
    it('should send plugin data to all users across edges', async () => {
      const client1 = new MumbleClient(); // 发送者 - Edge 1
      const client2 = new MumbleClient(); // 本 Edge 接收者 - Edge 1
      const client3 = new MumbleClient(); // 跨 Edge 接收者 - Edge 2

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

      const pluginId = 'com.example.testplugin';
      const pluginData = Buffer.from('test plugin data');

      // 本 Edge 用户监听
      let dataReceivedLocal = false;
      const dataPromiseLocal = new Promise<void>((resolve) => {
        client2.on('pluginData', (data: any) => {
          if (data.dataID === pluginId) {
            dataReceivedLocal = true;
            resolve();
          }
        });
      });

      // 跨 Edge 用户监听
      let dataReceivedRemote = false;
      const dataPromiseRemote = new Promise<void>((resolve) => {
        client3.on('pluginData', (data: any) => {
          if (data.dataID === pluginId) {
            dataReceivedRemote = true;
            resolve();
          }
        });
      });

      // 用户1发送插件数据（广播到所有用户）
      await client1.sendPluginData(pluginId, pluginData);

      // 等待本 Edge 和跨 Edge 用户收到数据
      await Promise.all([
        Promise.race([dataPromiseLocal, new Promise(resolve => setTimeout(resolve, 2000))]),
        Promise.race([dataPromiseRemote, new Promise(resolve => setTimeout(resolve, 2000))])
      ]);

      expect(dataReceivedLocal).toBe(true);
      expect(dataReceivedRemote).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
      await client3.disconnect();
    });

    it('should send plugin data to specific users', async () => {
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

      const session2 = client2.getStateManager().getSession()?.session;
      const pluginId = 'com.example.privateplugin';
      const pluginData = Buffer.from('private plugin data');

      // 只有用户2监听
      let dataReceived = false;
      const dataPromise = new Promise<void>((resolve) => {
        client2.on('pluginData', (data: any) => {
          if (data.dataID === pluginId) {
            dataReceived = true;
            resolve();
          }
        });
      });

      // 用户3也监听（不应该收到）
      let client3ReceivedData = false;
      client3.on('pluginData', (data: any) => {
        if (data.dataID === pluginId) {
          client3ReceivedData = true;
        }
      });

      // 用户1发送插件数据到特定用户（只发给用户2）
      await client1.sendPluginData(pluginId, pluginData, [session2!]);

      // 等待
      await Promise.race([
        dataPromise,
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);

      expect(dataReceived).toBe(true);
      expect(client3ReceivedData).toBe(false); // 用户3不应该收到

      await client1.disconnect();
      await client2.disconnect();
      await client3.disconnect();
    });

    it('should handle large plugin data', async () => {
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

      const pluginId = 'com.example.largeplugin';
      // 创建一个较大的数据包（10KB）
      const largeData = Buffer.alloc(10240);
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      // 用户2监听插件数据
      let dataReceived = false;
      const dataPromise = new Promise<void>((resolve) => {
        client2.on('pluginData', (data: any) => {
          if (data.dataID === pluginId && data.data.length === largeData.length) {
            dataReceived = true;
            resolve();
          }
        });
      });

      // 用户1发送大数据
      await client1.sendPluginData(pluginId, largeData);

      // 等待接收
      await Promise.race([
        dataPromise,
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);

      expect(dataReceived).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
    });
  });

  describe('Context Actions', () => {
    it('should register context action', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      // 注册上下文操作
      await client.registerContextAction(
        'test_action',
        'Test Action',
        [1, 2, 4] // Server, Channel, User contexts
      );

      // 等待注册生效
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should execute context action', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      // 注册上下文操作
      await client.registerContextAction(
        'kick_user',
        'Kick User',
        [4] // User context
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // 执行上下文操作（对特定用户）
      const users = client.getUsers();
      if (users.length > 1) {
        await client.executeContextAction('kick_user', users[1].session);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should register multiple context actions', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      // 注册多个上下文操作
      const actions = [
        { action: 'action1', text: 'Action 1', contexts: [1] },
        { action: 'action2', text: 'Action 2', contexts: [2] },
        { action: 'action3', text: 'Action 3', contexts: [4] },
      ];

      for (const act of actions) {
        await client.registerContextAction(act.action, act.text, act.contexts);
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should execute context action on channel', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      // 注册频道上下文操作
      await client.registerContextAction(
        'rename_channel',
        'Rename Channel',
        [2] // Channel context
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // 执行频道操作
      const channels = client.getChannels();
      if (channels.length > 0) {
        await client.executeContextAction(
          'rename_channel',
          undefined,
          channels[0].channel_id
        );
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should handle context action with no parameters', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      // 注册服务器级上下文操作
      await client.registerContextAction(
        'server_info',
        'Server Info',
        [1] // Server context
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      // 执行服务器操作（不需要特定目标）
      await client.executeContextAction('server_info');
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });
  });

  describe('Combined Plugin Features', () => {
    it('should use context action and plugin data together', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await client2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      // 注册上下文操作
      await client1.registerContextAction(
        'send_notification',
        'Send Notification',
        [4] // User context
      );

      await new Promise(resolve => setTimeout(resolve, 100));

      const session2 = client2.getStateManager().getSession()?.session;

      // 监听插件数据
      let notificationReceived = false;
      const notificationPromise = new Promise<void>((resolve) => {
        client2.on('pluginData', (data: any) => {
          if (data.dataID === 'notification') {
            notificationReceived = true;
            resolve();
          }
        });
      });

      // 执行上下文操作并发送插件数据
      await client1.executeContextAction('send_notification', session2);
      await client1.sendPluginData(
        'notification',
        Buffer.from('Notification from admin'),
        [session2!]
      );

      await Promise.race([
        notificationPromise,
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);

      expect(notificationReceived).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
    });
  });
});
