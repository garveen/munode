/**
 * Protobuf RPC 客户端
 * 
 * Edge 端使用此客户端向 Hub 发起 RPC 调用
 */

import { hubedge } from '../generated/proto/HubEdge.js';
import { EdgeHubWebSocketClient } from '../transport/websocket-client.js';

type EdgeHubPacket = hubedge.EdgeHubPacket;
type PacketType = hubedge.PacketType;
type RPCRequest = hubedge.RPCRequest;

const { EdgeHubPacket, PacketType, RPCRequest } = hubedge;
import {
  EdgeToHubMethods,
  RPCParams,
  RPCResult,
  RPCCallOptions,
  RPCError,
  RPCErrorCode,
} from './rpc-methods';

/**
 * 待处理的 RPC 请求
 */
interface PendingRequest<M extends keyof EdgeToHubMethods> {
  requestId: string;
  method: M;
  resolve: (result: RPCResult<EdgeToHubMethods, M>) => void;
  reject: (error: RPCError) => void;
  timer: NodeJS.Timeout;
  timestamp: number;
}

/**
 * Protobuf RPC 客户端
 */
export class ProtobufRPCClient {
  private transport: EdgeHubWebSocketClient;
  private pendingRequests = new Map<string, PendingRequest<any>>();
  private nextRequestId = 1;
  private defaultTimeout = 30000; // 30 秒

  constructor(transport: EdgeHubWebSocketClient) {
    this.transport = transport;

    // 监听响应消息
    this.transport.on('message', (packet: EdgeHubPacket) => {
      if (packet.type === PacketType.PACKET_TYPE_RPC_RESPONSE) {
        this.handleResponse(packet);
      } else if (packet.type === PacketType.PACKET_TYPE_RPC_ERROR) {
        this.handleError(packet);
      }
    });

    // 连接断开时清理所有待处理请求
    this.transport.on('disconnected', () => {
      this.clearAllPending('Connection lost');
    });
  }

  /**
   * 调用 RPC 方法
   */
  async call<M extends keyof EdgeToHubMethods>(
    method: M,
    params: RPCParams<EdgeToHubMethods, M>,
    options: RPCCallOptions = {}
  ): Promise<RPCResult<EdgeToHubMethods, M>> {
    const requestId = this.generateRequestId();
    const timeout = options.timeout ?? this.defaultTimeout;

    // 创建请求包
    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_RPC_REQUEST,
      rpc_request: new RPCRequest({
        request_id: requestId,
        method: method as string,
        params: Buffer.from(JSON.stringify(params)),
        timeout_ms: timeout,
      }),
    });

    // 创建 Promise 并设置超时
    return new Promise<RPCResult<EdgeToHubMethods, M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new RPCError(RPCErrorCode.TIMEOUT, `RPC call ${method} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(requestId, {
        requestId,
        method,
        resolve,
        reject,
        timer,
        timestamp: Date.now(),
      });

      // 发送请求
      this.transport.send(packet).catch((error) => {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(new RPCError(RPCErrorCode.INTERNAL_ERROR, `Failed to send RPC request: ${error.message}`));
      });
    });
  }

  /**
   * 批量调用多个 RPC 方法
   */
  async callBatch<M extends keyof EdgeToHubMethods>(
    calls: Array<{
      method: M;
      params: RPCParams<EdgeToHubMethods, M>;
      options?: RPCCallOptions;
    }>
  ): Promise<Array<RPCResult<EdgeToHubMethods, M> | RPCError>> {
    const promises = calls.map(({ method, params, options }) =>
      this.call(method, params, options).catch((error) => error)
    );

    return Promise.all(promises);
  }

  /**
   * 获取待处理请求数量
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const now = Date.now();
    const pendingDurations = Array.from(this.pendingRequests.values()).map(
      (req) => now - req.timestamp
    );

    return {
      pendingCount: this.pendingRequests.size,
      avgPendingDuration: pendingDurations.length > 0
        ? pendingDurations.reduce((a, b) => a + b, 0) / pendingDurations.length
        : 0,
      maxPendingDuration: pendingDurations.length > 0 ? Math.max(...pendingDurations) : 0,
    };
  }

  /**
   * 清理所有待处理的请求
   */
  private clearAllPending(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RPCError(RPCErrorCode.SERVICE_UNAVAILABLE, reason));
    }
    this.pendingRequests.clear();
  }

  /**
   * 处理 RPC 响应
   */
  private handleResponse(packet: EdgeHubPacket): void {
    if (!packet.rpc_response) {
      console.warn('Received RPC_RESPONSE packet without rpc_response field');
      return;
    }

    const { request_id: requestId, result, processing_time_ms: processingTimeMs } = packet.rpc_response;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      console.warn(`Received response for unknown request: ${requestId}`);
      return;
    }

    // 清理定时器和待处理请求
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    // 解析结果
    try {
      const parsedResult = JSON.parse(Buffer.from(result).toString());
      
      // 记录处理时间
      if (processingTimeMs !== undefined && processingTimeMs > 100) {
        console.debug(`RPC ${pending.method} took ${processingTimeMs}ms`);
      }

      pending.resolve(parsedResult);
    } catch (error) {
      pending.reject(
        new RPCError(
          RPCErrorCode.INTERNAL_ERROR,
          `Failed to parse RPC response: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * 处理 RPC 错误
   */
  private handleError(packet: EdgeHubPacket): void {
    if (!packet.rpc_error) {
      console.warn('Received RPC_ERROR packet without rpc_error field');
      return;
    }

    const { request_id: requestId, code, message, details } = packet.rpc_error;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      console.warn(`Received error for unknown request: ${requestId}`);
      return;
    }

    // 清理定时器和待处理请求
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    // 解析错误详情
    let parsedDetails: any = undefined;
    if (details && details.length > 0) {
      try {
        parsedDetails = JSON.parse(Buffer.from(details).toString());
      } catch (error) {
        // 忽略解析错误
      }
    }

    pending.reject(new RPCError(code, message, parsedDetails));
  }

  /**
   * 生成唯一的请求 ID
   */
  private generateRequestId(): string {
    return `req-${Date.now()}-${this.nextRequestId++}`;
  }

  /**
   * 设置默认超时时间
   */
  setDefaultTimeout(timeout: number): void {
    this.defaultTimeout = timeout;
  }
}
