/**
 * ACL Manager - 客户端 ACL 管理器
 *
 * 主要职责:
 * - ACL 查询和缓存
 * - 权限检查
 * - ACL 修改和保存
 * - 组管理
 */

import { PermissionManager, Permission, type ACLEntry } from '@munode/protocol';
import { mumbleproto, MessageType } from '@munode/protocol';
import type { MumbleClient } from '../core/mumble-client.js';
import type { ChannelInfo, ClientInfo } from '@munode/protocol';

export interface ACLManagerOptions {
  cacheTimeout?: number; // 缓存超时时间 (ms)
  enableCache?: boolean; // 是否启用缓存
}

export interface ACLQueryResult {
  channelId: number;
  acls: ACLEntry[];
  groups: Map<string, ChannelGroup>;
  inheritAcl: boolean;
}

export interface ChannelGroup {
  name: string;
  inherited: boolean;
  inheritable: boolean;
  add: number[]; // 用户ID列表
  remove: number[]; // 用户ID列表
  inherited_members: number[]; // 继承的成员
}

/**
 * ACL 管理器
 */
export class ACLManager {
  private client: MumbleClient;
  private permissionManager: PermissionManager;
  private options: Required<ACLManagerOptions>;
  private aclCache: Map<number, { data: ACLQueryResult; timestamp: number }> = new Map();

  constructor(client: MumbleClient, options: ACLManagerOptions = {}) {
    this.client = client;
    this.options = {
      cacheTimeout: options.cacheTimeout || 300000, // 5分钟默认
      enableCache: options.enableCache !== false
    };
    this.permissionManager = new PermissionManager();
  }

