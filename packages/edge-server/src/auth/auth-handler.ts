/**
 * 认证处理器
 * 
 * 处理用户认证相关逻辑：
 * - 认证请求处理
 * - 认证成功后的初始化
 * - 认证失败处理
 * - 证书指纹上报
 */

import { logger } from '@munode/common';
import { mumbleproto } from '@munode/protocol';
import { MessageType } from '@munode/protocol';
import { randomFillSync } from 'crypto';
import type { ClientInfo, AuthResult } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

export class AuthHandlers {
  private preConnectUserState: Map<number, {
    self_mute?: boolean;
    self_deaf?: boolean;
    plugin_context?: Buffer;
    plugin_identity?: string;
    comment?: string;
  }> = new Map();

  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get voiceRouter() { return this.factory.voiceRouter; }
  private get authManager() { return this.factory.authManager; }
  private get config() { return this.factory.config; }
  private get hubClient() { return this.factory.hubClient; }

  /**
   * 处理认证请求
   */
  async handleAuthenticate(session_id: number, data: Buffer): Promise<void> {
    try {
      // 解析认证消息
      const authMessage = mumbleproto.Authenticate.deserialize(data);
      const client = this.clientManager.getClient(session_id);

      if (!client) {
        logger.warn(`Authentication attempt for unknown session: ${session_id}`);
        return;
      }

      // 检查是否已经认证
      if (client.username) {
        logger.warn(`Session ${session_id} already authenticated`);
        this.sendReject(session_id, 'Already authenticated');
        return;
      }

      // 收集客户端信息（从客户端状态获取，如果客户端未提供则使用默认值）
      // 客户端通常在Version消息中提供这些信息
      const clientInfo = {
        ip_address: client.ip_address || '0.0.0.0',
        ip_version: client.ip_address?.includes(':') ? 'ipv6' : 'ipv4',
        release: client.client_name || 'unknown', // 客户端版本/名称
        os: client.os_name || 'unknown', // 操作系统名称
        os_version: client.os_version || 'unknown', // 操作系统版本
        certificate_hash: client.cert_hash,
      };

      // 调用认证管理器
      const authResult = await this.authManager.authenticate(
        session_id,
        authMessage.username || '',
        authMessage.password || '',
        authMessage.tokens || [],
        clientInfo
      );

      if (authResult.success) {
        // 认证成功
        await this.handleAuthSuccess(session_id, client, authResult, authMessage);
      } else {
        // 认证失败
        this.handleAuthFailure(
          session_id,
          authResult.reason || 'Authentication failed',
          authResult.rejectType || mumbleproto.Reject.RejectType.None
        );
      }
    } catch (error) {
      logger.error(`Authentication error for session ${session_id}:`, error);
      this.sendReject(session_id, 'Internal authentication error', mumbleproto.Reject.RejectType.None);
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
      // 更新客户端信息
      this.clientManager.updateClient(session_id, {
        user_id: authResult.user_id,
        username: authResult.displayName || authResult.username,
        groups: authResult.groups || [],
      });
      
      logger.info(`Auth success: user=${authResult.username}, user_id=${authResult.user_id}, groups=${JSON.stringify(authResult.groups)}`);

      // 1. 生成加密密钥并发送 CryptSetup
      const cryptKey = Buffer.alloc(16);
      const serverEncryptIV = Buffer.alloc(16);
      const serverDecryptIV = Buffer.alloc(16);

      randomFillSync(cryptKey);
      randomFillSync(serverEncryptIV);
      randomFillSync(serverDecryptIV);

      const cryptSetupMessage = new mumbleproto.CryptSetup({
        key: cryptKey,
        client_nonce: serverDecryptIV,
        server_nonce: serverEncryptIV,
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.CryptSetup, Buffer.from(cryptSetupMessage));

      // 设置客户端的 OCB2-AES128 加密密钥
      this.voiceRouter.setClientCrypto(session_id, cryptKey, serverEncryptIV, serverDecryptIV);

      // 2. 发送 CodecVersion
      const codecVersionMessage = new mumbleproto.CodecVersion({
        alpha: -2147483637, // CELT 0.7.0
        beta: -2147483632, // CELT 0.11.0
        prefer_alpha: true,
        opus: authMessage.opus || false,
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.CodecVersion, Buffer.from(codecVersionMessage));

      // 3. 发送频道树
      this.sendChannelTree(session_id);

      // 4. 发送所有其他用户的状态
      await this.sendUserListToClient(session_id);

      // 5. 应用 PreConnectUserState
      const preState = this.preConnectUserState.get(session_id);
      if (preState) {
        const updateFields: Partial<ClientInfo> = {};

        if (preState.self_mute !== undefined) {
          updateFields.self_mute = preState.self_mute;
        }
        if (preState.self_deaf !== undefined) {
          updateFields.self_deaf = preState.self_deaf;
        }
        if (preState.comment !== undefined) {
          updateFields.comment = preState.comment;
        }

        if (Object.keys(updateFields).length > 0) {
          this.clientManager.updateClient(session_id, updateFields);
          logger.debug(`Applied PreConnectUserState for session ${session_id}`, {
            self_mute: preState.self_mute,
            self_deaf: preState.self_deaf,
          });
        }

        this.preConnectUserState.delete(session_id);
      }

      // 6. 标记客户端已接收完整用户列表
      this.clientManager.updateClient(session_id, {
        has_full_user_list: true,
      });

      // 7. 获取更新后的客户端信息
      const updatedClient = this.clientManager.getClient(session_id);
      if (!updatedClient) {
        throw new Error(`Client ${session_id} not found after update`);
      }

      // 8. 发送当前用户的完整状态（必须在 ServerSync 之前）
      // 这是协议握手的关键步骤，客户端期望先收到自己的状态再收到 ServerSync
      const currentUserState = new mumbleproto.UserState({
        session: session_id,
        name: updatedClient.username,
        user_id: updatedClient.user_id,
        channel_id: updatedClient.channel_id,
        mute: updatedClient.mute || false,
        deaf: updatedClient.deaf || false,
        suppress: updatedClient.suppress || false,
        self_mute: updatedClient.self_mute || false,
        self_deaf: updatedClient.self_deaf || false,
        priority_speaker: updatedClient.priority_speaker || false,
        recording: updatedClient.recording || false,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(currentUserState));
      logger.debug(`Sent UserState for session ${session_id}: username=${updatedClient.username}, channel_id=${updatedClient.channel_id}`);

      // 9. 发送 ServerSync 消息（放在 UserState 之后）
      const serverSyncMessage = new mumbleproto.ServerSync({
        session: session_id,
        max_bandwidth: this.config.max_bandwidth || 128000,
        welcome_text: this.config.welcomeText || 'Welcome to Shitspeak Server',
        permissions: 0, // TODO: 计算权限
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.ServerSync, Buffer.from(serverSyncMessage));

      logger.info(
        `User authenticated: session=${session_id}, ` +
        `username=${updatedClient.username}, user_id=${updatedClient.user_id}`
      );

      // 10. 广播新用户加入给其他已认证客户端
      // broadcastUserStateToAuthenticatedClients 会根据接收方是否为注册用户决定是否发送证书哈希
      const broadcastStateData: any = {
        session: session_id,
        name: updatedClient.username,
        user_id: updatedClient.user_id,
        channel_id: updatedClient.channel_id,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      };
      
      // 添加非 false 的状态字段
      if (updatedClient.cert_hash) broadcastStateData.hash = updatedClient.cert_hash;
      if (updatedClient.mute) broadcastStateData.mute = true;
      if (updatedClient.deaf) broadcastStateData.deaf = true;
      if (updatedClient.suppress) broadcastStateData.suppress = true;
      if (updatedClient.self_mute) broadcastStateData.self_mute = true;
      if (updatedClient.self_deaf) broadcastStateData.self_deaf = true;
      if (updatedClient.priority_speaker) broadcastStateData.priority_speaker = true;
      if (updatedClient.recording) broadcastStateData.recording = true;
      
      const broadcastState = new mumbleproto.UserState(broadcastStateData);
      this.broadcastUserState(broadcastState, session_id);
      logger.debug(`Broadcasted UserState for new user ${updatedClient.username} (session ${session_id})`);

      // 11. 上报会话到 Hub（重要！让 Hub 知道这个用户已登录）
      if (!this.hubClient) {
        logger.warn(`hubClient is undefined, cannot report session ${session_id} to Hub`);
      } else if (!this.hubClient.isConnected()) {
        logger.warn(`hubClient is not connected, cannot report session ${session_id} to Hub`);
      } else {
        try {
          await this.hubClient.reportSession({
            session_id: session_id,
            user_id: updatedClient.user_id,
            username: updatedClient.username,
            channel_id: updatedClient.channel_id,
            startTime: new Date(),
            ip_address: updatedClient.ip_address,
            groups: updatedClient.groups,
            cert_hash: updatedClient.cert_hash,
            version: updatedClient.version,
            release: updatedClient.client_name,
            os: updatedClient.os_name,
            os_version: updatedClient.os_version,
          });
          logger.info(`Reported session ${session_id} (${updatedClient.username}) to Hub`);
        } catch (error) {
          logger.error(`Failed to report session ${session_id} to Hub:`, error);
        }
      }

      // 12. 上报证书指纹
      if (updatedClient.cert_hash && authResult.user_id > 0) {
        void this.reportCertificateFingerprint(authResult.user_id, updatedClient.cert_hash);
      }
    } catch (error) {
      logger.error(`Error in handleAuthSuccess for session ${session_id}:`, error);
      this.sendReject(session_id, 'Authentication setup failed');
    }
  }

  /**
   * 处理认证失败
   */
  handleAuthFailure(
    session_id: number,
    reason: string,
    rejectType: mumbleproto.Reject.RejectType = mumbleproto.Reject.RejectType.None
  ): void {
    logger.warn(`Authentication failed for session ${session_id}: ${reason}`);
    this.sendReject(session_id, reason, rejectType);
    
    // 认证失败时断开客户端连接
    this.clientManager.forceDisconnect(session_id, `Authentication failed: ${reason}`);
  }

  /**
   * 保存 PreConnect 用户状态
   */
  savePreConnectUserState(
    session_id: number,
    state: {
      self_mute?: boolean;
      self_deaf?: boolean;
      plugin_context?: Buffer;
      plugin_identity?: string;
      comment?: string;
    }
  ): void {
    this.preConnectUserState.set(session_id, state);
    logger.debug(`Saved PreConnectUserState for session ${session_id}`);
  }

  /**
   * 清理 PreConnect 用户状态
   */
  clearPreConnectUserState(session_id: number): void {
    this.preConnectUserState.delete(session_id);
  }

  /**
   * 上报证书指纹到外部API
   */
  private async reportCertificateFingerprint(user_id: number, cert_hash: string): Promise<void> {
    if (!this.config.auth.apiUrl) {
      return;
    }

    try {
      const response = await fetch(`${this.config.auth.apiUrl}/fingerprint`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.auth.apiKey}`,
        },
        body: JSON.stringify({
          user_id: user_id,
          cert_hash: cert_hash,
          timestamp: Date.now(),
        }),
        signal: AbortSignal.timeout(this.config.auth.timeout),
      });

      if (!response.ok) {
        logger.warn(`Failed to report certificate fingerprint: ${response.status}`);
      }
    } catch (error) {
      logger.error('Error reporting certificate fingerprint:', error);
    }
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
    rejectType?: mumbleproto.Reject.RejectType
  ): void {
    const messageHandlers = this.factory.messageHandlers;
    messageHandlers.sendReject(session_id, reason, rejectType);
  }

  /**
   * 广播用户状态（委托给 MessageHandlers）
   */
  private broadcastUserState(
    userState: mumbleproto.UserState,
    excludeSession?: number
  ): void {
    const messageHandlers = this.factory.messageHandlers;
    messageHandlers.broadcastUserStateToAuthenticatedClients(userState, excludeSession);
  }
}
