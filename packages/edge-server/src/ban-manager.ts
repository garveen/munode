import { createLogger } from '@munode/common';
import { LRUCache } from 'lru-cache';
import Database from 'sqlite3';
import * as ipaddr from 'ipaddr.js';
import type { BanInfo, BanCheckResult } from './types.js';

const logger = createLogger({ service: 'ban-manager' });

/**
 * 封禁管理系统
 * 支持 IP、证书、用户封禁，包含 LRU 缓存和 SQLite 持久化
 */
export class BanManager {
  private db: Database.Database;
  private temporaryBans: LRUCache<string, BanInfo>;
  private certBans: Set<string>;
  private initialized = false;

  constructor(
    private dbPath: string,
    private cacheSize = 1024
  ) {
    this.db = new Database.Database(dbPath);
    this.certBans = new Set<string>();

    // LRU 缓存用于临时封禁和性能优化
    this.temporaryBans = new LRUCache<string, BanInfo>({
      max: cacheSize,
      ttl: 60 * 1000, // 1分钟后重新验证
    });
  }

  /**
   * 初始化数据库和缓存
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // 创建封禁表
      await this.runQuery(`
        CREATE TABLE IF NOT EXISTS bans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          address TEXT,
          mask INTEGER DEFAULT 32,
          name TEXT,
          hash TEXT,
          reason TEXT NOT NULL,
          start_date TEXT NOT NULL,
          duration INTEGER DEFAULT 0,
          created_by TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now'))
        )
      `);

      // 创建索引
      await this.runQuery('CREATE INDEX IF NOT EXISTS idx_bans_address ON bans(address)');
      await this.runQuery('CREATE INDEX IF NOT EXISTS idx_bans_hash ON bans(hash)');
      await this.runQuery('CREATE INDEX IF NOT EXISTS idx_bans_start_date ON bans(start_date)');

      // 预加载证书封禁到内存
      await this.loadCertBans();

      // 清理过期封禁
      await this.cleanExpiredBans();

      this.initialized = true;
      logger.info('BanManager initialized', { dbPath: this.dbPath, cacheSize: this.cacheSize });
    } catch (error) {
      logger.error('Failed to initialize BanManager:', error);
      throw error;
    }
  }

  /**
   * 检查连接是否被封禁
   */
  async checkConnection(ip: string, certHash?: string): Promise<BanCheckResult> {
    // 1. 检查证书封禁 (最快)
    if (certHash && this.certBans.has(certHash)) {
      const ban = await this.getBanByCertHash(certHash);
      if (ban) {
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

    // 3. 检查数据库
    const ban = await this.findMatchingBan(ip);
    if (ban) {
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

    // 审计日志
    logger.info({
      action: 'ban_add',
      operator: ban.createdBy,
      target: ban.address || ban.hash || ban.name,
      reason: ban.reason,
      duration: ban.duration,
      timestamp: Date.now(),
    });

    // 执行封禁
    const result = await this.runQuery(
      `INSERT INTO bans (address, mask, name, hash, reason, start_date, duration, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ban.address || null,
        ban.mask || 32,
        ban.name || null,
        ban.hash || null,
        ban.reason,
        ban.startDate.toISOString(),
        ban.duration,
        ban.createdBy || null,
      ]
    );

    const banId = result.lastID;

    // 更新缓存
    if (ban.hash) {
      this.certBans.add(ban.hash);
    }

    logger.info(`Added ban #${banId}:`, ban);

    return banId;
  }

  /**
   * 移除封禁
   */
  async removeBan(banId: number): Promise<boolean> {
    const ban = await this.getBanById(banId);
    if (!ban) return false;

    await this.runQuery('DELETE FROM bans WHERE id = ?', [banId]);

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
    return this.queryAll('SELECT * FROM bans ORDER BY id DESC');
  }

  /**
   * 获取所有活跃封禁
   */
  async getAllActiveBans(): Promise<BanInfo[]> {
    const now = new Date().toISOString();

    return this.queryAll(
      `
      SELECT * FROM bans
      WHERE duration = 0
         OR datetime(start_date, '+' || duration || ' seconds') > datetime(?)
    `,
      [now]
    );
  }

  /**
   * 清理过期封禁
   */
  async cleanExpiredBans(): Promise<number> {
    const now = new Date().toISOString();

    const result = await this.runQuery(
      `
      DELETE FROM bans
      WHERE duration > 0
        AND datetime(start_date, '+' || duration || ' seconds') <= datetime(?)
    `,
      [now]
    );

    if (result.changes > 0) {
      logger.info(`Cleaned ${result.changes} expired bans`);
    }

    return result.changes;
  }

  /**
   * 清空所有封禁
   */
  async purgeBans(): Promise<void> {
    await this.runQuery('DELETE FROM bans');
    this.temporaryBans.clear();
    this.certBans.clear();

    logger.warn('All bans purged');
  }

  /**
   * 根据 ID 获取封禁
   */
  async getBanById(id: number): Promise<BanInfo | null> {
    return this.queryOne('SELECT * FROM bans WHERE id = ?', [id]);
  }

  /**
   * 根据证书哈希获取封禁
   */
  async getBanByCertHash(hash: string): Promise<BanInfo | null> {
    return this.queryOne('SELECT * FROM bans WHERE hash = ? LIMIT 1', [hash]);
  }

  /**
   * 根据 IP 获取封禁列表
   */
  async getBansByIP(ip: string): Promise<BanInfo[]> {
    return this.queryAll('SELECT * FROM bans WHERE address = ?', [ip]);
  }

  /**
   * 根据用户 ID 获取封禁列表
   */
  async getBansByUser(userId: number): Promise<BanInfo[]> {
    return this.queryAll('SELECT * FROM bans WHERE name = ?', [String(userId)]);
  }

  /**
   * 关闭数据库连接
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.db.close((err) => {
        if (err) {
          logger.error('Error closing database:', err);
        } else {
          logger.info('Database connection closed');
        }
        resolve();
      });
    });
  }

  // ===== 私有方法 =====

  /**
   * 查找匹配的封禁
   */
  private async findMatchingBan(ip: string): Promise<BanInfo | null> {
    const bans = await this.getAllActiveBans();

    for (const ban of bans) {
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

  /**
   * 预加载证书封禁到内存
   */
  private async loadCertBans(): Promise<void> {
    const bans = await this.queryAll<BanInfo>('SELECT hash FROM bans WHERE hash IS NOT NULL');

    this.certBans.clear();
    for (const ban of bans) {
      if (ban.hash) {
        this.certBans.add(ban.hash);
      }
    }

    logger.info(`Loaded ${this.certBans.size} certificate bans`);
  }

  // ===== 数据库辅助方法 =====

  private async runQuery(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  private async queryOne<T = BanInfo>(sql: string, params: any[] = []): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(this.parseBan(row) as T);
      });
    });
  }

  private async queryAll<T = BanInfo>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map((r) => this.parseBan(r)) as T[]);
      });
    });
  }

  private parseBan(row: any): BanInfo | null {
    if (!row) return null;

    return {
      id: row.id,
      address: row.address,
      mask: row.mask,
      name: row.name,
      hash: row.hash,
      reason: row.reason,
      startDate: new Date(row.start_date),
      duration: row.duration,
      createdBy: row.created_by,
      createdAt: row.created_at ? new Date(row.created_at * 1000) : undefined,
    };
  }
}
