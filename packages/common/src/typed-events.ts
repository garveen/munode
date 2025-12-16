/**
 * 类型安全的 EventEmitter
 * 
 * 提供强类型的事件定义和处理，避免使用裸字符串
 */

import { EventEmitter } from 'events';

/**
 * 事件映射类型
 * Key: 事件名称
 * Value: 事件参数类型（数组形式）
 */
export type EventMap = Record<string, unknown[]>;

/**
 * 类型安全的 EventEmitter
 * 
 * @example
 * interface MyEvents extends EventMap {
 *   'user-connected': [userId: number, username: string];
 *   'user-disconnected': [userId: number];
 *   'error': [error: Error];
 * }
 * 
 * class MyClass extends TypedEventEmitter<MyEvents> {
 *   connect(userId: number, username: string) {
 *     this.emit('user-connected', userId, username); // ✅ 类型安全
 *     this.emit('user-disconnected', userId); // ✅ 类型安全
 *     this.emit('error', new Error('test')); // ✅ 类型安全
 *     // this.emit('unknown', 123); // ❌ 编译错误
 *     // this.emit('user-connected', 'wrong'); // ❌ 编译错误
 *   }
 * }
 * 
 * const obj = new MyClass();
 * obj.on('user-connected', (userId, username) => {
 *   // userId 和 username 都有正确的类型
 * });
 */
export class TypedEventEmitter<TEvents extends EventMap> extends EventEmitter {
  /**
   * 触发事件
   */
  emit<K extends keyof TEvents & string>(
    event: K,
    ...args: TEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * 监听事件
   */
  on<K extends keyof TEvents & string>(
    event: K,
    listener: (...args: TEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }

  /**
   * 监听一次事件
   */
  once<K extends keyof TEvents & string>(
    event: K,
    listener: (...args: TEvents[K]) => void
  ): this {
    return super.once(event, listener);
  }

  /**
   * 移除监听器
   */
  off<K extends keyof TEvents & string>(
    event: K,
    listener: (...args: TEvents[K]) => void
  ): this {
    return super.off(event, listener);
  }

  /**
   * 移除所有监听器（可选指定事件）
   */
  removeAllListeners<K extends keyof TEvents & string>(event?: K): this {
    return super.removeAllListeners(event);
  }

  /**
   * 获取监听器列表
   */
  listeners<K extends keyof TEvents & string>(
    event: K
  ): Array<(...args: TEvents[K]) => void> {
    return super.listeners(event) as Array<(...args: TEvents[K]) => void>;
  }

  /**
   * 获取监听器数量
   */
  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return super.listenerCount(event);
  }

  /**
   * 前置事件监听器
   */
  prependListener<K extends keyof TEvents & string>(
    event: K,
    listener: (...args: TEvents[K]) => void
  ): this {
    return super.prependListener(event, listener);
  }

  /**
   * 前置一次性事件监听器
   */
  prependOnceListener<K extends keyof TEvents & string>(
    event: K,
    listener: (...args: TEvents[K]) => void
  ): this {
    return super.prependOnceListener(event, listener);
  }
}

/**
 * 辅助函数：创建强类型的 EventEmitter
 */
export function createTypedEmitter<TEvents extends EventMap>(): TypedEventEmitter<TEvents> {
  return new TypedEventEmitter<TEvents>();
}
