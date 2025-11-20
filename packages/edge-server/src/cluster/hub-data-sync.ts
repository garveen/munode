import { logger } from '@munode/common';
import { MessageType } from '@munode/protocol';
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';
import { HandlerFactory } from '../handler-factory.js';
import { EdgeControlClient } from './hub-client.js';
import { ChannelInfo } from '../types.js';

/**
 * Hub数据管理器
 * 负责从Hub加载频道和ACL数据，以及处理Hub相关的数据同步
 */
export class HubDataManager {
  private handlerFactory: HandlerFactory;
  private hubClient?: EdgeControlClient;

  constructor(handlerFactory: HandlerFactory, hubClient?: EdgeControlClient) {
    this.handlerFactory = handlerFactory;
    this.hubClient = hubClient;
  }

  /**
   * 从Hub加载频道和ACL数据
   */
  async loadDataFromHub(): Promise<void> {
    try {
      logger.info('Loading channels and ACLs from Hub...');

      if (!this.hubClient || !this.hubClient.isConnected()) {
        logger.warn('Hub client not connected, skipping data load');
        return;
      }

      // 从Hub获取所有频道
      const channels = await this.hubClient.getChannels();
      logger.info(`Loaded ${channels.length} channels from Hub`);

      // 重建频道树结构
      for (const channelData of channels) {
        const channel: ChannelInfo = {
          id: channelData.id,
          name: channelData.name,
          // Hub返回的是parent_id，需要转换为parent_id
          parent_id: channelData.parent_id === null || channelData.parent_id === undefined ? 0 : channelData.parent_id,
          position: channelData.position || 0,
          max_users: channelData.max_users || 0,
          description: channelData.description || '',
          temporary: channelData.temporary || false,
          inherit_acl: channelData.inherit_acl !== undefined ? channelData.inherit_acl : true,
          children: [],
          links: channelData.links || [],
        };

        // 将频道添加到ChannelManager
        this.handlerFactory.channelManager.addOrUpdateChannel(channel);
        logger.debug(`Loaded channel: ${channel.name} (${channel.id})`);
      }

      // 从Hub获取所有ACL（channel_id为0表示获取所有频道的ACL）
      try {
        const allAcls = await this.hubClient.getACLs(0);
        logger.info(`Loaded ${allAcls.length} ACL entries from Hub for all channels`);

        const aclMap = this.handlerFactory.aclMap;
        const permissionManager = this.handlerFactory.permissionManager;

        // 将ACL按频道分组存储到aclMap
        for (const aclData of allAcls) {
          const channelId = aclData.channel_id;
          if (!aclMap.has(channelId)) {
            aclMap.set(channelId, []);
          }

          const aclEntry = {
            user_id: aclData.user_id,
            group: aclData.group || '',
            apply_here: aclData.apply_here,
            apply_subs: aclData.apply_subs,
            allow: aclData.allow,
            deny: aclData.deny,
          };

          aclMap.get(channelId)!.push(aclEntry);
          logger.debug(`Loaded ACL for channel ${channelId}: user_id=${aclData.user_id}, group=${aclData.group}`);
        }

        // 清除权限缓存，确保使用新的ACL数据
        permissionManager.clearCache();
      } catch (error) {
        logger.warn('Failed to load ACLs from Hub:', error);
      }

      logger.info('Data loading from Hub completed');
    } catch (error) {
      logger.error('Failed to load data from Hub:', error);
      // 不抛出错误，允许服务器以空状态启动
    }
  }

