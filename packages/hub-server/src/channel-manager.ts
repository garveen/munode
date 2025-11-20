import { createLogger } from '@munode/common';
import type { HubDatabase } from './database.js';
import type { SyncBroadcaster } from './sync-broadcaster.js';

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
  private syncBroadcaster: SyncBroadcaster;
  private channelCache: Map<number, ChannelData> = new Map();

  constructor(database: HubDatabase, syncBroadcaster: SyncBroadcaster) {
    this.database = database;
    this.syncBroadcaster = syncBroadcaster;
    // 异步初始化将在外部调用
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
    const channels = await this.database.getAllChannels();
    for (const ch of channels) {
      this.channelCache.set(ch.id, ch);
    }
    logger.info(`Loaded ${channels.length} channels from database`);
  }

  /**
   * 创建频道
   */
  async createChannel(request: CreateChannelRequest): Promise<number> {
    const id = await this.database.createChannel(request);
    const created = await this.database.getChannel(id);

    if (created) {
      this.channelCache.set(id, created);
      logger.info(`Channel created: ${id} (${created.name})`);
      // 广播变更到 Edge Servers
      this.syncBroadcaster.broadcastChannelCreate({
        id: created.id,
        name: created.name,
        position: created.position,
        maxUsers: created.max_users,
         parent_id: created.parent_id,
        inheritAcl: created.inherit_acl,
        descriptionBlob: created.description_blob || '',
      });
    }

    return id;
  }

  /**
   * 更新频道
   */
  async updateChannel(id: number, updates: Partial<ChannelData>): Promise<void> {
    await this.database.updateChannel(id, updates);
    const updated = await this.database.getChannel(id);

    if (updated) {
      this.channelCache.set(id, updated);
      logger.info(`Channel updated: ${id}`, updates);
      // 广播变更到 Edge Servers
      this.syncBroadcaster.broadcastChannelUpdate({
        id: updated.id,
        name: updated.name,
        position: updated.position,
        maxUsers: updated.max_users,
         parent_id: updated.parent_id,
        inheritAcl: updated.inherit_acl,
        descriptionBlob: updated.description_blob || '',
      });
    }
  }

  /**
   * 删除频道
   */
  async deleteChannel(id: number): Promise<void> {
    await this.database.deleteChannel(id);
    this.channelCache.delete(id);
    logger.info(`Channel deleted: ${id}`);
    // 广播变更到 Edge Servers
    this.syncBroadcaster.broadcastChannelDelete(id);
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
    return await this.database.getChildChannels(parent_id);
  }

  /**
   * 链接两个频道
   */
  async linkChannels( channel_id: number,  target_id: number): Promise<void> {
    await this.database.linkChannels(channel_id, target_id);
    logger.info(`Channels linked: ${channel_id} <-> ${target_id}`);
    // 广播变更到 Edge Servers
    this.syncBroadcaster.broadcastChannelLink(channel_id, target_id);
  }

  /**
   * 取消链接两个频道
   */
  async unlinkChannels( channel_id: number,  target_id: number): Promise<void> {
    await this.database.unlinkChannels(channel_id, target_id);
    logger.info(`Channels unlinked: ${channel_id} <-> ${target_id}`);
    // 广播变更到 Edge Servers
    this.syncBroadcaster.broadcastChannelUnlink(channel_id, target_id);
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
