import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MultiTenantVoiceRouterSupport } from '@munode/edge-server';
import { OCB2AES128 } from '@munode/common';
import { Logger, createLogger } from '@munode/common';

describe('MultiTenantVoiceRouterSupport', () => {
  let support: MultiTenantVoiceRouterSupport;
  let logger: Logger;

  beforeAll(() => {
    logger = createLogger({ level: 'silent', service: 'test' });
  });

  beforeEach(() => {
    support = new MultiTenantVoiceRouterSupport(logger);
  });

  afterEach(() => {
    support.cleanup();
  });

  describe('基本操作', () => {
    it('应该注册和获取加密器', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      support.registerCrypto('vhost1', 100, crypto);
      const retrieved = support.getCryptoBySession(100);
      
      expect(retrieved).toBe(crypto);
    });

    it('应该通过虚拟主机和会话ID获取加密器', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      support.registerCrypto('vhost1', 200, crypto);
      const retrieved = support.getCryptoByVhostAndSession('vhost1', 200);
      
      expect(retrieved).toBe(crypto);
    });

    it('应该移除加密器', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      support.registerCrypto('vhost1', 300, crypto);
      expect(support.getCryptoBySession(300)).toBeDefined();
      
      support.removeCrypto(300);
      expect(support.getCryptoBySession(300)).toBeUndefined();
    });

    it('应该返回undefined当会话不存在', () => {
      const retrieved = support.getCryptoBySession(999);
      expect(retrieved).toBeUndefined();
    });
  });

  describe('虚拟主机隔离', () => {
    it('应该隔离不同虚拟主机的相同会话ID', () => {
      const crypto1 = new OCB2AES128();
      const crypto2 = new OCB2AES128();
      crypto1.generateKey();
      crypto2.generateKey();
      
      support.registerCrypto('vhost1', 100, crypto1);
      support.registerCrypto('vhost2', 100, crypto2);
      
      // 通过会话ID获取应该只返回第一个注册的（因为sessionToVhost是单映射）
      // 但通过虚拟主机+会话ID获取应该能正确区分
      expect(support.getCryptoByVhostAndSession('vhost1', 100)).toBe(crypto1);
      expect(support.getCryptoByVhostAndSession('vhost2', 100)).toBe(crypto2);
    });

    it('应该检查会话是否属于虚拟主机', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      support.registerCrypto('vhost1', 100, crypto);
      
      expect(support.isSessionInVhost(100, 'vhost1')).toBe(true);
      expect(support.isSessionInVhost(100, 'vhost2')).toBe(false);
    });

    it('应该获取会话所属的虚拟主机', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      support.registerCrypto('vhost1', 100, crypto);
      
      expect(support.getVhostForSession(100)).toBe('vhost1');
      expect(support.getVhostForSession(999)).toBeUndefined();
    });

    it('应该获取虚拟主机下的所有会话', () => {
      for (let i = 1; i <= 5; i++) {
        const crypto = new OCB2AES128();
        crypto.generateKey();
        support.registerCrypto('vhost1', i, crypto);
      }
      
      for (let i = 10; i <= 12; i++) {
        const crypto = new OCB2AES128();
        crypto.generateKey();
        support.registerCrypto('vhost2', i, crypto);
      }
      
      const vhost1Sessions = support.getSessionsInVhost('vhost1');
      const vhost2Sessions = support.getSessionsInVhost('vhost2');
      
      expect(vhost1Sessions.sort()).toEqual([1, 2, 3, 4, 5]);
      expect(vhost2Sessions.sort()).toEqual([10, 11, 12]);
    });
  });

  describe('虚拟主机管理', () => {
    it('应该清除虚拟主机的所有会话', () => {
      for (let i = 1; i <= 5; i++) {
        const crypto = new OCB2AES128();
        crypto.generateKey();
        support.registerCrypto('vhost1', i, crypto);
      }
      
      for (let i = 1; i <= 3; i++) {
        const crypto = new OCB2AES128();
        crypto.generateKey();
        support.registerCrypto('vhost2', i, crypto);
      }
      
      const cleared = support.clearVhost('vhost1');
      expect(cleared).toBe(5);
      
      // vhost1 的会话应该被清除
      expect(support.getSessionsInVhost('vhost1')).toEqual([]);
      
      // vhost2 的会话应该保留
      expect(support.getSessionsInVhost('vhost2').length).toBe(3);
    });

    it('应该获取所有虚拟主机名称', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      support.registerCrypto('vhost1', 1, crypto);
      support.registerCrypto('vhost2', 1, crypto);
      support.registerCrypto('vhost3', 1, crypto);
      
      const vhosts = support.getAllVhosts();
      expect(vhosts.size).toBe(3);
      expect(vhosts.has('vhost1')).toBe(true);
      expect(vhosts.has('vhost2')).toBe(true);
      expect(vhosts.has('vhost3')).toBe(true);
    });
  });

  describe('统计信息', () => {
    it('应该返回正确的统计信息', () => {
      for (let i = 1; i <= 3; i++) {
        const crypto = new OCB2AES128();
        crypto.generateKey();
        support.registerCrypto('vhost1', i, crypto);
      }
      
      for (let i = 1; i <= 5; i++) {
        const crypto = new OCB2AES128();
        crypto.generateKey();
        support.registerCrypto('vhost2', i, crypto);
      }
      
      const stats = support.getStats();
      expect(stats.totalKeys).toBe(8);
      expect(stats.vhostCount).toBe(2);
      expect(stats.vhostStats.get('vhost1')).toBe(3);
      expect(stats.vhostStats.get('vhost2')).toBe(5);
    });
  });

  describe('清理', () => {
    it('应该清理所有资源', () => {
      const crypto = new OCB2AES128();
      crypto.generateKey();
      
      support.registerCrypto('vhost1', 1, crypto);
      support.registerCrypto('vhost2', 2, crypto);
      
      expect(support.getStats().totalKeys).toBe(2);
      
      support.cleanup();
      
      expect(support.getStats().totalKeys).toBe(0);
      expect(support.getAllVhosts().size).toBe(0);
    });
  });

  describe('边界情况', () => {
    it('应该处理重复注册相同会话', () => {
      const crypto1 = new OCB2AES128();
      const crypto2 = new OCB2AES128();
      crypto1.generateKey();
      crypto2.generateKey();
      
      support.registerCrypto('vhost1', 100, crypto1);
      support.registerCrypto('vhost1', 100, crypto2);
      
      // 后注册的应该覆盖前面的
      expect(support.getCryptoBySession(100)).toBe(crypto2);
    });

    it('应该处理移除不存在的会话', () => {
      // 不应该抛出错误
      expect(() => support.removeCrypto(999)).not.toThrow();
    });

    it('应该处理清除空虚拟主机', () => {
      const cleared = support.clearVhost('nonexistent');
      expect(cleared).toBe(0);
    });
  });
});