  /**
   * 处理来自其他Edge的用户加入通知
   */
  handleRemoteUserJoined(params: any): void {
    try {
      logger.info(`Remote user joined: ${params.username} (session ${params.session_id}) from Edge ${params.edge_id}`);

      // 不要处理来自本Edge的用户
      if (params.edge_id !== this.handlerFactory.config.server_id && this.handlerFactory.stateManager) {
        this.handlerFactory.stateManager.addRemoteUser(params.session_id, params.edge_id, params.channel_id);
      }

      // 追踪远程用户状态

      // 构建UserState消息
      const userState = new mumbleproto.UserState({
        session: params.session_id,
        user_id: params.user_id,
        name: params.username,
        channel_id: params.channel_id,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      });

      if (params.cert_hash) {
        userState.hash = params.cert_hash;
      }

      const userStateMessage = userState.serialize();

      // 广播给所有本地已认证的客户端
      const allClients = this.handlerFactory.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0 && client.has_full_user_list) {
          this.handlerFactory.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userStateMessage));
        }
      }

      logger.debug(`Broadcasted remote user ${params.username} to ${allClients.filter(c => c.user_id > 0 && c.has_full_user_list).length} local clients`);
    } catch (error) {
      logger.error('Error handling remote user joined:', error);
    }
  }

  /**
   * 处理来自Hub的用户离开广播
   * Hub收到userLeft通知后会广播给所有Edge（包括发起的Edge）
   */
  handleRemoteUserLeft(params: any): void {
    try {
      const { session_id, edge_id, username } = params;

      logger.info(`User left notification from Hub: ${username || 'unknown'} (session ${session_id}) from Edge ${edge_id}`);

      // 如果是本Edge的用户，Hub的通知只是确认，不需要处理
      if (edge_id === this.handlerFactory.config.server_id) {
        logger.debug('Ignoring userLeft notification for local user');
        return;
      }

      // 从状态管理器中移除远程用户
      if (this.handlerFactory.stateManager) {
        this.handlerFactory.stateManager.removeRemoteUser(session_id);
      }

      // 构建UserRemove消息
      const userRemove = new mumbleproto.UserRemove({
        session: session_id,
      });

      const userRemoveMessage = userRemove.serialize();

      // 广播给所有本地已认证的客户端
      const allClients = this.handlerFactory.clientManager.getAllClients();
      for (const client of allClients) {
        // 跳过用户自己（如果是本Edge的用户断开）
        if (client.session === session_id) {
          continue;
        }

        if (client.user_id > 0) {
          this.handlerFactory.messageHandler.sendMessage(client.session, MessageType.UserRemove, Buffer.from(userRemoveMessage));
        }
      }

      logger.debug(`Broadcasted user removal (session ${session_id}) to ${allClients.filter(c => c.user_id > 0 && c.session !== session_id).length} local clients`);
    } catch (error) {
      logger.error('Error handling user left from Hub:', error);
    }
  }

  /**
   * 处理来自其他Edge的用户状态变更通知
   */
  handleRemoteUserStateChanged(params: any): void {
    try {
      // 不要处理来自本Edge的用户
      if (params.edge_id === this.handlerFactory.config.server_id) {
        return;
      }

      logger.debug(`Remote user state changed: session ${params.session_id} from Edge ${params.edge_id}`);

      // 更新状态管理器中的远程用户频道信息
      if (params.channel_id !== undefined && this.handlerFactory.stateManager) {
        this.handlerFactory.stateManager.updateRemoteUserChannel(params.session_id, params.channel_id);
      }

      // 构建UserState消息
      const userState = new mumbleproto.UserState({
        session: params.session_id,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      });

      // 只包含变更的字段
      if (params.channel_id !== undefined) {
        userState.channel_id = params.channel_id;
      }
      if (params.mute !== undefined) {
        userState.mute = params.mute;
      }
      if (params.deaf !== undefined) {
        userState.deaf = params.deaf;
      }
      if (params.suppress !== undefined) {
        userState.suppress = params.suppress;
      }
      if (params.self_mute !== undefined) {
        userState.self_mute = params.self_mute;
      }
      if (params.self_deaf !== undefined) {
        userState.self_deaf = params.self_deaf;
      }
      if (params.recording !== undefined) {
        userState.recording = params.recording;
      }
      if (params.priority_speaker !== undefined) {
        userState.priority_speaker = params.priority_speaker;
      }

      const userStateMessage = userState.serialize();

      // 广播给所有本地已认证的客户端
      const allClients = this.handlerFactory.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0 && client.has_full_user_list) {
          this.handlerFactory.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userStateMessage));
        }
      }

      logger.debug(`Broadcasted remote user state change to ${allClients.filter(c => c.user_id > 0 && c.has_full_user_list).length} local clients`);
    } catch (error) {
      logger.error('Error handling remote user state changed:', error);
    }
  }
}