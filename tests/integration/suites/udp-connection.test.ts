/**
 * UDP 连接集成测试
 * 
 * 测试 Client 到 Edge 的 UDP 连接建立和通信，包括：
 * - UDP Ping 包的发送和响应
 * - UDP 地址映射建立
 * - UDP 语音包发送和接收
 * - UDP 故障时降级到 TCP
 * 
 * 注意：当前存在已知问题，第一个测试通过后，后续测试的UDP ping响应可能不会到达。
 * 这可能是由于Edge服务器的UDP状态管理或测试环境清理问题。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';
import * as crypto from 'crypto';

let testEnv: TestEnvironment;

beforeAll(async () => {
  testEnv = await setupTestEnvironment();
}, 60000);

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
}, 30000);

/**
 * 生成随机语音数据用于测试
 */
function generateRandomVoiceData(size: number = 20): Buffer {
  return crypto.randomBytes(size);
}

/**
 * 等待语音包接收
 */
function waitForVoice(client: MumbleClient, timeout: number = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Voice receive timeout'));
    }, timeout);

    client.once('voice', (voiceData: any) => {
      clearTimeout(timer);
      resolve(voiceData);
    });
  });
}

describe('UDP Connection Tests', () => {
  it('should establish UDP connection with ping', async () => {
    console.log('[TEST] Starting test, testEnv:', testEnv ? 'initialized' : 'NOT initialized');
    console.log('[TEST] Edge port:', testEnv?.edgePort);
    console.log('[TEST] Edge process:', testEnv?.edgeProcess ? 'running' : 'NOT running');
    console.log('[TEST] Hub process:', testEnv?.hubProcess ? 'running' : 'NOT running');
    
    // Wait for servers to be ready
    console.log('[TEST] Waiting 5 seconds for servers to stabilize...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const client = new MumbleClient();
    
    // Track if UDP ready event was received
    let udpReadyReceived = false;
    
    // IMPORTANT: 在连接前设置所有事件监听器
    client.on('udpReady', () => {
      console.log('[CLIENT EVENT] udpReady received!');
      udpReadyReceived = true;
    });
    
    // Add event listeners to see all events
    client.on('connectionStateChanged', (state) => {
      console.log('[CLIENT EVENT] connectionStateChanged:', state);
    });
    
    client.on('version', (msg) => {
      console.log('[CLIENT EVENT] version received');
    });
    
    client.on('serverSync', (msg) => {
      console.log('[CLIENT EVENT] serverSync received, session:', msg.session);
    });
    
    client.on('cryptSetup', (msg) => {
      console.log('[CLIENT EVENT] cryptSetup received');
    });
    
    client.on('reject', (msg) => {
      console.log('[CLIENT EVENT] reject received:', msg);
    });
    
    client.on('error', (error) => {
      console.log('[CLIENT EVENT] error:', error);
    });
    
    try {
      console.log('[TEST] Connecting to Edge server...');
      // 连接到 Edge 服务器
      // 注意：UDP 和 TLS 使用相同的端口（Go/C 实现的行为）
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        // udpPort: testEnv.edgeUdpPort, // 不需要，使用相同端口
        username: 'udp_test_user1',
        password: 'password123',
        rejectUnauthorized: false,
      });

      console.log('[TEST] Connected, waiting for authentication and UDP setup...');
      // 等待认证完成和UDP ready（UDP ping happens automatically after CryptSetup)
      // 增加等待时间以确保UDP ping有足够时间往返
      await new Promise(resolve => setTimeout(resolve, 5000));

      console.log('[TEST] Checking connection state...');
      const connectionManager = client.getConnectionManager();
      console.log('[TEST] Is using TCP voice?', connectionManager.isUsingTcpVoice());
      console.log('[TEST] Is connected?', connectionManager.isConnected());
      console.log('[TEST] UDP ready received?', udpReadyReceived);
      
      // Check if UDP ready event was received
      expect(udpReadyReceived).toBe(true);
      expect(connectionManager.isUsingTcpVoice()).toBe(false);

      console.log('✓ UDP connection established successfully');
    } finally {
      await client.disconnect();
    }
  }, 30000);

  it('should send and receive voice packet via UDP', async () => {
    const sender = new MumbleClient();
    const receiver = new MumbleClient();
    
    let senderUdpReady = false;
    let receiverUdpReady = false;
    
    // Attach listeners BEFORE connecting
    sender.on('udpReady', () => { 
      console.log('[SENDER] UDP ready event received');
      senderUdpReady = true; 
    });
    receiver.on('udpReady', () => { 
      console.log('[RECEIVER] UDP ready event received');
      receiverUdpReady = true; 
    });
    
    try {
      // 连接发送者
      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'udp_sender',
        password: 'password123',
        rejectUnauthorized: false,
      });

      // 连接接收者
      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'udp_receiver',
        password: 'password123',
        rejectUnauthorized: false,
      });

      // 等待双方认证完成和 UDP 就绪
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('✓ Both clients UDP ready:', senderUdpReady, receiverUdpReady);

      // 确认都在使用 UDP
      expect(senderUdpReady).toBe(true);
      expect(receiverUdpReady).toBe(true);
      expect(sender.getConnectionManager().isUsingTcpVoice()).toBe(false);
      expect(receiver.getConnectionManager().isUsingTcpVoice()).toBe(false);

      // 发送语音包
      const voicePromise = waitForVoice(receiver, 10000);
      
      const voiceData = generateRandomVoiceData(20);
      const packet = createVoicePacket(4, 0, 1, voiceData);
      
      await sender.getConnectionManager().sendVoicePacket(packet);
      console.log('✓ Voice packet sent');

      // 等待接收语音包
      const receivedVoice = await voicePromise;
      console.log('✓ Voice packet received:', receivedVoice);

      // 验证接收到的语音包
      expect(receivedVoice).toBeDefined();
      expect(receivedVoice.session).toBeDefined();
      expect(receivedVoice.codec).toBe(4); // Opus
      expect(receivedVoice.target).toBe(0);
      
    } finally {
      await sender.disconnect();
      await receiver.disconnect();
    }
  }, 20000);

  it('should fallback to TCP when UDP fails', async () => {
    const client = new MumbleClient();
    
    try {
      // 强制使用 TCP 语音
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'tcp_fallback_user',
        password: 'password123',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // 验证使用 TCP 语音
      const connectionManager = client.getConnectionManager();
      expect(connectionManager.isUsingTcpVoice()).toBe(true);

      console.log('✓ TCP fallback working correctly');
    } finally {
      await client.disconnect();
    }
  }, 15000);

  it('should handle UDP ping correctly', async () => {
    const client = new MumbleClient();
    let udpReady = false;
    
    // Attach listener BEFORE connecting
    client.on('udpReady', () => { 
      console.log('[CLIENT] UDP ready event received');
      udpReady = true; 
    });
    
    try {
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'udp_ping_test',
        password: 'password123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('✓ UDP Ping response received, udpReady:', udpReady);
      
      // 验证 UDP 已建立
      expect(udpReady).toBe(true);
      expect(client.getConnectionManager().isUsingTcpVoice()).toBe(false);
      
    } finally {
      await client.disconnect();
    }
  }, 15000);

  it('should maintain UDP connection across multiple packets', async () => {
    const sender = new MumbleClient();
    const receiver = new MumbleClient();
    
    let senderUdpReady = false;
    let receiverUdpReady = false;
    
    // Attach listeners BEFORE connecting
    sender.on('udpReady', () => { 
      console.log('[SENDER] UDP ready event received');
      senderUdpReady = true; 
    });
    receiver.on('udpReady', () => { 
      console.log('[RECEIVER] UDP ready event received');
      receiverUdpReady = true; 
    });
    
    try {
      await sender.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'udp_multi_sender',
        password: 'password123',
        rejectUnauthorized: false,
      });

      await receiver.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'udp_multi_receiver',
        password: 'password123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(senderUdpReady).toBe(true);
      expect(receiverUdpReady).toBe(true);

      console.log('✓ Both clients ready for multi-packet test');

      // 发送多个语音包
      const packetCount = 5;
      let receivedCount = 0;

      const receivePromise = new Promise<void>((resolve) => {
        receiver.on('voice', () => {
          receivedCount++;
          console.log(`Received packet ${receivedCount}/${packetCount}`);
          if (receivedCount >= packetCount) {
            resolve();
          }
        });
      });

      for (let i = 0; i < packetCount; i++) {
        const voiceData = generateRandomVoiceData(20);
        const packet = createVoicePacket(4, 0, i + 1, voiceData);
        await sender.getConnectionManager().sendVoicePacket(packet);
        await new Promise(resolve => setTimeout(resolve, 50)); // 50ms 间隔
      }

      // 等待所有包接收完成（最多 5 秒）
      await Promise.race([
        receivePromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Not all packets received')), 5000)
        ),
      ]);

      expect(receivedCount).toBe(packetCount);
      console.log(`✓ All ${packetCount} packets received successfully`);
      
    } finally {
      await sender.disconnect();
      await receiver.disconnect();
    }
  }, 20000);
});

/**
 * 创建语音包（包含会话ID和序列号）
 */
function createVoicePacket(
  codec: number = 4,
  target: number = 0,
  sequence: number = 0,
  voiceData?: Buffer
): Buffer {
  const header = Buffer.alloc(1);
  header.writeUInt8((codec << 5) | (target & 0x1F), 0);
  
  // Session ID 暂时不添加，由客户端的 buildVoicePacket 处理
  // 但为了测试，我们需要构建完整的包
  
  // 简化版本：只包含 header + sequence + voice data
  const sequenceVarint = encodeVarint(sequence);
  const audioData = voiceData || generateRandomVoiceData(20);
  
  return Buffer.concat([header, sequenceVarint, audioData]);
}

/**
 * 编码可变长度整数
 */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7F;
    value >>= 7;
    if (value > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}
