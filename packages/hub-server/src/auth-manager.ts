/**
 * Hub Authentication Manager
 * 集中管理用户认证，Edge 通过 RPC 调用 Hub 进行认证
 */

import { createLogger } from '@munode/common';
import type { HubConfig } from './types.js';

const logger = createLogger({ service: 'hub-auth-manager' });

/**
 * 认证配置
 */
export interface AuthConfig {
  apiUrl?: string; // 外部认证 API 地址
  apiKey?: string; // API 密钥
  timeout?: number; // 超时时间（毫秒）
  headers?: {
    authHeaderName?: string; // 认证头名称，默认 'Authorization'
    authHeaderFormat?: string; // 认证头格式，默认 'Bearer {apiKey}'
  };
  responseFields?: {
    successField?: string; // 成功标志字段名，默认 'success'
    userIdField?: string; // 用户ID字段名，默认 'user_id'
    usernameField?: string; // 用户名字段名，默认 'username'
    displayNameField?: string; // 显示名字段名，默认 'displayName'
    groupsField?: string; // 用户组字段名，默认 'groups'
    reasonField?: string; // 失败原因字段名，默认 'reason' 或 'message'
  };
  cacheTTL?: number; // 缓存TTL（毫秒），默认 300000 (5分钟)
  allowCacheFallback?: boolean; // 是否允许缓存回退，默认 false
}

/**
 * 认证缓存项
 */
interface AuthCacheItem {
  result: AuthResult;
  timestamp: number;
}

/**
 * 认证结果
 */
export interface AuthResult {
  success: boolean;
  user_id?: number;
  username?: string;
  displayName?: string;
  groups?: string[];
  reason?: string;
  rejectType?: number;
}

/**
 * 认证请求参数
 */
export interface AuthRequest {
  server_id: number;
  username: string;
  password: string;
  tokens: string[];
  client_info: {
    ip_address: string;
    ip_version: string;
    release: string;
    os: string;
    os_version: string;
    certificate_hash?: string;
  };
}

/**
 * Hub 认证管理器
 */
export class HubAuthManager {
  private config: AuthConfig;
  private authCache: Map<string, AuthCacheItem> = new Map();

  constructor(hubConfig: HubConfig) {
    // 从 Hub 配置中提取认证配置
    this.config = (hubConfig as any).auth || {};
    
    // 设置默认值
    this.config.timeout = this.config.timeout || 5000;
    this.config.cacheTTL = this.config.cacheTTL || 300000;
    this.config.allowCacheFallback = this.config.allowCacheFallback ?? false;
    
    // 设置默认 header 配置
    this.config.headers = this.config.headers || {};
    this.config.headers.authHeaderName = this.config.headers.authHeaderName || 'Authorization';
    this.config.headers.authHeaderFormat = this.config.headers.authHeaderFormat || 'Bearer {apiKey}';
    
    // 设置默认响应字段映射
    this.config.responseFields = this.config.responseFields || {};
    this.config.responseFields.successField = this.config.responseFields.successField || 'success';
    this.config.responseFields.userIdField = this.config.responseFields.userIdField || 'user_id';
    this.config.responseFields.usernameField = this.config.responseFields.usernameField || 'username';
    this.config.responseFields.displayNameField = this.config.responseFields.displayNameField || 'displayName';
    this.config.responseFields.groupsField = this.config.responseFields.groupsField || 'groups';
    this.config.responseFields.reasonField = this.config.responseFields.reasonField || 'reason';

    logger.info('Hub Authentication Manager initialized');

    // 定期清理过期缓存
    setInterval(() => {
      this.cleanupExpiredCache();
    }, 60000); // 每分钟清理一次
  }

