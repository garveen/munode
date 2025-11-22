import { createLogger } from '@munode/common';
import { LRUCache } from 'lru-cache';
import * as ipaddr from 'ipaddr.js';
import type { BanInfo, BanCheckResult } from '../types.js';

const logger = createLogger({ service: 'ban-manager' });

/**
 * 封禁管理系统
 * 支持 IP、证书、用户封禁，包含内存缓存
 * 注意：Edge 服务器不进行持久化，所有封禁数据在重启后丢失
 */
export class BanManager {
  private bans: Map<number, BanInfo>;
  private temporaryBans: LRUCache<string, BanInfo>;
  private certBans: Set<string>;
  private nextId = 1;
  private initialized = false;

  constructor(
    private cacheSize = 1024
  ) {
    this.bans = new Map<number, BanInfo>();
    this.certBans = new Set<string>();

    // LRU 缓存用于临时封禁和性能优化
    this.temporaryBans = new LRUCache<string, BanInfo>({
      max: cacheSize,
      ttl: 60 * 1000, // 1分钟后重新验证
    });
  }

  /**
   * 初始化内存缓存
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 初始化证书封禁缓存
    this.certBans.clear();
    for (const ban of this.bans.values()) {
      if (ban.hash) {
        this.certBans.add(ban.hash);
      }
    }

    // 清理过期封禁
    await this.cleanExpiredBans();

    this.initialized = true;
    logger.info('BanManager initialized (memory-only)', { cacheSize: this.cacheSize });
  }

  /**
   * 检查连接是否被封禁
   */
  async checkConnection(ip: string, certHash?: string): Promise<BanCheckResult> {
    // 1. 检查证书封禁 (最快)
    if (certHash && this.certBans.has(certHash)) {
      const ban = await this.getBanByCertHash(certHash);
      if (ban && this.isBanActive(ban)) {
        return {
          banned: true,
          reason: ban.reason,
          expiresAt: this.getBanExpiry(ban),
          banId: ban.id,
        };
      }
    }

    // 2. 检查 LRU 缓存
    const cacheKey = `ip:${ip}`;
    const cachedBan = this.temporaryBans.get(cacheKey);
    if (cachedBan) {
      if (this.isBanActive(cachedBan)) {
        return {
          banned: true,
          reason: cachedBan.reason,
          expiresAt: this.getBanExpiry(cachedBan),
          banId: cachedBan.id,
        };
      } else {
        this.temporaryBans.delete(cacheKey);
      }
    }

    // 3. 检查内存中的封禁列表
    const ban = this.findMatchingBan(ip);
    if (ban && this.isBanActive(ban)) {
      // 缓存结果
      this.temporaryBans.set(cacheKey, ban);

      return {
        banned: true,
        reason: ban.reason,
        expiresAt: this.getBanExpiry(ban),
        banId: ban.id,
      };
    }

    return { banned: false };
  }

  /**
   * 添加封禁
   */
  async addBan(ban: Omit<BanInfo, 'id' | 'createdAt'>): Promise<number> {
    // 验证输入
    if (ban.address) {
      try {
        ipaddr.parse(ban.address);
      } catch {
        throw new Error('Invalid IP address');
      }
    }

    if (ban.mask !== undefined) {
      const maxMask = ban.address?.includes(':') ? 128 : 32;
      if (ban.mask < 0 || ban.mask > maxMask) {
        throw new Error(`Invalid mask: must be 0-${maxMask}`);
      }
    }

    // 创建封禁对象
    const banId = this.nextId++;
    const banInfo: BanInfo = {
      id: banId,
      address: ban.address,
      mask: ban.mask || 32,
      name: ban.name,
      hash: ban.hash,
      reason: ban.reason,
      startDate: ban.startDate,
      duration: ban.duration,
      createdBy: ban.createdBy,
      createdAt: new Date(),
    };

    // 存储到内存
    this.bans.set(banId, banInfo);

    // 更新缓存
    if (ban.hash) {
      this.certBans.add(ban.hash);
    }

    // 审计日志
    logger.info({
      action: 'ban_add',
      operator: ban.createdBy,
      target: ban.address || ban.hash || ban.name,
      reason: ban.reason,
      duration: ban.duration,
      timestamp: Date.now(),
    });

    logger.info(`Added ban #${banId}:`, ban);

    return banId;
  }

