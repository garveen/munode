import WebSocket, { WebSocketServer } from 'ws';
import { RPCChannel, Message, NotificationParams, type TypedRPCNotification } from '@munode/protocol';
import type { Logger } from '@munode/common';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import { ServerConnectionManager, VirtualEdgeChannel } from './hub-pool.js';

export interface ControlChannelConfig {
  port: number;
  host?: string;
  logger?: Logger;
}

/**
 * ControlChannelServer 事件类型定义
 */
export interface ControlChannelServerEvents extends EventMap {
  'edgeConnected': [edgeId: number, virtualChannel: VirtualEdgeChannel];
  'edgeDisconnected': [edgeId: number];
  'disconnect': [channel: RPCChannel];
  'connect': [channel: RPCChannel];
  'request': [channel: RPCChannel, message: Message, respond: (response: unknown) => void];
  'notification': [channel: RPCChannel, message: Message];
}

export class ControlChannelServer extends TypedEventEmitter<ControlChannelServerEvents> {
  private wss: WebSocketServer;
  private channels = new Map<WebSocket, RPCChannel>();
  private edgePool: ServerConnectionManager; // Edge 连接管理器
  private ready: Promise<void>;
  private logger?: Logger;

  constructor(config: ControlChannelConfig, logger: Logger) {
    super();
    this.logger = logger;
    this.edgePool = new ServerConnectionManager(config.logger);
    
    // 转发 Edge 连接池事件
    this.edgePool.on('edgeConnected', (edgeId: number, virtualChannel: VirtualEdgeChannel) => {
      this.emit('edgeConnected', edgeId, virtualChannel);
    });
    this.edgePool.on('edgeDisconnected', (edgeId: number) => {
      this.emit('edgeDisconnected', edgeId);
    });
    
    // 创建 Promise 来跟踪服务器就绪状态
    this.ready = new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: config.port,
        host: config.host,
      });

      this.wss.on('listening', () => {
        this.logger.info(`Control channel server listening on ${config.host || '0.0.0.0'}:${config.port}`);
        resolve();
      });

      this.wss.on('connection', this.handleConnection.bind(this));
      
      this.wss.on('error', (error) => {
        this.logger.error('Control channel server error:', error);
        reject(error);
      });
    });
  }

  /**
   * 等待服务器完全就绪
   */
  async waitForReady(): Promise<void> {
    await this.ready;
  }

  private handleConnection(ws: WebSocket): void {
    const channel = new RPCChannel(ws, this.logger);
    this.channels.set(ws, channel);

    // 监听请求
    channel.on('request', (message: Message, respond: (result?: unknown, error?: unknown) => void) => {
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

  private handleRequest(channel: RPCChannel, message: Message, respond: (result?: unknown, error?: unknown) => void): void {
    // 转发请求到上层处理
    this.emit('request', channel, message, respond);
  }

  private handleNotification(channel: RPCChannel, message: Message): void {
    // 转发通知到上层处理
    this.emit('notification', channel, message);
  }

  /**
   * 注册 Edge 连接到连接池
   * 在 Edge 完成注册后调用
   */
  registerEdge(edgeId: number, channel: RPCChannel): void {
    this.edgePool.registerConnection(edgeId, channel);
  }

  /**
   * 获取 Edge 的虚拟通道
   */
  getEdgeChannel(edgeId: number): VirtualEdgeChannel | undefined {
    return this.edgePool.getEdgeChannel(edgeId);
  }

  /**
   * 获取 Edge 连接管理器（用于高级操作）
   */
  getEdgePool(): ServerConnectionManager {
    return this.edgePool;
  }

  /**
   * 广播通知给所有 Edge（每个 Edge 只发送一次，由连接池管理去重）
   */
  broadcast(method: string, params?: TypedRPCNotification | NotificationParams): void {
    this.edgePool.broadcast(method, params);
  }

  /**
   * 广播给除指定 Edge 外的所有 Edge
   */
  broadcastExcept(excludeEdgeId: number, method: string, params?: TypedRPCNotification | NotificationParams): void {
    this.edgePool.broadcastExcept(excludeEdgeId, method, params);
  }

  /**
   * 关闭服务器
   */
  close(): void {
    // 关闭所有 Edge 连接
    this.edgePool.closeAll();
    
    // 关闭所有未注册的连接
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