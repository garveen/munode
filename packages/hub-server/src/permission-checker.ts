/**
 * Hub Permission Checker
 * 实现完整的Mumble ACL权限检查系统，供Hub使用
 */

import { logger } from '@munode/common';
import type { HubDatabase } from './database.js';
import type { GlobalSession } from '@munode/protocol';
import type { ChannelGroupManager } from './channel-group-manager.js';

/**
 * 权限位掩码定义
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
 * 频道信息（简化版本，仅用于权限计算）
 */
export interface ChannelInfo {
  id: number;
  parent_id: number;
  inherit_acl: boolean;
}

/**
 * ACL条目
 */
export interface ACLEntry {
  channel_id: number;
  user_id?: number;
  group?: string;
  apply_here: boolean;
  apply_subs: boolean;
  allow: number;
  deny: number;
}

/**
 * 用户信息（用于权限检查）
 */
export interface UserInfo {
  session_id: number;
  user_id: number;
  cert_hash?: string;
  channel_id?: number;
  groups?: string[];
}

/**
 * Hub权限检查器
 */
export class HubPermissionChecker {
  private database: HubDatabase;
  private channelGroupManager?: ChannelGroupManager;
  private aclCache: Map<string, Permission> = new Map();
  private channelTreeCache: Map<number, ChannelInfo> | null = null;
  private channelACLCache: Map<number, ACLEntry[]> = new Map();

  // 默认权限：非注册用户的基本权限
  static readonly DEFAULT_PERMISSIONS: Permission =
    Permission.Traverse |
    Permission.Enter |
    Permission.Speak |
    Permission.Whisper |
    Permission.TextMessage;

  constructor(database: HubDatabase, channelGroupManager?: ChannelGroupManager) {
    this.database = database;
    this.channelGroupManager = channelGroupManager;
  }

