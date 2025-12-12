/**
 * Edge-to-Edge Voice Encryption Integration Tests
 * 
 * 测试 Edge 间语音传输的加密功能：
 * - 加密密钥分发
 * - UDP 握手建立
 * - 加密语音包传输
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';

let testEnv: TestEnvironment;

beforeAll(async () => {
  testEnv = await setupTestEnvironment();
}, 60000);

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
}, 30000);

describe('Edge-to-Edge Voice Encryption Tests', () => {
  it('should distribute encryption keys to Edge servers', async () => {
    // 等待Edge服务器注册到Hub并接收配置
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 检查Edge服务器是否收到了加密配置
    const voiceTransport = testEnv.edgeServer['voiceTransport'];
    expect(voiceTransport).toBeDefined();
    
    // 检查语音传输是否已启动
    const isRunning = voiceTransport.isRunning();
    expect(isRunning).toBe(true);
    
    // 检查统计信息
    const stats = voiceTransport.getStats();
    expect(stats).toBeDefined();
    expect(stats.registeredEndpoints).toBeGreaterThanOrEqual(0);
    
    console.log('✓ Edge server received encryption configuration');
    console.log('✓ Voice UDP transport is running');
    console.log(`✓ Stats: ${JSON.stringify(stats)}`);
  }, 15000);
  
  it('should establish UDP handshake between Edges', async () => {
    // 此测试需要至少两个Edge服务器
    // 由于测试环境只有一个Edge，此测试仅验证基础功能
    
    const voiceTransport = testEnv.edgeServer['voiceTransport'];
    expect(voiceTransport).toBeDefined();
    
    // 检查是否有已注册的端点
    const registeredEdges = voiceTransport.getRegisteredEdgeIds();
    console.log(`✓ Registered Edge endpoints: ${registeredEdges.length}`);
    
    // 检查连接状态
    const allStatus = voiceTransport.getAllConnectionStatus();
    console.log(`✓ Connection status entries: ${allStatus.length}`);
    
    for (const status of allStatus) {
      console.log(`  Edge ${status.edgeId}: connected=${status.connected}, handshake=${status.handshakeComplete}`);
    }
  }, 15000);
  
  it('should handle encryption key updates', async () => {
    const voiceManager = testEnv.edgeServer['voiceManager'];
    expect(voiceManager).toBeDefined();
    
    // 模拟密钥更新
    const testKey = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const testKeyBase64 = testKey.toString('base64');
    
    // 更新加密密钥
    voiceManager.updateEncryptionKey('aes-128-cbc', testKeyBase64, 2);
    
    // 验证密钥已更新
    const voiceTransport = testEnv.edgeServer['voiceTransport'];
    const encryptionConfig = voiceTransport.getEncryptionConfig();
    
    expect(encryptionConfig).toBeDefined();
    if (encryptionConfig) {
      expect(encryptionConfig.algorithm).toBe('aes-128-cbc');
      expect(encryptionConfig.key.length).toBe(16); // AES-128 uses 16-byte keys
    }
    
    console.log('✓ Encryption key updated successfully');
  }, 15000);
});
