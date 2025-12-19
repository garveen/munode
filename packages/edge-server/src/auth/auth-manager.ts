import type { Logger } from 'winston';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import { EdgeConfig, AuthResult } from '../types.js';
import type { EdgeControlClient } from '../cluster/hub-client.js';

/**
 * AuthManager 事件类型定义
 */
export interface AuthManagerEvents extends EventMap {
  // AuthManager 当前没有发出事件，保留用于未来扩展
}

/**
 * 认证管理器 - 处理用户认证和授权
 * 所有认证请求必须通过 Hub 进行，Edge 不保留本地用户数据
 */
export class AuthManager extends TypedEventEmitter<AuthManagerEvents> {
  private config: EdgeConfig;
  private logger: Logger;
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
    this.logger.info('AuthManager initialized');
    // Edge does not cache authentication results
    // All authentication goes through Hub
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
    },
    preConnectState?: {
      self_mute?: boolean;
      self_deaf?: boolean;
      mute?: boolean;
      deaf?: boolean;
      suppress?: boolean;
      priority_speaker?: boolean;
      recording?: boolean;
      plugin_context?: Buffer;
      plugin_identity?: string;
      comment?: string;
    }
  ): Promise<AuthResult> {
    try {
      this.logger.info(`Authenticating user: session=${session_id}, username=${username}`);

      // Edge does NOT cache authentication results.
      // Hub is the single source of truth for authentication and session management.
      // 
      // Unlike C++ Murmur which inserts session into qhUsers immediately in msgAuthenticate,
      // we MUST call Hub's authenticateUser RPC for every new connection to ensure:
      // 1. Session is registered in Hub's SessionManager
      // 2. User authentication is validated (password, external auth API, etc.)
      // 3. User permissions and groups are loaded
      // 4. Initial channel is determined (last channel, default channel, etc.)
      //
      // Hub may use its own auth cache internally to optimize external API calls,
      // but Edge always calls Hub for each new session.

      // 通过 Hub 认证
      const authResult = await this.authenticateViaHub(session_id, username, password, tokens, clientInfo, preConnectState);

      if (authResult.success) {
        this.logger.info(
          `Authentication successful: session=${session_id}, userId=${authResult.user_id}${authResult.channel_id !== undefined ? `, channel=${authResult.channel_id}` : ''}`
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
    },
    preConnectState?: {
      self_mute?: boolean;
      self_deaf?: boolean;
      mute?: boolean;
      deaf?: boolean;
      suppress?: boolean;
      priority_speaker?: boolean;
      recording?: boolean;
      plugin_context?: Buffer;
      plugin_identity?: string;
      comment?: string;
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
      // 调用 Hub 的认证 RPC，包含 PreConnect 状态
      const authParams: {
        session_id: number;
        server_id: number;
        username: string;
        password: string;
        tokens: string[];
        client_info: {
          ip_address: string;
          ip_version: string;
          release: string;
          version?: number;
          os: string;
          os_version: string;
          certificate_hash?: string;
        };
        mute?: boolean;
        deaf?: boolean;
        suppress?: boolean;
        self_mute?: boolean;
        self_deaf?: boolean;
        priority_speaker?: boolean;
        recording?: boolean;
      } = {
        session_id: session_id,
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
      };

      // 添加 PreConnect 状态 - 只添加真正设置的字段
      // 注意：只传递 boolean 状态字段，plugin_context/plugin_identity/comment 由 UserState 处理
      if (preConnectState?.self_mute === true) {
        authParams.self_mute = true;
      }
      if (preConnectState?.self_deaf === true) {
        authParams.self_deaf = true;
      }
      if (preConnectState?.mute === true) {
        authParams.mute = true;
      }
      if (preConnectState?.deaf === true) {
        authParams.deaf = true;
      }
      if (preConnectState?.suppress === true) {
        authParams.suppress = true;
      }
      if (preConnectState?.priority_speaker === true) {
        authParams.priority_speaker = true;
      }
      if (preConnectState?.recording === true) {
        authParams.recording = true;
      }

      const response = await this.hubClient.call('edge.authenticateUser', authParams);

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

}
