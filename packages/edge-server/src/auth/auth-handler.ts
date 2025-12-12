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
  private preConnectUserState: Map<number, {
    self_mute?: boolean;
    self_deaf?: boolean;
    plugin_context?: Buffer;
    plugin_identity?: string;
    comment?: string;
  }> = new Map();
  private logger: Logger;

  constructor(private factory: HandlerFactory) {
    this.logger = factory.logger;
  }

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

      // 3. 上报会话到 Hub（必须在发送用户列表之前！）
      // 这样其他用户在调用 fullSync 时就能看到这个新用户
      // 移到这里可以避免竞态条件：用户B登录时可能看不到刚登录的用户A
      const clientBeforeSync = this.clientManager.getClient(session_id);
      if (!clientBeforeSync) {
        throw new Error(`Client ${session_id} not found before sync`);
      }
      
      if (!this.hubClient) {
        this.logger.warn(`hubClient is undefined, cannot report session ${session_id} to Hub`);
      } else if (!this.hubClient.isConnected()) {
        this.logger.warn(`hubClient is not connected, cannot report session ${session_id} to Hub`);
      } else {
        try {
          await this.hubClient.reportSession({
            session_id: session_id,
            user_id: clientBeforeSync.user_id,
            username: clientBeforeSync.username,
            channel_id: clientBeforeSync.channel_id,
            startTime: clientBeforeSync.connected_at || new Date(),
            ip_address: clientBeforeSync.ip_address,
            groups: clientBeforeSync.groups,
            cert_hash: clientBeforeSync.cert_hash,
            version: clientBeforeSync.version,
            release: clientBeforeSync.client_name,
            os: clientBeforeSync.os_name,
            os_version: clientBeforeSync.os_version,
          });
        this.logger.info(`Reported session ${session_id} (${clientBeforeSync.username}) to Hub (before user list sync)`);
        } catch (error) {
        this.logger.error(`Failed to report session ${session_id} to Hub:`, error);
          // Continue even if Hub report fails - local operations should still work
        }
      }

      // 4. 发送频道树
      this.sendChannelTree(session_id);

      // 5. 发送所有其他用户的状态
      await this.sendUserListToClient(session_id);

      // 6. 应用 PreConnectUserState
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
        this.logger.debug(`Applied PreConnectUserState for session ${session_id}`, {
            self_mute: preState.self_mute,
            self_deaf: preState.self_deaf,
          });
        }

        this.preConnectUserState.delete(session_id);
      }

      // 7. 标记客户端已接收完整用户列表
      this.clientManager.updateClient(session_id, {
        has_full_user_list: true,
      });

      // 8. 获取更新后的客户端信息
      const updatedClient = this.clientManager.getClient(session_id);
      if (!updatedClient) {
        throw new Error(`Client ${session_id} not found after update`);
      }

      // 9. 发送当前用户的完整状态（必须在 ServerSync 之前）
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
        this.logger.debug(`Sent UserState for session ${session_id}: username=${updatedClient.username}, channel_id=${updatedClient.channel_id}`);

      // 10. 发送 ServerSync 消息（放在 UserState 之后）
      const serverSyncMessage = new mumbleproto.ServerSync({
        session: session_id,
        max_bandwidth: this.config.max_bandwidth || 128000,
        welcome_text: this.config.welcomeText || 'Welcome to Shitspeak Server',
        permissions: 0, // TODO: 计算权限
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.ServerSync, Buffer.from(serverSyncMessage));

      // 发送 ServerSync 后，更新客户端状态为 Ready
      this.clientManager.updateClient(session_id, {
        state: ClientState.Ready,
      });

        this.logger.info(
        `User authenticated and ready: session=${session_id}, ` +
        `username=${updatedClient.username}, user_id=${updatedClient.user_id}, state=Ready`
      );

      // 11. 广播新用户加入给其他已认证客户端
      // broadcastUserStateToAuthenticatedClients 会根据接收方是否为注册用户决定是否发送证书哈希
      const broadcastStateData: {
        session: number;
        user_id: number;
        name: string;
        channel_id: number;
        temporary_access_tokens: string[];
        listening_channel_add: number[];
        listening_channel_remove: number[];
        hash?: string;
        mute?: boolean;
        deaf?: boolean;
        suppress?: boolean;
        self_mute?: boolean;
        self_deaf?: boolean;
        priority_speaker?: boolean;
        recording?: boolean;
      } = {
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
        this.logger.debug(`Broadcasted UserState for new user ${updatedClient.username} (session ${session_id})`);

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
        this.logger.debug(`Saved PreConnectUserState for session ${session_id}`);
  }

  /**
   * 清理 PreConnect 用户状态
   */
  clearPreConnectUserState(session_id: number): void {
    this.preConnectUserState.delete(session_id);
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
