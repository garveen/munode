import { createLogger } from '@munode/common';
import { HubPermissionChecker, Permission } from '../permission-checker.js';
import { HubHandlerFactory } from '../factory.js';
import type { EdgeNotificationParams } from '@munode/protocol';

const logger = createLogger({ service: 'hub-channel-state-handler' });

/**
 * 频道状态处理器接口
 */
export interface IChannelStateHandler {
  /**
   * 处理频道状态通知
   */
  handleChannelStateNotification(params: EdgeNotificationParams<'edge.channelStateNotification'>): Promise<void>;

  /**
   * 处理频道删除通知
   */
  handleChannelRemoveNotification(params: EdgeNotificationParams<'edge.channelRemoveNotification'>): Promise<void>;
}

/**
 * 频道状态处理器实现
 */
export class ChannelStateHandler implements IChannelStateHandler {
  private factory: HubHandlerFactory;
  private permissionChecker: HubPermissionChecker;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.permissionChecker = factory.getPermissionChecker();
  }

  async handleChannelStateNotification(params: EdgeNotificationParams<'edge.channelStateNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, channelState: channelStateObj, has_channel_id } = params;

      logger.info(`Hub received ChannelState from Edge ${edge_id}, actor: ${actor_username}(${actor_session}), has_channel_id: ${has_channel_id}`);

      const sessionManager = this.factory.getSessionManager();
      const permissionChecker = this.factory.getPermissionChecker();
      const channelManager = this.factory.getChannelManager();

      // 获取actor会话
      const actorSession = sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.factory.getControlService().notify(edge_id, 'hub.channelStateResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      // 确定频道ID和操作类型
      // 使用 has_channel_id 检查 protobuf optional 字段是否真的设置了值（遵循 Copilot 指导）
      let channelId: number;
      let isNewChannel: boolean;
      
      if (has_channel_id) {
        // 指定了channel_id - 这是更新现有频道或链接操作
        channelId = channelStateObj.channel_id!;
        const existingChannel = channelManager?.getChannel(channelId);
        isNewChannel = !existingChannel;
      } else {
        // 没有指定channel_id
        // 如果提供了name，这是创建新频道的请求
        if (channelStateObj.name) {
          // 生成新的频道ID
          const allChannels = channelManager?.getAllChannels() || [];
          const maxId = allChannels.reduce((max, ch) => Math.max(max, ch.id), 0);
          channelId = maxId + 1;
          isNewChannel = true;
        } else {
          // 没有name也没有channel_id，这是对当前频道的更新（如移动用户）
          channelId = actorSession.channel_id ?? 0;
          isNewChannel = false;
        }
      }

      // 权限检查
      if (permissionChecker) {
        const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
        
        // 对于新频道，检查parent的MakeChannel权限
        // 对于现有频道，检查该频道的TempChannel权限
        const channelToCheck = isNewChannel ? (channelStateObj.parent || 0) : channelId;
        const requiredPermission = isNewChannel ? Permission.MakeChannel : Permission.TempChannel;
        
        const hasPermission = await permissionChecker.hasPermission(
          channelToCheck,
          actorUserInfo,
          requiredPermission
        );

        if (!hasPermission) {
          this.factory.getControlService().notify(edge_id, 'hub.channelStateResponse', {
            success: false,
            actor_session,
            error: `Permission denied: ${isNewChannel ? 'MakeChannel' : 'MakeTempChannel'} permission required`,
            permission_denied: true,
            permission_type: isNewChannel ? 'MakeChannel' : 'MakeTempChannel',
          });
          return;
        }
      }

      // 如果是新频道，创建它
      if (isNewChannel) {
        if (!channelManager) {
          this.factory.getControlService().notify(edge_id, 'hub.channelStateResponse', {
            success: false,
            actor_session,
            error: 'Channel manager not available',
          });
          return;
        }

        // 准备新频道数据（用于创建）
        // 注意：ChannelManager.createChannel 期望的是 CreateChannelRequest 接口
        const channelData = {
          name: channelStateObj.name || '',
          parent_id: channelStateObj.parent || 0,
          description_blob: channelStateObj.description || '',
          position: channelStateObj.position || 0,
          max_users: channelStateObj.max_users || 0,
          inherit_acl: true, // 默认继承 ACL
        };

        try {
          const createdId = await channelManager.createChannel(channelData);
          // 验证创建的频道 ID 与预期一致
          if (createdId !== channelId) {
            logger.warn(`Expected channel ID ${channelId}, but database returned ${createdId}`);
            channelId = createdId; // 使用数据库返回的实际 ID
          }
          logger.info(`Created new channel: ${channelData.name} (ID: ${channelId})`);
        } catch (error) {
          logger.error(`Failed to create channel ${channelId}:`, error);
          this.factory.getControlService().notify(edge_id, 'hub.channelStateResponse', {
            success: false,
            actor_session,
            error: `Failed to create channel: ${error}`,
          });
          return;
        }
      } else {
        // 更新现有频道
        if (!channelManager) {
          this.factory.getControlService().notify(edge_id, 'hub.channelStateResponse', {
            success: false,
            actor_session,
            error: 'Channel manager not available',
          });
          return;
        }

        // 准备更新数据（使用数据库列名）
        const updateData: Partial<{
          name?: string;
          description_blob?: string;
          position?: number;
          max_users?: number;
          parent_id?: number;
        }> = {};
        if (channelStateObj.name !== undefined) {
          updateData.name = channelStateObj.name;
        }
        if (channelStateObj.parent !== undefined) {
          updateData.parent_id = channelStateObj.parent;
        }
        if (channelStateObj.description !== undefined) {
          updateData.description_blob = channelStateObj.description;
        }
        if (channelStateObj.position !== undefined) {
          updateData.position = channelStateObj.position;
        }
        if (channelStateObj.max_users !== undefined) {
          updateData.max_users = channelStateObj.max_users;
        }

        // 处理频道链接
        if (channelStateObj.links_add || channelStateObj.links_remove) {
          const database = this.factory.getDatabase();
          
          // 添加链接
          if (channelStateObj.links_add && Array.isArray(channelStateObj.links_add)) {
            for (const targetId of channelStateObj.links_add) {
              try {
                await database.linkChannels(channelId, targetId);
                logger.info(`Linked channels: ${channelId} <-> ${targetId}`);
              } catch (error) {
                logger.error(`Failed to link channels ${channelId} and ${targetId}:`, error);
              }
            }
          }
          
          // 移除链接
          if (channelStateObj.links_remove && Array.isArray(channelStateObj.links_remove)) {
            for (const targetId of channelStateObj.links_remove) {
              try {
                await database.unlinkChannels(channelId, targetId);
                logger.info(`Unlinked channels: ${channelId} <-> ${targetId}`);
              } catch (error) {
                logger.error(`Failed to unlink channels ${channelId} and ${targetId}:`, error);
              }
            }
          }
        }

        try {
          await channelManager.updateChannel(channelId, updateData);
          logger.info(`Updated channel: ${updateData.name || channelId} (ID: ${channelId})`);
        } catch (error) {
          logger.error(`Failed to update channel ${channelId}:`, error);
          this.factory.getControlService().notify(edge_id, 'hub.channelStateResponse', {
            success: false,
            actor_session,
            error: `Failed to update channel: ${error}`,
          });
          return;
        }
      }

      // 向发起Edge回复成功
      this.factory.getControlService().notify(edge_id, 'hub.channelStateResponse', {
        success: true,
        actor_session,
        channel_id: channelId,
      });

      // 获取最新的频道链接信息（如果有变更）
      let currentLinks: number[] | undefined;
      if (channelStateObj.links_add || channelStateObj.links_remove) {
        try {
          const database = this.factory.getDatabase();
          currentLinks = await database.getChannelLinks(channelId);
          logger.info(`Current links for channel ${channelId}: [${currentLinks.join(', ')}]`);
        } catch (error) {
          logger.error(`Failed to get channel links for ${channelId}:`, error);
        }
      }

      // 广播频道状态变化给所有Edge
      const broadcastData: Partial<{
        channel_id?: number;
        parent?: number;
        name?: string;
        description?: string;
        position?: number;
        temporary?: boolean;
        max_users?: number;
        links?: number[];
        links_add?: number[];
        links_remove?: number[];
      }> = {
        channel_id: channelId,
        name: channelStateObj.name,
        parent: channelStateObj.parent,
        description: channelStateObj.description,
        temporary: channelStateObj.temporary,
        position: channelStateObj.position,
      };
      
      // 如果有链接变更，广播links字段
      if (currentLinks !== undefined) {
        broadcastData.links = currentLinks;
      }
      
      // 如果有links_add或links_remove，也包含它们以便Edge进行增量更新
      if (channelStateObj.links_add) {
        broadcastData.links_add = channelStateObj.links_add;
      }
      if (channelStateObj.links_remove) {
        broadcastData.links_remove = channelStateObj.links_remove;
      }

      this.factory.getControlService().broadcast('hub.channelStateBroadcast', broadcastData);

      logger.info(`Hub: Broadcasting ChannelState for channel ${channelId} to all edges`);

    } catch (error) {
      logger.error('Error handling channel state notification:', error);
      this.factory.getControlService().notify(params.edge_id, 'hub.channelStateResponse', {
        success: false,
        actor_session: params.actor_session,
        error: 'Internal server error',
      });
    }
  }

  async handleChannelRemoveNotification(params: EdgeNotificationParams<'edge.channelRemoveNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, channel_id } = params;

      logger.info(`Hub received ChannelRemove from Edge ${edge_id}, actor: ${actor_username}(${actor_session}), channel: ${channel_id}`);

      const sessionManager = this.factory.getSessionManager();
      const permissionChecker = this.factory.getPermissionChecker();
      const channelManager = this.factory.getChannelManager();

      // 获取actor会话
      const actorSession = sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.factory.getControlService().notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      // 权限检查
      if (permissionChecker) {
        const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
        const hasPermission = await permissionChecker.hasPermission(
          channel_id,
          actorUserInfo,
          Permission.MakeChannel
        );

        if (!hasPermission) {
          this.factory.getControlService().notify(edge_id, 'hub.channelRemoveResponse', {
            success: false,
            actor_session,
            error: 'Permission denied: MakeChannel permission required',
            permission_denied: true,
            permission_type: 'MakeChannel',
          });
          return;
        }
      }

      // 检查频道是否存在
      const channel = channelManager?.getChannel(channel_id);
      if (!channel) {
        this.factory.getControlService().notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: 'Channel not found',
        });
        return;
      }

      // 检查频道是否为空（没有用户）
      const sessionsInChannel = sessionManager.getChannelSessions(channel_id);
      if (sessionsInChannel.length > 0) {
        this.factory.getControlService().notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: 'Cannot remove channel with users',
        });
        return;
      }

      // 删除频道
      if (!channelManager) {
        this.factory.getControlService().notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: 'Channel manager not available',
        });
        return;
      }

      try {
        await channelManager.deleteChannel(channel_id);
        logger.info(`Removed channel: ${channel.name} (ID: ${channel_id})`);
      } catch (error) {
        logger.error(`Failed to remove channel ${channel_id}:`, error);
        this.factory.getControlService().notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: `Failed to remove channel: ${error}`,
        });
        return;
      }

      // 向发起Edge回复成功
      this.factory.getControlService().notify(edge_id, 'hub.channelRemoveResponse', {
        success: true,
        actor_session,
        channel_id,
      });

      // 广播频道删除给所有Edge
      this.factory.getControlService().broadcast('hub.channelRemoveBroadcast', {
        channel_id,
      });

      logger.info(`Hub: Broadcasting ChannelRemove for channel ${channel_id} to all edges`);

    } catch (error) {
      logger.error('Error handling channel remove notification:', error);
      this.factory.getControlService().notify(params.edge_id, 'hub.channelRemoveResponse', {
        success: false,
        actor_session: params.actor_session,
        error: 'Internal server error',
      });
    }
  }
}