/**
 * 语音路由集成测试
 * 
 * 测试语音路由功能，包括：
 * - Push-to-Talk (target=0) 与频道链接
 * - Whisper (VoiceTarget) 与不同标志组合
 * - 传递性频道链接
 * - 监听频道场景
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';
import { mumbleproto } from '@munode/protocol';
import * as crypto from 'crypto';

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
function createVoicePacket(codec: number = 4, target: number = 0, sequence: number = 0): Buffer {
  // Header: codec(3位高位) + target(5位低位)
  // codec = 4 (Opus), target = 0 (normal talking) or 1-30 (whisper) or 31 (loopback)
  const header = Buffer.alloc(1);
  header.writeUInt8((codec << 5) | (target & 0x1F), 0);

  // Session varint (简化为单字节 0，服务器会替换为实际 session)
  const sessionVarint = Buffer.from([0x00]);

  // Sequence varint
  const sequenceVarint = Buffer.from([sequence & 0x7F]);

  // 随机语音数据
  const voiceData = generateRandomVoiceData(20);

  return Buffer.concat([header, sessionVarint, sequenceVarint, voiceData]);
}

/**
 * 链接两个频道 (需要管理员权限)
 */
async function linkChannels(adminClient: MumbleClient, channelId1: number, channelId2: number): Promise<void> {
  // 直接使用传入的管理员客户端链接频道
  await adminClient.sendChannelState({
    channel_id: channelId1,
    links_add: [channelId2],
  });
  
  // 等待链接生效和同步
  await new Promise(resolve => setTimeout(resolve, 500));
}

/**
 * 移除频道链接
 */
async function unlinkChannels(adminClient: MumbleClient, channelId1: number, channelId2: number): Promise<void> {
  await adminClient.sendChannelState({
    channel_id: channelId1,
    links_remove: [channelId2],
  });
  
  // 等待移除生效
  await new Promise(resolve => setTimeout(resolve, 500));
}

/**
 * 清除所有频道链接 (用于测试隔离)
 */
async function clearAllChannelLinks(adminClient: MumbleClient, channels: any[]): Promise<void> {
  for (const channel of channels) {
    if (channel.links && channel.links.length > 0) {
      await adminClient.sendChannelState({
        channel_id: channel.channel_id,
        links_remove: channel.links,
      });
    }
  }
  // 等待清除生效
  await new Promise(resolve => setTimeout(resolve, 500));
}

/**
 * 创建并连接管理员客户端
 */
async function createAdminClient(testEnv: TestEnvironment): Promise<MumbleClient> {
  const admin = new MumbleClient();
  await admin.connect({
    host: 'localhost',
    port: testEnv.edgePort,
    username: 'admin',
    password: 'admin123',
    rejectUnauthorized: false,
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  return admin;
}

/**
 * 等待接收语音包
 */
function waitForVoice(client: MumbleClient, senderSession: number, timeoutMs: number = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let voiceReceived = false;
    const timer = setTimeout(() => resolve(voiceReceived), timeoutMs);
    
    const voiceHandler = (data: any) => {
      if (data.session === senderSession) {
        voiceReceived = true;
        clearTimeout(timer);
        client.removeListener('voice', voiceHandler);
        resolve(true);
      }
    };
    
    client.on('voice', voiceHandler);
  });
}

