/**
 * Permission System - Mumble ACL 权限系统
 * 基于 Go 实现移植
 */

import type { ClientInfo, ChannelInfo } from './shared-types.js';

/**
 * 权限位掩码定义
 * 与 Go 实现保持一致
 */
export enum Permission {
  None = 0x0,
  Write = 0x1,
  Traverse = 0x2,
  Enter = 0x4,
  Speak = 0x8,
  MuteDeafen = 0x10,
  Move = 0x20,
  MakeChannel = 0x40,
  LinkChannel = 0x80,
  Whisper = 0x100,
  TextMessage = 0x200,
  TempChannel = 0x400,
  Listen = 0x800,

  // Root channel only
  Kick = 0x10000,
  Ban = 0x20000,
  Register = 0x40000,
  SelfRegister = 0x80000,

  // Masks
  AllPermissions = 0xf0fff,
  AllSubPermissions = 0xfff,
}

/**
 * ACL 条目
 */
export interface ACLEntry {
  channel_id?: number; // 可选，因为通常通过 Map<channelId, ACLEntry[]> 存储
  user_id?: number; // -1 表示组 ACL
  group?: string;
  apply_here: boolean;
  apply_subs: boolean;
  inherited?: boolean; // 是否从父频道继承（用于查询时标记，存储时不需要）
  allow: Permission;
  deny: Permission;
}

/**
 * 权限管理器
 */
export class PermissionManager {
  private aclCache: Map<string, Permission> = new Map();

  // 默认权限：非注册用户的基本权限
  static readonly DEFAULT_PERMISSIONS: Permission =
    Permission.Traverse |
    Permission.Enter |
    Permission.Speak |
    Permission.Whisper |
    Permission.TextMessage;

  constructor(_logger?: any) {
    // logger parameter kept for interface compatibility
  }

  /**
   * 检查用户是否拥有指定权限
   */
  hasPermission(
    channel: ChannelInfo,
    client: ClientInfo,
    permission: Permission,
    channelTree: Map<number, ChannelInfo>,
    aclMap: Map<number, ACLEntry[]>
  ): boolean {
    const granted = this.calculatePermission(channel, client, channelTree, aclMap);

    // +write 权限隐含所有权限，除了 +speak 和 +whisper
    if (permission !== Permission.Speak && permission !== Permission.Whisper) {
      return (granted & (permission | Permission.Write)) !== 0;
    } else {
      return (granted & permission) !== 0;
    }
  }

  /**
   * 计算用户在频道中的权限
   */
  calculatePermission(
    channel: ChannelInfo,
    client: ClientInfo,
    channelTree: Map<number, ChannelInfo>,
    aclMap: Map<number, ACLEntry[]>
  ): Permission {
    // 检查缓存
    const cacheKey = `${client.session}:${channel.id}`;
    const cached = this.aclCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // SuperUser 拥有所有权限
    if (this.isSuperUser(client)) {
      if (channel.id === 0) {
        return Permission.AllPermissions;
      } else {
        return Permission.AllSubPermissions;
      }
    }

    // 默认权限
    let granted = PermissionManager.DEFAULT_PERMISSIONS;

    // 构建频道链（从当前频道到根频道）
    const chain = this.buildChannelChain(channel, channelTree);
    const origChannel = channel;

    let traverse = true;
    let write = false;

    // 遍历频道链，计算权限
    for (const ctx of chain) {
      // 如果频道不继承 ACL，重置为默认权限
      if (!ctx.inherit_acl) {
        granted = PermissionManager.DEFAULT_PERMISSIONS;
      }

      // 获取当前频道的 ACL
      const acls = aclMap.get(ctx.id) || [];

      for (const acl of acls) {
        // 检查 ACL 是否应用于当前频道
        if (
          (origChannel.id === ctx.id && !acl.apply_here) ||
          (origChannel.id !== ctx.id && !acl.apply_subs)
        ) {
          continue;
        }

        // 检查是否匹配用户或组
        const matchUser =
          acl.user_id !== undefined && acl.user_id > 0 && acl.user_id === client.user_id;
        const matchGroup = acl.group && this.groupMemberCheck(origChannel, ctx, acl.group, client);

        if (matchUser || matchGroup) {
          // 处理 traverse 权限
          if (this.isPermissionSet(acl.allow, Permission.Traverse)) {
            traverse = true;
          }
          if (this.isPermissionSet(acl.deny, Permission.Traverse)) {
            traverse = false;
          }

          // 处理 write 权限
          if (this.isPermissionSet(acl.allow, Permission.Write)) {
            write = true;
          }
          if (this.isPermissionSet(acl.deny, Permission.Write)) {
            write = false;
          }

          // 应用允许和拒绝的权限
          granted |= acl.allow;
          granted &= ~acl.deny;
        }
      }

      // 如果没有 traverse 且没有 write，则没有任何权限
      if (!traverse && !write) {
        granted = Permission.None;
        break;
      }
    }

    // 缓存结果
    this.aclCache.set(cacheKey, granted);

    return granted;
  }

