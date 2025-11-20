/**
 * WebhookManager - Webhook 推送管理器
 * 
 * 主要职责:
 * - Webhook 配置管理
 * - 事件过滤和推送
 * - 批量推送
 * - 重试机制
 */

import type { MumbleClient } from '../core/mumble-client.js';
import type { WebhookConfig, WebhookPayload } from '../types/api-types.js';

export class WebhookManager {
  private client: MumbleClient;
  private webhooks: Map<string, WebhookSubscription> = new Map();

  constructor(client: MumbleClient) {
    this.client = client;
  }

  /**
   * 添加 Webhook 订阅
   */
  addWebhook(id: string, config: WebhookConfig): void {
    const subscription = new WebhookSubscription(config);
    this.webhooks.set(id, subscription);

    // 订阅指定的事件
    config.events.forEach(eventName => {
      this.client.on(eventName, (data: any) => {
        this.handleEvent(eventName, data);
      });
    });
  }

  /**
   * 移除 Webhook 订阅
   */
  removeWebhook(id: string): void {
    const subscription = this.webhooks.get(id);
    if (subscription) {
      // 移除 webhook 订阅
      this.webhooks.delete(id);
    }
  }

  /**
   * 处理事件并推送到 Webhook
   */
  private async handleEvent(eventName: string, data: any): Promise<void> {
    const payload: WebhookPayload = {
      event: eventName,
      timestamp: Date.now(),
      data
    };

    // 推送到所有订阅了该事件的 Webhook
    const promises: Promise<void>[] = [];
    this.webhooks.forEach(subscription => {
      if (subscription.shouldSendEvent(eventName)) {
        promises.push(subscription.send(payload));
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * 获取所有 Webhook 配置
   */
  getWebhooks(): Map<string, WebhookConfig> {
    const configs = new Map<string, WebhookConfig>();
    this.webhooks.forEach((subscription, id) => {
      configs.set(id, subscription.getConfig());
    });
    return configs;
  }

  /**
   * 清理所有 Webhook
   */
  cleanup(): void {
    this.webhooks.clear();
  }
}

/**
 * Webhook 订阅
 */
class WebhookSubscription {
  private config: WebhookConfig;
  private pendingEvents: WebhookPayload[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  /**
   * 检查是否应该发送该事件
   */
  shouldSendEvent(eventName: string): boolean {
    return this.config.events.includes(eventName) || this.config.events.includes('*');
  }

  /**
   * 发送 Webhook
   */
  async send(payload: WebhookPayload): Promise<void> {
    // 批量模式
    if (this.config.batch) {
      this.pendingEvents.push(payload);
      this.scheduleBatchSend();
      return;
    }

    // 立即发送
    await this.sendRequest([payload]);
  }

  /**
   * 安排批量发送
   */
  private scheduleBatchSend(): void {
    if (this.batchTimer) return;

    const batchInterval = this.config.batchInterval || 1000;
    this.batchTimer = setTimeout(() => {
      this.flushBatch();
    }, batchInterval);
  }

  /**
   * 刷新批量事件
   */
  private async flushBatch(): Promise<void> {
    if (this.pendingEvents.length === 0) return;

    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    this.batchTimer = null;

    await this.sendRequest(events);
  }

  /**
   * 发送 HTTP 请求
   */
  private async sendRequest(payloads: WebhookPayload[], retryCount: number = 0): Promise<void> {
    try {
      const response = await fetch(this.config.url, {
        method: this.config.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.headers || {})
        },
        body: JSON.stringify(payloads.length === 1 ? payloads[0] : payloads)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Webhook request failed:', error);

      // 重试逻辑
      const maxRetries = this.config.retry || 0;
      if (retryCount < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.sendRequest(payloads, retryCount + 1);
      }
    }
  }

  /**
   * 获取配置
   */
  getConfig(): WebhookConfig {
    return { ...this.config };
  }
}
