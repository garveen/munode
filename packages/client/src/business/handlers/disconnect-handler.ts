/**
 * DisconnectHandler - 断开连接处理器
 */

import type { BusinessHandler } from '../../types/api-types.js';
import type { ApiContext } from '../context.js';

export class DisconnectHandler implements BusinessHandler<Record<string, never>, void> {
  async execute(_params: Record<string, never>, context: ApiContext): Promise<void> {
    await context.client.disconnect();
  }
}
