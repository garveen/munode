import type { Logger } from 'winston';
import { MessageType } from '@munode/protocol';
import { mumbleproto } from '@munode/protocol';
import type { HubNotificationParams } from '@munode/protocol';
import { HandlerFactory } from '../core/handler-factory.js';
import { EdgeControlClient } from './hub-client.js';
import { ChannelInfo } from '../types.js';

/**
 * Hub数据管理器
 * 负责从Hub加载频道和ACL数据，以及处理Hub相关的数据同步
 */
export class HubDataManager {
  private handlerFactory: HandlerFactory;
  private hubClient?: EdgeControlClient;
  private logger: Logger;

  constructor(handlerFactory: HandlerFactory, hubClient?: EdgeControlClient) {
    this.handlerFactory = handlerFactory;
    this.hubClient = hubClient;
    this.logger = handlerFactory.logger;
  }

  /**
   * 从Hub加载频道和ACL数据
   */
  async loadDataFromHub(): Promise<void> {
    try {
        this.logger.info('Loading channels and ACLs from Hub...');

      if (!this.hubClient || !this.hubClient.isConnected()) {
        this.logger.warn('Hub client not connected, skipping data load');
        return;
      }

      // 从Hub获取所有频道
      const channels = await this.hubClient.getChannels();
        this.logger.info(`Loaded ${channels.length} channels from Hub`);
      
      // DEBUG: 打印每个从Hub收到的频道数据
      for (const ch of channels) {
        this.logger.debug(`[hub-data-sync] Hub returned channel: id=${ch.channel_id}, name=${ch.name}, parent_id=${ch.parent_id}`);
      }

      // 重建频道树结构
      for (const channelData of channels) {
        const channel: ChannelInfo = {
          id: channelData.channel_id,
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
        this.logger.debug(`Loaded channel: ${channel.name} (${channel.id})`);
      }

      // 从Hub获取所有ACL（channel_id为0表示获取所有频道的ACL）
      try {
        const allAcls = await this.hubClient.getACLs(0);
        this.logger.info(`Loaded ${allAcls.length} ACL entries from Hub for all channels`);

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

          aclMap.get(channelId).push(aclEntry);
        this.logger.debug(`Loaded ACL for channel ${channelId}: user_id=${aclData.user_id}, group=${aclData.group}`);
        }

        // 清除权限缓存，确保使用新的ACL数据
        permissionManager.clearCache();
      } catch (error) {
        this.logger.warn('Failed to load ACLs from Hub:', error);
      }

        this.logger.info('Data loading from Hub completed');
    } catch (error) {
        this.logger.error('Failed to load data from Hub:', error);
      // 不抛出错误，允许服务器以空状态启动
    }
  }

