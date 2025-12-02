import WebSocket from 'ws';
import { pack, unpack } from 'msgpackr';
import { EventEmitter } from 'events';

export interface Message {
  id?: string;           // 请求ID（响应时必填，通知时可选）
  type: string;          // 消息类型
  method?: string;       // RPC 方法名（请求时必填）
  params?: any;          // 参数
  result?: any;          // 结果（响应时使用）
  error?: {              // 错误（响应时使用）
    code: number;
    message: string;
    data?: any;
  };
  timestamp: number;     // 时间戳
}

export interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RPCChannel extends EventEmitter {
  private ws: WebSocket;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestTimeout = 30000; // 30秒

  constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    this.setupWebSocket();
  }

  private setupWebSocket(): void {
    this.ws.on('message', this.handleMessage.bind(this));
    this.ws.on('close', this.handleClose.bind(this));
    this.ws.on('error', this.handleError.bind(this));
  }

  /**
   * 发送 RPC 请求
   */
  async call(method: string, params?: any, timeout?: number): Promise<any> {
    const id = this.generateId();
    const message: Message = {
      id,
      type: 'request',
      method,
      params,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      // 设置超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeout || this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send(message);
    });
  }

  /**
   * 发送通知（无需响应）
   */
  notify(method: string, params?: any): void {
    const message: Message = {
      type: 'notification',
      method,
      params,
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * 发送响应
   */
  respond(id: string, result?: any, error?: any): void {
    const message: Message = {
      id,
      type: 'response',
      result,
      error,
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * 发送心跳
   */
  ping(): void {
    const message: Message = {
      type: 'ping',
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(data: Buffer): void {
    try {
      const message: Message = unpack(data);

      switch (message.type) {
        case 'request':
          this.handleRequest(message);
          break;

        case 'response':
          this.handleResponse(message);
          break;

        case 'notification':
          this.handleNotification(message);
          break;

        case 'ping':
          this.handlePing(message);
          break;

        case 'pong':
          this.handlePong(message);
          break;
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleRequest(message: Message): void {
    this.emit('request', message, (result?: any, error?: any) => {
      this.respond(message.id!, result, error);
    });
  }

  private handleResponse(message: Message): void {
    const pending = this.pendingRequests.get(message.id!);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.id!);

      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private handleNotification(message: Message): void {
    this.emit('notification', message);
  }

  private handlePing(message: Message): void {
    this.send({ type: 'pong', timestamp: Date.now() });
    this.emit('ping', message.timestamp);
  }

  private handlePong(message: Message): void {
    const latency = Date.now() - message.timestamp;
    this.emit('pong', latency);
  }

  private handleClose(code: number, reason: Buffer): void {
    this.emit('close', code, reason);
    this.cleanup();
  }

  private handleError(error: Error): void {
    this.emit('error', error);
  }

  private send(message: Message): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pack(message));
    } else {
      throw new Error('WebSocket not open');
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private cleanup(): void {
    // 清理所有待处理的请求
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.cleanup();
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  /**
   * 检查连接是否打开
   */
  isConnected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}