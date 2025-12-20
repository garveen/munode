/**
 * VoiceTargetHandler - 语音目标处理器
 *
 * 处理语音目标的设置和移除
 */

import { mumbleproto } from '@munode/protocol';
import type { BusinessHandler } from '../../types/api-types.js';
import type { ApiContext } from '../context.js';

interface VoiceTarget {
  session?: number[];
  channelId?: number;
  links?: boolean;
  children?: boolean;
  group?: string;
}

interface VoiceTargetParams {
  id: number;
  targets: VoiceTarget[];
}

export class VoiceTargetHandler implements BusinessHandler<VoiceTargetParams, void> {
  async execute(params: VoiceTargetParams, context: ApiContext): Promise<void> {
    // 转换为 protobuf 格式
    const protoTargets = params.targets.map(target => ({
      session: target.session || [],
      channel_id: target.channelId,
      links: target.links,
      children: target.children,
      group: target.group
    }));
    
    await context.client.setVoiceTarget(params.id, protoTargets);
  }
}

export class RemoveVoiceTargetHandler implements BusinessHandler {
  async execute(params: { id: number }, context: ApiContext): Promise<void> {
    await context.client.removeVoiceTarget(params.id);
  }
}