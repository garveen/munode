import { EventEmitter } from 'events';
import type { Logger } from 'winston';
import { EdgeConfig, AuthResult } from '../types.js';
import type { EdgeControlClient } from '../cluster/hub-client.js';

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
 * 认证管理器 - 处理用户认证和授权
 * 所有认证请求必须通过 Hub 进行，Edge 不保留本地用户数据
 */
export class AuthManager extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;
  private authCache: Map<string, AuthCacheItem> = new Map();
  private hubClient?: EdgeControlClient; // Hub 客户端

  constructor(config: EdgeConfig, logger: Logger, hubClient?: EdgeControlClient) {
    super();
    this.config = config;
    this.logger = logger;
    this.hubClient = hubClient;
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
   * 设置 Hub 客户端
   */
  setHubClient(hubClient: EdgeControlClient): void {
    this.hubClient = hubClient;
  }

  /**
   * 处理用户认证
   */
  async authenticate(
    session_id: number,
    username: string,
    password: string,
    tokens: string[],
    clientInfo?: {
      ip_address: string;
      ip_version: string;
      release: string;
      version?: number;
      os: string;
      os_version: string;
      certificate_hash?: string;
    }
  ): Promise<AuthResult> {
    try {
      this.logger.info(`Authenticating user: session=${session_id}, username=${username}`);

      // 检查缓存 - 使用密码的哈希值而不是明文
      const crypto = await import('crypto');
      const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
      const cacheKey = `${username}:${passwordHash}`;
      const cached = this.authCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.config.auth.cacheTTL) {
        return cached.result;
      }

      // 通过 Hub 认证
      const authResult = await this.authenticateViaHub(session_id, username, password, tokens, clientInfo);

      // 缓存结果
      if (authResult.success) {
        this.authCache.set(cacheKey, {
          result: authResult,
          timestamp: Date.now(),
        });
      }

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
   * 通过 Hub 进行认证
   */
  private async authenticateViaHub(
    session_id: number,
    username: string,
    password: string,
    tokens: string[],
    clientInfo?: {
      ip_address: string;
      ip_version: string;
      release: string;
      version?: number;
      os: string;
      os_version: string;
      certificate_hash?: string;
    }
  ): Promise<AuthResult> {
    if (!this.hubClient || !this.hubClient.isConnected()) {
      this.logger.error('Hub client not connected, authentication unavailable');
      return {
        success: false,
        reason: 'Authentication service unavailable',
      };
    }

    try {
      // 调用 Hub 的认证 RPC
      const response = await this.hubClient.call('edge.authenticateUser', {
        session_id: session_id, // 使用真实的客户端 session_id
        server_id: this.config.server_id,
        username,
        password,
        tokens,
        client_info: clientInfo || {
          ip_address: '0.0.0.0',
          ip_version: 'ipv4',
          release: 'unknown',
          os: 'unknown',
          os_version: 'unknown',
        },
      });

      this.logger.debug(`Hub auth response:`, response);
      return response as AuthResult;
    } catch (error) {
      this.logger.error('Hub authentication error:', error);
      return {
        success: false,
        reason: 'Authentication service error',
      };
    }
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