  /**
   * 检查用户是否是组成员
   * 支持完整的组继承模型
   */
  private groupMemberCheck(
    origChannel: ChannelInfo,
    ctx: ChannelInfo,
    group: string,
    client: ClientInfo
  ): boolean {
    // 特殊组处理
    if (group === 'all') {
      return true;
    }

    if (group === 'auth') {
      return client.user_id > 0;
    }

    if (group === 'in') {
      return client.channel_id === origChannel.id;
    }

    if (group === 'out') {
      return client.channel_id !== origChannel.id;
    }

    // 证书哈希组 (以 $ 开头)
    if (group.startsWith('$')) {
      const hash = group.substring(1);
      return client.cert_hash === hash;
    }

    // 检查频道组定义
    if (ctx.groups) {
      const channelGroup = ctx.groups.get(group);
      if (channelGroup) {
        // 检查是否在添加列表中
        if (channelGroup.add.includes(client.user_id)) {
          return true;
        }
        
        // 检查是否在移除列表中
        if (channelGroup.remove.includes(client.user_id)) {
          return false;
        }
        
        // 检查是否在继承成员中
        if (channelGroup.inherited_members.includes(client.user_id)) {
          return true;
        }
      }
    }

    // 普通组检查（兼容简化模型）
    if (client.groups && client.groups.includes(group)) {
      return true;
    }

    return false;
  }

  /**
   * 检查是否是超级用户
   */
  private isSuperUser(client: ClientInfo): boolean {
    // TODO: 实现超级用户检查逻辑
    // 可以基于特定的用户组或用户ID
    const isSuperUser = client.groups?.includes('admin') || client.groups?.includes('superuser') || false;
    console.log(`[PermissionManager] isSuperUser check for session ${client.session}: groups=${JSON.stringify(client.groups)}, result=${isSuperUser}`);
    return isSuperUser;
  }

  /**
   * 构建频道链（从当前频道到根频道）
   */
  private buildChannelChain(
    channel: ChannelInfo,
    channelTree: Map<number, ChannelInfo>
  ): ChannelInfo[] {
    const chain: ChannelInfo[] = [];
    let current: ChannelInfo | undefined = channel;

    while (current) {
      chain.unshift(current);
      if (current.parent_id === undefined || current.parent_id === -1 || current.parent_id === 0) {
        break;
      }
      current = channelTree.get(current.parent_id);
    }

    return chain;
  }

  /**
   * 检查权限位是否设置
   */
  private isPermissionSet(perm: Permission, check: Permission): boolean {
    return (perm & check) !== 0;
  }

  /**
   * 清除权限缓存
   */
  clearCache(): void {
    this.aclCache.clear();
  }

  /**
   * 清除特定用户的权限缓存
   */
  clearCacheForUser(sessionId: number): void {
    const keysToDelete: string[] = [];
    for (const key of this.aclCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.aclCache.delete(key);
    }
  }

  /**
   * 清除特定频道的权限缓存
   */
  clearCacheForChannel(channelId: number): void {
    const keysToDelete: string[] = [];
    for (const key of this.aclCache.keys()) {
      if (key.endsWith(`:${channelId}`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.aclCache.delete(key);
    }
  }

  /**
   * 获取根频道的默认权限
   */
  getRootPermissions(client: ClientInfo): Permission {
    let permissions = Permission.None;

    // 基本权限
    permissions |= Permission.Traverse;

    // 已认证用户的额外权限
    if (client.user_id > 0) {
      permissions |= Permission.Enter;
      permissions |= Permission.Speak;
      permissions |= Permission.Whisper;
      permissions |= Permission.TextMessage;
    }

    // 管理员权限
    if (this.isSuperUser(client)) {
      permissions = Permission.AllPermissions;
    }

    return permissions;
  }

  /**
   * 计算频道组的有效成员
   * 考虑继承、添加和移除
   */
  calculateGroupMembers(
    channel: ChannelInfo,
    groupName: string,
    channelTree: Map<number, ChannelInfo>
  ): Set<number> {
    const members = new Set<number>();
    
    // 获取频道组定义
    const group = channel.groups?.get(groupName);
    if (!group) {
      return members;
    }

    // 如果继承成员，从父频道收集
    if (group.inherit && channel.parent_id !== undefined && channel.parent_id >= 0) {
      const parentChannel = channelTree.get(channel.parent_id);
      if (parentChannel) {
        const parentGroup = parentChannel.groups?.get(groupName);
        if (parentGroup && parentGroup.inheritable) {
          // 递归计算父频道的组成员
          const parentMembers = this.calculateGroupMembers(parentChannel, groupName, channelTree);
          for (const memberId of parentMembers) {
            members.add(memberId);
          }
        }
      }
    }

    // 添加明确添加的成员
    for (const user_id of group.add) {
      members.add(user_id);
    }

    // 移除明确移除的成员
    for (const user_id of group.remove) {
      members.delete(user_id);
    }

    return members;
  }

  /**
   * 更新频道组的继承成员列表
   * 应在组定义改变后调用
   */
  updateGroupInheritedMembers(
    channel: ChannelInfo,
    groupName: string,
    channelTree: Map<number, ChannelInfo>
  ): void {
    const group = channel.groups?.get(groupName);
    if (!group) {
      return;
    }

    // 计算有效成员
    const effectiveMembers = this.calculateGroupMembers(channel, groupName, channelTree);
    
    // 更新 inheritedMembers（排除 add 列表中的成员）
    group.inherited_members = Array.from(effectiveMembers).filter(
      user_id => !group.add.includes(user_id)
    );
  }
}
