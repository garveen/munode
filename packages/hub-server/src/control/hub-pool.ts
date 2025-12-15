/**
 * Server-side Connection Manager
 * 
 * 管理 Hub Server 与各个 Edge 之间的连接
 * - 按 Edge ID 分组管理来自同一 Edge 的多个连接
 * - 通知去重：每个 Edge 只通过主连接发送一次
 * - 请求负载均衡：可以使用任意连接
 * - 封装连接细节，上层只需要知道 Edge ID
 */

import { EventEmitter } from 'events';
import type { Logger } from '@munode/common';
import { RPCChannel, type NotificationParams, type TypedRPCRequest, type TypedRPCResponse, type TypedRPCNotification } from '@munode/protocol';

interface EdgeConnectionInfo {
  edgeId: number;
  channels: RPCChannel[]; // 该 Edge 的所有连接
  primaryChannel: RPCChannel; // 用于发送通知的主连接
  lastActivity: number;
}

/**
 * 虚拟的 Edge Channel
 * 代表一个 Edge 的抽象通信通道，内部可能有多个实际连接
 */
export class VirtualEdgeChannel extends EventEmitter {
  private edgeId: number;
  private pool: ServerConnectionManager;

  constructor(edgeId: number, pool: ServerConnectionManager) {
    super();
    this.edgeId = edgeId;
    this.pool = pool;
  }

  /**
   * 发送通知（只通过主连接发送一次）
   */
  notify(method: string, params?: TypedRPCNotification | NotificationParams): void {
    this.pool.notifyEdge(this.edgeId, method, params);
  }

  /**
   * 发送请求并等待响应（可以使用任意连接）
   */
  async call(method: string, request: TypedRPCRequest, timeout?: number): Promise<TypedRPCResponse> {
    return this.pool.callEdge(this.edgeId, method, request, timeout);
  }

  /**
   * 关闭该 Edge 的所有连接
   */
  close(): void {
    this.pool.closeEdge(this.edgeId);
  }

  getEdgeId(): number {
    return this.edgeId;
  }

  /**
   * 检查该 Edge 是否有活跃连接
   */
  isConnected(): boolean {
    return this.pool.isEdgeConnected(this.edgeId);
  }
}

/**
 * Server 端连接管理器
 * 管理多个 Edge 的连接，每个 Edge 可能有多个连接
 */
export class ServerConnectionManager extends EventEmitter {
  private edges = new Map<number, EdgeConnectionInfo>(); // edgeId -> 连接信息
  private channelToEdge = new Map<RPCChannel, number>(); // channel -> edgeId 反向映射
  private logger?: Logger;

  constructor(logger?: Logger) {
    super();
    this.logger = logger;
  }

  /**
   * 注册一个新的连接
   * 当 Edge 注册完成后调用，将 channel 与 edgeId 关联
   */
  registerConnection(edgeId: number, channel: RPCChannel): void {
    this.channelToEdge.set(channel, edgeId);

    let edgeInfo = this.edges.get(edgeId);
    if (!edgeInfo) {
      // 首次连接
      edgeInfo = {
        edgeId,
        channels: [channel],
        primaryChannel: channel,
        lastActivity: Date.now(),
      };
      this.edges.set(edgeId, edgeInfo);
      
      this.logger?.info(`Edge ${edgeId} registered first connection`);
      
      // 触发 Edge 连接事件
      const virtualChannel = new VirtualEdgeChannel(edgeId, this);
      this.emit('edgeConnected', edgeId, virtualChannel);
    } else {
      // 添加到连接池
      edgeInfo.channels.push(channel);
      edgeInfo.lastActivity = Date.now();
      
      this.logger?.info(`Edge ${edgeId} added connection to pool (total: ${edgeInfo.channels.length})`);
      
      // 触发连接池扩展事件
      this.emit('poolExpanded', edgeId, edgeInfo.channels.length);
    }

    // 监听该连接的断开
    channel.on('close', () => {
      this.handleChannelClose(channel);
    });
  }

  /**
   * 处理连接断开
   */
  private handleChannelClose(channel: RPCChannel): void {
    const edgeId = this.channelToEdge.get(channel);
    if (!edgeId) {
      return;
    }

    this.channelToEdge.delete(channel);
    const edgeInfo = this.edges.get(edgeId);
    if (!edgeInfo) {
      return;
    }

    // 从连接池中移除
    const index = edgeInfo.channels.indexOf(channel);
    if (index !== -1) {
      edgeInfo.channels.splice(index, 1);
    }

    // 如果关闭的是主连接，选择新的主连接
    if (edgeInfo.primaryChannel === channel && edgeInfo.channels.length > 0) {
      edgeInfo.primaryChannel = edgeInfo.channels[0];
      this.logger?.info(`Edge ${edgeId} primary channel switched`);
    }

    this.logger?.info(`Edge ${edgeId} connection closed (remaining: ${edgeInfo.channels.length})`);

    // 如果没有连接了，移除该 Edge
    if (edgeInfo.channels.length === 0) {
      this.edges.delete(edgeId);
      this.logger?.info(`Edge ${edgeId} fully disconnected`);
      
      // 触发 Edge 断开事件
      this.emit('edgeDisconnected', edgeId);
    } else {
      // 触发连接池收缩事件
      this.emit('poolShrunk', edgeId, edgeInfo.channels.length);
    }
  }