  /**
   * 移除封禁
   */
  async removeBan(banId: number): Promise<boolean> {
    const ban = this.bans.get(banId);
    if (!ban) return false;

    this.bans.delete(banId);

    // 清除缓存
    if (ban.hash) {
      this.certBans.delete(ban.hash);
    }
    if (ban.address) {
      this.temporaryBans.delete(`ip:${ban.address}`);
    }

    logger.info(`Removed ban #${banId}`);

    return true;
  }

  /**
   * 获取所有封禁
   */
  async getAllBans(): Promise<BanInfo[]> {
    return Array.from(this.bans.values());
  }

  /**
   * 获取所有活跃封禁
   */
  async getAllActiveBans(): Promise<BanInfo[]> {
    return Array.from(this.bans.values()).filter(ban => this.isBanActive(ban));
  }

  /**
   * 清理过期封禁
   */
  async cleanExpiredBans(): Promise<number> {
    let cleaned = 0;

    for (const [id, ban] of this.bans) {
      if (!this.isBanActive(ban)) {
        this.bans.delete(id);
        if (ban.hash) {
          this.certBans.delete(ban.hash);
        }
        if (ban.address) {
          this.temporaryBans.delete(`ip:${ban.address}`);
        }
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} expired bans`);
    }

    return cleaned;
  }

  /**
   * 清空所有封禁
   */
  async purgeBans(): Promise<void> {
    this.bans.clear();
    this.temporaryBans.clear();
    this.certBans.clear();

    logger.warn('All bans purged');
  }

  /**
   * 根据 ID 获取封禁
   */
  async getBanById(id: number): Promise<BanInfo | null> {
    return this.bans.get(id) || null;
  }

  /**
   * 根据证书哈希获取封禁
   */
  async getBanByCertHash(hash: string): Promise<BanInfo | null> {
    for (const ban of this.bans.values()) {
      if (ban.hash === hash) {
        return ban;
      }
    }
    return null;
  }

  /**
   * 根据 IP 获取封禁列表
   */
  async getBansByIP(ip: string): Promise<BanInfo[]> {
    return Array.from(this.bans.values()).filter(ban => ban.address === ip);
  }

  /**
   * 根据用户 ID 获取封禁列表
   */
  async getBansByUser(userId: number): Promise<BanInfo[]> {
    return Array.from(this.bans.values()).filter(ban => ban.name === String(userId));
  }

  /**
   * 关闭 (无操作，因为没有持久化资源)
   */
  async close(): Promise<void> {
    // 内存实现不需要清理资源
    logger.info('BanManager closed (memory-only)');
  }

  // ===== 私有方法 =====

  /**
   * 查找匹配的封禁
   */
  private findMatchingBan(ip: string): BanInfo | null {
    const activeBans = Array.from(this.bans.values()).filter(ban => this.isBanActive(ban));

    for (const ban of activeBans) {
      if (!ban.address) continue;

      if (this.ipMatchesBan(ip, ban)) {
        return ban;
      }
    }

    return null;
  }

  /**
   * 检查 IP 是否匹配封禁规则
   */
  private ipMatchesBan(ip: string, ban: BanInfo): boolean {
    try {
      const addr = ipaddr.parse(ip);
      const banAddr = ipaddr.parse(ban.address);

      // 类型必须匹配 (IPv4 vs IPv6)
      if (addr.kind() !== banAddr.kind()) {
        return false;
      }

      // CIDR 匹配
      if (ban.mask !== undefined && ban.mask < (addr.kind() === 'ipv4' ? 32 : 128)) {
        return addr.match(banAddr, ban.mask);
      }

      // 精确匹配
      return addr.toString() === banAddr.toString();
    } catch (err) {
      logger.error('IP parse error:', err);
      return false;
    }
  }

  /**
   * 检查封禁是否活跃
   */
  private isBanActive(ban: BanInfo): boolean {
    if (ban.duration === 0) return true; // 永久封禁

    const expiry = this.getBanExpiry(ban);
    return expiry > new Date();
  }

  /**
   * 获取封禁到期时间
   */
  private getBanExpiry(ban: BanInfo): Date {
    if (ban.duration === 0) {
      return new Date('2099-12-31'); // 永久
    }

    return new Date(ban.startDate.getTime() + ban.duration * 1000);
  }
}
