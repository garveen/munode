/**
 * 认证处理器
 * 
 * 处理用户认证相关逻辑：
 * - 认证请求处理
 * - 认证成功后的初始化
 * - 认证失败处理
 * - 证书指纹上报
 */

import type { Logger } from 'winston';
import { mumbleproto, MessageType, ClientState } from '@munode/protocol';
import { DEFAULT_RATE_LIMITS } from '@munode/common';
import { randomFillSync } from 'crypto';
import type { ClientInfo, AuthResult } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

export class AuthHandlers {
  private logger: Logger;

  constructor(private factory: HandlerFactory) {
    this.logger = factory.logger;
  }

  private get clientManager() { return this.factory.clientManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get voiceRouter() { return this.factory.voiceRouter; }
  private get authManager() { return this.factory.authManager; }
  private get config() { return this.factory.config; }
  private get stateHandlers() { return this.factory.stateHandlers; }
  private get edgeServer() { return this.factory.edgeServer; }

  /**
   * 处理认证请求
   */
  async handleAuthenticate(session_id: number, data: Buffer): Promise<void> {
    try {
      const client = this.clientManager.getClient(session_id);

      if (!client) {
        this.logger.warn(`Authentication attempt for unknown session: ${session_id}`);
        return;
      }

      // 检查客户端状态：允许在 Connected、ServerSentVersion 或 ClientSentVersion 状态认证（与 C 实现一致）
      if (client.state !== ClientState.Connected && 
          client.state !== ClientState.ServerSentVersion &&
          client.state !== ClientState.ClientSentVersion) {
        this.logger.warn(
          `Authentication attempt in wrong state for session ${session_id}: state=${client.state}`
        );
        this.sendReject(
          session_id,
          'Invalid state for authentication',
          mumbleproto.Reject_RejectType.None
        );
        return;
      }

      // 解析认证消息
      const authMessage = mumbleproto.Authenticate.decode(data);

      // 检查是否已经认证
      if (client.username) {
        this.logger.warn(`Session ${session_id} already authenticated`);
        this.sendReject(session_id, 'Already authenticated');
        return;
      }

      // 收集客户端信息（从客户端状态获取，如果客户端未提供则使用默认值）
      // 客户端通常在Version消息中提供这些信息
      const clientInfo = {
        ip_address: client.ip_address || '0.0.0.0',
        ip_version: client.ip_address?.includes(':') ? 'ipv6' : 'ipv4',
        release: client.client_name || 'unknown', // 客户端版本/名称
        version: client.version_number, // 数字版本号
        os: client.os_name || 'unknown', // 操作系统名称
        os_version: client.os_version || 'unknown', // 操作系统版本
        certificate_hash: client.cert_hash,
      };

      // Get pending UserState if it exists (preConnect state)
      const pendingState = this.stateHandlers.getPendingUserStateDecoded(session_id);

      // 调用认证管理器
      const authResult = await this.authManager.authenticate(
        session_id,
        authMessage.username || '',
        authMessage.password || '',
        authMessage.tokens || [],
        clientInfo,
        pendingState
      );

      if (authResult.success) {
        // 认证成功
        await this.handleAuthSuccess(session_id, client, authResult, authMessage);
      } else {
        // 认证失败
        this.handleAuthFailure(
          session_id,
          authResult.reason || 'Authentication failed',
          authResult.rejectType || mumbleproto.Reject_RejectType.None
        );
      }
    } catch (error) {
        this.logger.error(`Authentication error for session ${session_id}:`, error);
      this.sendReject(session_id, 'Internal authentication error', mumbleproto.Reject_RejectType.None);
    }
  }

  /**
   * 处理认证成功
   */
  async handleAuthSuccess(
    session_id: number,
    _client: ClientInfo,
    authResult: AuthResult,
    authMessage: mumbleproto.Authenticate
  ): Promise<void> {
    try {
      // 保存从 Hub 接收的 cert_required 配置
      if (authResult.cert_required !== undefined) {
        this.edgeServer.setCertRequired(authResult.cert_required);
      }
      
      // 更新客户端信息，并更新状态为 Authenticated
      this.clientManager.updateClient(session_id, {
        user_id: authResult.user_id,
        username: authResult.displayName || authResult.username,
        groups: authResult.groups || [],
        state: ClientState.Authenticated, // 认证完成
      });
      
        this.logger.info(`Auth success: user=${authResult.username}, user_id=${authResult.user_id}, groups=${JSON.stringify(authResult.groups)}, state=Authenticated`);

      // 1. 生成加密密钥并发送 CryptSetup
      const cryptKey = Buffer.alloc(16);
      const serverEncryptIV = Buffer.alloc(16);
      const serverDecryptIV = Buffer.alloc(16);

      randomFillSync(cryptKey);
      randomFillSync(serverEncryptIV);
      randomFillSync(serverDecryptIV);

      const cryptSetupMessage = mumbleproto.CryptSetup.encode({
        key: cryptKey,
        client_nonce: serverDecryptIV,
        server_nonce: serverEncryptIV,
      }).finish();

      this.messageHandler.sendMessage(session_id, MessageType.CryptSetup, Buffer.from(cryptSetupMessage));

      // 设置客户端的 OCB2-AES128 加密密钥
      await this.voiceRouter.setClientCrypto(session_id, cryptKey, serverEncryptIV, serverDecryptIV);

      // 2. 发送 CodecVersion
      const codecVersionMessage = mumbleproto.CodecVersion.encode({
        alpha: -2147483637, // CELT 0.7.0
        beta: -2147483632, // CELT 0.11.0
        prefer_alpha: true,
        opus: authMessage.opus || false,
      }).finish();

      this.messageHandler.sendMessage(session_id, MessageType.CodecVersion, Buffer.from(codecVersionMessage));

      // 3. 使用 Hub 返回的频道 ID 更新客户端
      // Hub 已经处理了 last channel、权限检查等逻辑
      if (authResult.channel_id !== undefined) {
        this.clientManager.updateClient(session_id, {
          channel_id: authResult.channel_id,
        });
        this.logger.debug(`Set user channel to ${authResult.channel_id} (from Hub)`);
      }

      // 4. 发送频道树
      this.sendChannelTree(session_id);

      // 5. 标记客户端即将接收用户列表
      // 重要：必须在 sendUserListToClient 之前设置此标志
      // 这样在用户列表传输过程中，如果其他用户改变状态，Hub 广播的状态更新会被正确处理
      // 参考 Murmur 实现：https://github.com/mumble-voip/mumble/blob/master/src/murmur/Server.cpp
      this.clientManager.updateClient(session_id, {
        has_full_user_list: true,
      });

      // 6. 发送所有其他用户的状态
      await this.sendUserListToClient(session_id);

      // 7. 获取更新后的客户端信息
      const updatedClient = this.clientManager.getClient(session_id);
      if (!updatedClient) {
        throw new Error(`Client ${session_id} not found after update`);
      }

      // 8. 向用户自己发送 UserState（必须在 ServerSync 之前）
      // 参考 Mumble 客户端实现：msgServerSync 期望在收到 ServerSync 前已有 user profile
      // 参考 Go 实现：在 goroutine 中广播 UserState（包括用户自己），然后主线程发送 ServerSync
      // 从 Hub 返回的认证结果中获取初始状态（包括 suppress）
      const selfUserStateData: {
        session: number;
        actor: number;
        name: string;
        user_id?: number;
        channel_id: number;
        mute?: boolean;
        deaf?: boolean;
        suppress?: boolean;
        self_mute?: boolean;
        self_deaf?: boolean;
        priority_speaker?: boolean;
        recording?: boolean;
        temporary_access_tokens: string[];
        listening_channel_add: number[];
        listening_channel_remove: number[];
      } = {
        session: session_id,
        actor: session_id,
        name: updatedClient.username,
        user_id: updatedClient.user_id,
        channel_id: updatedClient.channel_id,
        // Include initial state from Hub authentication result
        mute: authResult.mute,
        deaf: authResult.deaf,
        suppress: authResult.suppress,
        self_mute: authResult.self_mute,
        self_deaf: authResult.self_deaf,
        priority_speaker: authResult.priority_speaker,
        recording: authResult.recording,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      };

      const selfUserState = mumbleproto.UserState.encode(selfUserStateData).finish();
      this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(selfUserState));

      // 9. 发送 ServerSync 消息
      // Hub 会通过 hub.userJoined 通知所有 Edge（包括本 Edge），广播给其他客户端
      const hubLimits = this.factory.hubLimits;
      const serverSyncMessage = mumbleproto.ServerSync.encode({
        session: session_id,
        max_bandwidth: hubLimits?.max_bandwidth ?? this.config.server.max_bandwidth ?? 128000,
        welcome_text: hubLimits?.welcome_text ?? this.config.server.welcome_text ?? 'Welcome to Munode Server',
        permissions: 0, // TODO: 计算权限
      }).finish();

      this.messageHandler.sendMessage(session_id, MessageType.ServerSync, Buffer.from(serverSyncMessage));

      // 9.5. 发送 ServerConfig 消息
      // 注意：cert_required 配置不发送给客户端，由服务器端在连接时强制执行
      // welcome_text 已在 ServerSync 中发送，此处不再重复发送
      const serverConfigMessage = mumbleproto.ServerConfig.encode({
        max_bandwidth: hubLimits?.max_bandwidth ?? this.config.server.max_bandwidth,
        allow_html: true,
        message_length: hubLimits?.text_message_length ?? 5000,
        image_message_length: hubLimits?.image_message_length ?? 131072,
        max_users: hubLimits?.max_users ?? this.config.server.capacity,
        recording_allowed: true,
      }).finish();
      this.messageHandler.sendMessage(session_id, MessageType.ServerConfig, Buffer.from(serverConfigMessage));

      // 9.6. 发送 SuggestConfig 消息（优先使用 Hub 下发的限制配置）
      const suggestConfig: {
        version?: number;
        positional?: boolean;
        push_to_talk?: boolean;
      } = {};
      let hasSuggestion = false;

      if (hubLimits?.suggest_version !== undefined && hubLimits.suggest_version > 0) {
        suggestConfig.version = hubLimits.suggest_version;
        hasSuggestion = true;
      } else if (this.config.client.suggest_version !== undefined && this.config.client.suggest_version > 0) {
        suggestConfig.version = this.config.client.suggest_version;
        hasSuggestion = true;
      }
      if (hubLimits?.suggest_positional !== undefined) {
        suggestConfig.positional = hubLimits.suggest_positional;
        hasSuggestion = true;
      } else if (this.config.client.suggest_positional !== undefined) {
        suggestConfig.positional = this.config.client.suggest_positional;
        hasSuggestion = true;
      }
      if (hubLimits?.suggest_push_to_talk !== undefined) {
        suggestConfig.push_to_talk = hubLimits.suggest_push_to_talk;
        hasSuggestion = true;
      } else if (this.config.client.suggest_push_to_talk !== undefined) {
        suggestConfig.push_to_talk = this.config.client.suggest_push_to_talk;
        hasSuggestion = true;
      }

      if (hasSuggestion) {
        const suggestMessage = mumbleproto.SuggestConfig.encode(suggestConfig).finish();
        this.messageHandler.sendMessage(session_id, MessageType.SuggestConfig, Buffer.from(suggestMessage));
      }

      // 10. 更新客户端状态为 Ready
      this.clientManager.updateClient(session_id, {
        state: ClientState.Ready,
      });

      // 应用 Hub 下发的速率限制（如果已收到）
      if (hubLimits?.message_rate && hubLimits.message_rate > 0) {
        this.clientManager.applyHubMessageRateLimits(
          session_id,
          hubLimits.message_rate,
          hubLimits.message_burst ?? DEFAULT_RATE_LIMITS.message.capacity,
        );
      }
      
      // 11. 处理待处理的UserState（如果有）
      // 在认证期间收到的UserState会被延迟到这里处理
      this.stateHandlers.processPendingUserState(session_id);

      this.logger.info(
        `[AUTH-FLOW] User authenticated and ready: session=${session_id}, ` +
        `username=${updatedClient.username}, user_id=${updatedClient.user_id}, channel=${updatedClient.channel_id}, state=Ready. ` +
        `Hub will broadcast userJoined to other clients.`
      );

    } catch (error) {
        this.logger.error(`Error in handleAuthSuccess for session ${session_id}:`, error);
      this.sendReject(session_id, 'Authentication setup failed');
    }
  }