  /**
   * 查询频道的 ACL
   */
  async queryACL(channelId: number): Promise<ACLQueryResult> {
    // 检查缓存
    if (this.options.enableCache) {
      const cached = this.aclCache.get(channelId);
      if (cached && Date.now() - cached.timestamp < this.options.cacheTimeout) {
        return cached.data;
      }
    }

    // 发送 ACL 查询消息
    const aclMessage = mumbleproto.ACL.fromObject({
      channel_id: channelId,
      query: true
    });

    const serialized = aclMessage.serialize();
    const wrappedMessage = this.client.getConnectionManager().wrapMessage(MessageType.ACL, serialized);
    await this.client.getConnectionManager().sendTCP(wrappedMessage);

    // 等待服务器回复
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ACL query timeout'));
      }, 5000); // 5秒超时

      const onACL = (message: any) => {
        if (message.channel_id === channelId) {
          clearTimeout(timeout);
          this.client.removeListener('acl', onACL);

          const aclData: ACLQueryResult = {
            channelId,
            acls: message.acls || [],
            groups: new Map(),
            inheritAcl: message.inherit_acls || false
          };

          // 转换组数据
          if (message.groups) {
            for (const group of message.groups) {
              aclData.groups.set(group.name, {
                name: group.name,
                inherited: group.inherited,
                inheritable: group.inheritable,
                add: group.add || [],
                remove: group.remove || [],
                inherited_members: group.inherited_members || []
              });
            }
          }

          // 缓存结果
          if (this.options.enableCache) {
            this.aclCache.set(channelId, {
              data: aclData,
              timestamp: Date.now()
            });
          }

          resolve(aclData);
        }
      };

      this.client.on('acl', onACL);
    });
  }

  /**
   * 保存 ACL
   */
  async saveACL(channelId: number, acls: ACLEntry[], groups?: Map<string, ChannelGroup>): Promise<number[]> {
    // 构建 ACL 消息
    const aclMessage = mumbleproto.ACL.fromObject({
      channel_id: channelId,
      inherit_acls: true, // 客户端默认继承
      acls: acls.map(acl => ({
        apply_here: acl.apply_here,
        apply_subs: acl.apply_subs,
        inherited: acl.inherited,
        user_id: acl.user_id,
        group: acl.group,
        grant: acl.allow,
        deny: acl.deny
      })),
      query: false
    });

    // 添加组信息
    if (groups) {
      const groupObjects: any[] = [];
      for (const [name, group] of groups) {
        groupObjects.push({
          name: name,
          inherited: group.inherited,
          inheritable: group.inheritable,
          add: group.add,
          remove: group.remove,
          inherited_members: group.inherited_members
        });
      }
      aclMessage.groups = groupObjects;
    }

    const serialized = aclMessage.serialize();
    const wrappedMessage = this.client.getConnectionManager().wrapMessage(MessageType.ACL, serialized);
    await this.client.getConnectionManager().sendTCP(wrappedMessage);

    // 清除缓存
    this.clearCacheForChannel(channelId);

    // 客户端无法知道ACL ID，所以返回空数组
    return [];
  }

  /**
   * 检查用户权限
   */
  async checkPermission(
    channelId: number,
    permission: Permission,
    userSession?: number
  ): Promise<boolean> {
    const channel = this.client.getStateManager().getChannel(channelId);
    if (!channel) {
      return false;
    }

    const user = userSession
      ? this.client.getStateManager().getUser(userSession)
      : this.client.getStateManager().getUser(this.client.getStateManager().getSession()?.session || 0);

    if (!user) {
      return false;
    }

    // 转换类型
    const channelInfo: ChannelInfo = {
      id: channel.channel_id,
      name: channel.name,
      parent_id: channel.parent,
      description: channel.description,
      position: channel.position,
      max_users: channel.max_users,
      temporary: channel.temporary,
      inherit_acl: true, // 客户端默认假设继承ACL
      children: channel.children,
      links: channel.links
    };

    const clientInfo: ClientInfo = {
      session: user.session,
      user_id: user.user_id || 0,
      username: user.name,
      channel_id: user.channel_id,
      mute: user.mute,
      deaf: user.deaf,
      self_mute: user.self_mute,
      self_deaf: user.self_deaf,
      suppress: user.suppress,
      priority_speaker: user.priority_speaker,
      recording: user.recording,
      groups: [], // 客户端暂时不支持组
      comment: user.comment || '',
      hash: user.hash || '',
      ip_address: '', // 客户端不知道IP
      connected_at: new Date(),
      last_active: new Date(),
      version: '',
      client_name: '',
      os_name: '',
      os_version: ''
    };

    // 获取完整的频道树和ACL映射
    const channels = this.client.getChannels();
    const channelTree = new Map<number, ChannelInfo>();
    for (const ch of channels) {
      channelTree.set(ch.channel_id, {
        id: ch.channel_id,
        name: ch.name,
        parent_id: ch.parent,
        description: ch.description,
        position: ch.position,
        max_users: ch.max_users,
        temporary: ch.temporary,
        inherit_acl: true,
        children: ch.children,
        links: ch.links
      });
    }

    const aclMap = await this.getACLMap();

    return this.permissionManager.hasPermission(
      channelInfo,
      clientInfo,
      permission,
      channelTree,
      aclMap
    );
  }

  /**
   * 获取用户在频道中的所有权限
   */
  async getUserPermissions(channelId: number, userSession?: number): Promise<Permission> {
    const channel = this.client.getStateManager().getChannel(channelId);
    if (!channel) {
      return Permission.None;
    }

    const user = userSession
      ? this.client.getStateManager().getUser(userSession)
      : this.client.getStateManager().getUser(this.client.getStateManager().getSession()?.session || 0);

    if (!user) {
      return Permission.None;
    }

    // 转换类型
    const channelInfo: ChannelInfo = {
      id: channel.channel_id,
      name: channel.name,
      parent_id: channel.parent,
      description: channel.description,
      position: channel.position,
      max_users: channel.max_users,
      temporary: channel.temporary,
      inherit_acl: true,
      children: channel.children,
      links: channel.links
    };

    const clientInfo: ClientInfo = {
      session: user.session,
      user_id: user.user_id || 0,
      username: user.name,
      channel_id: user.channel_id,
      mute: user.mute,
      deaf: user.deaf,
      self_mute: user.self_mute,
      self_deaf: user.self_deaf,
      suppress: user.suppress,
      priority_speaker: user.priority_speaker,
      recording: user.recording,
      groups: [],
      comment: user.comment || '',
      hash: user.hash || '',
      ip_address: '',
      connected_at: new Date(),
      last_active: new Date(),
      version: '',
      client_name: '',
      os_name: '',
      os_version: ''
    };

    const channels = this.client.getChannels();
    const channelTree = new Map<number, ChannelInfo>();
    for (const ch of channels) {
      channelTree.set(ch.channel_id, {
        id: ch.channel_id,
        name: ch.name,
        parent_id: ch.parent,
        description: ch.description,
        position: ch.position,
        max_users: ch.max_users,
        temporary: ch.temporary,
        inherit_acl: true,
        children: ch.children,
        links: ch.links
      });
    }

    const aclMap = await this.getACLMap();

    return this.permissionManager.calculatePermission(channelInfo, clientInfo, channelTree, aclMap);
  }

  /**
   * 添加 ACL 条目
   */
  async addACLEntry(
    channelId: number,
    entry: Omit<ACLEntry, 'channel_id'>
  ): Promise<number> {
    const aclData = await this.queryACL(channelId);
    const newEntry: ACLEntry = {
      ...entry,
      channel_id: channelId
    };

    aclData.acls.push(newEntry);
    const aclIds = await this.saveACL(channelId, aclData.acls, aclData.groups);

    return aclIds[aclIds.length - 1];
  }

  /**
   * 移除 ACL 条目
   */
  async removeACLEntry(channelId: number, entryIndex: number): Promise<void> {
    const aclData = await this.queryACL(channelId);
    if (entryIndex >= 0 && entryIndex < aclData.acls.length) {
      aclData.acls.splice(entryIndex, 1);
      await this.saveACL(channelId, aclData.acls, aclData.groups);
    }
  }

  /**
   * 更新 ACL 条目
   */
  async updateACLEntry(
    channelId: number,
    entryIndex: number,
    updates: Partial<ACLEntry>
  ): Promise<void> {
    const aclData = await this.queryACL(channelId);
    if (entryIndex >= 0 && entryIndex < aclData.acls.length) {
      Object.assign(aclData.acls[entryIndex], updates);
      await this.saveACL(channelId, aclData.acls, aclData.groups);
    }
  }

  /**
   * 创建频道组
   */
  async createChannelGroup(
    channelId: number,
    groupName: string,
    inherited: boolean = false,
    inheritable: boolean = false
  ): Promise<void> {
    const aclData = await this.queryACL(channelId);
    aclData.groups.set(groupName, {
      name: groupName,
      inherited,
      inheritable,
      add: [],
      remove: [],
      inherited_members: []
    });

    await this.saveACL(channelId, aclData.acls, aclData.groups);
  }

  /**
   * 删除频道组
   */
  async deleteChannelGroup(channelId: number, groupName: string): Promise<void> {
    const aclData = await this.queryACL(channelId);
    aclData.groups.delete(groupName);
    await this.saveACL(channelId, aclData.acls, aclData.groups);
  }

  /**
   * 添加用户到频道组
   */
  async addUserToGroup(channelId: number, groupName: string, userId: number): Promise<void> {
    const aclData = await this.queryACL(channelId);
    const group = aclData.groups.get(groupName);
    if (group) {
      if (!group.add.includes(userId)) {
        group.add.push(userId);
        // 从移除列表中移除
        group.remove = group.remove.filter(id => id !== userId);
        await this.saveACL(channelId, aclData.acls, aclData.groups);
      }
    }
  }

  /**
   * 从频道组移除用户
   */
  async removeUserFromGroup(channelId: number, groupName: string, userId: number): Promise<void> {
    const aclData = await this.queryACL(channelId);
    const group = aclData.groups.get(groupName);
    if (group) {
      group.add = group.add.filter(id => id !== userId);
      if (!group.remove.includes(userId)) {
        group.remove.push(userId);
      }
      await this.saveACL(channelId, aclData.acls, aclData.groups);
    }
  }

  /**
   * 获取完整的 ACL 映射
   */
  private async getACLMap(): Promise<Map<number, ACLEntry[]>> {
    const aclMap = new Map<number, ACLEntry[]>();
    const channels = this.client.getChannels();

    // 并行查询所有频道的ACL
    const promises = channels.map(async (channel) => {
      try {
        const aclData = await this.queryACL(channel.channel_id);
        aclMap.set(channel.channel_id, aclData.acls);
      } catch (error) {
        console.warn(`Failed to query ACL for channel ${channel.channel_id}:`, error);
        aclMap.set(channel.channel_id, []);
      }
    });

    await Promise.all(promises);
    return aclMap;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.aclCache.clear();
    this.permissionManager.clearCache();
  }

  /**
   * 清除特定频道的缓存
   */
  clearCacheForChannel(channelId: number): void {
    this.aclCache.delete(channelId);
    this.permissionManager.clearCacheForChannel(channelId);
  }

  /**
   * 清除特定用户的缓存
   */
  clearCacheForUser(sessionId: number): void {
    this.permissionManager.clearCacheForUser(sessionId);
  }

  /**
   * 获取权限管理器实例
   */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }
}