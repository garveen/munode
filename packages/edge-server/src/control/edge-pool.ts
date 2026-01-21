/**
 * WebSocket Connection Pool
 * 
 * Manages multiple WebSocket connections for resilient communication between Edge and Hub.
 * - Each connection is independent and handles its own message stream
 * - Send operations use any available connection (load balancing)
 * - Automatic reconnection of individual connections
 * - Pool is considered "connected" if at least one connection is alive
 */

import WebSocket from 'ws';
import type { Logger } from '@munode/common';
import { TypedEventEmitter, type EventMap, HeartbeatManager, type HeartbeatConfig, type HeartbeatCallbacks } from '@munode/common';
import { RPCChannel, type NotificationParams, type TypedRPCRequest, type TypedRPCResponse, type TypedRPCNotification, IRPCChannel } from '@munode/protocol';

export interface ClientConnectionPoolConfig {
  host: string;
  port: number;
  tls?: boolean;
  poolSize?: number; // Default: 2
  reconnectInterval?: number; // Default: 5000ms
  logger?: Logger;
  heartbeat?: {
    interval: number; // Heartbeat interval in ms
    sendHeartbeat: (connectionId: number, channel: RPCChannel) => Promise<void>;
  };
}

interface PooledConnection {
  id: number;
  ws: WebSocket | null;
  channel: RPCChannel | null;
  isConnected: boolean;
  isReconnecting: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  lastReconnectTime: number; // For exponential backoff calculation
  heartbeatManager?: HeartbeatManager;
}

/**
 * ClientConnectionPool 事件类型定义
 */
export interface ClientConnectionPoolEvents extends EventMap {
  'connection-established': [connectionId: number];
  'connect': [];
  'request': [message: { method: string; params: Record<string, unknown> }, respond: (response: Record<string, unknown>) => void];
  'notification': [message: { method: string; params: Record<string, unknown> }];
  'connection-closed': [connectionId: number];
  'disconnect': [];
}

/**
 * Client-side Connection Pool for resilient WebSocket communication from Edge to Hub
 * Manages multiple connections to the same server for load balancing and fault tolerance
 */
export class ClientConnectionPool extends TypedEventEmitter<ClientConnectionPoolEvents> implements IRPCChannel {
  private config: ClientConnectionPoolConfig;
  private connections: PooledConnection[] = [];
  private nextConnectionIndex = 0; // For round-robin load balancing
  private logger?: Logger;
  private isStopping = false;
  private connectionIdCounter = 0;

  constructor(config: ClientConnectionPoolConfig, logger: Logger) {
    super();
    this.config = {
      poolSize: 2,
      reconnectInterval: 5000,
      ...config,
    };
    this.logger = logger;
  }

  /**
   * Initialize and connect all connections in the pool
   */
  async connect(): Promise<void> {
    // 重置停止标志，允许连接和重连
    this.isStopping = false;
    
    // 如果已经有连接，先清理
    if (this.connections.length > 0) {
      this.logger.warn(`Connection pool already has ${this.connections.length} connections, cleaning up before reconnecting`);
      // 清理所有现有连接
      for (const conn of this.connections) {
        this.cleanupConnection(conn);
      }
      this.connections = []; // 清空数组，准备重新创建
      this.connectionIdCounter = 0; // 重置计数器
    }
    const poolSize = this.config.poolSize!;

    this.logger.info(`Initializing connection pool with ${poolSize} connections`);

    // Create all connections
    for (let i = 0; i < poolSize; i++) {
      const connId = ++this.connectionIdCounter;
      const conn: PooledConnection = {
        id: connId,
        ws: null,
        channel: null,
        isConnected: false,
        isReconnecting: false,
        reconnectTimer: null,
        reconnectAttempts: 0,
        lastReconnectTime: 0,
      };
      this.connections.push(conn);
    }

    // Connect all in parallel
    const connectPromises = this.connections.map((conn) => 
      this.connectSingle(conn).catch((error) => {
        this.logger.error(`Failed to connect connection ${conn.id}:`, error);
      })
    );

    await Promise.allSettled(connectPromises);

    // Check if at least one connection succeeded
    if (!this.isConnected()) {
      throw new Error('Failed to establish any connections in pool');
    }

    this.logger.info(`Connection pool initialized with ${this.getConnectedCount()}/${poolSize} connections`);
  }

