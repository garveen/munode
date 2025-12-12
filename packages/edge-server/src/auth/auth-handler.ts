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
  private get hubClient() { return this.factory.hubClient; }
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

      // 3. 应用 PreConnectUserState（必须在上报到 Hub 之前！）
      // 从 StateHandlers 获取 PreConnect 状态并应用到客户端
      const preState = this.stateHandlers.getPreConnectUserState(session_id);
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

        // 清理已应用的 PreConnect 状态
        this.stateHandlers.clearPreConnectUserState(session_id);
      }

      // 4. 上报会话到 Hub（必须在发送用户列表之前！）
      // 这样其他用户在调用 fullSync 时就能看到这个新用户
      // 移到这里可以避免竞态条件：用户B登录时可能看不到刚登录的用户A
      // PreConnect 状态已在步骤 3 应用，所以这里会包含正确的 self_mute/self_deaf
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
          // 只上报已显式设置的状态字段
          const reportData: {
            session_id: number;
            user_id: number;
            username: string;
            channel_id: number;
            startTime: Date;
            ip_address: string;
            groups: string[];
            cert_hash?: string;
            version?: string;
            release?: string;
            os?: string;
            os_version?: string;
            mute?: boolean;
            deaf?: boolean;
            suppress?: boolean;
            self_mute?: boolean;
            self_deaf?: boolean;
            priority_speaker?: boolean;
            recording?: boolean;
          } = {
            session_id: session_id,
            user_id: clientBeforeSync.user_id,
            username: clientBeforeSync.username,
            channel_id: clientBeforeSync.channel_id,
            startTime: clientBeforeSync.connected_at || new Date(),
            ip_address: clientBeforeSync.ip_address,
            groups: clientBeforeSync.groups,
          };
          
          // 只添加已显式设置的字段
          if (clientBeforeSync.cert_hash) reportData.cert_hash = clientBeforeSync.cert_hash;
          if (clientBeforeSync.version) reportData.version = clientBeforeSync.version;
          if (clientBeforeSync.client_name) reportData.release = clientBeforeSync.client_name;
          if (clientBeforeSync.os_name) reportData.os = clientBeforeSync.os_name;
          if (clientBeforeSync.os_version) reportData.os_version = clientBeforeSync.os_version;
          
          // 只上报值为 true 的状态字段（参考 Murmur 实现）
          const reportedFields: string[] = [];
          if (clientBeforeSync.mute === true) {
            reportData.mute = true;
            reportedFields.push('mute');
          }
          if (clientBeforeSync.deaf === true) {
            reportData.deaf = true;
            reportedFields.push('deaf');
          }
          if (clientBeforeSync.suppress === true) {
            reportData.suppress = true;
            reportedFields.push('suppress');
          }
          if (clientBeforeSync.self_mute === true) {
            reportData.self_mute = true;
            reportedFields.push('self_mute');
          }
          if (clientBeforeSync.self_deaf === true) {
            reportData.self_deaf = true;
            reportedFields.push('self_deaf');
          }
          if (clientBeforeSync.priority_speaker === true) {
            reportData.priority_speaker = true;
            reportedFields.push('priority_speaker');
          }
          if (clientBeforeSync.recording === true) {
            reportData.recording = true;
            reportedFields.push('recording');
          }
          
          await this.hubClient.reportSession(reportData);
          this.logger.info(`Reported session ${session_id} (${clientBeforeSync.username}) to Hub${reportedFields.length > 0 ? ` with state: [${reportedFields.join(', ')}]` : ' (no state fields)'}`);
        } catch (error) {
        this.logger.error(`Failed to report session ${session_id} to Hub:`, error);
          // Continue even if Hub report fails - local operations should still work
        }
      }

      // 5. 发送频道树
      this.sendChannelTree(session_id);

      // 6. 发送所有其他用户的状态
      await this.sendUserListToClient(session_id);

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
      // 只发送已显式设置的状态字段
      const currentUserStateData: {
        session: number;
        name: string;
        user_id: number;
        channel_id: number;
        temporary_access_tokens: string[];
        listening_channel_add: number[];
        listening_channel_remove: number[];
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
      
      // 只添加值为 true 的状态字段（参考 Murmur 实现）
      if (updatedClient.deaf === true) {
        currentUserStateData.deaf = true;
      } else if (updatedClient.mute === true) {
        currentUserStateData.mute = true;
      }
      if (updatedClient.suppress === true) currentUserStateData.suppress = true;
      if (updatedClient.priority_speaker === true) currentUserStateData.priority_speaker = true;
      if (updatedClient.recording === true) currentUserStateData.recording = true;
      if (updatedClient.self_deaf === true) {
        currentUserStateData.self_deaf = true;
      } else if (updatedClient.self_mute === true) {
        currentUserStateData.self_mute = true;
      }
      
      const currentUserState = new mumbleproto.UserState(currentUserStateData).serialize();

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
      // 参考 Mumble/Murmur 实现：新用户加入时只广播基本信息，不包含状态字段
      // 状态字段只在用户显式改变时才广播
      const broadcastStateData: {
        session: number;
        user_id: number;
        name: string;
        channel_id: number;
        temporary_access_tokens: string[];
        listening_channel_add: number[];
        listening_channel_remove: number[];
        hash?: string;
      } = {
        session: session_id,
        name: updatedClient.username,
        user_id: updatedClient.user_id,
        channel_id: updatedClient.channel_id,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      };
      
      // 只添加证书哈希（如果有）
      if (updatedClient.cert_hash) broadcastStateData.hash = updatedClient.cert_hash;
      
      // 注意：不广播状态字段（mute, deaf, self_mute, self_deaf, priority_speaker, recording）
      // 这些字段只在用户显式改变时才通过 UserState 消息单独广播
      
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
