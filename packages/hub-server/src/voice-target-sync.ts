import { createLogger } from '@munode/common';
import type { GlobalSessionManager } from './session-manager.js';
import type { VoiceTargetConfig, VoiceTarget } from './types.js';
import { GlobalSession } from '@munode/protocol';

const logger = createLogger({ service: 'hub-voice-target-sync' });

/**
 * VoiceTarget 同步服务
 * 维护全局 VoiceTarget 配置，支持完整同步和增量更新
 */
export class VoiceTargetSyncService {
  // 存储格式: Map<edge_id, Map<client_session, Map<target_id, VoiceTarget>>>
  private configs = new Map<number, Map<number, Map<number, VoiceTarget>>>();
  private sessionManager: GlobalSessionManager;

  constructor(sessionManager: GlobalSessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * 同步 VoiceTarget 配置
   */
  syncVoiceTarget(config: VoiceTargetConfig): void {
    const { edge_id, client_session, target_id, config: vtConfig } = config;

    // 1. 更新本地存储
    if (!this.configs.has(edge_id)) {
      this.configs.set(edge_id, new Map());
    }

    const edgeConfigs = this.configs.get(edge_id);
    if (!edgeConfigs.has(client_session)) {
      edgeConfigs.set(client_session, new Map());
    }

    const clientConfigs = edgeConfigs.get(client_session);

    if (vtConfig === null) {
      // 删除配置
      clientConfigs.delete(target_id);
      logger.info(
        `VoiceTarget deleted: Edge ${edge_id}, Session ${client_session}, Target ${target_id}`
      );
    } else {
      // 更新配置
      clientConfigs.set(target_id, vtConfig);
      logger.info(
        `VoiceTarget synced: Edge ${edge_id}, Session ${client_session}, Target ${target_id}`
      );
    }
  }

  /**
   * 获取所有 VoiceTarget 配置
   */
  getAllConfigs(): VoiceTargetConfig[] {
    const result: VoiceTargetConfig[] = [];

    for (const [edge_id, edgeConfigs] of this.configs.entries()) {
      for (const [client_session, clientConfigs] of edgeConfigs.entries()) {
        for (const [target_id, config] of clientConfigs.entries()) {
          result.push({
            edge_id,
            client_session,
            target_id,
            config,
            timestamp: Date.now(),
          });
        }
      }
    }

    return result;
  }

  /**
   * 获取特定 Edge 的 VoiceTarget 配置
   */
  getEdgeConfigs( edge_id: number): VoiceTargetConfig[] {
    const result: VoiceTargetConfig[] = [];
    const edgeConfigs = this.configs.get(edge_id);

    if (edgeConfigs) {
      for (const [client_session, clientConfigs] of edgeConfigs.entries()) {
        for (const [target_id, config] of clientConfigs.entries()) {
          result.push({
            edge_id,
            client_session,
            target_id,
            config,
            timestamp: Date.now(),
          });
        }
      }
    }

    return result;
  }

  /**
   * 获取特定会话的 VoiceTarget 配置
   */
  getSessionConfigs( edge_id: number,  client_session: number): Map<number, VoiceTarget> {
    const edgeConfigs = this.configs.get(edge_id);
    if (!edgeConfigs) return new Map();

    const clientConfigs = edgeConfigs.get(client_session);
    if (!clientConfigs) return new Map();

    return new Map(clientConfigs);
  }

  /**
   * 获取 VoiceTarget 数量
   */
  getTargetCount(): number {
    let count = 0;
    for (const edgeConfigs of this.configs.values()) {
      for (const clientConfigs of edgeConfigs.values()) {
        count += clientConfigs.size;
      }
    }
    return count;
  }

  /**
   * 获取频道中的会话（用于路由决策）
   */
  getChannelSessions( channel_id: number): GlobalSession[] {
    return this.sessionManager.getChannelSessions(channel_id);
  }

  /**
   * 清理指定会话的配置
   */
  cleanupSession( edge_id: number,  client_session: number): void {
    const edgeConfigs = this.configs.get(edge_id);
    if (edgeConfigs) {
      edgeConfigs.delete(client_session);
      if (edgeConfigs.size === 0) {
        this.configs.delete(edge_id);
      }
    }
    logger.debug(`Cleaned up VoiceTarget configs for Edge ${edge_id}, Session ${client_session}`);
  }
}
