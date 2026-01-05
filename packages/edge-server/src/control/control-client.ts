import WebSocket from 'ws';
import { 
  RPCChannel, 
  type NotificationParams,
  TypedRPCClient,
  createTypedRPCClient,
  type RPCParams,
  type RPCResult,
  type EdgeToHubMethods
} from '@munode/protocol';
import type { Logger } from '@munode/common';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import { ClientConnectionPool, type ClientConnectionPoolConfig } from './edge-pool.js';

export interface ControlChannelClientConfig {
  host: string;
  port: number;
  tls?: boolean;
  poolSize?: number; // If > 1, use connection pool; if 1 or undefined, use single connection (backward compatible)
  reconnectInterval?: number; // For connection pool reconnection
  heartbeat?: {
    interval: number; // Heartbeat interval in ms
    sendHeartbeat: (connectionId: number, channel: RPCChannel) => Promise<void>;
  };
}

/**
 * ControlChannelClient 事件类型定义
 */
export interface ControlChannelClientEvents extends EventMap {
  'connect': [];
  'disconnect': [];
  'request': [message: { method: string; params: Record<string, unknown> }, respond: (response: Record<string, unknown>) => void];
  'notification': [message: { method: string; params: Record<string, unknown> }];
  'error': [error: Error];
}

export class ControlChannelClient extends TypedEventEmitter<ControlChannelClientEvents> {
  private ws: WebSocket | null = null;
  private channel: RPCChannel | null = null;
  private pool: ClientConnectionPool | null = null;
  private typedClient: TypedRPCClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private logger: Logger;
  private usePool: boolean;

  constructor(private config: ControlChannelClientConfig, logger: Logger) {
    super();
    this.logger = logger;
    this.usePool = (config.poolSize ?? 1) > 1;
  }

  /**
   * 连接到服务器
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.isConnected()) {
      return;
    }

    this.isConnecting = true;

    if (this.usePool) {
      return this.connectWithPool();
    } else {
      return this.connectSingle();
    }
  }

  /**
   * Connect using connection pool
   * 复用现有pool，避免创建多个实例
   */
  private async connectWithPool(): Promise<void> {
    try {
      // 如果已经有pool，直接使用（可能是重连）
      if (this.pool) {
        this.logger?.debug('Reusing existing connection pool');
        await this.pool.connect();
        this.isConnecting = false;
        return;
      }

      // 首次创建pool
      const poolConfig: ClientConnectionPoolConfig = {
        host: this.config.host,
        port: this.config.port,
        tls: this.config.tls,
        poolSize: this.config.poolSize,
        reconnectInterval: this.config.reconnectInterval,
        logger: this.logger,
        heartbeat: this.config.heartbeat,
      };

      this.pool = new ClientConnectionPool(poolConfig, this.logger);
      
      // Forward pool events
      this.pool.on('connect', () => {
        this.isConnecting = false;
        this.emit('connect');
      });

      this.pool.on('disconnect', () => {
        this.emit('disconnect');
      });

      this.pool.on('connection-established', (connId: number) => {
        this.logger?.debug(`Pool connection ${connId} established`);
      });

      this.pool.on('connection-closed', (connId: number) => {
        this.logger?.debug(`Pool connection ${connId} closed`);
      });

      // Forward request and notification events
      this.pool.on('request', (message, respond) => {
        this.emit('request', message, respond);
      });

      this.pool.on('notification', (message) => {
        this.emit('notification', message);
      });

      await this.pool.connect();
      this.isConnecting = false;
    } catch (error) {
      this.isConnecting = false;
      throw error;
    }
  }

  /**
   * Connect using single connection (backward compatible)
   */
  private async connectSingle(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = this.config.tls ? 'wss' : 'ws';
      const url = `${protocol}://${this.config.host}:${this.config.port}`;

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.channel = new RPCChannel(this.ws, this.logger);
        this.typedClient = createTypedRPCClient(this.channel);
        this.setupChannel();
        this.emit('connect');
        resolve();
      });

      this.ws.on('error', (error) => {
        this.isConnecting = false;
        this.emit('error', error);
        reject(error);
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        this.channel = null;
        this.typedClient = null;
        this.emit('disconnect');
      });
    });
  }

  private setupChannel(): void {
    if (!this.channel) return;

    // 监听请求
    this.channel.on('request', (message, respond) => {
      this.emit('request', message, respond);
    });

    // 监听通知
    this.channel.on('notification', (message) => {
      this.emit('notification', message);
    });
  }

  /**
   * 发送RPC请求 - 使用TypedRPCClient进行protobuf转换
   */
  async call<M extends EdgeToHubMethods['method']>(
    method: M,
    params?: RPCParams<M>,
    _timeout?: number
  ): Promise<RPCResult<M>> {
    if (this.usePool) {
      if (!this.pool) {
        throw new Error('Not connected');
      }
      // Pool implements RPCChannel-like interface, so we can use it with TypedRPCClient
      const typedClient = createTypedRPCClient(this.pool);
      return typedClient.call(method, params);
    } else {
      if (!this.typedClient) {
        throw new Error('Not connected');
      }
      return this.typedClient.call(method, params);
    }
  }

  /**
   * 发送通知
   */
  notify(method: string, params?: NotificationParams): void {
    if (this.usePool) {
      if (!this.pool) {
        throw new Error('Not connected');
      }
      if (params) {
        this.pool.notify(method, params);
      }
    } else {
      if (!this.channel) {
        throw new Error('Not connected');
      }
      if (params) {
        this.channel.notify(method, params);
      }
    }
  }

  /**
   * 断开连接
   * 对于pool模式，保留pool对象以便复用
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.usePool) {
      if (this.pool) {
        this.pool.disconnect();
        // 不设置为null，保留pool对象用于重连
      }
    } else {
      if (this.channel) {
        this.channel.close();
        this.channel = null;
        this.typedClient = null;
      }

      if (this.ws) {
        // 移除所有WebSocket事件监听器以防止内存泄漏
        this.ws.removeAllListeners();
        this.ws.close();
        this.ws = null;
      }
    }
    
    // 不移除EventEmitter监听器，因为可能需要重连
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    if (this.usePool) {
      return this.pool !== null && this.pool.isConnected();
    } else {
      return this.channel !== null && this.channel.isConnected();
    }
  }

  /**
   * 重新连接
   * 对于pool模式，connect会复用现有pool
   */
  async reconnect(): Promise<void> {
    if (this.usePool) {
      // Pool模式：直接重连，pool.connect会处理清理
      await this.connect();
    } else {
      // 单连接模式：需要先断开
      this.disconnect();
      await this.connect();
    }
  }

  /**
   * Get connection statistics (only available when using pool)
   */
  getConnectionStats(): {
    poolSize: number;
    connectedCount: number;
    reconnectingCount: number;
    totalReconnectAttempts: number;
  } | null {
    if (this.usePool && this.pool) {
      return this.pool.getStats();
    }
    return null;
  }
}