  /**
   * 认证用户
   */
  async authenticate(request: AuthRequest): Promise<AuthResult> {
    try {
      logger.info(`Authenticating user: username=${request.username}, server_id=${request.server_id}`);

      // 检查缓存 - 使用密码的哈希值而不是明文
      const crypto = await import('crypto');
      const passwordHash = crypto.createHash('sha256').update(request.password).digest('hex');
      const cacheKey = `${request.username}:${passwordHash}`;
      const cached = this.authCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < (this.config.cacheTTL || 300000)) {
        logger.debug(`Auth cache hit for user: ${request.username}`);
        return cached.result;
      }

      // 调用外部认证 API
      const authResult = await this.authenticateWithAPI(request);

      // 缓存结果
      if (authResult.success) {
        this.authCache.set(cacheKey, {
          result: authResult,
          timestamp: Date.now(),
        });
      }

      if (authResult.success) {
        logger.info(
          `Authentication successful: username=${request.username}, userId=${authResult.user_id}`
        );
      } else {
        logger.warn(
          `Authentication failed: username=${request.username}, reason=${authResult.reason}`
        );
      }

      return authResult;
    } catch (error) {
      logger.error(`Authentication error for user ${request.username}:`, error);
      return {
        success: false,
        reason: 'Internal authentication error',
      };
    }
  }

  /**
   * 调用外部认证 API
   */
  private async authenticateWithAPI(request: AuthRequest): Promise<AuthResult> {
    const authUrl = this.config.apiUrl;

    if (!authUrl) {
      // 如果没有配置外部 API，使用本地认证
      return this.authenticateLocally(request.username, request.password);
    }

    try {
      // 构建请求头
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // 添加认证头
      if (this.config.apiKey) {
        const authHeaderName = this.config.headers?.authHeaderName || 'Authorization';
        const authHeaderFormat = this.config.headers?.authHeaderFormat || 'Bearer {apiKey}';
        headers[authHeaderName] = authHeaderFormat.replace('{apiKey}', this.config.apiKey);
      }

      // 构建请求体，包含客户端信息
      const requestBody = {
        username: request.username,
        password: request.password,
        tokens: request.tokens,
        server_id: request.server_id,
        ip_address: request.client_info.ip_address,
        ip_version: request.client_info.ip_version,
        release: request.client_info.release,
        os: request.client_info.os,
        os_version: request.client_info.os_version,
        certificate_hash: request.client_info.certificate_hash,
      };

      logger.debug(`Auth API request to ${authUrl}:`, requestBody);

      const response = await fetch(authUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.timeout || 5000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Auth API error: ${response.status} - ${errorText}`);

        // 根据 HTTP 状态码确定 reject 类型
        if (response.status === 401 || response.status === 403) {
          let errorData: any = null;
          try {
            errorData = JSON.parse(errorText);
          } catch {
            // 忽略解析错误
          }

          return {
            success: false,
            reason: errorData?.message || errorData?.reason || 'Invalid username or password',
            rejectType: 2, // mumbleproto.Reject.RejectType.WrongUserPW
          };
        }

        // 其他错误视为服务不可用
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      logger.debug(`Auth API response:`, result);

      // 使用配置的字段名提取响应数据
      const fields = this.config.responseFields || {};
      const successField = fields.successField || 'success';
      const userIdField = fields.userIdField || 'user_id';
      const usernameField = fields.usernameField || 'username';
      const displayNameField = fields.displayNameField || 'displayName';
      const groupsField = fields.groupsField || 'groups';
      const reasonField = fields.reasonField || 'reason';

      // 规范化返回格式
      const normalized: AuthResult = {
        success: result[successField] || false,
        user_id: result[userIdField] || 0,
        username: result[usernameField] || request.username,
        displayName: result[displayNameField] || result[usernameField] || request.username,
        groups: result[groupsField] || ['user'],
        reason: (result as any).message || result[reasonField],
        rejectType: result[successField]
          ? undefined
          : ((result as any).message?.includes('Invalid password'))
            ? 2 // mumbleproto.Reject.RejectType.WrongUserPW
            : 0, // mumbleproto.Reject.RejectType.None
      };

      logger.debug(`Normalized auth result:`, normalized);
      return normalized;
    } catch (error) {
      logger.error('External auth API error:', error);

      // 如果允许缓存回退，尝试从缓存认证
      if (this.config.allowCacheFallback) {
        const cacheKey = `${request.username}:${request.password}`;
        const cached = this.authCache.get(cacheKey);
        if (cached) {
          logger.warn(`Using cached auth for user ${request.username} due to API error`);
          return cached.result;
        }
      }

      // 认证失败，返回失败结果
      return {
        success: false,
        reason: 'Authentication service unavailable',
      };
    }
  }

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
   * 清理过期缓存
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, value] of this.authCache) {
      if (now - value.timestamp > (this.config.cacheTTL || 300000)) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.authCache.delete(key);
    }

    if (toDelete.length > 0) {
      logger.debug(`Cleaned up ${toDelete.length} expired auth cache entries`);
    }
  }

  /**
   * 获取认证统计
   */
  getAuthStats() {
    return {
      cacheSize: this.authCache.size,
    };
  }
}
