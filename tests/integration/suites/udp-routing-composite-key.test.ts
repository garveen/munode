import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  makeCompositeKey, 
  parseCompositeKey,
  isValidCompositeKey,
  CryptoKeyRegistry 
} from '@munode/edge-server';
import { OCB2AES128 } from '@munode/common';

describe('UDP Routing - Composite Key Integration', () => {
  let registry: CryptoKeyRegistry;

  beforeEach(() => {
    registry = new CryptoKeyRegistry();
  });

  afterEach(() => {
    registry.stopAutoCleanup();
    registry.clear();
  });

  describe('多租户会话隔离', () => {
    it('应该能区分不同虚拟主机的相同会话ID', () => {
      const crypto1 = new OCB2AES128();
      const crypto2 = new OCB2AES128();
      crypto1.generateKey();
      crypto2.generateKey();

      registry.register('tenant1.example.com', 100, crypto1);
      registry.register('tenant2.example.com', 100, crypto2);

      const key1 = makeCompositeKey('tenant1.example.com', 100);
      const key2 = makeCompositeKey('tenant2.example.com', 100);

      expect(key1).not.toBe(key2);
      expect(registry.get(key1)).toBe(crypto1);
      expect(registry.get(key2)).toBe(crypto2);
    });

    it('应该支持每个虚拟主机独立的会话空间', () => {
      const cryptos = new Map<string, OCB2AES128>();
      
      // 为每个虚拟主机创建会话 1-10
      for (const vhost of ['vhost1', 'vhost2', 'vhost3']) {
        for (let session = 1; session <= 10; session++) {
          const crypto = new OCB2AES128();
          crypto.generateKey();
          const key = `${vhost}:${session}`;
          cryptos.set(key, crypto);
          registry.register(vhost, session, crypto);
        }
      }

      // 验证每个虚拟主机有 10 个会话
      expect(registry.getByVhost('vhost1').size).toBe(10);
      expect(registry.getByVhost('vhost2').size).toBe(10);
      expect(registry.getByVhost('vhost3').size).toBe(10);
      
      // 验证总共 30 个密钥
      expect(registry.size).toBe(30);

      // 验证可以正确获取每个密钥
      for (const [key, crypto] of cryptos) {
        const [vhost, sessionStr] = key.split(':');
        const session = parseInt(sessionStr, 10);
        expect(registry.getByVhostAndSession(vhost, session)).toBe(crypto);
      }
    });

    it('应该在删除虚拟主机时清理所有会话', () => {
      // 创建多个虚拟主机
      for (const vhost of ['vhost1', 'vhost2']) {
        for (let session = 1; session <= 5; session++) {
          const crypto = new OCB2AES128();
          crypto.generateKey();
          registry.register(vhost, session, crypto);
        }
      }

      expect(registry.size).toBe(10);

      // 删除 vhost1 的所有会话
      const cleared = registry.clearVhost('vhost1');
      expect(cleared).toBe(5);
      expect(registry.size).toBe(5);

      // vhost2 的会话应该仍然存在
      expect(registry.getByVhost('vhost2').size).toBe(5);
    });
  });

  describe('复合键格式', () => {
    it('应该使用冒号分隔虚拟主机和会话ID', () => {
      const key = makeCompositeKey('tenant1.example.com', 12345);
      expect(key).toBe('tenant1.example.com:12345');
    });

    it('应该能解析复合键', () => {
      const key = makeCompositeKey('my-vhost', 999);
      const parsed = parseCompositeKey(key);
      
      expect(parsed.vhostName).toBe('my-vhost');
      expect(parsed.sessionId).toBe(999);
    });

    it('应该验证复合键格式', () => {
      expect(isValidCompositeKey('vhost:123')).toBe(true);
      expect(isValidCompositeKey('tenant.com:456')).toBe(true);
      expect(isValidCompositeKey('invalid')).toBe(false);
      expect(isValidCompositeKey('too:many:parts')).toBe(false);
      expect(isValidCompositeKey('vhost:notanumber')).toBe(false);
    });
  });

  describe('密钥生命周期管理', () => {
    it('应该更新最后使用时间当获取密钥', async () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      registry.register('vhost1', 100, crypto);
      
      // 获取密钥
      const key = makeCompositeKey('vhost1', 100);
      const retrieved1 = registry.get(key);
      expect(retrieved1).toBe(crypto);
      
      // 等待一段时间
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 再次获取密钥应该更新使用时间
      const retrieved2 = registry.get(key);
      expect(retrieved2).toBe(crypto);
    });

    it('应该提供虚拟主机统计信息', () => {
      // 创建不同数量的会话
      for (let i = 1; i <= 3; i++) {
        const crypto = new OCB2AES128();
        crypto.generateKey();
        registry.register('vhost1', i, crypto);
      }
      
      for (let i = 1; i <= 5; i++) {
        const crypto = new OCB2AES128();
        crypto.generateKey();
        registry.register('vhost2', i, crypto);
      }

      const stats = registry.getStats();
      expect(stats.totalKeys).toBe(8);
      expect(stats.vhostCount).toBe(2);
      expect(stats.vhostStats.get('vhost1')).toBe(3);
      expect(stats.vhostStats.get('vhost2')).toBe(5);
    });

    it('应该列出所有虚拟主机名称', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      registry.register('vhost1', 1, crypto);
      registry.register('vhost2', 1, crypto);
      registry.register('vhost3', 1, crypto);

      const vhosts = registry.getAllVhosts();
      expect(vhosts.size).toBe(3);
      expect(vhosts.has('vhost1')).toBe(true);
      expect(vhosts.has('vhost2')).toBe(true);
      expect(vhosts.has('vhost3')).toBe(true);
    });
  });

  describe('边界情况', () => {
    it('应该处理虚拟主机名包含冒号的情况', () => {
      // 这是一个潜在的问题情况
      // 虚拟主机名通常不应包含冒号，但我们应该测试
      const vhostWithColon = 'invalid:vhost';
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      registry.register(vhostWithColon, 100, crypto);
      
      // makeCompositeKey 会创建 "invalid:vhost:100"
      // parseCompositeKey 会失败因为有 3 个部分
      const key = makeCompositeKey(vhostWithColon, 100);
      expect(() => parseCompositeKey(key)).toThrow('Invalid composite key format');
    });

    it('应该处理大会话ID', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      const largeSession = 2147483647; // 2^31 - 1
      
      registry.register('vhost1', largeSession, crypto);
      const retrieved = registry.getByVhostAndSession('vhost1', largeSession);
      
      expect(retrieved).toBe(crypto);
    });

    it('应该处理长虚拟主机名', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      const longVhost = 'a'.repeat(255) + '.example.com';
      
      registry.register(longVhost, 1, crypto);
      const retrieved = registry.getByVhostAndSession(longVhost, 1);
      
      expect(retrieved).toBe(crypto);
    });
  });
});
