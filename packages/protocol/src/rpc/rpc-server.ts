/**
 * Protobuf RPC 服务器
 * 
 * Hub 端使用此服务器处理来自 Edge 的 RPC 调用
 */

import { EdgeHubWebSocketServer, EdgeClient } from '../transport/websocket-server';
import { hubedge } from '../generated/proto/HubEdge.js';

type EdgeHubPacket = hubedge.EdgeHubPacket;
type PacketType = hubedge.PacketType;
type RPCRequest = hubedge.RPCRequest;
type RPCResponse = hubedge.RPCResponse;
type ProtoRPCError = hubedge.RPCError;

const { EdgeHubPacket, PacketType, RPCRequest, RPCResponse, RPCError: ProtoRPCError } = hubedge;
import {
  EdgeToHubMethods,
  HubToEdgeMethods,
  RPCParams,
  RPCResult,
  RPCError,
  RPCErrorCode,
} from './rpc-methods';

/**
 * RPC 方法处理器类型
 */
export type RPCHandler<Methods extends Record<string, any>, M extends keyof Methods> = (
  params: RPCParams<Methods, M>,
  client: EdgeClient
) => Promise<RPCResult<Methods, M>> | RPCResult<Methods, M>;

/**
 * Protobuf RPC 服务器
 */
