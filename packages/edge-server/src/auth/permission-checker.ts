import { logger } from '@munode/common';
import { mumbleproto } from '@munode/protocol';
import { MessageType, Permission } from '@munode/protocol';
import type { ClientInfo, ChannelInfo } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

/**
 * 权限处理器 - 处理ACL和权限查询
 */
export class PermissionHandlers {
  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get channelManager() { return this.factory.channelManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get permissionManager() { return this.factory.permissionManager; }
  private get config() { return this.factory.config; }
  private get hubClient() { return this.factory.hubClient; }
  private get aclMap() { return this.factory.aclMap; }

  /**
   * 处理 ACL 消息 (查询或更新)
   * 架构说明：Edge 仅负责转发到 Hub，所有业务逻辑在 Hub 处理
   */
  async handleACL(session_id: number, data: Buffer): Promise<void> {
    try {
      const acl = mumbleproto.ACL.deserialize(data);
      
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`ACL from unknown session: ${session_id}`);
        return;
      }

      if (!actor.user_id || actor.user_id <= 0) {
        logger.warn(`ACL from unauthenticated session: ${session_id}`);
        return;
      }

      if (acl.channel_id === undefined) {
        logger.warn(`ACL without channel_id from session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('ACL rejected: Hub client not available (standalone mode not supported)');
        this.factory.messageHandlers.sendPermissionDenied(session_id, 'write', 'Server must be connected to Hub');
        return;
      }

      const isQuery = acl.query === true || !acl.acls || acl.acls.length === 0;
      
      logger.info(`Forwarding ACL ${isQuery ? 'query' : 'update'} from session ${session_id} to Hub, channel: ${acl.channel_id}`);

      // 转发到 Hub（使用 RPC call）
      const result = await this.hubClient.call('edge.handleACL', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        channel_id: acl.channel_id,
        query: isQuery,
        raw_data: data.toString('base64'),
      });

      logger.debug(`ACL request completed, success: ${result?.success}`);

      // 处理响应
      if (!result?.success) {
        logger.warn(`ACL request failed: ${result?.error}`);
        
        // 如果是权限拒绝，发送 PermissionDenied 消息
        if (result?.permission_denied) {
          this.factory.messageHandlers.sendPermissionDenied(session_id, 'write', result.error || 'Permission denied', acl.channel_id);
        }
        return;
      }

      // 如果是查询且有数据，直接发送给客户端
      if (isQuery && result.raw_data) {
        const aclData = Buffer.from(result.raw_data, 'base64');
        this.messageHandler.sendMessage(session_id, MessageType.ACL, aclData);
        logger.info(`Forwarded ACL query response to session ${session_id} for channel ${acl.channel_id}`);
      }
    } catch (error) {
      logger.error(`Error handling ACL for session ${session_id}:`, error);
    }
  }

  /**
   * 处理权限查询消息
   */
  handlePermissionQuery(session_id: number, data: Buffer): void {
    try {
      const permQuery = mumbleproto.PermissionQuery.deserialize(data);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`PermissionQuery from unauthenticated session: ${session_id}`);
        return;
      }

      if (permQuery.channel_id === undefined) {
        logger.warn(`PermissionQuery without channel_id from session: ${session_id}`);
        return;
      }

      const channel = this.channelManager.getChannel(permQuery.channel_id);
      if (!channel) {
        logger.warn(`PermissionQuery for non-existent channel: ${permQuery.channel_id}`);
        return;
      }

      // 计算用户在该频道的权限
      const channelTree = this.channelManager.getChannelTree();
      const permissions = this.permissionManager.calculatePermission(
        channel,
        actor,
        channelTree,
        this.aclMap
      );

      // 发送权限响应
      const permissionQueryResponse = new mumbleproto.PermissionQuery({
        channel_id: permQuery.channel_id,
        permissions: permissions,
        flush: true,
      });

      this.messageHandler.sendMessage(
        session_id,
        MessageType.PermissionQuery,
        Buffer.from(permissionQueryResponse.serialize())
      );

      logger.debug(`Sent permission query response for channel ${permQuery.channel_id} to session ${session_id}: ${permissions}`);
    } catch (error) {
      logger.error(`Error handling PermissionQuery for session ${session_id}:`, error);
    }
  }

  /**
   * 频道权限动态刷新
   * 当 ACL 变更时，自动更新频道内所有用户的 suppress 状态
   * 参照 Go 实现：server.go:1774-1793
   */
  async refreshChannelPermissions(channel_id: number): Promise<void> {
    try {
      // 获取频道信息
      const channel = this.channelManager.getChannel(channel_id);
      if (!channel) {
        logger.warn(`Cannot refresh permissions for unknown channel: ${channel_id}`);
        return;
      }

      // 获取频道内的所有用户
      const clientsInChannel = this.clientManager.getClientsInChannel(channel_id);
      
      if (clientsInChannel.length === 0) {
        logger.debug(`No users in channel ${channel_id}, skipping permission refresh`);
        return;
      }

      logger.info(`Refreshing permissions for ${clientsInChannel.length} users in channel ${channel_id}`);

      // 对每个用户重新计算 suppress 状态
      for (const client of clientsInChannel) {
        if (!client.user_id || client.user_id <= 0) {
          continue; // 跳过未认证的客户端
        }

        // 检查用户是否有 Speak 权限
        const hasSpeak = await this.checkPermission(
          client.session,
          channel_id,
          Permission.Speak
        );

        // 计算新的 suppress 状态
        // suppress = 没有 Speak 权限，且不是自我静音
        const newSuppress = !hasSpeak && !client.self_mute;

        // 如果 suppress 状态改变，更新并广播
        if (client.suppress !== newSuppress) {
          logger.debug(
            `User ${client.username} in channel ${channel_id}: suppress changed from ${client.suppress} to ${newSuppress}`
          );

          // 更新本地状态
          this.clientManager.updateClient(client.session, {
            suppress: newSuppress,
          });

          // 广播状态变更给所有客户端
          const userState = new mumbleproto.UserState({
            session: client.session,
            suppress: newSuppress,
            temporary_access_tokens: [],
            listening_channel_add: [],
            listening_channel_remove: [],
          });

          // 广播给所有已认证的客户端
          const allClients = this.clientManager.getAllClients();
          for (const otherClient of allClients) {
            if (otherClient.user_id > 0) {
              this.messageHandler.sendMessage(
                otherClient.session,
                MessageType.UserState,
                Buffer.from(userState.serialize())
              );
            }
          }

          // 在集群模式下，同步到 Hub
          this.hubClient.notify('hub.handleUserState', {
            edge_id: this.config.server_id,
            actor_session: 0, // 系统操作
            actor_user_id: 0,
            actor_username: 'System',
            userState: {
              session: client.session,
              suppress: newSuppress,
            },
          });
        }
      }

      logger.info(`Permission refresh completed for channel ${channel_id}`);
    } catch (error) {
      logger.error(`Failed to refresh permissions for channel ${channel_id}:`, error);
    }
  }

  /**
   * 检查用户是否有某个权限
   */
  checkPermission(
    session_id: number,
    channel_id: number,
    permission: Permission
  ): boolean {
    try {
      const client = this.clientManager.getClient(session_id);
      if (!client || !client.user_id) {
        return false;
      }

      // 如果有 PermissionManager，使用它来检查权限
      if (this.permissionManager) {
        const channel = this.channelManager.getChannel(channel_id);
        if (channel) {
          // 构建客户端信息对象
          const channelTree = new Map<number, ChannelInfo>();
          // 获取所有频道构建频道树
          const allChannels = this.channelManager.getAllChannels();
          for (const ch of allChannels) {
            channelTree.set(ch.id, ch);
          }
          
          return this.permissionManager.hasPermission(
            channel,
            client as ClientInfo,
            permission,
            channelTree,
            this.aclMap
          );
        }
      }

      // Fallback: 如果本地无法检查，返回 false
      // TODO: 可以考虑添加 Hub RPC 接口来检查权限
      logger.debug(`Cannot check permission locally for user ${client.user_id} on channel ${channel_id}`);
      return false;
    } catch (error) {
      logger.error(`Error checking permission:`, error);
      return false;
    }
  }
}
