import type { Logger } from '@munode/common';
import { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';


/**
 * 语音路由处理器接口
 */
export interface IVoiceRoutingHandler {
  /**
   * 处理语音目标同步
   */
  handleSyncVoiceTarget(params: RPCParams<'edge.syncVoiceTarget'>): Promise<RPCResult<'edge.syncVoiceTarget'>>;

  /**
   * 处理获取语音目标
   */
  handleGetVoiceTargets(params: RPCParams<'edge.getVoiceTargets'>): Promise<RPCResult<'edge.getVoiceTargets'>>;

  /**
   * 验证并清理因ACL更改而无效的 VoiceTarget
   */
  validateAndCleanupVoiceTargets(affectedChannelIds: number[]): Promise<void>;

  /**
   * NOTE: Voice packet routing through hub has been removed.
   * 
   * Architecture: Voice packets now flow edge-to-edge directly via UDP (VoiceUDPTransport).
   * Hub only handles VoiceTarget configuration synchronization, not voice data packets.
   * 
   * This method (handleRouteVoice) has been removed as it's no longer needed.
   * @deprecated Since voice routing architecture change - will be removed in future version
   */
}

/**
 * 语音路由处理器实现
 */
export class VoiceRoutingHandler implements IVoiceRoutingHandler {
  private factory: HubHandlerFactory;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
  }

  async handleSyncVoiceTarget(params: RPCParams<'edge.syncVoiceTarget'>): Promise<RPCResult<'edge.syncVoiceTarget'>> {
    const voiceTargetSync = this.factory.getVoiceTargetSync();
    const controlService = this.factory.getControlService();
    const sessionManager = this.factory.getSessionManager();
    const permissionChecker = this.factory.getPermissionChecker();

    // 获取会话信息
    const session = sessionManager.getSession(params.client_session);
    if (!session) {
      this.logger.warn(`VoiceTarget sync from unknown session: ${params.client_session}`);
      return { 
        success: false, 
        error: 'Session not found' 
      };
    }

    // 如果是删除 VoiceTarget（config 为 null），不需要权限验证
    if (params.config === null || params.config === undefined) {
      voiceTargetSync.syncVoiceTarget(params);
      
      this.logger.info(
        `VoiceTarget deleted: Edge ${params.edge_id}, Session ${params.client_session}, Target ${params.target_id}`
      );
      
      const notificationParams = {
        edge_id: params.edge_id,
        client_session: params.client_session,
        target_id: params.target_id,
        config: params.config,
      };
      controlService.broadcastExcept(params.edge_id, 'hub.syncVoiceTarget', notificationParams);
      
      return { success: true };
    }

    // 权限验证：用户必须在其当前频道拥有 Whisper 权限
    const userChannelId = session.channel_id;
    if (userChannelId === undefined) {
      this.logger.warn(`VoiceTarget sync: session ${params.client_session} has no channel`);
      return { 
        success: false, 
        error: 'User not in any channel' 
      };
    }

    const userInfo = permissionChecker.sessionToUserInfo(session, userChannelId);
    const hasWhisper = await permissionChecker.hasPermission(
      userChannelId,
      userInfo,
      0x100 // Permission.Whisper
    );

    if (!hasWhisper) {
      this.logger.warn(
        `VoiceTarget denied: Session ${params.client_session} lacks Whisper permission in channel ${userChannelId}`
      );
      return { 
        success: false, 
        error: 'Permission denied: Whisper permission required in your current channel' 
      };
    }

    // 验证目标频道权限
    if (params.config.targets) {
      for (const target of params.config.targets) {
        // 如果指定了目标频道，检查用户是否有权限在该频道发言
        // Note: channel_id can be 0 (root channel), which should also be validated
        if (target.channel_id !== undefined) {
          const canSpeak = await permissionChecker.hasPermission(target.channel_id, userInfo, 0x8); // Permission.Speak
          
          if (!canSpeak) {
            this.logger.warn(
              `VoiceTarget denied: Session ${params.client_session} cannot speak in channel ${target.channel_id}`
            );
            return { 
              success: false, 
              error: `Permission denied: Speak permission required in channel ${target.channel_id}` 
            };
          }
        }

        // 如果指定了目标用户会话，验证这些用户是否可见
        if (target.session && target.session.length > 0) {
          for (const targetSessionId of target.session) {
            const targetSession = sessionManager.getSession(targetSessionId);
            if (!targetSession) {
              this.logger.warn(
                `VoiceTarget denied: Target session ${targetSessionId} not found`
              );
              return { 
                success: false, 
                error: `Target user session ${targetSessionId} not found` 
              };
            }

            // 检查是否可以向目标用户发送语音（Channel Ninja 规则）
            const targetChannelId = targetSession.channel_id;
            if (targetChannelId !== undefined) {
              const ninjaChannels = this.factory.getConfig().ninjaChannels 
                ? new Set(this.factory.getConfig().ninjaChannels) 
                : undefined;
              
              const canSeeUser = await permissionChecker.canUserSeeOtherUser(
                userInfo,
                userChannelId,
                targetChannelId,
                ninjaChannels
              );

              if (!canSeeUser) {
                this.logger.warn(
                  `VoiceTarget denied: Session ${params.client_session} cannot see user in session ${targetSessionId}`
                );
                return { 
                  success: false, 
                  error: `Permission denied: Cannot target user in session ${targetSessionId}` 
                };
              }
            }
          }
        }
      }
    }

    // 权限验证通过，同步语音目标配置到本地存储
    voiceTargetSync.syncVoiceTarget(params);

    // 广播 VoiceTarget 更新到所有其他 Edge（除了发送者）
    this.logger.info(
      `VoiceTarget set: Edge ${params.edge_id}, Session ${params.client_session}, Target ${params.target_id}`
    );

    // 广播到所有其他Edge（除了发送者）
    const notificationParams = {
      edge_id: params.edge_id,
      client_session: params.client_session,
      target_id: params.target_id,
      config: params.config,
    };
    controlService.broadcastExcept(params.edge_id, 'hub.syncVoiceTarget', notificationParams);
    
    return { success: true };
  }

  async handleGetVoiceTargets(params: RPCParams<'edge.getVoiceTargets'>): Promise<RPCResult<'edge.getVoiceTargets'>> {
    const voiceTargetSync = this.factory.getVoiceTargetSync();

    let configs;
    if (params.edge_id !== undefined) {
      // 获取特定Edge的配置
      configs = voiceTargetSync.getEdgeConfigs(params.edge_id);
    } else {
      // 获取所有配置
      configs = voiceTargetSync.getAllConfigs();
    }

    return { voice_targets: configs };
  }

  /**
   * 验证并清理因ACL更改而无效的 VoiceTarget
   * 当ACL发生变化时，需要重新验证所有现有的VoiceTarget配置
   * 如果用户不再有权限使用某个VoiceTarget，则删除它
   * 
   * @param affectedChannelIds - 受影响的频道ID列表（ACL被修改的频道）
   */
  async validateAndCleanupVoiceTargets(affectedChannelIds: number[]): Promise<void> {
    const voiceTargetSync = this.factory.getVoiceTargetSync();
    const sessionManager = this.factory.getSessionManager();
    const permissionChecker = this.factory.getPermissionChecker();
    const controlService = this.factory.getControlService();

    // 清除受影响频道的权限缓存
    for (const channelId of affectedChannelIds) {
      permissionChecker.clearCacheForChannel(channelId);
    }

    // 获取所有 VoiceTarget 配置
    const allConfigs = voiceTargetSync.getAllConfigs();
    
    this.logger.info(`Validating ${allConfigs.length} VoiceTargets after ACL change on channels: ${affectedChannelIds.join(', ')}`);

    let invalidCount = 0;

    for (const config of allConfigs) {
      if (!config.config || !config.config.targets) {
        continue;
      }

      // 获取会话信息
      const session = sessionManager.getSession(config.client_session);
      if (!session || session.channel_id === undefined) {
        // 会话不存在或不在任何频道，删除此VoiceTarget
        voiceTargetSync.syncVoiceTarget({
          edge_id: config.edge_id,
          client_session: config.client_session,
          target_id: config.target_id,
          config: null,
        });
        
        // 广播删除通知
        controlService.broadcastExcept(config.edge_id, 'hub.syncVoiceTarget', {
          edge_id: config.edge_id,
          client_session: config.client_session,
          target_id: config.target_id,
          config: null,
        });
        
        invalidCount++;
        this.logger.info(`Removed VoiceTarget ${config.target_id} for session ${config.client_session}: session not found or no channel`);
        continue;
      }

      const userInfo = permissionChecker.sessionToUserInfo(session, session.channel_id);
      let isValid = true;

      // 检查用户是否仍有 Whisper 权限
      const hasWhisper = await permissionChecker.hasPermission(
        session.channel_id,
        userInfo,
        0x100 // Permission.Whisper
      );

      if (!hasWhisper) {
        isValid = false;
        this.logger.debug(`VoiceTarget ${config.target_id} for session ${config.client_session} invalid: no Whisper permission`);
      }

      // 检查每个目标的权限
      if (isValid) {
        for (const target of config.config.targets) {
          // 检查目标频道权限
          if (target.channel_id !== undefined) {
            const canSpeak = await permissionChecker.hasPermission(target.channel_id, userInfo, 0x8); // Permission.Speak
            
            if (!canSpeak) {
              isValid = false;
              this.logger.debug(`VoiceTarget ${config.target_id} for session ${config.client_session} invalid: cannot speak in channel ${target.channel_id}`);
              break;
            }
          }

          // 检查目标用户是否可见
          if (target.session && target.session.length > 0) {
            for (const targetSessionId of target.session) {
              const targetSession = sessionManager.getSession(targetSessionId);
              if (!targetSession || targetSession.channel_id === undefined) {
                isValid = false;
                this.logger.debug(`VoiceTarget ${config.target_id} for session ${config.client_session} invalid: target session ${targetSessionId} not found`);
                break;
              }

              const ninjaChannels = this.factory.getConfig().ninjaChannels 
                ? new Set(this.factory.getConfig().ninjaChannels) 
                : undefined;
              
              const canSeeUser = await permissionChecker.canUserSeeOtherUser(
                userInfo,
                session.channel_id,
                targetSession.channel_id,
                ninjaChannels
              );

              if (!canSeeUser) {
                isValid = false;
                this.logger.debug(`VoiceTarget ${config.target_id} for session ${config.client_session} invalid: cannot see target session ${targetSessionId}`);
                break;
              }
            }
            
            if (!isValid) break;
          }
        }
      }

      // 如果VoiceTarget无效，删除它
      if (!isValid) {
        voiceTargetSync.syncVoiceTarget({
          edge_id: config.edge_id,
          client_session: config.client_session,
          target_id: config.target_id,
          config: null,
        });
        
        // 广播删除通知
        controlService.broadcastExcept(config.edge_id, 'hub.syncVoiceTarget', {
          edge_id: config.edge_id,
          client_session: config.client_session,
          target_id: config.target_id,
          config: null,
        });
        
        invalidCount++;
        this.logger.info(`Removed invalid VoiceTarget ${config.target_id} for session ${config.client_session} (Edge ${config.edge_id})`);
      }
    }

    if (invalidCount > 0) {
      this.logger.info(`Cleaned up ${invalidCount} invalid VoiceTargets after ACL change`);
    }
  }

  // Implementation removed - see interface documentation above
}