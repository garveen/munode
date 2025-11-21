import { createLogger } from '@munode/common';
import type { BanData } from '@munode/protocol/src/hub-edge-types.js';
import * as crypto from 'crypto';
import * as ipaddr from 'ipaddr.js';

const logger = createLogger({ service: 'edge-state-manager' });

// ==================
// 类型定义
// ==================

// Channel 数据类型
export interface ChannelData {
  id: number;
  name?: string;
  parent_id?: number;
  position?: number;
  maxUsers?: number;
  inheritAcl?: boolean;
  description?: string;
  temporary?: boolean;
  links?: number[];
}

export interface ChannelNode extends ChannelData {
  children: ChannelNode[];
  links: number[]; // 链接的频道 ID
}

// ACL 数据类型
export interface ACLData {
  id?: number;
  channel_id: number;
  user_id?: number;
  group?: string;
  apply_here: boolean;
  apply_subs: boolean;
  allow: number;
  deny: number;
}

// 同步更新类型
export interface SyncUpdate {
  type: string | number;
  sequence: number;
  timestamp: number;
  data: any; // 已经通过 msgpack 解析的数据
}

// 完整快照类型
export interface FullSnapshot {
  channels: ChannelData[];
  channelLinks?: Array<{ channel_id: number;  target_id: number }>;
  acls: ACLData[];
  bans: BanData[];
  configs?: Record<string, string>;
  timestamp: number;
  sequence: number;
}

export interface BanCheckResult {
  banned: boolean;
  reason?: string;
  expiresAt?: number;
  banId?: number;
}

// ==================
// 封禁缓存
// ==================

class BanCache {
  private bans: Map<number, BanData> = new Map();
  private certBans: Map<string, number> = new Map(); // hash -> ban.id
  private ipBans: BanData[] = []; // IP 封禁需要遍历检查

  constructor(initialBans: BanData[] = []) {
    for (const ban of initialBans) {
      this.add(ban);
    }
  }

  add(ban: BanData): void {
    this.bans.set(ban.id, ban);

    // 索引证书封禁
    if (ban.hash) {
      this.certBans.set(ban.hash, ban.id);
    }

    // 索引 IP 封禁
    if (ban.address) {
      this.ipBans.push(ban);
    }
  }

  remove(banId: number): void {
    const ban = this.bans.get(banId);
    if (!ban) return;

    this.bans.delete(banId);

    if (ban.hash) {
      this.certBans.delete(ban.hash);
    }

    if (ban.address) {
      this.ipBans = this.ipBans.filter((b) => b.id !== banId);
    }
  }

