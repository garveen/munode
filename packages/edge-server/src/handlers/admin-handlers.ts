/**
 * admin-handlers.ts
 * 
 * 处理服务器管理相关的消息：
 * - 封禁管理 (BanList)
 * - 上下文动作 (ContextAction)
 * - Blob 请求 (RequestBlob)
 * - 用户列表 (UserList)
 * - 频道成员移动
 * - 混杂模式 (PromiscuousMode)
 * - 用户缓存清理
 */

import { MessageType, mumbleproto, Permission } from '@munode/protocol';
import { logger } from '@munode/common';
import type { ChannelInfo, ClientInfo } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

/**
 * 管理员处理器
 */
export class AdminHandlers {
  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get channelManager() { return this.factory.channelManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get config() { return this.factory.config; }
  private get banManager() { return this.factory.banManager; }
  private get hubClient() { return this.factory.hubClient; }

  /**
   * 处理 BanList 查询
   */
  public async handleBanListQuery(session_id: number, _data: Buffer): Promise<void> {
    try {
      // 检查admin权限
      const client = this.clientManager.getClient(session_id);
      if (!client) {
        return;
      }

      if (!this.checkAdminPermission(client)) {
        this.sendPermissionDenied(session_id, 'ban', 'Requires admin permission');
        return;
      }

      // 返回封禁列表
      const banList = await this.banManager.getAllActiveBans();
      const response = new mumbleproto.BanList({
        bans: banList.map((entry) => new mumbleproto.BanList.BanEntry({
          address: entry.address ? Buffer.from(entry.address.split('.').map((x) => parseInt(x))) : undefined,
          mask: entry.mask || 32,
          name: entry.name || '',
          hash: entry.hash || '',
          reason: entry.reason || '',
          start: entry.startDate ? entry.startDate.toISOString() : undefined,
          duration: entry.duration || 0,
        })),
        query: false,
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.BanList, Buffer.from(response));
      logger.debug(`Sent BanList to session ${session_id}: ${banList.length} entries`);
    } catch (error) {
      logger.error(`Error handling BanList query for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 BanList 更新（添加或删除封禁）
   */
  public async handleBanListUpdate(session_id: number, data: Buffer): Promise<void> {
    try {
      // 检查admin权限
      const client = this.clientManager.getClient(session_id);
      if (!client) {
        return;
      }

      if (!this.checkAdminPermission(client)) {
        this.sendPermissionDenied(session_id, 'ban', 'Requires admin permission');
        return;
      }

      const banList = mumbleproto.BanList.deserialize(data);

      // 如果是查询请求（query=true），调用查询处理
      if (banList.query) {
        await this.handleBanListQuery(session_id, data);
        return;
      }

      // 更新封禁列表
      if (banList.bans) {
        // TODO: 实现批量更新封禁列表
        // 当前 BanManager 不支持 clearAll，需要逐个操作
        for (const ban of banList.bans) {
          const address = ban.address
            ? Array.from(ban.address)
                .map((x) => x.toString())
                .join('.')
            : undefined;
          
          await this.banManager.addBan({
            address,
            mask: ban.mask || 32,
            name: ban.name || undefined,
            hash: ban.hash || undefined,
            reason: ban.reason || 'Banned by admin',
            startDate: ban.start ? new Date(ban.start) : new Date(),
            duration: ban.duration || 0,
            createdBy: client.username || 'admin',
          });
        }

        logger.info(`Updated BanList by session ${session_id}: ${banList.bans.length} entries`);

        // 将更新后的封禁列表通过Hub同步到其他Edge
        const allBans = await this.banManager.getAllActiveBans();
        this.hubClient.notify('edge.banListUpdated', {
          edge_id: this.config.server_id,
          bans: allBans,
        });

      }
    } catch (error) {
      logger.error(`Error handling BanList update for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 ContextAction 消息
   */
  public async handleContextAction(session_id: number, data: Buffer): Promise<void> {
    try {
      const action = mumbleproto.ContextAction.deserialize(data);
      logger.debug(
        `Received ContextAction from session ${session_id}: ${action.action} for session ${action.session} channel ${action.channel_id}`
      );

      // 内置动作处理由 ContextActions 组件完成
      // 这里只需要将消息传递给它
      // （已经在 setupEventHandlers 中绑定）
    } catch (error) {
      logger.error(`Error handling ContextAction for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 ContextActionModify 消息
   */
  public handleContextActionModify(session_id: number, data: Buffer): void {
    try {
      const modify = mumbleproto.ContextActionModify.deserialize(data);
      logger.debug(
        `Received ContextActionModify from session ${session_id}: ${modify.action} operation ${modify.operation}`
      );

      // 自定义 Context Action 注册
      // TODO: 实现自定义 Context Action 的存储和管理
    } catch (error) {
      logger.error(`Error handling ContextActionModify for session ${session_id}:`, error);
    }
  }

  /**
   * 发送 ContextActionModify 消息给客户端
   */
  public sendContextActionModify(session_id: number, message: mumbleproto.ContextActionModify): void {
    try {
      const data = Buffer.from(message.serialize());
      this.messageHandler.sendMessage(session_id, MessageType.ContextActionModify, data);
    } catch (error) {
      logger.error(`Error sending ContextActionModify to session ${session_id}:`, error);
    }
  }

  /**
   * 处理批量移动频道成员
   */
  public handleMoveChannelMembers(
    actorSession: number,
    fromChannelId: number,
    toChannelId: number
  ): void {
    try {
      const actor = this.clientManager.getClient(actorSession);
      if (!actor) {
        logger.warn(`Move request from unknown session: ${actorSession}`);
        return;
      }

      const fromChannel = this.channelManager.getChannel(fromChannelId);
      const toChannel = this.channelManager.getChannel(toChannelId);

      if (!fromChannel || !toChannel) {
        logger.warn(`Invalid channel IDs: from=${fromChannelId}, to=${toChannelId}`);
        this.sendPermissionDenied(
          actorSession,
          'move',
          'Source or target channel does not exist'
        );
        return;
      }

      // 检查移动权限：需要源频道的 Move 权限
      if (!this.hasPermission(actor, fromChannel, Permission.Move)) {
        this.sendPermissionDenied(
          actorSession,
          'move',
          'You do not have Move permission on the source channel'
        );
        return;
      }

      // 获取源频道的所有用户
      const usersToMove = this.clientManager.getClientsInChannel(fromChannelId);

      if (usersToMove.length === 0) {
        logger.debug(`No users to move from channel ${fromChannelId}`);
        return;
      }

      // 移动每个用户
      let movedCount = 0;
      for (const client of usersToMove) {
        // 检查目标频道的 Enter 权限
        if (!this.hasPermission(client, toChannel, Permission.Enter)) {
          logger.debug(`User ${client.username} cannot enter target channel ${toChannelId}`);
          continue;
        }

        // 更新客户端的频道
        client.channel_id = toChannelId;

        // 广播 UserState 消息
        const userState = new mumbleproto.UserState({
          session: client.session,
          channel_id: toChannelId,
          temporary_access_tokens: [],
          listening_channel_add: [],
          listening_channel_remove: [],
        });

        this.messageHandler.broadcastMessage(MessageType.UserState, Buffer.from(userState.serialize()));

        movedCount++;
      }

      logger.info(
        `Moved ${movedCount} users from channel ${fromChannelId} to ${toChannelId} by session ${actorSession}`
      );
    } catch (error) {
      logger.error(
        `Error moving channel members from ${fromChannelId} to ${toChannelId}:`,
        error
      );
    }
  }

  /**
   * 处理混杂模式设置
   * 混杂模式允许用户接收所有频道的语音
   */
  public handleSetPromiscuousMode(session_id: number, enabled: boolean): void {
    try {
      const client = this.clientManager.getClient(session_id);
      if (!client) {
        logger.warn(`SetPromiscuousMode request from unknown session: ${session_id}`);
        return;
      }

      // 需要 root 频道的管理员权限
      const rootChannel = this.channelManager.getChannel(0);
      if (!rootChannel) {
        return;
      }

      if (!this.checkAdminPermission(client)) {
        this.sendPermissionDenied(session_id, 'promiscuous', 'Requires admin permission');
        return;
      }

      // 设置混杂模式标志
      // TODO: 在 ClientInfo 中添加 promiscuous 字段
      // client.promiscuous = enabled;

      logger.info(`Session ${session_id} set promiscuous mode to ${enabled}`);

      // 发送确认（通过 TextMessage）
      const confirmMessage = new mumbleproto.TextMessage({
        actor: 0, // 服务器消息
        message: `Promiscuous mode ${enabled ? 'enabled' : 'disabled'}`,
        session: [session_id],
        channel_id: [],
        tree_id: [],
      });

      this.messageHandler.sendMessage(
        session_id,
        MessageType.TextMessage,
        Buffer.from(confirmMessage.serialize())
      );
    } catch (error) {
      logger.error(`Error setting promiscuous mode for session ${session_id}:`, error);
    }
  }

  /**
   * 处理清除用户缓存（仅清理客户端纹理和评论缓存）
   * Edge 不再保留本地用户数据缓存
   */
  public handleClearUserCache(session_id: number): void {
    try {
      const client = this.clientManager.getClient(session_id);
      if (!client) {
        logger.warn(`ClearUserCache request from unknown session: ${session_id}`);
        return;
      }

      // 需要管理员权限
      if (!this.checkAdminPermission(client)) {
        this.sendPermissionDenied(session_id, 'cache', 'Requires admin permission');
        return;
      }

      // 清除所有客户端的纹理和评论缓存
      // TODO: 实现客户端缓存清理
      logger.info(`Session ${session_id} requested user cache clear`);

      // 广播 UserState 消息，清除所有用户的纹理和评论
      const allClients = Array.from(this.clientManager.getAllClients().values());
      for (const targetClient of allClients) {
        const clearState = new mumbleproto.UserState({
          session: targetClient.session,
          texture: Buffer.alloc(0), // 空纹理
          comment: '', // 空评论
          temporary_access_tokens: [],
          listening_channel_add: [],
          listening_channel_remove: [],
        });

        this.messageHandler.broadcastMessage(
          MessageType.UserState,
          Buffer.from(clearState.serialize())
        );
      }

      logger.info(`User cache cleared by session ${session_id}`);
    } catch (error) {
      logger.error(`Error clearing user cache for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 RequestBlob 消息
   */
  public async handleRequestBlob(session_id: number, data: Buffer): Promise<void> {
    try {
      const request = mumbleproto.RequestBlob.deserialize(data);

      // 检查 Hub 的 blob 存储是否启用
      if (!this.hubClient) {
        logger.warn('Hub client not available, cannot handle blob requests');
        return;
      }

      // 处理用户纹理请求
      if (request.session_texture && request.session_texture.length > 0) {
        for (const targetSession of request.session_texture) {
          try {
            const targetClient = this.clientManager.getClient(targetSession);
            if (!targetClient || !targetClient.user_id) {
              continue;
            }

            // 从 Hub 获取用户纹理
            const result = await this.hubClient.getUserTexture(targetClient.user_id);

            if (result.success && result.data && result.hash) {
              // 发送 UserState 消息，包含纹理数据
              const userState = new mumbleproto.UserState({
                session: targetSession,
                texture: result.data,
                temporary_access_tokens: [],
                listening_channel_add: [],
                listening_channel_remove: [],
              });
              this.messageHandler.sendMessage(
                session_id,
                MessageType.UserState,
                Buffer.from(userState.serialize())
              );
              logger.debug(`Sent texture for session ${targetSession} to session ${session_id}`);
            }
          } catch (error) {
            logger.error(`Error fetching texture for session ${targetSession}:`, error);
          }
        }
      }

      // 处理用户评论请求
      if (request.session_comment && request.session_comment.length > 0) {
        for (const targetSession of request.session_comment) {
          try {
            const targetClient = this.clientManager.getClient(targetSession);
            if (!targetClient || !targetClient.user_id) {
              continue;
            }

            // 从 Hub 获取用户评论
            const result = await this.hubClient.getUserComment(targetClient.user_id);

            if (result.success && result.data) {
              // 发送 UserState 消息，包含评论
              const userState = new mumbleproto.UserState({
                session: targetSession,
                comment: result.data.toString('utf-8'),
                temporary_access_tokens: [],
                listening_channel_add: [],
                listening_channel_remove: [],
              });
              this.messageHandler.sendMessage(
                session_id,
                MessageType.UserState,
                Buffer.from(userState.serialize())
              );
              logger.debug(`Sent comment for session ${targetSession} to session ${session_id}`);
            }
          } catch (error) {
            logger.error(`Error fetching comment for session ${targetSession}:`, error);
          }
        }
      }

      // 频道描述请求
      if (request.channel_description && request.channel_description.length > 0) {
        for (const channel_id of request.channel_description) {
          const channel = this.channelManager.getChannel(channel_id);
          if (channel && channel.description) {
            const response = new mumbleproto.ChannelState({
              channel_id: channel_id,
              description: channel.description,
              links: [],
              links_add: [],
              links_remove: [],
            }).serialize();

            this.messageHandler.sendMessage(session_id, MessageType.ChannelState, Buffer.from(response)); 
          }
        }
      }

      logger.debug(`Handled RequestBlob from session ${session_id}`);
    } catch (error) {
      logger.error(`Error handling RequestBlob for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 UserList 消息
   */
  public handleUserList(session_id: number, data: Buffer): void {
    try {
      const userList = mumbleproto.UserList.deserialize(data);

      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`UserList from unknown session: ${session_id}`);
        return;
      }

      // 需要根频道的Register权限
      const rootChannel = this.channelManager.getChannel(0);
      if (!rootChannel || !this.hasPermission(actor, rootChannel, Permission.Register)) {
        this.sendPermissionDenied(
          session_id,
          'register',
          'UserList requires Register permission on root channel'
        );
        return;
      }

      // 如果是查询请求（无users字段）
      if (!userList.users || userList.users.length === 0) {
        // 返回所有注册用户
        // TODO: 从Hub或用户缓存获取所有用户
        const response = new mumbleproto.UserList({
          users: [], // 暂时返回空列表
        }).serialize();

        this.messageHandler.sendMessage(session_id, MessageType.UserList, Buffer.from(response)); 
        logger.debug(`Sent UserList response to session ${session_id}`);
      } else {
        // 用户重命名或注销请求
        // TODO: 实现用户管理功能
        logger.warn(`UserList modification not implemented: ${userList.users.length} users`);
      }
    } catch (error) {
      logger.error(`Error handling UserList for session ${session_id}:`, error);
    }
  }

  /**
   * 检查管理员权限
   */
  private checkAdminPermission(client: ClientInfo): boolean {
    const rootChannel = this.channelManager.getChannel(0);
    if (!rootChannel) {
      return false;
    }

    // 检查是否有 root 频道的 Write 权限（通常表示管理员）
    return this.hasPermission(client, rootChannel, Permission.Write);
  }

  /**
   * 发送权限拒绝消息
   */
  public sendPermissionDenied(session_id: number, type: string, reason: string): void {
    try {
      // 根据类型映射到 Mumble 的 DenyType
      let denyType = mumbleproto.PermissionDenied.DenyType.Permission;
      let denyName = '';

      switch (type) {
        case 'permission':
          denyType = mumbleproto.PermissionDenied.DenyType.Permission;
          denyName = 'Permission';
          break;
        case 'write':
          denyType = mumbleproto.PermissionDenied.DenyType.ChannelName;
          denyName = 'Write';
          break;
        case 'traverse':
        case 'enter':
        case 'speak':
        case 'whisper':
        case 'link':
        case 'move':
        case 'makeChannel':
        case 'makeTemporaryChannel':
        case 'register':
        case 'registerSelf':
          denyType = mumbleproto.PermissionDenied.DenyType.Permission;
          denyName = type;
          break;
        case 'textMessage':
          denyType = mumbleproto.PermissionDenied.DenyType.TextTooLong;
          denyName = 'TextMessage';
          break;
        case 'ban':
        case 'kick':
        case 'promiscuous':
        case 'cache':
        case 'contextAction':
          denyType = mumbleproto.PermissionDenied.DenyType.Permission;
          denyName = 'Admin';
          break;
        default:
          denyType = mumbleproto.PermissionDenied.DenyType.Permission;
          denyName = type;
      }

      const deny = new mumbleproto.PermissionDenied({
        type: denyType,
        name: denyName,
        reason: reason,
        permission: 0,
        channel_id: 0,
        session: 0,
      });

      this.messageHandler.sendMessage(session_id, MessageType.PermissionDenied, Buffer.from(deny.serialize()));
      logger.debug(`Sent PermissionDenied to session ${session_id}: ${denyName} - ${reason}`);
    } catch (error) {
      logger.error(`Error sending PermissionDenied to session ${session_id}:`, error);
    }
  }

  /**
   * 检查权限（委托给 PermissionHandlers）
   */
  private hasPermission(client: ClientInfo, channel: ChannelInfo, permission: Permission): boolean {
    const permissionHandlers = this.factory.permissionHandlers;
    return permissionHandlers.checkPermission(client.session, channel.id, permission);
  }
}
