/**
 * Edge连接接口
 * 
 * 定义Edge间连接的统一接口，支持UDP和TCP实现
 */

import type { EventMap, TypedEventEmitter } from '@munode/common';
import type { ConnectionStatus, ConnectionQualityMetrics } from './connection-types.js';

/**
 * Edge连接事件类型
 */
export interface EdgeConnectionEvents extends EventMap {
  'connected': [];
  'disconnected': [reason?: string];
  'error': [error: Error];
  'data': [data: Buffer, timestamp: number];
  'reconnecting': [attempt: number];
}

/**
 * Edge连接接口
 * 
 * 抽象了Edge间的连接，不关心底层使用UDP还是TCP
 */
export interface IEdgeConnection extends TypedEventEmitter<EdgeConnectionEvents> {
  /** Edge ID */
  readonly edgeId: number;
  
  /** 是否已连接 */
  readonly isConnected: boolean;
  
  /** 连接类型 */
  readonly type: 'udp' | 'tcp';
  
  /**
   * 建立连接
   */
  connect(): Promise<void>;
  
  /**
   * 关闭连接
   */
  close(): void;
  
  /**
   * 发送数据
   * @param data 要发送的数据
   */
  send(data: Buffer): Promise<void>;
  
  /**
   * 获取连接状态
   */
  getStatus(): ConnectionStatus;
  
  /**
   * 获取连接质量指标
   */
  getQualityMetrics(): ConnectionQualityMetrics;
  
  /**
   * 更新最后活跃时间
   */
  updateLastSeen(): void;
}
