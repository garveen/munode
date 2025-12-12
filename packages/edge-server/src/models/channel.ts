import { EventEmitter } from 'events';
import type { Logger } from 'winston';
import { EdgeConfig, ChannelInfo } from '../types.js';

export type ChannelTreeNode = Omit<ChannelInfo, 'children'> & { children: ChannelTreeNode[] };

/**
 * 频道管理器 - 管理服务器频道结构
 */
export class ChannelManager extends EventEmitter {
  private logger: Logger;
  private channels: Map<number, ChannelInfo> = new Map();
  private channelCounter = 1;
  private channelLinks: Map<number, Set<number>> = new Map(); // 频道链接映射
  
  // 缓存：用于语音路由优化
  private transitiveLinksCache: Map<number, Set<number>> = new Map(); // 频道的所有传递链接（包括自己的链接和链接频道的链接）
  private descendantsCache: Map<number, Set<number>> = new Map(); // 频道的所有子孙频道
  private cacheValid = false; // 缓存是否有效

  constructor(_config: EdgeConfig, logger: Logger) {
    super();
    this.logger = logger;

    // 创建根频道
    const rootChannel: ChannelInfo = {
      id: 0,
      name: 'Root',
      parent_id: undefined,
      description: 'Root channel',
      position: 0,
      max_users: 0,
      temporary: false,
      inherit_acl: true,
      children: [],
      links: [],
    };
    this.channels.set(0, rootChannel);
    this.channelCounter = 1;
  }

  /**
   * 创建频道
   */
  createChannel(channelData: Omit<ChannelInfo, 'id'>): ChannelInfo {
    const channel: ChannelInfo = {
      id: this.channelCounter++,
      ...channelData,
    };

    this.channels.set(channel.id, channel);

    // 更新父频道的子频道列表
    if (channel.parent_id !== undefined) {
      const parent = this.channels.get(channel.parent_id);
      if (parent && !parent.children.includes(channel.id)) {
        parent.children.push(channel.id);
      }
    }

    this.invalidateCache(); // 使缓存失效
    this.logger.info(`Channel created: id=${channel.id}, name=${channel.name}`);
    this.emit('channelCreated', channel);
    return channel;
  }

  /**
   * 删除频道
   */
  removeChannel(channel_id: number): boolean {
    const channel = this.channels.get(channel_id);
    if (!channel) {
      return false;
    }

    // 不能删除根频道
    if (channel_id === 0) {
      return false;
    }

    // 递归删除子频道
    for (const childId of channel.children) {
      this.removeChannel(childId);
    }

    // 从父频道中移除
    if (channel.parent_id !== undefined) {
      const parent = this.channels.get(channel.parent_id);
      if (parent) {
        parent.children = parent.children.filter((id) => id !== channel_id);
      }
    }

    this.channels.delete(channel_id);
    this.invalidateCache(); // 使缓存失效
    this.logger.info(`Channel removed: id=${channel_id}, name=${channel.name}`);
    this.emit('channelRemoved', channel);
    return true;
  }

  /**
   * 添加或更新频道（用于从Hub加载频道）
   * 不会自动分配ID，使用提供的频道数据中的ID
   */
  addOrUpdateChannel(channelData: ChannelInfo): ChannelInfo {
    const existingChannel = this.channels.get(channelData.id);
    
    if (existingChannel) {
      // 更新现有频道
      Object.assign(existingChannel, channelData);
      this.logger.debug(`Channel updated: id=${channelData.id}, name=${channelData.name}`);
      this.emit('channelUpdated', existingChannel);
      return existingChannel;
    } else {
      // 添加新频道
      this.channels.set(channelData.id, channelData);
      
      // 更新频道计数器，确保不会产生ID冲突
      if (channelData.id >= this.channelCounter) {
        this.channelCounter = channelData.id + 1;
      }
      
      // 更新父频道的子频道列表
      if (channelData.parent_id !== undefined) {
        const parent = this.channels.get(channelData.parent_id);
        if (parent && !parent.children.includes(channelData.id)) {
          parent.children.push(channelData.id);
        }
      }
      
      this.logger.debug(`Channel added: id=${channelData.id}, name=${channelData.name}`);
      this.emit('channelCreated', channelData);
      return channelData;
    }
  }

