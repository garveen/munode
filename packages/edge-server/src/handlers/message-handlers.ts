import { logger } from '@munode/common';
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';
import { MessageType } from '@munode/protocol';
import type { ChannelInfo } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

/**
 * 消息处理器 - 处理文本消息和频道/用户列表发送
 */
export class MessageHandlers {
  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get config() { return this.factory.config; }
  private get hubClient() { return this.factory.hubClient; }
  private get stateManager() { return this.factory.stateManager; }

  /**
   * 处理文本消息
   * 
   * 架构说明：Edge转发到Hub进行权限检查和目标解析，Hub广播给所有Edge
   */
  handleTextMessage(session_id: number, data: Buffer): void {
    try {
      const textMessage = mumbleproto.TextMessage.deserialize(data);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`TextMessage from unauthenticated session: ${session_id}`);
        return;
      }

      // 检查客户端是否已认证
      if (!actor.user_id || actor.user_id <= 0) {
        logger.warn(`TextMessage from unauthenticated session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('TextMessage rejected: Hub client not available (standalone mode not supported)');
        this.sendPermissionDenied(session_id, 'text_message', 'Server must be connected to Hub');
        return;
      }

      // 设置发送者
      textMessage.actor = session_id;

      // 转发到Hub处理（Hub会进行权限检查、目标解析和广播）
      this.hubClient.notify('hub.handleTextMessage', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        actor_channel_id: actor.channel_id,
        textMessage: {
          actor: session_id,
          session: textMessage.session || [],
          channel_id: textMessage.channel_id || [],
          tree_id: textMessage.tree_id || [],
          message: textMessage.message || '',
        },
      });

      logger.debug(`Forwarded TextMessage from session ${session_id} to Hub`);
    } catch (error) {
      logger.error(`Error handling TextMessage for session ${session_id}:`, error);
    }
  }

  /**
   * 获取频道的正确 parent 值（用于发送给客户端）
   * 根据 Mumble 协议规范：
   * - 根频道 (ID=0) 不应该包含 parent 字段（返回 undefined）
   * - 其他频道必须有有效的 parent_id，且不能指向自己
   * - 如果 parent_id 无效，默认使用根频道 (0)
   */
  private getChannelParentForProtocol(channel: ChannelInfo): number | undefined {
    if (channel.id === 0) {
      // 根频道不设置 parent 字段
      return undefined;
    }
    
    if (channel.parent_id === undefined || channel.parent_id === null || channel.parent_id === channel.id) {
      // 如果 parent_id 无效或指向自己，使用根频道作为父频道
      logger.warn(
        `Channel ${channel.id} (${channel.name}) has invalid parent_id=${channel.parent_id}, using root channel (0) as parent`
      );
      return 0;
    }
    
    return channel.parent_id;
  }

  /**
   * 发送频道树给客户端
   * 
   * 重要：模仿Go服务器的两次发送策略，避免客户端报错
   * "Server asked to move a channel into itself or one of its children"
   * 
   * 原因：Mumble客户端在收到包含parent字段的ChannelState时会立即执行移动操作，
   * 如果一次性发送所有频道信息（包含parent），可能导致循环引用检查失败。
   * 
   * 解决方案：
   * 1. 第一次：发送所有频道的基本信息（name、description等），但parent设为0（根频道除外）
   * 2. 第二次：仅发送频道的parent关系，此时所有频道都已在客户端创建完毕
   */
  sendChannelTree(session_id: number): void {
    let channels: ChannelInfo[];

    // 在集群模式下，从stateManager获取频道（Hub同步的数据）
    if (this.stateManager) {
      const stateChannels = this.stateManager.getAllChannels();
      // 转换ChannelData为ChannelInfo
      channels = stateChannels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        parent_id: ch.id === 0 ? -1 : ch.parent_id,
        description: ch.description || '',
        position: ch.position || 0,
        max_users: ch.maxUsers || 0,
        temporary: ch.temporary || false,
        inherit_acl: ch.inheritAcl !== false, // 默认 true
        children: [],
        links: [],
      }));
      logger.info(
        `[sendChannelTree] Cluster mode: sending ${channels.length} channels from stateManager to session ${session_id}`
      );
    } else {
      channels = [];
    }

    if (!channels || channels.length === 0) {
      logger.warn(`[sendChannelTree] No channels to send`);
      return;
    }

    logger.debug(`[sendChannelTree] Starting two-pass channel tree sync for session ${session_id}`);

    // === 第一次循环：发送所有频道的基本信息，parent字段设为0（根频道除外不设parent） ===
    for (const channel of channels) {
      const links = this.stateManager.getChannelLinks(channel.id);

      const channelState = new mumbleproto.ChannelState({
        channel_id: channel.id,
        name: channel.name,
        description: channel.description || '',
        position: channel.position,
        temporary: channel.temporary,
        max_users: channel.max_users || 0,
        links: links || [],
        links_add: [],
        links_remove: [],
        // 第一次：根频道(id=0)不设parent，其他频道parent都设为0
        parent: channel.id === 0 ? undefined : 0,
      });

      logger.debug(
        `[sendChannelTree] Pass 1: channel ${channel.id} (${channel.name}), parent=${channel.id === 0 ? 'undefined' : 0}`
      );

      const channelStateMessage = new mumbleproto.ChannelState(channelState).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.ChannelState, Buffer.from(channelStateMessage));
    }

    // === 第二次循环：仅发送parent关系 ===
    for (const channel of channels) {
      // 根频道跳过（根频道没有parent）
      if (channel.id === 0) {
        continue;
      }

      const parentId = this.getChannelParentForProtocol(channel);

      const channelState = new mumbleproto.ChannelState({
        channel_id: channel.id,
        parent: parentId,
        position: channel.position,
        temporary: channel.temporary,
        links: [],
        links_add: [],
        links_remove: [],
      });

      logger.debug(
        `[sendChannelTree] Pass 2: channel ${channel.id} parent relationship, parent=${parentId}`
      );

      const channelStateMessage = new mumbleproto.ChannelState(channelState).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.ChannelState, Buffer.from(channelStateMessage));
    }

    logger.info(
      `[sendChannelTree] Completed two-pass channel tree sync. Sent ${channels.length} channels to session ${session_id}`
    );
  }

  /**
   * 发送用户列表给新认证的客户端（不包括自己）
   * 类似 Go 实现的 sendUserList
   */
  async sendUserListToClient(session_id: number): Promise<void> {
    // 从Hub获取全部用户会话信息（包括其他Edge的用户）
    if (this.hubClient && this.hubClient.isConnected()) {
      try {
        // 通过fullSync获取所有会话
        const syncData = await this.hubClient.call('edge.fullSync', {});
        const allSessions = syncData.sessions || [];
        
        let sentCount = 0;
        for (const session of allSessions) {
          // 发送所有其他已认证用户的状态（不包括自己）
          if (session.user_id > 0 && session.session_id !== session_id) {
            const userStateData: any = {
              session: session.session_id,
              user_id: session.user_id,
              name: session.username,
              channel_id: session.channel_id,
              temporary_access_tokens: [],
              listening_channel_add: [],
              listening_channel_remove: [],
            };
            
            // 添加可选字段（只添加非 undefined 的字段）
            if (session.cert_hash !== undefined) {
              userStateData.hash = session.cert_hash;
            }
            if (session.mute !== undefined) {
              userStateData.mute = session.mute;
            }
            if (session.deaf !== undefined) {
              userStateData.deaf = session.deaf;
            }
            if (session.suppress !== undefined) {
              userStateData.suppress = session.suppress;
            }
            if (session.self_mute !== undefined) {
              userStateData.self_mute = session.self_mute;
            }
            if (session.self_deaf !== undefined) {
              userStateData.self_deaf = session.self_deaf;
            }
            if (session.priority_speaker !== undefined) {
              userStateData.priority_speaker = session.priority_speaker;
            }
            if (session.recording !== undefined) {
              userStateData.recording = session.recording;
            }
            
            const userState = new mumbleproto.UserState(userStateData);
            this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(userState.serialize())); 
            sentCount++;
          }
        }
        
        logger.debug(`Sent user list to session ${session_id} from Hub (${sentCount} users)`);
      } catch (error) {
        logger.error(`Failed to get user list from Hub for session ${session_id}:`, error);
        // Fallback: 只发送本地用户
        this.sendLocalUserListToClient(session_id);
      }
    } else {
      // 如果没有连接到Hub，只发送本地用户
      logger.warn(`Hub not connected, sending local users only to session ${session_id}`);
      this.sendLocalUserListToClient(session_id);
    }
  }

  /**
   * Fallback: 只发送本地Edge的用户列表
   */
  private sendLocalUserListToClient(session_id: number): void {
    const clients = this.clientManager.getAllClients();

    for (const client of clients) {
      // 发送所有其他已认证的客户端状态（不包括自己）
      if (client.user_id > 0 && client.session !== session_id) {
        const userState = new mumbleproto.UserState({
          session: client.session,
          user_id: client.user_id,
          name: client.username,
          channel_id: client.channel_id,
          temporary_access_tokens: [],
          listening_channel_add: [],
          listening_channel_remove: [],
        });
        for (const field of ['cert_hash', 'mute', 'deaf', 'suppress', 'self_mute', 'self_deaf', 'priority_speaker', 'recording'] as const) {
          const value = client[field];
          if (value) {
            (userState as any)[field] = value;
          }
        }

        this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(userState.serialize())); 
      }
    }
    
    logger.debug(`Sent local user list to session ${session_id} (${clients.filter(c => c.user_id > 0 && c.session !== session_id).length} users)`);
  }

  /**
   * 发送权限拒绝消息
   */
  sendPermissionDenied(
    session_id: number,
    permission: string,
    reason: string,
    channel_id?: number,
    type?: number
  ): void {
    try {
      // 构建 mumbleproto.PermissionDenied 消息
      const permissionDenied: any = {
        reason: reason,
        session: session_id,
        type: type,
        permission: undefined,
        channel_id: channel_id,
      };

      // 设置 DenyType
      if (type !== undefined) {
        permissionDenied.type = type;
      } else if (permission === 'Text' || permission === 'text') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.Text;
      } else if (permission === 'SuperUser' || permission === 'superuser') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.SuperUser;
      } else if (permission === 'ChannelName' || permission === 'channel_name') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.ChannelName;
      } else if (permission === 'TextTooLong' || permission === 'text_too_long') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.TextTooLong;
      } else if (permission === 'TemporaryChannel' || permission === 'temporary_channel') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.TemporaryChannel;
      } else if (permission === 'MissingCertificate' || permission === 'missing_certificate') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.MissingCertificate;
      } else if (permission === 'UserName' || permission === 'username') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.UserName;
      } else if (permission === 'ChannelFull' || permission === 'channel_full') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.ChannelFull;
      } else {
        // 默认为 Permission 类型
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.Permission;

        // 尝试将权限字符串转换为权限位
        const permissionMap: { [key: string]: any } = {
          write: 0x00001,
          traverse: 0x00002,
          enter: 0x00004,
          speak: 0x00008,
          mutedeafen: 0x00010,
          move: 0x00020,
          make_channel: 0x00040,
          link_channel: 0x00080,
          whisper: 0x00100,
          text_message: 0x00200,
          temp_channel: 0x00400,
          kick: 0x10000,
          ban: 0x20000,
          register: 0x40000,
          self_register: 0x80000,
        };

        const permissionBit = permissionMap[permission.toLowerCase()];
        if (permissionBit !== undefined) {
          permissionDenied.permission = permissionBit;
        }
      }

      // 编码并发送消息
      const message = new mumbleproto.PermissionDenied(permissionDenied).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.PermissionDenied, Buffer.from(message));

      logger.warn(
        `Permission denied for session ${session_id}: type=${permissionDenied.type}, permission=${permission}, reason=${reason}, channel=${channel_id || 'N/A'}`
      );
    } catch (error) {
      logger.error(`Error sending mumbleproto.PermissionDenied to session ${session_id}:`, error);
    }
  }

  /**
   * 发送拒绝消息
   */
  sendReject(
    session_id: number,
    reason: string,
    rejectType: mumbleproto.Reject.RejectType = mumbleproto.Reject.RejectType.None
  ): void {
    logger.debug(`Sending reject to session ${session_id}: type=${rejectType}, reason=${reason}`);

    const rejectMessage = new mumbleproto.Reject({
      type: rejectType,
      reason: reason,
    }).serialize();

    this.messageHandler.sendMessage(session_id, MessageType.Reject, Buffer.from(rejectMessage));
  }

  /**
   * 广播用户状态给所有已认证的客户端
   * 类似 Go 实现的 broadcastProtoMessageWithPredicate
   */
  broadcastUserStateToAuthenticatedClients(
    userState: mumbleproto.UserState,
    excludeSession?: number
  ): void {
    const clients = this.clientManager.getAllClients();
    const serializedState = Buffer.from(userState.serialize());

    for (const client of clients) {
      // 只广播给已收到完整用户列表的客户端，排除指定的会话
      if (client.has_full_user_list && client.session !== excludeSession) {
        this.messageHandler.sendMessage(client.session, MessageType.UserState, serializedState);
      }
    }

    logger.debug(
      `Broadcasted UserState to ${clients.filter(c => c.has_full_user_list && c.session !== excludeSession).length} authenticated clients`
    );
  }
}