  /**
   * 处理来自其他Edge的用户加入通知
   */
  handleRemoteUserJoined(params: HubNotificationParams<'hub.userJoined'>): void {
    try {
      const isLocalUser = params.edge_id === this.handlerFactory.config.server_id;
      this.logger.info(`[HUB-EVENT] User joined: ${params.username} (session ${params.session_id}) from Edge ${params.edge_id}${isLocalUser ? ' (LOCAL)' : ' (REMOTE)'}, channel=${params.channel_id}`);

      // Track remote user state (不跟踪本地用户)
      if (!isLocalUser && this.handlerFactory.stateManager) {
        this.handlerFactory.stateManager.addRemoteUser(params.session_id, params.edge_id, params.channel_id);
      }

      // Broadcast to all local authenticated clients
      // 对于本地用户：广播给所有有完整用户列表的客户端（包括用户自己，确保获取完整的PreConnect状态）
      // 对于远程用户：广播给所有已注册的本地用户
      const allClients = this.handlerFactory.clientManager.getAllClients();
      let broadcastCount = 0;
      
      for (const client of allClients) {
        const shouldBroadcast = isLocalUser 
          ? client !== undefined 
          : (client.user_id > 0 && client !== undefined);
        
        if (shouldBroadcast) {
          // 🔒 根据接收方是否为已注册用户，决定是否发送证书哈希
          const receiverIsRegistered = client.user_id > 0;
          
          // 构建UserState消息（每个客户端都单独构建，因为cert_hash字段可能不同）
          interface UserStateData {
            session: number;
            actor: number;
            user_id: number;
            name: string;
            channel_id: number;
            temporary_access_tokens: string[];
            listening_channel_add: number[];
            listening_channel_remove: number[];
            hash?: string;
            mute?: boolean;
            deaf?: boolean;
            suppress?: boolean;
            self_mute?: boolean;
            self_deaf?: boolean;
            priority_speaker?: boolean;
            recording?: boolean;
          }
          const userStateData: UserStateData = {
            session: params.session_id,
            actor: params.session_id,
            user_id: params.user_id,
            name: params.username,
            channel_id: params.channel_id,
            temporary_access_tokens: [],
            listening_channel_add: [],
            listening_channel_remove: [],
          };

          // 只有接收方是已注册用户时，才发送证书哈希
          if (params.cert_hash && receiverIsRegistered) {
            userStateData.hash = params.cert_hash;
          }

          // 只包含值为 true 的状态字段（参考 Murmur 实现）
          if (params.mute === true) {
            userStateData.mute = true;
          }
          if (params.deaf === true) {
            userStateData.deaf = true;
          }
          if (params.suppress === true) {
            userStateData.suppress = true;
          }
          if (params.self_mute === true) {
            userStateData.self_mute = true;
          }
          if (params.self_deaf === true) {
            userStateData.self_deaf = true;
          }
          if (params.priority_speaker === true) {
            userStateData.priority_speaker = true;
          }
          if (params.recording === true) {
            userStateData.recording = true;
          }

          const userStateMessage = mumbleproto.UserState.encode(userStateData).finish();
          this.handlerFactory.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userStateMessage));
          this.logger.debug(`[HUB-BROADCAST] Sent UserState to client ${client.session} (user session=${params.session_id}, channel=${params.channel_id})`);
          broadcastCount++;
        }
      }

      this.logger.info(`[HUB-BROADCAST] Broadcasted user ${params.username} (${isLocalUser ? 'LOCAL' : 'REMOTE'}) to ${broadcastCount} local clients`);
    } catch (error) {
        this.logger.error('Error handling remote user joined:', error);
    }
  }

  /**
   * 处理来自其他Edge的用户状态变更通知
   */
  handleRemoteUserStateChanged(params: HubNotificationParams<'hub.userStateChanged'>): void {
    try {
      // Extract edge_id from changes if present
      const changes = params.changes;
      const edgeId = typeof changes.edge_id === 'number' ? changes.edge_id : undefined;

      // 不要处理来自本Edge的用户
      if (edgeId !== undefined && edgeId === this.handlerFactory.config.server_id) {
        return;
      }

        this.logger.debug(`Remote user state changed: session ${params.session_id}${edgeId !== undefined ? ` from Edge ${edgeId}` : ''}`);

      // 更新状态管理器中的远程用户频道信息
      if (typeof changes.channel_id === 'number' && this.handlerFactory.stateManager) {
        this.handlerFactory.stateManager.updateRemoteUserChannel(params.session_id, changes.channel_id);
      }

      // 构建UserState消息，只包含变更的字段
      const userState: any = {
        session: params.session_id,
        actor: 0,
      };
      
      if (typeof changes.channel_id === 'number') {
        userState.channel_id = changes.channel_id;
      }
      if (typeof changes.mute === 'boolean') {
        userState.mute = changes.mute;
      }
      if (typeof changes.deaf === 'boolean') {
        userState.deaf = changes.deaf;
      }
      if (typeof changes.suppress === 'boolean') {
        userState.suppress = changes.suppress;
      }
      if (typeof changes.self_mute === 'boolean') {
        userState.self_mute = changes.self_mute;
      }
      if (typeof changes.self_deaf === 'boolean') {
        userState.self_deaf = changes.self_deaf;
      }
      if (typeof changes.recording === 'boolean') {
        userState.recording = changes.recording;
      }
      if (typeof changes.priority_speaker === 'boolean') {
        userState.priority_speaker = changes.priority_speaker;
      }

      const userStateMessage = mumbleproto.UserState.encode(userState).finish();

      // 广播给所有本地已认证的客户端
      const allClients = this.handlerFactory.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0 && client !== undefined) {
          this.handlerFactory.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userStateMessage));
        }
      }

        this.logger.debug(`Broadcasted remote user state change to ${allClients.filter(c => c.user_id > 0 && c !== undefined).length} local clients`);
    } catch (error) {
        this.logger.error('Error handling remote user state changed:', error);
    }
  }
}