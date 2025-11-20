/**
 * Edge连接管理器
 *
 * 管理Hub与Edge服务器的连接：
 * - 跟踪Edge连接状态
 * - 处理断开和重连逻辑
 * - 集成消息缓存机制
 * - 提供连接监控和统计
 */

import { RPCChannel, Message } from '@munode/protocol';
import { MessageCache } from './message-cache.js';

export interface EdgeConnection {
  edgeId: number;
  channel: RPCChannel;
  connectedAt: number;
  lastHeartbeat: number;
  stats: EdgeStats;
}

export interface EdgeStats {
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  reconnectCount: number;
}

export interface EdgeManagerCallbacks {
  onEdgeConnected: (edgeId: number, channel: RPCChannel) => void;
  onEdgeDisconnected: (edgeId: number, reason?: string) => void;
  onEdgeReconnected: (edgeId: number, channel: RPCChannel) => void;
}

export class EdgeManager {
  private connections = new Map<number, EdgeConnection>();
  private messageCache: MessageCache;
  private callbacks: EdgeManagerCallbacks;

  constructor(messageCache: MessageCache, callbacks: EdgeManagerCallbacks) {
    this.messageCache = messageCache;
    this.callbacks = callbacks;
  }

  /**
   * 添加Edge连接
   */
  addConnection(edgeId: number, channel: RPCChannel): void {
    const existing = this.connections.get(edgeId);

    if (existing) {
      // 重连情况
      existing.channel = channel;
      existing.connectedAt = Date.now();
      existing.lastHeartbeat = Date.now();
      existing.stats.reconnectCount++;

      // 发送缓存的消息
      this.sendCachedMessages(edgeId, channel);

      // 通知重连
      this.callbacks.onEdgeReconnected(edgeId, channel);
    } else {
      // 新连接
      const connection: EdgeConnection = {
        edgeId,
        channel,
        connectedAt: Date.now(),
        lastHeartbeat: Date.now(),
        stats: {
          messagesSent: 0,
          messagesReceived: 0,
          bytesSent: 0,
          bytesReceived: 0,
          reconnectCount: 0,
        },
      };

      this.connections.set(edgeId, connection);

      // 通知新连接
      this.callbacks.onEdgeConnected(edgeId, channel);
    }
  }

  /**
   * 移除Edge连接
   */
  removeConnection(edgeId: number, reason?: string): void {
    const connection = this.connections.get(edgeId);
    if (connection) {
      this.connections.delete(edgeId);
      this.callbacks.onEdgeDisconnected(edgeId, reason);
    }
  }

  /**
   * 获取Edge连接
   */
  getConnection(edgeId: number): EdgeConnection | undefined {
    return this.connections.get(edgeId);
  }

  /**
   * 获取所有连接
   */
  getAllConnections(): EdgeConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * 检查Edge是否连接
   */
  isConnected(edgeId: number): boolean {
    return this.connections.has(edgeId);
  }

  /**
   * 更新心跳时间
   */
  updateHeartbeat(edgeId: number): void {
    const connection = this.connections.get(edgeId);
    if (connection) {
      connection.lastHeartbeat = Date.now();
    }
  }

  /**
   * 更新统计信息
   */
  updateStats(edgeId: number, sent: boolean, bytes: number): void {
    const connection = this.connections.get(edgeId);
    if (connection) {
      if (sent) {
        connection.stats.messagesSent++;
        connection.stats.bytesSent += bytes;
      } else {
        connection.stats.messagesReceived++;
        connection.stats.bytesReceived += bytes;
      }
    }
  }

  /**
   * 广播消息给所有连接的Edge
   */
  broadcast(message: Message, excludeEdge?: number): void {
    const connectedEdges = new Set<number>();

    for (const [edgeId, connection] of this.connections) {
      if (edgeId === excludeEdge) continue;

      connectedEdges.add(edgeId);

      try {
        connection.channel.notify(message.method, message.params);
        this.updateStats(edgeId, true, JSON.stringify(message).length);
      } catch (error) {
        console.warn(`Failed to send message to edge ${edgeId}:`, error);
      }
    }

    // 缓存消息给断开的Edge
    this.messageCache.broadcastMessage({
      id: message.id || '',
      type: message.type,
      method: message.method,
      params: message.params,
      timestamp: message.timestamp,
    }, connectedEdges);
  }

  /**
   * 发送消息给指定Edge
   */
  sendToEdge(edgeId: number, message: Message): boolean {
    const connection = this.connections.get(edgeId);
    if (!connection) {
      return false;
    }

    try {
      connection.channel.notify(message.method, message.params);
      this.updateStats(edgeId, true, JSON.stringify(message).length);
      return true;
    } catch (error) {
      console.warn(`Failed to send message to edge ${edgeId}:`, error);
      return false;
    }
  }

  /**
   * 发送缓存的消息给Edge
   */
  private sendCachedMessages(edgeId: number, channel: RPCChannel): void {
    const cachedMessages = this.messageCache.getAndClearCache(edgeId);

    if (cachedMessages.length > 0) {
      console.info(`Sending ${cachedMessages.length} cached messages to edge ${edgeId}`);

      for (const message of cachedMessages) {
        try {
          channel.notify(message.method, message.params);
          this.updateStats(edgeId, true, JSON.stringify(message).length);
        } catch (error) {
          console.warn(`Failed to send cached message to edge ${edgeId}:`, error);
        }
      }
    }
  }

  /**
   * 获取连接统计信息
   */
  getStats(): {
    totalConnections: number;
    connectedEdges: number[];
    totalMessagesSent: number;
    totalMessagesReceived: number;
    totalBytesSent: number;
    totalBytesReceived: number;
    cacheStats: any;
  } {
    let totalMessagesSent = 0;
    let totalMessagesReceived = 0;
    let totalBytesSent = 0;
    let totalBytesReceived = 0;
    const connectedEdges: number[] = [];

    for (const connection of this.connections.values()) {
      connectedEdges.push(connection.edgeId);
      totalMessagesSent += connection.stats.messagesSent;
      totalMessagesReceived += connection.stats.messagesReceived;
      totalBytesSent += connection.stats.bytesSent;
      totalBytesReceived += connection.stats.bytesReceived;
    }

    return {
      totalConnections: this.connections.size,
      connectedEdges,
      totalMessagesSent,
      totalMessagesReceived,
      totalBytesSent,
      totalBytesReceived,
      cacheStats: this.messageCache.getStats(),
    };
  }

  /**
   * 获取Edge统计信息
   */
  getEdgeStats(edgeId: number): EdgeStats | undefined {
    const connection = this.connections.get(edgeId);
    return connection?.stats;
  }

  /**
   * 清理所有连接
   */
  clear(): void {
    for (const [edgeId] of this.connections) {
      this.callbacks.onEdgeDisconnected(edgeId, 'manager shutdown');
    }
    this.connections.clear();
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    this.clear();
    this.messageCache.destroy();
  }
}