/**
 * 连接监控器
 *
 * 负责监控集群内连接的状态：
 * - 定期检查心跳超时
 * - 处理连接中断事件
 * - 区分不同类型的连接
 */

import { HeartbeatManager } from '../heartbeat/heartbeat-manager.js';

export enum ClusterConnectionType {
  HUB = 'hub',
  EDGE = 'edge',
  PEER = 'peer',
}

export interface ConnectionInfo {
  id: string;
  type: ClusterConnectionType;
  remoteAddress: string;
  connectedAt: number;
}

export interface ConnectionMonitorCallbacks {
  onConnectionLost: (connectionId: string, type: ClusterConnectionType) => void;
  onConnectionTimeout: (connectionId: string, type: ClusterConnectionType) => void;
}

export class ConnectionMonitor {
  private heartbeatManager: HeartbeatManager;
  private connections = new Map<string, ConnectionInfo>();
  private monitorTimer?: NodeJS.Timeout;
  private callbacks: ConnectionMonitorCallbacks;
  private checkInterval: number;

  constructor(
    heartbeatManager: HeartbeatManager,
    callbacks: ConnectionMonitorCallbacks,
    checkInterval: number = 1000
  ) {
    this.heartbeatManager = heartbeatManager;
    this.callbacks = callbacks;
    this.checkInterval = checkInterval;
  }

  /**
   * 启动连接监控
   */
  startMonitoring(): void {
    if (this.monitorTimer) {
      return; // 已经在监控中
    }

    this.monitorTimer = setInterval(() => {
      this.checkConnections();
    }, this.checkInterval);
  }

  /**
   * 停止连接监控
   */
  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
  }

  /**
   * 添加连接进行监控
   */
  addConnection(connectionId: string, type: ClusterConnectionType, remoteAddress: string): void {
    const connection: ConnectionInfo = {
      id: connectionId,
      type,
      remoteAddress,
      connectedAt: Date.now(),
    };

    this.connections.set(connectionId, connection);
  }

  /**
   * 移除连接监控
   */
  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /**
   * 检查所有连接状态
   */
  private checkConnections(): void {
    for (const [connectionId, connection] of this.connections) {
      if (this.heartbeatManager.checkTimeout(connectionId)) {
        this.handleConnectionTimeout(connectionId, connection.type);
      }
    }
  }

  /**
   * 处理连接超时
   */
  private handleConnectionTimeout(connectionId: string, type: ClusterConnectionType): void {
    // 移除连接
    this.connections.delete(connectionId);

    // 停止心跳管理
    this.heartbeatManager.stop(connectionId);

    // 调用回调
    this.callbacks.onConnectionTimeout(connectionId, type);
  }

  /**
   * 手动报告连接丢失
   */
  reportConnectionLost(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.handleConnectionTimeout(connectionId, connection.type);
      this.callbacks.onConnectionLost(connectionId, connection.type);
    }
  }

  /**
   * 获取连接信息
   */
  getConnection(connectionId: string): ConnectionInfo | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * 获取所有连接
   */
  getAllConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values());
  }

  /**
   * 获取按类型分组的连接
   */
  getConnectionsByType(): Record<ClusterConnectionType, ConnectionInfo[]> {
    const result: Record<ClusterConnectionType, ConnectionInfo[]> = {
      [ClusterConnectionType.HUB]: [],
      [ClusterConnectionType.EDGE]: [],
      [ClusterConnectionType.PEER]: [],
    };

    for (const connection of this.connections.values()) {
      result[connection.type].push(connection);
    }

    return result;
  }

  /**
   * 获取连接统计信息
   */
  getStats(): {
    total: number;
    byType: Record<ClusterConnectionType, number>;
    oldestConnection?: number;
    newestConnection?: number;
  } {
    const connections = Array.from(this.connections.values());
    const byType = this.getConnectionsByType();

    let oldestConnection: number | undefined;
    let newestConnection: number | undefined;

    for (const conn of connections) {
      if (!oldestConnection || conn.connectedAt < oldestConnection) {
        oldestConnection = conn.connectedAt;
      }
      if (!newestConnection || conn.connectedAt > newestConnection) {
        newestConnection = conn.connectedAt;
      }
    }

    return {
      total: connections.length,
      byType: {
        [ClusterConnectionType.HUB]: byType[ClusterConnectionType.HUB].length,
        [ClusterConnectionType.EDGE]: byType[ClusterConnectionType.EDGE].length,
        [ClusterConnectionType.PEER]: byType[ClusterConnectionType.PEER].length,
      },
      oldestConnection,
      newestConnection,
    };
  }

  /**
   * 清理所有连接
   */
  clear(): void {
    this.connections.clear();
  }
}