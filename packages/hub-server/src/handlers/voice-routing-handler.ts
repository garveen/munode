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
        // 如果指定了目标频道，检查用户是否有权限访问该频道
        // Note: channel_id can be 0 (root channel), which should also be validated
        if (target.channel_id !== undefined) {
          const canAccess = await permissionChecker.canUserAccessChannel(target.channel_id, userInfo);
          
          if (!canAccess) {
            this.logger.warn(
              `VoiceTarget denied: Session ${params.client_session} cannot access channel ${target.channel_id}`
            );
            return { 
              success: false, 
              error: `Permission denied: No access to channel ${target.channel_id}` 
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

  // Implementation removed - see interface documentation above
}