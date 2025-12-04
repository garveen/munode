import { createLogger } from '@munode/common';
import { HubPermissionChecker, Permission } from '../permission-checker.js';
import { HubHandlerFactory } from '../factory.js';

const logger = createLogger({ service: 'hub-channel-state-handler' });

/**
 * 频道状态处理器接口
 */
export interface IChannelStateHandler {
  /**
   * 处理频道状态通知
   */
  handleChannelStateNotification(params: any): Promise<void>;

  /**
   * 处理频道删除通知
   */
  handleChannelRemoveNotification(params: any): Promise<void>;
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

  async handleChannelStateNotification(params: any): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, channelState: channelStateObj, has_channel_id } = params;

      logger.info(`Hub received ChannelState from Edge ${edge_id}, actor: ${actor_username}(${actor_session})`);

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

      // 确定频道ID
      let channelId: number;
      if (has_channel_id && channelStateObj.channel_id !== undefined) {
        channelId = channelStateObj.channel_id;
      } else {
        // 如果没有提供channel_id，使用actor的当前频道
        channelId = actorSession.channel_id ?? 0;
      }

      // 检查频道是否存在
      const existingChannel = channelManager?.getChannel(channelId);
      const isNewChannel = !existingChannel;

      // 权限检查
      if (permissionChecker) {
        const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
        const hasPermission = await permissionChecker.hasPermission(
          channelId,
          actorUserInfo,
          isNewChannel ? Permission.MakeChannel : Permission.TempChannel
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

      // 准备频道数据
      const channelData: any = {
        channel_id: channelId,
        name: channelStateObj.name || '',
        parent: channelStateObj.parent || 0,
        description: channelStateObj.description || '',
        temporary: channelStateObj.temporary || false,
        position: channelStateObj.position || 0,
      };

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

        try {
          await channelManager.createChannel(channelData);
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

        try {
          await channelManager.updateChannel(channelId, channelData);
          logger.info(`Updated channel: ${channelData.name} (ID: ${channelId})`);
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

      // 广播频道状态变化给所有Edge
      this.factory.getControlService().broadcast('hub.channelStateBroadcast', {
        channel_id: channelId,
        name: channelData.name,
        parent: channelData.parent,
        description: channelData.description,
        temporary: channelData.temporary,
        position: channelData.position,
      });

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

  async handleChannelRemoveNotification(params: any): Promise<void> {
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