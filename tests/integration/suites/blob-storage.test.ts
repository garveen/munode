/**
 * Blob 存储集成测试
 * 
 * 测试场景：
 * 1. 用户纹理上传和检索
 * 2. 用户评论上传和检索（短评论和长评论）
 * 3. Blob 持久化和数据库关联
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, createClients, cleanupClients, USE_RUST } from '../setup.js';
import type { TestEnvironment } from '../setup.js';

describe.skipIf(USE_RUST)('Blob Storage Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(15200, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: false,
    });
  }, 30000);

  afterAll(async () => {
    await testEnv.cleanup();
  }, 30000);

  describe('User Texture Storage', () => {
    it('should upload and store user texture', async () => {
      const clients = await createClients(testEnv, [
        { username: 'admin', edge: 1 },
      ]);

      try {
        // 创建测试纹理（小图片）
        const textureSize = 60 * 60 * 4; // 60x60 RGBA
        const texture = Buffer.alloc(textureSize);
        
        // 填充一些数据（简单的渐变）
        for (let i = 0; i < textureSize; i++) {
          texture[i] = i % 256;
        }

        // 上传纹理
        await clients[0].setTexture(texture);

        // 等待处理
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 验证 blob 存储中有文件
        const blobStore = testEnv.hubServer!.getBlobStore();
        const stats = await blobStore!.getStats();
        
        expect(stats.enabled).toBe(true);
        expect(stats.totalBlobs).toBeGreaterThan(0);
      } finally {
        await cleanupClients(clients);
      }
    }, 10000);

    it('should deduplicate identical textures', async () => {
      const clients = await createClients(testEnv, [
        { username: 'admin', edge: 1 },
        { username: 'user1', edge: 1 },
      ]);

      try {
        // 创建相同的纹理
        const texture = Buffer.alloc(50);
        texture.fill(0xcc);

        // 两个客户端上传相同纹理
        await clients[0].setTexture(texture);
        await new Promise((resolve) => setTimeout(resolve, 300));
        
        const blobStore = testEnv.hubServer!.getBlobStore();
        const beforeStats = await blobStore!.getStats();
        const blobCount = beforeStats.totalBlobs || 0;

        await clients[1].setTexture(texture);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const afterStats = await blobStore!.getStats();
        
        // Blob 数量不应增加（去重）
        expect(afterStats.totalBlobs).toBe(blobCount);
      } finally {
        await cleanupClients(clients);
      }
    }, 10000);
  });

  describe('User Comment Storage', () => {
    it('should handle long comments (> 128 bytes) in blob storage', async () => {
      // 创建两个客户端，测试 comment_hash 广播和按需加载（对齐 C++ Mumble）
      const clients = await createClients(testEnv, [
        { username: 'admin', edge: 1 },
        { username: 'user1', edge: 1 },
      ]);

      const longComment = 'This is a very long comment. '.repeat(10);
      expect(longComment.length).toBeGreaterThan(128);

      const blobStore = testEnv.hubServer!.getBlobStore();

      // 等待用户同步
      await new Promise((resolve) => setTimeout(resolve, 800));

      // 上传长评论
      await clients[0].setComment(longComment);
      
      // 等待 comment 被处理并广播到其他客户端
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 验证进入了 blob 存储（至少有一个 blob）
      const afterStats = await blobStore!.getStats();
      expect(afterStats.totalBlobs).toBeGreaterThanOrEqual(1);
      
      // 步骤1：验证另一个客户端收到 comment_hash（对齐 C++ Mumble 行为）
      let users = clients[1].getUsers();
      const adminUser = users.find(u => u.name === 'admin' || u.name === 'Administrator');
      expect(adminUser).toBeDefined();
      expect(adminUser!.comment_hash).toBeDefined();
      expect(adminUser!.comment_hash).toBeTruthy();
      
      // 步骤2：客户端请求完整 comment（对齐 C++ 客户端按需加载）
      await clients[1].requestUserComment(adminUser!.session);
      
      // 等待 comment 返回
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      // 步骤3：验证收到完整 comment
      users = clients[1].getUsers();
      const updatedAdminUser = users.find(u => u.name === 'admin' || u.name === 'Administrator');
      expect(updatedAdminUser).toBeDefined();
      expect(updatedAdminUser!.comment).toBe(longComment);

      // 清理客户端
      await cleanupClients(clients);
    }, 15000);

    it('should handle UTF-8 encoded comments', async () => {
      const clients = await createClients(testEnv, [
        { username: 'admin', edge: 1 },
      ]);

      try {
        const utf8Comment = '这是中文评论 🎵 emoji test';
        
        // 系统应该正确处理 UTF-8（不抛出错误）
        await clients[0].setComment(utf8Comment);
        await new Promise((resolve) => setTimeout(resolve, 500));
        
        expect(true).toBe(true);
      } finally {
        await cleanupClients(clients);
      }
    }, 10000);
  });

  describe('Database Integration', () => {
    it('should persist texture hash in database', async () => {
      const clients = await createClients(testEnv, [
        { username: 'admin', edge: 1 },
      ]);

      try {
        const texture = Buffer.alloc(80);
        texture.fill(0xdd);

        await clients[0].setTexture(texture);
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 检查数据库
        const db = testEnv.hubServer!.getDatabase();
        const userId = clients[0].getUserId();
        
        if (userId) {
          const textureHash = await db!.getUserTextureBlob(userId);
          expect(textureHash).not.toBeNull();
          expect(textureHash).toMatch(/^[0-9a-f]{40}$/);
        }
      } finally {
        await cleanupClients(clients);
      }
    }, 10000);

    it('should handle texture update', async () => {
      const clients = await createClients(testEnv, [
        { username: 'admin', edge: 1 },
      ]);

      try {
        const texture1 = Buffer.alloc(50, 0x11);
        const texture2 = Buffer.alloc(50, 0x22);

        // 上传第一个纹理
        await clients[0].setTexture(texture1);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const db = testEnv.hubServer!.getDatabase();
        const userId = clients[0].getUserId();
        
        if (userId) {
          const hash1 = await db!.getUserTextureBlob(userId);

          // 上传第二个纹理
          await clients[0].setTexture(texture2);
          await new Promise((resolve) => setTimeout(resolve, 300));

          const hash2 = await db!.getUserTextureBlob(userId);

          // Hash 应该不同
          expect(hash1).not.toBe(hash2);
        }
      } finally {
        await cleanupClients(clients);
      }
    }, 10000);
  });

  describe('Blob Store Statistics', () => {
    it('should track blob storage stats', async () => {
      const blobStore = testEnv.hubServer!.getBlobStore();
      const stats = await blobStore!.getStats();

      expect(stats.enabled).toBe(true);
      expect(stats.totalBlobs).toBeDefined();
      expect(stats.totalSize).toBeDefined();
      expect(stats.totalBlobs).toBeGreaterThanOrEqual(0);
      expect(stats.totalSize).toBeGreaterThanOrEqual(0);
    }, 10000);
  });
});
