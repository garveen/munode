import type { Logger } from '@munode/common';
import type { HubDatabase } from './database.js';
import type { ACLData } from '@munode/protocol';

// Use ACLData from protocol directly - it has all fields we need
// (id, channel_id, user_id, group, apply_here, apply_subs, allow, deny)

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
  private aclCache: Map<number, ACLData[]> = new Map(); // key: channel_id
  private allACLsCache: ACLData[] | null = null;  // 全量 ACL 缓存

    private logger: Logger;

  constructor(database: HubDatabase, logger: Logger) {
    this.logger = logger;
    this.database = database;
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
   * 获取全部频道的 ACL（带全量缓存）
   * 每次任意频道 ACL 发生变更时，缓存会被清除，下次调用时重新从 DB 加载。
   */
  async getAllChannelACLs(): Promise<ACLData[]> {
    if (this.allACLsCache === null) {
      this.allACLsCache = await this.database.getAllChannelACLs();
    }
    return this.allACLsCache;
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

    this.logger.info(`ACL added: ${id} for channel ${request.channel_id}`);
    // 广播变更到 Edge Servers
    await this.getChannelACLs(request.channel_id);

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

    this.logger.info(`ACL updated: ${id}`, updates);
      // 广播变更到 Edge Servers
      await this.getChannelACLs(channel_id);
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

    this.logger.info(`ACL deleted: ${id}`);
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

    this.logger.info(`ACLs saved for channel ${channel_id}: ${acls.length} entries, IDs: ${aclIds.join(',')}`);
    return aclIds;
  }

  /**
   * 使缓存失效
   */
  private invalidateCache( channel_id: number): void {
    this.aclCache.delete(channel_id);
    this.allACLsCache = null;  // 全量缓存同步失效
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
    this.logger.warn(`Cannot find channel for ACL ${aclId}`);
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
    this.logger.info(`Preloaded ACLs for ${channelIds.length} channels`);
  }
}
