import type { Logger } from 'winston';
import { mumbleproto, ClientState } from '@munode/protocol';
import type { HandlerFactory } from '../core/handler-factory.js';

/**
 * 状态处理器 - 处理用户和频道状态变更
 */
export class StateHandlers {
  // PreConnect 用户状态 - 存储认证前客户端发送的 UserState
  private preConnectUserState: Map<number, {
    self_mute?: boolean;
    self_deaf?: boolean;
    plugin_context?: Buffer;
    plugin_identity?: string;
    comment?: string;
  }> = new Map();
  
  // Pending UserState - 存储认证期间收到的 UserState
  // 注意：每个session只存储最新的一条UserState，后续消息会覆盖之前的
  // 这确保状态始终是最新的，匹配Murmur行为
  private pendingUserState: Map<number, Buffer> = new Map();
  
  private logger: Logger;

  constructor(private factory: HandlerFactory) {
    this.logger = factory.logger;
  }

  private get clientManager() { return this.factory.clientManager; }
  private get config() { return this.factory.config; }
  private get hubClient() { return this.factory.hubClient; }

  /**
   * 清除PreConnect状态（认证完成后调用）
   */
  clearPreConnectUserState(session_id: number): void {
    this.preConnectUserState.delete(session_id);
  }
  
  /**
   * 获取待处理的UserState（解码但不移除）
   * 用于在认证时发送给Hub
   */
  getPendingUserStateDecoded(session_id: number): {
    self_mute?: boolean;
    self_deaf?: boolean;
    mute?: boolean;
    deaf?: boolean;
    suppress?: boolean;
    priority_speaker?: boolean;
    recording?: boolean;
  } | undefined {
    const pendingData = this.pendingUserState.get(session_id);
    if (!pendingData) {
      return undefined;
    }
    
    try {
      const userState = mumbleproto.UserState.decode(pendingData);
      // 只返回状态相关的字段
      const result = {
        self_mute: userState.self_mute,
        self_deaf: userState.self_deaf,
        mute: userState.mute,
        deaf: userState.deaf,
        suppress: userState.suppress,
        priority_speaker: userState.priority_speaker,
        recording: userState.recording,
      };
      return result;
    } catch (error) {
      this.logger.error(`Failed to decode pending UserState for session ${session_id}:`, error);
      return undefined;
    }
  }
  
  /**
   * 处理待处理的UserState（在认证完成且Ready后调用）
   * 注意：只处理一次，避免无限递归
   */
  processPendingUserState(session_id: number): void {
    const pendingData = this.pendingUserState.get(session_id);
    if (pendingData) {
      this.logger.debug(`Processing pending UserState for session ${session_id}`);
      this.pendingUserState.delete(session_id); // 先删除，避免递归
      // 调用handleUserState处理这个消息（此时client state应该是Ready）
      this.handleUserState(session_id, pendingData);
    }
  }