  /**
   * 获取频道信息
   */
  getChannel(channel_id: number): ChannelInfo | undefined {
    return this.channels.get(channel_id);
  }

  /**
   * 获取所有频道
   */
  getAllChannels(): ChannelInfo[] {
    return Array.from(this.channels.values());
  }

  /**
   * 获取频道数量
   */
  getChannelCount(): number {
    return this.channels.size;
  }

  /**
   * 更新频道信息
   */
  updateChannel(channel_id: number, updates: Partial<ChannelInfo>): boolean {
    const channel = this.channels.get(channel_id);
    if (!channel) {
      return false;
    }

    // 处理父频道变更
    if (updates.parent_id !== undefined && updates.parent_id !== channel.parent_id) {
      // 从旧父频道移除
      if (channel.parent_id !== undefined) {
        const oldParent = this.channels.get(channel.parent_id);
        if (oldParent) {
          oldParent.children = oldParent.children.filter((id) => id !== channel_id);
        }
      }

      // 添加到新父频道
      const newParent = this.channels.get(updates.parent_id);
      if (newParent && !newParent.children.includes(channel_id)) {
        newParent.children.push(channel_id);
      }
      
      this.invalidateCache(); // 父子关系变化时使缓存失效
    }
    
    // 处理频道链接变更
    if (updates.links !== undefined) {
      // 重要：更新内部 channelLinks Map，确保 getAllLinkedChannels() 能正确工作
      // 注意：Hub已经负责双向链接，这里只需要更新单向链接即可
      const newLinks = new Set(updates.links);
      
      // 直接替换此频道的链接集合
      if (newLinks.size > 0) {
        this.channelLinks.set(channel_id, newLinks);
      } else {
        this.channelLinks.delete(channel_id);
      }
      
      this.logger.debug(`Updated channelLinks Map for channel ${channel_id}: [${Array.from(newLinks).join(', ')}]`);
      this.invalidateCache(); // 链接变化时使缓存失效
    }

    Object.assign(channel, updates);
    this.logger.info(`Channel updated: id=${channel_id}, name=${channel.name}`);
    this.emit('channelUpdated', channel);
    return true;
  }

  /**
   * 更新频道ID（用于同步Hub分配的ID）
   */
  updatechannel_id(oldId: number, newId: number): boolean {
    const channel = this.channels.get(oldId);
    if (!channel) {
      this.logger.error(`Cannot update channel ID: channel ${oldId} not found`);
      return false;
    }

    // 更新频道ID
    this.channels.delete(oldId);
    channel.id = newId;
    this.channels.set(newId, channel);

    // 更新父频道的children数组
    if (channel.parent_id !== undefined) {
      const parent = this.channels.get(channel.parent_id);
      if (parent) {
        const index = parent.children.indexOf(oldId);
        if (index !== -1) {
          parent.children[index] = newId;
        }
      }
    }

    // 更新所有子频道的parent_id引用
    for (const childId of channel.children) {
      const child = this.channels.get(childId);
      if (child) {
        child.parent_id = newId;
      }
    }

    // 更新频道链接
    const links = this.channelLinks.get(oldId);
    if (links) {
      this.channelLinks.delete(oldId);
      this.channelLinks.set(newId, links);

      // 更新所有链接频道的引用
      for (const linkedId of links) {
        const linkedChannelLinks = this.channelLinks.get(linkedId);
        if (linkedChannelLinks) {
          linkedChannelLinks.delete(oldId);
          linkedChannelLinks.add(newId);

          // 更新ChannelInfo的links字段
          const linkedChannel = this.channels.get(linkedId);
          if (linkedChannel) {
            linkedChannel.links = Array.from(linkedChannelLinks);
          }
        }
      }

      // 更新当前频道的links字段
      channel.links = Array.from(links);
    }

    this.logger.debug(`Channel ID updated: ${oldId} -> ${newId}, name=${channel.name}`);
    this.emit('channel_idUpdated', oldId, newId);
    return true;
  }

  /**
   * 获取子频道
   */
  getChildChannels( parent_id: number): ChannelInfo[] {
    const parent = this.channels.get(parent_id);
    if (!parent) {
      return [];
    }

    return parent.children.map((id) => this.channels.get(id)).filter(Boolean);
  }

