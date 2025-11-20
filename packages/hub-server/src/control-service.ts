import { createLogger, BlobStore } from '@munode/common';
import {
  ControlChannelServer,
  ControlChannelConfig,
  RPCChannel,
  Message,
  TypedRPCServer,
  createTypedRPCServer,
  RPCParams,
  RPCResult,
  ChannelData,
  ACLData,
  GlobalSession,
} from '@munode/protocol';
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';
import type { HubConfig } from './types.js';
import type { ServiceRegistry } from './registry.js';
import type { GlobalSessionManager } from './session-manager.js';
import type { VoiceTargetSyncService } from './voice-target-sync.js';
import type { CertificateExchangeService } from './certificate-exchange.js';
import type { HubDatabase } from './database.js';
import type { ACLManager } from './acl-manager.js';
import type { ChannelGroupManager } from './channel-group-manager.js';
import { HubPermissionChecker, Permission } from './permission-checker.js';

const logger = createLogger({ service: 'hub-control' });

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars, @typescript-eslint/indent */

/**
 * Hub Server 控制信道服务
 * 基于 MessagePack + WebSocket 的 RPC 服务
 */
export class HubControlService {
  private server: ControlChannelServer;
  private typedServer: TypedRPCServer;
  private config: HubConfig;
  private _registry: ServiceRegistry;
  private _sessionManager: GlobalSessionManager;
  private _voiceTargetSync: VoiceTargetSyncService;
  private _certExchange: CertificateExchangeService;
  private _database?: HubDatabase;
  private _aclManager?: ACLManager;
  private _channelGroupManager?: ChannelGroupManager;
  private _permissionChecker?: HubPermissionChecker;
  private _blobStore?: BlobStore;
  private edgeChannels = new Map<number, RPCChannel>(); // edge_id -> channel

  constructor(
    config: HubConfig,
    registry: ServiceRegistry,
    sessionManager: GlobalSessionManager,
    voiceTargetSync: VoiceTargetSyncService,
    certExchange: CertificateExchangeService,
    database?: HubDatabase,
    aclManager?: ACLManager,
    channelGroupManager?: ChannelGroupManager,
    blobStore?: BlobStore
  ) {
    this.config = config;
    this._registry = registry;
    this._sessionManager = sessionManager;
    this._voiceTargetSync = voiceTargetSync;
    this._certExchange = certExchange;
    this._database = database;
    this._aclManager = aclManager;
    this._channelGroupManager = channelGroupManager;
    this._blobStore = blobStore;
    
    // 初始化权限检查器
    if (database) {
      this._permissionChecker = new HubPermissionChecker(database, channelGroupManager);
    }

    const controlConfig: ControlChannelConfig = {
      port: config.controlPort || 8443,
      host: config.host,
    };

    this.server = new ControlChannelServer(controlConfig);
    this.typedServer = createTypedRPCServer();
    this.setupEventHandlers();
    this.registerHandlers();
  }

  private setupEventHandlers(): void {
    // 监听连接
    this.server.on('connect', (_channel: RPCChannel) => {
      logger.info('Edge connected to control channel');
    });

    // 监听断开
    this.server.on('disconnect', (channel: RPCChannel) => {
      // 找到对应的edge_id并移除
      for (const [edge_id, ch] of this.edgeChannels) {
        if (ch === channel) {
          this.edgeChannels.delete(edge_id);
          logger.info(`Edge ${edge_id} disconnected from control channel`);
          break;
        }
      }
    });

    // 监听请求
    this.server.on('request', (channel: RPCChannel, message: Message, respond: (result?: any, error?: any) => void) => {
      if (message.method) {
        this.typedServer.handleRequest(channel, { method: message.method, params: message.params }, respond);
      } else {
        respond(undefined, { code: -32600, message: 'Invalid request: missing method' });
      }
    });

    // 监听通知（notification不需要响应）
    this.server.on('notification', (channel: RPCChannel, message: Message) => {
      this.handleNotification(channel, message);
    });
  }

  /**
   * 处理来自Edge的通知消息
   */
  private handleNotification(_channel: RPCChannel, message: Message): void {
    const { method, params } = message;

    switch (method) {
      case 'hub.handleUserState':
        this.handleUserStateNotification(params);
        break;
      
      case 'hub.handleChannelState':
        this.handleChannelStateNotification(params);
        break;
      
      case 'hub.handleUserRemove':
        this.handleUserRemoveNotification(params);
        break;
      
      case 'hub.handleChannelRemove':
        this.handleChannelRemoveNotification(params);
        break;
      
      case 'hub.userLeft':
        this.handleUserLeftNotification(params);
        break;

      case 'hub.handleTextMessage':
        this.handleTextMessageNotification(params);
        break;

      default:
        logger.debug(`Unknown notification method: ${method}`);
    }
  }

