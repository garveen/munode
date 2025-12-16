/**
 * EdgeHubWebSocketClient - Edge 端 WebSocket 客户端
 * 
 * 用于 Edge 连接到 Hub 的 WebSocket 客户端
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { hubedge } from '../generated/proto/HubEdge';
import { PacketCodec } from './packet-codec';

export type Logger = {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
};

export interface WebSocketClientConfig {
  url: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  reconnectMaxAttempts?: number;
  heartbeatInterval?: number;
  logger?: Logger;
}

export interface WebSocketClientEvents {
  connected: () => void;
  disconnected: (code: number, reason: string) => void;
  message: (packet: hubedge.EdgeHubPacket) => void;
  error: (error: Error) => void;
  reconnecting: (attempt: number) => void;
  reconnected: () => void;
}

export declare interface EdgeHubWebSocketClient {
  on<K extends keyof WebSocketClientEvents>(
    event: K,
    listener: WebSocketClientEvents[K]
  ): this;
  emit<K extends keyof WebSocketClientEvents>(
    event: K,
    ...args: Parameters<WebSocketClientEvents[K]>
  ): boolean;
}

export class EdgeHubWebSocketClient extends EventEmitter {
  private ws?: WebSocket;
  private config: Required<WebSocketClientConfig>;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private connected = false;
  private intentionallyClosed = false;
  private logger: Logger;

  constructor(config: WebSocketClientConfig) {
    super();
    this.config = {
      reconnect: true,
      reconnectInterval: 5000,
      reconnectMaxAttempts: 10,
      heartbeatInterval: 30000,
      logger: console as Logger,
      ...config,
    };
    this.logger = this.config.logger;
  }

  /**
   * 连接到 Hub
   */
  async connect(): Promise<void> {
    if (this.ws && this.connected) {
      this.logger.warn('Already connected');
      return;
    }

    this.intentionallyClosed = false;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url);

        const onOpen = () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.logger.info('WebSocket connected', { url: this.config.url });
          
          this.ws?.removeListener('open', onOpen);
          this.ws?.removeListener('error', onError);

          this.startHeartbeat();
          this.emit('connected');
          resolve();
        };

        const onError = (error: Error) => {
          this.logger.error('WebSocket connection error', error);
          this.ws?.removeListener('open', onOpen);
          this.ws?.removeListener('error', onError);
          reject(error);
        };

        this.ws.once('open', onOpen);
        this.ws.once('error', onError);

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.handleClose(code, reason.toString());
        });

        this.ws.on('error', (error: Error) => {
          this.emit('error', error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.stopReconnect();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = undefined;
    }

    this.connected = false;
  }

  /**
   * 发送数据包
   */
  async send(packet: hubedge.EdgeHubPacket): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new Error('WebSocket not connected');
    }

    const data = PacketCodec.encode(packet);
    
    return new Promise((resolve, reject) => {
      this.ws.send(data, (error) => {
        if (error) {
          this.logger.error('Failed to send packet', error);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(data: Buffer): void {
    try {
      const packet = PacketCodec.decode(new Uint8Array(data));
      this.emit('message', packet);
    } catch (error) {
      this.logger.error('Failed to decode packet', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * 处理连接关闭
   */
  private handleClose(code: number, reason: string): void {
    this.connected = false;
    this.stopHeartbeat();

    this.logger.info('WebSocket closed', { code, reason });
    this.emit('disconnected', code, reason);

    if (!this.intentionallyClosed && this.config.reconnect) {
      this.scheduleReconnect();
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.reconnectMaxAttempts) {
      this.logger.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1);

    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(() => {
      this.connect()
        .then(() => {
          this.emit('reconnected');
        })
        .catch((error) => {
          this.logger.error('Reconnect failed', error);
          this.scheduleReconnect();
        });
    }, delay);
  }

  /**
   * 停止重连
   */
  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    // 心跳逻辑将在 RPC 层实现
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
