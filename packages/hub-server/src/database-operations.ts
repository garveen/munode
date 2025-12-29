import type { Logger, BlobStore } from '@munode/common';
import type { HubDatabase } from './database.js';


/**
 * 数据库操作接口
 */
export interface IDatabaseOperations {
  /**
   * 添加封禁记录
   */
  addBan(banData: {
    address: Buffer;
    mask: number;
    name?: string;
    hash?: string;
    reason?: string;
    start?: number;
    duration?: number;
  }): Promise<void>;

  /**
   * 获取频道信息
   */
  getChannel(channelId: number): Promise<{
    id: number;
    name: string;
    position: number;
    max_users: number;
    parent_id: number;
    inherit_acl: number;
    description_blob?: string;
  } | null>;

  /**
   * 获取子频道列表
   */
  getChildChannels(channelId: number): Promise<Array<{
    id: number;
    name: string;
    position: number;
    max_users: number;
    parent_id: number;
    inherit_acl: number;
    description_blob?: string;
  }>>;

  /**
   * 设置 BlobStore（用于延迟初始化）
   */
  setBlobStore?(blobStore: BlobStore): void;

  /**
   * 清理数据库
   */
  cleanup(): Promise<void>;

  /**
   * 获取活跃的Edge列表
   */
  getActiveEdges(): Promise<Array<{
    server_id: number;
    name: string;
    host: string;
    port: number;
    region: string;
    current_load: number;
    capacity: number;
  }>>;

  /**
   * 获取所有频道ACL
   */
  getAllChannelACLs(): Promise<Array<{
    id: number;
    channel_id: number;
    user_id?: number;
    group: string;
    apply_here: boolean;
    apply_subs: boolean;
    allow: number;
    deny: number;
  }>>;

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

    private logger: Logger;

  constructor(database: HubDatabase | undefined, logger: Logger, blobStore?: BlobStore) {
    this.logger = logger;
    this.database = database;
    this.blobStore = blobStore;
  }

  /**
   * 设置BlobStore（用于延迟初始化）
   */
  setBlobStore(blobStore: BlobStore): void {
    this.blobStore = blobStore;
  }

  async addBan(banData: {
    address: Buffer;
    mask: number;
    name?: string;
    hash?: string;
    reason?: string;
    start?: number;
    duration?: number;
  }): Promise<void> {
    if (!this.database) {
      throw new Error('Database not available');
    }

    await this.database.addBan(banData);
    this.logger.debug('Added ban record', { banData });
  }

  async getChannel(channelId: number): Promise<{
    id: number;
    name: string;
    position: number;
    max_users: number;
    parent_id: number;
    inherit_acl: number;
    description_blob?: string;
  } | null> {
    if (!this.database) {
      return null;
    }

    return await this.database.getChannel(channelId);
  }

  async getChildChannels(channelId: number): Promise<Array<{
    id: number;
    name: string;
    position: number;
    max_users: number;
    parent_id: number;
    inherit_acl: number;
    description_blob?: string;
  }>> {
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
    this.logger.debug('Database cleanup completed');
  }

  async getActiveEdges(): Promise<Array<{
    server_id: number;
    name: string;
    host: string;
    port: number;
    region: string;
    current_load: number;
    capacity: number;
  }>> {
    if (!this.database) {
      return [];
    }

    const edges = await this.database.getActiveEdges();
    // 转换 RegisteredEdge 类型为返回类型
    return edges.map(edge => ({
      server_id: edge.server_id,
      name: edge.name,
      host: edge.host,
      port: edge.port,
      region: edge.region || '',
      current_load: edge.current_load,
      capacity: edge.capacity,
    }));
  }

  async getAllChannelACLs(): Promise<Array<{
    id: number;
    channel_id: number;
    user_id?: number;
    group: string;
    apply_here: boolean;
    apply_subs: boolean;
    allow: number;
    deny: number;
  }>> {
    if (!this.database) {
      return [];
    }

    const acls = await this.database.getAllChannelACLs();
    // 转换 ACLData 类型为返回类型
    return acls.map(acl => ({
      id: acl.id,
      channel_id: acl.channel_id,
      user_id: acl.user_id,
      group: acl.group || '',
      apply_here: acl.apply_here,
      apply_subs: acl.apply_subs,
      allow: acl.allow,
      deny: acl.deny,
    }));
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
    this.logger.debug(`Set texture blob for user ${userId}: ${hash}`);
  }

  async setUserCommentBlob(userId: number, hash: string): Promise<void> {
    if (!this.database) {
      throw new Error('Database not available');
    }

    await this.database.setUserCommentBlob(userId, hash);
    this.logger.debug(`Set comment blob for user ${userId}: ${hash}`);
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