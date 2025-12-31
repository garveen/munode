import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CryptoWorkerPool } from '@munode/edge-server';
import type { CryptoWorkerPoolConfig } from '@munode/edge-server';
import { Logger, createLogger } from '@munode/common';

describe('CryptoWorkerPool', () => {
  let pool: CryptoWorkerPool;
  let logger: Logger;

  beforeAll(() => {
    logger = createLogger({ level: 'silent', service: 'test' });
  });

  afterEach(async () => {
    if (pool) {
      await pool.cleanup();
    }
  });

  describe('初始化', () => {
    it('应该创建指定数量的 Worker', async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 2,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
      
      expect(pool.workerCount).toBe(2);
    });

    it('应该处理多个 Worker 的初始化', async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 4,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
      
      expect(pool.workerCount).toBe(4);
    }, 10000);
  });

  describe('加密/解密操作', () => {
    beforeEach(async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 2,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
    });

    it('应该设置加密密钥', async () => {
      const key = Buffer.alloc(16, 1);
      const iv = Buffer.alloc(16, 0);
      
      await pool.setKey('vhost1:100', key, iv, iv);
      
      // 验证密钥已设置 - 尝试加密应该成功
      const encrypted = await pool.encrypt('vhost1:100', Buffer.from('test'));
      expect(encrypted).toBeInstanceOf(Buffer);
    });

    it('应该加密数据', async () => {
      const key = Buffer.alloc(16, 1);
      const iv = Buffer.alloc(16, 0);
      
      await pool.setKey('vhost1:100', key, iv, iv);
      
      const plaintext = Buffer.from('Hello, World!');
      const encrypted = await pool.encrypt('vhost1:100', plaintext);
      
      expect(encrypted).toBeInstanceOf(Buffer);
      expect(encrypted.length).toBeGreaterThan(0);
    });

    it('应该解密数据', async () => {
      const key = Buffer.alloc(16, 1);
      const iv = Buffer.alloc(16, 0);
      
      await pool.setKey('vhost1:100', key, iv, iv);
      
      const plaintext = Buffer.from('Hello, World!');
      const encrypted = await pool.encrypt('vhost1:100', plaintext);
      const result = await pool.decrypt('vhost1:100', encrypted);
      
      expect(result.valid).toBe(true);
      expect(result.plain.toString()).toBe(plaintext.toString());
    });

    it('应该处理多个会话', async () => {
      const key1 = Buffer.alloc(16, 1);
      const key2 = Buffer.alloc(16, 2);
      const iv = Buffer.alloc(16, 0);
      
      await pool.setKey('vhost1:100', key1, iv, iv);
      await pool.setKey('vhost1:200', key2, iv, iv);
      
      const data1 = Buffer.from('Session 100');
      const data2 = Buffer.from('Session 200');
      
      const [enc1, enc2] = await Promise.all([
        pool.encrypt('vhost1:100', data1),
        pool.encrypt('vhost1:200', data2),
      ]);
      
      expect(enc1).toBeInstanceOf(Buffer);
      expect(enc2).toBeInstanceOf(Buffer);
    });
  });

  describe('负载均衡', () => {
    it('应该将会话分布到多个 Worker', async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 2,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
      
      const key = Buffer.alloc(16, 1);
      const iv = Buffer.alloc(16, 0);
      
      // 设置多个不同的会话
      await pool.setKey('vhost1:1', key, iv, iv);
      await pool.setKey('vhost1:2', key, iv, iv);
      await pool.setKey('vhost1:3', key, iv, iv);
      await pool.setKey('vhost1:4', key, iv, iv);
      
      const stats = await pool.getStats();
      expect(stats.length).toBe(2);
      
      // 验证会话已分布到两个 Worker
      const totalSessions = stats.reduce((sum, s) => sum + s.sessionsCount, 0);
      expect(totalSessions).toBe(4);
      
      // 验证每个 Worker 至少处理了1个会话（负载均衡）
      expect(stats.every(s => s.sessionsCount > 0)).toBe(true);
    });

    it('应该为同一会话使用相同的 Worker', async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 3,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
      
      const key = Buffer.alloc(16, 1);
      const iv = Buffer.alloc(16, 0);
      
      // 设置密钥
      await pool.setKey('vhost1:100', key, iv, iv);
      
      // 多次加密操作应该都成功（证明使用了同一个 Worker）
      for (let i = 0; i < 10; i++) {
        const plaintext = Buffer.from(`Message ${i}`);
        const encrypted = await pool.encrypt('vhost1:100', plaintext);
        const result = await pool.decrypt('vhost1:100', encrypted);
        
        expect(result.valid).toBe(true);
        expect(result.plain.toString()).toBe(plaintext.toString());
      }
    });
  });

  describe('会话管理', () => {
    beforeEach(async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 2,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
    });

    it('应该移除会话', async () => {
      const key = Buffer.alloc(16, 1);
      const iv = Buffer.alloc(16, 0);
      
      await pool.setKey('vhost1:100', key, iv, iv);
      
      // 验证密钥已设置
      const encrypted = await pool.encrypt('vhost1:100', Buffer.from('test'));
      expect(encrypted).toBeInstanceOf(Buffer);
      
      // 移除会话
      await pool.removeSession('vhost1:100');
      
      // 移除后应该无法加密
      await expect(
        pool.encrypt('vhost1:100', Buffer.from('test'))
      ).rejects.toThrow();
    });
  });

  describe('统计信息', () => {
    beforeEach(async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 2,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
    });

    it('应该获取统计信息', async () => {
      const stats = await pool.getStats();
      
      expect(stats).toBeInstanceOf(Array);
      expect(stats.length).toBe(2);
      
      for (const stat of stats) {
        expect(stat).toHaveProperty('workerId');
        expect(stat).toHaveProperty('sessionsCount');
        expect(stat).toHaveProperty('encryptCount');
        expect(stat).toHaveProperty('decryptCount');
        expect(stat).toHaveProperty('errorCount');
        expect(stat).toHaveProperty('uptime');
      }
    });

    it('应该统计加密/解密操作', async () => {
      const key = Buffer.alloc(16, 1);
      const iv = Buffer.alloc(16, 0);
      
      await pool.setKey('vhost1:100', key, iv, iv);
      
      const data = Buffer.from('test');
      await pool.encrypt('vhost1:100', data);
      await pool.encrypt('vhost1:100', data);
      
      const stats = await pool.getStats();
      const totalEncrypts = stats.reduce((sum, s) => sum + s.encryptCount, 0);
      
      expect(totalEncrypts).toBeGreaterThanOrEqual(2);
    });
  });

  describe('清理', () => {
    it('应该清理所有 Worker', async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 2,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
      
      expect(pool.workerCount).toBe(2);
      
      await pool.cleanup();
      
      expect(pool.workerCount).toBe(0);
      expect(pool.queueLength).toBe(0);
    });
  });

  describe('错误处理', () => {
    beforeEach(async () => {
      const config: CryptoWorkerPoolConfig = {
        workerCount: 1,
        workerTimeout: 1000,
      };
      
      pool = new CryptoWorkerPool(config, logger);
      await pool.initialize();
    });

    it('应该处理不存在的会话', async () => {
      await expect(
        pool.encrypt('nonexistent:999', Buffer.from('test'))
      ).rejects.toThrow();
    });

    it('应该处理无效操作', async () => {
      const key = Buffer.alloc(16, 1);
      const iv = Buffer.alloc(16, 0);
      
      await pool.setKey('vhost1:100', key, iv, iv);
      
      // 尝试解密无效数据
      const result = await pool.decrypt('vhost1:100', Buffer.from('invalid'));
      expect(result.valid).toBe(false);
    });
  });
});
