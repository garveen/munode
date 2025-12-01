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

import { logger } from '@munode/common';
import { mumbleproto } from '@munode/protocol';
import { MessageType } from '@munode/protocol';
import type { ClientInfo } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

export class HubMessageHandlers {
  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get channelManager() { return this.factory.channelManager; }
  private get stateManager() { return this.factory.stateManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get config() { return this.factory.config; }

  /**
   * 处理来自Hub的UserState广播
   */
  handleUserStateBroadcastFromHub(params: any): void {
    try {
      logger.info(`Edge: Received UserState broadcast from Hub: ${JSON.stringify(params)}`);
      
      const { session_id, edge_id, userState: userStateObj } = params;

      // 重构UserState对象，只包含实际存在的字段
      const userStateInit: any = {
        session: userStateObj.session || session_id,
        actor: userStateObj.actor,
      };
      
      // 只设置实际存在的字段
      if (userStateObj.name !== undefined) {
        userStateInit.name = userStateObj.name;
      }
      if (userStateObj.user_id !== undefined) {
        userStateInit.user_id = userStateObj.user_id;
      }
      if (userStateObj.channel_id !== undefined) {
        userStateInit.channel_id = userStateObj.channel_id;
      }
      if (userStateObj.mute !== undefined) {
        userStateInit.mute = userStateObj.mute;
      }
      if (userStateObj.deaf !== undefined) {
        userStateInit.deaf = userStateObj.deaf;
      }
      if (userStateObj.suppress !== undefined) {
        userStateInit.suppress = userStateObj.suppress;
      }
      if (userStateObj.self_mute !== undefined) {
        userStateInit.self_mute = userStateObj.self_mute;
      }
      if (userStateObj.self_deaf !== undefined) {
        userStateInit.self_deaf = userStateObj.self_deaf;
      }
      if (userStateObj.priority_speaker !== undefined) {
        userStateInit.priority_speaker = userStateObj.priority_speaker;
      }
      if (userStateObj.recording !== undefined) {
        userStateInit.recording = userStateObj.recording;
      }
      
      // 只在有值时才设置 repeated 字段
      if (userStateObj.listening_channel_add && userStateObj.listening_channel_add.length > 0) {
        userStateInit.listening_channel_add = userStateObj.listening_channel_add;
      }
      if (userStateObj.listening_channel_remove && userStateObj.listening_channel_remove.length > 0) {
        userStateInit.listening_channel_remove = userStateObj.listening_channel_remove;
      }
      if (userStateObj.temporary_access_tokens && userStateObj.temporary_access_tokens.length > 0) {
        userStateInit.temporary_access_tokens = userStateObj.temporary_access_tokens;
      }
      
      const userState = new mumbleproto.UserState(userStateInit);

      const targetSession = userState.session || session_id;

      // 更新本地用户状态镜像（如果是本Edge的用户）
      if (edge_id === this.config.server_id) {
        const client = this.clientManager.getClient(targetSession);
        if (client) {
          const updates: Partial<ClientInfo> = {};
          
          if (userState.has_channel_id && userState.channel_id !== undefined) {
            logger.info(`[USERSTATE-DEBUG] Moving local client ${client.username} (session ${targetSession}) from channel ${client.channel_id} to ${userState.channel_id}`);
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
            logger.debug(`Client ${client.username} now listening to channels: ${Array.from(client.listeningChannels).join(', ')}`);
          }
          
          if (userState.listening_channel_remove && userState.listening_channel_remove.length > 0) {
            if (client.listeningChannels) {
              for (const channelId of userState.listening_channel_remove) {
                client.listeningChannels.delete(channelId);
              }
              logger.debug(`Client ${client.username} stopped listening to channels, now: ${Array.from(client.listeningChannels).join(', ')}`);
            }
          }
          
          if (Object.keys(updates).length > 0) {
            this.clientManager.updateClient(targetSession, updates);
          }
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
      logger.debug(`Broadcasted UserState to ${broadcasted} local clients${targetSessionsSet ? ' (filtered)' : ''}`);
    } catch (error) {
      logger.error('Error handling UserState broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的UserState响应
   */
  handleUserStateResponseFromHub(params: any): void {
    try {
      const { success, actor_session, error, permission_denied } = params;

      if (!success) {
        logger.warn(`UserState request from session ${actor_session} failed: ${error}`);
        
        // 如果是权限拒绝，发送PermissionDenied消息给客户端
        if (permission_denied) {
          this.factory.messageHandlers.sendPermissionDenied(actor_session, 'userstate', error || 'Permission denied');
        } else {
          logger.debug(`Sending error notification to session ${actor_session}`);
        }
        return;
      }

      logger.debug(`UserState request from session ${actor_session} succeeded`);
    } catch (error) {
      logger.error('Error handling UserState response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelState响应
   */
  handleChannelStateResponseFromHub(params: any): void {
    try {
      const { success, actor_session, error, permission_denied } = params;

      if (!success) {
        logger.warn(`ChannelState request from session ${actor_session} failed: ${error}`);
        
        if (permission_denied) {
          this.factory.messageHandlers.sendPermissionDenied(actor_session, 'channelstate', error || 'Permission denied');
        }
        return;
      }

      logger.debug(`ChannelState request from session ${actor_session} succeeded`);
    } catch (error) {
      logger.error('Error handling ChannelState response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelState广播
   */
  handleChannelStateBroadcastFromHub(params: any): void {
    try {
      const { channelState } = params;

      logger.debug(`Received ChannelState broadcast from Hub: channel ${channelState.channel_id}`);

      // 更新本地频道状态镜像
      if (channelState.channel_id !== undefined) {
        const existingChannel = this.channelManager.getChannel(channelState.channel_id);
        
        if (existingChannel) {
          const updates: any = {};
          
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
            logger.debug(`Updated channel ${existingChannel.id} links to: [${updates.links.join(', ')}]`);
          } else if (channelState.links_add !== undefined || channelState.links_remove !== undefined) {
            // 基于当前链接进行增量更新
            let newLinks = [...(existingChannel.links || [])];
            
            if (channelState.links_add !== undefined && Array.isArray(channelState.links_add)) {
              for (const linkId of channelState.links_add) {
                if (!newLinks.includes(linkId)) {
                  newLinks.push(linkId);
                }
              }
              logger.debug(`Added links to channel ${existingChannel.id}: [${channelState.links_add.join(', ')}]`);
            }
            
            if (channelState.links_remove !== undefined && Array.isArray(channelState.links_remove)) {
              newLinks = newLinks.filter(linkId => !channelState.links_remove.includes(linkId));
              logger.debug(`Removed links from channel ${existingChannel.id}: [${channelState.links_remove.join(', ')}]`);
            }
            
            updates.links = newLinks;
            logger.debug(`Channel ${existingChannel.id} final links: [${newLinks.join(', ')}]`);
          }
          
          // 应用更新
          if (Object.keys(updates).length > 0) {
            this.channelManager.updateChannel(existingChannel.id, updates);
            
            // 更新stateManager
            const updatedChannel = { ...existingChannel, ...updates };
            this.stateManager.addOrUpdateChannel(updatedChannel);
          }
        } else {
          // 创建新频道
          const newChannelData = {
            id: channelState.channel_id,
            name: channelState.name || 'Unnamed Channel',
            parent_id: channelState.parent || 0,
            description: channelState.description || '',
            position: channelState.position || 0,
            max_users: channelState.max_users || 0,
            temporary: channelState.temporary || false,
            inherit_acl: channelState.inherit_acl !== undefined ? channelState.inherit_acl : true,
            children: [],
            links: [],
          };

          this.channelManager.addOrUpdateChannel(newChannelData);
          this.stateManager.addOrUpdateChannel(newChannelData);
        }
      }

      // 广播给所有本地已认证的客户端
      const channelStateMsg = new mumbleproto.ChannelState(channelState);
      const channelStateMessage = channelStateMsg.serialize();
      const allClients = this.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0) {
          this.messageHandler.sendMessage(client.session, MessageType.ChannelState, Buffer.from(channelStateMessage));
        }
      }

      logger.debug(`Broadcasted ChannelState to ${allClients.filter(c => c.user_id > 0).length} local clients`);
    } catch (error) {
      logger.error('Error handling ChannelState broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的UserRemove响应
   */
  handleUserRemoveResponseFromHub(params: any): void {
    try {
      const { success, actor_session, error } = params;

      if (!success) {
        logger.warn(`UserRemove request from session ${actor_session} failed: ${error}`);
        this.factory.messageHandlers.sendPermissionDenied(actor_session, 'kick', error || 'Operation failed');
        return;
      }

      logger.debug(`UserRemove request from session ${actor_session} succeeded`);
    } catch (error) {
      logger.error('Error handling UserRemove response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的UserRemove广播
   */
  handleUserRemoveBroadcastFromHub(params: any): void {
    try {
      const { session_id, actor_session, target_session, target_edge_id, reason, ban, target_sessions } = params;

      // Use session_id as primary target (Channel Ninja mode), otherwise use target_session (traditional kick/ban mode)
      const actualTargetSession = session_id || target_session;

      logger.debug(`Received UserRemove broadcast from Hub: target ${actualTargetSession} on Edge ${target_edge_id}${target_sessions ? ' (filtered)' : ''}`);

      // 构建UserRemove消息
      const userRemove = new mumbleproto.UserRemove({
        session: actualTargetSession,
        actor: actor_session,
        reason: reason || '',
        ban: ban || false,
      });

      const userRemoveMessage = userRemove.serialize();

      // Broadcast to all local authenticated clients (if target_sessions provided, only broadcast to these clients)
      const allClients = this.clientManager.getAllClients();
      const targetSessionsSet = target_sessions ? new Set(target_sessions) : null; // Convert to Set for O(1) lookup
      
      for (const client of allClients) {
        if (client.user_id > 0) {
          // If target_sessions provided, only broadcast to specified sessions (Channel Ninja mode)
          if (!targetSessionsSet || targetSessionsSet.has(client.session)) {
            this.messageHandler.sendMessage(client.session, MessageType.UserRemove, Buffer.from(userRemoveMessage));
          }
        }
      }

      // If target user on this Edge and is real kick/ban (not Channel Ninja hiding), force disconnect
      if (!target_sessions && target_edge_id === this.config.server_id) {
        const targetClient = this.clientManager.getClient(actualTargetSession);
        if (targetClient) {
          this.clientManager.forceDisconnect(
            actualTargetSession,
            ban ? `Banned: ${reason}` : `Kicked: ${reason}`
          );
          logger.info(`Disconnected local client ${actualTargetSession} due to ${ban ? 'ban' : 'kick'}`);
        }
      }

      const broadcasted = targetSessionsSet 
        ? allClients.filter(c => c.user_id > 0 && targetSessionsSet.has(c.session)).length
        : allClients.filter(c => c.user_id > 0).length;
      logger.debug(`Broadcasted UserRemove to ${broadcasted} local clients${targetSessionsSet ? ' (filtered)' : ''}`);
    } catch (error) {
      logger.error('Error handling UserRemove broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelRemove响应
   */
  handleChannelRemoveResponseFromHub(data: any): void {
    try {
      const { success, error, actor_session } = data;
      
      logger.info(`ChannelRemove response from Hub: success=${success}, error=${error}`);
      
      // 找到发起删除的客户端
      const actor = this.clientManager.getClient(actor_session);
      if (!actor) {
        logger.warn(`ChannelRemove actor ${actor_session} not found on this Edge`);
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
        logger.info(`Sent PermissionDenied to actor ${actor_session}: ${error}`);
      }
    } catch (error) {
      logger.error('Error handling ChannelRemove response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelRemove广播
   */
  handleChannelRemoveBroadcastFromHub(data: any): void {
    try {
      const { channel_id, channels_removed, affected_sessions, parent_id } = data;
      
      logger.info(
        `ChannelRemove broadcast from Hub: channel=${channel_id}, ` +
        `removed=${channels_removed.length}, affected=${affected_sessions.length}`
      );
      
      // 1. 更新本地频道镜像 - 删除所有被移除的频道
      for (const removed_id of channels_removed) {
        this.channelManager.removeChannel(removed_id);
        this.stateManager.removeChannel(removed_id);
        logger.debug(`Removed channel ${removed_id} from local mirrors`);
      }
      
      // 2. 更新受影响用户的频道位置（他们已被Hub移动到父频道）
      for (const session of affected_sessions) {
        const client = this.clientManager.getClient(session);
        if (client) {
          const oldChannel = client.channel_id;
          client.channel_id = parent_id;
          logger.debug(`Updated session ${session} channel: ${oldChannel} -> ${parent_id}`);
        }
      }
      
      // 3. 为每个被删除的频道构造ChannelRemove消息并广播给所有本地客户端
      const allClients = this.clientManager.getAllClients();
      for (const removed_id of channels_removed) {
        const channelRemoveMessage = {
          channel_id: removed_id,
        };
        const channelRemoveBuffer = Buffer.from(
          new mumbleproto.ChannelRemove(channelRemoveMessage).serialize()
        );
        
        for (const client of allClients) {
          if (client.user_id > 0) {
            this.messageHandler.sendMessage(client.session, MessageType.ChannelRemove, channelRemoveBuffer);
          }
        }
      }
      
      // 4. 为每个受影响的用户发送UserState更新（新的channel_id）
      for (const session of affected_sessions) {
        const client = this.clientManager.getClient(session);
        if (client) {
          const userStateUpdate = new mumbleproto.UserState({
            session,
            channel_id: parent_id,
            temporary_access_tokens: [],
            listening_channel_add: [],
            listening_channel_remove: [],
          });
          const userStateBuffer = Buffer.from(userStateUpdate.serialize());
          
          // 广播给所有本地客户端
          for (const c of allClients) {
            if (c.user_id > 0) {
              this.messageHandler.sendMessage(c.session, MessageType.UserState, userStateBuffer);
            }
          }
        }
      }
      
      logger.debug(`Broadcasted ChannelRemove to ${allClients.filter(c => c.user_id > 0).length} local clients`);
    } catch (error) {
      logger.error('Error handling ChannelRemove broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的TextMessage广播
   */
  handleTextMessageBroadcastFromHub(params: any): void {
    try {
      const { textMessage, target_sessions } = params;

      logger.debug(
        `Received TextMessage broadcast from Hub: from ${textMessage.actor}, targets: ${target_sessions.length}`
      );

      // 构建TextMessage消息
      const textMsg = new mumbleproto.TextMessage({
        actor: textMessage.actor,
        session: textMessage.session || [],
        channel_id: textMessage.channel_id || [],
        tree_id: textMessage.tree_id || [],
        message: textMessage.message || '',
      });

      const textMessageBuffer = Buffer.from(textMsg.serialize());

      // 只发送给本Edge上的目标用户
      let sentCount = 0;
      for (const targetSession of target_sessions) {
        const client = this.clientManager.getClient(targetSession);
        if (client && client.user_id > 0) {
          this.messageHandler.sendMessage(targetSession, MessageType.TextMessage, textMessageBuffer);
          sentCount++;
        }
      }

      logger.debug(`Broadcasted TextMessage to ${sentCount} local clients`);
    } catch (error) {
      logger.error('Error handling TextMessage broadcast from Hub:', error);
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
    // Handle serialized Buffer object from msgpack: { type: 'Buffer', data: [...] }
    if (typeof data === 'object' && 'type' in data && data.type === 'Buffer' && 'data' in data && Array.isArray(data.data)) {
      return Buffer.from(data.data);
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
  handlePluginDataBroadcastFromHub(params: any): void {
    try {
      const { pluginData, target_sessions } = params;

      logger.debug(
        `Received PluginData broadcast from Hub: from ${pluginData.senderSession}, targets: ${target_sessions.length}`
      );

      // 构建PluginDataTransmission消息
      // 注意：根据 Mumble 协议，发送给客户端时应清除 receiverSessions
      const pluginDataMsg = new mumbleproto.PluginDataTransmission({
        senderSession: pluginData.senderSession,
        dataID: pluginData.dataID || '',
        data: this.normalizeDataField(pluginData.data),
        receiverSessions: [], // 清除接收者列表，客户端不需要知道
      });

      const pluginDataBuffer = Buffer.from(pluginDataMsg.serialize());

      // 只发送给本Edge上的目标用户
      let sentCount = 0;
      for (const targetSession of target_sessions) {
        const client = this.clientManager.getClient(targetSession);
        if (client && client.user_id > 0) {
          this.messageHandler.sendMessage(targetSession, MessageType.PluginDataTransmission, pluginDataBuffer);
          sentCount++;
        }
      }

      logger.debug(`Broadcasted PluginData to ${sentCount} local clients`);
    } catch (error) {
      logger.error('Error handling PluginData broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的语音数据
   */
  handleVoiceDataFromHub(data: any, respond: (result?: any, error?: any) => void): void {
    try {
      // TODO: 实现VoiceRouter.handleVoiceDataFromHub方法
      logger.debug('Received voice data from Hub:', data);
      respond({ success: true });
    } catch (error) {
      logger.error('Error handling voice data from Hub:', error);
      respond(undefined, { code: -32603, message: 'Internal error' });
    }
  }

  /**
   * 处理来自Hub的ACL更新通知
   */
  handleACLUpdatedNotification(params: { channel_id: number; timestamp: number }): void {
    try {
      const { channel_id } = params;
      logger.info(`Received ACL update notification for channel ${channel_id}`);
      
      // 触发频道权限刷新（委托给 PermissionHandlers）
      const permissionHandlers = this.factory.permissionHandlers;
      void permissionHandlers.refreshChannelPermissions(channel_id);
    } catch (error) {
      logger.error('Error handling ACL update notification:', error);
    }
  }

  /**
   * 处理来自Hub的UserStats响应
   */
  handleUserStatsResponseFromHub(params: any): void {
    try {
      const { actor_session, userStats, error } = params;

      if (error) {
        logger.warn(`UserStats request from session ${actor_session} failed: ${error}`);
        // 发送空响应或错误提示
        return;
      }

      // 将 Hub 返回的 UserStats 数据发送给请求的客户端
      logger.debug(`Sending UserStats response to session ${actor_session}`);
      
      // 构建 UserStats protobuf 对象
      const response: any = {
        session: userStats.session,
        onlinesecs: userStats.onlinesecs,
        idlesecs: userStats.idlesecs,
      };

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
          response.address = userStats.address;
        }
        if (userStats.version) {
          response.version = new mumbleproto.Version(userStats.version);
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
      
      logger.debug(`Sent UserStats response to session ${actor_session}`);
    } catch (error) {
      logger.error('Error handling UserStats response from Hub:', error);
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
      logger.info('Received voice routing config from Hub:', {
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
      
      logger.info(`Voice routing ${params.enabled ? 'enabled' : 'disabled'} by Hub configuration`);
    } catch (error) {
      logger.error('Error handling voice routing config from Hub:', error);
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
      logger.info(`Received route table update from Hub: ${params.routes.length} routes`);

      // 通知 hubClient 触发 routeTableUpdate 事件
      const hubClient = this.factory.hubClient;
      if (hubClient) {
        hubClient.emit('routeTableUpdateReceived', params.routes);
      }
      
      logger.debug('Route table update details:', {
        routes: params.routes.map(r => ({
          target: r.targetEdgeId,
          type: r.type,
          nextHop: r.nextHop,
          cost: r.cost.toFixed(2),
        })),
      });
    } catch (error) {
      logger.error('Error handling route table update from Hub:', error);
    }
  }
}
