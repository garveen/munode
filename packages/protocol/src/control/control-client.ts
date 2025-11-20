import WebSocket from 'ws';
import { RPCChannel } from '../rpc/rpc-channel.js';
import { EventEmitter } from 'events';

export interface ControlChannelClientConfig {
  host: string;
  port: number;
  tls?: boolean;
}

export class ControlChannelClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private channel: RPCChannel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;

  constructor(private config: ControlChannelClientConfig) {
    super();
  }

  /**
   * 连接到服务器
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.isConnected()) {
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      const protocol = this.config.tls ? 'wss' : 'ws';
      const url = `${protocol}://${this.config.host}:${this.config.port}`;

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.channel = new RPCChannel(this.ws!);
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
   * 发送RPC请求
   */
  async call(method: string, params?: any, timeout?: number): Promise<any> {
    if (!this.channel) {
      throw new Error('Not connected');
    }
    return this.channel.call(method, params, timeout);
  }

  /**
   * 发送通知
   */
  notify(method: string, params?: any): void {
    if (!this.channel) {
      throw new Error('Not connected');
    }
    this.channel.notify(method, params);
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.channel !== null && this.channel.isConnected();
  }

  /**
   * 重新连接
   */
  async reconnect(): Promise<void> {
    this.disconnect();
    await this.connect();
  }
}