  /**
   * 处理用户状态变更消息
   * 
   * 架构说明：Edge仅负责转发到Hub，所有业务逻辑在Hub处理
   * Hub处理完成后会广播给所有Edge（包括发起请求的Edge）
   * 
   * 注意：不再支持独立模式，必须连接到Hub才能工作
   * 
   * PreConnectUserState: 允许客户端在认证前设置初始状态（自我静音/自我禁听等）
   * 参照 Go 实现：message.go:583-618
   */
  handleUserState(session_id: number, data: Buffer): void {
    try {
      const userState = mumbleproto.UserState.decode(data);

      // 获取执行操作的客户端（actor）
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        this.logger.warn(`mumbleproto.UserState from unknown session: ${session_id}`);
        return;
      }

      // 如果客户端状态是 Authenticated（认证中），延迟处理
      // 这匹配 Murmur 行为：只接受已完全认证的用户的 UserState
      if (actor.state === ClientState.Authenticated) {
        this.logger.debug(`Storing UserState for session ${session_id} (auth in progress, state=${actor.state})`);
        this.pendingUserState.set(session_id, data);
        return;
      }

      // PreConnectUserState: 处理认证前的状态设置
      if (!actor.user_id || actor.user_id <= 0) {
        // 客户端未认证，将UserState消息保存到pending queue
        // 认证完成后会重新处理这些消息（参考C++ Murmur行为）
        this.logger.debug(`UserState received before authentication for session ${session_id}, saving to pending queue`);
        this.pendingUserState.set(session_id, data);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        this.logger.error('UserState rejected: Hub client not available (standalone mode not supported)');
        this.factory.messageHandlers.sendPermissionDenied(session_id, 'connection', 'Server must be connected to Hub');
        return;
      }

      // 设置actor信息
      userState.actor = session_id;
      
      // 如果没有指定target session，默认为自己
      if (!userState.session || userState.session === 0) {
        userState.session = session_id;
      }

      // 只转发实际设置的字段，避免发送默认值
      // ts-proto with useOptionals=all: 未在消息中出现的字段将是 undefined
      const userStateToSend: {
        session: number;
        actor: number;
        channel_id?: number;
        self_mute?: boolean;
        self_deaf?: boolean;
        mute?: boolean;
        deaf?: boolean;
        suppress?: boolean;
        priority_speaker?: boolean;
        recording?: boolean;
        name?: string;
        user_id?: number;
        comment?: string;
        hash?: string;
        texture?: Uint8Array;
        plugin_context?: Uint8Array;
        plugin_identity?: string;
        comment_hash?: Uint8Array;
        texture_hash?: Uint8Array;
        listening_channel_add?: number[];
        listening_channel_remove?: number[];
        listening_volume_adjustment?: Array<{
          listening_channel?: number;
          volume_adjustment?: number;
        }>;
      } = {
        session: userState.session,
        actor: userState.actor,
      };

      // 只包含已设置（非 undefined）的字段
      if (userState.channel_id !== undefined) {
        userStateToSend.channel_id = userState.channel_id;
      }
      if (userState.self_mute !== undefined) {
        userStateToSend.self_mute = userState.self_mute;
      }
      if (userState.self_deaf !== undefined) {
        userStateToSend.self_deaf = userState.self_deaf;
      }
      if (userState.mute !== undefined) {
        userStateToSend.mute = userState.mute;
      }
      if (userState.deaf !== undefined) {
        userStateToSend.deaf = userState.deaf;
      }
      if (userState.suppress !== undefined) {
        userStateToSend.suppress = userState.suppress;
      }
      if (userState.priority_speaker !== undefined) {
        userStateToSend.priority_speaker = userState.priority_speaker;
      }
      if (userState.recording !== undefined) {
        userStateToSend.recording = userState.recording;
      }
      if (userState.comment !== undefined) {
        userStateToSend.comment = userState.comment;
      }
      if (userState.texture !== undefined) {
        userStateToSend.texture = userState.texture;
      }
      if (userState.plugin_context !== undefined) {
        userStateToSend.plugin_context = userState.plugin_context;
      }
      if (userState.plugin_identity !== undefined) {
        userStateToSend.plugin_identity = userState.plugin_identity;
      }
      
      // 处理监听频道 - 只在字段存在时才添加
      if (userState.listening_channel_add && userState.listening_channel_add.length > 0) {
        userStateToSend.listening_channel_add = userState.listening_channel_add;
      }
      if (userState.listening_channel_remove && userState.listening_channel_remove.length > 0) {
        userStateToSend.listening_channel_remove = userState.listening_channel_remove;
      }
      
      // 处理音量调节 - 只在客户端提供时才处理
      if (userState.listening_volume_adjustment && userState.listening_volume_adjustment.length > 0) {
        // 存储音量调节到本地管理器
        for (const adjustment of userState.listening_volume_adjustment) {
          if (adjustment.listening_channel !== undefined && adjustment.volume_adjustment !== undefined) {
            try {
              this.clientManager.setListenerVolumeAdjustment(
                session_id,
                adjustment.listening_channel,
                adjustment.volume_adjustment
              );
            } catch (error) {
              this.logger.warn(`Invalid volume adjustment: ${error instanceof Error ? error.message : error}`);
            }
          }
        }
        
        // 转发到其他客户端
        userStateToSend.listening_volume_adjustment = userState.listening_volume_adjustment;
      }
      
      // 处理 blob 字段（texture 和 comment）
      // 如果客户端发送了texture或comment数据，需要上传到Hub blob存储
      if (userState.texture !== undefined && userState.texture && userState.texture.length > 0) {
        // 异步上传texture到Hub，不阻塞当前处理
        this.uploadUserTexture(actor.user_id, userState.texture).catch(error => {
        this.logger.error(`Failed to upload texture for user ${actor.user_id}:`, error);
        });
      }

      if (userState.comment !== undefined && userState.comment && userState.comment.length > 128) {
        // 如果comment超过128字节，上传到blob存储
        // 参考 Go 实现：小于128字节的comment直接存储在消息中
        this.uploadUserComment(actor.user_id, Buffer.from(userState.comment, 'utf-8')).catch(error => {
        this.logger.error(`Failed to upload comment for user ${actor.user_id}:`, error);
        });
      }

      // 转发到Hub（使用notification，因为不需要等待响应）
      this.hubClient.notify('hub.handleUserState', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        userState: userStateToSend,
      });

