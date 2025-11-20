/**
 * ContextActionHandler - 上下文操作处理器
 *
 * 处理上下文操作的注册和执行
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';

export class RegisterContextActionHandler implements BusinessHandler {
  async execute(params: { action: string; text: string; contexts?: number[] }, context: ApiContext): Promise<void> {
    await context.client.registerContextAction(params.action, params.text, params.contexts);
  }
}

export class ExecuteContextActionHandler implements BusinessHandler {
  async execute(params: { action: string; session?: number; channel?: number }, context: ApiContext): Promise<void> {
    await context.client.executeContextAction(params.action, params.session, params.channel);
  }
}