export class ProtobufRPCServer {
  private transport: EdgeHubWebSocketServer;
  private handlers = new Map<string, RPCHandler<any, any>>();
  private requestStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalProcessingTime: 0,
  };

  constructor(transport: EdgeHubWebSocketServer) {
    this.transport = transport;

    // 监听 RPC 请求
    this.transport.on('message', (client: EdgeClient, packet: EdgeHubPacket) => {
      if (packet.type === PacketType.PACKET_TYPE_RPC_REQUEST) {
        this.handleRequest(client, packet).catch((error) => {
          console.error('Failed to handle RPC request:', error);
        });
      }
    });
  }

  /**
   * 注册 RPC 方法处理器
   */
  register<M extends keyof EdgeToHubMethods>(
    method: M,
    handler: RPCHandler<EdgeToHubMethods, M>
  ): void {
    this.handlers.set(method as string, handler);
  }

  /**
   * 批量注册 RPC 方法
   */
  registerBatch(handlers: {
    [M in keyof EdgeToHubMethods]?: RPCHandler<EdgeToHubMethods, M>;
  }): void {
    for (const [method, handler] of Object.entries(handlers)) {
      if (handler) {
        this.handlers.set(method, handler);
      }
    }
  }

  /**
   * 取消注册 RPC 方法
   */
  unregister(method: keyof EdgeToHubMethods): void {
    this.handlers.delete(method as string);
  }

  /**
   * 检查方法是否已注册
   */
  hasHandler(method: keyof EdgeToHubMethods): boolean {
    return this.handlers.has(method as string);
  }

  /**
   * 获取所有已注册的方法
   */
  getRegisteredMethods(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * 调用 Edge 的 RPC 方法（Hub -> Edge）
   */
  async callEdge<M extends keyof HubToEdgeMethods>(
    client: EdgeClient,
    method: M,
    params: RPCParams<HubToEdgeMethods, M>,
    timeout: number = 30000
  ): Promise<RPCResult<HubToEdgeMethods, M>> {
    const requestId = this.generateRequestId();

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
    return new Promise<RPCResult<HubToEdgeMethods, M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.transport['pendingRequests'].delete(requestId);
        reject(new RPCError(RPCErrorCode.TIMEOUT, `RPC call ${method} timed out after ${timeout}ms`));
      }, timeout);

      // 存储待处理请求
      this.transport['pendingRequests'].set(requestId, {
        resolve,
        reject,
        timer,
      });

      // 发送请求
      client.send(packet).catch((error) => {
        clearTimeout(timer);
        this.transport['pendingRequests'].delete(requestId);
        reject(new RPCError(RPCErrorCode.INTERNAL_ERROR, `Failed to send RPC request: ${error.message}`));
      });
    });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.requestStats,
      avgProcessingTime:
        this.requestStats.totalRequests > 0
          ? this.requestStats.totalProcessingTime / this.requestStats.totalRequests
          : 0,
      successRate:
        this.requestStats.totalRequests > 0
          ? this.requestStats.successfulRequests / this.requestStats.totalRequests
          : 0,
    };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.requestStats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalProcessingTime: 0,
    };
  }

  /**
   * 处理 RPC 请求
   */
  private async handleRequest(client: EdgeClient, packet: EdgeHubPacket): Promise<void> {
    if (!packet.rpc_request) {
      console.warn('Received RPC_REQUEST packet without rpc_request field');
      return;
    }

    const { request_id: requestId, method, params: paramsBuffer, timeout_ms: timeoutMs } = packet.rpc_request;
    const startTime = Date.now();

    this.requestStats.totalRequests++;

    try {
      // 查找处理器
      const handler = this.handlers.get(method);
      if (!handler) {
        throw new RPCError(
          RPCErrorCode.METHOD_NOT_FOUND,
          `RPC method not found: ${method}`
        );
      }

      // 解析参数
      let params: any;
      try {
        params = JSON.parse(Buffer.from(paramsBuffer).toString());
      } catch (error) {
        throw new RPCError(
          RPCErrorCode.INVALID_PARAMS,
          `Failed to parse RPC params: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // 设置超时（如果指定）
      let timeoutTimer: NodeJS.Timeout | undefined;
      const handlerPromise = Promise.resolve(handler(params, client));

      if (timeoutMs && timeoutMs > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            reject(new RPCError(
              RPCErrorCode.TIMEOUT,
              `RPC handler timeout after ${timeoutMs}ms`
            ));
          }, timeoutMs);
        });

        // 竞速：处理器 vs 超时
        const result = await Promise.race([handlerPromise, timeoutPromise]);
        clearTimeout(timeoutTimer);

        await this.sendResponse(client, requestId, result, startTime);
      } else {
        const result = await handlerPromise;
        await this.sendResponse(client, requestId, result, startTime);
      }

      this.requestStats.successfulRequests++;
    } catch (error) {
      this.requestStats.failedRequests++;

      if (error instanceof RPCError) {
        await this.sendError(client, requestId, error);
      } else {
        await this.sendError(
          client,
          requestId,
          new RPCError(
            RPCErrorCode.INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error)
          )
        );
      }
    } finally {
      const processingTime = Date.now() - startTime;
      this.requestStats.totalProcessingTime += processingTime;

      // 记录慢请求
      if (processingTime > 1000) {
        console.warn(`Slow RPC request: ${method} took ${processingTime}ms`);
      }
    }
  }

  /**
   * 发送成功响应
   */
  private async sendResponse(
    client: EdgeClient,
    requestId: string,
    result: any,
    startTime: number
  ): Promise<void> {
    const processingTime = Date.now() - startTime;

    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_RPC_RESPONSE,
      rpc_response: new RPCResponse({
        request_id: requestId,
        result: Buffer.from(JSON.stringify(result)),
        processing_time_ms: processingTime,
      }),
    });

    await client.send(packet);
  }

  /**
   * 发送错误响应
   */
  private async sendError(
    client: EdgeClient,
    requestId: string,
    error: RPCError
  ): Promise<void> {
    const errorData: any = {
      request_id: requestId,
      code: error.code,
      message: error.message,
    };

    // 只在有 details 时设置，避免传递 undefined
    if (error.details) {
      errorData.details = Buffer.from(JSON.stringify(error.details));
    }

    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_RPC_ERROR,
      rpc_error: new ProtoRPCError(errorData),
    });

    await client.send(packet);
  }

  /**
   * 生成唯一的请求 ID
   */
  private generateRequestId(): string {
    return `hub-req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
