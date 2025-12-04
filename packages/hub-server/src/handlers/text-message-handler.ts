import { createLogger } from '@munode/common';
import { HubPermissionChecker, Permission } from '../permission-checker.js';
import { HubHandlerFactory } from '../factory.js';

const logger = createLogger({ service: 'hub-text-message-handler' });

/**
 * 文本消息处理器接口
 */
export interface ITextMessageHandler {
  /**
   * 处理文本消息通知
   */
  handleTextMessageNotification(params: any): Promise<void>;
}

/**
 * 文本消息处理器实现
 */
export class TextMessageHandler implements ITextMessageHandler {
  private factory: HubHandlerFactory;
  private permissionChecker: HubPermissionChecker;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.permissionChecker = factory.getPermissionChecker();
  }

  async handleTextMessageNotification(params: any): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, actor_channel_id, textMessage } = params;

      logger.info(`Hub received TextMessage from Edge ${edge_id}, actor: ${actor_username}(${actor_session})`);

      const sessionManager = this.factory.getSessionManager();
      const permissionChecker = this.factory.getPermissionChecker();
      const channelManager = this.factory.getChannelManager();
      const databaseOperations = this.factory.getDatabaseOperations();

      // 获取actor会话
      const actorSession = sessionManager.getSession(actor_session);
      if (!actorSession) {
        logger.warn(`Actor session ${actor_session} not found in Hub`);
        return;
      }

      // 目标会话列表
      const targetSessions: number[] = [];
      const targetSessionsByEdge = new Map<number, number[]>(); // edge_id -> session_ids

      // 1. 处理直接指定的用户（私聊）
      if (textMessage.session && textMessage.session.length > 0) {
        for (const targetSession of textMessage.session) {
          const session = sessionManager.getSession(targetSession);
          if (session) {
            targetSessions.push(targetSession);
            // 按Edge分组
            if (!targetSessionsByEdge.has(session.edge_id)) {
              targetSessionsByEdge.set(session.edge_id, []);
            }
            targetSessionsByEdge.get(session.edge_id)!.push(targetSession);
          }
        }
      }

      // 2. 处理频道消息
      if (textMessage.channel_id && textMessage.channel_id.length > 0) {
        for (const channel_id of textMessage.channel_id) {
          // 权限检查：需要TextMessage权限
          if (permissionChecker) {
            const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actor_channel_id);
            const hasPermission = await permissionChecker.hasPermission(
              channel_id,
              actorUserInfo,
              Permission.TextMessage
            );

            if (!hasPermission) {
              logger.warn(`Actor ${actor_username} denied TextMessage permission for channel ${channel_id}`);
              // 发送权限拒绝通知给发起Edge
              this.factory.getControlService().notify(edge_id, 'hub.textMessageDenied', {
                actor_session,
                channel_id,
                reason: 'TextMessage permission denied',
              });
              continue;
            }
          }

          // 获取频道中的所有用户
          const channelSessions = sessionManager.getChannelSessions(channel_id);
          for (const session of channelSessions) {
            if (!targetSessions.includes(session.session_id)) {
              targetSessions.push(session.session_id);
              // 按Edge分组
              if (!targetSessionsByEdge.has(session.edge_id)) {
                targetSessionsByEdge.set(session.edge_id, []);
              }
              targetSessionsByEdge.get(session.edge_id)!.push(session.session_id);
            }
          }
        }
      }

      // 3. 处理频道树消息（包含子频道）
      if (textMessage.tree_id && textMessage.tree_id.length > 0) {
        for (const rootChannelId of textMessage.tree_id) {
          // 权限检查：需要TextMessage权限
          if (permissionChecker) {
            const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actor_channel_id);
            const hasPermission = await permissionChecker.hasPermission(
              rootChannelId,
              actorUserInfo,
              Permission.TextMessage
            );

            if (!hasPermission) {
              logger.warn(`Actor ${actor_username} denied TextMessage permission for channel tree ${rootChannelId}`);
              this.factory.getControlService().notify(edge_id, 'hub.textMessageDenied', {
                actor_session,
                channel_id: rootChannelId,
                reason: 'TextMessage permission denied',
              });
              continue;
            }
          }

          // 收集频道树中的所有频道
          const channelsInTree: number[] = [];
          const collectChannels = async (channel_id: number) => {
            channelsInTree.push(channel_id);
            const channel = channelManager
              ? channelManager.getChannel(channel_id)
              : await databaseOperations.getChannel(channel_id);
            if (channel) {
              const children = channelManager
                ? await channelManager.getChildChannels(channel_id)
                : await databaseOperations.getChildChannels(channel_id);
              for (const child of children) {
                await collectChannels(child.id);
              }
            }
          };
          await collectChannels(rootChannelId);

          // 获取这些频道中的所有用户
          for (const channelId of channelsInTree) {
            const channelSessions = sessionManager.getChannelSessions(channelId);
            for (const session of channelSessions) {
              if (!targetSessions.includes(session.session_id)) {
                targetSessions.push(session.session_id);
                // 按Edge分组
                if (!targetSessionsByEdge.has(session.edge_id)) {
                  targetSessionsByEdge.set(session.edge_id, []);
                }
                targetSessionsByEdge.get(session.edge_id)!.push(session.session_id);
              }
            }
          }
        }
      }

      if (targetSessions.length === 0) {
        logger.warn(`TextMessage from ${actor_username} has no valid targets`);
        return;
      }

      // 按Edge广播（每个Edge只发送其本地用户的session列表）
      for (const [target_edge_id, sessions] of targetSessionsByEdge.entries()) {
        this.factory.getControlService().notify(target_edge_id, 'hub.textMessageBroadcast', {
          textMessage: {
            actor: textMessage.actor,
            session: textMessage.session || [],
            channel_id: textMessage.channel_id || [],
            tree_id: textMessage.tree_id || [],
            message: textMessage.message || '',
          },
          target_sessions: sessions,
        });
      }

      logger.info(`Broadcasted TextMessage from ${actor_username} to ${targetSessions.length} users across ${targetSessionsByEdge.size} edges`);
    } catch (error) {
      logger.error('Error handling TextMessage notification:', error);
    }
  }
}