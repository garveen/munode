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
   * 处理 TCP 降级语音中转
   * 当 Edge 之间 UDP 连接不可用时，通过 Hub 中转语音数据
   */
  handleRelayVoiceViaTcp(params: RPCParams<'edge.relayVoiceViaTcp'>): Promise<RPCResult<'edge.relayVoiceViaTcp'>>;
}

/**
 * 语音路由处理器实现
 */
export class VoiceRoutingHandler implements IVoiceRoutingHandler {
  private factory: HubHandlerFactory;
  private logger: Logger;
  private enableTcpFallback: boolean;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
    
    // 缓存 TCP 降级配置开关，避免每次处理语音包时都读取
    const config = factory.getConfig();
    this.enableTcpFallback = config.voice_routing?.hub_relay?.enable_tcp_fallback ?? true;

    this.logger.info(`VoiceRoutingHandler initialized, Hub relay (TCP fallback via Hub): ${this.enableTcpFallback}`);
  }

  handleSyncVoiceTarget(params: RPCParams<'edge.syncVoiceTarget'>): Promise<RPCResult<'edge.syncVoiceTarget'>> {
    const voiceTargetSync = this.factory.getVoiceTargetSync();

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
    this.factory.getControlService().broadcastExcept(params.edge_id, 'hub.syncVoiceTarget', notificationParams);
    
    return Promise.resolve({ success: true });
  }

  handleGetVoiceTargets(params: RPCParams<'edge.getVoiceTargets'>): Promise<RPCResult<'edge.getVoiceTargets'>> {
    const voiceTargetSync = this.factory.getVoiceTargetSync();

    let configs;
    if (params.edge_id !== undefined) {
      // 获取特定Edge的配置
      configs = voiceTargetSync.getEdgeConfigs(params.edge_id);
    } else {
      // 获取所有配置
      configs = voiceTargetSync.getAllConfigs();
    }

    return Promise.resolve({ voice_targets: configs });
  }

  /**
   * 处理 TCP 降级语音中转
   * 当 UDP 连接不可用时，Edge 通过 Hub 的 WebSocket 控制通道转发语音包
   */
  handleRelayVoiceViaTcp(params: RPCParams<'edge.relayVoiceViaTcp'>): Promise<RPCResult<'edge.relayVoiceViaTcp'>> {
    const { from_edge_id, target_edge_id, voice_packet, timestamp } = params;

    // 检查 Hub 中转降级功能是否启用（使用缓存的配置）
    if (!this.enableTcpFallback) {
      this.logger.debug(
        `[HUB-RELAY] Hub relay (TCP fallback via Hub) is disabled, ` +
        `rejecting relay request from Edge ${from_edge_id} to Edge ${target_edge_id}`
      );
      return Promise.resolve({
        success: false,
        error: 'Hub relay (TCP fallback) is disabled'
      });
    }

    try {
      // 记录 Hub 中转降级转发
      this.logger.debug(
        `[HUB-RELAY] Relaying voice via Hub: Edge ${from_edge_id} -> Hub -> Edge ${target_edge_id}, ` +
        `packet_size=${voice_packet.length}, timestamp=${timestamp}`
      );

      // 通过控制服务的 notify 方法发送给目标 Edge
      // 使用通知机制，不需要等待响应
      this.factory.getControlService().notify(target_edge_id, 'hub.relayVoicePacket', {
        from_edge_id,
        voice_packet,
        timestamp,
      });

      this.logger.debug(
        `[HUB-RELAY] Hub relay successful: ${voice_packet.length} bytes Edge ${from_edge_id} -> Hub -> Edge ${target_edge_id}`
      );
      return Promise.resolve({ success: true });
    } catch (error) {
      this.logger.error(`[HUB-RELAY] Hub relay error from Edge ${from_edge_id} to ${target_edge_id}:`, error);
      return Promise.resolve({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }
}