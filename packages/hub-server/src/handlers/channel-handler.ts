import type { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';

/**
 * Hub 频道处理器接口
 */
export interface IChannelHandler {
  handleSaveChannel(params: RPCParams<'edge.saveChannel'>): Promise<RPCResult<'edge.saveChannel'>>;
}

/**
 * Hub 频道处理器 - 处理频道相关的操作
 */
export class ChannelHandler implements IChannelHandler {
  private factory: HubHandlerFactory;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
  }

  /**
   * 处理保存频道
   */
  async handleSaveChannel(params: RPCParams<'edge.saveChannel'>): Promise<RPCResult<'edge.saveChannel'>> {
    let channel_id: number;

    if (params.channel.id !== undefined) {
      // 更新现有频道 - 只更新提供的字段
      const updates: any = {};

      if (params.channel.name !== undefined) {
        updates.name = params.channel.name;
      }
      if (params.channel.position !== undefined) {
        updates.position = params.channel.position;
      }
      if (params.channel.max_users !== undefined) {
        updates.max_users = params.channel.max_users;
      }
      if (params.channel.parent_id !== undefined) {
        updates.parent_id = params.channel.parent_id;
      }
      if (params.channel.inherit_acl !== undefined) {
        updates.inherit_acl = params.channel.inherit_acl;
      }
      if (params.channel.description_blob !== undefined || params.channel.description !== undefined) {
        updates.description_blob = params.channel.description_blob || params.channel.description;
      }

      await (this.factory.getChannelManager()
        ? this.factory.getChannelManager().updateChannel(params.channel.id, updates)
        : this.factory.getDatabase().updateChannel(params.channel.id, updates));
      channel_id = params.channel.id;
    } else {
      // 创建新频道 - 必须提供所有必需字段的默认值
      if (!params.channel.name) {
        throw new Error('Channel name is required for new channels');
      }
      const channelData = {
        name: params.channel.name,
        position: params.channel.position !== undefined ? params.channel.position : 0,
        max_users: params.channel.max_users !== undefined ? params.channel.max_users : 0,
        parent_id: params.channel.parent_id !== undefined ? params.channel.parent_id : 0,
        inherit_acl: params.channel.inherit_acl !== undefined ? params.channel.inherit_acl : true,
        description_blob: params.channel.description_blob || params.channel.description || '',
      };

      channel_id = this.factory.getChannelManager()
        ? await this.factory.getChannelManager().createChannel(channelData)
        : await this.factory.getDatabase().createChannel(channelData);
    }

    return { success: true, channel_id };
  }
}