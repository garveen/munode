/**
 * 语音功能集成测试（合并版）
 * 
 * 测试语音包的路由、转发和传输功能，包括：
 * - 同一 Edge 和跨 Edge 的语音广播
 * - Push-to-Talk (target=0) 与频道链接
 * - Whisper (VoiceTarget) 与不同标志组合
 * - ACL 组过滤
 * - Loopback 和特殊场景
 * 
 * 测试策略：
 * - 每个测试同时验证本地 Edge 和跨 Edge 的场景
 * - 每个测试验证不应接收语音的客户端（不同频道、deaf 用户等）
 * - 如果测试账号不足，自动创建
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import * as crypto from 'crypto';

/**
 * Voice event data structure
 */
interface VoiceData {
  session: number;
  codec: number;
  target: number;
  sequence: number;
  data: Buffer;
}

/**
 * Channel structure for tests
 */
interface ChannelInfo {
  channel_id: number;
  name: string;
  parent?: number;
  links?: number[];
  description?: string;
  position?: number;
  temporary?: boolean;
}

/**
 * 生成随机语音数据用于测试
 */
function generateRandomVoiceData(size: number = 20): Buffer {
  return crypto.randomBytes(size);
}

/**
 * 创建 Opus 语音包（客户端格式）
 * 客户端发送格式: [header(1字节)][sequence_varint][voice_data]
 * 注意：客户端发送时不包含 session，服务器转发时才会添加 session
 */
function createVoicePacket(codec: number = 4, target: number = 0, sequence: number = 0): Buffer {
  const header = Buffer.alloc(1);
  header.writeUInt8((codec << 5) | (target & 0x1F), 0);
  const sequenceVarint = Buffer.from([sequence & 0x7F]);
  const voiceData = generateRandomVoiceData(20);
  return Buffer.concat([header, sequenceVarint, voiceData]);
}

/**
 * 链接两个频道
 */
async function linkChannels(adminClient: MumbleClient, channelId1: number, channelId2: number): Promise<void> {
  console.log(`[TEST] Calling linkChannels: ${channelId1} -> ${channelId2}`);
  await adminClient.sendChannelState({
    channel_id: channelId1,
    links_add: [channelId2],
  });
  console.log(`[TEST] linkChannels sent, waiting for sync...`);
  // 等待链接广播到所有 Edge（增加到 2 秒确保完全同步）
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log(`[TEST] linkChannels wait completed`);
}

/**
 * 移除频道链接
 */
