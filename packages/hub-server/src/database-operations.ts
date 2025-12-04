import { createLogger, type BlobStore } from '@munode/common';
import type { HubDatabase } from './database.js';

const logger = createLogger({ service: 'hub-database-operations' });

/**
 * 数据库操作接口
 */
export interface IDatabaseOperations {
  /**
   * 添加封禁记录
   */
  addBan(banData: any): Promise<void>;

  /**
   * 获取频道信息
   */
  getChannel(channelId: number): Promise<any | null>;

  /**
   * 获取子频道列表
   */
  getChildChannels(channelId: number): Promise<any[]>;

  /**
   * 清理数据库
   */
  cleanup(): Promise<void>;

  /**
   * 获取活跃的Edge列表
   */
  getActiveEdges(): Promise<any[]>;

  /**
   * 获取所有频道ACL
   */
  getAllChannelACLs(): Promise<any[]>;

  /**
   * 获取用户纹理blob
   */
  getUserTextureBlob(userId: number): Promise<string | null>;

  /**
   * 获取用户评论blob
   */
  getUserCommentBlob(userId: number): Promise<string | null>;

  /**
   * 设置用户纹理blob
   */
  setUserTextureBlob(userId: number, hash: string): Promise<void>;

  /**
   * 设置用户评论blob
   */
  setUserCommentBlob(userId: number, hash: string): Promise<void>;

  /**
   * 获取blob数据
   */
  getBlobData(hash: string): Promise<Buffer | null>;

  /**
   * 存储blob数据
   */
  putBlobData(data: Buffer): Promise<string>;
}

/**
 * 数据库操作封装类
 */
export class DatabaseOperations implements IDatabaseOperations {
  private database?: HubDatabase;
  private blobStore?: BlobStore;

  constructor(database?: HubDatabase, blobStore?: BlobStore) {
    this.database = database;
    this.blobStore = blobStore;
  }

  async addBan(banData: any): Promise<void> {
    if (!this.database) {
      throw new Error('Database not available');
    }

    await this.database.addBan(banData);
    logger.debug('Added ban record', { banData });
  }

  async getChannel(channelId: number): Promise<any | null> {
    if (!this.database) {
      return null;
    }

    return await this.database.getChannel(channelId);
  }

  async getChildChannels(channelId: number): Promise<any[]> {
    if (!this.database) {
      return [];
    }

    return await this.database.getChildChannels(channelId);
  }

  async cleanup(): Promise<void> {
    if (!this.database) {
      return;
    }

    await this.database.cleanup();
    logger.debug('Database cleanup completed');
  }

  async getActiveEdges(): Promise<any[]> {
    if (!this.database) {
      return [];
    }

    return await this.database.getActiveEdges();
  }

  async getAllChannelACLs(): Promise<any[]> {
    if (!this.database) {
      return [];
    }

    return await this.database.getAllChannelACLs();
  }

  async getUserTextureBlob(userId: number): Promise<string | null> {
    if (!this.database) {
      throw new Error('Database not available');
    }

    return await this.database.getUserTextureBlob(userId);
  }

  async getUserCommentBlob(userId: number): Promise<string | null> {
    if (!this.database) {
      throw new Error('Database not available');
    }

    return await this.database.getUserCommentBlob(userId);
  }

  async setUserTextureBlob(userId: number, hash: string): Promise<void> {
    if (!this.database) {
      throw new Error('Database not available');
    }

    await this.database.setUserTextureBlob(userId, hash);
    logger.debug(`Set texture blob for user ${userId}: ${hash}`);
  }

  async setUserCommentBlob(userId: number, hash: string): Promise<void> {
    if (!this.database) {
      throw new Error('Database not available');
    }

    await this.database.setUserCommentBlob(userId, hash);
    logger.debug(`Set comment blob for user ${userId}: ${hash}`);
  }

  /**
   * 获取blob数据
   */
  async getBlobData(hash: string): Promise<Buffer | null> {
    if (!this.blobStore) {
      return null;
    }

    return await this.blobStore.get(hash);
  }

  /**
   * 存储blob数据
   */
  async putBlobData(data: Buffer): Promise<string> {
    if (!this.blobStore) {
      throw new Error('BlobStore not available');
    }

    return await this.blobStore.put(data);
  }
}