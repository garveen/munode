/**
 * Type-Safe RPC Server Handler
 * 为 Hub Server 提供类型安全的请求处理器
 */

import type { RPCChannel } from './rpc-channel.js';
import type {
  EdgeToHubMethods,
  RPCParams,
  RPCResult,
  HubToEdgeNotifications,
  NotificationParams,
} from './rpc-types.js';

/**
 * RPC 方法处理器类型
 */
export type RPCHandler<M extends EdgeToHubMethods['method']> = (
  channel: RPCChannel,
  params: RPCParams<M>
) => Promise<RPCResult<M>>;

/**
 * RPC 错误
 */
export interface RPCError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * 类型安全的 RPC 服务器
 *
 * 使用方法：
 * ```typescript
 * const server = new TypedRPCServer();
 *
 * // 注册处理器，TypeScript 会自动推断参数和返回值类型
 * server.handle('edge.register', async (channel, params) => {
 *   // params 类型自动推断为 EdgeRegisterMethod['params']
 *   // 返回值必须符合 EdgeRegisterMethod['result']
 *   return {
 *     success: true,
 *     hubServerId: 1,
 *     edgeList: [],
 *   };
 * });
 *
 * // 在收到请求时调用
 * server.handleRequest(channel, message, respond);
 * ```
 */
export class TypedRPCServer {
  private handlers = new Map<string, RPCHandler<EdgeToHubMethods['method']>>();

  /**
   * 注册类型安全的处理器
   * @param method RPC 方法名
   * @param handler 处理函数（参数和返回值类型自动推断）
   */
  handle<M extends EdgeToHubMethods['method']>(method: M, handler: RPCHandler<M>): void {
    this.handlers.set(method, handler);
  }

  /**
   * 处理 RPC 请求
   * @param channel RPC 通道
   * @param message 请求消息
   * @param respond 响应函数
   */
  async handleRequest(
    channel: RPCChannel,
    message: { method: string; params: unknown },
    respond: (result?: unknown, error?: RPCError) => void
  ): Promise<void> {
    const handler = this.handlers.get(message.method);

    if (!handler) {
      respond(undefined, {
        code: -32601,
        message: `Method not found: ${message.method}`,
      });
      return;
    }

    try {
      const result = await handler(channel, message.params);
      respond(result, undefined);
    } catch (error) {
      respond(undefined, {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
        data: error,
      });
    }
  }

  /**
   * 发送类型安全的通知到客户端
   * @param channel RPC 通道
   * @param method 通知方法名
   * @param params 通知参数
   */
  notify<M extends HubToEdgeNotifications['method']>(
    channel: RPCChannel,
    method: M,
    params: NotificationParams<M>
  ): void {
    channel.notify(method, params);
  }

  /**
   * 广播类型安全的通知到所有客户端
   * @param channels RPC 通道列表
   * @param method 通知方法名
   * @param params 通知参数
   */
  broadcast<M extends HubToEdgeNotifications['method']>(
    channels: RPCChannel[],
    method: M,
    params: NotificationParams<M>
  ): void {
    for (const channel of channels) {
      this.notify(channel, method, params);
    }
  }
}

/**
 * 创建类型安全的 RPC 服务器
 */
export function createTypedRPCServer(): TypedRPCServer {
  return new TypedRPCServer();
}