  /**
   * 向指定 Edge 发送通知（只通过主连接发送）
   */
  notifyEdge(edgeId: number, method: string, params?: TypedRPCNotification | NotificationParams): void {
    const edgeInfo = this.edges.get(edgeId);
    if (!edgeInfo) {
      this.logger?.warn(`Cannot notify Edge ${edgeId}: not connected`);
      return;
    }

    try {
      edgeInfo.primaryChannel.notify(method, params);
      edgeInfo.lastActivity = Date.now();
    } catch (error) {
      this.logger?.error(`Failed to notify Edge ${edgeId}:`, error);
      throw error;
    }
  }

  /**
   * 向指定 Edge 发送请求（使用负载均衡选择连接）
   */
  async callEdge(
    edgeId: number,
    method: string,
    request: TypedRPCRequest,
    timeout?: number
  ): Promise<TypedRPCResponse> {
    const edgeInfo = this.edges.get(edgeId);
    if (!edgeInfo) {
      throw new Error(`Edge ${edgeId} not connected`);
    }

    // 简单的轮询负载均衡：选择活跃度最低的连接
    // 可以改进为更复杂的算法
    const channel = this.selectChannelForRequest(edgeInfo);

    try {
      const response = await channel.call(method, request, timeout);
      edgeInfo.lastActivity = Date.now();
      return response;
    } catch (error) {
      this.logger?.error(`Failed to call Edge ${edgeId}:`, error);
      throw error;
    }
  }

  /**
   * 选择一个连接用于发送请求（负载均衡）
   */
  private selectChannelForRequest(edgeInfo: EdgeConnectionInfo): RPCChannel {
    // 简单策略：使用主连接
    // 可以改进为：
    // - 轮询
    // - 最少活跃连接
    // - 响应时间最优
    return edgeInfo.primaryChannel;
  }

  /**
   * 广播通知给所有 Edge（每个 Edge 只发送一次）
   */
  broadcast(method: string, params?: TypedRPCNotification | NotificationParams): void {
    const results: Array<{ edgeId: number; success: boolean; error?: Error }> = [];
    
    for (const [edgeId, edgeInfo] of this.edges.entries()) {
      try {
        edgeInfo.primaryChannel.notify(method, params);
        edgeInfo.lastActivity = Date.now();
        results.push({ edgeId, success: true });
      } catch (error) {
        this.logger?.error(`Failed to broadcast to Edge ${edgeId}:`, error);
        results.push({ edgeId, success: false, error: error as Error });
      }
    }

    // 触发广播完成事件，包含结果统计
    this.emit('broadcastComplete', {
      method,
      totalEdges: this.edges.size,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  }

  /**
   * 广播给除指定 Edge 外的所有 Edge
   */
  broadcastExcept(excludeEdgeId: number, method: string, params?: TypedRPCNotification | NotificationParams): void {
    for (const [edgeId, edgeInfo] of this.edges.entries()) {
      if (edgeId === excludeEdgeId) {
        continue;
      }

      try {
        edgeInfo.primaryChannel.notify(method, params);
        edgeInfo.lastActivity = Date.now();
      } catch (error) {
        this.logger?.error(`Failed to broadcast to Edge ${edgeId}:`, error);
      }
    }
  }

  /**
   * 关闭指定 Edge 的所有连接
   */
  closeEdge(edgeId: number): void {
    const edgeInfo = this.edges.get(edgeId);
    if (!edgeInfo) {
      return;
    }

    for (const channel of edgeInfo.channels) {
      try {
        channel.close();
      } catch (error) {
        this.logger?.warn(`Error closing channel for Edge ${edgeId}:`, error);
      }
    }

    this.edges.delete(edgeId);
    this.logger?.info(`Edge ${edgeId} closed`);
  }

  /**
   * 关闭所有连接
   */
  closeAll(): void {
    for (const edgeId of this.edges.keys()) {
      this.closeEdge(edgeId);
    }
  }

  /**
   * 获取虚拟 Edge Channel
   */
  getEdgeChannel(edgeId: number): VirtualEdgeChannel | undefined {
    if (!this.edges.has(edgeId)) {
      return undefined;
    }
    return new VirtualEdgeChannel(edgeId, this);
  }

  /**
   * 获取所有已连接的 Edge ID
   */
  getConnectedEdges(): number[] {
    return Array.from(this.edges.keys());
  }

  /**
   * 检查 Edge 是否已连接
   */
  isEdgeConnected(edgeId: number): boolean {
    return this.edges.has(edgeId);
  }

  /**
   * 获取 Edge 的连接数
   */
  getEdgeConnectionCount(edgeId: number): number {
    const edgeInfo = this.edges.get(edgeId);
    return edgeInfo ? edgeInfo.channels.length : 0;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalEdges: number;
    totalConnections: number;
    edgeStats: Array<{
      edgeId: number;
      connections: number;
      lastActivity: number;
    }>;
  } {
    const edgeStats = Array.from(this.edges.entries()).map(([edgeId, info]) => ({
      edgeId,
      connections: info.channels.length,
      lastActivity: info.lastActivity,
    }));

    return {
      totalEdges: this.edges.size,
      totalConnections: Array.from(this.edges.values()).reduce((sum, info) => sum + info.channels.length, 0),
      edgeStats,
    };
  }
}
