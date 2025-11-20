import { createLogger } from '@munode/common';
import type { HubDatabase } from './database.js';
import type { SyncBroadcaster } from './sync-broadcaster.js';

const logger = createLogger({ service: 'hub-acl-manager' });

export interface ACLData {
  id: number;
  channel_id: number;
  user_id?: number;
  group?: string;
  apply_here: boolean;
  apply_subs: boolean;
  allow: number;
  deny: number;
}

export interface CreateACLRequest {
  channel_id: number;
  user_id: number;
  group?: string;
  apply_here?: number;
  apply_subs?: number;
  allow?: number;
  deny?: number;
}

/**
 * ACL 管理器
 * 负责频道访问控制列表的管理，所有操作直接作用于数据库
 */
export class ACLManager {
  private database: HubDatabase;
  private syncBroadcaster: SyncBroadcaster;
  private aclCache: Map<number, ACLData[]> = new Map(); // key: channel_id

  constructor(database: HubDatabase, syncBroadcaster: SyncBroadcaster) {
    this.database = database;
    this.syncBroadcaster = syncBroadcaster;
  }

  /**
   * 初始化 ACL 管理器
   */
  async init(): Promise<void> {
    // 可以在这里预加载常用频道的 ACL
  }

  /**
   * 获取频道的 ACL（带缓存）
   */
  async getChannelACLs( channel_id: number): Promise<ACLData[]> {
    if (!this.aclCache.has(channel_id)) {
      const acls = await this.database.getChannelACLs(channel_id);
      this.aclCache.set(channel_id, acls);
    }
    return this.aclCache.get(channel_id);
  }

  /**
   * 添加 ACL
   */
  async addACL(request: CreateACLRequest): Promise<number> {
    const acl: Omit<ACLData, 'id'> = {
      channel_id: request.channel_id,
      user_id: request.user_id,
      group: request.group,
      apply_here: !!request.apply_here,
      apply_subs: !!request.apply_subs,
      allow: request.allow || 0,
      deny: request.deny || 0,
    };
    const id = await this.database.addACL(acl);
    this.invalidateCache(request.channel_id);

    logger.info(`ACL added: ${id} for channel ${request.channel_id}`);
    // 广播变更到 Edge Servers
    const allAcls = await this.getChannelACLs(request.channel_id);
    this.syncBroadcaster.broadcastACLUpdate(
      request.channel_id,
      allAcls.map((a) => ({
        id: a.id,
         channel_id: a.channel_id,
         user_id: a.user_id,
        group: a.group || '',
        applyHere: a.apply_here,
        applySubs: a.apply_subs,
        allow: a.allow,
        deny: a.deny,
      }))
    );

    return id;
  }

  /**
   * 更新 ACL
   */
  async updateACL(id: number, updates: Partial<Omit<ACLData, 'id' | 'channel_id'>>): Promise<void> {
    // 先获取 ACL 以确定其所属频道
    const channel_id = this.findChannelByACL(id);

    if (channel_id !== null) {
      await this.database.updateACL(id, updates);
      this.invalidateCache(channel_id);

      logger.info(`ACL updated: ${id}`, updates);
      // 广播变更到 Edge Servers
      const allAcls = await this.getChannelACLs(channel_id);
      this.syncBroadcaster.broadcastACLUpdate(
        channel_id,
        allAcls.map((a) => ({
          id: a.id,
           channel_id: a.channel_id,
           user_id: a.user_id,
          group: a.group || '',
          applyHere: a.apply_here,
          applySubs: a.apply_subs,
          allow: a.allow,
          deny: a.deny,
        }))
      );
    }
  }

  /**
   * 删除 ACL
   */
  async deleteACL(id: number): Promise<void> {
    const channel_id = this.findChannelByACL(id);

    if (channel_id !== null) {
      await this.database.deleteACL(id);
      this.invalidateCache(channel_id);

      logger.info(`ACL deleted: ${id}`);
      // 广播变更到 Edge Servers
      this.syncBroadcaster.broadcastACLDelete(id);
    }
  }

  /**
   * 批量保存ACL（清除现有ACL后保存新的）
   * 返回保存的ACL ID数组
   */
  async saveACLs(channel_id: number, acls: Omit<ACLData, 'id' | 'channel_id'>[]): Promise<number[]> {
    const aclIds: number[] = [];

    // Clear existing ACLs for this channel
    await this.database.clearChannelACLs(channel_id);
    this.invalidateCache(channel_id);

    // Save all ACLs and collect their IDs
    for (const acl of acls) {
      const aclData = {
        ...acl,
        channel_id, // Ensure channel_id is set
      };

      const aclId = await this.database.addACL(aclData);
      aclIds.push(aclId);
    }

    // Update cache with new ACLs
    const allAcls = await this.database.getChannelACLs(channel_id);
    this.aclCache.set(channel_id, allAcls);

    logger.info(`ACLs saved for channel ${channel_id}: ${acls.length} entries, IDs: ${aclIds.join(',')}`);

    // 广播变更到 Edge Servers
    this.syncBroadcaster.broadcastACLUpdate(
      channel_id,
      allAcls.map((a) => ({
        id: a.id,
         channel_id: a.channel_id,
         user_id: a.user_id,
        group: a.group || '',
        applyHere: a.apply_here,
        applySubs: a.apply_subs,
        allow: a.allow,
        deny: a.deny,
      }))
    );

    return aclIds;
  }

  /**
   * 使缓存失效
   */
  private invalidateCache( channel_id: number): void {
    this.aclCache.delete(channel_id);
  }

  /**
   * 根据 ACL ID 查找其所属频道
   */
  private findChannelByACL(aclId: number): number | null {
    // 遍历缓存查找
    for (const [channel_id, acls] of this.aclCache.entries()) {
      if (acls.some((acl) => acl.id === aclId)) {
        return channel_id;
      }
    }

    // 如果缓存中找不到，从数据库查找
    // 这需要数据库支持按 ACL ID 查询
    // 暂时返回 null，实际实现中应该添加数据库方法
    logger.warn(`Cannot find channel for ACL ${aclId}`);
    return null;
  }

  /**
   * 刷新缓存
   */
  refreshCache(): void {
    this.aclCache.clear();
  }

  /**
   * 预加载指定频道的 ACL 到缓存
   */
  async preloadChannelACLs(channelIds: number[]): Promise<void> {
    for (const channel_id of channelIds) {
      const acls = await this.database.getChannelACLs(channel_id);
      this.aclCache.set(channel_id, acls);
    }
    logger.info(`Preloaded ACLs for ${channelIds.length} channels`);
  }
}