  /**
   * 处理认证失败
   */
  handleAuthFailure(
    session_id: number,
    reason: string,
    rejectType: mumbleproto.Reject_RejectType = mumbleproto.Reject_RejectType.None
  ): void {
        this.logger.warn(`Authentication failed for session ${session_id}: ${reason}`);
    this.sendReject(session_id, reason, rejectType);
    
    // 认证失败时断开客户端连接
    this.clientManager.forceDisconnect(session_id, `Authentication failed: ${reason}`);
  }

  /**
   * 发送频道树（委托给 MessageHandlers）
   */
  private sendChannelTree(session_id: number): void {
    const messageHandlers = this.factory.messageHandlers;
    messageHandlers.sendChannelTree(session_id);
  }

  /**
   * 发送用户列表（委托给 MessageHandlers）
   */
  private async sendUserListToClient(session_id: number): Promise<void> {
    const messageHandlers = this.factory.messageHandlers;
    await messageHandlers.sendUserListToClient(session_id);
  }

  /**
   * 发送拒绝消息（委托给 MessageHandlers）
   */
  private sendReject(
    session_id: number,
    reason: string,
    rejectType?: mumbleproto.Reject_RejectType
  ): void {
    const messageHandlers = this.factory.messageHandlers;
    messageHandlers.sendReject(session_id, reason, rejectType);
  }

}
