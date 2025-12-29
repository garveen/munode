/**
 * Hub Authentication Manager
 * 集中管理用户认证，Edge 通过 RPC 调用 Hub 进行认证
 */

import type { Logger } from '@munode/common';
import type { HubConfig, ExternalAuthRequest } from './types.js';
import type { HubAuthConfig } from './config-schema.js';
import { isAuthConfigWithCallback, isAuthConfigWithApi } from './config-schema.js';

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
  session_id: number;
  server_id: number;
  username: string;
  password: string;
  tokens: string[];
  client_info: {
    ip_address: string;
    ip_version: string;
    release: string;
    version?: number; // 客户端版本号（数字格式，例如：66051 代表 1.2.3）
    os: string;
    os_version: string;
    certificate_hash?: string;
  };
}

/**
 * Hub 认证管理器
 */
export class HubAuthManager {
  private config: NonNullable<HubAuthConfig>;
  private authCache: Map<string, AuthCacheItem> = new Map();

  private logger: Logger;

  constructor(hubConfig: HubConfig, logger: Logger) {
    this.logger = logger;
    // 从 Hub 配置中提取认证配置
    this.config = (hubConfig as { auth?: HubAuthConfig }).auth || ({} as NonNullable<HubAuthConfig>);

    // 日志初始化信息
    if (isAuthConfigWithCallback(this.config)) {
      this.logger.debug('Hub Authentication Manager initialized with callback function');
    } else if (isAuthConfigWithApi(this.config)) {
      this.logger.debug('Hub Authentication Manager initialized with API URL', {
        api_url: this.config.api_url,
        content_type: this.config.content_type
      });
    } else {
      this.logger.debug('Hub Authentication Manager initialized with local authentication');
    }

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
      this.logger.info(`Authenticating user: username=${request.username}, server_id=${request.server_id}`);

      // 检查缓存 - 使用密码的哈希值而不是明文
      const crypto = await import('crypto');
      const passwordHash = crypto.createHash('sha256').update(request.password).digest('hex');
      const cacheKey = `${request.username}:${passwordHash}`;
      const cached = this.authCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < (this.config.cache_ttl || 300000)) {
        this.logger.debug(`Auth cache hit for user: ${request.username}`);
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
        this.logger.info(
          `Authentication successful: username=${request.username}, userId=${authResult.user_id}`
        );
      } else {
        this.logger.warn(
          `Authentication failed: username=${request.username}, reason=${authResult.reason}`
        );
      }

