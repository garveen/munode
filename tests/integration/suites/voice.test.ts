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
import { TestEnvironment, setupTestEnvironment, createClients, cleanupClients, sleep, waitForCondition } from '../setup';
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
  await new Promise(resolve => setTimeout(resolve, 1000));
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
  await new Promise(resolve => setTimeout(resolve, 500));
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
  await new Promise(resolve => setTimeout(resolve, 500));
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

describe('Voice Integration Tests', () => {
  let testEnv: TestEnvironment;
  let adminForCleanup: MumbleClient | null = null;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8089, { reuse: false }); // 使用独立环境，避免与其他测试冲突
  }, 60000);

  afterAll(async () => {
    if (adminForCleanup) {
      await adminForCleanup.disconnect();
    }
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    // 检查 adminForCleanup 是否仍然连接（例如 Hub 重启后可能断开）
    if (!adminForCleanup || !adminForCleanup.isConnected()) {
      if (adminForCleanup) {
        try { await adminForCleanup.disconnect(); } catch { /* ignore */ }
      }
      adminForCleanup = await createAdminClient(testEnv);
    }
    // 直接从已连接的 adminForCleanup 获取频道列表，无需额外创建 tempClient
    const channels = adminForCleanup.getChannels();
    await clearAllChannelLinks(adminForCleanup, channels);
    await sleep(300);
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
        { username: 'voice_sender', edge: 1, channelId: 0 },
        { username: 'voice_recv_e1_same', edge: 1, channelId: 0 },
        { username: 'voice_recv_e2_same', edge: 2, channelId: 0 },
        { username: 'voice_recv_e1_other', edge: 1, channelId: 1 },
        { username: 'voice_recv_e2_other', edge: 2, channelId: 1 },
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
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      // 等待语音包到达（跨 Edge 需要更长时间）
      await new Promise(resolve => setTimeout(resolve, 2000));
      
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
        { username: 'voice_sender2', edge: 1, channelId: 0 },
        { username: 'voice_deaf_e1', edge: 1, channelId: 0 },
        { username: 'voice_deaf_e2', edge: 2, channelId: 0 },
        { username: 'voice_normal_e1', edge: 1, channelId: 0 },
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
      const voicePacket = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 验证：deaf 用户不应收到，normal 用户应该收到
      expect(receivedVoice.deafE1).toBe(false);
      expect(receivedVoice.deafE2).toBe(false);
      expect(receivedVoice.normalE1).toBe(true);
      
      await cleanupClients(clients);
    });
  });

  describe('Channel Linking', () => {
    it('should broadcast voice to linked channels on same and cross edge, but not unlinked channels', async () => {
      // 测试频道链接：Channel 0 (Root) 链接到 Channel 1
      // 4 个在链接频道的 client 全部同时发送语音，每个 client 都应收到其他 3 个的语音
      // Channel 2 的 client 不应收到任何语音
      //
      // linked clients（索引 0-3）：
      //   [0] voice_sender3:     Edge 1, Channel 0
      //   [1] voice_recv_e2_ch0: Edge 2, Channel 0（跨 Edge 同频道）
      //   [2] voice_recv_e1_ch1: Edge 1, Channel 1（链接）
      //   [3] voice_recv_e2_ch1: Edge 2, Channel 1（链接，跨 Edge）
      // unlinked clients（索引 4-5）：
      //   [4] voice_recv_e1_ch2: Edge 1, Channel 2 - 不应收到任何语音
      //   [5] voice_recv_e2_ch2: Edge 2, Channel 2 - 不应收到任何语音
      
      const admin = await createAdminClient(testEnv);
      await linkChannels(admin, 0, 1);
      
      const clients = await createClients(testEnv, [
        { username: 'voice_sender3', edge: 1, channelId: 0 },
        { username: 'voice_recv_e2_ch0', edge: 2, channelId: 0 },
        { username: 'voice_recv_e1_ch1', edge: 1, channelId: 1 },
        { username: 'voice_recv_e2_ch1', edge: 2, channelId: 1 },
        { username: 'voice_recv_e1_ch2', edge: 1, channelId: 2 },
        { username: 'voice_recv_e2_ch2', edge: 2, channelId: 2 },
      ]);
      
      // 等待所有客户端完全初始化并接收频道链接信息
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const [sender, recvE2Ch0, recvE1Ch1, recvE2Ch1, recvE1Ch2, recvE2Ch2] = clients;
      
      // 验证频道链接是否正确同步
      const channelsE1 = sender.getChannels();
      const channelsE2 = recvE2Ch0.getChannels();
      const ch0E1 = channelsE1.find((ch: ChannelInfo) => ch.channel_id === 0);
      const ch0E2 = channelsE2.find((ch: ChannelInfo) => ch.channel_id === 0);
      
      console.log(`[TEST] Edge 1 Channel 0 links: [${(ch0E1?.links || []).join(', ')}]`);
      console.log(`[TEST] Edge 2 Channel 0 links: [${(ch0E2?.links || []).join(', ')}]`);
      
      expect(ch0E1?.links).toContain(1);
      expect(ch0E2?.links).toContain(1);
      
      // 获取 4 个 linked client 的 session（按索引对应）
      const linkedClients = [sender, recvE2Ch0, recvE1Ch1, recvE2Ch1];
      const linkedSessions = linkedClients.map(c => c.getStateManager().getSession()?.session ?? 0);
      const linkedSessionSet = new Set(linkedSessions);
      
      // receivedFrom[i] = 客户端 i 收到了哪些 sender session 的语音
      const receivedFrom: Set<number>[] = clients.map(() => new Set<number>());
      
      clients.forEach((client, idx) => {
        client.on('voice', (data: VoiceData) => {
          if (linkedSessionSet.has(data.session)) {
            receivedFrom[idx].add(data.session);
          }
        });
      });
      
      // 4 个 linked client 同时发送语音
      await Promise.all(
        linkedClients.map(c => c.getConnectionManager().sendVoicePacket(createVoicePacket(4, 0, 0)))
      );
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 验证：每个 linked client 都应收到其他 3 个 client 的语音（按 session 匹配）
      const clientNames = ['voice_sender3', 'voice_recv_e2_ch0', 'voice_recv_e1_ch1', 'voice_recv_e2_ch1'];
      for (let i = 0; i < linkedClients.length; i++) {
        for (let j = 0; j < linkedClients.length; j++) {
          if (i !== j) {
            expect(
              receivedFrom[i].has(linkedSessions[j]),
              `${clientNames[i]} 应收到来自 ${clientNames[j]} (session=${linkedSessions[j]}) 的语音`
            ).toBe(true);
          }
        }
      }
      
      // 验证：Channel 2 的两个 client 不应收到任何 linked client 的语音
      expect(receivedFrom[4].size, 'voice_recv_e1_ch2 不应收到任何语音').toBe(0);
      expect(receivedFrom[5].size, 'voice_recv_e2_ch2 不应收到任何语音').toBe(0);
      
      await unlinkChannels(admin, 0, 1);
      await cleanupClients(clients);
      await admin.disconnect();
    });

    it('should broadcast voice correctly in a->b<-c chain linked channel topology', async () => {
      // 测试链式频道链接：Ch0 (A) ↔ Ch1 (B) ↔ Ch2 (C)
      // 链接操作：A↔B 和 C↔B 分别建立——这正是 "a->b<-c" 拓扑
      // Murmur allLinks() 图遍历：任意频道的所有链接可达频道 = {A, B, C}
      // 因此 A、B、C 三个频道的用户全部互相可听
      //
      // 客户端分布：
      //   [0] chain_a_e1:  Edge 1, Ch0 (A 端, E1)
      //   [1] chain_b_e1:  Edge 1, Ch1 (B 中间, E1)
      //   [2] chain_b_e2:  Edge 2, Ch1 (B 中间, 跨Edge)
      //   [3] chain_c_e1:  Edge 1, Ch2 (C 端, E1)
      //   [4] chain_c_e2:  Edge 2, Ch2 (C 端, 跨Edge)

      const admin = await createAdminClient(testEnv);
      // 建立 A↔B 和 C↔B 链接
      await linkChannels(admin, 0, 1);  // ch0 ↔ ch1
      await linkChannels(admin, 2, 1);  // ch2 ↔ ch1

      const clients = await createClients(testEnv, [
        { username: 'chain_a_e1', edge: 1, channelId: 0 },
        { username: 'chain_b_e1', edge: 1, channelId: 1 },
        { username: 'chain_b_e2', edge: 2, channelId: 1 },
        { username: 'chain_c_e1', edge: 1, channelId: 2 },
        { username: 'chain_c_e2', edge: 2, channelId: 2 },
      ]);

      // 等待所有客户端完全初始化并接收频道链接信息
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证链接已同步到客户端
      // ch0.links 应包含 ch1，ch1.links 应包含 ch0 和 ch2，ch2.links 应包含 ch1
      const chA = clients[0].getChannels().find((ch: ChannelInfo) => ch.channel_id === 0);
      const chB = clients[1].getChannels().find((ch: ChannelInfo) => ch.channel_id === 1);
      const chC = clients[3].getChannels().find((ch: ChannelInfo) => ch.channel_id === 2);

      console.log(`[TEST] a->b<-c: ch0.links=[${chA?.links?.join(',')}], ch1.links=[${chB?.links?.join(',')}], ch2.links=[${chC?.links?.join(',')}]`);

      expect(chA?.links, 'ch0 应链接到 ch1').toContain(1);
      expect(chB?.links, 'ch1 应链接到 ch0').toContain(0);
      expect(chB?.links, 'ch1 应链接到 ch2').toContain(2);
      expect(chC?.links, 'ch2 应链接到 ch1').toContain(1);

      // 全部 5 个客户端的 session
      const sessions = clients.map(c => c.getStateManager().getSession()?.session ?? 0);
      const sessionSet = new Set(sessions);

      // receivedFrom[i] = 客户端 i 收到了哪些 session 的语音
      const receivedFrom: Set<number>[] = clients.map(() => new Set<number>());
      clients.forEach((client, idx) => {
        client.on('voice', (data: VoiceData) => {
          if (sessionSet.has(data.session)) {
            receivedFrom[idx].add(data.session);
          }
        });
      });

      // 5 个客户端全部同时发送语音
      await Promise.all(
        clients.map(c => c.getConnectionManager().sendVoicePacket(createVoicePacket(4, 0, 0)))
      );

      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证：各客户端应收到其他全部 4 个客户端的语音
      const names = ['chain_a_e1', 'chain_b_e1', 'chain_b_e2', 'chain_c_e1', 'chain_c_e2'];
      for (let i = 0; i < clients.length; i++) {
        for (let j = 0; j < clients.length; j++) {
          if (i !== j) {
            expect(
              receivedFrom[i].has(sessions[j]),
              `${names[i]} 应收到来自 ${names[j]} (session=${sessions[j]}) 的语音`
            ).toBe(true);
          }
        }
      }

      await unlinkChannels(admin, 0, 1);
      await unlinkChannels(admin, 2, 1);
      await cleanupClients(clients);
      await admin.disconnect();
    });

    it('should route PTT voice correctly after Hub restart (links reloaded from DB)', async () => {
      // 验证 Hub 重启后从 DB 加载的频道链接能正确驱动语音路由
      // 客户端能看到链接（ChannelState.links 已同步）且语音 PTT 也能正确路由
      //
      // 场景：Ch0 ↔ Ch1，每侧各 1 个客户端
      //   [0] restart_ch0_e1: Edge 1, Ch0
      //   [1] restart_ch1_e1: Edge 1, Ch1（链接）

      const admin = await createAdminClient(testEnv);
      await linkChannels(admin, 0, 1);
      await admin.disconnect();

      // ── Hub 重启 ──
      if (!testEnv.hubServer) throw new Error('hubServer not available in testEnv');
      await testEnv.hubServer.stop();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await testEnv.hubServer.start();
      // 等待 Edge 重连 Hub 并完成频道同步（主动检测而非固定等待）
      // Edge 检测到 Hub 断开 → 重连 → joinCluster → loadDataFromHub
      await waitForCondition(
        async () => {
          try {
            const probe = new MumbleClient();
            await probe.connect({
              host: 'localhost',
              port: testEnv.edgePort,
              username: 'admin',
              password: 'admin123',
              rejectUnauthorized: false,
            });
            await probe.disconnect();
            return true;
          } catch {
            return false;
          }
        },
        15000, // 最多等 15 秒
        500,
        'Edge to reconnect to Hub after restart'
      );

      // 重启后连接客户端
      const clients = await createClients(testEnv, [
        { username: 'restart_ch0_e1', edge: 1, channelId: 0 },
        { username: 'restart_ch1_e1', edge: 1, channelId: 1 },
      ]);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const [clientCh0, clientCh1] = clients;

      // 验证链接已同步到客户端
      const ch0 = clientCh0.getChannels().find((ch: ChannelInfo) => ch.channel_id === 0);
      const ch1 = clientCh1.getChannels().find((ch: ChannelInfo) => ch.channel_id === 1);
      console.log(`[TEST] After Hub restart: ch0.links=[${ch0?.links?.join(',')}], ch1.links=[${ch1?.links?.join(',')}]`);
      expect(ch0?.links, 'Hub 重启后 ch0 链接应同步到客户端').toContain(1);
      expect(ch1?.links, 'Hub 重启后 ch1 链接应同步到客户端').toContain(0);

      const sessions = clients.map(c => c.getStateManager().getSession()?.session ?? 0);
      const sessionSet = new Set(sessions);
      const receivedFrom: Set<number>[] = clients.map(() => new Set<number>());

      clients.forEach((client, idx) => {
        client.on('voice', (data: VoiceData) => {
          if (sessionSet.has(data.session)) receivedFrom[idx].add(data.session);
        });
      });

      // 双向同时发送
      await Promise.all(
        clients.map(c => c.getConnectionManager().sendVoicePacket(createVoicePacket(4, 0, 0)))
      );
      await new Promise(resolve => setTimeout(resolve, 2000));

      // ch0 应收到 ch1 的语音，ch1 应收到 ch0 的语音
      expect(
        receivedFrom[0].has(sessions[1]),
        `restart_ch0_e1 应收到来自 restart_ch1_e1 (session=${sessions[1]}) 的语音（Hub 重启后 PTT 路由应正常）`
      ).toBe(true);
      expect(
        receivedFrom[1].has(sessions[0]),
        `restart_ch1_e1 应收到来自 restart_ch0_e1 (session=${sessions[0]}) 的语音（Hub 重启后 PTT 路由应正常）`
      ).toBe(true);

      // 清理
      const adminCleanup = await createAdminClient(testEnv);
      await unlinkChannels(adminCleanup, 0, 1);
      await cleanupClients(clients);
      await adminCleanup.disconnect();
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
        { username: 'voice_whisper_sender', edge: 1, channelId: 0 },
        { username: 'voice_target1_e1', edge: 1, channelId: 0 },
        { username: 'voice_target1_e2', edge: 2, channelId: 0 },
        { username: 'voice_non_target_e1', edge: 1, channelId: 0 },
        { username: 'voice_non_target_e2', edge: 2, channelId: 0 },
      ]);
      
      const [sender, target1E1, target1E2, nonTargetE1, nonTargetE2] = clients;
      
      // 创建 VoiceTarget
      await sender.setVoiceTarget(1, [
        { session: [target1E1.getStateManager().getSession()?.session || 0, target1E2.getStateManager().getSession()?.session || 0] },
      ]);
      // 等待 VoiceTarget 同步到所有 Edge（增加到 0.5 秒）
      await new Promise(resolve => setTimeout(resolve, 500));
      
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
      
      // 等待语音包跨 Edge 传输
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
        { username: 'voice_ch_target_sender', edge: 1, channelId: 0 },
        { username: 'voice_recv_e1_tch1', edge: 1, channelId: 1 },
        { username: 'voice_recv_e2_tch1', edge: 2, channelId: 1 },
        { username: 'voice_recv_e1_tch0', edge: 1, channelId: 0 },
        { username: 'voice_recv_e1_tch2', edge: 1, channelId: 2 },
      ]);
      
      const [sender, recvE1Ch1, recvE2Ch1, recvE1Ch0, recvE1Ch2] = clients;
      
      // 创建频道 VoiceTarget
      await sender.setVoiceTarget(2, [
        { session: [], channel_id: 1 },
      ]);
      // 等待 VoiceTarget 同步到所有 Edge（增加到 0.5 秒）
      await new Promise(resolve => setTimeout(resolve, 500));
      
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
      
      // 等待语音包跨 Edge 传输
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
        { username: 'voice_loopback_sender', edge: 1, channelId: 0 },
        { username: 'voice_loopback_other', edge: 1, channelId: 0 },
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
      
      // 发送 loopback 语音包
      const voicePacket = createVoicePacket(4, 31, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket);
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
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
        { username: 'voice_multi_sender', edge: 1, channelId: 0 },
        { username: 'voice_multi_recv_e1', edge: 1, channelId: 0 },
        { username: 'voice_multi_recv_e2', edge: 2, channelId: 0 },
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
      
      // 等待跨 Edge 连接和状态同步就绪
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 发送 5 个语音包
      for (let i = 0; i < 5; i++) {
        const voicePacket = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(voicePacket);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
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
        { username: 'voice_complex_sender', edge: 1, channelId: 0 },
        { username: 'voice_complex_e1_ch0', edge: 1, channelId: 0 },
        { username: 'voice_complex_e2_ch1', edge: 2, channelId: 1 },
        { username: 'voice_whisper_tgt_e2', edge: 2, channelId: 2 },
        { username: 'voice_deaf_e1_ch0', edge: 1, channelId: 0 },
        { username: 'voice_normal_e1_ch2', edge: 1, channelId: 2 },
      ]);
      
      const [sender, recvE1Ch0, recvE2Ch1, whisperTargetE2, deafE1Ch0, normalE1Ch2] = clients;
      
      // 设置 deaf
      await deafE1Ch0.sendUserState({ self_deaf: true });
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // 创建 VoiceTarget
      await sender.setVoiceTarget(3, [
        { session: [whisperTargetE2.getStateManager().getSession()?.session || 0] },
      ]);
      // 等待 VoiceTarget 同步到所有 Edge（增加到 0.5 秒）
      await new Promise(resolve => setTimeout(resolve, 500));
      
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
      
      // 第一次：普通 push-to-talk (target=0)
      const voicePacket1 = createVoicePacket(4, 0, 0);
      await sender.getConnectionManager().sendVoicePacket(voicePacket1);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 第二次：whisper (target=3)
      const voicePacket2 = createVoicePacket(4, 3, 1);
      await sender.getConnectionManager().sendVoicePacket(voicePacket2);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
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
