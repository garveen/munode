/**
 * WebhookHandler - Webhook 处理器
 *
 * 处理 Webhook 订阅的管理
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';

export class AddWebhookHandler implements BusinessHandler {
  async execute(params: { id: string; config: any }, context: ApiContext): Promise<void> {
    context.client.addWebhook(params.id, params.config);
  }
}

export class RemoveWebhookHandler implements BusinessHandler {
  async execute(params: { id: string }, context: ApiContext): Promise<void> {
    context.client.removeWebhook(params.id);
  }
}

export class GetWebhooksHandler implements BusinessHandler {
  async execute(_params: {}, context: ApiContext): Promise<Map<string, any>> {
    return context.client.getWebhooks();
  }
}