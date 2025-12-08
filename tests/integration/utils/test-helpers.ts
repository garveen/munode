/**
 * 共享测试辅助函数
 */

import * as crypto from 'crypto';
import { MumbleClient } from '../../../packages/client/src/index.js';
import type { TestEnvironment } from '../setup.js';
import { sleep } from '../setup.js';

/**
 * 生成随机语音数据用于测试
 */
export function generateRandomVoiceData(size: number = 20): Buffer {
  return crypto.randomBytes(size);
}

/**
 * 创建 Opus 语音包（客户端格式）
 * 客户端发送格式: [header(1字节)][sequence_varint][voice_data]
 */
export function createVoicePacket(codec: number = 4, target: number = 0, sequence: number = 0): Buffer {
  const header = Buffer.alloc(1);
  header.writeUInt8((codec << 5) | (target & 0x1F), 0);
  const sequenceVarint = Buffer.from([sequence & 0x7F]);
  const voiceData = generateRandomVoiceData(20);
  return Buffer.concat([header, sequenceVarint, voiceData]);
}

/**
 * 批量创建测试客户端配置
 */
export interface ClientConfig {
  username: string;
  password: string;
  edge: 1 | 2 | 3 | 4;
  channelId?: number;
}

/**
 * 获取 Edge 端口
 */
function getEdgePort(testEnv: TestEnvironment, edge: 1 | 2 | 3 | 4): number {
  switch (edge) {
    case 1: return testEnv.edgePort;
    case 2: return testEnv.edgePort2;
    case 3: return testEnv.edgePort3;
    case 4: return testEnv.edgePort4;
  }
}

/**
 * 批量创建和连接测试客户端
 */
export async function createClients(testEnv: TestEnvironment, configs: ClientConfig[]): Promise<MumbleClient[]> {
  const clients: (MumbleClient | null)[] = new Array(configs.length).fill(null);
  
  await Promise.all(configs.map(async (config, index) => {
    const client = new MumbleClient();
    const targetPort = getEdgePort(testEnv, config.edge);
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
      await sleep(200);
    }
    
    clients[index] = client;
  }));
  
  return clients as MumbleClient[];
}

/**
 * 清理客户端连接
 */
export async function cleanupClients(clients: MumbleClient[]): Promise<void> {
  for (const client of clients) {
    try {
      await client.disconnect();
    } catch (e) {
      // 忽略断开连接的错误
    }
  }
}

/**
 * 创建并连接管理员客户端
 */
export async function createAdminClient(testEnv: TestEnvironment, edge: 1 | 2 = 1): Promise<MumbleClient> {
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
  await sleep(300);
  return admin;
}