        this.logger.debug(`Forwarded UserState from session ${session_id} to Hub, fields: ${Object.entries(userStateToSend).filter(([k, v]) => k !== 'session' && k !== 'actor' && v !== undefined).map(([k]) => k).join(', ')}`);
    } catch (error) {
        this.logger.error(`Error handling mumbleproto.UserState for session ${session_id}:`, error);
    }
  }

  /**
   * 处理用户踢出/封禁消息
   * 
   * 架构说明：Edge仅负责转发到Hub，所有业务逻辑在Hub处理
   * 
   * 注意：不再支持独立模式，必须连接到Hub才能工作
   */
  async handleUserRemove(session_id: number, data: Buffer): Promise<void> {
    try {
      const userRemove = mumbleproto.UserRemove.decode(data);

      // 获取执行操作的客户端（actor）
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        this.logger.warn(`mumbleproto.UserRemove from unknown session: ${session_id}`);
        return;
      }

      // 获取要被移除的客户端
      if (!userRemove.session) {
        this.logger.warn(`mumbleproto.UserRemove without target session`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        this.logger.error('UserRemove rejected: Hub client not available (standalone mode not supported)');
        this.factory.messageHandlers.sendPermissionDenied(session_id, 'kick', 'Server must be connected to Hub');
        return;
      }

      // 转发到Hub处理
      this.hubClient.notify('hub.handleUserRemove', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        target_session: userRemove.session,
        reason: userRemove.reason || '',
        ban: userRemove.ban || false,
      });

        this.logger.debug(`Forwarded UserRemove from session ${session_id} to Hub`);
    } catch (error) {
        this.logger.error(`Error handling mumbleproto.UserRemove for session ${session_id}:`, error);
    }
  }

  /**
   * 处理频道状态变更消息（创建/编辑）
   * 
   * 架构说明：Edge仅负责转发到Hub，所有业务逻辑在Hub处理
   * 
   * 注意：不再支持独立模式，必须连接到Hub才能工作
   */
  async handleChannelState(session_id: number, data: Buffer): Promise<void> {
    try {
      const channelState = mumbleproto.ChannelState.decode(data);
        this.logger.debug(
        `Decoded mumbleproto.ChannelState from session ${session_id}: ${JSON.stringify(channelState)}`
      );

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        this.logger.warn(`mumbleproto.ChannelState from unauthenticated session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        this.logger.error('ChannelState rejected: Hub client not available (standalone mode not supported)');
        this.factory.messageHandlers.sendPermissionDenied(session_id, 'make_channel', 'Server must be connected to Hub');
        return;
      }

      // 转发到Hub处理
      this.hubClient.notify('hub.handleChannelState', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        channelState: channelState,
        raw_data: data.toString('base64'),
      });

        this.logger.debug(`Forwarded ChannelState from session ${session_id} to Hub`);
    } catch (error) {
        this.logger.error(`Error handling mumbleproto.ChannelState for session ${session_id}:`, error);
    }
  }

  /**
   * 处理频道删除消息
   */
  async handleChannelRemove(session_id: number, data: Buffer): Promise<void> {
    try {
      const channelRemove = mumbleproto.ChannelRemove.decode(data);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        this.logger.warn(`mumbleproto.ChannelRemove from unauthenticated session: ${session_id}`);
        return;
      }

      if (channelRemove.channel_id === undefined) {
        this.logger.warn(`mumbleproto.ChannelRemove without channel_id from session: ${session_id}`);
        return;
      }

      // 集群模式：转发到Hub处理
    try {
        await this.hubClient.notify('hub.handleChannelRemove', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_username: actor.username,
        channel_id: channelRemove.channel_id,
        });
        this.logger.debug(`Forwarded ChannelRemove from session ${session_id} to Hub`);
    } catch (error) {
        this.logger.error('Error forwarding ChannelRemove to Hub:', error);
        this.factory.messageHandlers.sendPermissionDenied(session_id, 'channel_remove', 'Internal error');
    }
    return;

    } catch (error) {
        this.logger.error(`Error handling mumbleproto.ChannelRemove for session ${session_id}:`, error);
    }
  }

  /**
   * 获取 PreConnect 用户状态
   */
  getPreConnectUserState(session_id: number) {
    return this.preConnectUserState.get(session_id);
  }

  /**
   * 上传用户纹理到 Hub blob 存储
   */
  private async uploadUserTexture(user_id: number, data: Uint8Array): Promise<void> {
    if (!this.hubClient) {
      throw new Error('Hub client not available');
    }

    try {
      const result = await this.hubClient.setUserTexture(user_id, Buffer.from(data));

      if (!result.success) {
        throw new Error(result.error || 'Failed to upload texture');
      }

        this.logger.info(`Uploaded texture for user ${user_id}: ${result.hash}`);
    } catch (error) {
        this.logger.error(`Error uploading texture for user ${user_id}:`, error);
      throw error;
    }
  }

  /**
   * 上传用户评论到 Hub blob 存储
   */
  private async uploadUserComment(user_id: number, data: Buffer): Promise<void> {
    if (!this.hubClient) {
      throw new Error('Hub client not available');
    }

    try {
      const result = await this.hubClient.setUserComment(user_id, data);

      if (!result.success) {
        throw new Error(result.error || 'Failed to upload comment');
      }

        this.logger.info(`Uploaded comment for user ${user_id}: ${result.hash}`);
    } catch (error) {
        this.logger.error(`Error uploading comment for user ${user_id}:`, error);
      throw error;
    }
  }
}
