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
          mumbleproto.Reject.RejectType.None
        );
        return;
      }

      // 解析认证消息
      const authMessage = mumbleproto.Authenticate.deserialize(data);

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

      // 调用认证管理器
      // 获取 PreConnect 状态（如果有）
      const preState = this.stateHandlers.getPreConnectUserState(session_id);

      const authResult = await this.authManager.authenticate(
        session_id,
        authMessage.username || '',
        authMessage.password || '',
        authMessage.tokens || [],
        clientInfo,
        preState
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
        this.logger.error(`Authentication error for session ${session_id}:`, error);
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

      // 3. 使用 Hub 返回的频道 ID 更新客户端
      // Hub 已经处理了 last channel、权限检查等逻辑
      if (authResult.channel_id !== undefined) {
        this.clientManager.updateClient(session_id, {
          channel_id: authResult.channel_id,
        });
        this.logger.debug(`Set user channel to ${authResult.channel_id} (from Hub)`);
      }

      // 清理 PreConnect 状态（已经由 Hub 处理）
      this.stateHandlers.clearPreConnectUserState(session_id);

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
      const selfUserState = new mumbleproto.UserState({
        session: session_id,
        actor: session_id,
        name: updatedClient.username,
        user_id: updatedClient.user_id,
        channel_id: updatedClient.channel_id,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      });

      this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(selfUserState.serialize()));

      // 9. 发送 ServerSync 消息
      // Hub 会通过 hub.userJoined 通知所有 Edge（包括本 Edge），广播给其他客户端
      const serverSyncMessage = new mumbleproto.ServerSync({
        session: session_id,
        max_bandwidth: this.config.max_bandwidth || 128000,
        welcome_text: this.config.welcomeText || 'Welcome to Shitspeak Server',
        permissions: 0, // TODO: 计算权限
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.ServerSync, Buffer.from(serverSyncMessage));

      // 10. 更新客户端状态为 Ready
      this.clientManager.updateClient(session_id, {
        state: ClientState.Ready,
      });

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
    rejectType: mumbleproto.Reject.RejectType = mumbleproto.Reject.RejectType.None
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
    rejectType?: mumbleproto.Reject.RejectType
  ): void {
    const messageHandlers = this.factory.messageHandlers;
    messageHandlers.sendReject(session_id, reason, rejectType);
  }

}
