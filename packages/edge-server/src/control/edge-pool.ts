/**
 * WebSocket Connection Pool
 * 
 * Manages multiple WebSocket connections for resilient communication between Edge and Hub.
 * - Each connection is independent and handles its own message stream
 * - Send operations use any available connection (load balancing)
 * - Automatic reconnection of individual connections
 * - Pool is considered "connected" if at least one connection is alive
 */

// @ts-ignore - ws types may not be available in all environments
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Logger } from '@munode/common';
import { HeartbeatManager, type HeartbeatConfig, type HeartbeatCallbacks } from '@munode/common';
import { RPCChannel, type NotificationParams, type TypedRPCRequest, type TypedRPCResponse, type TypedRPCNotification } from '@munode/protocol';

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
 * RPCChannel-like interface for ClientConnectionPool
 * This allows ClientConnectionPool to be used with TypedRPCClient
 */
interface RPCChannelLike {
  call(method: string, request: TypedRPCRequest, timeout?: number): Promise<TypedRPCResponse>;
  notify(method: string, params: TypedRPCNotification | NotificationParams): void;
  isConnected(): boolean;
}

/**
 * Client-side Connection Pool for resilient WebSocket communication from Edge to Hub
 * Manages multiple connections to the same server for load balancing and fault tolerance
 */
export class ClientConnectionPool extends EventEmitter implements RPCChannelLike {
  private config: ClientConnectionPoolConfig;
  private connections: PooledConnection[] = [];
  private nextConnectionIndex = 0; // For round-robin load balancing
  private logger?: Logger;
  private isStopping = false;
  private connectionIdCounter = 0;

  constructor(config: ClientConnectionPoolConfig) {
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
        lastReconnectTime: 0,
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
        
        // Start heartbeat if configured
        if (this.config.heartbeat) {
          this.startHeartbeatForConnection(conn);
        }
        
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
        this.logger?.warn(`Heartbeat timeout for connection ${connectionId}`);
        // Close the connection to trigger reconnection
        if (conn.ws) {
          conn.ws.close();
        }
      },
      onHeartbeat: (connectionId: string, latency: number) => {
        this.logger?.debug(`Heartbeat received for connection ${connectionId}, latency: ${latency}ms`);
      },
    };

    conn.heartbeatManager = new HeartbeatManager(callbacks, heartbeatConfig);

    conn.heartbeatManager.startSending(conn.id.toString(), async () => {
      try {
        await this.config.heartbeat!.sendHeartbeat(conn.id, conn.channel!);
      } catch (error) {
        this.logger?.error(`Failed to send heartbeat for connection ${conn.id}:`, error);
        throw error;
      }
    });
  }

  /**
   * Handle connection close
   */
  private handleConnectionClose(conn: PooledConnection): void {
    conn.isConnected = false;
    conn.channel = null;
    conn.ws = null;

    // Stop heartbeat for this connection
    if (conn.heartbeatManager) {
      conn.heartbeatManager.stop(conn.id.toString());
      conn.heartbeatManager = undefined;
    }

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
   * Schedule reconnection for a single connection with exponential backoff
   */
  private scheduleReconnect(conn: PooledConnection): void {
    if (conn.reconnectTimer || conn.isReconnecting || this.isStopping) {
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
    
    this.logger?.debug(
      `Scheduling reconnect for connection ${conn.id} (attempt ${conn.reconnectAttempts}) in ${backoffInterval}ms`
    );

    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      conn.isReconnecting = true;
      
      this.connectSingle(conn).catch((error) => {
        this.logger?.error(`Reconnection failed for connection ${conn.id}:`, error);
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
        this.logger?.debug('Retrying RPC call on another connection');
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
   */
  disconnect(): void {
    this.isStopping = true;

    for (const conn of this.connections) {
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }

      // Stop heartbeat
      if (conn.heartbeatManager) {
        conn.heartbeatManager.stop(conn.id.toString());
        conn.heartbeatManager = undefined;
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
