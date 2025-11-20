import { EventEmitter } from 'events';
// import { logger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, CachedUser } from '../types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * 用户缓存管理器 - 缓存外部认证API的用户信息
 */
export class UserCache extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;
  private cache: Map<string, CachedUser> = new Map();
  private cacheFile: string;

  constructor(config: EdgeConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.cacheFile = resolve(config.auth.userCachePath || './data/users.json');
  }

  /**
   * 初始化用户缓存
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing UserCache...');

    // 加载缓存文件
    await this.loadCache();

    // 启动定期拉取
    // if (this.config.auth.pullInterval > 0) {
    //   setInterval(() => {
    //     this.pullUsers();
    //   }, this.config.auth.pullInterval);
    // }

    // 定期保存缓存
    setInterval(() => {
      this.saveCache();
    }, 300000); // 5分钟保存一次
  }

  /**
   * 关闭用户缓存
   */
  async shutdown(): Promise<void> {
    // 保存缓存到文件
    await this.saveCache();
  }

  /**
   * 加载缓存文件
   */
  private async loadCache(): Promise<void> {
    try {
      if (existsSync(this.cacheFile)) {
        const data = readFileSync(this.cacheFile, 'utf-8');
        const users: CachedUser[] = JSON.parse(data);

        for (const user of users) {
          this.cache.set(user.user_id, user);
        }

        this.logger.info(`Loaded ${users.length} users from cache`);
      }
    } catch (error) {
      this.logger.error('Failed to load user cache:', error);
    }
  }

  /**
   * 保存缓存到文件
   */
  private async saveCache(): Promise<void> {
    try {
      const users = Array.from(this.cache.values());
      writeFileSync(this.cacheFile, JSON.stringify(users, null, 2));
      this.logger.debug(`Saved ${users.length} users to cache`);
    } catch (error) {
      this.logger.error('Failed to save user cache:', error);
    }
  }

  /**
   * 从外部API拉取用户列表
   */
  /*
  private async pullUsers(): Promise<void> {
    if (!this.config.auth.apiUrl) {
      return;
    }

    try {
      this.logger.debug('Pulling users from external API...');

      const response = await fetch(`${this.config.auth.apiUrl}/data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.auth.apiKey}`,
          'X-Server-Id': String(this.config.server_id),
        },
        body: JSON.stringify({}), // 空body用于获取所有用户
        signal: AbortSignal.timeout(this.config.auth.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const users: Record<string, CachedUser> = (await response.json()) as Record<
        string,
        CachedUser
      >;
      const now = Date.now();

      let updated = 0;
      for (const [userId, user] of Object.entries(users)) {
        this.cache.set(userId, {
          ...user,
          cachedAt: now,
        });
        updated++;
      }

      this.logger.info(`Pulled ${updated} users from external API`);

      // 保存到磁盘
      await this.saveCache();

      this.emit('usersPulled', updated);
    } catch (error) {
      this.logger.error('Failed to pull users from external API:', error);
      this.emit('pullFailed', error);
    }
  }
  */

  /**
   * 获取缓存的用户
   */
  getUser(userId: string): CachedUser | undefined {
    return this.cache.get(userId);
  }

  /**
   * 根据用户ID获取用户（数字类型）
   */
  async getUserById(id: number): Promise<CachedUser | undefined> {
    return this.cache.get(String(id));
  }

  /**
   * 根据用户名查找用户
   */
  findUserByName(username: string): CachedUser | undefined {
    for (const user of this.cache.values()) {
      if (user.username === username) {
        return user;
      }
    }
    return undefined;
  }

  /**
   * 验证用户凭据
   */
  validateCredentials(userId: string, password: string): boolean {
    const user = this.cache.get(userId);
    if (!user) {
      return false;
    }

    // 检查密码
    if (user.password !== password) {
      return false;
    }

    // 检查缓存是否过期
    if (Date.now() - user.cachedAt > this.config.auth.cacheTTL) {
      this.logger.warn(`User cache expired for ${userId}`);
      if (!this.config.auth.allowCacheFallback) {
        return false;
      }
    }

    return true;
  }

  /**
   * 添加或更新用户
   */
  setUser(user: CachedUser): void {
    user.cachedAt = Date.now();
    this.cache.set(user.user_id, user);
    this.logger.debug(`Updated user cache: ${user.user_id}`);
  }

  /**
   * 移除用户
   */
  removeUser(userId: string): void {
    this.cache.delete(userId);
    this.logger.debug(`Removed user from cache: ${userId}`);
  }

  /**
   * 清理过期缓存
   */
  cleanupExpiredCache(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [userId, user] of this.cache) {
      if (now - user.cachedAt > this.config.auth.cacheTTL) {
        toRemove.push(userId);
      }
    }

    for (const userId of toRemove) {
      this.cache.delete(userId);
    }

    if (toRemove.length > 0) {
      this.logger.info(`Cleaned up ${toRemove.length} expired user cache entries`);
    }
  }

  /**
   * 获取所有缓存用户
   */
  getAllUsers(): CachedUser[] {
    return Array.from(this.cache.values());
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): any {
    const now = Date.now();
    const expired = Array.from(this.cache.values()).filter(
      (user) => now - user.cachedAt > this.config.auth.cacheTTL
    ).length;

    return {
      totalUsers: this.cache.size,
      expiredUsers: expired,
      validUsers: this.cache.size - expired,
    };
  }

  /**
   * 清除指定会话的用户缓存
   */
  clearUserCache(sessionId: number): void {
    // 这里可以实现基于会话的缓存清理逻辑
    // 暂时记录调试信息
    this.logger.debug(`Clearing user cache for session: ${sessionId}`);
  }
}
