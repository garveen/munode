import { createHash } from 'crypto';
import { promises as fs, constants } from 'fs';
import * as path from 'path';
import { createLogger } from './logger/logger.js';

const logger = createLogger({ service: 'blob-store' });

/**
 * 内容可寻址的 Blob 存储
 * 使用 SHA1 作为 key，文件系统作为持久化存储
 * 
 * 目录结构：
 * blobstore/
 *   2a/
 *     2aae6c35c94fcfb415dbe95f408b9ce91ee846ed
 *   b4/
 *     b45cffe084dd3d20d928bee85e7b0f21
 * 
 * 与 Go 实现的 blobstore 兼容
 */
export class BlobStore {
  private dir: string;
  private enabled: boolean;

  /**
   * 创建 BlobStore 实例
   * @param dir - blob 存储目录
   * @param enabled - 是否启用 blob 存储
   */
  constructor(dir: string, enabled = true) {
    this.dir = dir;
    this.enabled = enabled;
  }

  /**
   * 初始化 BlobStore，确保目录存在
   */
  async init(): Promise<void> {
    if (!this.enabled) {
      logger.info('BlobStore is disabled');
      return;
    }

    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o750 });
      logger.info(`BlobStore initialized at ${this.dir}`);
    } catch (error) {
      logger.error('Failed to initialize BlobStore:', error);
      throw error;
    }
  }

  /**
   * 检查 BlobStore 是否启用
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 存储 blob 数据，返回 SHA1 hash 作为 key
   * @param data - 要存储的数据
   * @returns SHA1 hash (40位十六进制字符串)
   */
  async put(data: Buffer): Promise<string> {
    if (!this.enabled) {
      throw new Error('BlobStore is disabled');
    }

    // 计算 SHA1 hash
    const hash = createHash('sha1');
    hash.update(data);
    const key = hash.digest('hex');

    // 检查是否已存在
    const exists = await this.exists(key);
    if (exists) {
      logger.debug(`Blob ${key} already exists`);
      return key;
    }

    // 创建子目录（前两位字符）
    const subdir = key.substring(0, 2);
    const blobdir = path.join(this.dir, subdir);
    
    try {
      await fs.mkdir(blobdir, { recursive: true, mode: 0o750 });
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }

    // 写入临时文件
    const blobpath = path.join(blobdir, key);
    const tmppath = `${blobpath}.tmp.${Date.now()}`;

    try {
      await fs.writeFile(tmppath, data, { mode: 0o640 });
      
      // 原子性重命名
      await fs.rename(tmppath, blobpath);
      
      logger.debug(`Blob stored: ${key} (${data.length} bytes)`);
      return key;
    } catch (error) {
      // 清理临时文件
      try {
        await fs.unlink(tmppath);
      } catch {
        // 忽略清理错误
      }
      throw error;
    }
  }

  /**
   * 获取 blob 数据
   * @param key - SHA1 hash
   * @returns blob 数据，如果不存在返回 null
   */
  async get(key: string): Promise<Buffer | null> {
    if (!this.enabled) {
      throw new Error('BlobStore is disabled');
    }

    if (!this.isValidKey(key)) {
      logger.warn(`Invalid blob key: ${key}`);
      return null;
    }

    const subdir = key.substring(0, 2);
    const blobpath = path.join(this.dir, subdir, key);

    try {
      const data = await fs.readFile(blobpath);
      
      // 验证 SHA1
      const hash = createHash('sha1');
      hash.update(data);
      const actualKey = hash.digest('hex');
      
      if (actualKey !== key) {
        logger.error(`Blob corruption detected: ${key} (actual: ${actualKey})`);
        return null;
      }

      logger.debug(`Blob retrieved: ${key} (${data.length} bytes)`);
      return data;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        logger.debug(`Blob not found: ${key}`);
        return null;
      }
      logger.error(`Error reading blob ${key}:`, error);
      throw error;
    }
  }

  /**
   * 检查 blob 是否存在
   * @param key - SHA1 hash
   * @returns 是否存在
   */
  async exists(key: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    if (!this.isValidKey(key)) {
      return false;
    }

    const subdir = key.substring(0, 2);
    const blobpath = path.join(this.dir, subdir, key);

    try {
      await fs.access(blobpath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除 blob
   * @param key - SHA1 hash
   * @returns 是否成功删除
   */
  async delete(key: string): Promise<boolean> {
    if (!this.enabled) {
      throw new Error('BlobStore is disabled');
    }

    if (!this.isValidKey(key)) {
      return false;
    }

    const subdir = key.substring(0, 2);
    const blobpath = path.join(this.dir, subdir, key);

    try {
      await fs.unlink(blobpath);
      logger.debug(`Blob deleted: ${key}`);
      return true;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return false;
      }
      logger.error(`Error deleting blob ${key}:`, error);
      throw error;
    }
  }

  /**
   * 验证 key 格式是否正确
   * @param key - SHA1 hash
   * @returns 是否有效
   */
  private isValidKey(key: string): boolean {
    // SHA1 hash 是40位十六进制字符串
    return /^[0-9a-f]{40}$/i.test(key);
  }

  /**
   * 获取存储统计信息
   */
  async getStats(): Promise<{
    enabled: boolean;
    totalBlobs?: number;
    totalSize?: number;
  }> {
    if (!this.enabled) {
      return { enabled: false };
    }

    try {
      let totalBlobs = 0;
      let totalSize = 0;

      const subdirs = await fs.readdir(this.dir);
      for (const subdir of subdirs) {
        if (!/^[0-9a-f]{2}$/i.test(subdir)) {
          continue;
        }

        const subdirPath = path.join(this.dir, subdir);
        const files = await fs.readdir(subdirPath);
        
        for (const file of files) {
          if (this.isValidKey(file)) {
            const filePath = path.join(subdirPath, file);
            const stat = await fs.stat(filePath);
            totalBlobs++;
            totalSize += stat.size;
          }
        }
      }

      return {
        enabled: true,
        totalBlobs,
        totalSize,
      };
    } catch (error) {
      logger.error('Error getting blob stats:', error);
      return { enabled: true, totalBlobs: 0, totalSize: 0 };
    }
  }
}
