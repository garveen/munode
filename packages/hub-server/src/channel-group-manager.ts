import { createLogger } from '@munode/common';
import type { HubDatabase } from './database.js';
import type { SyncBroadcaster } from './sync-broadcaster.js';

const logger = createLogger({ service: 'hub-channel-group-manager' });

/**
 * 频道组数据
 */
export interface ChannelGroupData {
  id: number;
  channel_id: number;
  name: string;
  inherit: boolean;
  inheritable: boolean;
}

/**
 * 频道组成员数据
 */
export interface ChannelGroupMemberData {
  id: number;
  channel_group_id: number;
  user_id: number;
  is_add: boolean; // true = add, false = remove
}

/**
 * 创建频道组请求
 */
export interface CreateChannelGroupRequest {
  channel_id: number;
  name: string;
  inherit?: boolean;
  inheritable?: boolean;
  add_members?: number[];
  remove_members?: number[];
}

/**
 * 更新频道组请求
 */
export interface UpdateChannelGroupRequest {
  name?: string;
  inherit?: boolean;
  inheritable?: boolean;
  add_members?: number[];
  remove_members?: number[];
}

/**
 * 完整的频道组信息（包含成员和继承的成员）
 */
export interface FullChannelGroupInfo extends ChannelGroupData {
  add_members: number[];
  remove_members: number[];
  inherited_members: number[];
}

/**
 * 频道组管理器
 * 负责频道组的管理，包括组的创建、更新、删除以及成员管理
 */
export class ChannelGroupManager {
  private database: HubDatabase;
  private syncBroadcaster: SyncBroadcaster;
  private channelGroupCache: Map<number, Map<string, FullChannelGroupInfo>> = new Map(); // channel_id -> channel_group_name -> ChannelGroupInfo

  constructor(database: HubDatabase, syncBroadcaster: SyncBroadcaster) {
    this.database = database;
    this.syncBroadcaster = syncBroadcaster;
  }

  /**
   * 初始化频道组管理器
   */
  async init(): Promise<void> {
    logger.info('ChannelGroupManager initialized');
  }

  /**
   * 获取频道的所有频道组（包括继承的）
   */
  async getChannelGroups(channel_id: number, includeInherited: boolean = true): Promise<FullChannelGroupInfo[]> {
    const cacheKey = channel_id;
    
    if (!this.channelGroupCache.has(cacheKey)) {
      await this.loadChannelGroups(channel_id);
    }

    const channelGroupMap = this.channelGroupCache.get(cacheKey);
    if (!channelGroupMap) {
      return [];
    }

    const channelGroups = Array.from(channelGroupMap.values());
    
    if (!includeInherited) {
      return channelGroups.filter(g => g.channel_id === channel_id);
    }

    return channelGroups;
  }

  /**
   * 获取特定频道组
   */
  async getChannelGroup(channel_id: number, channelGroupName: string): Promise<FullChannelGroupInfo | null> {
    const channelGroups = await this.getChannelGroups(channel_id);
    return channelGroups.find(g => g.name === channelGroupName) || null;
  }

  /**
   * 创建频道组
   */
  async createChannelGroup(request: CreateChannelGroupRequest): Promise<number> {
    const channelGroup: Omit<ChannelGroupData, 'id'> = {
      channel_id: request.channel_id,
      name: request.name,
      inherit: request.inherit !== undefined ? request.inherit : true,
      inheritable: request.inheritable !== undefined ? request.inheritable : true,
    };

    const channelGroupId = await this.database.addChannelGroup(channelGroup);

    // 添加成员
    if (request.add_members && request.add_members.length > 0) {
      for (const userId of request.add_members) {
        await this.database.addChannelGroupMember({
          channel_group_id: channelGroupId,
          user_id: userId,
          is_add: true,
        });
      }
    }

    // 添加移除的成员
    if (request.remove_members && request.remove_members.length > 0) {
      for (const userId of request.remove_members) {
        await this.database.addChannelGroupMember({
          channel_group_id: channelGroupId,
          user_id: userId,
          is_add: false,
        });
      }
    }

    // 清除缓存
    this.invalidateCache(request.channel_id);

    logger.info(`Channel group created: ${request.name} in channel ${request.channel_id}`);

    // 广播组变更
    await this.broadcastChannelGroupUpdate(request.channel_id);

    return channelGroupId;
  }

