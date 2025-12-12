import type { Logger } from '@munode/common';
import type { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';


/**
 * Hub Edge处理器接口
 */
export interface IEdgeHandler {
  handleEdgeRegister(params: RPCParams<'edge.register'>): Promise<RPCResult<'edge.register'>>;
}

/**
 * Hub Edge处理器 - 处理Edge注册和相关操作
 */
export class EdgeHandler implements IEdgeHandler {
  private factory: HubHandlerFactory;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
  }

  /**
   * 处理Edge注册
   */
  async handleEdgeRegister(params: RPCParams<'edge.register'>): Promise<RPCResult<'edge.register'>> {
    // 调用注册服务
    const result = await this.factory.getRegistry().register(params);

    if (result.success) {
      // 将Edge与RPCChannel关联
      // 注意：这里需要从外部传入channel，但由于handler模式，我们假设在control-service中处理
      this.logger.info(`Edge ${params.server_id} registered successfully`);

      // 添加 Edge 到网络拓扑
      this.factory.getNetworkTopologyManager().addEdge(params.server_id);

      // 推送语音路由配置给新注册的 Edge
      // 注意：这里需要外部调用，因为需要channel信息
    }

    return result;
  }
}