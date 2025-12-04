import type { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';

/**
 * Hub 管理操作处理器接口
 */
export interface IAdminOperationHandler {
  handleAdminOperation(params: RPCParams<'edge.adminOperation'>): Promise<RPCResult<'edge.adminOperation'>>;
}

/**
 * Hub 管理操作处理器 - 处理管理相关的操作
 */
export class AdminOperationHandler implements IAdminOperationHandler {
  private factory: HubHandlerFactory;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
  }

  /**
   * 处理管理操作
   */
  async handleAdminOperation(params: RPCParams<'edge.adminOperation'>): Promise<RPCResult<'edge.adminOperation'>> {
    // 简单的管理操作处理
    switch (params.operation) {
      case 'cleanup': {
        // 清理过期数据
        this.factory.getSessionManager().cleanup();
        this.factory.getCertExchange().cleanupExpiredCertificates();
        await this.factory.getDatabaseOperations().cleanup();
        return { success: true, message: 'Cleanup completed' };
      }

      case 'getStats': {
        // 获取统计信息
        const stats = {
          edges: this.factory.getRegistry().getEdgeCount(),
          sessions: this.factory.getSessionManager().getTotalSessionCount(),
          voiceTargets: this.factory.getVoiceTargetSync().getTargetCount(),
          channels: 0, // TODO: 从数据库获取
        };
        return { success: true, stats };
      }

      default:
        throw new Error('Unknown admin operation');
    }
  }
}