  /**
   * Connect a single connection
   * 复用连接对象，每次重连前彻底清理旧资源
   */
  private async connectSingle(conn: PooledConnection): Promise<void> {
    if (this.isStopping) {
      return;
    }

    // 彻底清理旧资源，确保干净的重连
    this.cleanupConnection(conn);

    const protocol = this.config.tls ? 'wss' : 'ws';
    const url = `${protocol}://${this.config.host}:${this.config.port}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      conn.ws = ws;

      const onOpen = () => {
        conn.isConnected = true;
        conn.isReconnecting = false;
        conn.reconnectAttempts = 0;
        conn.channel = new RPCChannel(ws, this.logger);
        this.setupChannelHandlers(conn);
        
        // Start heartbeat if configured
        if (this.config.heartbeat) {
          this.startHeartbeatForConnection(conn);
        }
        
        this.logger.info(`Connection ${conn.id} established`);
        this.emit('connection-established', conn.id);
        
        // Emit 'connect' only if this is the first connection
        if (this.getConnectedCount() === 1) {
          this.emit('connect');
        }
        
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        resolve();
      };

      const onError = (error: Error) => {
        this.logger.error(`Connection ${conn.id} error:`, error);
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        reject(error);
      };

      ws.once('open', onOpen);
      ws.once('error', onError);

      // 使用 once 避免事件监听器累积（close 只会触发一次）
      // 注意：虽然 close 只触发一次，但重连时会创建新的 ws 对象，所以这里改用 once 更安全
      ws.once('close', () => {
        this.handleConnectionClose(conn);
      });
    });
  }

  /**
   * 彻底清理连接的所有资源
   */
  private cleanupConnection(conn: PooledConnection): void {
    // 停止心跳
    if (conn.heartbeatManager) {
      conn.heartbeatManager.stop(conn.id.toString());
      conn.heartbeatManager = undefined;
    }

    // 清理定时器（必须在状态重置前清理，避免定时器回调访问错误状态）
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }

    // 关闭channel（先移除事件监听器，再关闭）
    if (conn.channel) {
      try {
        conn.channel.removeAllListeners();
        conn.channel.close();
      } catch (error) {
        this.logger?.debug(`Error closing channel ${conn.id}:`, error);
      }
      conn.channel = null;
    }

    // 关闭WebSocket（先移除所有监听器，避免 close 事件触发重连）
    if (conn.ws) {
      try {
        conn.ws.removeAllListeners();
        if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
          conn.ws.close();
        }
      } catch (error) {
        this.logger?.debug(`Error closing WebSocket ${conn.id}:`, error);
      }
      conn.ws = null;
    }

    // 重置所有状态标志
    conn.isConnected = false;
    conn.isReconnecting = false;
  }

  /**
   * Setup handlers for a channel
   */
  private setupChannelHandlers(conn: PooledConnection): void {
    if (!conn.channel) return;

    // Forward all channel events to pool listeners
    conn.channel.on('request', (message, respond) => {
      this.emit('request', message, respond);
    });

    conn.channel.on('notification', (message) => {
      this.emit('notification', message);
    });

    conn.channel.on('close', () => {
      // Already handled by WebSocket close event
    });
  }

  /**
   * Start heartbeat for a specific connection
   */
  private startHeartbeatForConnection(conn: PooledConnection): void {
    if (!conn.channel || !this.config.heartbeat) return;

    const heartbeatConfig: HeartbeatConfig = {
      interval: this.config.heartbeat.interval,
      timeout: this.config.heartbeat.interval * 3, // Timeout is 3x interval
      maxRetries: 3,
    };

    const callbacks: HeartbeatCallbacks = {
      onTimeout: (connectionId: string) => {
        this.logger.warn(`Heartbeat timeout for connection ${connectionId}`);
        // 关闭连接会自动触发清理和重连
        if (conn.ws) {
          conn.ws.close();
        }
      },
      onHeartbeat: (connectionId: string, latency: number) => {
        this.logger.debug(`Heartbeat for connection ${connectionId}, latency: ${latency}ms`);
      },
    };

    conn.heartbeatManager = new HeartbeatManager(callbacks, heartbeatConfig);

    conn.heartbeatManager.startSending(conn.id.toString(), async () => {
      await this.config.heartbeat!.sendHeartbeat(conn.id, conn.channel!);
    });
  }

  /**
   * Handle connection close
   */
  private handleConnectionClose(conn: PooledConnection): void {
    this.logger.info(`Connection ${conn.id} closed (isStopping: ${this.isStopping})`);
    
    // 如果连接池正在停止，直接返回，不做任何处理
    if (this.isStopping) {
      this.logger.debug(`Ignoring close event for connection ${conn.id} - pool is stopping`);
      return;
    }
    
    // 标记连接已断开
    conn.isConnected = false;
    
    // 清理资源（但不清理 ws，因为已经关闭了）
    conn.channel = null;
    conn.ws = null;

    // Stop heartbeat for this connection
    if (conn.heartbeatManager) {
      conn.heartbeatManager.stop(conn.id.toString());
      conn.heartbeatManager = undefined;
    }

    this.emit('connection-closed', conn.id);

    // Check if all connections are closed
    if (!this.isConnected()) {
      this.logger.warn('All connections in pool are closed');
      this.emit('disconnect');
    }

    // Schedule reconnection if not stopping and not already scheduled
    if (!this.isStopping && !conn.isReconnecting && !conn.reconnectTimer) {
      this.scheduleReconnect(conn);
    }
  }

  /**
   * Schedule reconnection for a single connection with exponential backoff
   */
  private scheduleReconnect(conn: PooledConnection): void {
    // 多重检查确保不会在已停止或已在重连中的连接上调度
    if (this.isStopping) {
      this.logger.debug(`Not scheduling reconnect for connection ${conn.id} - pool is stopping`);
      return;
    }
    
    if (conn.reconnectTimer) {
      this.logger.debug(`Connection ${conn.id} already has pending reconnect timer`);
      return;
    }
    
    if (conn.isReconnecting) {
      this.logger.debug(`Connection ${conn.id} is already reconnecting`);
      return;
    }

    conn.reconnectAttempts++;
    conn.lastReconnectTime = Date.now();
    
    // Exponential backoff: baseInterval * (2 ^ attempts), capped at maxInterval
    const baseInterval = this.config.reconnectInterval || 5000;
    const maxInterval = 60000; // Maximum 60 seconds between retries
    const backoffInterval = Math.min(
      baseInterval * Math.pow(2, Math.min(conn.reconnectAttempts - 1, 5)),
      maxInterval
    );
    
    this.logger.debug(
      `Scheduling reconnect for connection ${conn.id} (attempt ${conn.reconnectAttempts}) in ${backoffInterval}ms`
    );

    conn.reconnectTimer = setTimeout(() => {
      // 再次检查是否已停止
      if (this.isStopping) {
        this.logger.debug(`Aborting reconnect for connection ${conn.id} - pool stopped`);
        conn.reconnectTimer = null;
        return;
      }
      
      conn.reconnectTimer = null;
      conn.isReconnecting = true;
      
      this.connectSingle(conn).catch((error) => {
        this.logger.error(`Reconnection failed for connection ${conn.id}:`, error);
        // Will schedule another reconnect via handleConnectionClose
      });
    }, backoffInterval);
  }

  /**
   * Send RPC call using an available connection
   */
  async call(method: string, request: TypedRPCRequest, timeout?: number): Promise<TypedRPCResponse> {
    const channel = this.getNextAvailableChannel();
    if (!channel) {
      throw new Error('No available connections in pool');
    }

    try {
      return await channel.call(method, request, timeout);
    } catch (error) {
      // If the call fails due to connection issue, try another connection
      const retryChannel = this.getNextAvailableChannel();
      if (retryChannel && retryChannel !== channel) {
        this.logger.debug('Retrying RPC call on another connection');
        return await retryChannel.call(method, request, timeout);
      }
      throw error;
    }
  }

  /**
   * Send notification using an available connection
   */
  notify(method: string, params: TypedRPCNotification | NotificationParams): void {
    const channel = this.getNextAvailableChannel();
    if (!channel) {
      this.logger.warn(`Cannot send notification ${method}: no available connections`);
      return;
    }

    try {
      channel.notify(method, params);
    } catch (error) {
      this.logger.error(`Failed to send notification ${method}:`, error);
      // Try another connection
      const retryChannel = this.getNextAvailableChannel();
      if (retryChannel && retryChannel !== channel) {
        try {
          retryChannel.notify(method, params);
        } catch (retryError) {
          this.logger.error(`Retry notification also failed:`, retryError);
        }
      }
    }
  }

  /**
   * Get next available channel using round-robin
   */
  private getNextAvailableChannel(): RPCChannel | null {
    const connectedChannels = this.connections
      .filter(conn => conn.isConnected && conn.channel)
      .map(conn => conn.channel)
      .filter((channel): channel is RPCChannel => channel !== null);

    if (connectedChannels.length === 0) {
      return null;
    }

    // Round-robin selection
    const channel = connectedChannels[this.nextConnectionIndex % connectedChannels.length];
    this.nextConnectionIndex = (this.nextConnectionIndex + 1) % connectedChannels.length;
    
    return channel;
  }

  /**
   * Check if pool has at least one connected connection
   */
  isConnected(): boolean {
    return this.connections.some(conn => conn.isConnected);
  }

  /**
   * Get count of connected connections
   */
  getConnectedCount(): number {
    return this.connections.filter(conn => conn.isConnected).length;
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    poolSize: number;
    connectedCount: number;
    reconnectingCount: number;
    totalReconnectAttempts: number;
  } {
    return {
      poolSize: this.connections.length,
      connectedCount: this.getConnectedCount(),
      reconnectingCount: this.connections.filter(conn => conn.isReconnecting).length,
      totalReconnectAttempts: this.connections.reduce((sum, conn) => sum + conn.reconnectAttempts, 0),
    };
  }

  /**
   * Disconnect all connections
   * 只清理连接资源，保留连接对象用于未来重连
   */
  disconnect(): void {
    this.logger.info(`Disconnecting connection pool (${this.connections.length} connections)`);
    this.isStopping = true;

    // 清理所有连接但保留对象
    for (const conn of this.connections) {
      this.cleanupConnection(conn);
    }

    // 不移除 EventEmitter 监听器，因为可能需要重连
    // 上层代码（如 EdgeControlClient）依赖这些事件
    this.logger.info('Connection pool disconnected (connections preserved for reuse)');
  }

  /**
   * Force reconnect all connections
   * 复用现有连接对象进行重连
   */
  async reconnectAll(): Promise<void> {
    this.logger.info('Forcing reconnect of all connections');
    this.isStopping = false; // 允许重连
    
    // 关闭所有现有连接
    for (const conn of this.connections) {
      this.cleanupConnection(conn);
    }

    // 重连所有连接（复用对象）
    const reconnectPromises = this.connections.map(conn => 
      this.connectSingle(conn).catch(error => {
        this.logger.error(`Reconnection failed for connection ${conn.id}:`, error);
      })
    );

    await Promise.allSettled(reconnectPromises);
    this.logger.info(`Reconnected ${this.getConnectedCount()}/${this.connections.length} connections`);
  }
}