      return authResult;
    } catch (error) {
      this.logger.error(`Authentication error for user ${request.username}:`, error);
      return {
        success: false,
        reason: 'Internal authentication error',
      };
    }
  }

  /**
   * 调用外部认证 API 或回调
   */
  private async authenticateWithAPI(request: AuthRequest): Promise<AuthResult> {
    // 方式1: 如果配置了回调函数，优先使用回调
    if (isAuthConfigWithCallback(this.config)) {
      try {
        const externalRequest: ExternalAuthRequest = {
          username: request.username,
          password: request.password,
          tokens: request.tokens,
          session_id: request.session_id,
          server_id: request.server_id,
          ip_address: request.client_info.ip_address,
          ip_version: request.client_info.ip_version,
          release: request.client_info.release,
          version: request.client_info.version,
          os: request.client_info.os,
          os_version: request.client_info.os_version,
          certificate_hash: request.client_info.certificate_hash,
        };

        this.logger.debug('Authenticating with callback function', { username: request.username });
        const result = await this.config.callback(externalRequest);

        this.logger.info(`Callback auth result for ${request.username}: success=${result.success}`);
        return result;
      } catch (error) {
        this.logger.error('Callback authentication error:', error);
        return {
          success: false,
          reason: 'Authentication callback error',
        };
      }
    }

    // 方式2: 使用 HTTP API
    if (!isAuthConfigWithApi(this.config)) {
      // 如果没有配置外部 API，使用本地认证
      return this.authenticateLocally(request.username, request.password);
    }

    // 类型守卫后，this.config 已经是 HubAuthConfigWithApi 类型
    const authUrl = this.config.api_url;

    try {
      // 确定内容类型
      const contentType = this.config.content_type;

      // 构建请求头
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        "Accept": "application/json",
      };

      // 添加认证头
      if (this.config.api_key) {
        const authHeaderName = this.config.headers?.auth_header_name || 'Authorization';
        const authHeaderFormat = this.config.headers?.auth_header_format || 'Bearer {apiKey}';
        headers[authHeaderName] = authHeaderFormat.replace('{apiKey}', this.config.api_key);
      }

      // 构建请求数据（使用标准字段名）
      const requestData: Record<string, string | number | string[] | undefined> = {
        username: request.username,
        password: request.password,
        tokens: request.tokens,
        session_id: request.session_id,
        server_id: request.server_id,
        ip_address: request.client_info.ip_address,
        ip_version: request.client_info.ip_version,
        release: request.client_info.release,
        os: request.client_info.os,
        os_version: request.client_info.os_version,
      };

      if (request.client_info.version !== undefined) {
        requestData.version = request.client_info.version;
      }
      if (request.client_info.certificate_hash) {
        requestData.certificate_hash = request.client_info.certificate_hash;
      }

      // 根据内容类型编码请求体
      let body: string;
      if (contentType === 'application/x-www-form-urlencoded') {
        // URL 编码
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(requestData)) {
          if (Array.isArray(value)) {
            // 数组字段处理（如 tokens）
            value.forEach(v => params.append(key + '[]', String(v)));
          } else if (value !== undefined && value !== null) {
            params.append(key, String(value));
          }
        }
        body = params.toString();
        this.logger.debug(`Auth API request to ${authUrl} (form-urlencoded):`, { body });
      } else {
        // JSON 编码（默认）
        body = JSON.stringify(requestData);
        this.logger.debug(`Auth API request to ${authUrl} (json):`, requestData);
      }

      const response = await fetch(authUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Auth API error: ${response.status} - ${errorText}`);

        // 根据 HTTP 状态码确定 reject 类型
        if (response.status === 401 || response.status === 403) {
          let errorData: { message?: string; reason?: string } | null = null;
          try {
            const parsed: unknown = JSON.parse(errorText);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              errorData = parsed as { message?: string; reason?: string };
            }
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
      this.logger.info(`Auth API response for user ${request.username}:`, result);

      // 使用配置的字段名提取响应数据（带默认值）
      const fields = this.config.response_fields;
      const successField = fields?.success_field ?? 'success';
      const successValue = fields?.success_value ?? true;
      const userIdField = fields?.user_id_field ?? 'user_id';
      const usernameField = fields?.username_field ?? 'username';
      const displayNameField = fields?.display_name_field ?? 'displayName';
      const groupsField = fields?.groups_field ?? 'groups';
      const reasonField = fields?.reason_field ?? 'reason';

      // 判断认证是否成功：比较响应中的成功字段值与配置的期望值
      const isSuccess = result[successField] === successValue;

      // 规范化返回格式
      const normalized: AuthResult = {
        success: isSuccess,
        user_id: result[userIdField] || 0,
        username: result[usernameField] || request.username,
        displayName: result[displayNameField] || result[usernameField] || request.username,
        groups: result[groupsField] || ['user'],
        reason: (result as { message?: string })[reasonField] || (result as { message?: string }).message,
        rejectType: isSuccess
          ? undefined
          : (typeof (result as { message?: string }).message === 'string' && (result as { message?: string }).message?.includes('Invalid password'))
            ? 2 // mumbleproto.Reject.RejectType.WrongUserPW
            : 0, // mumbleproto.Reject.RejectType.None
      };

      this.logger.info(`Normalized auth result for ${request.username}: userId=${normalized.user_id}, groups=${JSON.stringify(normalized.groups)}`);
      return normalized;
    } catch (error) {
      this.logger.error('External auth API error:', error);

      // 如果允许缓存回退，尝试从缓存认证
      if (this.config.allow_cache_fallback) {
        const cacheKey = `${request.username}:${request.password}`;
        const cached = this.authCache.get(cacheKey);
        if (cached) {
          this.logger.warn(`Using cached auth for user ${request.username} due to API error`);
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
      if (now - value.timestamp > (this.config.cache_ttl || 300000)) {
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
  getAuthStats() {
    return {
      cacheSize: this.authCache.size,
    };
  }
}
