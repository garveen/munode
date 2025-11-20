import { createLogger } from '@munode/common';
import type { HubDatabase } from './database.js';
import type { SyncBroadcaster } from './sync-broadcaster.js';

const logger = createLogger({ service: 'hub-ban-manager' });

export interface BanData {
  id: number;
  address?: Buffer;
  mask: number;
  name?: string;
  hash?: string;
  reason?: string;
  start?: number;
  duration?: number;
}

export interface CreateBanRequest {
  address?: Buffer;
  mask: number;
  name?: string;
  hash?: string;
  reason?: string;
  start?: number;
  duration?: number;
}

export interface BanCheckResult {
  banned: boolean;
  reason?: string;
  expiresAt?: number;
  banId?: number;
}

/**
 * 封禁管理器
 * 负责封禁列表的管理，所有操作直接作用于数据库
 */
export class BanManager {
  private database: HubDatabase;
  private syncBroadcaster: SyncBroadcaster;
  private banCache: Map<number, BanData> = new Map();
  private certBanIndex: Map<string, number> = new Map(); // hash -> ban.id
  private ipBans: BanData[] = []; // 需要遍历检查的 IP 封禁

  constructor(database: HubDatabase, syncBroadcaster: SyncBroadcaster) {
    this.database = database;
    this.syncBroadcaster = syncBroadcaster;
    // 异步初始化将在外部调用
  }

  /**
   * 初始化封禁管理器
   */
  async init(): Promise<void> {
    await this.loadBans();
  }

  /**
   * 从数据库加载所有封禁到缓存
   */
  private async loadBans(): Promise<void> {
    const bans = await this.database.getAllBans();

    for (const ban of bans) {
      this.banCache.set(ban.id, ban);

      // 索引证书封禁
      if (ban.hash) {
        this.certBanIndex.set(ban.hash, ban.id);
      }

      // 索引 IP 封禁
      if (ban.address) {
        this.ipBans.push(ban);
      }
    }

    logger.info(`Loaded ${bans.length} bans from database`, {
      certBans: this.certBanIndex.size,
      ipBans: this.ipBans.length,
    });
  }

  /**
   * 添加封禁
   */
  async addBan(request: CreateBanRequest): Promise<number> {
    // 设置默认值
    const ban: CreateBanRequest = {
      ...request,
      start: request.start || Math.floor(Date.now() / 1000),
      duration: request.duration !== undefined ? request.duration : 0,
    };

    const id = await this.database.addBan({
      address: ban.address || Buffer.alloc(0),
      mask: ban.mask,
      name: ban.name,
      hash: ban.hash,
      reason: ban.reason,
      start: ban.start,
      duration: ban.duration,
    });

    // 重新加载以获取完整数据
    const allBans = await this.database.getAllBans();
    const created = allBans.find((b) => b.id === id);
    if (created) {
      this.banCache.set(id, created);

      if (created.hash) {
        this.certBanIndex.set(created.hash, id);
      }

      if (created.address) {
        this.ipBans.push(created);
      }

      logger.info(`Ban added: ${id}`, {
        hash: created.hash,
        hasAddress: !!created.address,
        reason: created.reason,
      });

      // 广播变更到 Edge Servers
      this.syncBroadcaster.broadcastBanAdd({
        id: created.id,
        address: created.address || Buffer.alloc(0),
        mask: created.mask,
        name: created.name || '',
        hash: created.hash || '',
        reason: created.reason || '',
        start: created.start || 0,
        duration: created.duration || 0,
      });
    }

    return id;
  }

  /**
   * 移除封禁（软删除）
   */
  async removeBan(id: number): Promise<void> {
    const ban = this.banCache.get(id);
    if (!ban) return;

    await this.database.deleteBan(id);
    this.banCache.delete(id);

    if (ban.hash) {
      this.certBanIndex.delete(ban.hash);
    }

    if (ban.address) {
      this.ipBans = this.ipBans.filter((b) => b.id !== id);
    }

    logger.info(`Ban removed: ${id}`);
    // 广播变更到 Edge Servers
    this.syncBroadcaster.broadcastBanRemove(id);
  }

  /**
   * 清空所有封禁
   */
  async purgeAllBans(): Promise<void> {
    await this.database.purgeBans();
    this.banCache.clear();
    this.certBanIndex.clear();
    this.ipBans = [];

    logger.warn('All bans purged');
    // TODO: 广播变更到 Edge Servers
  }

  /**
   * 检查是否被封禁
   */
  checkBan(_ip: string, certHash?: string): BanCheckResult {
    // 1. 检查证书封禁（最快）
    if (certHash && this.certBanIndex.has(certHash)) {
      const banId = this.certBanIndex.get(certHash);
      const ban = this.banCache.get(banId);

      if (ban && this.isBanActive(ban)) {
        return {
          banned: true,
          reason: ban.reason,
          expiresAt: this.getBanExpiry(ban),
          banId: ban.id,
        };
      }
    }

    // 2. IP 封禁检查暂时禁用
    // TODO: 实现 IP CIDR 匹配

    return { banned: false };
  }

  /**
   * 检查封禁是否仍然有效
   */
  private isBanActive(ban: BanData): boolean {
    if (!ban.start || ban.duration === undefined) return true;
    if (ban.duration === 0) return true; // 永久封禁

    const now = Math.floor(Date.now() / 1000);
    return ban.start + ban.duration > now;
  }

  /**
   * 获取封禁过期时间
   */
  private getBanExpiry(ban: BanData): number | undefined {
    if (!ban.start || ban.duration === undefined || ban.duration === 0) {
      return undefined; // 永久封禁
    }
    return (ban.start + ban.duration) * 1000; // 转换为毫秒
  }

  /**
   * 获取所有封禁
   */
  getAllBans(): BanData[] {
    return Array.from(this.banCache.values());
  }

  /**
   * 获取封禁数量
   */
  getBanCount(): number {
    return this.banCache.size;
  }

  /**
   * 刷新缓存（重新加载所有封禁）
   */
  async refreshCache(): Promise<void> {
    this.banCache.clear();
    this.certBanIndex.clear();
    this.ipBans = [];
    await this.loadBans();
  }

  /**
   * 清理过期封禁
   */
  cleanupExpiredBans(): void {
    const toRemove: number[] = [];

    for (const [id, ban] of this.banCache.entries()) {
      if (!this.isBanActive(ban)) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.removeBan(id);
    }

    if (toRemove.length > 0) {
      logger.info(`Cleaned up ${toRemove.length} expired bans`);
    }
  }
}
