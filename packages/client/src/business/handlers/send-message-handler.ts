/**
 * SendMessageHandler - 发送消息处理器
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';

export interface SendMessageParams {
  target: {
    channelId?: number;
    userId?: number;
    tree?: boolean;
  };
  message: string;
}

export class SendMessageHandler implements BusinessHandler {
  async execute(params: SendMessageParams, context: ApiContext): Promise<void> {
    // 验证消息内容
    if (!params.message || params.message.trim().length === 0) {
      throw new Error('Message cannot be empty');
    }
    
    // 验证目标
    if (!params.target.channelId && !params.target.userId) {
      throw new Error('Must specify either channelId or userId');
    }
    
    // 发送消息
    await context.client.sendMessage(params.target, params.message);
  }
}
