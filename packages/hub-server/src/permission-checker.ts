/**
 * Hub Permission Checker
 * 实现完整的Mumble ACL权限检查系统，供Hub使用
 */

import type { Logger } from '@munode/common';
import type { HubDatabase } from './database.js';
import type { GlobalSession } from '@munode/protocol';
import type { ChannelGroupManager } from './channel-group-manager.js';
import { HubHandlerFactory } from './factory.js';

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
 * Note: This is a minimal version for permission checking, different from PermissionChannelInfo in @munode/protocol
 */
export interface PermissionChannelInfo {
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
export interface PermissionUserInfo {
  session_id: number;
  user_id: number;
  cert_hash?: string;
  channel_id?: number;
  groups?: string[];
  temporary_tokens?: string[];
}

/**
 * Hub权限检查器
 */
export class HubPermissionChecker {
  private database: HubDatabase;
  private channelGroupManager: ChannelGroupManager;
  private aclCache: Map<string, Permission> = new Map();
  private channelTreeCache: Map<number, PermissionChannelInfo> | null = null;
  private channelACLCache: Map<number, ACLEntry[]> = new Map();
  private logger: Logger;

  // 默认权限：非注册用户的基本权限
  // 注意：Listen 权限允许用户监听其他频道（重要的语音路由功能）
  static readonly DEFAULT_PERMISSIONS: Permission =
    Permission.Traverse |
    Permission.Enter |
    Permission.Speak |
    Permission.Whisper |
    Permission.TextMessage |
    Permission.Listen;

  constructor(factory: HubHandlerFactory) {
    this.database = factory.getDatabase();
    this.channelGroupManager = factory.getChannelGroupManager();
    this.logger = factory.getLogger();
  }

