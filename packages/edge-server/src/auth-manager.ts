import { EventEmitter } from 'events';
import type { Logger } from 'winston';
import { EdgeConfig, AuthConfig, AuthResult } from './types.js';
import { UserCache } from './user-cache.js';
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';

/**
 * 认证缓存项
 */
interface AuthCacheItem {
  result: AuthResult;
  timestamp: number;
}

/**
 * 认证统计
 */
interface AuthStats {
  cacheSize: number;
  cacheHitRate: number;
}

/**
 * API认证响应
 */
interface AuthAPIResponse {
  success: boolean;
  user_id?: number;
  username?: string;
  displayName?: string;
  groups?: string[];
  error?: string;
  message?: string;
  reason?: string;
}

/**
 * 认证管理器 - 处理用户认证和授权
 */
export class AuthManager extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;
  private authCache: Map<string, AuthCacheItem> = new Map();
  private userCache?: UserCache; // UserCache instance

  constructor(config: EdgeConfig, logger: Logger, userCache?: UserCache) {
    super();
    this.config = config;
    this.logger = logger;
    this.userCache = userCache;
  }

  /**
   * 初始化认证管理器
   */
  initialize(): void {
    this.logger.info('Initializing AuthManager...');

    // 清理过期缓存
    setInterval(() => {
      this.cleanupExpiredCache();
    }, 60000); // 每分钟清理一次
  }

  /**
   * 处理用户认证
   */
  async authenticate(
     session_id: number,
    username: string,
    password: string,
    tokens: string[]
  ): Promise<AuthResult> {
    try {
      this.logger.info(`Authenticating user: session=${session_id}, username=${username}`);

      // 检查缓存
      const cacheKey = `${username}:${password}`;
      const cached = this.authCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.config.auth.cacheTTL) {
        return cached.result;
      }

      // 调用外部认证 API
      const authResult = await this.authenticateWithAPI(username, password, tokens);

      // 缓存结果
      this.authCache.set(cacheKey, {
        result: authResult,
        timestamp: Date.now(),
      });

      if (authResult.success) {
        this.logger.info(
          `Authentication successful: session=${session_id}, userId=${authResult.user_id}`
        );
      } else {
        this.logger.warn(
          `Authentication failed: session=${session_id}, reason=${authResult.reason}`
        );
      }

      return authResult;
    } catch (error) {
      this.logger.error(`Authentication error for session ${session_id}:`, error);
      return {
        success: false,
        reason: 'Internal authentication error',
      };
    }
  }

  /**
   * 调用外部认证 API
   */
  private async authenticateWithAPI(
    username: string,
    password: string,
    tokens: string[]
  ): Promise<AuthResult> {
    // 支持 apiUrl 或 endpoint 字段（向后兼容）
    const authConfig = this.config.auth as AuthConfig & { endpoint?: string };
    const authUrl = authConfig.apiUrl || authConfig.endpoint;

    if (!authUrl) {
      // 如果没有配置外部 API，使用本地认证
      return this.authenticateLocally(username, password);
    }

    try {
      const response = await fetch(authUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authConfig.apiKey || ''}`,
        },
        body: JSON.stringify({
          username,
          password,
          tokens,
           server_id: this.config.server_id,
        }),
        signal: AbortSignal.timeout(authConfig.timeout || 5000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Auth API error: ${response.status} - ${errorText}`);

        // 根据 HTTP 状态码确定 reject 类型
        if (response.status === 401 || response.status === 403) {
          // 401/403 表示认证凭据错误（用户名或密码错误）
          let errorData: AuthAPIResponse | null = null;
          try {
            errorData = JSON.parse(errorText) as AuthAPIResponse;
          } catch {
            // 忽略解析错误
          }

          return {
            success: false,
            reason: errorData?.message || errorData?.reason || 'Invalid username or password',
            rejectType: mumbleproto.Reject.RejectType.WrongUserPW,
          };
        }

        // 其他错误视为服务不可用
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as AuthAPIResponse;

      this.logger.info(`Auth API response: ${JSON.stringify(result)}`);

      // 规范化返回格式，确保包含所有必需字段
      const normalized: AuthResult = {
        success: result.success || false,
        user_id: result.user_id || 0,
        username: result.username || username,
        displayName: result.displayName || result.username || username,
        groups: result.groups || ['user'],
        reason: result.message || result.reason,
        rejectType: result.success
          ? undefined
          : result.message?.includes('Invalid password')
            ? mumbleproto.Reject.RejectType.WrongUserPW
            : mumbleproto.Reject.RejectType.None,
      };

      this.logger.info(`Normalized auth result: ${JSON.stringify(normalized)}`);
      return normalized;
    } catch (error) {
      this.logger.error('External auth API error:', error);

      // 如果允许缓存回退，尝试本地缓存
      if (authConfig.allowCacheFallback) {
        return this.authenticateFromCache(username, password);
      }

      // 认证失败，返回失败结果
      return {
        success: false,
        reason: 'Authentication service unavailable',
      };
    }
  }

  /**
   * 本地认证（开发模式）
   */
  /**
   * 本地认证（备用方案）
   */
  private authenticateLocally(username: string, password: string): AuthResult {
    // 简单的本地认证逻辑
    if (username && password) {
      return {
        success: true,
        user_id: this.generateUserId(username),
        username,
        groups: ['user'],
        displayName: username,
      };
    }

    return {
      success: false,
      reason: 'Invalid credentials',
    };
  }

  /**
   * 从缓存认证
   */
  private authenticateFromCache(username: string, password: string): AuthResult {
    if (!this.userCache) {
      return {
        success: false,
        reason: 'Cache not available',
      };
    }

    // 尝试从用户缓存获取用户
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const cachedUser = this.userCache.findUserByName(username);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (cachedUser && cachedUser.password === password) {
      // 检查缓存是否过期
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (Date.now() - cachedUser.cachedAt > this.config.auth.cacheTTL) {
        this.logger.warn(`User cache expired for ${username}`);
        if (!this.config.auth.allowCacheFallback) {
          return {
            success: false,
            reason: 'Cache expired',
          };
        }
      }

      return {
        success: true,
        user_id: parseInt(cachedUser.user_id, 10),
        username: cachedUser.username,
        groups: cachedUser.groups,
        displayName: cachedUser.username,
      };
    }

    return {
      success: false,
      reason: 'User not found in cache',
    };
  }

  /**
   * 生成用户ID
   */
  private generateUserId(username: string): number {
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      const char = username.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // 转换为32位整数
    }
    return Math.abs(hash);
  }

  /**
   * 检查用户权限（占位实现）
   */
  checkPermission(_userId: number, _permission: string, _channelId?: number): boolean {
    // TODO: 实现权限检查逻辑
    return true;
  }

  /**
   * 获取用户权限组（占位实现）
   */
  getUserGroups(_userId: number): string[] {
    // TODO: 实现获取用户权限组逻辑
    return [];
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, value] of this.authCache) {
      if (now - value.timestamp > this.config.auth.cacheTTL) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.authCache.delete(key);
    }

    if (toDelete.length > 0) {
      this.logger.debug(`Cleaned up ${toDelete.length} expired auth cache entries`);
    }
  }

  /**
   * 获取认证统计
   */
  getAuthStats(): AuthStats {
    return {
      cacheSize: this.authCache.size,
      cacheHitRate: 0, // 可以实现更详细的统计
    };
  }
}