  /**
   * 获取频道路径
   */
  getChannelPath(channel_id: number): ChannelInfo[] {
    const path: ChannelInfo[] = [];
    let currentId = channel_id;

    while (currentId !== undefined) {
      const channel = this.channels.get(currentId);
      if (!channel) {
        break;
      }
      path.unshift(channel);
      currentId = channel.parent_id ?? -1;
      if (currentId === -1) break;
    }

    return path;
  }

  /**
   * 查找频道
   */
  findChannelByName(name: string): ChannelInfo | undefined {
    for (const channel of this.channels.values()) {
      if (channel.name === name) {
        return channel;
      }
    }
    return undefined;
  }

  /**
   * 检查频道是否存在
   */
  channelExists(channel_id: number): boolean {
    return this.channels.has(channel_id);
  }

  /**
   * 获取频道的用户数量
   */
  getChannelUserCount(channel_id: number): number {
    // 这个方法将在 EdgeServer 中实现，因为需要访问 ClientManager
    this.emit('getChannelUserCount', channel_id);
    return 0;
  }

  /**
   * 检查用户是否可以加入频道
   */
  canUserJoinChannel(channel_id: number, _userId: number): boolean {
    const channel = this.channels.get(channel_id);
    if (!channel) {
      return false;
    }

    // 检查用户限制
    if (channel.max_users > 0) {
      const userCount = this.getChannelUserCount(channel_id);
      if (userCount >= channel.max_users) {
        return false;
      }
    }

    return true;
  }

  /**
   * 获取频道的完整树结构（用于权限计算）
   */
  getChannelTree(): Map<number, ChannelInfo> {
    return new Map(this.channels);
  }

  /**
   * 链接两个频道
   */
  linkChannels(channel_id1: number, channel_id2: number): boolean {
    const channel1 = this.channels.get(channel_id1);
    const channel2 = this.channels.get(channel_id2);

    if (!channel1 || !channel2) {
      return false;
    }

    // 初始化链接集合
    if (!this.channelLinks.has(channel_id1)) {
      this.channelLinks.set(channel_id1, new Set());
    }
    if (!this.channelLinks.has(channel_id2)) {
      this.channelLinks.set(channel_id2, new Set());
    }

    // 添加双向链接
    const links1Set = this.channelLinks.get(channel_id1);
    const links2Set = this.channelLinks.get(channel_id2);
    if (links1Set && links2Set) {
      links1Set.add(channel_id2);
      links2Set.add(channel_id1);

      // 更新 ChannelInfo 的 links 字段
      channel1.links = Array.from(links1Set);
      channel2.links = Array.from(links2Set);
    }

    this.invalidateCache(); // 使缓存失效
    this.logger.info(`Channels linked: ${channel_id1} <-> ${channel_id2}`);
    this.emit('channelsLinked', channel_id1, channel_id2);
    return true;
  }

  /**
   * 取消链接两个频道
   */
  unlinkChannels(channel_id1: number, channel_id2: number): boolean {
    const channel1 = this.channels.get(channel_id1);
    const channel2 = this.channels.get(channel_id2);
    const links1 = this.channelLinks.get(channel_id1);
    const links2 = this.channelLinks.get(channel_id2);

    if (!links1 || !links2 || !channel1 || !channel2) {
      return false;
    }

    links1.delete(channel_id2);
    links2.delete(channel_id1);

    // 更新 ChannelInfo 的 links 字段
    channel1.links = Array.from(links1);
    channel2.links = Array.from(links2);

    this.invalidateCache(); // 使缓存失效
    this.logger.info(`Channels unlinked: ${channel_id1} <-> ${channel_id2}`);
    this.emit('channelsUnlinked', channel_id1, channel_id2);
    return true;
  }

  /**
   * 获取频道的所有链接
   */
  getChannelLinks(channel_id: number): number[] {
    const links = this.channelLinks.get(channel_id);
    return links ? Array.from(links) : [];
  }

  /**
   * 获取频道树数组结构
   */
  getChannelTreeArray(): ChannelTreeNode[] {
    const buildTree = (channel_id: number): ChannelTreeNode => {
      const channel = this.channels.get(channel_id);
      if (!channel) {
        throw new Error(`Channel ${channel_id} not found`);
      }
      return {
        id: channel.id,
        name: channel.name,
        parent_id: channel.parent_id,
        description: channel.description,
        position: channel.position,
        max_users: channel.max_users,
        temporary: channel.temporary,
        inherit_acl: channel.inherit_acl,
        links: channel.links,
        children: channel.children.map(buildTree),
      };
    };

    return [buildTree(0)]; // 从根频道开始
  }

