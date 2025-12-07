/**
 * WebhookHandler - Webhook 处理器
 *
 * 处理 Webhook 订阅的管理
 */

import type { BusinessHandler } from '../../types/api-types.js';
import type { ApiContext } from '../context.js';

interface WebhookParams {
  id: string;
  config: {
    url: string;
    events: string[];
    enabled: boolean;
  };
}

export class WebhookHandler implements BusinessHandler<WebhookParams, void> {
  async execute(params: WebhookParams, context: ApiContext): Promise<void> {
    const config = {
      id: params.id,
      ...params.config
    };
    context.client.addWebhook(params.id, config);
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