/**
 * DisconnectHandler - 断开连接处理器
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';

export class DisconnectHandler implements BusinessHandler {
  async execute(_params: any, context: ApiContext): Promise<void> {
    await context.client.disconnect();
  }
}