  check(ip: string, certHash?: string): BanCheckResult {
    // 1. 检查证书封禁
    if (certHash && this.certBans.has(certHash)) {
      const banId = this.certBans.get(certHash);
      const ban = this.bans.get(banId);

      if (this.isBanActive(ban)) {
        return {
          banned: true,
          reason: ban.reason,
          expiresAt: this.getBanExpiry(ban),
          banId: ban.id,
        };
      }
    }

    // 2. 检查 IP 封禁
    try {
      const ipObj = ipaddr.parse(ip);

      for (const ban of this.ipBans) {
        if (!ban.address || !this.isBanActive(ban)) continue;

        if (this.matchesIPBan(ipObj, ban)) {
          return {
            banned: true,
            reason: ban.reason,
            expiresAt: this.getBanExpiry(ban),
            banId: ban.id,
          };
        }
      }
    } catch (error) {
      logger.warn('Invalid IP address', {
        ip,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { banned: false };
  }

  private isBanActive(ban: BanData): boolean {
    if (!ban.start || ban.duration === undefined) return true;
    if (ban.duration === 0) return true; // 永久封禁

    const now = Math.floor(Date.now() / 1000);
    return ban.start + ban.duration > now;
  }

  private getBanExpiry(ban: BanData): number | undefined {
    if (!ban.start || ban.duration === undefined || ban.duration === 0) {
      return undefined; // 永久封禁
    }
    return (ban.start + ban.duration) * 1000; // 转换为毫秒
  }

  private matchesIPBan(ip: ipaddr.IPv4 | ipaddr.IPv6, ban: BanData): boolean {
    if (!ban.address) return false;

    try {
      // address 现在是字符串，直接解析
      const bannedIP = ipaddr.process(ban.address);
      const cidr = ban.mask || (bannedIP.kind() === 'ipv4' ? 32 : 128);

      // IPv4/IPv6 兼容性检查 - 简化处理
      // 如果 IP 版本不匹配，则不匹配封禁
      if (ip.kind() !== bannedIP.kind()) {
        return false;
      }

      // 使用 CIDR 匹配
      return ip.match(bannedIP, cidr);
    } catch (error) {
      logger.warn('IP ban match error', {
        error: error instanceof Error ? error.message : String(error),
        banId: ban.id,
      });
      return false;
    }
  }

  size(): number {
    return this.bans.size;
  }

  getAll(): BanData[] {
    return Array.from(this.bans.values());
  }

  clear(): void {
    this.bans.clear();
    this.certBans.clear();
    this.ipBans = [];
  }
}

// ==================
// Edge 状态管理器
// ==================

export class EdgeStateManager {
  private channels: Map<number, ChannelData> = new Map();
  private channelTree: ChannelNode | null = null;
  private channelLinks: Map<number, Set<number>> = new Map(); // channel_id -> Set<target_id>
  private acls: Map<number, ACLData[]> = new Map(); // channel_id -> ACLs
  private bans: BanCache;
  private configs: Map<string, string> = new Map();
  private lastSyncTimestamp: number = 0;
  private lastSyncSequence: number = 0;
  
  // 远程用户追踪（用于优化语音广播）
  private remoteUsers: Map<number, { edge_id: number; channel_id: number }> = new Map(); // session -> {edge_id, channel_id}
  private channelRemoteUsers: Map<number, Set<number>> = new Map(); // channel_id -> Set<edge_id>

  constructor() {
    this.bans = new BanCache();
  }

  /**
   * 加载完整快照
   */
  loadSnapshot(snapshot: FullSnapshot): void {
    logger.info('Loading snapshot...', {
      channels: snapshot.channels?.length || 0,
      channelLinks: snapshot.channelLinks?.length || 0,
      acls: snapshot.acls?.length || 0,
      bans: snapshot.bans?.length || 0,
    });

    // 清空现有数据
    this.clear();

    // 加载频道 - 现在 snapshot.channels 已经是 Channel[] 类型
    if (snapshot.channels && Array.isArray(snapshot.channels)) {
      for (const channel of snapshot.channels) {
        logger.debug(`Loading channel from snapshot: ${JSON.stringify(channel)}`);
        this.channels.set(channel.id, channel);
      }
    }

    // 加载频道链接
    if (snapshot.channelLinks && Array.isArray(snapshot.channelLinks)) {
      for (const link of snapshot.channelLinks) {
        if (!this.channelLinks.has(link.channel_id)) {
          this.channelLinks.set(link.channel_id, new Set());
        }
        const links = this.channelLinks.get(link.channel_id);
        if (links) {
          links.add(link.target_id);
        }
      }
    }

    // 构建频道树
    this.rebuildChannelTree();

    // 加载 ACL
    if (snapshot.acls && Array.isArray(snapshot.acls)) {
      for (const acl of snapshot.acls) {
        if (!this.acls.has(acl.channel_id)) {
          this.acls.set(acl.channel_id, []);
        }
        const aclList = this.acls.get(acl.channel_id);
        if (aclList) {
          aclList.push(acl);
        }
      }
    }

    // 加载封禁
    if (snapshot.bans && Array.isArray(snapshot.bans)) {
      this.bans = new BanCache(snapshot.bans);
    } else {
      this.bans = new BanCache();
    }

    // 加载配置
    if (snapshot.configs && typeof snapshot.configs === 'object') {
      for (const [key, value] of Object.entries(snapshot.configs)) {
        this.configs.set(key, value);
      }
    }

    this.lastSyncTimestamp = snapshot.timestamp || 0;
    this.lastSyncSequence = snapshot.sequence || 0;

    logger.info('Snapshot loaded successfully', {
      channels: this.channels.size,
      channelLinks: this.channelLinks.size,
      acls: this.acls.size,
      bans: this.bans.size(),
      sequence: this.lastSyncSequence,
    });
  }

  /**
   * 处理增量更新
   */
  handleUpdate(update: SyncUpdate): void {
    logger.debug('Handling update', { type: update.type, sequence: update.sequence });

    // 将 UpdateType 转换为字符串进行匹配
    const typeStr = typeof update.type === 'string' ? update.type : String(update.type);

    try {
      switch (typeStr) {
        case 'CHANNEL_CREATE':
        case 'CHANNEL_UPDATE': {
          // msgpack 已解析，直接使用
          const data = update.data as { channel: ChannelData };
          if (data.channel) {
            this.handleChannelUpdate(data.channel);
          }
          break;
        }

        case 'CHANNEL_DELETE': {
          const data = update.data as { channel_id: number };
          this.handleChannelDelete(data.channel_id);
          break;
        }

        case 'CHANNEL_LINK': {
          const data = update.data as { channel_id: number;  target_id: number };
          this.handleChannelLink(data.channel_id, data.target_id);
          break;
        }

        case 'CHANNEL_UNLINK': {
          const data = update.data as { channel_id: number;  target_id: number };
          this.handleChannelUnlink(data.channel_id, data.target_id);
          break;
        }

        case 'ACL_UPDATE': {
          const data = update.data as { channel_id: number; acls: ACLData[] };
          this.handleACLUpdate(data.channel_id, data.acls);
          break;
        }

        case 'ACL_DELETE': {
          const data = update.data as { aclId: number };
          if (data.aclId > 0) {
            // TODO: 实现单个ACL删除
            logger.warn(`Single ACL delete not implemented: ${data.aclId}`);
          }
          break;
        }

        case 'BAN_ADD': {
          const data = update.data as { ban: BanData };
          if (data.ban) {
            this.bans.add(data.ban);
          }
          break;
        }

        case 'BAN_REMOVE': {
          const data = update.data as { banId: number };
          this.bans.remove(data.banId);
          break;
        }

        case 'CONFIG_UPDATE': {
          const data = update.data as { key: string; value: string };
          this.configs.set(data.key, data.value);
          break;
        }

        default:
          logger.warn('Unknown update type', { type: update.type, typeStr });
      }
    } catch (error) {
      logger.error('Failed to process sync update:', {
        type: typeStr,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.lastSyncTimestamp = update.timestamp;
    this.lastSyncSequence = update.sequence;
  }

  /**
   * 批量处理更新
   */
  handleBatchUpdates(updates: SyncUpdate[]): void {
    let needRebuildTree = false;

    for (const update of updates) {
      // 检测是否需要重建频道树
      const typeStr = typeof update.type === 'string' ? update.type : String(update.type);

      if (typeStr.startsWith('CHANNEL_')) {
        needRebuildTree = true;
      }

      this.handleUpdate(update);
    }

    // 批量处理完成后重建频道树（避免多次重建）
    if (needRebuildTree) {
      this.rebuildChannelTree();
    }
  }

  // ==================
  // 私有辅助方法
  // ==================

  private handleChannelUpdate(channel: ChannelData): void {
    this.channels.set(channel.id, channel);
    this.rebuildChannelTree();
  }

  private handleChannelDelete(channel_id: number): void {
    this.channels.delete(channel_id);
    this.acls.delete(channel_id);
    this.channelLinks.delete(channel_id);

    // 移除指向该频道的链接
    for (const links of this.channelLinks.values()) {
      links.delete(channel_id);
    }

    this.rebuildChannelTree();
  }

  private handleChannelLink(channel_id: number,  target_id: number): void {
    if (!this.channelLinks.has(channel_id)) {
      this.channelLinks.set(channel_id, new Set());
    }
    this.channelLinks.get(channel_id).add(target_id);

    if (!this.channelLinks.has(target_id)) {
      this.channelLinks.set(target_id, new Set());
    }
    this.channelLinks.get(target_id).add(channel_id);

    this.rebuildChannelTree();
  }

  private handleChannelUnlink(channel_id: number,  target_id: number): void {
    this.channelLinks.get(channel_id)?.delete(target_id);
    this.channelLinks.get(target_id)?.delete(channel_id);
    this.rebuildChannelTree();
  }

  private handleACLUpdate(channel_id: number, acls: ACLData[]): void {
    this.acls.set(channel_id, acls);
  }

  /**
   * 构建/重建频道树
   */
  private rebuildChannelTree(): void {
    const root = this.channels.get(0);
    if (!root) {
      logger.warn('Root channel not found, cannot build channel tree');
      this.channelTree = null;
      return;
    }

    const buildNode = (channel: ChannelData, visited: Set<number> = new Set()): ChannelNode => {
      if (visited.has(channel.id)) {
        logger.warn(`Cycle detected in channel tree at channel ${channel.id}`);
        return { ...channel, children: [], links: [] };
      }
      visited.add(channel.id);

      // 找到子频道
      // 注意：根频道(ID=0)的 parent_id 可能是 0（指向自己），这是正常的，不应该被当作子频道
      const children = Array.from(this.channels.values())
        .filter((ch) => ch.parent_id === channel.id && ch.id !== channel.id)
        .sort((a, b) => a.position - b.position)
        .map((ch) => buildNode(ch, new Set(visited)));

      // 获取链接
      const links = Array.from(this.channelLinks.get(channel.id) || []);

      return {
        ...channel,
        children,
        links,
      };
    };

    this.channelTree = buildNode(root);
  }

  /**
   * 清空所有数据
   */
  clear(): void {
    this.channels.clear();
    this.channelTree = null;
    this.channelLinks.clear();
    this.acls.clear();
    this.bans.clear();
    this.configs.clear();
    this.remoteUsers.clear();
    this.channelRemoteUsers.clear();
  }

  // ==================
  // 远程用户管理
  // ==================

  /**
   * 添加远程用户
   */
  addRemoteUser(session_id: number, edge_id: number, channel_id: number): void {
    this.remoteUsers.set(session_id, { edge_id, channel_id });
    
    if (!this.channelRemoteUsers.has(channel_id)) {
      this.channelRemoteUsers.set(channel_id, new Set());
    }
    this.channelRemoteUsers.get(channel_id)!.add(edge_id);
    
    logger.debug(`Added remote user: session=${session_id}, edge=${edge_id}, channel=${channel_id}`);
  }

  /**
   * 移除远程用户
   */
  removeRemoteUser(session_id: number): void {
    const user = this.remoteUsers.get(session_id);
    if (user) {
      // 检查该 Edge 在此频道中是否还有其他用户
      const hasOtherUsersInChannel = Array.from(this.remoteUsers.values()).some(
        u => u.edge_id === user.edge_id && u.channel_id === user.channel_id && this.remoteUsers.get(session_id) !== u
      );
      
      // 如果该 Edge 在此频道中没有其他用户了，从频道的 Edge 集合中移除
      if (!hasOtherUsersInChannel) {
        const channelEdges = this.channelRemoteUsers.get(user.channel_id);
        if (channelEdges) {
          channelEdges.delete(user.edge_id);
          if (channelEdges.size === 0) {
            this.channelRemoteUsers.delete(user.channel_id);
          }
        }
      }
      
      this.remoteUsers.delete(session_id);
      logger.debug(`Removed remote user: session=${session_id}, edge=${user.edge_id}, channel=${user.channel_id}`);
    }
  }

  /**
   * 更新远程用户频道
   */
  updateRemoteUserChannel(session_id: number, new_channel_id: number): void {
    const user = this.remoteUsers.get(session_id);
    if (user) {
      const old_channel_id = user.channel_id;
      
      // 检查该 Edge 在旧频道中是否还有其他用户
      const hasOtherUsersInOldChannel = Array.from(this.remoteUsers.values()).some(
        u => u.edge_id === user.edge_id && u.channel_id === old_channel_id && this.remoteUsers.get(session_id) !== u
      );
      
      // 如果该 Edge 在旧频道中没有其他用户了，从旧频道的 Edge 集合中移除
      if (!hasOtherUsersInOldChannel) {
        const oldChannelEdges = this.channelRemoteUsers.get(old_channel_id);
        if (oldChannelEdges) {
          oldChannelEdges.delete(user.edge_id);
          if (oldChannelEdges.size === 0) {
            this.channelRemoteUsers.delete(old_channel_id);
          }
        }
      }
      
      // 更新用户的频道
      user.channel_id = new_channel_id;
      
      // 添加到新频道的 Edge 集合
      if (!this.channelRemoteUsers.has(new_channel_id)) {
        this.channelRemoteUsers.set(new_channel_id, new Set());
      }
      this.channelRemoteUsers.get(new_channel_id)!.add(user.edge_id);
      
      logger.debug(`Updated remote user channel: session=${session_id}, edge=${user.edge_id}, ${old_channel_id} -> ${new_channel_id}`);
    }
  }

  /**
   * 检查频道中是否有远程用户
   */
  hasRemoteUsersInChannel(channel_id: number): boolean {
    const edges = this.channelRemoteUsers.get(channel_id);
    return edges !== undefined && edges.size > 0;
  }

  /**
   * 获取频道中有用户的 Edge 列表
   */
  getEdgesInChannel(channel_id: number): Set<number> {
    return this.channelRemoteUsers.get(channel_id) || new Set();
  }

  /**
   * 获取频道中的远程 Edge 数量
   */
  getRemoteEdgeCountInChannel(channel_id: number): number {
    const edges = this.channelRemoteUsers.get(channel_id);
    return edges ? edges.size : 0;
  }

  // ==================
  // 公共查询接口
  // ==================

  /**
   * 获取频道
   */
  getChannel(channel_id: number): ChannelData | undefined {
    return this.channels.get(channel_id);
  }

  /**
   * 获取频道树
   */
  getChannelTree(): ChannelNode | null {
    return this.channelTree;
  }

  /**
   * 获取子频道
   */
  getChildChannels( parent_id: number): ChannelData[] {
    return Array.from(this.channels.values())
      .filter((ch) => ch.parent_id === parent_id)
      .sort((a, b) => a.position - b.position);
  }

  /**
   * 获取频道链接
   */
  getChannelLinks(channel_id: number): number[] {
    return Array.from(this.channelLinks.get(channel_id) || []);
  }

  /**
   * 获取频道的 ACL
   */
  getChannelACLs(channel_id: number): ACLData[] {
    return this.acls.get(channel_id) || [];
  }

  /**
   * 检查是否被封禁
   */
  checkBan(ip: string, certHash?: string): BanCheckResult {
    return this.bans.check(ip, certHash);
  }

  /**
   * 获取配置值
   */
  getConfig(key: string): string | undefined {
    return this.configs.get(key);
  }

  /**
   * 获取所有频道
   */
  getAllChannels(): ChannelData[] {
    return Array.from(this.channels.values());
  }

  /**
   * 添加或更新频道（用于本地操作）
   */
  addOrUpdateChannel(channel: ChannelData): void {
    this.channels.set(channel.id, channel);
    this.rebuildChannelTree();
    logger.info(
      `Channel ${channel.id} (${channel.name}) added/updated in stateManager. Total channels: ${this.channels.size}`
    );
    logger.debug(`Channel data: ${JSON.stringify(channel)}`);
  }

  /**
   * 删除频道（用于本地操作）
   */
  removeChannel(channel_id: number): void {
    this.channels.delete(channel_id);
    this.acls.delete(channel_id);
    this.channelLinks.delete(channel_id);

    // 移除指向该频道的链接
    for (const links of this.channelLinks.values()) {
      links.delete(channel_id);
    }

    this.rebuildChannelTree();
    logger.debug(`Channel ${channel_id} removed from stateManager`);
  }

  /**
   * 获取同步状态
   */
  getSyncStatus(): {
    lastTimestamp: number;
    lastSequence: number;
     channel_count: number;
    aclCount: number;
    banCount: number;
  } {
    return {
      lastTimestamp: this.lastSyncTimestamp,
      lastSequence: this.lastSyncSequence,
       channel_count: this.channels.size,
      aclCount: this.acls.size,
      banCount: this.bans.size(),
    };
  }

  /**
   * 计算数据校验和
   */
  calculateChecksum(): {
    channels: string;
    acls: string;
    bans: string;
  } {
    const channelsData = Array.from(this.channels.entries()).sort((a, b) => a[0] - b[0]);
    const aclsData = Array.from(this.acls.entries()).sort((a, b) => a[0] - b[0]);
    const bansData = this.bans.getAll().sort((a, b) => a.id - b.id);

    return {
      channels: this.hash(channelsData),
      acls: this.hash(aclsData),
      bans: this.hash(bansData),
    };
  }

  private hash(data: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  /**
   * 导出状态（用于调试）
   */
  exportState(): {
    channels: Array<[number, ChannelData]>;
    channelLinks: Array<[number, Set<number>]>;
    acls: Array<[number, ACLData[]]>;
    bans: BanData[];
    configs: Array<[string, string]>;
    lastSyncTimestamp: number;
    lastSyncSequence: number;
  } {
    return {
      channels: Array.from(this.channels.entries()),
      channelLinks: Array.from(this.channelLinks.entries()),
      acls: Array.from(this.acls.entries()),
      bans: this.bans.getAll(),
      configs: Array.from(this.configs.entries()),
      lastSyncTimestamp: this.lastSyncTimestamp,
      lastSyncSequence: this.lastSyncSequence,
    };
  }
}