  /**
   * 更新频道组
   */
  async updateChannelGroup(channel_id: number, channelGroupName: string, updates: UpdateChannelGroupRequest): Promise<void> {
    const channelGroup = await this.getChannelGroup(channel_id, channelGroupName);
    if (!channelGroup) {
      throw new Error(`Channel group ${channelGroupName} not found in channel ${channel_id}`);
    }

    // 更新组属性
    const channelGroupUpdates: Partial<Omit<ChannelGroupData, 'id' | 'channel_id'>> = {};
    if (updates.name !== undefined) channelGroupUpdates.name = updates.name;
    if (updates.inherit !== undefined) channelGroupUpdates.inherit = updates.inherit;
    if (updates.inheritable !== undefined) channelGroupUpdates.inheritable = updates.inheritable;

    if (Object.keys(channelGroupUpdates).length > 0) {
      await this.database.updateChannelGroup(channelGroup.id, channelGroupUpdates);
    }

    // 更新成员
    if (updates.add_members && updates.add_members.length > 0) {
      // 先删除现有的 add 成员，再添加新的
      await this.database.clearChannelGroupMembers(channelGroup.id, true);
      for (const userId of updates.add_members) {
        await this.database.addChannelGroupMember({
          channel_group_id: channelGroup.id,
          user_id: userId,
          is_add: true,
        });
      }
    }

    if (updates.remove_members && updates.remove_members.length > 0) {
      // 先删除现有的 remove 成员，再添加新的
      await this.database.clearChannelGroupMembers(channelGroup.id, false);
      for (const userId of updates.remove_members) {
        await this.database.addChannelGroupMember({
          channel_group_id: channelGroup.id,
          user_id: userId,
          is_add: false,
        });
      }
    }

    // 清除缓存
    this.invalidateCache(channel_id);

    logger.info(`Channel group updated: ${channelGroupName} in channel ${channel_id}`);

    // 广播组变更
    await this.broadcastChannelGroupUpdate(channel_id);
  }

  /**
   * 删除频道组
   */
  async deleteChannelGroup(channel_id: number, channelGroupName: string): Promise<void> {
    const channelGroup = await this.getChannelGroup(channel_id, channelGroupName);
    if (!channelGroup) {
      throw new Error(`Channel group ${channelGroupName} not found in channel ${channel_id}`);
    }

    await this.database.deleteChannelGroup(channelGroup.id);

    // 清除缓存
    this.invalidateCache(channel_id);

    logger.info(`Channel group deleted: ${channelGroupName} from channel ${channel_id}`);

    // 广播组变更
    await this.broadcastChannelGroupUpdate(channel_id);
  }

  /**
   * 批量保存频道的所有频道组
   */
  async saveChannelGroups(channel_id: number, channelGroups: CreateChannelGroupRequest[]): Promise<void> {
    // 清除频道现有的所有组
    await this.database.clearChannelGroups(channel_id);

    // 添加新的组
    for (const channelGroupReq of channelGroups) {
      await this.createChannelGroup({ ...channelGroupReq, channel_id });
    }

    // 清除缓存
    this.invalidateCache(channel_id);

    logger.info(`Saved ${channelGroups.length} channel groups for channel ${channel_id}`);

    // 广播组变更
    await this.broadcastChannelGroupUpdate(channel_id);
  }

  /**
   * 检查用户是否在频道组中
   */
  async isUserInChannelGroup(channel_id: number, channelGroupName: string, userId: number): Promise<boolean> {
    const members = await this.getChannelGroupMembers(channel_id, channelGroupName);
    return members.includes(userId);
  }

