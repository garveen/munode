import { logger } from '@munode/common';
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';
import type { HandlerFactory } from '../handler-factory.js';

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

  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get config() { return this.factory.config; }
  private get hubClient() { return this.factory.hubClient; }

  /**
   * 处理用户状态变更消息
   * 
   * 架构说明：Edge仅负责转发到Hub，所有业务逻辑在Hub处理
   * Hub处理完成后会广播给所有Edge（包括发起请求的Edge）
   * 
   * 注意：不再支持独立模式，必须连接到Hub才能工作
   * 
   * PreConnectUserState: 允许客户端在认证前设置初始状态（自我静音/自我耳聋等）
   * 参照 Go 实现：message.go:583-618
   */
  handleUserState(session_id: number, data: Buffer): void {
    try {
      const userState = mumbleproto.UserState.deserialize(data);

      // 获取执行操作的客户端（actor）
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.UserState from unknown session: ${session_id}`);
        return;
      }

      // PreConnectUserState: 处理认证前的状态设置
      if (!actor.user_id || actor.user_id <= 0) {
        // 客户端未认证，保存 PreConnect 状态
        const preState: {
          self_mute?: boolean;
          self_deaf?: boolean;
          plugin_context?: Buffer;
          plugin_identity?: string;
          comment?: string;
        } = {};

        // 只保存允许在认证前设置的字段
        if (userState.has_self_mute) {
          preState.self_mute = userState.self_mute;
        }
        if (userState.has_self_deaf) {
          preState.self_deaf = userState.self_deaf;
        }
        if (userState.has_plugin_context) {
          preState.plugin_context = Buffer.from(userState.plugin_context);
        }
        if (userState.has_plugin_identity) {
          preState.plugin_identity = userState.plugin_identity;
        }
        if (userState.has_comment) {
          preState.comment = userState.comment;
        }

        // 保存 PreConnect 状态
        if (Object.keys(preState).length > 0) {
          this.preConnectUserState.set(session_id, preState);
          logger.debug(`Saved PreConnectUserState for session ${session_id}: ${Object.keys(preState).join(', ')}`);
        }
        
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('UserState rejected: Hub client not available (standalone mode not supported)');
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
      // 参考Edge废弃实现：只检查has_xxx来确定字段是否真正存在
      const userStateToSend: any = {
        session: userState.session,
        actor: userState.actor,
      };

      // 只包含实际设置的字段
      if (userState.has_channel_id) {
        userStateToSend.channel_id = userState.channel_id;
      }
      if (userState.has_self_mute) {
        userStateToSend.self_mute = userState.self_mute;
      }
      if (userState.has_self_deaf) {
        userStateToSend.self_deaf = userState.self_deaf;
      }
      if (userState.has_mute) {
        userStateToSend.mute = userState.mute;
      }
      if (userState.has_deaf) {
        userStateToSend.deaf = userState.deaf;
      }
      if (userState.has_suppress) {
        userStateToSend.suppress = userState.suppress;
      }
      if (userState.has_priority_speaker) {
        userStateToSend.priority_speaker = userState.priority_speaker;
      }
      if (userState.has_recording) {
        userStateToSend.recording = userState.recording;
      }
      if (userState.has_comment) {
        userStateToSend.comment = userState.comment;
      }
      if (userState.has_texture) {
        userStateToSend.texture = userState.texture;
      }
      if (userState.has_plugin_context) {
        userStateToSend.plugin_context = userState.plugin_context;
      }
      if (userState.has_plugin_identity) {
        userStateToSend.plugin_identity = userState.plugin_identity;
      }
      
      // 处理 blob 字段（texture 和 comment）
      // 如果客户端发送了texture或comment数据，需要上传到Hub blob存储
      if (userState.has_texture && userState.texture && userState.texture.length > 0) {
        // 异步上传texture到Hub，不阻塞当前处理
        this.uploadUserTexture(actor.user_id!, userState.texture).catch(error => {
          logger.error(`Failed to upload texture for user ${actor.user_id}:`, error);
        });
      }

      if (userState.has_comment && userState.comment && userState.comment.length > 128) {
        // 如果comment超过128字节，上传到blob存储
        // 参考 Go 实现：小于128字节的comment直接存储在消息中
        this.uploadUserComment(actor.user_id!, Buffer.from(userState.comment, 'utf-8')).catch(error => {
          logger.error(`Failed to upload comment for user ${actor.user_id}:`, error);
        });
      }
      
      // 处理监听频道
      if (userState.listening_channel_add && userState.listening_channel_add.length > 0) {
        userStateToSend.listening_channel_add = userState.listening_channel_add;
      }
      if (userState.listening_channel_remove && userState.listening_channel_remove.length > 0) {
        userStateToSend.listening_channel_remove = userState.listening_channel_remove;
      }

      // 转发到Hub（使用notification，因为不需要等待响应）
      this.hubClient.notify('hub.handleUserState', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        userState: userStateToSend,
      });

      logger.debug(`Forwarded UserState from session ${session_id} to Hub, fields: ${Object.keys(userStateToSend).filter(k => k !== 'session' && k !== 'actor').join(', ')}`);
    } catch (error) {
      logger.error(`Error handling mumbleproto.UserState for session ${session_id}:`, error);
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
      const userRemove = mumbleproto.UserRemove.deserialize(data);

      // 获取执行操作的客户端（actor）
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.UserRemove from unknown session: ${session_id}`);
        return;
      }

      // 获取要被移除的客户端
      if (!userRemove.session) {
        logger.warn(`mumbleproto.UserRemove without target session`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('UserRemove rejected: Hub client not available (standalone mode not supported)');
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

      logger.debug(`Forwarded UserRemove from session ${session_id} to Hub`);
    } catch (error) {
      logger.error(`Error handling mumbleproto.UserRemove for session ${session_id}:`, error);
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
      const channelState = mumbleproto.ChannelState.deserialize(data);
      logger.debug(
        `Decoded mumbleproto.ChannelState from session ${session_id}: ${JSON.stringify(channelState)}`
      );

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.ChannelState from unauthenticated session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('ChannelState rejected: Hub client not available (standalone mode not supported)');
        this.factory.messageHandlers.sendPermissionDenied(session_id, 'make_channel', 'Server must be connected to Hub');
        return;
      }

      // 转发到Hub处理
      this.hubClient.notify('hub.handleChannelState', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        channelState: channelState.toObject(),
        raw_data: data.toString('base64'),
      });

      logger.debug(`Forwarded ChannelState from session ${session_id} to Hub`);
    } catch (error) {
      logger.error(`Error handling mumbleproto.ChannelState for session ${session_id}:`, error);
    }
  }

  /**
   * 处理频道删除消息
   */
  async handleChannelRemove(session_id: number, data: Buffer): Promise<void> {
    try {
      const channelRemove = mumbleproto.ChannelRemove.deserialize(data);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.ChannelRemove from unauthenticated session: ${session_id}`);
        return;
      }

      if (channelRemove.channel_id === undefined) {
        logger.warn(`mumbleproto.ChannelRemove without channel_id from session: ${session_id}`);
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
        logger.debug(`Forwarded ChannelRemove from session ${session_id} to Hub`);
    } catch (error) {
        logger.error('Error forwarding ChannelRemove to Hub:', error);
        this.factory.messageHandlers.sendPermissionDenied(session_id, 'channel_remove', 'Internal error');
    }
    return;

    } catch (error) {
      logger.error(`Error handling mumbleproto.ChannelRemove for session ${session_id}:`, error);
    }
  }

  /**
   * 获取 PreConnect 用户状态
   */
  getPreConnectUserState(session_id: number) {
    return this.preConnectUserState.get(session_id);
  }

  /**
   * 清除 PreConnect 用户状态
   */
  clearPreConnectUserState(session_id: number): void {
    this.preConnectUserState.delete(session_id);
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

      logger.info(`Uploaded texture for user ${user_id}: ${result.hash}`);
    } catch (error) {
      logger.error(`Error uploading texture for user ${user_id}:`, error);
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

      logger.info(`Uploaded comment for user ${user_id}: ${result.hash}`);
    } catch (error) {
      logger.error(`Error uploading comment for user ${user_id}:`, error);
      throw error;
    }
  }
}
