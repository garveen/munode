/**
 * JoinChannelHandler - 加入频道处理器
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';

export interface JoinChannelParams {
  channelId: number;
}

export class JoinChannelHandler implements BusinessHandler {
  async execute(params: JoinChannelParams, context: ApiContext): Promise<void> {
    // 验证频道 ID
    if (typeof params.channelId !== 'number' || params.channelId < 0) {
      throw new Error('Invalid channel ID');
    }
    
    // 发送 UserState 消息加入频道
    await context.client.joinChannel(params.channelId);
  }
}
