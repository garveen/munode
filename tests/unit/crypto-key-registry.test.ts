import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CryptoKeyRegistry } from '@munode/edge-server';
import { OCB2AES128 } from '@munode/common';

describe('CryptoKeyRegistry', () => {
  let registry: CryptoKeyRegistry;
  
  const mockCryptoState1 = new OCB2AES128();
  const mockCryptoState2 = new OCB2AES128();

  beforeEach(() => {
    registry = new CryptoKeyRegistry({ expirationMs: 1000 });
    // 生成密钥使其有效
    mockCryptoState1.generateKey();
    mockCryptoState2.generateKey();
  });

  afterEach(() => {
    registry.stopAutoCleanup();
    registry.clear();
  });

  describe('基本操作', () => {
    it('应该注册和获取密钥', () => {
      registry.register('host1', 100, mockCryptoState1);
      const retrieved = registry.get('host1:100');
      expect(retrieved).toBe(mockCryptoState1);
    });

    it('应该通过虚拟主机和会话ID获取', () => {
      registry.register('host1', 200, mockCryptoState1);
      const retrieved = registry.getByVhostAndSession('host1', 200);
      expect(retrieved).toBe(mockCryptoState1);
    });

    it('应该删除密钥', () => {
      registry.register('host1', 300, mockCryptoState1);
      expect(registry.get('host1:300')).toBeDefined();
      
      const deleted = registry.delete('host1:300');
      expect(deleted).toBe(true);
      expect(registry.get('host1:300')).toBeUndefined();
    });

    it('应该通过虚拟主机和会话ID删除', () => {
      registry.register('host1', 400, mockCryptoState1);
      expect(registry.getByVhostAndSession('host1', 400)).toBeDefined();
      
      const deleted = registry.deleteByVhostAndSession('host1', 400);
      expect(deleted).toBe(true);
      expect(registry.getByVhostAndSession('host1', 400)).toBeUndefined();
    });

    it('应该返回正确的大小', () => {
      expect(registry.size).toBe(0);
      
      registry.register('host1', 1, mockCryptoState1);
      expect(registry.size).toBe(1);
      
      registry.register('host2', 1, mockCryptoState2);
      expect(registry.size).toBe(2);
      
      registry.delete('host1:1');
      expect(registry.size).toBe(1);
    });
  });

  describe('虚拟主机操作', () => {
    it('应该获取虚拟主机下的所有密钥', () => {
      registry.register('host1', 1, mockCryptoState1);
      registry.register('host1', 2, mockCryptoState2);
      registry.register('host2', 1, mockCryptoState1);
      
      const host1Keys = registry.getByVhost('host1');
      expect(host1Keys.size).toBe(2);
      expect(host1Keys.get(1)).toBe(mockCryptoState1);
      expect(host1Keys.get(2)).toBe(mockCryptoState2);
      
      const host2Keys = registry.getByVhost('host2');
      expect(host2Keys.size).toBe(1);
      expect(host2Keys.get(1)).toBe(mockCryptoState1);
    });

    it('应该清除虚拟主机的所有密钥', () => {
      registry.register('host1', 1, mockCryptoState1);
      registry.register('host1', 2, mockCryptoState2);
      registry.register('host2', 1, mockCryptoState1);
      
      const count = registry.clearVhost('host1');
      expect(count).toBe(2);
      expect(registry.size).toBe(1);
      expect(registry.get('host2:1')).toBeDefined();
    });

    it('应该获取所有虚拟主机名称', () => {
      registry.register('host1', 1, mockCryptoState1);
      registry.register('host2', 1, mockCryptoState2);
      registry.register('host2', 2, mockCryptoState1);
      
      const vhosts = registry.getAllVhosts();
      expect(vhosts.size).toBe(2);
      expect(vhosts.has('host1')).toBe(true);
      expect(vhosts.has('host2')).toBe(true);
    });
  });

  describe('统计信息', () => {
    it('应该返回正确的统计信息', () => {
      registry.register('host1', 1, mockCryptoState1);
      registry.register('host1', 2, mockCryptoState2);
      registry.register('host2', 1, mockCryptoState1);
      
      const stats = registry.getStats();
      expect(stats.totalKeys).toBe(3);
      expect(stats.vhostCount).toBe(2);
      expect(stats.vhostStats.get('host1')).toBe(2);
      expect(stats.vhostStats.get('host2')).toBe(1);
    });
  });

  describe('过期清理', () => {
    it('应该清理过期的密钥', async () => {
      vi.useFakeTimers();
      
      registry.register('host1', 1, mockCryptoState1);
      registry.register('host2', 2, mockCryptoState2);
      
      // 推进时间超过过期时间
      vi.advanceTimersByTime(1500);
      
      const cleaned = registry.cleanupExpired();
      expect(cleaned).toBe(2);
      expect(registry.size).toBe(0);
      
      vi.useRealTimers();
    });

    it('应该保留未过期的密钥', async () => {
      vi.useFakeTimers();
      
      registry.register('host1', 1, mockCryptoState1);
      
      // 推进时间但不超过过期时间
      vi.advanceTimersByTime(500);
      
      const cleaned = registry.cleanupExpired();
      expect(cleaned).toBe(0);
      expect(registry.size).toBe(1);
      
      vi.useRealTimers();
    });

    it('应该更新最后使用时间当获取密钥', async () => {
      vi.useFakeTimers();
      
      registry.register('host1', 1, mockCryptoState1);
      
      // 推进时间
      vi.advanceTimersByTime(500);
      
      // 获取密钥更新最后使用时间
      registry.get('host1:1');
      
      // 再推进时间
      vi.advanceTimersByTime(700);
      
      // 总共 1200ms 但最后使用时间是 700ms 前，应该不会被清理
      const cleaned = registry.cleanupExpired();
      expect(cleaned).toBe(0);
      expect(registry.size).toBe(1);
      
      vi.useRealTimers();
    });
  });

  describe('自动清理', () => {
    it('应该启动和停止自动清理', async () => {
      vi.useFakeTimers();
      
      registry.register('host1', 1, mockCryptoState1);
      registry.startAutoCleanup(100);
      
      // 推进时间超过过期时间
      vi.advanceTimersByTime(1500);
      
      // 应该已经自动清理
      expect(registry.size).toBe(0);
      
      registry.stopAutoCleanup();
      
      vi.useRealTimers();
    });

    it('应该不重复启动自动清理', () => {
      registry.startAutoCleanup(100);
      registry.startAutoCleanup(100);
      
      // 不应该抛出错误
      registry.stopAutoCleanup();
    });
  });

  describe('清空操作', () => {
    it('应该清空所有密钥', () => {
      registry.register('host1', 1, mockCryptoState1);
      registry.register('host2', 2, mockCryptoState2);
      
      expect(registry.size).toBe(2);
      
      registry.clear();
      expect(registry.size).toBe(0);
    });
  });

  describe('边界情况', () => {
    it('应该处理不存在的密钥', () => {
      const retrieved = registry.get('nonexistent:999');
      expect(retrieved).toBeUndefined();
    });

    it('应该处理删除不存在的密钥', () => {
      const deleted = registry.delete('nonexistent:999');
      expect(deleted).toBe(false);
    });

    it('应该处理清除空虚拟主机', () => {
      const count = registry.clearVhost('nonexistent');
      expect(count).toBe(0);
    });

    it('应该处理获取空虚拟主机的密钥', () => {
      const keys = registry.getByVhost('nonexistent');
      expect(keys.size).toBe(0);
    });
  });
});
