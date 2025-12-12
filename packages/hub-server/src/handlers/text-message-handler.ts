import type { Logger } from '@munode/common';
import { HubPermissionChecker, Permission } from '../permission-checker.js';
import { HubHandlerFactory } from '../factory.js';
import type { EdgeNotificationParams } from '@munode/protocol';


/**
 * 文本消息处理器接口
 */
export interface ITextMessageHandler {
  /**
   * 处理文本消息通知
   */
  handleTextMessageNotification(params: EdgeNotificationParams<'edge.textMessageNotification'>): Promise<void>;
}

/**
 * 文本消息处理器实现
 */
export class TextMessageHandler implements ITextMessageHandler {
  private factory: HubHandlerFactory;
  private permissionChecker: HubPermissionChecker;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
    this.permissionChecker = factory.getPermissionChecker();
  }

  async handleTextMessageNotification(params: EdgeNotificationParams<'edge.textMessageNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, session, channel_id, tree_id, message } = params;

      this.logger.info(`Hub received TextMessage from Edge ${edge_id}, actor: ${actor_username}(${actor_session})`);

      const sessionManager = this.factory.getSessionManager();
      const permissionChecker = this.factory.getPermissionChecker();
      const channelManager = this.factory.getChannelManager();
      const databaseOperations = this.factory.getDatabaseOperations();

      // 获取actor会话
      const actorSession = sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.logger.warn(`Actor session ${actor_session} not found in Hub`);
        return;
      }

      // Get actor's channel
      const actor_channel_id = actorSession.channel_id ?? 0;

      // 目标会话列表
      const targetSessions: number[] = [];
      const targetSessionsByEdge = new Map<number, number[]>(); // edge_id -> session_ids

      // 1. 处理直接指定的用户（私聊）
      if (session && session.length > 0) {
        for (const targetSession of session) {
          const sess = sessionManager.getSession(targetSession);
          if (sess) {
            targetSessions.push(targetSession);
            // 按Edge分组
            if (!targetSessionsByEdge.has(sess.edge_id)) {
              targetSessionsByEdge.set(sess.edge_id, []);
            }
            targetSessionsByEdge.get(sess.edge_id).push(targetSession);
          }
        }
      }

      // 2. 处理频道消息
      if (channel_id && channel_id.length > 0) {
        for (const channelId of channel_id) {
          // 权限检查：需要TextMessage权限
          if (permissionChecker) {
            const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actor_channel_id);
            const hasPermission = await permissionChecker.hasPermission(
              channelId,
              actorUserInfo,
              Permission.TextMessage
            );

            if (!hasPermission) {
              this.logger.warn(`Actor ${actor_username} denied TextMessage permission for channel ${channelId}`);
              // 发送权限拒绝通知给发起Edge
              this.factory.getControlService().notify(edge_id, 'hub.textMessageDenied', {
                actor_session,
                reason: 'TextMessage permission denied',
              });
              continue;
            }
          }

          // 获取频道中的所有用户
          const channelSessions = sessionManager.getChannelSessions(channelId);
          for (const sess of channelSessions) {
            if (!targetSessions.includes(sess.session_id)) {
              targetSessions.push(sess.session_id);
              // 按Edge分组
              if (!targetSessionsByEdge.has(sess.edge_id)) {
                targetSessionsByEdge.set(sess.edge_id, []);
              }
              targetSessionsByEdge.get(sess.edge_id).push(sess.session_id);
            }
          }
        }
      }

      // 3. 处理频道树消息（包含子频道）
      if (tree_id && tree_id.length > 0) {
        for (const rootChannelId of tree_id) {
          // 权限检查：需要TextMessage权限
          if (permissionChecker) {
            const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actor_channel_id);
            const hasPermission = await permissionChecker.hasPermission(
              rootChannelId,
              actorUserInfo,
              Permission.TextMessage
            );

            if (!hasPermission) {
              this.logger.warn(`Actor ${actor_username} denied TextMessage permission for channel tree ${rootChannelId}`);
              this.factory.getControlService().notify(edge_id, 'hub.textMessageDenied', {
                actor_session,
                reason: 'TextMessage permission denied',
              });
              continue;
            }
          }

          // 收集频道树中的所有频道
          const channelsInTree: number[] = [];
          const collectChannels = async (channelId: number) => {
            channelsInTree.push(channelId);
            const channel = channelManager
              ? channelManager.getChannel(channelId)
              : await databaseOperations.getChannel(channelId);
            if (channel) {
              const children = channelManager
                ? await channelManager.getChildChannels(channelId)
                : await databaseOperations.getChildChannels(channelId);
              for (const child of children) {
                await collectChannels(child.id);
              }
            }
          };
          await collectChannels(rootChannelId);

          // 获取这些频道中的所有用户
          for (const channelId of channelsInTree) {
            const channelSessions = sessionManager.getChannelSessions(channelId);
            for (const sess of channelSessions) {
              if (!targetSessions.includes(sess.session_id)) {
                targetSessions.push(sess.session_id);
                // 按Edge分组
                if (!targetSessionsByEdge.has(sess.edge_id)) {
                  targetSessionsByEdge.set(sess.edge_id, []);
                }
                targetSessionsByEdge.get(sess.edge_id).push(sess.session_id);
              }
            }
          }
        }
      }

      if (targetSessions.length === 0) {
        this.logger.warn(`TextMessage from ${actor_username} has no valid targets`);
        return;
      }

      // 按Edge广播（每个Edge只发送其本地用户的session列表）
      for (const [target_edge_id] of targetSessionsByEdge.entries()) {
        this.factory.getControlService().notify(target_edge_id, 'hub.textMessageBroadcast', {
          actor: actor_session,
          session: session || [],
          channel_id: channel_id || [],
          tree_id: tree_id || [],
          message: message || '',
        });
      }

      this.logger.info(`Broadcasted TextMessage from ${actor_username} to ${targetSessions.length} users across ${targetSessionsByEdge.size} edges`);
    } catch (error) {
      this.logger.error('Error handling TextMessage notification:', error);
    }
  }
}