  /**
   * 检查用户是否拥有指定权限
   */
  async hasPermission(
    channelId: number,
    user: UserInfo,
    permission: Permission
  ): Promise<boolean> {
    const granted = await this.calculatePermission(channelId, user);

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
  async calculatePermission(channelId: number, user: UserInfo): Promise<Permission> {
    // 检查缓存
    const cacheKey = `${user.session_id}:${channelId}`;
    const cached = this.aclCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // 获取频道信息
    const channel = await this.getChannelInfo(channelId);
    if (!channel) {
      return Permission.None;
    }

    // SuperUser 拥有所有权限
    if (this.isSuperUser(user)) {
      const result = channel.id === 0 ? Permission.AllPermissions : Permission.AllSubPermissions;
      this.aclCache.set(cacheKey, result);
      return result;
    }

    // 默认权限
    let granted = HubPermissionChecker.DEFAULT_PERMISSIONS;

    // 构建频道链（从当前频道到根频道）
    const chain = await this.buildChannelChain(channel);
    const origChannel = channel;

    let traverse = true;
    let write = false;

    // 遍历频道链，计算权限
    for (const ctx of chain) {
      // 如果频道不继承 ACL，重置为默认权限
      if (!ctx.inherit_acl) {
        granted = HubPermissionChecker.DEFAULT_PERMISSIONS;
      }

      // 获取当前频道的 ACL
      const acls = await this.getChannelACLs(ctx.id);

      for (const acl of acls) {
        // 检查 ACL 是否应用于当前频道
        if (
          (origChannel.id === ctx.id && !acl.apply_here) ||
          (origChannel.id !== ctx.id && !acl.apply_subs)
        ) {
          continue;
        }

        // 检查是否匹配用户或组
        const matchUser = acl.user_id !== undefined && acl.user_id > 0 && acl.user_id === user.user_id;
        const matchGroup = acl.group && (await this.groupMemberCheck(origChannel, ctx, acl.group, user));

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
   */
  private async groupMemberCheck(
    origChannel: ChannelInfo,
    ctx: ChannelInfo,
    group: string,
    user: UserInfo
  ): Promise<boolean> {
    // 特殊组处理
    if (group === 'all') {
      return true;
    }

    if (group === 'auth') {
      return user.user_id > 0;
    }

    if (group === 'in') {
      return user.channel_id === origChannel.id;
    }

    if (group === 'out') {
      return user.channel_id !== origChannel.id;
    }

    // 证书哈希组 (以 $ 开头)
    if (group.startsWith('$')) {
      const hash = group.substring(1);
      return user.cert_hash === hash;
    }

    // 令牌组 (以 # 开头)
    if (group.startsWith('#')) {
      const token = group.substring(1);
      return user.groups?.includes(token) || false;
    }

    // 普通组检查 - 从数据库查询频道组定义
    if (this.channelGroupManager) {
      try {
        // 检查上下文频道的组（这是ACL所在的频道）
        const isInChannelGroup = await this.channelGroupManager.isUserInChannelGroup(ctx.id, group, user.user_id);
        return isInChannelGroup;
      } catch (error) {
        // 如果组不存在或查询失败，继续检查用户的groups属性
      }
    }

    // 回退：检查用户的groups属性
    if (user.groups && user.groups.includes(group)) {
      return true;
    }

    return false;
  }

  /**
   * 检查是否是超级用户
   */
  private isSuperUser(user: UserInfo): boolean {
    // 基于用户组检查
    const isSuperUser = user.groups?.includes('admin') || user.groups?.includes('superuser') || false;
    logger.debug(`isSuperUser check for user ${user.user_id}: groups=${JSON.stringify(user.groups)}, result=${isSuperUser}`);
    return isSuperUser;
  }

  /**
   * 构建频道链（从当前频道到根频道）
   */
  private async buildChannelChain(channel: ChannelInfo): Promise<ChannelInfo[]> {
    const chain: ChannelInfo[] = [];
    let current: ChannelInfo | null = channel;

    while (current) {
      chain.unshift(current);
      if (current.parent_id === undefined || current.parent_id === -1 || current.parent_id === 0) {
        break;
      }
      current = await this.getChannelInfo(current.parent_id);
    }

    return chain;
  }

  /**
   * 获取频道信息（带缓存）
   */
  private async getChannelInfo(channelId: number): Promise<ChannelInfo | null> {
    // 尝试从缓存获取
    if (this.channelTreeCache) {
      const cached = this.channelTreeCache.get(channelId);
      if (cached) {
        return cached;
      }
    }

    // 从数据库获取
    const channel = await this.database.getChannel(channelId);
    if (!channel) {
      return null;
    }

    const channelInfo: ChannelInfo = {
      id: channel.id,
      parent_id: channel.parent_id,
      inherit_acl: channel.inherit_acl,
    };

    // 更新缓存
    if (!this.channelTreeCache) {
      this.channelTreeCache = new Map();
    }
    this.channelTreeCache.set(channelId, channelInfo);

    return channelInfo;
  }

  /**
   * 获取频道的ACL（带缓存）
   */
  private async getChannelACLs(channelId: number): Promise<ACLEntry[]> {
    // 检查缓存
    const cached = this.channelACLCache.get(channelId);
    if (cached) {
      return cached;
    }

    // 从数据库获取
    const acls = await this.database.getChannelACLs(channelId);
    
    // 转换为 ACLEntry 格式
    const aclEntries: ACLEntry[] = acls.map((acl) => ({
      channel_id: acl.channel_id,
      user_id: acl.user_id,
      group: acl.group,
      apply_here: acl.apply_here,
      apply_subs: acl.apply_subs,
      allow: acl.allow,
      deny: acl.deny,
    }));

    // 更新缓存
    this.channelACLCache.set(channelId, aclEntries);

    return aclEntries;
  }

  /**
   * 检查权限位是否设置
   */
  private isPermissionSet(perm: number, check: Permission): boolean {
    return (perm & check) !== 0;
  }

  /**
   * 清除权限缓存
   */
  clearCache(): void {
    this.aclCache.clear();
    this.channelTreeCache = null;
    this.channelACLCache.clear();
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
    // 清除权限计算缓存
    const keysToDelete: string[] = [];
    for (const key of this.aclCache.keys()) {
      if (key.endsWith(`:${channelId}`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.aclCache.delete(key);
    }

    // 清除ACL缓存
    this.channelACLCache.delete(channelId);

    // 清除频道树缓存（因为频道结构可能改变）
    if (this.channelTreeCache) {
      this.channelTreeCache.delete(channelId);
    }
  }

  /**
   * 检查循环引用
   * 检查将channel移动到newParent是否会造成循环引用
   */
  async hasCircularReference(channelId: number, newParentId: number): Promise<boolean> {
    if (channelId === newParentId) {
      return true;
    }

    // 向上遍历新父频道的链，看是否会遇到channel
    let current = newParentId;
    const visited = new Set<number>();

    while (current > 0) {
      if (visited.has(current)) {
        // 已经访问过，防止无限循环
        return true;
      }
      visited.add(current);

      if (current === channelId) {
        // 找到了循环引用
        return true;
      }

      const channelInfo = await this.getChannelInfo(current);
      if (!channelInfo || channelInfo.parent_id <= 0) {
        break;
      }

      current = channelInfo.parent_id;
    }

    return false;
  }

  /**
   * 检查同级频道名称是否重复
   */
  async hasDuplicateSiblingName(parentId: number, channelName: string, excludeChannelId?: number): Promise<boolean> {
    const siblings = await this.database.getChildChannels(parentId);
    
    for (const sibling of siblings) {
      if (sibling.id === excludeChannelId) {
        continue;
      }
      if (sibling.name.toLowerCase() === channelName.toLowerCase()) {
        return true;
      }
    }

    return false;
  }

  /**
   * 从GlobalSession创建UserInfo
   */
  static sessionToUserInfo(session: GlobalSession, channelId?: number): UserInfo {
    return {
      session_id: session.session_id,
      user_id: session.user_id,
      cert_hash: session.cert_hash,
      channel_id: channelId,
      groups: session.groups || [], // 从 session 中获取用户组
    };
  }
}
