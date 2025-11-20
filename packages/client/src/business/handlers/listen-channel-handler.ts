/**
 * ListenChannelHandler - 监听频道处理器
 *
 * 处理监听频道的添加、移除和查询
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';

export class AddListeningChannelHandler implements BusinessHandler {
  async execute(params: { channelId: number }, context: ApiContext): Promise<void> {
    await context.client.addListeningChannel(params.channelId);
  }
}

export class RemoveListeningChannelHandler implements BusinessHandler {
  async execute(params: { channelId: number }, context: ApiContext): Promise<void> {
    await context.client.removeListeningChannel(params.channelId);
  }
}

export class ClearListeningChannelsHandler implements BusinessHandler {
  async execute(_params: {}, context: ApiContext): Promise<void> {
    await context.client.clearListeningChannels();
  }
}

export class GetListeningChannelsHandler implements BusinessHandler {
  async execute(_params: {}, context: ApiContext): Promise<number[]> {
    const session = context.client.getStateManager().getSession();
    return session?.listeningChannels || [];
  }
}