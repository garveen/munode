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

    // 同步语音目标配置到本地存储（不进行权限验证）
    // 权限检查在实际使用VoiceTarget发送语音时进行（在Edge的voice router中）
    // 这与Murmur的实现一致：msgVoiceTarget只负责设置qmTargets，不验证权限
    voiceTargetSync.syncVoiceTarget(params);

    if (params.config === null || params.config === undefined) {
      this.logger.info(
        `VoiceTarget deleted: Edge ${params.edge_id}, Session ${params.client_session}, Target ${params.target_id}`
      );
    } else {
      this.logger.info(
        `VoiceTarget set: Edge ${params.edge_id}, Session ${params.client_session}, Target ${params.target_id}`
      );
    }

    // 广播 VoiceTarget 更新到所有其他 Edge（除了发送者）
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