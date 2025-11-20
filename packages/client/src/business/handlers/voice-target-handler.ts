/**
 * VoiceTargetHandler - 语音目标处理器
 *
 * 处理语音目标的设置和移除
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';

export class SetVoiceTargetHandler implements BusinessHandler {
  async execute(params: { id: number; targets: any[] }, context: ApiContext): Promise<void> {
    await context.client.setVoiceTarget(params.id, params.targets);
  }
}

export class RemoveVoiceTargetHandler implements BusinessHandler {
  async execute(params: { id: number }, context: ApiContext): Promise<void> {
    await context.client.removeVoiceTarget(params.id);
  }
}