  /**
   * 移动频道位置
   */
  moveChannel(channel_id: number, newPosition: number): boolean {
    const channel = this.channels.get(channel_id);
    if (!channel || channel_id === 0) {
      return false;
    }

    channel.position = newPosition;
    this.logger.debug(`Channel moved: id=${channel_id}, position=${newPosition}`);
    this.emit('channelMoved', channel);
    return true;
  }

  /**
   * 重命名频道
   */
  renameChannel(channel_id: number, newName: string): boolean {
    const channel = this.channels.get(channel_id);
    if (!channel || channel_id === 0) {
      return false;
    }

    const oldName = channel.name;
    channel.name = newName;
    this.logger.debug(`Channel renamed: id=${channel_id}, oldName=${oldName}, newName=${newName}`);
    this.emit('channelRenamed', channel);
    return true;
  }

  /**
   * 使缓存失效
   * 在频道结构或链接发生变化时调用
   */
  private invalidateCache(): void {
    this.cacheValid = false;
    this.transitiveLinksCache.clear();
    this.descendantsCache.clear();
  }

  /**
   * 重建缓存
   * 计算所有频道的传递链接和子孙频道
   */
  private rebuildCache(): void {
    if (this.cacheValid) {
      return;
    }

    this.transitiveLinksCache.clear();
    this.descendantsCache.clear();

    // 计算所有频道的子孙频道
    for (const channel of this.channels.values()) {
      const descendants = new Set<number>();
      this.collectDescendants(channel.id, descendants);
      this.descendantsCache.set(channel.id, descendants);
    }

    // 计算所有频道的传递链接
    for (const channel of this.channels.values()) {
      const transitiveLinks = new Set<number>();
      this.collectTransitiveLinks(channel.id, transitiveLinks, new Set<number>());
      this.transitiveLinksCache.set(channel.id, transitiveLinks);
    }

    this.cacheValid = true;
    this.logger.debug('Channel cache rebuilt');
  }

  /**
   * 递归收集频道的所有子孙频道
   */
  private collectDescendants(channel_id: number, result: Set<number>): void {
    const channel = this.channels.get(channel_id);
    if (!channel) {
      return;
    }

    for (const childId of channel.children) {
      if (!result.has(childId)) {
        result.add(childId);
        this.collectDescendants(childId, result);
      }
    }
  }

  /**
   * 递归收集频道的所有传递链接（深度优先搜索）
   * 如果 A 链接 B，B 链接 C，则 A 的传递链接包含 B 和 C
   * 注意：不包括频道自身
   */
  private collectTransitiveLinks(
    channel_id: number,
    result: Set<number>,
    visited: Set<number>
  ): void {
    if (visited.has(channel_id)) {
      return;
    }
    visited.add(channel_id);

    const links = this.channelLinks.get(channel_id);
    if (!links) {
      return;
    }

    for (const linkedId of links) {
      // 添加到结果集（不包括起始频道自己）
      result.add(linkedId);
      // 递归收集链接频道的链接（但不重复添加已访问的）
      if (!visited.has(linkedId)) {
        this.collectTransitiveLinks(linkedId, result, visited);
      }
    }
  }

  /**
   * 获取频道的所有传递链接（包括直接链接和间接链接）
   * 使用缓存以提高性能
   * 不包括频道自身
   */
  getAllLinkedChannels(channel_id: number): Set<number> {
    this.rebuildCache();
    const cached = this.transitiveLinksCache.get(channel_id);
    if (!cached) {
      return new Set<number>();
    }
    // 过滤掉频道自身（如果存在）
    const result = new Set<number>();
    for (const id of cached) {
      if (id !== channel_id) {
        result.add(id);
      }
    }
    return result;
  }

  /**
   * 获取频道的所有子孙频道
   * 使用缓存以提高性能
   */
  getAllDescendants(channel_id: number): Set<number> {
    this.rebuildCache();
    return this.descendantsCache.get(channel_id) || new Set<number>();
  }
}
