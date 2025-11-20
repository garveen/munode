/**
 * WebSocket Server
 * 
 * 主要职责:
 * - WebSocket 双向通信
 * - 命令执行
 * - 事件推送
 * - 音频流传输
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import type { MumbleClient } from '../core/mumble-client.js';
import { ApiDispatcher } from './dispatcher.js';
import type { WebSocketOptions, WebSocketMessage } from '../types/api-types.js';

export class MumbleWebSocketServer {
  private wss: WebSocketServer;
  private client: MumbleClient;
  private dispatcher: ApiDispatcher;
  private connections: Set<WebSocketConnection> = new Set();

  constructor(client: MumbleClient, options: WebSocketOptions) {
    this.client = client;
    this.dispatcher = new ApiDispatcher();
    this.wss = new WebSocketServer({
      port: options.port,
      path: options.path || '/ws'
    });

    this.setupWebSocketServer();
    this.setupClientEventForwarding();
  }

  /**
   * 设置 WebSocket 服务器
   */
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      this.handleConnection(ws, request);
    });

    this.wss.on('error', (error: Error) => {
      console.error('WebSocket server error:', error);
    });
  }

  /**
   * 处理新的 WebSocket 连接
   */
  private handleConnection(ws: WebSocket, _request: IncomingMessage): void {
    console.log('New WebSocket connection');

    const connection = new WebSocketConnection(ws, this.client, this.dispatcher);
    this.connections.add(connection);

    ws.on('close', () => {
      console.log('WebSocket connection closed');
      this.connections.delete(connection);
    });

    ws.on('error', (error: Error) => {
      console.error('WebSocket error:', error);
      this.connections.delete(connection);
    });
  }

  /**
   * 设置客户端事件转发到 WebSocket
   */
  private setupClientEventForwarding(): void {
    // 监听客户端事件并推送到所有 WebSocket 连接
    
    this.client.on('connected', () => {
      this.broadcast({ type: 'event', event: 'connected', data: {} });
    });
    
    this.client.on('disconnected', () => {
      this.broadcast({ type: 'event', event: 'disconnected', data: {} });
    });
    
    this.client.on('userJoined', (user: any) => {
      this.broadcast({ type: 'event', event: 'userJoined', data: user });
    });
    
    this.client.on('userLeft', (user: any) => {
      this.broadcast({ type: 'event', event: 'userLeft', data: user });
    });
    
    this.client.on('textMessage', (message: any) => {
      this.broadcast({ type: 'event', event: 'textMessage', data: message });
    });
    
    this.client.on('channelCreated', (channel: any) => {
      this.broadcast({ type: 'event', event: 'channelCreated', data: channel });
    });
    
    this.client.on('channelRemoved', (channelId: number) => {
      this.broadcast({ type: 'event', event: 'channelRemoved', data: { channelId } });
    });
  }

  /**
   * 广播消息到所有连接
   */
  broadcast(message: WebSocketMessage): void {
    const data = JSON.stringify(message);
    this.connections.forEach(conn => {
      conn.send(data);
    });
  }

  /**
   * 关闭服务器
   */
  async close(): Promise<void> {
    // 关闭所有连接
    this.connections.forEach(conn => {
      conn.close();
    });
    this.connections.clear();

    // 关闭服务器
    return new Promise((resolve, reject) => {
      this.wss.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

/**
 * WebSocket 连接管理
 */
class WebSocketConnection {
  private ws: WebSocket;
  private client: MumbleClient;
  private dispatcher: ApiDispatcher;

  constructor(ws: WebSocket, client: MumbleClient, dispatcher: ApiDispatcher) {
    this.ws = ws;
    this.client = client;
    this.dispatcher = dispatcher;

    this.setupMessageHandler();
  }

  /**
   * 设置消息处理器
   */
  private setupMessageHandler(): void {
    this.ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as WebSocketMessage;
        await this.handleMessage(message);
      } catch (error) {
        this.sendError('Invalid message format', (error as Error).message);
      }
    });
  }

  /**
   * 处理接收到的消息
   */
  private async handleMessage(message: WebSocketMessage): Promise<void> {
    if (message.type === 'command') {
      await this.handleCommand(message);
    } else {
      this.sendError('INVALID_MESSAGE_TYPE', 'Unknown message type');
    }
  }

  /**
   * 处理命令
   */
  private async handleCommand(message: WebSocketMessage): Promise<void> {
    const { id, action, data } = message;

    try {
      const result = await this.dispatcher.dispatch(
        { action: action!, params: data },
        { client: this.client, source: 'websocket' }
      );

      this.sendResponse(id!, result);
    } catch (error) {
      this.sendError('COMMAND_FAILED', (error as Error).message, id);
    }
  }

  /**
   * 发送响应
   */
  private sendResponse(id: string, result: any): void {
    this.send(JSON.stringify({
      type: 'response',
      id,
      success: true,
      data: result
    }));
  }

  /**
   * 发送错误
   */
  private sendError(code: string, message: string, id?: string): void {
    this.send(JSON.stringify({
      type: 'response',
      id,
      success: false,
      error: { code, message }
    }));
  }

  /**
   * 发送事件
   */
  sendEvent(event: string, data: any): void {
    this.send(JSON.stringify({
      type: 'event',
      event,
      data
    }));
  }

  /**
   * 发送消息
   */
  send(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.ws.close();
  }
}

/**
 * 启动 WebSocket 服务器的便捷函数
 */
export async function startWebSocketServer(
  client: MumbleClient,
  options: WebSocketOptions
): Promise<MumbleWebSocketServer> {
  const server = new MumbleWebSocketServer(client, options);
  console.log(`WebSocket server listening on port ${options.port}`);
  return server;
}
