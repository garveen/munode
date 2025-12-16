/**
 * EdgeHubWebSocketServer - Hub 端 WebSocket 服务器
 * 
 * 用于 Hub 接受来自 Edge 的 WebSocket 连接
 */

import { Server as HTTPServer } from 'http';
import { Server as HTTPSServer } from 'https';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerOptions } from 'ws';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import { hubedge } from '../generated/proto/HubEdge';
import { PacketCodec } from './packet-codec';

export type Logger = {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
};

export interface WebSocketServerConfig {
  port?: number;
  server?: HTTPServer | HTTPSServer;
  path?: string;
  logger?: Logger;
}

/**
 * EdgeClient 事件类型定义
 */
export interface EdgeClientEvents extends EventMap {
  // EdgeClient 当前没有自定义事件，保留用于未来扩展
}

/**
 * Edge 客户端连接
 */
export class EdgeClient extends TypedEventEmitter<EdgeClientEvents> {
  private static nextId = 1;
  
  public readonly id: number;
  public edgeId?: number; // Edge 注册后设置
  private ws: WebSocket;
  private logger: Logger;

  constructor(ws: WebSocket, logger: Logger) {
    super();
    this.id = EdgeClient.nextId++;
    this.ws = ws;
    this.logger = logger;
  }

  /**
   * 发送数据包
   */
  async send(packet: hubedge.EdgeHubPacket): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }

    const data = PacketCodec.encode(packet);
    
    return new Promise((resolve, reject) => {
      this.ws.send(data, (error) => {
        if (error) {
          this.logger.error('Failed to send packet to client', { clientId: this.id, error });
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 关闭连接
   */
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 获取远程地址
   */
  getRemoteAddress(): string {
    const socket = (this.ws as { _socket?: { remoteAddress?: string } })._socket;
    return socket?.remoteAddress || 'unknown';
  }
}

/**
 * EdgeHubWebSocketServer 事件类型定义
 */
export interface EdgeHubWebSocketServerEvents extends EventMap {
  'connection': [client: EdgeClient];
  'message': [client: EdgeClient, packet: hubedge.EdgeHubPacket];
  'disconnection': [client: EdgeClient, code: number, reason: string];
  'error': [error: Error];
}

export class EdgeHubWebSocketServer extends TypedEventEmitter<EdgeHubWebSocketServerEvents> {
  private wss?: WebSocketServer;
  private clients = new Map<number, EdgeClient>();
  private edgeClients = new Map<number, EdgeClient>(); // edgeId -> client
  private config: Required<WebSocketServerConfig>;
  private logger: Logger;

  constructor(config: WebSocketServerConfig) {
    super();
    this.config = {
      port: 9000,
      path: '/hub',
      logger: console as Logger,
      ...config,
    } as Required<WebSocketServerConfig>;
    this.logger = this.config.logger;
  }

  /**
   * 启动服务器
   */
  start(): void {
    if (this.wss) {
      throw new Error('Server already started');
    }

    const options: ServerOptions = {
      path: this.config.path,
    };

    if (this.config.server) {
      options.server = this.config.server;
    } else if (this.config.port) {
      options.port = this.config.port;
    }

    this.wss = new WebSocketServer(options);

    this.wss.on('connection', (ws: WebSocket, request) => {
      this.handleConnection(ws, request);
    });

    this.wss.on('error', (error: Error) => {
      this.logger.error('WebSocket server error', error);
      this.emit('error', error);
    });

    this.logger.info('WebSocket server started', { 
      port: this.config.port, 
      path: this.config.path 
    });
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    if (!this.wss) {
      return;
    }

    // 关闭所有客户端连接
    for (const client of this.clients.values()) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.edgeClients.clear();

    return new Promise((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          this.logger.error('Error closing WebSocket server', error);
          reject(error);
        } else {
          this.logger.info('WebSocket server stopped');
          this.wss = undefined;
          resolve();
        }
      });
    });
  }

  /**
   * 广播消息到所有 Edge
   */
  async broadcast(packet: hubedge.EdgeHubPacket, exclude?: EdgeClient[]): Promise<void> {
    const excludeIds = new Set(exclude?.map(c => c.id) || []);
    const promises: Promise<void>[] = [];

    for (const client of this.clients.values()) {
      if (!excludeIds.has(client.id) && client.isConnected()) {
        promises.push(
          client.send(packet).catch((error) => {
            this.logger.error('Failed to broadcast to client', { clientId: client.id, error });
          })
        );
      }
    }

    await Promise.all(promises);
  }

  /**
   * 发送消息到特定 Edge
   */
  async sendToEdge(edgeId: number, packet: hubedge.EdgeHubPacket): Promise<void> {
    const client = this.edgeClients.get(edgeId);
    if (!client) {
      throw new Error(`Edge ${edgeId} not found`);
    }
    await client.send(packet);
  }

  /**
   * 注册 Edge 客户端
   */
  registerEdge(client: EdgeClient, edgeId: number): void {
    client.edgeId = edgeId;
    this.edgeClients.set(edgeId, client);
    this.logger.info('Edge registered', { clientId: client.id, edgeId });
  }

  /**
   * 取消注册 Edge 客户端
   */
  unregisterEdge(edgeId: number): void {
    this.edgeClients.delete(edgeId);
    this.logger.info('Edge unregistered', { edgeId });
  }

  /**
   * 获取所有已连接的 Edge ID
   */
  getConnectedEdgeIds(): number[] {
    return Array.from(this.edgeClients.keys());
  }

  /**
   * 获取客户端数量
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * 处理新连接
   */
  private handleConnection(ws: WebSocket, _request: { url?: string; headers: Record<string, string | string[] | undefined> }): void {
    const client = new EdgeClient(ws, this.logger);
    this.clients.set(client.id, client);

    this.logger.info('New WebSocket connection', { 
      clientId: client.id, 
      remoteAddress: client.getRemoteAddress() 
    });

    ws.on('message', (data: Buffer) => {
      this.handleMessage(client, data);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.handleClose(client, code, reason.toString());
    });

    ws.on('error', (error: Error) => {
      this.logger.error('WebSocket client error', { clientId: client.id, error });
    });

    this.emit('connection', client);
  }

  /**
   * 处理客户端消息
   */
  private handleMessage(client: EdgeClient, data: Buffer): void {
    try {
      const packet = PacketCodec.decode(new Uint8Array(data));
      this.emit('message', client, packet);
    } catch (error) {
      this.logger.error('Failed to decode packet', { clientId: client.id, error });
    }
  }

  /**
   * 处理客户端断开
   */
  private handleClose(client: EdgeClient, code: number, reason: string): void {
    this.logger.info('WebSocket client disconnected', { 
      clientId: client.id, 
      edgeId: client.edgeId,
      code, 
      reason 
    });

    this.clients.delete(client.id);
    
    if (client.edgeId !== undefined) {
      this.edgeClients.delete(client.edgeId);
    }

    this.emit('disconnection', client, code, reason);
  }
}