  /**
   * 检查用户是否拥有指定权限
   */
  async hasPermission(
    channelId: number,
    user: PermissionUserInfo,
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
  async calculatePermission(channelId: number, user: PermissionUserInfo): Promise<Permission> {
    // 如果有临时令牌，不使用缓存（临时令牌可能随时改变）
    const hasTemporaryTokens = user.temporary_tokens && user.temporary_tokens.length > 0;
    
    // 检查缓存
    const cacheKey = `${user.session_id}:${channelId}`;
    if (!hasTemporaryTokens) {
      const cached = this.aclCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
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

    // 只有在没有临时令牌时才缓存结果
    if (!hasTemporaryTokens) {
      this.aclCache.set(cacheKey, granted);
    }

    return granted;
  }

  /**
   * 检查用户是否是组成员
   */
  private async groupMemberCheck(
    origChannel: PermissionChannelInfo,
    ctx: PermissionChannelInfo,
    group: string,
    user: PermissionUserInfo
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
      // 检查永久令牌
      if (user.groups?.includes(token)) {
        return true;
      }
      // 检查临时令牌
      if (user.temporary_tokens?.includes(token)) {
        return true;
      }
      return false;
    }

    // 普通组检查 - 从数据库查询频道组定义
    if (this.channelGroupManager) {
      try {
        // 检查上下文频道的组（这是ACL所在的频道）
        const isInChannelGroup = await this.channelGroupManager.isUserInChannelGroup(ctx.id, group, user.user_id);
        if (isInChannelGroup) {
          return true;
        }
      } catch (_error) {
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
  isSuperUser(user: PermissionUserInfo): boolean {
    // 基于用户组检查
    const isSuperUser = user.groups?.includes('admin') || user.groups?.includes('superuser') || false;
    this.logger.debug(`isSuperUser check for user ${user.user_id}: groups=${JSON.stringify(user.groups)}, result=${isSuperUser}`);
    return isSuperUser;
  }

  /**
   * 构建频道链（从当前频道到根频道）
   */
  private async buildChannelChain(channel: PermissionChannelInfo): Promise<PermissionChannelInfo[]> {
    const chain: PermissionChannelInfo[] = [];
    let current: PermissionChannelInfo | null = channel;

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
  private async getChannelInfo(channelId: number): Promise<PermissionChannelInfo | null> {
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

    const channelInfo: PermissionChannelInfo = {
      id: channel.id,
      parent_id: channel.parent_id,
      inherit_acl: channel.inherit_acl === 1, // 转换数字到布尔值
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
  sessionToUserInfo(session: GlobalSession, channelId?: number, temporaryTokens?: string[]): PermissionUserInfo {
    return {
      session_id: session.session_id,
      user_id: session.user_id,
      cert_hash: session.cert_hash,
      channel_id: channelId,
      groups: session.groups || [], // 从 session 中获取用户组
      temporary_tokens: temporaryTokens || session.temporary_tokens || [], // 支持临时令牌
    };
  }

  /**
   * Check if a user can access a channel (has Enter OR Listen permission)
   * @param channelId - Channel ID to check
   * @param user - User info
   * @returns Whether the user can access the channel
   */
  async canUserAccessChannel(channelId: number, user: PermissionUserInfo): Promise<boolean> {
    const hasEnter = await this.hasPermission(channelId, user, Permission.Enter);
    if (hasEnter) {
      return true;
    }

    const hasListen = await this.hasPermission(channelId, user, Permission.Listen);
    return hasListen;
  }

  /**
   * Get all transitively linked channels from a channel
   * This includes direct links and links of links (contagious linking)
   * @param channelId - Starting channel ID
   * @returns Set of all transitively linked channel IDs (including the starting channel)
   */
  async getTransitivelyLinkedChannels(channelId: number): Promise<Set<number>> {
    const visited = new Set<number>();
    const queue: number[] = [channelId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (visited.has(currentId)) {
        continue;
      }
      visited.add(currentId);

      const linkedChannels = await this.database.getChannelLinks(currentId);
      for (const linkedId of linkedChannels) {
        if (!visited.has(linkedId)) {
          queue.push(linkedId);
        }
      }
    }

    return visited;
  }

  /**
   * Check if a user can see users in a ninja channel
   * 
   * A user can see users in a ninja channel if ANY of the following is true:
   * 1. User has Enter permission on the ninja channel, or
   * 2. User has Listen permission on the ninja channel, or
   * 3. User has Enter permission on any transitively linked channel, or
   * 4. User has Listen permission on any transitively linked channel
   * 
   * Note: This does NOT check if the user is currently in the channel (that's handled separately)
   * 
   * @param ninjaChannelId - The ninja channel ID to check
   * @param user - User info
   * @returns Whether the user can see users in this ninja channel
   */
  async canUserSeeNinjaChannel(ninjaChannelId: number, user: PermissionUserInfo): Promise<boolean> {
    // Check permissions on the ninja channel itself
    if (await this.canUserAccessChannel(ninjaChannelId, user)) {
      return true;
    }

    // Get all transitively linked channels (contagious linking)
    const linkedChannels = await this.getTransitivelyLinkedChannels(ninjaChannelId);
    
    // Check permissions on all linked channels
    for (const linkedId of linkedChannels) {
      if (linkedId === ninjaChannelId) continue; // Already checked
      if (await this.canUserAccessChannel(linkedId, user)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a user can see a specified channel (for Channel Ninja feature)
   * 
   * For ninja-enabled channels:
   * - User can see if they have Enter/Listen permission on the channel
   * - User can see if they have Enter/Listen permission on any transitively linked channel
   * - User in the channel (moved by admin) can always see it
   * 
   * For non-ninja channels:
   * - All users can see the channel (traditional Mumble behavior)
   * 
   * @param channelId - Channel ID to check
   * @param user - User info
   * @param ninjaChannels - Set of channel IDs that are ninja channels
   * @param userCurrentChannelId - The channel the user is currently in (optional)
   * @returns Whether the user can see the channel
   */
  async canUserSeeChannel(
    channelId: number, 
    user: PermissionUserInfo, 
    ninjaChannels?: Set<number>,
    userCurrentChannelId?: number
  ): Promise<boolean> {
    // If no ninja channels configured, all channels are visible
    if (!ninjaChannels || ninjaChannels.size === 0) {
      // Legacy behavior: check Enter/Listen on channel and linked channels
      if (await this.canUserAccessChannel(channelId, user)) {
        return true;
      }

      const linkedChannels = await this.database.getChannelLinks(channelId);
      for (const linkedChannelId of linkedChannels) {
        if (await this.canUserAccessChannel(linkedChannelId, user)) {
          return true;
        }
      }

      return false;
    }

    // Check if the target channel or any of its transitive links is a ninja channel
    const transitiveLinks = await this.getTransitivelyLinkedChannels(channelId);
    
    // Check if any channel in the transitive group is a ninja channel
    let isNinjaRelated = false;
    for (const chId of transitiveLinks) {
      if (ninjaChannels.has(chId)) {
        isNinjaRelated = true;
        break;
      }
    }

    // If not related to any ninja channel, use traditional visibility
    if (!isNinjaRelated) {
      return true; // Non-ninja channels are always visible
    }

    // User is currently in this channel (moved by admin) - they can see it
    if (userCurrentChannelId !== undefined && transitiveLinks.has(userCurrentChannelId)) {
      return true;
    }

    // Check if user has Enter/Listen on any channel in the transitive group
    for (const chId of transitiveLinks) {
      if (await this.canUserAccessChannel(chId, user)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a user should see another user based on ninja channel rules
   * 
   * For ninja functionality to be active, ALL of the following must be true:
   * 1. ninjaChannels parameter is provided and not empty (from Hub config)
   * 2. The target user is in a ninja channel (or a channel linked to a ninja channel)
   * 
   * If ninja is active for the target user, observer can see them if ANY of:
   * 1. Observer has Enter permission on any channel in the ninja group (target + linked)
   * 2. Observer has Listen permission on any channel in the ninja group
   * 3. Observer is in the same ninja channel group (e.g., moved there by admin)
   * 
   * @param observerUser - The user who is observing
   * @param observerChannelId - The channel the observer is in
   * @param targetChannelId - The channel the target user is in
   * @param ninjaChannels - Set of channel IDs that are ninja channels (from Hub config)
   * @returns Whether the observer can see the target user
   */
  async canUserSeeOtherUser(
    observerUser: PermissionUserInfo,
    observerChannelId: number,
    targetChannelId: number,
    ninjaChannels?: Set<number>
  ): Promise<boolean> {
    // Condition 1: If ninja mode is not enabled (no ninja channels configured), everyone sees everyone
    if (!ninjaChannels || ninjaChannels.size === 0) {
      return true;
    }

    // Get all channels transitively linked to the target channel (includes the channel itself)
    const targetTransitiveLinks = await this.getTransitivelyLinkedChannels(targetChannelId);

    // Condition 2: Check if the target channel (or its links) involves any ninja channel
    let isTargetInNinjaGroup = false;
    for (const chId of targetTransitiveLinks) {
      if (ninjaChannels.has(chId)) {
        isTargetInNinjaGroup = true;
        break;
      }
    }

    // If target is not in a ninja channel group, they are visible to everyone (no ninja filtering)
    if (!isTargetInNinjaGroup) {
      return true;
    }

    // Target is in a ninja channel group - now check if observer can see them

    // Check condition 3: Observer is in the same ninja channel group (moved there by admin)
    if (targetTransitiveLinks.has(observerChannelId)) {
      return true;
    }

    // Check conditions 1 & 2: Observer has Enter or Listen permission on any channel in the ninja group
    for (const chId of targetTransitiveLinks) {
      if (await this.canUserAccessChannel(chId, observerUser)) {
        return true;
      }
    }

    // Observer cannot see the target user
    return false;
  }
}
