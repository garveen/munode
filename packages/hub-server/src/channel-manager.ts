import { createLogger } from '@munode/common';
import type { HubDatabase } from './database.js';

const logger = createLogger({ service: 'hub-channel-manager' });

export interface ChannelData {
  id: number;
  name: string;
  position: number;
  max_users: number;
  parent_id: number;
  inherit_acl: boolean;
  description_blob?: string;
}

export interface CreateChannelRequest {
  name: string;
  position?: number;
  max_users?: number;
  parent_id?: number;
  inherit_acl?: boolean;
  description_blob?: string;
}

/**
 * 频道管理器
 * 负责频道的创建、更新、删除和查询，所有操作直接作用于数据库
 */
export class ChannelManager {
  private database: HubDatabase;
  private channelCache: Map<number, ChannelData> = new Map();

  constructor(database: HubDatabase) {
    this.database = database;
  }

  /**
   * 初始化频道管理器
   */
  async init(): Promise<void> {
    await this.loadChannels();
  }

  /**
   * 从数据库加载所有频道到缓存
   */
  private async loadChannels(): Promise<void> {
    const dbChannels = await this.database.getAllChannels();
    for (const ch of dbChannels) {
      const channelData: ChannelData = {
        id: ch.id,
        name: ch.name,
        parent_id: ch.parent_id,
        position: ch.position,
        max_users: ch.max_users,
        inherit_acl: Boolean(ch.inherit_acl), // 确保是布尔类型
        description_blob: ch.description_blob,
      };
      this.channelCache.set(ch.id, channelData);
    }
    logger.info(`Loaded ${dbChannels.length} channels from database`);
  }

  /**
   * 创建频道
   */
  async createChannel(request: CreateChannelRequest): Promise<number> {
    const id = await this.database.createChannel(request);
    const dbCreated = await this.database.getChannel(id);

    if (dbCreated) {
      const created: ChannelData = {
        id: dbCreated.id,
        name: dbCreated.name,
        parent_id: dbCreated.parent_id,
        position: dbCreated.position,
        max_users: dbCreated.max_users,
        inherit_acl: dbCreated.inherit_acl === 1,
        description_blob: dbCreated.description_blob,
      };
      this.channelCache.set(id, created);
      logger.info(`Channel created: ${id} (${created.name})`);
    }

    return id;
  }

  /**
   * 更新频道
   */
  async updateChannel(id: number, updates: Partial<ChannelData>): Promise<void> {
    await this.database.updateChannel(id, updates);
    const dbUpdated = await this.database.getChannel(id);

    if (dbUpdated) {
      const updated: ChannelData = {
        id: dbUpdated.id,
        name: dbUpdated.name,
        parent_id: dbUpdated.parent_id,
        position: dbUpdated.position,
        max_users: dbUpdated.max_users,
        inherit_acl: dbUpdated.inherit_acl === 1,
        description_blob: dbUpdated.description_blob,
      };
      this.channelCache.set(id, updated);
      logger.info(`Channel updated: ${id}`, updates);
    }
  }

  /**
   * 删除频道
   */
  async deleteChannel(id: number): Promise<void> {
    await this.database.deleteChannel(id);
    this.channelCache.delete(id);
    logger.info(`Channel deleted: ${id}`);
  }

  /**
   * 获取频道（从缓存）
   */
  getChannel(id: number): ChannelData | undefined {
    return this.channelCache.get(id);
  }

  /**
   * 获取所有频道
   */
  getAllChannels(): ChannelData[] {
    return Array.from(this.channelCache.values());
  }

  /**
   * 获取子频道
   */
  async getChildChannels( parent_id: number): Promise<ChannelData[]> {
    const dbChannels = await this.database.getChildChannels(parent_id);
    return dbChannels.map(ch => ({
      id: ch.id,
      name: ch.name,
      parent_id: ch.parent_id,
      position: ch.position,
      max_users: ch.max_users,
      inherit_acl: ch.inherit_acl === 1,
      description_blob: ch.description_blob,
    }));
  }

  /**
   * 链接两个频道
   */
  async linkChannels( channel_id: number,  target_id: number): Promise<void> {
    await this.database.linkChannels(channel_id, target_id);
    logger.info(`Channels linked: ${channel_id} <-> ${target_id}`);
  }

  /**
   * 取消链接两个频道
   */
  async unlinkChannels( channel_id: number,  target_id: number): Promise<void> {
    await this.database.unlinkChannels(channel_id, target_id);
    logger.info(`Channels unlinked: ${channel_id} <-> ${target_id}`);
  }

  /**
   * 获取频道链接
   */
  async getChannelLinks( channel_id: number): Promise<number[]> {
    return await this.database.getChannelLinks(channel_id);
  }

  /**
   * 刷新缓存（重新加载所有频道）
   */
  async refreshCache(): Promise<void> {
    this.channelCache.clear();
    await this.loadChannels();
  }
}
