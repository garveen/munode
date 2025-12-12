import type { Logger } from '@munode/common';
import { HubPermissionChecker, Permission } from '../permission-checker.js';
import { HubHandlerFactory } from '../factory.js';
import type { EdgeNotificationParams } from '@munode/protocol';


/**
 * 用户状态处理器接口
 */
export interface IUserStateHandler {
  /**
   * 处理用户状态通知
   */
  handleUserStateNotification(params: EdgeNotificationParams<'edge.userStateNotification'>): Promise<void>;

  /**
   * 处理用户离开通知
   */
  handleUserLeftNotification(params: EdgeNotificationParams<'edge.userLeftNotification'>): Promise<void>;
}

/**
 * 用户状态处理器实现
 */
export class UserStateHandler implements IUserStateHandler {
  private factory: HubHandlerFactory;
  private permissionChecker: HubPermissionChecker;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
    this.permissionChecker = factory.getPermissionChecker();
  }

  async handleUserStateNotification(params: EdgeNotificationParams<'edge.userStateNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, userState: userStateObj } = params;

      this.logger.info(`Hub received UserState from Edge ${edge_id}, actor: ${actor_username}(${actor_session}), target: ${userStateObj.session || actor_session}`);

      const sessionManager = this.factory.getSessionManager();
      const controlService = this.factory.getControlService();
      const config = this.factory.getConfig();

      // 确定目标会话
      const targetSession = userStateObj.session || actor_session;

      // 获取目标会话
      const targetGlobalSession = sessionManager.getSession(targetSession);
      if (!targetGlobalSession) {
        this.logger.warn(`Target session ${targetSession} not found in Hub`);

        // 向发起Edge回复错误
        controlService.notify(edge_id, 'hub.userStateResponse', {
          success: false,
          actor_session,
          error: 'Target session not found',
        });
        return;
      }

      // 获取actor会话（用于权限检查）
      const actorSession = sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.logger.warn(`Actor session ${actor_session} not found in Hub`);
        controlService.notify(edge_id, 'hub.userStateResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      const isActorTarget = actor_session === targetSession;
      let broadcast = false;

      // Save the old channel ID before any updates (for ninja channel logic)
      const originalChannelId = targetGlobalSession.channel_id ?? 0;

      // 创建一个新的UserState对象，只包含实际变更的字段
      // 参考Edge废弃实现：只广播变更的字段，避免客户端显示不必要的消息
      const broadcastUserState: Partial<{
        session?: number;
        actor?: number;
        name?: string;
        user_id?: number;
        channel_id?: number;
        mute?: boolean;
        deaf?: boolean;
        suppress?: boolean;
        self_mute?: boolean;
        self_deaf?: boolean;
        priority_speaker?: boolean;
        recording?: boolean;
        listening_channel_add?: number[];
        listening_channel_remove?: number[];
      }> = {
        session: targetSession,
        actor: actor_session,
        name: targetGlobalSession.username,
        user_id: targetGlobalSession.user_id,
      };

      // 设置actor字段（保留在原对象中用于后续处理）
      userStateObj.actor = actor_session;
      userStateObj.session = targetSession;

      // 处理频道移动
      if (userStateObj.channel_id !== undefined) {
        const oldChannelId = targetGlobalSession.channel_id;
        const newChannelId = userStateObj.channel_id;

        // 将channel_id添加到广播对象
        broadcastUserState.channel_id = newChannelId;

        // 权限检查：移动其他用户需要特殊权限
        if (!isActorTarget) {
          const database = this.factory.getDatabase();
          if (database) {
            // 检查目标用户是否对新频道有EnterPermission
            const targetUserInfo = this.permissionChecker.sessionToUserInfo(targetGlobalSession, oldChannelId);
            const targetHasEnter = await this.permissionChecker.hasPermission(
              newChannelId,
              targetUserInfo,
              Permission.Enter
            );

            // 检查actor是否对目标用户当前频道有MovePermission
            const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
            const actorHasMove = oldChannelId !== undefined
              ? await this.permissionChecker.hasPermission(oldChannelId, actorUserInfo, Permission.Move)
              : false;

            // 如果目标没有Enter权限，actor必须在目标当前频道有Move权限
            if (!targetHasEnter && !actorHasMove) {
              controlService.notify(edge_id, 'hub.userStateResponse', {
                success: false,
                actor_session,
                error: 'Permission denied: MovePermission required',
                permission_denied: true,
                permission_type: 'Move',
              });
              return;
            }

            // 如果目标有Enter权限，actor需要在新频道有Move权限
            if (targetHasEnter) {
              const actorHasMoveInDest = await this.permissionChecker.hasPermission(
                newChannelId,
                actorUserInfo,
                Permission.Move
              );
              if (!actorHasMoveInDest) {
                controlService.notify(edge_id, 'hub.userStateResponse', {
                  success: false,
                  actor_session,
                  error: 'Permission denied: MovePermission required in destination channel',
                  permission_denied: true,
                  permission_type: 'Move',
                });
                return;
              }
            }

            // 检查目标用户是否对新频道有TraversePermission
            const targetHasTraverse = await this.permissionChecker.hasPermission(
              newChannelId,
              targetUserInfo,
              Permission.Traverse
            );
            if (!targetHasTraverse) {
              controlService.notify(edge_id, 'hub.userStateResponse', {
                success: false,
                actor_session,
                error: 'Permission denied: target lacks TraversePermission',
                permission_denied: true,
                permission_type: 'Traverse',
              });
              return;
            }

            this.logger.debug(`User ${actor_username} moving user ${targetGlobalSession.username} with permission check passed`);
          }
        } else if (isActorTarget) {
          // 自己移动自己：需要EnterPermission
          const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, oldChannelId);
          const hasEnter = await this.permissionChecker.hasPermission(
            newChannelId,
            actorUserInfo,
            Permission.Enter
          );
          if (!hasEnter) {
            controlService.notify(edge_id, 'hub.userStateResponse', {
              success: false,
              actor_session,
              error: 'Permission denied: EnterPermission required',
              permission_denied: true,
              permission_type: 'Enter',
            });
            return;
          }
        }

        // TODO: 检查目标频道是否存在

        // 更新会话的频道
        sessionManager.updateSessionChannel(targetSession, userStateObj.channel_id);
        broadcast = true;

        this.logger.info(`User ${targetGlobalSession.username} moved from channel ${oldChannelId} to ${userStateObj.channel_id}`);
      }

      // 防止actor != target时应用自我操作字段
      if (!isActorTarget &&
          (userStateObj.self_deaf !== undefined || userStateObj.self_mute !== undefined ||
           userStateObj.texture !== undefined || userStateObj.plugin_context !== undefined ||
           userStateObj.plugin_identity !== undefined)) {
        this.logger.warn(`Invalid UserState: actor ${actor_session} trying to set self-fields for target ${targetSession}`);
        controlService.notify(edge_id, 'hub.userStateResponse', {
          success: false,
          actor_session,
          error: 'Cannot set self-fields for other users',
        });
        return;
      }

      // 处理SelfDeaf/SelfMute（用户自己控制）
      if (userStateObj.self_deaf !== undefined) {
        const stateUpdates: { self_deaf: boolean; self_mute?: boolean } = { self_deaf: userStateObj.self_deaf };
        broadcastUserState.self_deaf = userStateObj.self_deaf;

        if (userStateObj.self_deaf) {
          // SelfDeaf 会自动 SelfMute
          userStateObj.self_mute = true;
          broadcastUserState.self_mute = true;
          stateUpdates.self_mute = true;
        }

        sessionManager.updateSessionState(targetSession, stateUpdates);
        broadcast = true;
      }

      if (userStateObj.self_mute !== undefined) {
        const stateUpdates: { self_mute: boolean; self_deaf?: boolean } = { self_mute: userStateObj.self_mute };
        broadcastUserState.self_mute = userStateObj.self_mute;

        if (!userStateObj.self_mute) {
          // Un-SelfMute 会自动 Un-SelfDeaf
          userStateObj.self_deaf = false;
          broadcastUserState.self_deaf = false;
          stateUpdates.self_deaf = false;
        }

        sessionManager.updateSessionState(targetSession, stateUpdates);
        broadcast = true;
      }

      // 处理Mute/Deaf/Suppress/PrioritySpeaker（管理员操作）
      if (userStateObj.mute !== undefined || userStateObj.deaf !== undefined ||
          userStateObj.suppress !== undefined || userStateObj.priority_speaker !== undefined) {

        // 权限检查：操作其他用户需要MuteDeafenPermission
        if (!isActorTarget && targetGlobalSession.channel_id !== undefined) {
          const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
          const hasMuteDeafen = await this.permissionChecker.hasPermission(
            targetGlobalSession.channel_id,
            actorUserInfo,
            Permission.MuteDeafen
          );
          if (!hasMuteDeafen) {
            controlService.notify(edge_id, 'hub.userStateResponse', {
              success: false,
              actor_session,
              error: 'Permission denied: MuteDeafenPermission required',
              permission_denied: true,
              permission_type: 'MuteDeafen',
            });
            return;
          }
          this.logger.debug(`User ${actor_username} has MuteDeafenPermission for user ${targetGlobalSession.username}`);
        }

        // Suppress只能由服务器设置（拒绝客户端设置为true）
        if (userStateObj.suppress === true) {
          controlService.notify(edge_id, 'hub.userStateResponse', {
            success: false,
            actor_session,
            error: 'Permission denied: only server can suppress users',
            permission_denied: true,
            permission_type: 'suppress',
          });
          return;
        }

        const stateUpdates: Partial<{
          deaf?: boolean;
          mute?: boolean;
          suppress?: boolean;
          self_deaf?: boolean;
          self_mute?: boolean;
          priority_speaker?: boolean;
        }> = {};

        if (userStateObj.deaf !== undefined) {
          stateUpdates.deaf = userStateObj.deaf;
          broadcastUserState.deaf = userStateObj.deaf;
          if (userStateObj.deaf) {
            // Deaf会自动Mute
            userStateObj.mute = true;
            broadcastUserState.mute = true;
            stateUpdates.mute = true;
          }
        }

        if (userStateObj.mute !== undefined) {
          stateUpdates.mute = userStateObj.mute;
          broadcastUserState.mute = userStateObj.mute;
          if (!userStateObj.mute && stateUpdates.deaf === undefined) {
            // Un-Mute会自动Un-Deaf（如果deaf没有被显式设置）
            userStateObj.deaf = false;
            broadcastUserState.deaf = false;
            stateUpdates.deaf = false;
          }
        }

        if (userStateObj.suppress !== undefined) {
          stateUpdates.suppress = userStateObj.suppress;
          broadcastUserState.suppress = userStateObj.suppress;
        }

        if (userStateObj.priority_speaker !== undefined) {
          stateUpdates.priority_speaker = userStateObj.priority_speaker;
          broadcastUserState.priority_speaker = userStateObj.priority_speaker;
        }

        sessionManager.updateSessionState(targetSession, stateUpdates);
        broadcast = true;
      }

      // 处理Recording状态变化
      if (userStateObj.recording !== undefined) {
        sessionManager.updateSessionState(targetSession, { recording: userStateObj.recording });
        broadcastUserState.recording = userStateObj.recording;
        broadcast = true;

        const recordingMessage = userStateObj.recording
          ? `User '${targetGlobalSession.username}' started recording`
          : `User '${targetGlobalSession.username}' stopped recording`;
        this.logger.info(recordingMessage);
      }

      // 处理监听频道（listening_channel_add/remove）
      if (userStateObj.listening_channel_add && userStateObj.listening_channel_add.length > 0) {
        // 权限检查：需要对每个频道有Listen权限
        const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
        const allowedChannels: number[] = [];

        for (const channelId of userStateObj.listening_channel_add) {
          const hasListen = await this.permissionChecker.hasPermission(
            channelId,
            actorUserInfo,
            Permission.Listen
          );

          if (hasListen) {
            allowedChannels.push(channelId);
          } else {
            this.logger.warn(`User ${actor_username} denied Listen permission for channel ${channelId}`);
            // 发送权限被拒绝的消息给客户端
            controlService.notify(edge_id, 'hub.permissionDenied', {
              session_id: actor_session,
              channel_id: channelId,
              permission_type: 'Listen',
              reason: 'No Listen permission for this channel',
            });
          }
        }

        if (allowedChannels.length > 0) {
          broadcastUserState.listening_channel_add = allowedChannels;
          broadcast = true;
          this.logger.info(`User ${actor_username} started listening to channels: ${allowedChannels.join(', ')}`);
        }

      }

      if (userStateObj.listening_channel_remove && userStateObj.listening_channel_remove.length > 0) {
        // 移除监听不需要权限检查
        broadcastUserState.listening_channel_remove = userStateObj.listening_channel_remove;
        broadcast = true;
        this.logger.info(`User ${actor_username} stopped listening to channels: ${userStateObj.listening_channel_remove.join(', ')}`);
      }

      if (!broadcast) {
        // 没有任何变化，但仍然回复成功
        controlService.notify(edge_id, 'hub.userStateResponse', {
          success: true,
          actor_session,
          target_session: targetSession,
        });
        return;
      }

      // 向发起Edge回复成功，并包含实际的userState数据用于发送给客户端
      controlService.notify(edge_id, 'hub.userStateResponse', {
        success: true,
        actor_session,
        target_session: targetSession,
        userState: broadcastUserState,
      });

      this.logger.info(`Hub: Broadcasting UserState for session ${targetSession} to all edges, fields: ${Object.keys(broadcastUserState).join(', ')}`);

      // Check if Channel Ninja feature is enabled and we have ninja channels configured
      const channelNinjaEnabled = config.channelNinja ?? false;
      const hasNinjaChannels = config.ninjaChannels?.length > 0;

      if (channelNinjaEnabled && hasNinjaChannels) {
        // Ninja logic: Filter broadcast based on individual user visibility
        const ninjaChannels = new Set(config.ninjaChannels);
        const allSessions = sessionManager.getAllSessions();
        
        // Track which sessions can see this user state change
        const visibleToSessions = new Map<number, number[]>(); // edge_id -> session_ids[]
        const invisibleToSessions = new Map<number, number[]>(); // edge_id -> session_ids[]
        
        // Determine the target user's channel (after the state change)
        const targetChannelId = broadcastUserState.channel_id ?? targetGlobalSession.channel_id ?? 0;
        
        // Check if this is a channel move (and user was in a different channel before)
        const isChannelMove = broadcastUserState.channel_id !== undefined && originalChannelId !== targetChannelId;
        
        for (const observerSession of allSessions) {
          // Skip the target user themselves
          if (observerSession.session_id === targetSession) continue;
          
          const observerUserInfo = this.permissionChecker.sessionToUserInfo(
            observerSession,
            observerSession.channel_id ?? 0
          );
          
          // Check if observer can see the target user in the new state
          const canSeeTarget = await this.permissionChecker.canUserSeeOtherUser(
            observerUserInfo,
            observerSession.channel_id ?? 0,
            targetChannelId,
            ninjaChannels
          );
          
          if (canSeeTarget) {
            // Observer can see the target - send UserState
            if (!visibleToSessions.has(observerSession.edge_id)) {
              visibleToSessions.set(observerSession.edge_id, []);
            }
            visibleToSessions.get(observerSession.edge_id).push(observerSession.session_id);
          } else if (isChannelMove) {
            // Observer cannot see target AND this is a channel move
            // Check if they could see the target in the old channel
            const couldSeeOldChannel = await this.permissionChecker.canUserSeeOtherUser(
              observerUserInfo,
              observerSession.channel_id ?? 0,
              originalChannelId,
              ninjaChannels
            );
            
            if (couldSeeOldChannel) {
              // Observer could see target before but not now - send UserRemove
              if (!invisibleToSessions.has(observerSession.edge_id)) {
                invisibleToSessions.set(observerSession.edge_id, []);
              }
              invisibleToSessions.get(observerSession.edge_id).push(observerSession.session_id);
            }
            // else: observer couldn't see before and can't see now - do nothing
          }
          // else: not a channel move and observer can't see - do nothing
        }
        
        // Send UserState to sessions that can see the target
        for (const [edgeId, sessionIds] of visibleToSessions.entries()) {
          controlService.notify(edgeId, 'hub.userStateBroadcast', {
            ...broadcastUserState,
            target_sessions: sessionIds,
          });
        }
        
        // Send UserRemove to sessions that could see before but not now
        if (invisibleToSessions.size > 0) {
          for (const [edgeId, sessionIds] of invisibleToSessions.entries()) {
            controlService.notify(edgeId, 'hub.userRemoveBroadcast', {
              session: targetSession,
              target_sessions: sessionIds,
            });
          }
          this.logger.info(`Channel Ninja: Sent UserRemove for session ${targetSession} to ${Array.from(invisibleToSessions.values()).flat().length} users who cannot see the new channel`);
        }
        
        this.logger.info(`Channel Ninja: Broadcasted UserState for session ${targetSession} to ${Array.from(visibleToSessions.values()).flat().length} users (ninja filtering applied)`);
      } else {
        // No ninja functionality or not configured - broadcast to all edges normally
        controlService.broadcast('hub.userStateBroadcast', broadcastUserState);
      }

    } catch (error) {
      this.logger.error('Error handling user state notification:', error);
      // 向发起Edge回复错误
      const controlService = this.factory.getControlService();
      controlService.notify(params.edge_id, 'hub.userStateResponse', {
        success: false,
        actor_session: params.actor_session,
        error: 'Internal server error',
      });
    }
  }

  async handleUserLeftNotification(params: EdgeNotificationParams<'edge.userLeftNotification'>): Promise<void> {
    const { edge_id, session_id } = params as { edge_id: number; session_id: number; reason?: string };
    const sessionManager = this.factory.getSessionManager();
    const controlService = this.factory.getControlService();

    this.logger.info(`User (session ${session_id}) left from Edge ${edge_id}`);

    // 从会话管理器中移除会话
    sessionManager.removeSession(session_id);

    // 广播用户离开消息给所有Edge
    controlService.broadcast('hub.userLeft', {
      session_id: session_id,
      reason: params.reason,
    });
  }
}