/**
 * Type-Safe RPC Client
 * 为 RPCChannel 提供类型安全的包装器
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
 * 类型安全的 RPC 客户端
 *
 * 使用方法：
 * ```typescript
 * const client = new TypedRPCClient(rpcChannel);
 *
 * // TypeScript 会自动推断参数和返回值类型
 * const result = await client.call('edge.register', {
 *   serverId: 1,
 *   name: 'edge-1',
 *   // ... TypeScript 会提示需要的字段
 * });
 *
 * // result 的类型会被自动推断为 RegisterResponse
 * console.log(result.success);
 * ```
 */
export class TypedRPCClient {
  constructor(private channel: RPCChannel) {}

  /**
   * 类型安全的 RPC 调用
   * @param method RPC 方法名
   * @param params 请求参数（类型会根据 method 自动推断）
   * @returns Promise，返回值类型根据 method 自动推断
   */
  async call<M extends EdgeToHubMethods['method']>(
    method: M,
    params: RPCParams<M>
  ): Promise<RPCResult<M>> {
    return this.channel.call(method, params) as Promise<RPCResult<M>>;
  }

  /**
   * 类型安全的通知发送（无需等待响应）
   * @param method 通知方法名
   * @param params 通知参数
   */
  notify<M extends HubToEdgeNotifications['method']>(
    method: M,
    params: NotificationParams<M>
  ): void {
    this.channel.notify(method, params);
  }

  /**
   * 获取底层 RPCChannel
   */
  getChannel(): RPCChannel {
    return this.channel;
  }
}

/**
 * 创建类型安全的 RPC 客户端
 */
export function createTypedRPCClient(channel: RPCChannel): TypedRPCClient {
  return new TypedRPCClient(channel);
}
