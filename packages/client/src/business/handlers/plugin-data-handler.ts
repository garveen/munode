/**
 * PluginDataHandler - 插件数据处理器
 *
 * 处理插件数据的发送
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';

export class SendPluginDataHandler implements BusinessHandler {
  async execute(params: { pluginId: string; data: Buffer; receivers?: number[] }, context: ApiContext): Promise<void> {
    await context.client.sendPluginData(params.pluginId, params.data, params.receivers);
  }
}