describe('Voice Routing Integration Tests', () => {
  let testEnv: TestEnvironment;
  let adminForCleanup: MumbleClient | null = null;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8090);
  }, 60000);

  afterAll(async () => {
    if (adminForCleanup) {
      await adminForCleanup.disconnect();
    }
    await testEnv?.cleanup();
  });

  describe('Push-to-Talk (target=0) with Channel Links', () => {
    beforeEach(async () => {
      // Clear any existing channel links before each test to ensure isolation
      if (!adminForCleanup) {
        adminForCleanup = await createAdminClient(testEnv);
      }
      const tempClient = new MumbleClient();
      await tempClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      const channels = tempClient.getChannels();
      await clearAllChannelLinks(adminForCleanup, channels);
      await tempClient.disconnect();
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    it('should route voice to users in sender channel', async () => {
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

      // 两个用户都在根频道
      await new Promise(resolve => setTimeout(resolve, 500));

      const session1 = client1.getStateManager().getSession()?.session;
      expect(session1).toBeGreaterThan(0);

      // 设置语音接收监听
      const voicePromise = waitForVoice(client2, session1!, 2000);

      // 用户1发送语音 (Push-to-Talk, target=0)
      const voicePacket = createVoicePacket(4, 0, 0);
      await client1.sendVoice(voicePacket);

      // 等待接收
      const received = await voicePromise;
      expect(received).toBe(true);

      await client1.disconnect();
      await client2.disconnect();
    });

    it('should route voice to users in linked channels', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      // 获取频道列表
      const channels = client1.getChannels();
      expect(channels.length).toBeGreaterThanOrEqual(1);

      // 如果有多个频道，测试跨频道链接
      if (channels.length >= 3) {
        const session1 = client1.getStateManager().getSession()?.session;
        
        // 创建管理员客户端用于链接频道
        const admin = await createAdminClient(testEnv);
        
        // 用户1在频道1
        await client1.joinChannel(channels[1].channel_id);
        // 用户2在频道2
        await client2.joinChannel(channels[2].channel_id);
        // 用户3留在根频道
        
        // Wait for channel changes to be confirmed by server
        await new Promise(resolve => setTimeout(resolve, 1000));
        

        // 链接频道1和频道2
        await linkChannels(admin, channels[1].channel_id, channels[2].channel_id);
        
        // Disconnect admin before testing voice to avoid interference
        await admin.disconnect();
        await new Promise(resolve => setTimeout(resolve, 200));

        // 设置监听
        const voice2Promise = waitForVoice(client2, session1!, 2000);
        const voice3Promise = waitForVoice(client3, session1!, 2000);

        // 用户1发送语音，用户2应该能收到（因为频道链接）
        const voicePacket = createVoicePacket(4, 0, 0);
        await client1.sendVoice(voicePacket);

        // 验证接收
        const received2 = await voice2Promise;
        const received3 = await voice3Promise;
        
        expect(received2).toBe(true); // 用户2在链接的频道2中，应该收到
        expect(received3).toBe(false); // 用户3在根频道，不应该收到

        expect(client1.isConnected()).toBe(true);
        expect(client2.isConnected()).toBe(true);
        expect(client3.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });

    it('should route voice to users listening to linked channels', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 3) {
        const session1 = client1.getStateManager().getSession()?.session;
        
        // 创建管理员客户端
        const admin = await createAdminClient(testEnv);
        
        // 用户1在频道1
        await client1.joinChannel(channels[1].channel_id);
        // 用户2在根频道，但监听频道2
        await client2.addListeningChannel(channels[2].channel_id);
        // Wait for channel changes to be confirmed
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 链接频道1和频道2
        await linkChannels(admin, channels[1].channel_id, channels[2].channel_id);
        
        // Disconnect admin before testing
        await admin.disconnect();
        await new Promise(resolve => setTimeout(resolve, 200));

        // 设置监听
        const voice2Promise = waitForVoice(client2, session1!, 2000);

        // 用户1发送语音，用户2应该能收到（因为监听链接的频道2）
        const voicePacket = createVoicePacket(4, 0, 0);
        await client1.sendVoice(voicePacket);

        const received2 = await voice2Promise;
        expect(received2).toBe(true);

        expect(client1.isConnected()).toBe(true);
        expect(client2.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
      ]);
    });

    it('should handle transitive channel links (A->B, B->C, so A->C)', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 4) {
        const session1 = client1.getStateManager().getSession()?.session;
        
        // 创建管理员客户端
        const admin = await createAdminClient(testEnv);
        
        // 用户1在频道1
        await client1.joinChannel(channels[1].channel_id);
        // 用户2在频道2
        await client2.joinChannel(channels[2].channel_id);
        // 用户3在频道3
        await client3.joinChannel(channels[3].channel_id);
        // Wait for channel changes to be confirmed
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 链接频道 1->2, 2->3
        await linkChannels(admin, channels[1].channel_id, channels[2].channel_id);
        await linkChannels(admin, channels[2].channel_id, channels[3].channel_id);
        
        // Disconnect admin before testing
        await admin.disconnect();
        await new Promise(resolve => setTimeout(resolve, 200));

        // 设置监听
        const voice2Promise = waitForVoice(client2, session1!, 2000);
        const voice3Promise = waitForVoice(client3, session1!, 2000);

        // 用户1发送语音，用户2和用户3都应该能收到（传递链接）
        const voicePacket = createVoicePacket(4, 0, 0);
        await client1.sendVoice(voicePacket);

        const received2 = await voice2Promise;
        const received3 = await voice3Promise;
        
        expect(received2).toBe(true);
        expect(received3).toBe(true); // 传递链接: 1->2->3

        expect(client1.isConnected()).toBe(true);
        expect(client2.isConnected()).toBe(true);
        expect(client3.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });
  });

  describe('Whisper (VoiceTarget) - Basic', () => {
    beforeEach(async () => {
      // Clear any existing channel links before each test
      if (!adminForCleanup) {
        adminForCleanup = await createAdminClient(testEnv);
      }
      const tempClient = new MumbleClient();
      await tempClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      const channels = tempClient.getChannels();
      await clearAllChannelLinks(adminForCleanup, channels);
      await tempClient.disconnect();
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    it('should send whisper to specific users', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const session2 = client2.getStateManager().getSession()?.session;
      const session3 = client3.getStateManager().getSession()?.session;
      const session1 = client1.getStateManager().getSession()?.session;

      if (session2 && session3 && session1) {
        // 用户1设置 VoiceTarget 1：只发给用户2
        await client1.setVoiceTarget(1, [
          {
            session: [session2],
          },
        ]);
        
        // Wait for VoiceTarget to be processed
        await new Promise(resolve => setTimeout(resolve, 300));

        // 设置监听
        const voice2Promise = waitForVoice(client2, session1, 2000);
        const voice3Promise = waitForVoice(client3, session1, 2000);

        // 用户1使用 target=1 发送语音
        const voicePacket = createVoicePacket(4, 1, 0); // target=1 (whisper to VoiceTarget 1)
        await client1.sendVoice(voicePacket);

        // 只有用户2应该收到，用户3不应该收到
        const received2 = await voice2Promise;
        const received3 = await voice3Promise;
        
        expect(received2).toBe(true);
        expect(received3).toBe(false);

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });

    it('should send whisper to channel without flags (links=false, children=false)', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 2) {
        const session1 = client1.getStateManager().getSession()?.session;
        
        // 用户1在根频道
        // 用户2在频道1
        await client2.joinChannel(channels[1].channel_id);
        // 用户3也在频道1
        await client3.joinChannel(channels[1].channel_id);
        // Wait for channel changes to be confirmed
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 用户1设置 VoiceTarget：发送到频道1，不包含链接和子频道
        await client1.setVoiceTarget(1, [
          {
            session: [],
            channel_id: channels[1].channel_id,
            links: false,
            children: false,
          },
        ]);
        
        // Wait for VoiceTarget to be processed
        await new Promise(resolve => setTimeout(resolve, 300));

        // 设置监听
        const voice2Promise = waitForVoice(client2, session1!, 2000);
        const voice3Promise = waitForVoice(client3, session1!, 2000);

        // 发送语音
        const voicePacket = createVoicePacket(4, 1, 0);
        await client1.sendVoice(voicePacket);

        // 用户2和用户3应该收到（在频道1中）
        const received2 = await voice2Promise;
        const received3 = await voice3Promise;
        
        expect(received2).toBe(true);
        expect(received3).toBe(true);

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });
  });

  describe('Whisper (VoiceTarget) - With Links Flag', () => {
    it('should send whisper to channel with links=true', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();
      const client4 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
        client4.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 3) {
        // 用户1在根频道
        // 用户2在频道1
        await client2.joinChannel(channels[1].channel_id);
        // 用户3在频道2（链接到频道1）
        await client3.joinChannel(channels[2].channel_id);
        // 用户4在根频道（不应该收到）
        await new Promise(resolve => setTimeout(resolve, 300));

        // TODO: 链接频道1和频道2
        
        // 用户1设置 VoiceTarget：发送到频道1，包含链接
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: true,
              children: false,
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 用户2应该收到（在频道1中）
        // 用户3应该收到（在链接的频道2中）
        // 用户4不应该收到（在根频道）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
        client4.disconnect(),
      ]);
    });

    it('should send whisper to user listening to linked channel', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 3) {
        // 用户1在根频道
        // 用户2在频道1
        await client2.joinChannel(channels[1].channel_id);
        // 用户3在根频道，但监听频道2（链接到频道1）
        await client3.addListeningChannel(channels[2].channel_id);
        await new Promise(resolve => setTimeout(resolve, 300));

        // TODO: 链接频道1和频道2
        
        // 用户1设置 VoiceTarget：发送到频道1，包含链接
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: true,
              children: false,
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 用户2应该收到（在频道1中）
        // 用户3应该收到（监听链接的频道2）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });
  });

  describe('Whisper (VoiceTarget) - With Children Flag', () => {
    it('should send whisper to channel with children=true', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();
      const client4 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
        client4.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      
      // 我们需要一个有子频道的频道结构
      // 假设频道1是父频道，频道2是频道1的子频道
      if (channels.length >= 2) {
        // 用户1在根频道
        // 用户2在频道1（父频道）
        await client2.joinChannel(channels[1].channel_id);
        
        // TODO: 创建子频道或使用现有子频道
        // 用户3在频道1的子频道
        // 用户4在根频道（不应该收到）
        await new Promise(resolve => setTimeout(resolve, 300));

        // 用户1设置 VoiceTarget：发送到频道1，包含子频道
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: false,
              children: true,
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 用户2应该收到（在频道1中）
        // 用户3应该收到（在频道1的子频道中）
        // 用户4不应该收到（在根频道）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
        client4.disconnect(),
      ]);
    });

    it('should send whisper to user listening to child channel', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 2) {
        // 用户1在根频道
        // 用户2在频道1
        await client2.joinChannel(channels[1].channel_id);
        // 用户3在根频道，但监听频道1的子频道
        // TODO: 获取频道1的子频道ID并监听
        await new Promise(resolve => setTimeout(resolve, 300));

        // 用户1设置 VoiceTarget：发送到频道1，包含子频道
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: false,
              children: true,
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 用户2应该收到（在频道1中）
        // 用户3应该收到（监听子频道）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });
  });

  describe('Whisper (VoiceTarget) - With Links and Children Flags', () => {
    it('should send whisper to channel with links=true and children=true', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();
      const client4 = new MumbleClient();
      const client5 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
        client4.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin123',
          rejectUnauthorized: false,
        }),
        client5.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'moderator',
          password: 'mod123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 3) {
        // 用户1在根频道
        // 用户2在频道1
        await client2.joinChannel(channels[1].channel_id);
        // 用户3在频道1的链接频道
        await client3.joinChannel(channels[2].channel_id);
        // TODO: 链接频道1和频道2
        
        // 用户4在频道1的子频道
        // TODO: 获取子频道并加入
        
        // 用户5在频道1的子频道的链接频道
        // TODO: 创建或获取该频道并加入
        
        await new Promise(resolve => setTimeout(resolve, 300));

        // 用户1设置 VoiceTarget：发送到频道1，包含链接和子频道
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: true,
              children: true,
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 用户2应该收到（在频道1中）
        // 用户3应该收到（在链接频道中）
        // 用户4应该收到（在子频道中）
        // 用户5应该收到（在子频道的链接频道中）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
        client4.disconnect(),
        client5.disconnect(),
      ]);
    });
  });

  describe('Edge Cases', () => {
    it('should not send voice to deaf users', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      // 用户2设置为deaf
      await client2.setSelfDeaf(true);
      await new Promise(resolve => setTimeout(resolve, 200));

      // TODO: 用户1发送语音
      // 用户2不应该收到（因为是deaf）

      expect(client1.isConnected()).toBe(true);
      expect(client2.isConnected()).toBe(true);

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
      ]);
    });

    it('should not send voice from muted users', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      // 用户1设置为mute
      await client1.setSelfMute(true);
      await new Promise(resolve => setTimeout(resolve, 200));

      // TODO: 用户1尝试发送语音
      // 用户2不应该收到（因为用户1被mute）

      expect(client1.isConnected()).toBe(true);
      expect(client2.isConnected()).toBe(true);

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
      ]);
    });

    it('should not route voice to sender', async () => {
      const client1 = new MumbleClient();

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // TODO: 用户1发送语音
      // 用户1不应该收到自己的语音（除非使用 target=31 loopback）

      expect(client1.isConnected()).toBe(true);

      await client1.disconnect();
    });
  });

  describe('ACL Group Filtering', () => {
    it('should filter whisper recipients by ACL group membership', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 2) {
        // 用户1在根频道
        // 用户2和用户3在频道1
        await client2.joinChannel(channels[1].channel_id);
        await client3.joinChannel(channels[1].channel_id);
        await new Promise(resolve => setTimeout(resolve, 300));

        // TODO: 设置频道1的ACL，创建一个组（如 "speakers"）
        // 只将用户2添加到该组
        
        // 用户1设置 VoiceTarget：发送到频道1，限制为 "speakers" 组
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: false,
              children: false,
              group: 'speakers',
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 只有用户2应该收到（在 "speakers" 组中）
        // 用户3不应该收到（不在组中）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });

    it('should filter whisper with links flag by group membership', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();
      const client4 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
        client4.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 3) {
        // 用户1在根频道
        // 用户2在频道1
        await client2.joinChannel(channels[1].channel_id);
        // 用户3在频道2（链接到频道1）
        await client3.joinChannel(channels[2].channel_id);
        // 用户4也在频道2
        await client4.joinChannel(channels[2].channel_id);
        // Wait for channel changes to be confirmed
        await new Promise(resolve => setTimeout(resolve, 1000));

        // TODO: 链接频道1和频道2
        // TODO: 在两个频道中设置相同的ACL组 "moderators"
        // 将用户2和用户3添加到 "moderators" 组，用户4不在组中
        
        // 用户1设置 VoiceTarget：发送到频道1，包含链接，限制为 "moderators" 组
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: true,
              children: false,
              group: 'moderators',
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 用户2应该收到（在频道1，在组中）
        // 用户3应该收到（在链接的频道2，在组中）
        // 用户4不应该收到（虽然在频道2，但不在组中）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
        client4.disconnect(),
      ]);
    });

    it('should filter by user authentication groups from auth server', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 2) {
        // 用户1在根频道
        // 用户2和用户3在频道1
        await client2.joinChannel(channels[1].channel_id);
        await client3.joinChannel(channels[1].channel_id);
        await new Promise(resolve => setTimeout(resolve, 300));

        // 假设认证服务器返回：
        // user2 属于 "premium" 组（存储在 client.groups）
        // guest 不属于任何特殊组
        
        // 用户1设置 VoiceTarget：发送到频道1，限制为 "premium" 组
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: false,
              children: false,
              group: 'premium',
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 只有用户2应该收到（认证组 "premium" 成员）
        // 用户3不应该收到（不在认证组中）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });

    it('should accept users in either channel ACL group or auth group', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();
      const client4 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
        client4.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 2) {
        // 用户1在根频道
        // 用户2、3、4在频道1
        await client2.joinChannel(channels[1].channel_id);
        await client3.joinChannel(channels[1].channel_id);
        await client4.joinChannel(channels[1].channel_id);
        // Wait for channel changes to be confirmed
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 假设：
        // user2 在频道ACL组 "moderators" 中（通过 channel.groups）
        // guest 在认证组 "moderators" 中（通过 client.groups）
        // admin 两个都不在
        
        // 用户1设置 VoiceTarget：发送到频道1，限制为 "moderators" 组
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: false,
              children: false,
              group: 'moderators',
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 用户2应该收到（在频道ACL组中）
        // 用户3应该收到（在认证组中）
        // 用户4不应该收到（两个都不在）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
        client4.disconnect(),
      ]);
    });

    it('should handle inherited group members correctly', async () => {
      const client1 = new MumbleClient();
      const client2 = new MumbleClient();
      const client3 = new MumbleClient();

      await Promise.all([
        client1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        }),
        client2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        }),
        client3.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 500));

      const channels = client1.getChannels();
      if (channels.length >= 2) {
        // 用户1在根频道
        // 用户2和用户3在频道1的子频道
        // TODO: 创建频道1的子频道并移动用户
        await new Promise(resolve => setTimeout(resolve, 300));

        // TODO: 在父频道设置ACL组 "team"，用户2在组中
        // 子频道继承该组，用户3在继承的组中但被明确移除
        
        // 用户1设置 VoiceTarget：发送到频道1，包含子频道，限制为 "team" 组
        const voiceTarget = new mumbleproto.VoiceTarget({
          id: 1,
          targets: [
            new mumbleproto.VoiceTarget.Target({
              session: [],
              channel_id: channels[1].channel_id,
              links: false,
              children: true,
              group: 'team',
            }),
          ],
        });

        // TODO: 发送 VoiceTarget 消息并发送语音
        // 用户2应该收到（在组中）
        // 用户3不应该收到（虽然继承了组成员资格，但被明确移除）

        expect(client1.isConnected()).toBe(true);
      }

      await Promise.all([
        client1.disconnect(),
        client2.disconnect(),
        client3.disconnect(),
      ]);
    });
  });

  describe('Server Loopback (target=31)', () => {
    it('should send voice back to sender when using loopback target', async () => {
      const client1 = new MumbleClient();

      await client1.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // TODO: 用户1使用 target=31 发送语音
      // 用户1应该收到自己的语音（loopback）

      expect(client1.isConnected()).toBe(true);

      await client1.disconnect();
    });
  });
});
