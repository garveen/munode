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
import { EventEmitter } from 'events';
import type { Logger } from '@munode/common';
import { RPCChannel } from '../rpc/rpc-channel.js';
import type { hubedgeRpc } from '../generated/proto/HubEdgeRPC.js';
import type { NotificationParams } from '../rpc/rpc-channel.js';

export interface ConnectionPoolConfig {
  host: string;
  port: number;
  tls?: boolean;
  poolSize?: number; // Default: 2
  reconnectInterval?: number; // Default: 5000ms
  logger?: Logger;
}

interface PooledConnection {
  id: number;
  ws: WebSocket | null;
  channel: RPCChannel | null;
  isConnected: boolean;
  isReconnecting: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
}

/**
 * RPCChannel-like interface for ConnectionPool
 * This allows ConnectionPool to be used with TypedRPCClient
 */
interface RPCChannelLike {
  call(method: string, request: hubedgeRpc.TypedRPCRequest, timeout?: number): Promise<hubedgeRpc.TypedRPCResponse>;
  notify(method: string, params: hubedgeRpc.TypedRPCNotification | NotificationParams): void;
  isConnected(): boolean;
}

/**
 * Connection Pool for resilient WebSocket communication
 */
export class ConnectionPool extends EventEmitter implements RPCChannelLike {
  private config: ConnectionPoolConfig;
  private connections: PooledConnection[] = [];
  private nextConnectionIndex = 0; // For round-robin load balancing
  private logger?: Logger;
  private isStopping = false;
  private connectionIdCounter = 0;

  constructor(config: ConnectionPoolConfig) {
    super();
    this.config = {
      poolSize: 2,
      reconnectInterval: 5000,
      ...config,
    };
    this.logger = config.logger;
  }

  /**
   * Initialize and connect all connections in the pool
   */
  async connect(): Promise<void> {
    if (this.connections.length > 0) {
      this.logger?.warn('Connection pool already initialized');
      return;
    }

    this.isStopping = false;
    const poolSize = this.config.poolSize!;

    this.logger?.info(`Initializing connection pool with ${poolSize} connections`);

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
      };
      this.connections.push(conn);
    }

    // Connect all in parallel
    const connectPromises = this.connections.map((conn) => 
      this.connectSingle(conn).catch((error) => {
        this.logger?.error(`Failed to connect connection ${conn.id}:`, error);
      })
    );

    await Promise.allSettled(connectPromises);

    // Check if at least one connection succeeded
    if (!this.isConnected()) {
      throw new Error('Failed to establish any connections in pool');
    }

    this.logger?.info(`Connection pool initialized with ${this.getConnectedCount()}/${poolSize} connections`);
  }

  /**
   * Connect a single connection
   */
  private async connectSingle(conn: PooledConnection): Promise<void> {
    if (this.isStopping) {
      return;
    }

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
        
        this.logger?.info(`Connection ${conn.id} established`);
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
        this.logger?.error(`Connection ${conn.id} error:`, error);
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        reject(error);
      };

      ws.once('open', onOpen);
      ws.once('error', onError);

      ws.on('close', () => {
        this.handleConnectionClose(conn);
      });
    });
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
   * Handle connection close
   */
  private handleConnectionClose(conn: PooledConnection): void {
    conn.isConnected = false;
    conn.channel = null;
    conn.ws = null;

    this.logger?.info(`Connection ${conn.id} closed`);
    this.emit('connection-closed', conn.id);

    // Check if all connections are closed
    if (!this.isConnected()) {
      this.logger?.warn('All connections in pool are closed');
      this.emit('disconnect');
    }

    // Schedule reconnection if not stopping
    if (!this.isStopping) {
      this.scheduleReconnect(conn);
    }
  }

  /**
   * Schedule reconnection for a single connection
   */
  private scheduleReconnect(conn: PooledConnection): void {
    if (conn.reconnectTimer || conn.isReconnecting || this.isStopping) {
      return;
    }

    conn.reconnectAttempts++;
    this.logger?.debug(`Scheduling reconnect for connection ${conn.id} (attempt ${conn.reconnectAttempts})`);

    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      conn.isReconnecting = true;
      
      this.connectSingle(conn).catch((error) => {
        this.logger?.error(`Reconnection failed for connection ${conn.id}:`, error);
        // Will schedule another reconnect via handleConnectionClose
      });
    }, this.config.reconnectInterval);
  }

  /**
   * Send RPC call using an available connection
   */
  async call(method: string, request: hubedgeRpc.TypedRPCRequest, timeout?: number): Promise<hubedgeRpc.TypedRPCResponse> {
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
        this.logger?.debug('Retrying RPC call on another connection');
        return await retryChannel.call(method, request, timeout);
      }
      throw error;
    }
  }

  /**
   * Send notification using an available connection
   */
  notify(method: string, params: hubedgeRpc.TypedRPCNotification | NotificationParams): void {
    const channel = this.getNextAvailableChannel();
    if (!channel) {
      this.logger?.warn(`Cannot send notification ${method}: no available connections`);
      return;
    }

    try {
      channel.notify(method, params);
    } catch (error) {
      this.logger?.error(`Failed to send notification ${method}:`, error);
      // Try another connection
      const retryChannel = this.getNextAvailableChannel();
      if (retryChannel && retryChannel !== channel) {
        try {
          retryChannel.notify(method, params);
        } catch (retryError) {
          this.logger?.error(`Retry notification also failed:`, retryError);
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
      .map(conn => conn.channel!);

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
   */
  disconnect(): void {
    this.isStopping = true;

    for (const conn of this.connections) {
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }

      if (conn.channel) {
        conn.channel.close();
        conn.channel = null;
      }

      if (conn.ws) {
        conn.ws.removeAllListeners();
        conn.ws.close();
        conn.ws = null;
      }

      conn.isConnected = false;
      conn.isReconnecting = false;
    }

    this.connections = [];
    this.removeAllListeners();
    
    this.logger?.info('Connection pool disconnected');
  }

  /**
   * Force reconnect all connections
   */
  async reconnectAll(): Promise<void> {
    this.logger?.info('Forcing reconnect of all connections');
    
    // Disconnect all
    for (const conn of this.connections) {
      if (conn.ws) {
        conn.ws.close();
      }
    }

    // Wait a bit for clean shutdown
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Reconnect all
    const reconnectPromises = this.connections.map(conn => 
      this.connectSingle(conn).catch(error => {
        this.logger?.error(`Reconnection failed for connection ${conn.id}:`, error);
      })
    );

    await Promise.allSettled(reconnectPromises);
  }
}