async function unlinkChannels(adminClient: MumbleClient, channelId1: number, channelId2: number): Promise<void> {
  await adminClient.sendChannelState({
    channel_id: channelId1,
    links_remove: [channelId2],
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
}

/**
 * 清除所有频道链接
 */
async function clearAllChannelLinks(adminClient: MumbleClient, channels: ChannelInfo[]): Promise<void> {
  for (const channel of channels) {
    if (channel.links && channel.links.length > 0) {
      await adminClient.sendChannelState({
        channel_id: channel.channel_id,
        links_remove: channel.links,
      });
    }
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}

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
    
    const voiceHandler = (data: VoiceData) => {
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
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    // Use index to preserve order
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

describe('Voice Integration Tests', () => {
  let testEnv: TestEnvironment;
  let adminForCleanup: MumbleClient | null = null;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8089, { silent: false }); // 启用日志输出用于调试
  }, 60000);

  afterAll(async () => {
    if (adminForCleanup) {
      await adminForCleanup.disconnect();
    }
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
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

  describe('Basic Voice Broadcasting (target=0)', () => {
    it('should broadcast voice within same channel to same edge and cross edge users, but not to other channels', async () => {
      // 测试配置：
      // - sender: Edge 1, Channel 0 (Root)
      // - receiver_edge1_same: Edge 1, Channel 0 - 应该接收
      // - receiver_edge2_same: Edge 2, Channel 0 - 应该接收（跨 Edge）
      // - receiver_edge1_other: Edge 1, Channel 1 - 不应接收（不同频道）
      // - receiver_edge2_other: Edge 2, Channel 1 - 不应接收（跨 Edge + 不同频道）
      
      const clients = await createClients(testEnv, [
        { username: 'voice_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'voice_recv_e1_same', password: 'pass2', edge: 1, channelId: 0 },
        { username: 'voice_recv_e2_same', password: 'pass3', edge: 2, channelId: 0 },
        { username: 'voice_recv_e1_other', password: 'pass4', edge: 1, channelId: 1 },
        { username: 'voice_recv_e2_other', password: 'pass5', edge: 2, channelId: 1 },
      ]);
      
      const [sender, recvE1Same, recvE2Same, recvE1Other, recvE2Other] = clients;
      
      // 设置语音监听器
      const receivedVoice = {
        recvE1Same: false,
        recvE2Same: false,
        recvE1Other: false,
        recvE2Other: false,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      recvE1Same.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Same = true;
      });
      
      recvE2Same.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE2Same = true;
      });
      
      recvE1Other.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Other = true;
      });
      
      recvE2Other.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE2Other = true;
      });
      
      // 发送语音包
      await new Promise(resolve => setTimeout(resolve, 1000));
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      // 等待语音包到达
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 验证结果
      expect(receivedVoice.recvE1Same).toBe(true); // 同 Edge 同频道应该收到
      expect(receivedVoice.recvE2Same).toBe(true); // 跨 Edge 同频道应该收到
      expect(receivedVoice.recvE1Other).toBe(false); // 同 Edge 不同频道不应收到
      expect(receivedVoice.recvE2Other).toBe(false); // 跨 Edge 不同频道不应收到
      
      await cleanupClients(clients);
    });

    it('should not send voice to deaf users on same or cross edge', async () => {
      // 测试 deaf 用户不接收语音
      const clients = await createClients(testEnv, [
        { username: 'voice_sender2', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'voice_deaf_e1', password: 'pass2', edge: 1, channelId: 0 },
        { username: 'voice_deaf_e2', password: 'pass3', edge: 2, channelId: 0 },
        { username: 'voice_normal_e1', password: 'pass4', edge: 1, channelId: 0 },
      ]);
      
      const [sender, deafE1, deafE2, normalE1] = clients;
      
      // 设置 deaf 状态
      await deafE1.sendUserState({ self_deaf: true });
      await deafE2.sendUserState({ self_deaf: true });
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const receivedVoice = {
        deafE1: false,
        deafE2: false,
        normalE1: false,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      deafE1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.deafE1 = true;
      });
      
      deafE2.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.deafE2 = true;
      });
      
      normalE1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.normalE1 = true;
      });
      
      // 发送语音包
      await new Promise(resolve => setTimeout(resolve, 1000));
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 验证：deaf 用户不应收到，normal 用户应该收到
      expect(receivedVoice.deafE1).toBe(false);
      expect(receivedVoice.deafE2).toBe(false);
      expect(receivedVoice.normalE1).toBe(true);
      
      await cleanupClients(clients);
    });
  });

  describe('Channel Linking', () => {
    it('should broadcast voice to linked channels on same and cross edge, but not unlinked channels', async () => {
      // 测试频道链接
      // Channel 0 (Root) 链接到 Channel 1
      // - sender: Edge 1, Channel 0
      // - recv_e1_ch0: Edge 1, Channel 0 - 应该收到
      // - recv_e2_ch0: Edge 2, Channel 0 - 应该收到（跨 Edge）
      // - recv_e1_ch1: Edge 1, Channel 1 - 应该收到（链接）
      // - recv_e2_ch1: Edge 2, Channel 1 - 应该收到（跨 Edge + 链接）
      // - recv_e1_ch2: Edge 1, Channel 2 - 不应收到（未链接）
      
      const admin = await createAdminClient(testEnv);
      await linkChannels(admin, 0, 1);
      
      const clients = await createClients(testEnv, [
        { username: 'voice_sender3', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'voice_recv_e1_ch0', password: 'pass2', edge: 1, channelId: 0 },
        { username: 'voice_recv_e2_ch0', password: 'pass3', edge: 2, channelId: 0 },
        { username: 'voice_recv_e1_ch1', password: 'pass4', edge: 1, channelId: 1 },
        { username: 'voice_recv_e2_ch1', password: 'pass5', edge: 2, channelId: 1 },
        { username: 'voice_recv_e1_ch2', password: 'pass6', edge: 1, channelId: 2 },
      ]);
      
      // 等待所有客户端完全初始化并接收频道链接信息（增加到 1.5 秒）
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const [sender, recvE1Ch0, recvE2Ch0, recvE1Ch1, recvE2Ch1, recvE1Ch2] = clients;
      
      // 验证频道链接是否正确同步
      const channelsE1 = sender.getChannels();
      const channelsE2 = recvE2Ch0.getChannels();
      const ch0E1 = channelsE1.find((ch: ChannelInfo) => ch.channel_id === 0);
      const ch0E2 = channelsE2.find((ch: ChannelInfo) => ch.channel_id === 0);
      
      console.log(`[TEST-DEBUG] Edge 1 Channel 0 links: [${(ch0E1?.links || []).join(', ')}]`);
      console.log(`[TEST-DEBUG] Edge 2 Channel 0 links: [${(ch0E2?.links || []).join(', ')}]`);
      
      // 断言：确保链接已同步
      expect(ch0E1?.links).toContain(1);
      expect(ch0E2?.links).toContain(1);
      
      const receivedVoice = {
        recvE1Ch0: false,
        recvE2Ch0: false,
        recvE1Ch1: false,
        recvE2Ch1: false,
        recvE1Ch2: false,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      recvE1Ch0.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Ch0 = true;
      });
      recvE2Ch0.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE2Ch0 = true;
      });
      recvE1Ch1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Ch1 = true;
      });
      recvE2Ch1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE2Ch1 = true;
      });
      recvE1Ch2.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Ch2 = true;
      });
      
      // UDP 连接已在 createClients 中确认就绪，等待监听器设置完成
      await new Promise(resolve => setTimeout(resolve, 500));
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 验证
      expect(receivedVoice.recvE1Ch0).toBe(true); // 同频道同 Edge
      expect(receivedVoice.recvE2Ch0).toBe(true); // 同频道跨 Edge
      expect(receivedVoice.recvE1Ch1).toBe(true); // 链接频道同 Edge
      expect(receivedVoice.recvE2Ch1).toBe(true); // 链接频道跨 Edge
      expect(receivedVoice.recvE1Ch2).toBe(false); // 未链接频道
      
      await unlinkChannels(admin, 0, 1);
      await cleanupClients(clients);
      await admin.disconnect();
    });
  });

  describe('Voice Target (Whisper)', () => {
    it('should send voice 1 to targeted users on same and cross edge', async () => {
      // 测试 VoiceTarget (target=1)
      // - sender 创建 VoiceTarget 指向 target1_e1 和 target1_e2
      // - target1_e1: Edge 1 - 应该收到
      // - target1_e2: Edge 2 - 应该收到（跨 Edge）
      // - non_target_e1: Edge 1, 同频道 - 不应收到
      // - non_target_e2: Edge 2, 同频道 - 不应收到
      
      const clients = await createClients(testEnv, [
        { username: 'voice_whisper_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'voice_target1_e1', password: 'pass2', edge: 1, channelId: 0 },
        { username: 'voice_target1_e2', password: 'pass3', edge: 2, channelId: 0 },
        { username: 'voice_non_target_e1', password: 'pass4', edge: 1, channelId: 0 },
        { username: 'voice_non_target_e2', password: 'pass5', edge: 2, channelId: 0 },
      ]);
      
      const [sender, target1E1, target1E2, nonTargetE1, nonTargetE2] = clients;
      
      // 创建 VoiceTarget
      await sender.setVoiceTarget(1, [
        { session: [target1E1.getStateManager().getSession()?.session || 0, target1E2.getStateManager().getSession()?.session || 0] },
      ]);
      // 等待 VoiceTarget 同步到所有 Edge（增加到 2 秒）
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const receivedVoice = {
        target1E1: false,
        target1E2: false,
        nonTargetE1: false,
        nonTargetE2: false,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      target1E1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.target1E1 = true;
      });
      target1E2.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.target1E2 = true;
      });
      nonTargetE1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.nonTargetE1 = true;
      });
      nonTargetE2.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.nonTargetE2 = true;
      });
      
      // 等待监听器设置完成
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 发送 whisper 语音包 (target=1)
      const voicePacket = createVoicePacket(4, 1, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      // 等待语音包跨 Edge 传输（增加到 2 秒）
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 验证：只有 target 用户收到
      expect(receivedVoice.target1E1).toBe(true);
      expect(receivedVoice.target1E2).toBe(true);
      expect(receivedVoice.nonTargetE1).toBe(false);
      expect(receivedVoice.nonTargetE2).toBe(false);
      
      await cleanupClients(clients);
    });

    it('should send voice to channel targets on same and cross edge', async () => {
      // 测试 VoiceTarget 指向频道
      // - sender: Channel 0
      // - VoiceTarget 指向 Channel 1
      // - recv_e1_ch1: Edge 1, Channel 1 - 应该收到
      // - recv_e2_ch1: Edge 2, Channel 1 - 应该收到
      // - recv_e1_ch0: Edge 1, Channel 0 - 不应收到（虽然同频道，但用 whisper）
      // - recv_e1_ch2: Edge 1, Channel 2 - 不应收到
      
      const clients = await createClients(testEnv, [
        { username: 'voice_ch_target_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'voice_recv_e1_tch1', password: 'pass2', edge: 1, channelId: 1 },
        { username: 'voice_recv_e2_tch1', password: 'pass3', edge: 2, channelId: 1 },
        { username: 'voice_recv_e1_tch0', password: 'pass4', edge: 1, channelId: 0 },
        { username: 'voice_recv_e1_tch2', password: 'pass5', edge: 1, channelId: 2 },
      ]);
      
      const [sender, recvE1Ch1, recvE2Ch1, recvE1Ch0, recvE1Ch2] = clients;
      
      // 创建频道 VoiceTarget
      await sender.setVoiceTarget(2, [
        { channel_id: 1 },
      ]);
      // 等待 VoiceTarget 同步到所有 Edge（增加到 2 秒）
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const receivedVoice = {
        recvE1Ch1: false,
        recvE2Ch1: false,
        recvE1Ch0: false,
        recvE1Ch2: false,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      recvE1Ch1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Ch1 = true;
      });
      recvE2Ch1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE2Ch1 = true;
      });
      recvE1Ch0.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Ch0 = true;
      });
      recvE1Ch2.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Ch2 = true;
      });
      
      // 等待监听器设置完成
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 发送 whisper 到 target=2
      const voicePacket = createVoicePacket(4, 2, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      // 等待语音包跨 Edge 传输（增加到 2 秒）
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 验证
      expect(receivedVoice.recvE1Ch1).toBe(true);
      expect(receivedVoice.recvE2Ch1).toBe(true);
      expect(receivedVoice.recvE1Ch0).toBe(false); // whisper 不发给自己频道
      expect(receivedVoice.recvE1Ch2).toBe(false);
      
      await cleanupClients(clients);
    });
  });

  describe('Loopback', () => {
    it('should send voice back to sender when using loopback target (31)', async () => {
      // 测试 loopback (target=31)
      const clients = await createClients(testEnv, [
        { username: 'voice_loopback_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'voice_loopback_other', password: 'pass2', edge: 1, channelId: 0 },
      ]);
      
      const [sender, other] = clients;
      
      const receivedVoice = {
        sender: false,
        other: false,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      sender.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.sender = true;
      });
      
      other.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.other = true;
      });
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 发送 loopback 语音包
      const voicePacket = createVoicePacket(4, 31, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 验证：只有发送者自己收到
      expect(receivedVoice.sender).toBe(true);
      expect(receivedVoice.other).toBe(false);
      
      await cleanupClients(clients);
    });
  });

  describe('Multiple Voice Packets', () => {
    it('should handle multiple voice packets to same and cross edge receivers', async () => {
      // 测试多个语音包的传输
      const clients = await createClients(testEnv, [
        { username: 'voice_multi_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'voice_multi_recv_e1', password: 'pass2', edge: 1, channelId: 0 },
        { username: 'voice_multi_recv_e2', password: 'pass3', edge: 2, channelId: 0 },
      ]);
      
      const [sender, recvE1, recvE2] = clients;
      
      const receivedCount = {
        recvE1: 0,
        recvE2: 0,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      recvE1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedCount.recvE1++;
      });
      
      recvE2.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedCount.recvE2++;
      });
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 发送 5 个语音包
      for (let i = 0; i < 5; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 验证：两个接收者都应该收到 5 个包
      expect(receivedCount.recvE1).toBe(5);
      expect(receivedCount.recvE2).toBe(5);
      
      await cleanupClients(clients);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle mixed scenario: channel links + whisper + deaf users across edges', async () => {
      // 复杂场景：
      // - Channel 0 链接到 Channel 1
      // - sender: Edge 1, Channel 0
      // - VoiceTarget 3 指向 whisper_target_e2
      // - recv_e1_ch0: Edge 1, Channel 0 - 应该收到（normal push-to-talk）
      // - recv_e2_ch1: Edge 2, Channel 1 - 应该收到（链接 + 跨 Edge）
      // - whisper_target_e2: Edge 2, Channel 2 - 应该收到（whisper 目标）
      // - deaf_e1_ch0: Edge 1, Channel 0, deaf - 不应收到
      // - normal_e1_ch2: Edge 1, Channel 2 - 不应收到（未链接，非 whisper 目标）
      
      const admin = await createAdminClient(testEnv);
      await linkChannels(admin, 0, 1);
      
      const clients = await createClients(testEnv, [
        { username: 'voice_complex_sender', password: 'pass1', edge: 1, channelId: 0 },
        { username: 'voice_complex_e1_ch0', password: 'pass2', edge: 1, channelId: 0 },
        { username: 'voice_complex_e2_ch1', password: 'pass3', edge: 2, channelId: 1 },
        { username: 'voice_whisper_tgt_e2', password: 'pass4', edge: 2, channelId: 2 },
        { username: 'voice_deaf_e1_ch0', password: 'pass5', edge: 1, channelId: 0 },
        { username: 'voice_normal_e1_ch2', password: 'pass6', edge: 1, channelId: 2 },
      ]);
      
      const [sender, recvE1Ch0, recvE2Ch1, whisperTargetE2, deafE1Ch0, normalE1Ch2] = clients;
      
      // 设置 deaf
      await deafE1Ch0.sendUserState({ self_deaf: true });
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // 创建 VoiceTarget
      await sender.setVoiceTarget(3, [
        { session: [whisperTargetE2.getStateManager().getSession()?.session || 0] },
      ]);
      // 等待 VoiceTarget 同步到所有 Edge（增加到 2 秒）
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const receivedVoice = {
        recvE1Ch0: false,
        recvE2Ch1: false,
        whisperTargetE2: false,
        deafE1Ch0: false,
        normalE1Ch2: false,
      };
      
      const senderSession = sender.getStateManager().getSession()?.session || 0;
      
      recvE1Ch0.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE1Ch0 = true;
      });
      recvE2Ch1.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.recvE2Ch1 = true;
      });
      whisperTargetE2.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.whisperTargetE2 = true;
      });
      deafE1Ch0.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.deafE1Ch0 = true;
      });
      normalE1Ch2.on('voice', (data: VoiceData) => {
        if (data.session === senderSession) receivedVoice.normalE1Ch2 = true;
      });
      
      // UDP 连接已在 createClients 中确认就绪，等待监听器设置完成
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 第一次：普通 push-to-talk (target=0)
      const voicePacket1 = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket1);
      await new Promise(resolve => setTimeout(resolve, 800));
      
      // 第二次：whisper (target=3)
      const voicePacket2 = createVoicePacket(4, 3, 1);
      await sender.getConnectionManager().sendVoicePacket(voicePacket2);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 验证
      expect(receivedVoice.recvE1Ch0).toBe(true); // 接收 push-to-talk
      expect(receivedVoice.recvE2Ch1).toBe(true); // 接收 push-to-talk（链接）
      expect(receivedVoice.whisperTargetE2).toBe(true); // 接收 whisper
      expect(receivedVoice.deafE1Ch0).toBe(false); // deaf 不接收
      expect(receivedVoice.normalE1Ch2).toBe(false); // 未链接且非 whisper 目标
      
      await unlinkChannels(admin, 0, 1);
      await cleanupClients(clients);
      await admin.disconnect();
    });
  });
});
