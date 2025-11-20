import WebSocket, { WebSocketServer } from 'ws';
import { RPCChannel, Message } from '../rpc/rpc-channel.js';
import { EventEmitter } from 'events';

export interface ControlChannelConfig {
  port: number;
  host?: string;
}

export class ControlChannelServer extends EventEmitter {
  private wss: any;
  private channels = new Map<any, RPCChannel>();

  constructor(config: ControlChannelConfig) {
    super();
    this.wss = new WebSocketServer({
      port: config.port,
      host: config.host,
    });

    this.wss.on('connection', this.handleConnection.bind(this));
    this.wss.on('error', (error) => {
      console.error('Control channel server error:', error);
    });
  }

  private handleConnection(ws: WebSocket): void {
    const channel = new RPCChannel(ws);
    this.channels.set(ws, channel);

    // 监听请求
    channel.on('request', (message: Message, respond: (result?: any, error?: any) => void) => {
      this.handleRequest(channel, message, respond);
    });

    // 监听通知
    channel.on('notification', (message: Message) => {
      this.handleNotification(channel, message);
    });

    // 监听断开
    channel.on('close', () => {
      this.channels.delete(ws);
      this.emit('disconnect', channel);
    });

    this.emit('connect', channel);
  }

  private handleRequest(channel: RPCChannel, message: Message, respond: (result?: any, error?: any) => void): void {
    // 转发请求到上层处理
    this.emit('request', channel, message, respond);
  }

  private handleNotification(channel: RPCChannel, message: Message): void {
    // 转发通知到上层处理
    this.emit('notification', channel, message);
  }

  /**
   * 广播通知给所有连接的客户端
   */
  broadcast(method: string, params?: any): void {
    for (const channel of this.channels.values()) {
      channel.notify(method, params);
    }
  }

  /**
   * 发送通知给特定客户端
   */
  notify(channel: RPCChannel, method: string, params?: any): void {
    channel.notify(method, params);
  }

  /**
   * 关闭服务器
   */
  close(): void {
    for (const channel of this.channels.values()) {
      channel.close();
    }
    this.channels.clear();
    this.wss.close();
  }

  /**
   * 获取连接数量
   */
  getConnectionCount(): number {
    return this.channels.size;
  }
}