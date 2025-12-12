/**
 * Hub消息处理器
 * 
 * 处理来自 Hub 的消息：
 * - UserState 广播和响应
 * - ChannelState 广播和响应
 * - UserRemove 广播和响应
 * - ChannelRemove 广播和响应
 * - TextMessage 广播
 * - VoiceData 转发
 * - ACL 更新通知
 */

import type { Logger } from 'winston';
import {  mumbleproto } from '@munode/protocol';
import { MessageType } from '@munode/protocol';
import type { HubNotificationParams } from '@munode/protocol';
import type { ChannelInfo, ClientInfo } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

interface ChannelUpdateFields {
  name?: string;
  position?: number;
  max_users?: number;
  description?: string;
  links?: number[];
}

export class HubMessageHandlers {
  private logger: Logger;

  constructor(private factory: HandlerFactory) {
    this.logger = factory.logger;
  }

  private get clientManager() { return this.factory.clientManager; }
  private get channelManager() { return this.factory.channelManager; }
  private get stateManager() { return this.factory.stateManager; }
  private get messageHandler() { return this.factory.messageHandler; }

  /**
   * 处理来自Hub的UserState广播
   */
  handleUserStateBroadcastFromHub(params: HubNotificationParams<'hub.userStateBroadcast'>): void {
    try {
        this.logger.debug(`Edge: Received UserState broadcast from Hub: ${JSON.stringify(params)}`);
      
      // params is the userState object directly, use the type from HubNotificationParams
      // Build UserState protobuf message with only the fields that are set
      // Use any here since we're building a protobuf message dynamically
      const userStateInit: {
        session: number;
        actor: number;
        temporary_access_tokens: string[];
        listening_channel_add: number[];
        listening_channel_remove: number[];
        name?: string;
        user_id?: number;
        channel_id?: number;
        mute?: boolean;
        deaf?: boolean;
        suppress?: boolean;
        self_mute?: boolean;
        self_deaf?: boolean;
        priority_speaker?: boolean;
        recording?: boolean;
        texture?: Uint8Array;
        plugin_context?: Uint8Array;
        plugin_identity?: string;
      } = {
        session: params.session,
        actor: params.actor,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      };
      
      // Only set fields that are defined
      if (params.name !== undefined) userStateInit.name = params.name;
      if (params.user_id !== undefined) userStateInit.user_id = params.user_id;
      if (params.channel_id !== undefined) userStateInit.channel_id = params.channel_id;
      if (params.mute !== undefined) userStateInit.mute = params.mute;
      if (params.deaf !== undefined) userStateInit.deaf = params.deaf;
      if (params.suppress !== undefined) userStateInit.suppress = params.suppress;
      if (params.self_mute !== undefined) userStateInit.self_mute = params.self_mute;
      if (params.self_deaf !== undefined) userStateInit.self_deaf = params.self_deaf;
      if (params.priority_speaker !== undefined) userStateInit.priority_speaker = params.priority_speaker;
      if (params.recording !== undefined) userStateInit.recording = params.recording;
      if (params.texture !== undefined) userStateInit.texture = params.texture;
      if (params.plugin_context !== undefined) userStateInit.plugin_context = params.plugin_context;
      if (params.plugin_identity !== undefined) userStateInit.plugin_identity = params.plugin_identity;
      
      // Only set repeated fields when they have values
      if (params.listening_channel_add && params.listening_channel_add.length > 0) {
        userStateInit.listening_channel_add = params.listening_channel_add;
      }
      if (params.listening_channel_remove && params.listening_channel_remove.length > 0) {
        userStateInit.listening_channel_remove = params.listening_channel_remove;
      }
      if (params.temporary_access_tokens && params.temporary_access_tokens.length > 0) {
        userStateInit.temporary_access_tokens = params.temporary_access_tokens;
      }
      
      const userState = new mumbleproto.UserState(userStateInit);

      const targetSession = userState.session;

      // 更新本地用户状态镜像（如果是本Edge的用户）
      const client = this.clientManager.getClient(targetSession);
      if (client) {
          const updates: Partial<ClientInfo> = {};
          
          if (userState.has_channel_id && userState.channel_id !== undefined) {
        this.logger.info(`[USERSTATE-DEBUG] Moving local client ${client.username} (session ${targetSession}) from channel ${client.channel_id} to ${userState.channel_id}`);
            this.clientManager.moveClient(targetSession, userState.channel_id);
          }
          if (userState.has_mute && userState.mute !== undefined) {
            updates.mute = userState.mute;
          }
          if (userState.has_deaf && userState.deaf !== undefined) {
            updates.deaf = userState.deaf;
          }
          if (userState.has_suppress && userState.suppress !== undefined) {
            updates.suppress = userState.suppress;
          }
          if (userState.has_self_mute && userState.self_mute !== undefined) {
            updates.self_mute = userState.self_mute;
          }
          if (userState.has_self_deaf && userState.self_deaf !== undefined) {
            updates.self_deaf = userState.self_deaf;
          }
          if (userState.has_priority_speaker && userState.priority_speaker !== undefined) {
            updates.priority_speaker = userState.priority_speaker;
          }
          if (userState.has_recording && userState.recording !== undefined) {
            updates.recording = userState.recording;
          }
          
          // 处理监听频道状态更新
          if (userState.listening_channel_add && userState.listening_channel_add.length > 0) {
            if (!client.listeningChannels) {
              client.listeningChannels = new Set();
            }
            for (const channelId of userState.listening_channel_add) {
              client.listeningChannels.add(channelId);
            }
        this.logger.debug(`Client ${client.username} now listening to channels: ${Array.from(client.listeningChannels).join(', ')}`);
          }
          
          if (userState.listening_channel_remove && userState.listening_channel_remove.length > 0) {
            if (client.listeningChannels) {
              for (const channelId of userState.listening_channel_remove) {
                client.listeningChannels.delete(channelId);
              }
        this.logger.debug(`Client ${client.username} stopped listening to channels, now: ${Array.from(client.listeningChannels).join(', ')}`);
            }
          }
          
          if (Object.keys(updates).length > 0) {
            this.clientManager.updateClient(targetSession, updates);
          }
        }

      // Broadcast to all local authenticated clients (if target_sessions provided, only broadcast to these clients)
      const userStateMessage = userState.serialize();
      const allClients = this.clientManager.getAllClients();
      const targetSessions = params.target_sessions; // List of target sessions in Channel Ninja mode
      const targetSessionsSet = targetSessions ? new Set(targetSessions) : null; // Convert to Set for O(1) lookup
      
      for (const client of allClients) {
        if (client.user_id > 0) {
          // If target_sessions provided, only broadcast to specified sessions
          if (!targetSessionsSet || targetSessionsSet.has(client.session)) {
            this.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userStateMessage));
          }
        }
      }