  /**
   * 获取频道组的最终成员列表（包括继承）
   */
  async getChannelGroupMembers(channel_id: number, channelGroupName: string): Promise<number[]> {
    const channelGroup = await this.getChannelGroup(channel_id, channelGroupName);
    if (!channelGroup) {
      return [];
    }

    return channelGroup.inherited_members;
  }

  /**
   * 加载频道的频道组（包括继承的）
   */
  private async loadChannelGroups(channel_id: number): Promise<void> {
    // 获取频道层级
    const channelHierarchy = await this.database.getChannelHierarchy(channel_id);
    
    const channelGroupMap = new Map<string, FullChannelGroupInfo>();

    // 从根到当前频道遍历
    for (const chanId of channelHierarchy) {
      const channelGroups = await this.database.getChannelGroups(chanId);

      for (const channelGroup of channelGroups) {
        const members = await this.database.getChannelGroupMembers(channelGroup.id);
        
        const addMembers = members.filter(m => m.is_add).map(m => m.user_id);
        const removeMembers = members.filter(m => !m.is_add).map(m => m.user_id);

        // 检查是否已经有这个组（从父频道继承）
        const existingChannelGroup = channelGroupMap.get(channelGroup.name);

        if (existingChannelGroup) {
          // 如果组不可继承，或当前频道的组不继承父组，跳过继承
          if (!existingChannelGroup.inheritable || (channelGroup.channel_id === chanId && !channelGroup.inherit)) {
            // 替换为当前频道的组
            channelGroupMap.set(channelGroup.name, {
              ...channelGroup,
              add_members: addMembers,
              remove_members: removeMembers,
              inherited_members: this.calculateInheritedMembers([], addMembers, removeMembers),
            });
          } else {
            // 继承并合并
            const inheritedMembers = this.calculateInheritedMembers(
              existingChannelGroup.inherited_members,
              addMembers,
              removeMembers
            );

            channelGroupMap.set(channelGroup.name, {
              ...channelGroup,
              add_members: addMembers,
              remove_members: removeMembers,
              inherited_members: inheritedMembers,
            });
          }
        } else {
          // 新组
          channelGroupMap.set(channelGroup.name, {
            ...channelGroup,
            add_members: addMembers,
            remove_members: removeMembers,
            inherited_members: this.calculateInheritedMembers([], addMembers, removeMembers),
          });
        }
      }
    }

    this.channelGroupCache.set(channel_id, channelGroupMap);
  }

  /**
   * 计算继承的成员
   */
  private calculateInheritedMembers(
    parentMembers: number[],
    addMembers: number[],
    removeMembers: number[]
  ): number[] {
    const memberSet = new Set<number>(parentMembers);

    // 添加新成员
    for (const userId of addMembers) {
      memberSet.add(userId);
    }

    // 移除成员
    for (const userId of removeMembers) {
      memberSet.delete(userId);
    }

    return Array.from(memberSet);
  }

  /**
   * 清除缓存
   */
  private invalidateCache(channel_id: number): void {
    // 清除当前频道及其所有子频道的缓存
    this.channelGroupCache.delete(channel_id);
    
    // TODO: 也需要清除所有子频道的缓存
    // 这需要从数据库查询子频道列表
  }

  /**
   * 刷新所有缓存
   */
  refreshCache(): void {
    this.channelGroupCache.clear();
  }

  /**
   * 广播频道组更新
   */
  private async broadcastChannelGroupUpdate(channel_id: number): Promise<void> {
    const channelGroups = await this.getChannelGroups(channel_id, false);
    
    this.syncBroadcaster.broadcastChannelGroupUpdate(
      channel_id,
      channelGroups.map(g => ({
        channel_id: g.channel_id,
        name: g.name,
        inherit: g.inherit,
        inheritable: g.inheritable,
        add_members: g.add_members,
        remove_members: g.remove_members,
      }))
    );
  }
}
