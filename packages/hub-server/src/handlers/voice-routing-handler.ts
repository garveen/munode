import { createLogger } from '@munode/common';
import { HubHandlerFactory } from '../factory.js';

const logger = createLogger({ service: 'hub-voice-routing-handler' });

/**
 * 语音路由处理器接口
 */
export interface IVoiceRoutingHandler {
  /**
   * 处理语音目标同步
   */
  handleSyncVoiceTarget(params: any): Promise<any>;

  /**
   * 处理获取语音目标
   */
  handleGetVoiceTargets(params: any): Promise<any>;

  /**
   * 处理语音路由
   */
  handleRouteVoice(params: any): Promise<any>;
}

/**
 * 语音路由处理器实现
 */
export class VoiceRoutingHandler implements IVoiceRoutingHandler {
  private factory: HubHandlerFactory;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
  }

  async handleSyncVoiceTarget(params: any): Promise<any> {
    const voiceTargetSync = this.factory.getVoiceTargetSync();
    const controlService = this.factory.getControlService();

    // 同步语音目标配置到本地存储
    voiceTargetSync.syncVoiceTarget(params);

    // 广播 VoiceTarget 更新到所有其他 Edge（除了发送者）
    logger.info(
      `Broadcasting VoiceTarget update: Edge ${params.edge_id}, Session ${params.client_session}, Target ${params.target_id}`
    );

    // 广播到所有其他Edge（除了发送者）
    controlService.broadcastExcept(params.edge_id, 'hub.syncVoiceTarget', params);    return { success: true };
  }

  async handleGetVoiceTargets(params: any): Promise<any> {
    const voiceTargetSync = this.factory.getVoiceTargetSync();

    let configs;
    if (params.edge_id !== undefined) {
      // 获取特定Edge的配置
      configs = voiceTargetSync.getEdgeConfigs(params.edge_id);
    } else {
      // 获取所有配置
      configs = voiceTargetSync.getAllConfigs();
    }

    return { voiceTargets: configs };
  }

  async handleRouteVoice(params: any): Promise<any> {
    const voiceTargetSync = this.factory.getVoiceTargetSync();
    const sessionManager = this.factory.getSessionManager();
    const controlService = this.factory.getControlService();

    // 获取语音目标配置
    const sessionConfigs = voiceTargetSync.getSessionConfigs(params.fromEdgeId, params.fromSessionId);
    const targetConfig = sessionConfigs.get(params.target_id);

    if (!targetConfig) {
      throw new Error('Voice target not found');
    }

    // 路由语音数据到目标会话
    const routingResults: Array<{ session_id: number; edge_id: number }> = [];

    // 处理会话目标
    for (const session_id of targetConfig.sessions) {
      const session = sessionManager.getSession(session_id);
      if (session) {
        // 发送到目标Edge
        controlService.notify(session.edge_id, 'voice.data', {
          fromSessionId: params.fromSessionId,
          targetSessionId: session_id,
          voiceData: params.voiceData,
          timestamp: params.timestamp,
        });
        routingResults.push({ session_id, edge_id: session.edge_id });
      }
    }

    // 处理频道目标
    for (const channelTarget of targetConfig.channels) {
      const channelSessions = voiceTargetSync.getChannelSessions(channelTarget.channel_id);
      for (const session of channelSessions) {
        if (session.session_id !== params.fromSessionId) { // 不发送给自己
          controlService.notify(session.edge_id, 'voice.data', {
            fromSessionId: params.fromSessionId,
            targetSessionId: session.session_id,
            voiceData: params.voiceData,
            timestamp: params.timestamp,
          });
          routingResults.push({ session_id: session.session_id, edge_id: session.edge_id });
        }
      }
    }

    return { success: true, routedTo: routingResults };
  }
}