      const broadcasted = targetSessionsSet 
        ? allClients.filter(c => c.user_id > 0 && targetSessionsSet.has(c.session)).length
        : allClients.filter(c => c.user_id > 0).length;
        this.logger.debug(`Broadcasted UserState to ${broadcasted} local clients${targetSessionsSet ? ' (filtered)' : ''}`);
    } catch (error) {
        this.logger.error('Error handling UserState broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的UserState响应
   */
  handleUserStateResponseFromHub(params: HubNotificationParams<'hub.userStateResponse'>): void {
    try {
      const { success, actor_session, error, permission_denied, userState } = params;

      if (!success) {
        this.logger.warn(`UserState request from session ${actor_session} failed: ${error}`);
        
        // 如果是权限拒绝，发送PermissionDenied消息给客户端
        if (permission_denied) {
          this.factory.messageHandlers.sendPermissionDenied(actor_session, 'userstate', error || 'Permission denied');
        } else {
        this.logger.debug(`Sending error notification to session ${actor_session}`);
        }
        return;
      }

      // 如果成功并且有userState数据，发送给客户端
      if (userState) {
        this.logger.debug(`Sending UserState response to session ${actor_session}`);
        
        // Build UserState protobuf message with only the fields that are set
        // Use the same pattern as handleUserStateBroadcastFromHub
        // Use any here since we're building a protobuf message dynamically
        const userStateInit: {
          session: number;
          actor: number;
          temporary_access_tokens: string[];
          listening_channel_add: number[];
          listening_channel_remove: number[];
          name?: string;
          user_id?: number;
          channel_id?: number;
          mute?: boolean;
          deaf?: boolean;
          suppress?: boolean;
          self_mute?: boolean;
          self_deaf?: boolean;
          priority_speaker?: boolean;
          recording?: boolean;
          texture?: Uint8Array;
          plugin_context?: Uint8Array;
          plugin_identity?: string;
        } = {
          session: userState.session,
          actor: userState.actor,
          temporary_access_tokens: [],
          listening_channel_add: [],
          listening_channel_remove: [],
        };
        
        // Only set fields that are defined
        if (userState.name !== undefined) userStateInit.name = userState.name;
        if (userState.user_id !== undefined) userStateInit.user_id = userState.user_id;
        if (userState.channel_id !== undefined) userStateInit.channel_id = userState.channel_id;
        if (userState.mute !== undefined) userStateInit.mute = userState.mute;
        if (userState.deaf !== undefined) userStateInit.deaf = userState.deaf;
        if (userState.suppress !== undefined) userStateInit.suppress = userState.suppress;
        if (userState.self_mute !== undefined) userStateInit.self_mute = userState.self_mute;
        if (userState.self_deaf !== undefined) userStateInit.self_deaf = userState.self_deaf;
        if (userState.priority_speaker !== undefined) userStateInit.priority_speaker = userState.priority_speaker;
        if (userState.recording !== undefined) userStateInit.recording = userState.recording;
        if (userState.texture !== undefined) userStateInit.texture = userState.texture;
        if (userState.plugin_context !== undefined) userStateInit.plugin_context = userState.plugin_context;
        if (userState.plugin_identity !== undefined) userStateInit.plugin_identity = userState.plugin_identity;
        
        // Only set repeated fields when they have values
        if (userState.listening_channel_add && userState.listening_channel_add.length > 0) {
          userStateInit.listening_channel_add = userState.listening_channel_add;
        }
        if (userState.listening_channel_remove && userState.listening_channel_remove.length > 0) {
          userStateInit.listening_channel_remove = userState.listening_channel_remove;
        }
        if (userState.temporary_access_tokens && userState.temporary_access_tokens.length > 0) {
          userStateInit.temporary_access_tokens = userState.temporary_access_tokens;
        }
        
        // 构建UserState消息
        const userStateMsg = new mumbleproto.UserState(userStateInit);
        const userStateBuffer = Buffer.from(userStateMsg.serialize());
        
        // 发送给客户端
        this.messageHandler.sendMessage(actor_session, MessageType.UserState, userStateBuffer);
      } else {
        this.logger.debug(`UserState request from session ${actor_session} succeeded (no state data to send)`);
      }
    } catch (error) {
        this.logger.error('Error handling UserState response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelState响应
   */
  handleChannelStateResponseFromHub(params: HubNotificationParams<'hub.channelStateResponse'>): void {
    try {
      const { success, actor_session, error, permission_denied } = params;

      if (!success) {
        this.logger.warn(`ChannelState request from session ${actor_session} failed: ${error}`);
        
        if (permission_denied) {
          this.factory.messageHandlers.sendPermissionDenied(actor_session, 'channelstate', error || 'Permission denied');
        }
        return;
      }

        this.logger.debug(`ChannelState request from session ${actor_session} succeeded`);
    } catch (error) {
        this.logger.error('Error handling ChannelState response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelState广播
   */
  handleChannelStateBroadcastFromHub(params: HubNotificationParams<'hub.channelStateBroadcast'>): void {
    try {
      const channelState = params;

        this.logger.debug(`Received ChannelState broadcast from Hub: channel ${channelState.channel_id}`);

      // 更新本地频道状态镜像
      if (channelState.channel_id !== undefined) {
        const existingChannel = this.channelManager.getChannel(channelState.channel_id);
        
        if (existingChannel) {
          const updates: ChannelUpdateFields = {};
          
          // 更新现有频道
          if (channelState.name !== undefined) {
            updates.name = channelState.name;
          }
          if (channelState.position !== undefined) {
            updates.position = channelState.position;
          }
          if (channelState.max_users !== undefined) {
            updates.max_users = channelState.max_users;
          }
          if (channelState.description !== undefined) {
            updates.description = channelState.description;
          }
          
          // 处理频道链接
          if (channelState.links !== undefined && Array.isArray(channelState.links)) {
            // 完整替换链接列表
            updates.links = [...channelState.links];
        this.logger.debug(`Updated channel ${existingChannel.id} links to: [${updates.links.join(', ')}]`);
          } else if (channelState.links_add !== undefined || channelState.links_remove !== undefined) {
            // 基于当前链接进行增量更新
            let newLinks = [...(existingChannel.links || [])];
            
            if (channelState.links_add !== undefined && Array.isArray(channelState.links_add)) {
              for (const linkId of channelState.links_add) {
                if (!newLinks.includes(linkId)) {
                  newLinks.push(linkId);
                }
              }
        this.logger.debug(`Added links to channel ${existingChannel.id}: [${channelState.links_add.join(', ')}]`);
            }
            
            if (channelState.links_remove !== undefined && Array.isArray(channelState.links_remove)) {
              newLinks = newLinks.filter(linkId => !channelState.links_remove.includes(linkId));
        this.logger.debug(`Removed links from channel ${existingChannel.id}: [${channelState.links_remove.join(', ')}]`);
            }
            
            updates.links = newLinks;
        this.logger.debug(`Channel ${existingChannel.id} final links: [${newLinks.join(', ')}]`);
          }
          
          // 应用更新
          if (Object.keys(updates).length > 0) {
            this.channelManager.updateChannel(existingChannel.id, updates);
            
            // 更新stateManager
            const updatedChannel = { ...existingChannel, ...updates };
            this.stateManager.addOrUpdateChannel(updatedChannel);
            
            if (existingChannel.id === 0 && updates.links) {
        this.logger.debug(`[HUB-HANDLER] Updated stateManager channel 0 with links: [${updates.links.join(', ')}]`);
            }
          }
        } else {
          // 创建新频道
          const newChannelData: ChannelInfo = {
            id: channelState.channel_id,
            name: channelState.name || 'Unnamed Channel',
            parent_id: channelState.parent || 0,
            description: channelState.description || '',
            position: channelState.position || 0,
            max_users: channelState.max_users || 0,
            temporary: channelState.temporary || false,
            inherit_acl: channelState.inherit_acl !== undefined ? channelState.inherit_acl : true,
            children: [],
            links: channelState.links || [], // 使用广播中的链接，而不是硬编码为空数组
          };

        this.logger.debug(`[CHANNEL-LINKS] Created new channel ${channelState.channel_id} with links: [${newChannelData.links.join(', ')}]`);
          this.channelManager.addOrUpdateChannel(newChannelData);
          this.stateManager.addOrUpdateChannel(newChannelData);
        }
      }

      // 广播给所有本地已认证的客户端
      // Construct ChannelState message with the fields present in the notification
      const channelStateInit: {
        channel_id: number;
        parent?: number;
        name?: string;
        description?: string;
        description_hash?: Buffer;
        temporary?: boolean;
        position?: number;
        max_users?: number;
        is_enter_restricted?: boolean;
        can_enter?: boolean;
        links: number[];
        links_add: number[];
        links_remove: number[];
      } = {
        channel_id: channelState.channel_id,
        links: channelState.links || [],
        links_add: channelState.links_add || [],
        links_remove: channelState.links_remove || [],
      };
      
      if (channelState.parent !== undefined) channelStateInit.parent = channelState.parent;
      if (channelState.name !== undefined) channelStateInit.name = channelState.name;
      if (channelState.description !== undefined) channelStateInit.description = channelState.description;
      if (channelState.description_hash !== undefined) channelStateInit.description_hash = channelState.description_hash;
      if (channelState.temporary !== undefined) channelStateInit.temporary = channelState.temporary;
      if (channelState.position !== undefined) channelStateInit.position = channelState.position;
      if (channelState.max_users !== undefined) channelStateInit.max_users = channelState.max_users;
      if (channelState.is_enter_restricted !== undefined) channelStateInit.is_enter_restricted = channelState.is_enter_restricted;
      if (channelState.can_enter !== undefined) channelStateInit.can_enter = channelState.can_enter;

      const channelStateMsg = new mumbleproto.ChannelState(channelStateInit);
      const channelStateMessage = channelStateMsg.serialize();
      const allClients = this.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0) {
          this.messageHandler.sendMessage(client.session, MessageType.ChannelState, Buffer.from(channelStateMessage));
        }
      }

        this.logger.debug(`Broadcasted ChannelState to ${allClients.filter(c => c.user_id > 0).length} local clients`);
    } catch (error) {
        this.logger.error('Error handling ChannelState broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的UserRemove响应
   */
  handleUserRemoveResponseFromHub(params: HubNotificationParams<'hub.userRemoveResponse'>): void {
    try {
      const { success, actor_session, error } = params;

      if (!success) {
        this.logger.warn(`UserRemove request from session ${actor_session} failed: ${error}`);
        this.factory.messageHandlers.sendPermissionDenied(actor_session, 'kick', error || 'Operation failed');
        return;
      }

        this.logger.debug(`UserRemove request from session ${actor_session} succeeded`);
    } catch (error) {
        this.logger.error('Error handling UserRemove response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的UserRemove广播
   */
  handleUserRemoveBroadcastFromHub(params: HubNotificationParams<'hub.userRemoveBroadcast'>): void {
    try {
      const { session, actor, reason, ban, target_sessions } = params;

        this.logger.debug(`Received UserRemove broadcast from Hub: target ${session}, ninja mode: ${!!target_sessions}`);

      // 构建UserRemove消息
      const userRemove = new mumbleproto.UserRemove({
        session: session,
        actor: actor,
        reason: reason || '',
        ban: ban || false,
      });

      const userRemoveMessage = userRemove.serialize();

      // Broadcast to local authenticated clients
      // If target_sessions is provided (ninja mode), only send to specified sessions
      const allClients = this.clientManager.getAllClients();
      const targetSessionsSet = target_sessions ? new Set(target_sessions) : null;
      
      for (const client of allClients) {
        if (client.user_id > 0) {
          // If target_sessions provided, only broadcast to specified sessions
          if (!targetSessionsSet || targetSessionsSet.has(client.session)) {
            this.messageHandler.sendMessage(client.session, MessageType.UserRemove, Buffer.from(userRemoveMessage));
          }
        }
      }

      // If target_sessions is NOT provided, this is a real kick/ban - force disconnect
      // If target_sessions IS provided, this is ninja mode - don't disconnect
      if (!target_sessions) {
        const targetClient = this.clientManager.getClient(session);
        if (targetClient) {
          this.clientManager.forceDisconnect(
            session,
            ban ? `Banned: ${reason || ''}` : `Kicked: ${reason || ''}`
          );
        this.logger.info(`Disconnected local client ${session} due to ${ban ? 'ban' : 'kick'}`);
        }
      }

      const broadcasted = targetSessionsSet 
        ? allClients.filter(c => c.user_id > 0 && targetSessionsSet.has(c.session)).length
        : allClients.filter(c => c.user_id > 0).length;
        this.logger.debug(`Broadcasted UserRemove to ${broadcasted} local clients${targetSessionsSet ? ' (filtered)' : ''}`);
    } catch (error) {
        this.logger.error('Error handling UserRemove broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelRemove响应
   */
  handleChannelRemoveResponseFromHub(data: HubNotificationParams<'hub.channelRemoveResponse'>): void {
    try {
      const { success, error, actor_session } = data;
      
        this.logger.info(`ChannelRemove response from Hub: success=${success}, error=${error}`);
      
      // 找到发起删除的客户端
      const actor = this.clientManager.getClient(actor_session);
      if (!actor) {
        this.logger.warn(`ChannelRemove actor ${actor_session} not found on this Edge`);
        return;
      }
      
      // 如果失败，返回错误给客户端
      if (!success && error) {
        this.factory.messageHandlers.sendPermissionDenied(
          actor_session,
          'write',
          error,
          0,
          mumbleproto.PermissionDenied.DenyType.Permission
        );
        this.logger.info(`Sent PermissionDenied to actor ${actor_session}: ${error}`);
      }
    } catch (error) {
        this.logger.error('Error handling ChannelRemove response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelRemove广播
   */
  handleChannelRemoveBroadcastFromHub(data: HubNotificationParams<'hub.channelRemoveBroadcast'>): void {
    try {
      const { channel_id } = data;
      
        this.logger.info(`ChannelRemove broadcast from Hub: channel=${channel_id}`);
      
      // 更新本地频道镜像 - 删除频道
      this.channelManager.removeChannel(channel_id);
      this.stateManager.removeChannel(channel_id);
        this.logger.debug(`Removed channel ${channel_id} from local mirrors`);
      
      // 构造ChannelRemove消息并广播给所有本地客户端
      const allClients = this.clientManager.getAllClients();
      const channelRemoveMessage = {
        channel_id: channel_id,
      };
      const channelRemoveBuffer = Buffer.from(
        new mumbleproto.ChannelRemove(channelRemoveMessage).serialize()
      );
      
      for (const client of allClients) {
        if (client.user_id > 0) {
          this.messageHandler.sendMessage(client.session, MessageType.ChannelRemove, channelRemoveBuffer);
        }
      }
      
        this.logger.debug(`Broadcasted ChannelRemove to ${allClients.filter(c => c.user_id > 0).length} local clients`);
    } catch (error) {
        this.logger.error('Error handling ChannelRemove broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的TextMessage广播
   */
  handleTextMessageBroadcastFromHub(params: HubNotificationParams<'hub.textMessageBroadcast'>): void {
    try {
      const { actor, session, channel_id, tree_id, message } = params;

        this.logger.debug(
        `Received TextMessage broadcast from Hub: from ${actor}`
      );

      // 构建TextMessage消息
      const textMsg = new mumbleproto.TextMessage({
        actor,
        session: session || [],
        channel_id: channel_id || [],
        tree_id: tree_id || [],
        message: message || '',
      });

      const textMessageBuffer = Buffer.from(textMsg.serialize());

      // 发送给所有本地客户端（let them filter by target）
      let sentCount = 0;
      for (const client of this.clientManager.getAllClients()) {
        if (client && client.user_id > 0) {
          this.messageHandler.sendMessage(client.session, MessageType.TextMessage, textMessageBuffer);
          sentCount++;
        }
      }

        this.logger.debug(`Broadcasted TextMessage to ${sentCount} local clients`);
    } catch (error) {
        this.logger.error('Error handling TextMessage broadcast from Hub:', error);
    }
  }

  /**
   * 将来自 RPC 的数据字段规范化为 Uint8Array
   * msgpack 序列化可能产生不同的数据类型
   */
  private normalizeDataField(data: Buffer | Uint8Array | { type: string; data: number[] } | null | undefined): Uint8Array {
    if (!data) {
      return new Uint8Array(0);
    }
    if (Buffer.isBuffer(data)) {
      return data;
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    if (typeof data === 'object') {
      const obj = data as any;
      
      // Handle { type: 'Buffer', data: [...] } format (Node.js Buffer.toJSON())
      if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
        return Buffer.from(obj.data);
      }
      
      // Handle array-like object with numeric keys (msgpack serialization of Uint8Array/Buffer)
      if (Object.keys(obj).every((k: string) => !isNaN(Number(k)))) {
        const values = Object.keys(obj).sort((a, b) => Number(a) - Number(b)).map(k => obj[k]);
        return Buffer.from(values);
      }
    }
    return new Uint8Array(0);
  }

  /**
   * 处理来自Hub的插件数据广播
   * 
   * 注意：遵循 Mumble 官方实现，发送给客户端时清除 receiverSessions 字段
   * 客户端不需要知道其他接收者列表
   * 参考：mumble-voip/mumble/src/murmur/Messages.cpp msgPluginDataTransmission
   */
  handlePluginDataBroadcastFromHub(params: HubNotificationParams<'hub.pluginDataBroadcast'>): void {
    try {
      const { sender_session, dataID, data, target_sessions } = params;

        this.logger.debug(
        `Received PluginData broadcast from Hub: from ${sender_session}, dataID=${dataID}, target_sessions=${target_sessions?.length ?? 'all'}`
      );

      // 构建PluginDataTransmission消息
      // 注意：根据 Mumble 协议，发送给客户端时应清除 receiverSessions
      const normalizedData = this.normalizeDataField(data);
      
      const pluginDataMsg = new mumbleproto.PluginDataTransmission({
        senderSession: sender_session,
        dataID: dataID || '',
        data: normalizedData,
        receiverSessions: [], // 清除接收者列表，客户端不需要知道
      });

      const pluginDataBuffer = Buffer.from(pluginDataMsg.serialize());

      // 发送给目标客户端
      let sentCount = 0;
      for (const client of this.clientManager.getAllClients()) {
        if (client && client.user_id > 0) {
          // 如果指定了target_sessions，只发送给这些会话
          if (target_sessions && target_sessions.length > 0) {
            if (target_sessions.includes(client.session)) {
              this.messageHandler.sendMessage(client.session, MessageType.PluginDataTransmission, pluginDataBuffer);
              sentCount++;
            }
          } else {
            // 没有指定target_sessions，广播给所有本地客户端
            this.messageHandler.sendMessage(client.session, MessageType.PluginDataTransmission, pluginDataBuffer);
            sentCount++;
          }
        }
      }

        this.logger.debug(`Sent PluginData to ${sentCount} local clients (target_sessions=${target_sessions?.length ?? 'all'})`);
    } catch (error) {
        this.logger.error('Error handling PluginData broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的语音数据
   */
  handleVoiceDataFromHub(data: HubNotificationParams<'voice.data'>, respond: (result?: unknown, error?: unknown) => void): void {
    try {
      // TODO: 实现VoiceRouter.handleVoiceDataFromHub方法
        this.logger.debug('Received voice data from Hub:', data);
      respond({ success: true });
    } catch (error) {
        this.logger.error('Error handling voice data from Hub:', error);
      respond(undefined, { code: -32603, message: 'Internal error' });
    }
  }

  /**
   * 处理来自Hub的ACL更新通知
   */
  handleACLUpdatedNotification(params: { channel_id: number; timestamp: number }): void {
    try {
      const { channel_id } = params;
        this.logger.info(`Received ACL update notification for channel ${channel_id}`);
      
      // 触发频道权限刷新（委托给 PermissionHandlers）
      const permissionHandlers = this.factory.permissionHandlers;
      void permissionHandlers.refreshChannelPermissions(channel_id);
    } catch (error) {
        this.logger.error('Error handling ACL update notification:', error);
    }
  }

  /**
   * 处理来自Hub的UserStats响应
   */
  handleUserStatsResponseFromHub(params: HubNotificationParams<'hub.userStatsResponse'>): void {
    try {
      const { actor_session, error, userStats } = params;

      if (error) {
        this.logger.warn(`UserStats request from session ${actor_session} failed: ${error}`);
        // 发送空响应或错误提示
        return;
      }

      // 如果有userStats数据，发送给请求的客户端
      if (userStats) {
        this.logger.debug(`Sending UserStats response to session ${actor_session}`);
        
        // 构建 UserStats protobuf 对象
        // Use any here since we're building a protobuf message dynamically
        const response: {
          session: number;
          certificates: Uint8Array[];
          from_client?: mumbleproto.UserStats.Stats;
          from_server?: mumbleproto.UserStats.Stats;
          udp_packets?: number;
          tcp_packets?: number;
          udp_ping_avg?: number;
          udp_ping_var?: number;
          tcp_ping_avg?: number;
          tcp_ping_var?: number;
          version?: mumbleproto.Version;
          strong_certificate?: boolean;
          address?: Uint8Array;
          bandwidth?: number;
          onlinesecs?: number;
          idlesecs?: number;
          stats_only?: boolean;
          celt_versions: number[];
          opus?: boolean;
        } = {
          session: userStats.session,
          certificates: [],
          celt_versions: [],
        };

        // 添加基本统计字段
        if (userStats.onlinesecs !== undefined) {
          response.onlinesecs = userStats.onlinesecs;
        }
        if (userStats.idlesecs !== undefined) {
          response.idlesecs = userStats.idlesecs;
        }

        // 添加 stats_only 标志（如果在请求中设置）
        if (userStats.stats_only !== undefined) {
          response.stats_only = userStats.stats_only;
        }

        // 仅在非 stats_only 模式下添加详细信息字段
        if (!userStats.stats_only) {
          // 添加可选字段
          if (userStats.strong_certificate !== undefined) {
            response.strong_certificate = userStats.strong_certificate;
          }
          if (userStats.address) {
            // Convert address string to Uint8Array if needed
            response.address = typeof userStats.address === 'string' 
              ? new TextEncoder().encode(userStats.address)
              : userStats.address;
          }
          if (userStats.version) {
            response.version = new mumbleproto.Version({
              version: (userStats.version.major || 0) << 16 | (userStats.version.minor || 0) << 8 | (userStats.version.patch || 0),
              release: `${userStats.version.major}.${userStats.version.minor}.${userStats.version.patch || 0}`,
              os: '',
              os_version: '',
            });
          }
          // 注意：证书链 (certificates) 由 protobuf 自动初始化为空数组
          // 如果有证书数据需要添加，在这里处理
          if (userStats.certificates && userStats.certificates.length > 0) {
            response.certificates = userStats.certificates;
          }
        }

        // 添加网络统计字段（需要转换为 protobuf 对象）
        if (userStats.from_client) {
          response.from_client = new mumbleproto.UserStats.Stats(userStats.from_client);
        }
        if (userStats.from_server) {
          response.from_server = new mumbleproto.UserStats.Stats(userStats.from_server);
        }
        if (userStats.udp_packets !== undefined) {
          response.udp_packets = userStats.udp_packets;
        }
        if (userStats.tcp_packets !== undefined) {
          response.tcp_packets = userStats.tcp_packets;
        }
        if (userStats.udp_ping_avg !== undefined) {
          response.udp_ping_avg = userStats.udp_ping_avg;
        }
        if (userStats.udp_ping_var !== undefined) {
          response.udp_ping_var = userStats.udp_ping_var;
        }
        if (userStats.tcp_ping_avg !== undefined) {
          response.tcp_ping_avg = userStats.tcp_ping_avg;
        }
        if (userStats.tcp_ping_var !== undefined) {
          response.tcp_ping_var = userStats.tcp_ping_var;
        }

        const userStatsMessage = new mumbleproto.UserStats(response);
        const responseMessage = userStatsMessage.serialize();
        
        this.messageHandler.sendMessage(actor_session, MessageType.UserStats, Buffer.from(responseMessage));
        
        this.logger.debug(`Sent UserStats response to session ${actor_session}`);
      } else {
        this.logger.debug(`UserStats response for session ${actor_session}: success (no stats data)`);
      }
    } catch (error) {
        this.logger.error('Error handling UserStats response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的语音路由配置推送
   * 
   * Hub 会在以下情况推送配置：
   * 1. Edge 首次注册到 Hub
   * 2. Hub 配置发生变化（热更新）
   * 
   * 配置内容包括：
   * - enabled: 功能总开关
   * - policy: 路由策略参数
   * - preferredRelayEdges: 优选中转节点
   * - hubRelay: Hub 中转配置
   */
  handleVoiceRoutingConfigFromHub(params: {
    enabled: boolean;
    policy?: {
      directRttThreshold: number;
      directLossThreshold: number;
      enableRelay: boolean;
      maxRelayHops: number;
      relayCostFactor: number;
      routeSwitchHysteresis: number;
      routeSwitchCostDelta: number;
      maxRelayLoadPerEdge: number;
      probeInterval: number;
      routeTableUpdateInterval: number;
    };
    preferredRelayEdges?: number[];
    hubRelay?: {
      enableTcpFallback: boolean;
    };
  }): void {
    try {
        this.logger.info('Received voice routing config from Hub:', {
        enabled: params.enabled,
        policy: params.policy ? {
          directRttThreshold: params.policy.directRttThreshold,
          directLossThreshold: params.policy.directLossThreshold,
        } : undefined,
      });

      // 通知 hubClient 触发 voiceRoutingConfig 事件
      // hubClient 的监听器会处理这个配置
      const hubClient = this.factory.hubClient;
      if (hubClient) {
        hubClient.emit('voiceRoutingConfigReceived', params);
      }
      
        this.logger.info(`Voice routing ${params.enabled ? 'enabled' : 'disabled'} by Hub configuration`);
    } catch (error) {
        this.logger.error('Error handling voice routing config from Hub:', error);
    }
  }

  /**
   * 处理来自 Hub 的路由表更新
   * 
   * Hub 会定期推送全局计算的路由表给每个 Edge
   * Edge 应该使用这些路由来决定如何发送语音包
   */
  handleRouteTableUpdateFromHub(params: {
    routes: Array<{
      targetEdgeId: number;
      type: 'direct' | 'relay' | 'fallback';
      nextHop?: number;
      cost: number;
      timestamp: number;
      source: 'hub' | 'local';
    }>;
  }): void {
    try {
        this.logger.info(`Received route table update from Hub: ${params.routes.length} routes`);

      // 通知 hubClient 触发 routeTableUpdate 事件
      const hubClient = this.factory.hubClient;
      if (hubClient) {
        hubClient.emit('routeTableUpdateReceived', params.routes);
      }
      
        this.logger.debug('Route table update details:', {
        routes: params.routes.map(r => ({
          target: r.targetEdgeId,
          type: r.type,
          nextHop: r.nextHop,
          cost: r.cost.toFixed(2),
        })),
      });
    } catch (error) {
        this.logger.error('Error handling route table update from Hub:', error);
    }
  }
}