  /**
   * 处理UserState通知 - 执行完整的业务逻辑并广播
   * 参照Edge独立模式的handleUserStateLocal_DEPRECATED实现
   */
  private async handleUserStateNotification(params: any): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, userState: userStateObj } = params;

      logger.info(`Hub received UserState from Edge ${edge_id}, actor: ${actor_username}(${actor_session}), target: ${userStateObj.session || actor_session}`);

      // 确定目标会话
      const targetSession = userStateObj.session || actor_session;
      
      // 获取目标会话
      const targetGlobalSession = this._sessionManager.getSession(targetSession);
      if (!targetGlobalSession) {
        logger.warn(`Target session ${targetSession} not found in Hub`);
        
        // 向发起Edge回复错误
        this.notify(edge_id, 'hub.userStateResponse', {
          success: false,
          actor_session,
          error: 'Target session not found',
        });
        return;
      }

      // 获取actor会话（用于权限检查）
      const actorSession = this._sessionManager.getSession(actor_session);
      if (!actorSession) {
        logger.warn(`Actor session ${actor_session} not found in Hub`);
        this.notify(edge_id, 'hub.userStateResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      const isActorTarget = actor_session === targetSession;
      let broadcast = false;

      // 创建一个新的UserState对象，只包含实际变更的字段
      // 参考Edge废弃实现：只广播变更的字段，避免客户端显示不必要的消息
      const broadcastUserState: any = {
        session: targetSession,
        actor: actor_session,
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
        if (!isActorTarget && this._permissionChecker && this._database) {
          // 检查目标用户是否对新频道有EnterPermission
          const targetUserInfo = HubPermissionChecker.sessionToUserInfo(targetGlobalSession, oldChannelId);
          const targetHasEnter = await this._permissionChecker.hasPermission(
            newChannelId,
            targetUserInfo,
            Permission.Enter
          );

          // 检查actor是否对目标用户当前频道有MovePermission
          const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
          const actorHasMove = oldChannelId !== undefined 
            ? await this._permissionChecker.hasPermission(oldChannelId, actorUserInfo, Permission.Move)
            : false;

          // 如果目标没有Enter权限，actor必须在目标当前频道有Move权限
          if (!targetHasEnter && !actorHasMove) {
            this.notify(edge_id, 'hub.userStateResponse', {
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
            const actorHasMoveInDest = await this._permissionChecker.hasPermission(
              newChannelId,
              actorUserInfo,
              Permission.Move
            );
            if (!actorHasMoveInDest) {
              this.notify(edge_id, 'hub.userStateResponse', {
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
          const targetHasTraverse = await this._permissionChecker.hasPermission(
            newChannelId,
            targetUserInfo,
            Permission.Traverse
          );
          if (!targetHasTraverse) {
            this.notify(edge_id, 'hub.userStateResponse', {
              success: false,
              actor_session,
              error: 'Permission denied: target lacks TraversePermission',
              permission_denied: true,
              permission_type: 'Traverse',
            });
            return;
          }

          logger.debug(`User ${actor_username} moving user ${targetGlobalSession.username} with permission check passed`);
        } else if (isActorTarget && this._permissionChecker) {
          // 自己移动自己：需要EnterPermission
          const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, oldChannelId);
          const hasEnter = await this._permissionChecker.hasPermission(
            newChannelId,
            actorUserInfo,
            Permission.Enter
          );
          if (!hasEnter) {
            this.notify(edge_id, 'hub.userStateResponse', {
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
        this._sessionManager.updateSessionChannel(targetSession, userStateObj.channel_id);
        broadcast = true;
        
        logger.info(`User ${targetGlobalSession.username} moved from channel ${oldChannelId} to ${userStateObj.channel_id}`);
      }

      // 防止actor != target时应用自我操作字段
      if (!isActorTarget && 
          (userStateObj.self_deaf !== undefined || userStateObj.self_mute !== undefined || 
           userStateObj.texture !== undefined || userStateObj.plugin_context !== undefined || 
           userStateObj.plugin_identity !== undefined)) {
        logger.warn(`Invalid UserState: actor ${actor_session} trying to set self-fields for target ${targetSession}`);
        this.notify(edge_id, 'hub.userStateResponse', {
          success: false,
          actor_session,
          error: 'Cannot set self-fields for other users',
        });
        return;
      }

      // 处理SelfDeaf/SelfMute（用户自己控制）
      if (userStateObj.self_deaf !== undefined) {
        const stateUpdates: any = { self_deaf: userStateObj.self_deaf };
        broadcastUserState.self_deaf = userStateObj.self_deaf;
        
        if (userStateObj.self_deaf) {
          // SelfDeaf 会自动 SelfMute
          userStateObj.self_mute = true;
          broadcastUserState.self_mute = true;
          stateUpdates.self_mute = true;
        }
        
        this._sessionManager.updateSessionState(targetSession, stateUpdates);
        broadcast = true;
      }

      if (userStateObj.self_mute !== undefined) {
        const stateUpdates: any = { self_mute: userStateObj.self_mute };
        broadcastUserState.self_mute = userStateObj.self_mute;
        
        if (!userStateObj.self_mute) {
          // Un-SelfMute 会自动 Un-SelfDeaf
          userStateObj.self_deaf = false;
          broadcastUserState.self_deaf = false;
          stateUpdates.self_deaf = false;
        }
        
        this._sessionManager.updateSessionState(targetSession, stateUpdates);
        broadcast = true;
      }

      // 处理Mute/Deaf/Suppress/PrioritySpeaker（管理员操作）
      if (userStateObj.mute !== undefined || userStateObj.deaf !== undefined || 
          userStateObj.suppress !== undefined || userStateObj.priority_speaker !== undefined) {
        
        // 权限检查：操作其他用户需要MuteDeafenPermission
        if (!isActorTarget && this._permissionChecker && targetGlobalSession.channel_id !== undefined) {
          const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
          const hasMuteDeafen = await this._permissionChecker.hasPermission(
            targetGlobalSession.channel_id,
            actorUserInfo,
            Permission.MuteDeafen
          );
          if (!hasMuteDeafen) {
            this.notify(edge_id, 'hub.userStateResponse', {
              success: false,
              actor_session,
              error: 'Permission denied: MuteDeafenPermission required',
              permission_denied: true,
              permission_type: 'MuteDeafen',
            });
            return;
          }
          logger.debug(`User ${actor_username} has MuteDeafenPermission for user ${targetGlobalSession.username}`);
        }

        // Suppress只能由服务器设置（拒绝客户端设置为true）
        if (userStateObj.suppress === true) {
          this.notify(edge_id, 'hub.userStateResponse', {
            success: false,
            actor_session,
            error: 'Permission denied: only server can suppress users',
            permission_denied: true,
            permission_type: 'suppress',
          });
          return;
        }

        const stateUpdates: any = {};

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

        this._sessionManager.updateSessionState(targetSession, stateUpdates);
        broadcast = true;
      }

      // 处理Recording状态变化
      if (userStateObj.recording !== undefined) {
        this._sessionManager.updateSessionState(targetSession, { recording: userStateObj.recording });
        broadcastUserState.recording = userStateObj.recording;
        broadcast = true;
        
        const recordingMessage = userStateObj.recording
          ? `User '${targetGlobalSession.username}' started recording`
          : `User '${targetGlobalSession.username}' stopped recording`;
        logger.info(recordingMessage);
      }

      // 处理监听频道（listening_channel_add/remove）
      if (userStateObj.listening_channel_add && userStateObj.listening_channel_add.length > 0) {
        // 权限检查：需要对每个频道有Listen权限
        if (this._permissionChecker) {
          const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
          const allowedChannels: number[] = [];
          
          for (const channelId of userStateObj.listening_channel_add) {
            const hasListen = await this._permissionChecker.hasPermission(
              channelId,
              actorUserInfo,
              Permission.Listen
            );
            
            if (hasListen) {
              allowedChannels.push(channelId);
            } else {
              logger.warn(`User ${actor_username} denied Listen permission for channel ${channelId}`);
              // 发送权限被拒绝的消息给客户端
              this.notify(edge_id, 'hub.permissionDenied', {
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
            logger.info(`User ${actor_username} started listening to channels: ${allowedChannels.join(', ')}`);
          }
        } else {
          // 没有权限检查器，允许所有请求
          broadcastUserState.listening_channel_add = userStateObj.listening_channel_add;
          broadcast = true;
          logger.info(`User ${actor_username} started listening to channels: ${userStateObj.listening_channel_add.join(', ')}`);
        }
      }

      if (userStateObj.listening_channel_remove && userStateObj.listening_channel_remove.length > 0) {
        // 移除监听不需要权限检查
        broadcastUserState.listening_channel_remove = userStateObj.listening_channel_remove;
        broadcast = true;
        logger.info(`User ${actor_username} stopped listening to channels: ${userStateObj.listening_channel_remove.join(', ')}`);
      }

      if (!broadcast) {
        // 没有任何变化，但仍然回复成功
        this.notify(edge_id, 'hub.userStateResponse', {
          success: true,
          actor_session,
          target_session: targetSession,
        });
        return;
      }

      // 向发起Edge回复成功
      this.notify(edge_id, 'hub.userStateResponse', {
        success: true,
        actor_session,
        target_session: targetSession,
      });

      logger.info(`Hub: Broadcasting UserState for session ${targetSession} to all edges, fields: ${Object.keys(broadcastUserState).join(', ')}`);
      
      // 广播UserState给所有Edge（只包含实际变更的字段）
      this.broadcast('hub.userStateBroadcast', {
        session_id: targetSession,
        edge_id: targetGlobalSession.edge_id,
        userState: broadcastUserState,
      });

      logger.info(`Hub: Broadcasted UserState for session ${targetSession} to all edges`);
    } catch (error) {
      logger.error('Error handling UserState notification:', error);
    }
  }

  /**
   * 处理用户离开通知
   */
  private handleUserLeftNotification(params: any): void {
    try {
      const { session_id, edge_id } = params;
      
      // 从会话管理器移除
      const removedSession = this._sessionManager.removeSession(session_id);
      
      if (removedSession) {
        // 广播用户离开给所有Edge（包括发起者）
        this.broadcast('hub.userLeft', {
          session_id,
          edge_id,
          user_id: removedSession.user_id,
          username: removedSession.username,
        });

        logger.info(`User ${removedSession.username} (session ${session_id}) left, broadcasted to all edges`);
      }
    } catch (error) {
      logger.error('Error handling user left notification:', error);
    }
  }

  /**
   * 处理ChannelState通知 - 执行完整的业务逻辑并广播
   * 参照Edge独立模式的handleChannelStateLocal_DEPRECATED实现
   */
  private async handleChannelStateNotification(params: any): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, channelState: channelStateObj } = params;

      logger.info(`Hub received ChannelState from Edge ${edge_id}, actor: ${actor_username}(${actor_session})`);

      // 获取actor会话
      const actorSession = this._sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.notify(edge_id, 'hub.channelStateResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      const isCreate = !channelStateObj.channel_id || channelStateObj.channel_id === 0;
      
      let channel_id: number;
      
      if (isCreate) {
        // === 创建频道 ===
        if (!channelStateObj.name || channelStateObj.name.trim().length === 0) {
          this.notify(edge_id, 'hub.channelStateResponse', {
            success: false,
            actor_session,
            error: 'Channel name required',
            permission_denied: false,
          });
          return;
        }

        const parent_id = channelStateObj.parent !== undefined ? channelStateObj.parent : 0;
        
        // 检查父频道是否存在
        if (parent_id > 0 && this._database) {
          const parentChannel = await this._database.getChannel(parent_id);
          if (!parentChannel) {
            this.notify(edge_id, 'hub.channelStateResponse', {
              success: false,
              actor_session,
              error: 'Parent channel not found',
            });
            return;
          }
        }

        // 检查MakeChannel权限
        if (this._permissionChecker) {
          const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
          const hasMakeChannel = await this._permissionChecker.hasPermission(
            parent_id,
            actorUserInfo,
            Permission.MakeChannel
          );
          if (!hasMakeChannel) {
            this.notify(edge_id, 'hub.channelStateResponse', {
              success: false,
              actor_session,
              error: 'Permission denied: MakeChannelPermission required',
              permission_denied: true,
              permission_type: 'MakeChannel',
            });
            return;
          }
        }

        // 检查同级频道名称是否重复
        if (this._permissionChecker) {
          const hasDuplicate = await this._permissionChecker.hasDuplicateSiblingName(
            parent_id,
            channelStateObj.name
          );
          if (hasDuplicate) {
            this.notify(edge_id, 'hub.channelStateResponse', {
              success: false,
              actor_session,
              error: 'Channel name already exists in parent',
              permission_denied: false,
            });
            return;
          }
        }

        // 创建频道
        channel_id = await this._database.createChannel({
          name: channelStateObj.name,
          parent_id: parent_id,
          position: channelStateObj.position || 0,
          max_users: channelStateObj.max_users || 0,
          inherit_acl: true,
          description_blob: channelStateObj.description || '',
        });

        // 更新channelState对象的channel_id（用于广播）
        channelStateObj.channel_id = channel_id;
        
        // TODO: 为创建者自动添加Write权限的ACL（如果创建者没有Write权限）
        
        logger.info(`Channel "${channelStateObj.name}" created with ID ${channel_id} by ${actor_username}`);
      } else {
        // === 编辑频道 ===
        channel_id = channelStateObj.channel_id;
        
        // 检查频道是否存在
        const channel = await this._database.getChannel(channel_id);
        if (!channel) {
          this.notify(edge_id, 'hub.channelStateResponse', {
            success: false,
            actor_session,
            error: 'Channel not found',
          });
          return;
        }

        // 检查Write权限
        if (this._permissionChecker) {
          const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
          const hasWrite = await this._permissionChecker.hasPermission(
            channel_id,
            actorUserInfo,
            Permission.Write
          );
          if (!hasWrite) {
            this.notify(edge_id, 'hub.channelStateResponse', {
              success: false,
              actor_session,
              error: 'Permission denied: WritePermission required',
              permission_denied: true,
              permission_type: 'Write',
            });
            return;
          }
        }
        
        const updates: any = {};
        const changes: string[] = [];
        
        // 名称修改
        if (channelStateObj.name !== undefined) {
          // 检查同级频道名称是否重复
          if (this._permissionChecker) {
            const hasDuplicate = await this._permissionChecker.hasDuplicateSiblingName(
              channel.parent_id,
              channelStateObj.name,
              channel_id
            );
            if (hasDuplicate) {
              this.notify(edge_id, 'hub.channelStateResponse', {
                success: false,
                actor_session,
                error: 'Channel name already exists in parent',
              });
              return;
            }
          }
          
          updates.name = channelStateObj.name;
          changes.push(`name: ${channelStateObj.name}`);
        }
        
        // 位置修改
        if (channelStateObj.position !== undefined) {
          const newPosition = typeof channelStateObj.position === 'number' && !isNaN(channelStateObj.position) 
            ? channelStateObj.position : 0;
          updates.position = newPosition;
          changes.push(`position: ${newPosition}`);
        }
        
        // 最大用户数修改
        if (channelStateObj.max_users !== undefined) {
          const newMaxUsers = typeof channelStateObj.max_users === 'number' && !isNaN(channelStateObj.max_users) 
            ? channelStateObj.max_users : 0;
          updates.max_users = newMaxUsers;
          changes.push(`max_users: ${newMaxUsers}`);
        }
        
        // 父频道移动
        if (channelStateObj.parent !== undefined) {
          const newParentId = typeof channelStateObj.parent === 'number' && !isNaN(channelStateObj.parent) 
            ? channelStateObj.parent : 0;
            
          // 检查新父频道是否存在
          if (newParentId > 0) {
            const newParent = await this._database.getChannel(newParentId);
            if (!newParent) {
              this.notify(edge_id, 'hub.channelStateResponse', {
                success: false,
                actor_session,
                error: 'New parent channel not found',
              });
              return;
            }
          }

          // 检查循环引用
          if (this._permissionChecker) {
            const hasCircular = await this._permissionChecker.hasCircularReference(
              channel_id,
              newParentId
            );
            if (hasCircular) {
              this.notify(edge_id, 'hub.channelStateResponse', {
                success: false,
                actor_session,
                error: 'Circular reference detected',
              });
              return;
            }
          }

          // 检查新父频道的MakeChannel权限
          if (this._permissionChecker) {
            const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
            const hasMakeChannel = await this._permissionChecker.hasPermission(
              newParentId,
              actorUserInfo,
              Permission.MakeChannel
            );
            if (!hasMakeChannel) {
              this.notify(edge_id, 'hub.channelStateResponse', {
                success: false,
                actor_session,
                error: 'Permission denied: MakeChannelPermission required in new parent',
                permission_denied: true,
                permission_type: 'MakeChannel',
              });
              return;
            }
          }

          // 检查同级名称重复
          if (this._permissionChecker) {
            const hasDuplicate = await this._permissionChecker.hasDuplicateSiblingName(
              newParentId,
              channel.name,
              channel_id
            );
            if (hasDuplicate) {
              this.notify(edge_id, 'hub.channelStateResponse', {
                success: false,
                actor_session,
                error: 'Channel name already exists in new parent',
              });
              return;
            }
          }

          updates.parent_id = newParentId;
          changes.push(`parent: ${newParentId}`);
        }
        
        // 描述修改
        if (channelStateObj.description !== undefined) {
          updates.description_blob = channelStateObj.description;
          changes.push('description');
        }
        
        if (Object.keys(updates).length > 0) {
          await this._database.updateChannel(channel_id, updates);
          logger.info(`Channel ${channel_id} updated by ${actor_username}: ${changes.join(', ')}`);
          
          // 清除权限缓存
          if (this._permissionChecker && updates.parent_id !== undefined) {
            this._permissionChecker.clearCacheForChannel(channel_id);
          }
        }
        
        // 处理频道链接 (links_add, links_remove)
        const affectedChannels = new Set<number>();
        
        if (channelStateObj.links_add && Array.isArray(channelStateObj.links_add) && channelStateObj.links_add.length > 0) {
          for (const linkChannelId of channelStateObj.links_add) {
            // 检查链接目标频道是否存在
            const linkChannel = await this._database.getChannel(linkChannelId);
            if (!linkChannel) {
              logger.warn(`Link target channel ${linkChannelId} not found, skipping`);
              continue;
            }

            // 检查LinkChannel权限
            if (this._permissionChecker) {
              const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
              
              // 需要在两个频道都有LinkChannel权限
              const hasLinkInSource = await this._permissionChecker.hasPermission(
                channel_id,
                actorUserInfo,
                Permission.LinkChannel
              );
              const hasLinkInTarget = await this._permissionChecker.hasPermission(
                linkChannelId,
                actorUserInfo,
                Permission.LinkChannel
              );

              if (!hasLinkInSource || !hasLinkInTarget) {
                this.notify(edge_id, 'hub.channelStateResponse', {
                  success: false,
                  actor_session,
                  error: `Permission denied: LinkChannelPermission required in both channels`,
                  permission_denied: true,
                  permission_type: 'LinkChannel',
                });
                return;
              }
            }

            // 添加双向链接
            await this._database.linkChannels(channel_id, linkChannelId);
            await this._database.linkChannels(linkChannelId, channel_id);
            
            affectedChannels.add(linkChannelId);
            logger.info(`Channel ${channel_id} linked to ${linkChannelId} by ${actor_username}`);
          }
        }

        if (channelStateObj.links_remove && Array.isArray(channelStateObj.links_remove) && channelStateObj.links_remove.length > 0) {
          for (const unlinkChannelId of channelStateObj.links_remove) {
            // 检查LinkChannel权限（移除链接也需要权限）
            if (this._permissionChecker) {
              const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
              
              const hasLinkInSource = await this._permissionChecker.hasPermission(
                channel_id,
                actorUserInfo,
                Permission.LinkChannel
              );

              if (!hasLinkInSource) {
                this.notify(edge_id, 'hub.channelStateResponse', {
                  success: false,
                  actor_session,
                  error: `Permission denied: LinkChannelPermission required to unlink`,
                  permission_denied: true,
                  permission_type: 'LinkChannel',
                });
                return;
              }
            }

            // 移除双向链接
            await this._database.unlinkChannels(channel_id, unlinkChannelId);
            await this._database.unlinkChannels(unlinkChannelId, channel_id);
            
            affectedChannels.add(unlinkChannelId);
            logger.info(`Channel ${channel_id} unlinked from ${unlinkChannelId} by ${actor_username}`);
          }
        }

        // 更新channelState对象的links字段（用于广播）
        if (this._database) {
          channelStateObj.links = await this._database.getChannelLinks(channel_id);
        }

        // 广播受影响频道的状态更新
        for (const affectedChannelId of affectedChannels) {
          const affectedChannel = await this._database.getChannel(affectedChannelId);
          if (affectedChannel) {
            const affectedLinks = await this._database.getChannelLinks(affectedChannelId);
            this.broadcast('hub.channelStateBroadcast', {
              channelState: {
                channel_id: affectedChannelId,
                links: affectedLinks,
              },
            });
            logger.debug(`Broadcasted link update for affected channel ${affectedChannelId}`);
          }
        }
      }

      // 向发起Edge回复成功
      this.notify(edge_id, 'hub.channelStateResponse', {
        success: true,
        actor_session,
        channel_id,
      });

      // 广播ChannelState给所有Edge
      this.broadcast('hub.channelStateBroadcast', {
        channelState: channelStateObj,
      });

      logger.debug(`Broadcasted ChannelState for channel ${channel_id} to all edges`);
    } catch (error) {
      logger.error('Error handling ChannelState notification:', error);
    }
  }

  /**
   * 处理UserRemove（Kick/Ban）通知
   */
  private async handleUserRemoveNotification(params: any): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, target_session, reason, ban } = params;

      logger.info(`Hub received UserRemove from Edge ${edge_id}, actor: ${actor_username}(${actor_session}), target: ${target_session}, ban: ${ban}`);

      // 获取目标会话
      const targetSession = this._sessionManager.getSession(target_session);
      if (!targetSession) {
        this.notify(edge_id, 'hub.userRemoveResponse', {
          success: false,
          actor_session,
          error: 'Target session not found',
        });
        return;
      }

      // 获取actor会话
      const actorSession = this._sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.notify(edge_id, 'hub.userRemoveResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      // 权限检查：Kick需要root频道的Kick权限，Ban需要Ban权限
      if (this._permissionChecker) {
        const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
        const requiredPermission = ban ? Permission.Ban : Permission.Kick;
        
        // Kick/Ban权限只在root频道检查
        const hasPermission = await this._permissionChecker.hasPermission(
          0, // root channel
          actorUserInfo,
          requiredPermission
        );
        
        if (!hasPermission) {
          this.notify(edge_id, 'hub.userRemoveResponse', {
            success: false,
            actor_session,
            error: `Permission denied: ${ban ? 'Ban' : 'Kick'}Permission required`,
            permission_denied: true,
            permission_type: ban ? 'Ban' : 'Kick',
          });
          return;
        }
      }

      // 如果是ban，记录到数据库
      if (ban && this._database) {
        // 将IP地址转换为Buffer
        // 简化处理：使用IP字符串的hash作为标识
        const ipBuffer = Buffer.from(targetSession.ip_address || '0.0.0.0');
        
        // 添加ban记录
        await this._database.addBan({
          address: ipBuffer,
          mask: 32, // 精确匹配单个IP
          hash: targetSession.cert_hash,
          reason: reason || 'No reason provided',
          start: Math.floor(Date.now() / 1000), // Unix timestamp in seconds
          duration: 0, // 0表示永久ban
        });
        logger.info(`User ${targetSession.username} (session ${target_session}) banned by ${actor_username}, reason: ${reason}`);
      } else {
        logger.info(`User ${targetSession.username} (session ${target_session}) kicked by ${actor_username}, reason: ${reason}`);
      }

      // 向发起Edge回复成功
      this.notify(edge_id, 'hub.userRemoveResponse', {
        success: true,
        actor_session,
        target_session,
        ban,
      });

      // 广播UserRemove给所有Edge
      this.broadcast('hub.userRemoveBroadcast', {
        actor_session,
        target_session,
        target_edge_id: targetSession.edge_id,
        reason,
        ban,
      });

      // 从会话管理器移除目标会话
      this._sessionManager.removeSession(target_session);

      logger.debug(`Broadcasted UserRemove for session ${target_session} to all edges`);
    } catch (error) {
      logger.error('Error handling UserRemove notification:', error);
    }
  }

  /**
   * 处理ChannelRemove（频道删除）通知
   */
  private async handleChannelRemoveNotification(params: any): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, channel_id } = params;

      logger.info(`Hub received ChannelRemove from Edge ${edge_id}, actor: ${actor_username}(${actor_session}), channel: ${channel_id}`);

      if (!this._database) {
        this.notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: 'Database not available',
        });
        return;
      }

      // 获取actor会话
      const actorSession = this._sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      // 获取频道
      const channel = await this._database.getChannel(channel_id);
      if (!channel) {
        this.notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: 'Channel not found',
        });
        return;
      }

      // 不能删除根频道
      if (channel_id === 0) {
        this.notify(edge_id, 'hub.channelRemoveResponse', {
          success: false,
          actor_session,
          error: 'Cannot remove root channel',
        });
        return;
      }

      // 权限检查：需要Write权限
      if (this._permissionChecker) {
        const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
        const hasWrite = await this._permissionChecker.hasPermission(
          channel_id,
          actorUserInfo,
          Permission.Write
        );
        if (!hasWrite) {
          this.notify(edge_id, 'hub.channelRemoveResponse', {
            success: false,
            actor_session,
            error: 'Permission denied: WritePermission required',
            permission_denied: true,
            permission_type: 'Write',
          });
          return;
        }
      }

      // 收集所有需要删除的频道（包括子频道）
      const channelsToRemove: number[] = [];
      const collectChannels = async (cid: number) => {
        channelsToRemove.push(cid);
        const children = await this._database!.getChildChannels(cid);
        for (const child of children) {
          await collectChannels(child.id);
        }
      };
      await collectChannels(channel_id);

      // 移动频道中的所有用户到父频道
      const parent_id = channel.parent_id;
      const affectedSessions: number[] = [];
      
      for (const session of this._sessionManager.getAllSessions()) {
        if (channelsToRemove.includes(session.channel_id || 0)) {
          this._sessionManager.updateSessionChannel(session.session_id, parent_id);
          affectedSessions.push(session.session_id);
        }
      }

      // 删除频道（递归删除）
      for (const cid of channelsToRemove) {
        await this._database.deleteChannel(cid);
        // 清除权限缓存
        if (this._permissionChecker) {
          this._permissionChecker.clearCacheForChannel(cid);
        }
      }

      logger.info(`User ${actor_username} removed channel "${channel.name}" (${channel_id}) and ${channelsToRemove.length - 1} sub-channels`);

      // 向发起Edge回复成功
      this.notify(edge_id, 'hub.channelRemoveResponse', {
        success: true,
        actor_session,
        channel_id,
      });

      // 广播ChannelRemove和受影响用户的UserState给所有Edge
      this.broadcast('hub.channelRemoveBroadcast', {
        channel_id,
        channels_removed: channelsToRemove,
        affected_sessions: affectedSessions,
        parent_id,
      });

      logger.debug(`Broadcasted ChannelRemove for channel ${channel_id} to all edges`);
    } catch (error) {
      logger.error('Error handling ChannelRemove notification:', error);
    }
  }

  /**
   * 处理TextMessage通知 - 执行权限检查、目标解析并广播
   */
  private async handleTextMessageNotification(params: any): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, actor_channel_id, textMessage } = params;

      logger.info(`Hub received TextMessage from Edge ${edge_id}, actor: ${actor_username}(${actor_session})`);

      // 获取actor会话
      const actorSession = this._sessionManager.getSession(actor_session);
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
          const session = this._sessionManager.getSession(targetSession);
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
          if (this._permissionChecker && this._database) {
            const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actor_channel_id);
            const hasPermission = await this._permissionChecker.hasPermission(
              channel_id,
              actorUserInfo,
              Permission.TextMessage
            );
            
            if (!hasPermission) {
              logger.warn(`Actor ${actor_username} denied TextMessage permission for channel ${channel_id}`);
              // 发送权限拒绝通知给发起Edge
              this.notify(edge_id, 'hub.textMessageDenied', {
                actor_session,
                channel_id,
                reason: 'TextMessage permission denied',
              });
              continue;
            }
          }

          // 获取频道中的所有用户
          const channelSessions = this._sessionManager.getChannelSessions(channel_id);
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
          if (this._permissionChecker && this._database) {
            const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorSession, actor_channel_id);
            const hasPermission = await this._permissionChecker.hasPermission(
              rootChannelId,
              actorUserInfo,
              Permission.TextMessage
            );
            
            if (!hasPermission) {
              logger.warn(`Actor ${actor_username} denied TextMessage permission for channel tree ${rootChannelId}`);
              this.notify(edge_id, 'hub.textMessageDenied', {
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
            if (this._database) {
              const channel = await this._database.getChannel(channel_id);
              if (channel) {
                const children = await this._database.getChildChannels(channel_id);
                for (const child of children) {
                  await collectChannels(child.id);
                }
              }
            }
          };
          await collectChannels(rootChannelId);

          // 获取这些频道中的所有用户
          for (const channelId of channelsInTree) {
            const channelSessions = this._sessionManager.getChannelSessions(channelId);
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
        this.notify(target_edge_id, 'hub.textMessageBroadcast', {
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

  private registerHandlers(): void {
    // 注册所有类型安全的处理器
    this.typedServer.handle('edge.register', async (channel, params) => {
      return this.handleEdgeRegister(channel, params);
    });

    this.typedServer.handle('edge.heartbeat', async (channel, params) => {
      return this.handleEdgeHeartbeat(channel, params);
    });

    this.typedServer.handle('edge.allocateSessionId', async (channel, params) => {
      return this.handleAllocateSessionId(channel, params);
    });

    this.typedServer.handle('edge.reportSession', async (channel, params) => {
      return this.handleReportSession(channel, params);
    });

    this.typedServer.handle('edge.syncVoiceTarget', async (channel, params) => {
      return this.handleSyncVoiceTarget(channel, params);
    });

    this.typedServer.handle('edge.getVoiceTargets', async (channel, params) => {
      return this.handleGetVoiceTargets(channel, params);
    });

    this.typedServer.handle('edge.routeVoice', async (channel, params) => {
      return this.handleRouteVoice(channel, params);
    });

    this.typedServer.handle('edge.adminOperation', async (channel, params) => {
      return this.handleAdminOperation(channel, params);
    });

    this.typedServer.handle('edge.exchangeCertificates', async (channel, params) => {
      return this.handleExchangeCertificates(channel, params);
    });

    this.typedServer.handle('edge.fullSync', async (channel, params) => {
      return this.handleFullSync(channel, params);
    });

    this.typedServer.handle('edge.getChannels', async (channel, params) => {
      return this.handleGetChannels(channel, params);
    });

    this.typedServer.handle('edge.getACLs', async (channel, params) => {
      return this.handleGetACLs(channel, params);
    });

    this.typedServer.handle('edge.saveChannel', async (channel, params) => {
      return this.handleSaveChannel(channel, params);
    });

    this.typedServer.handle('edge.saveACL', async (channel, params) => {
      return this.handleSaveACL(channel, params);
    });

    this.typedServer.handle('edge.handleACL', async (channel, params) => {
      return this.handleACLRequest(channel, params);
    });

    this.typedServer.handle('edge.join', async (channel, params) => {
      return this.handleEdgeJoin(channel, params);
    });

    this.typedServer.handle('edge.joinComplete', async (channel, params) => {
      return this.handleEdgeJoinComplete(channel, params);
    });

    this.typedServer.handle('edge.reportPeerDisconnect', async (channel, params) => {
      return this.handleEdgeReportPeerDisconnect(channel, params);
    });

    this.typedServer.handle('cluster.getStatus', async (channel, params) => {
      return this.handleGetClusterStatus(channel, params);
    });

    // Blob 存储相关处理器
    this.typedServer.handle('blob.put', async (channel, params) => {
      return this.handleBlobPut(channel, params);
    });

    this.typedServer.handle('blob.get', async (channel, params) => {
      return this.handleBlobGet(channel, params);
    });

    this.typedServer.handle('blob.getUserTexture', async (channel, params) => {
      return this.handleGetUserTexture(channel, params);
    });

    this.typedServer.handle('blob.getUserComment', async (channel, params) => {
      return this.handleGetUserComment(channel, params);
    });

    this.typedServer.handle('blob.setUserTexture', async (channel, params) => {
      return this.handleSetUserTexture(channel, params);
    });

    this.typedServer.handle('blob.setUserComment', async (channel, params) => {
      return this.handleSetUserComment(channel, params);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleEdgeRegister(
    _channel: RPCChannel,
    params: RPCParams<'edge.register'>
  ): Promise<RPCResult<'edge.register'>> {
    // 调用注册服务
    const result = await this._registry.register(params);

    if (result.success) {
      // 将Edge与RPCChannel关联
      this.edgeChannels.set(params.server_id, _channel);
      logger.info(`Edge ${params.server_id} registered successfully`);
    }

    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleEdgeHeartbeat(
    _channel: RPCChannel,
    params: RPCParams<'edge.heartbeat'>
  ): Promise<RPCResult<'edge.heartbeat'>> {
    // 调用心跳服务
    const result = await this._registry.heartbeat(params);
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleAllocateSessionId(
    _channel: RPCChannel,
    params: RPCParams<'edge.allocateSessionId'>
  ): Promise<RPCResult<'edge.allocateSessionId'>> {
    const session_id = this._sessionManager.allocateSessionId();
    logger.debug(`Allocated session ID ${session_id} for Edge ${params.edge_id}`);
    return { session_id };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleReportSession(
    _channel: RPCChannel,
    params: RPCParams<'edge.reportSession'>
  ): Promise<RPCResult<'edge.reportSession'>> {
    // 将RPC参数转换为GlobalSession对象
    const session: GlobalSession = {
      session_id: params.session_id,
      edge_id: params.edge_server_id,
      user_id: params.user_id,
      username: params.username,
      ip_address: params.ip_address,
      cert_hash: params.cert_hash || '',
      is_authenticated: true,
      channel_id: params.channel_id,
      connected_at: Math.floor(params.startTime.getTime() / 1000),
      last_active: Math.floor(Date.now() / 1000),
      groups: params.groups || [], // 传递用户组信息
    };

    // 上报会话
    this._sessionManager.reportSession(session);
    
    // 广播新用户加入通知到所有Edge（包括发起者）
    // Edge通过edge_id判断是否需要过滤（不要处理来自自己Edge的用户）
    this.broadcast('hub.userJoined', {
      session_id: params.session_id,
      edge_id: params.edge_server_id,
      user_id: params.user_id,
      username: params.username,
      channel_id: params.channel_id,
      cert_hash: session.cert_hash,
    });
    
    logger.info(`Session ${params.session_id} reported from Edge ${params.edge_server_id}, broadcasted to all edges`);
    
    return { success: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleSyncVoiceTarget(
    _channel: RPCChannel,
    params: RPCParams<'edge.syncVoiceTarget'>
  ): Promise<RPCResult<'edge.syncVoiceTarget'>> {
    // 同步语音目标配置
    this._voiceTargetSync.syncVoiceTarget(params);
    return { success: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleGetVoiceTargets(
    _channel: RPCChannel,
    params: RPCParams<'edge.getVoiceTargets'>
  ): Promise<RPCResult<'edge.getVoiceTargets'>> {
    let configs;
    if (params.edge_id !== undefined) {
      // 获取特定Edge的配置
      configs = this._voiceTargetSync.getEdgeConfigs(params.edge_id);
    } else {
      // 获取所有配置
      configs = this._voiceTargetSync.getAllConfigs();
    }

    return { voiceTargets: configs };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleRouteVoice(
    _channel: RPCChannel,
    params: RPCParams<'edge.routeVoice'>
  ): Promise<RPCResult<'edge.routeVoice'>> {
    // 获取语音目标配置
    const sessionConfigs = this._voiceTargetSync.getSessionConfigs(params.fromEdgeId, params.fromSessionId);
    const targetConfig = sessionConfigs.get(params.target_id);

    if (!targetConfig) {
      throw new Error('Voice target not found');
    }

    // 路由语音数据到目标会话
    const routingResults: Array<{  session_id: number;  edge_id: number }> = [];

    // 处理会话目标
    for (const session_id of targetConfig.sessions) {
      const session = this._sessionManager.getSession(session_id);
      if (session) {
        // 发送到目标Edge
        this.notify(session.edge_id, 'voice.data', {
          fromSessionId: params.fromSessionId,
          targetSessionId: session_id,
          voiceData: params.voiceData,
          timestamp: params.timestamp,
        });
        routingResults.push({ session_id,  edge_id: session.edge_id });
      }
    }

    // 处理频道目标
    for (const channelTarget of targetConfig.channels) {
      const channelSessions = this._voiceTargetSync.getChannelSessions(channelTarget.channel_id);
      for (const session of channelSessions) {
        if (session.session_id !== params.fromSessionId) { // 不发送给自己
          this.notify(session.edge_id, 'voice.data', {
            fromSessionId: params.fromSessionId,
            targetSessionId: session.session_id,
            voiceData: params.voiceData,
            timestamp: params.timestamp,
          });
          routingResults.push({  session_id: session.session_id,  edge_id: session.edge_id });
        }
      }
    }

    return { success: true, routedTo: routingResults };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleAdminOperation(
    _channel: RPCChannel,
    params: RPCParams<'edge.adminOperation'>
  ): Promise<RPCResult<'edge.adminOperation'>> {
    // 简单的管理操作处理
    switch (params.operation) {
      case 'cleanup': {
        // 清理过期数据
        this._sessionManager.cleanup();
        this._certExchange.cleanupExpiredCertificates();
        if (this._database) {
          await this._database.cleanup();
        }
        return { success: true, message: 'Cleanup completed' };
      }

      case 'getStats': {
        // 获取统计信息
        const stats = {
          edges: this._registry.getEdgeCount(),
          sessions: this._sessionManager.getTotalSessionCount(),
          voiceTargets: this._voiceTargetSync.getTargetCount(),
          channels: 0, // TODO: 从数据库获取
        };
        return { success: true, stats };
      }

      default:
        throw new Error('Unknown admin operation');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleExchangeCertificates(
    _channel: RPCChannel,
    params: RPCParams<'edge.exchangeCertificates'>
  ): Promise<RPCResult<'edge.exchangeCertificates'>> {
    // 注册证书
    await this._certExchange.registerCertificate(params.server_id, params.certificate);
    return { success: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleFullSync(
    _channel: RPCChannel,
    _params: RPCParams<'edge.fullSync'>
  ): Promise<RPCResult<'edge.fullSync'>> {
    // 获取所有频道
    const dbChannels = await this._database.getAllChannels();

    // 映射数据库字段到protocol字段
    const channels: ChannelData[] = dbChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      parent_id: ch.parent_id,
      position: ch.position,
      max_users: ch.max_users,
      inherit_acl: ch.inherit_acl,
      description: ch.description_blob,
      temporary: false, // 从数据库加载的频道都不是临时频道
      links: [], // TODO: 从数据库获取链接信息
    }));

    // 获取所有会话（从内存中的 sessionManager 获取当前活跃会话）
    // 注意：会话不再持久化，这里返回的是当前运行时的活跃会话
    const sessions: GlobalSession[] = this._sessionManager.getAllSessions();

    // 获取所有Edge
    const dbEdges = await this._database.getActiveEdges();
    const edges = dbEdges.map((edge) => ({
      server_id: edge.server_id,
      name: edge.name,
      host: edge.host,
      port: edge.port,
      region: edge.region,
      current_load: edge.current_load,
      capacity: edge.capacity,
    }));

    // 获取所有ACL
    const dbAcls = await this._database.getChannelACLs(0); // 0表示获取所有频道的ACL
    const acls: ACLData[] = dbAcls.map((acl) => ({
      id: acl.id,
      channel_id: acl.channel_id,
      user_id: acl.user_id,
      group: acl.group,
      apply_here: acl.apply_here,
      apply_subs: acl.apply_subs,
      allow: acl.allow,
      deny: acl.deny,
    }));

    return {
      channels,
      channelLinks: [], // TODO: 实现频道链接
      acls,
      bans: [], // TODO: 实现封禁数据
      sessions,
      configs: {}, // TODO: 实现配置数据
      timestamp: Date.now(),
      sequence: 0,
      edges,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleGetChannels(
    _channel: RPCChannel,
    _params: RPCParams<'edge.getChannels'>
  ): Promise<RPCResult<'edge.getChannels'>> {
    const dbChannels = await this._database.getAllChannels();

    // 映射数据库字段到protocol字段
    const channels: ChannelData[] = dbChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      parent_id: ch.parent_id,
      position: ch.position,
      max_users: ch.max_users,
      inherit_acl: ch.inherit_acl,
      description: ch.description_blob,
      temporary: false, // 从数据库加载的频道都不是临时频道
      links: [], // TODO: 从数据库获取链接信息
    }));

    return { success: true, channels };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleGetACLs(
    _channel: RPCChannel,
    params: RPCParams<'edge.getACLs'>
  ): Promise<RPCResult<'edge.getACLs'>> {
    const dbAcls = await this._database.getChannelACLs(params.channel_id);
    const acls: ACLData[] = dbAcls.map((acl) => ({
      id: acl.id,
      channel_id: acl.channel_id,
      user_id: acl.user_id,
      group: acl.group,
      apply_here: acl.apply_here,
      apply_subs: acl.apply_subs,
      allow: acl.allow,
      deny: acl.deny,
    }));
    return { success: true, acls };
  }


  /**
   * 处理来自 Edge 的 ACL 请求（查询或更新）
   * Edge 作为中转，真正的权限检查和业务逻辑在 Hub 进行
   */
  private async handleACLRequest(
    _channel: RPCChannel,
    params: RPCParams<'edge.handleACL'>
  ): Promise<RPCResult<'edge.handleACL'>> {
    try {
      const { edge_id, actor_session, channel_id, query, raw_data } = params;
      
      logger.info(`Hub received ACL request from Edge ${edge_id}, actor: ${actor_session}, channel: ${channel_id}, query: ${query}`);

      if (!this._database) {
        logger.error('Database not available');
        return { success: false, error: 'Database not available' };
      }

      // 解码 ACL 消息
      const aclData = Buffer.from(raw_data, 'base64');
      const acl = mumbleproto.ACL.deserialize(aclData);

      // 获取频道信息
      const channel = await this._database.getChannel(channel_id);
      if (!channel) {
        logger.warn(`ACL for non-existent channel: ${channel_id}`);
        return { success: false, error: 'Channel not found' };
      }

      // 权限检查：需要 Write 权限（查询和修改都需要）
      // 允许三种情况（与Go实现一致）：
      // 1. 用户在目标频道有 Write 权限
      // 2. 用户在父频道有 Write 权限（如果父频道存在）
      // 3. 用户在根频道(ID=0)有 Write 权限（Murmur的管理员绕过机制）
      if (this._permissionChecker && this._sessionManager) {
        const actorGlobalSession = this._sessionManager.getSession(actor_session);
        if (!actorGlobalSession) {
          logger.warn(`ACL request from unknown session: ${actor_session}`);
          return { success: false, error: 'Session not found' };
        }

        const actorUserInfo = HubPermissionChecker.sessionToUserInfo(actorGlobalSession, actorGlobalSession.channel_id);
        
        // 检查三个位置的 Write 权限
        const hasWriteOnChannel = await this._permissionChecker.hasPermission(
          channel_id,
          actorUserInfo,
          Permission.Write
        );
        
        let hasWriteOnParent = false;
        if (channel.parent_id > 0) {
          hasWriteOnParent = await this._permissionChecker.hasPermission(
            channel.parent_id,
            actorUserInfo,
            Permission.Write
          );
        }
        
        const hasWriteOnRoot = await this._permissionChecker.hasPermission(
          0,
          actorUserInfo,
          Permission.Write
        );
        
        const hasWritePermission = hasWriteOnChannel || hasWriteOnParent || hasWriteOnRoot;
        
        if (!hasWritePermission) {
          logger.warn(`ACL request denied for session ${actor_session}: no Write permission on channel ${channel.name}`);
          return { 
            success: false, 
            error: 'Permission denied: Write permission required',
            permission_denied: true 
          };
        }
        
        logger.debug(`ACL request permission granted for session ${actor_session}`);
      }

      if (query) {
        // === 查询 ACL ===
        logger.debug(`Processing ACL query for channel ${channel_id}`);
        
        // 构建频道链：从当前频道向上遍历到根频道或不继承ACL的频道
        const channelsInChain: Array<{ id: number; inherit_acl: boolean; parent_id: number }> = [];
        let currentChannelId: number | null = channel_id;
        
        while (currentChannelId !== null && currentChannelId >= 0) {
          const ch = await this._database.getChannel(currentChannelId);
          if (!ch) break;
          
          channelsInChain.unshift({ id: ch.id, inherit_acl: ch.inherit_acl, parent_id: ch.parent_id });
          
          // 如果是当前频道或者继承ACL，且有父频道，继续向上
          if ((ch.id === channel_id || ch.inherit_acl) && ch.parent_id > 0) {
            currentChannelId = ch.parent_id;
          } else {
            break;
          }
        }

        logger.debug(`Built channel chain for ACL query: ${channelsInChain.map(c => c.id).join(' -> ')}`);

        // 收集所有相关的 ACL（包括继承的）
        const allACLs: mumbleproto.ACL.ChanACL[] = [];

        for (const iterChannel of channelsInChain) {
          const channelACLs = await this._database.getChannelACLs(iterChannel.id);
          logger.debug(`Channel ${iterChannel.id} has ${channelACLs.length} ACL entries`);
          
          for (const aclEntry of channelACLs) {
            // 如果是当前频道，或者 ACL 应用于子频道，则包含此 ACL
            if (iterChannel.id === channel_id || aclEntry.apply_subs) {
              const chanACL: any = {
                apply_here: aclEntry.apply_here,
                apply_subs: aclEntry.apply_subs,
                inherited: iterChannel.id !== channel_id,
                group: aclEntry.group || undefined,
                grant: aclEntry.allow,
                deny: aclEntry.deny,
              };
              if (aclEntry.user_id && aclEntry.user_id > 0) {
                chanACL.user_id = aclEntry.user_id;
              }
              allACLs.push(new mumbleproto.ACL.ChanACL(chanACL));
            }
          }
        }
        
        logger.debug(`Collected ${allACLs.length} total ACL entries`);

        // 收集频道组信息（包括继承的组）
        const allGroups: mumbleproto.ACL.ChanGroup[] = [];
        
        if (this._channelGroupManager) {
          const channelGroups = await this._channelGroupManager.getChannelGroups(channel_id, true);
          
          for (const channelGroup of channelGroups) {
            const chanGroup: any = {
              name: channelGroup.name,
              inherited: channelGroup.channel_id !== channel_id,
              inherit: channelGroup.inherit,
              inheritable: channelGroup.inheritable,
              add: channelGroup.add_members,
              remove: channelGroup.remove_members,
              inherited_members: channelGroup.inherited_members,
            };
            allGroups.push(new mumbleproto.ACL.ChanGroup(chanGroup));
          }
        }
        
        logger.debug(`Collected ${allGroups.length} total groups`);

        // 构建 ACL 响应
        const aclResponse = new mumbleproto.ACL({
          channel_id,
          inherit_acls: channel.inherit_acl,
          acls: allACLs,
          groups: allGroups,
          query: false,
        });

        const responseData = aclResponse.serialize();
        logger.debug(`ACL response built: ${allACLs.length} ACLs, ${allGroups.length} groups`);

        logger.info(`ACL query completed for channel ${channel_id}`);
        return { 
          success: true,
          channel_id,
          raw_data: Buffer.from(responseData).toString('base64')
        };
      } else {
        // === 更新 ACL ===
        logger.debug(`Processing ACL update for channel ${channel_id}`);
        
        const acls = acl.acls ?? [];
        
        // 转换为数据库格式
        const aclData = acls.map((aclMsg) => ({
          user_id: aclMsg.user_id,
          group: aclMsg.group || '',
          apply_here: aclMsg.apply_here !== false,
          apply_subs: aclMsg.apply_subs !== false,
          allow: aclMsg.grant || 0,
          deny: aclMsg.deny || 0,
        }));

        // 使用 ACLManager 保存 ACL
        if (this._aclManager) {
          await this._aclManager.saveACLs(channel_id, aclData);
          logger.info(`ACL updated for channel ${channel_id}: ${aclData.length} entries`);
        }

        // 更新频道的 inherit_acl 设置
        if (acl.inherit_acls !== undefined && acl.inherit_acls !== channel.inherit_acl) {
          await this._database.updateChannel(channel_id, { inherit_acl: acl.inherit_acls });
          logger.info(`Channel ${channel_id} inherit_acl updated to ${acl.inherit_acls}`);
        }

        // 处理频道组更新
        if (this._channelGroupManager && acl.groups && acl.groups.length > 0) {
          logger.info(`Channel ${channel_id} channel groups update requested: ${acl.groups.length} groups`);
          
          // 只保存非继承的组
          const channelGroupsToSave = acl.groups
            .filter(g => !g.inherited)
            .map(g => ({
              channel_id,
              name: g.name,
              inherit: g.inherit !== false,
              inheritable: g.inheritable !== false,
              add_members: g.add || [],
              remove_members: g.remove || [],
            }));
          
          await this._channelGroupManager.saveChannelGroups(channel_id, channelGroupsToSave);
          logger.info(`Saved ${channelGroupsToSave.length} channel groups for channel ${channel_id}`);
        }

        // 通知所有 Edge 刷新该频道的权限
        // 这会触发 Edge 重新计算频道内所有用户的 suppress 状态
        logger.info(`Broadcasting ACL update notification for channel ${channel_id}`);
        this.broadcast('edge.aclUpdated', {
          channel_id,
          timestamp: Date.now(),
        });

        logger.info(`ACL update completed for channel ${channel_id}`);
        return { 
          success: true,
          channel_id
        };
      }
    } catch (error) {
      logger.error('Error handling ACL request:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleSaveChannel(
    _channel: RPCChannel,
    params: RPCParams<'edge.saveChannel'>
  ): Promise<RPCResult<'edge.saveChannel'>> {
    let  channel_id: number;

    if (params.channel.id !== undefined) {
      // 更新现有频道 - 只更新提供的字段
      const updates: any = {};
      
      if (params.channel.name !== undefined) {
        updates.name = params.channel.name;
      }
      if (params.channel.position !== undefined) {
        updates.position = params.channel.position;
      }
      if (params.channel.max_users !== undefined) {
        updates.max_users = params.channel.max_users;
      }
      if (params.channel.parent_id !== undefined) {
        updates.parent_id = params.channel.parent_id;
      }
      if (params.channel.inherit_acl !== undefined) {
        updates.inherit_acl = params.channel.inherit_acl;
      }
      if (params.channel.description_blob !== undefined || params.channel.description !== undefined) {
        updates.description_blob = params.channel.description_blob || params.channel.description;
      }

      await this._database.updateChannel(params.channel.id, updates);
      channel_id = params.channel.id;
    } else {
      // 创建新频道 - 必须提供所有必需字段的默认值
      if (!params.channel.name) {
        throw new Error('Channel name is required for new channels');
      }
      const channelData = {
        name: params.channel.name,
        position: params.channel.position !== undefined ? params.channel.position : 0,
        max_users: params.channel.max_users !== undefined ? params.channel.max_users : 0,
        parent_id: params.channel.parent_id !== undefined ? params.channel.parent_id : 0,
        inherit_acl: params.channel.inherit_acl !== undefined ? params.channel.inherit_acl : true,
        description_blob: params.channel.description_blob || params.channel.description || '',
      };
      
      channel_id = await this._database.createChannel(channelData);
    }

    return { success: true, channel_id };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleSaveACL(
    _channel: RPCChannel,
    params: RPCParams<'edge.saveACL'>
  ): Promise<RPCResult<'edge.saveACL'>> {
    if (!this._aclManager) {
      throw new Error('ACLManager not available');
    }

    const { channel_id, acls } = params;

    console.log(acls)

    // Convert RPC ACL format to ACLManager format
    const aclData = acls.map((acl) => ({
      user_id: acl.user_id,
      group: acl.group,
      apply_here: acl.apply_here,
      apply_subs: acl.apply_subs,
      allow: acl.allow,
      deny: acl.deny,
    }));

    // Use ACLManager to save ACLs
    const aclIds = await this._aclManager.saveACLs(channel_id, aclData);

    return { success: true, aclIds };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleEdgeJoin(
    _channel: RPCChannel,
    params: RPCParams<'edge.join'>
  ): Promise<RPCResult<'edge.join'>> {
    logger.info(`Edge ${params.server_id} requesting to join cluster`);

    // 获取所有已注册的Edge作为Peer列表
    const allEdges = this._registry.getEdgeList();
    const peers = allEdges
      .filter((edge) => edge.server_id !== params.server_id)
      .map((edge) => ({
        id: edge.server_id,
        name: edge.name,
        host: edge.host,
        port: edge.port,
        voicePort: edge.port + 1,
      }));

    // 生成加入令牌
    const token = `token-${params.server_id}-${Date.now()}`;

    logger.info(`Edge ${params.server_id} join request accepted, peers: ${peers.length}`);

    return {
      success: true,
      token,
      peers,
      timeout: 60000,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleEdgeJoinComplete(
    _channel: RPCChannel,
    params: RPCParams<'edge.joinComplete'>
  ): Promise<RPCResult<'edge.joinComplete'>> {
    logger.info(
      `Edge ${params.server_id} completed join, connected peers: ${params.connectedPeers.join(',')}`
    );

    // 广播新成员加入通知
    const edge = this._registry.getEdge(params.server_id);
    if (edge) {
      this.broadcast('edge.peerJoined', {
        id: edge.server_id,
        name: edge.name,
        host: edge.host,
        port: edge.port,
        voicePort: edge.port + 1,
      });
    }

    return { success: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleEdgeReportPeerDisconnect(
    _channel: RPCChannel,
    params: RPCParams<'edge.reportPeerDisconnect'>
  ): Promise<RPCResult<'edge.reportPeerDisconnect'>> {
    logger.warn(`Peer disconnect reported: Edge ${params.localEdgeId} <-> Edge ${params.remoteEdgeId}`);

    // 获取远程Edge的客户端数量
    const remoteEdge = this._registry.getEdge(params.remoteEdgeId);
    const remoteClientCount = remoteEdge?.stats?.user_count || 0;

    logger.info(`Comparing client counts: local=${params.localClientCount}, remote=${remoteClientCount}`);

    // 比较客户端数量，让客户端少的Edge断开重连
    if (params.localClientCount < remoteClientCount) {
      logger.info(`Instructing Edge ${params.localEdgeId} to disconnect (fewer clients)`);
      return { action: 'disconnect' };
    } else if (params.localClientCount > remoteClientCount) {
      logger.info(`Instructing Edge ${params.remoteEdgeId} to disconnect (fewer clients)`);
      // 通知远程Edge断开
      this.notify(params.remoteEdgeId, 'edge.forceDisconnect', {
        reason: 'Peer connection failed, fewer clients',
      });
      return { action: 'wait' };
    } else {
      // 客户端数量相同，让ID较小的断开
      if (params.localEdgeId < params.remoteEdgeId) {
        return { action: 'disconnect' };
      } else {
        this.notify(params.remoteEdgeId, 'edge.forceDisconnect', {
          reason: 'Peer connection failed, tie-break',
        });
        return { action: 'wait' };
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleGetClusterStatus(
    _channel: RPCChannel,
    _params: RPCParams<'cluster.getStatus'>
  ): Promise<RPCResult<'cluster.getStatus'>> {
    const edges = this._registry.getEdgeList();
    return {
      edges: edges.map((edge) => ({
        id: edge.server_id,
        name: edge.name,
        host: edge.host,
        port: edge.port,
        clientCount: edge.current_load || 0,
        status: (edge.last_seen && Date.now() - edge.last_seen < 10000 ? 'online' : 'offline') as 'online' | 'offline',
         last_seen: edge.last_seen,
      })),
    };
  }

  // ============================================================================
  // Blob Storage Handlers
  // ============================================================================

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleBlobPut(
    _channel: RPCChannel,
    params: RPCParams<'blob.put'>
  ): Promise<RPCResult<'blob.put'>> {
    if (!this._blobStore || !this._blobStore.isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    try {
      const hash = await this._blobStore.put(params.data);
      logger.debug(`Blob stored: ${hash}`);
      return { success: true, hash };
    } catch (error) {
      logger.error('Error storing blob:', error);
      return { success: false, error: String(error) };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleBlobGet(
    _channel: RPCChannel,
    params: RPCParams<'blob.get'>
  ): Promise<RPCResult<'blob.get'>> {
    if (!this._blobStore || !this._blobStore.isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    try {
      const data = await this._blobStore.get(params.hash);
      if (!data) {
        return { success: false, error: 'Blob not found' };
      }
      return { success: true, data };
    } catch (error) {
      logger.error(`Error retrieving blob ${params.hash}:`, error);
      return { success: false, error: String(error) };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleGetUserTexture(
    _channel: RPCChannel,
    params: RPCParams<'blob.getUserTexture'>
  ): Promise<RPCResult<'blob.getUserTexture'>> {
    if (!this._blobStore || !this._blobStore.isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    if (!this._database) {
      return { success: false, error: 'Database not available' };
    }

    try {
      const hash = await this._database.getUserTextureBlob(params.user_id);
      if (!hash) {
        return { success: false, error: 'User texture not found' };
      }

      const data = await this._blobStore.get(hash);
      if (!data) {
        return { success: false, error: 'Texture blob not found' };
      }

      return { success: true, data, hash };
    } catch (error) {
      logger.error(`Error getting user texture for user ${params.user_id}:`, error);
      return { success: false, error: String(error) };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleGetUserComment(
    _channel: RPCChannel,
    params: RPCParams<'blob.getUserComment'>
  ): Promise<RPCResult<'blob.getUserComment'>> {
    if (!this._blobStore || !this._blobStore.isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    if (!this._database) {
      return { success: false, error: 'Database not available' };
    }

    try {
      const hash = await this._database.getUserCommentBlob(params.user_id);
      if (!hash) {
        return { success: false, error: 'User comment not found' };
      }

      const data = await this._blobStore.get(hash);
      if (!data) {
        return { success: false, error: 'Comment blob not found' };
      }

      return { success: true, data, hash };
    } catch (error) {
      logger.error(`Error getting user comment for user ${params.user_id}:`, error);
      return { success: false, error: String(error) };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleSetUserTexture(
    _channel: RPCChannel,
    params: RPCParams<'blob.setUserTexture'>
  ): Promise<RPCResult<'blob.setUserTexture'>> {
    if (!this._blobStore || !this._blobStore.isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    if (!this._database) {
      return { success: false, error: 'Database not available' };
    }

    try {
      // 存储 blob 数据
      const hash = await this._blobStore.put(params.data);
      
      // 保存 hash 到数据库
      await this._database.setUserTextureBlob(params.user_id, hash);
      
      logger.info(`Set user texture for user ${params.user_id}: ${hash}`);
      return { success: true, hash };
    } catch (error) {
      logger.error(`Error setting user texture for user ${params.user_id}:`, error);
      return { success: false, error: String(error) };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleSetUserComment(
    _channel: RPCChannel,
    params: RPCParams<'blob.setUserComment'>
  ): Promise<RPCResult<'blob.setUserComment'>> {
    if (!this._blobStore || !this._blobStore.isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    if (!this._database) {
      return { success: false, error: 'Database not available' };
    }

    try {
      // 存储 blob 数据
      const hash = await this._blobStore.put(params.data);
      
      // 保存 hash 到数据库
      await this._database.setUserCommentBlob(params.user_id, hash);
      
      logger.info(`Set user comment for user ${params.user_id}: ${hash}`);
      return { success: true, hash };
    } catch (error) {
      logger.error(`Error setting user comment for user ${params.user_id}:`, error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 启动控制信道服务
   */
  async start(): Promise<void> {
    logger.info(`Starting Hub control channel server on port ${this.config.controlPort || 8443}`);
    // 服务器在构造函数中已经启动
  }

  /**
   * 停止控制信道服务
   */
  async stop(): Promise<void> {
    logger.info('Stopping Hub control channel server');
    this.server.close();
  }

  /**
   * 广播通知给所有连接的Edge
   * 注意：广播会发送给所有Edge，包括发起操作的Edge
   * Edge应该通过edge_id字段判断是否需要处理本地状态更新
   */
  broadcast(method: string, params?: any): void {
    this.server.broadcast(method, params);
  }

  /**
   * 发送通知给特定Edge
   */
  notify( edge_id: number, method: string, params?: any): void {
    const channel = this.edgeChannels.get(edge_id);
    if (channel) {
      this.server.notify(channel, method, params);
    }
  }
}