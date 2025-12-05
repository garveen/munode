import { logger } from '@munode/common';
import { HandlerFactory } from '../core/handler-factory.js';
import { EdgeControlClient } from '../cluster/hub-client.js';
import { VoiceManager } from './voice-manager.js';
import { HubDataManager } from '../cluster/hub-data-sync.js';
import { BanHandler } from './ban-handler.js';
import { MessageManager } from './message-manager.js';
import { mumbleproto, MessageType, ClientState } from '@munode/protocol';

/**
 * 事件设置管理器
 * 负责设置所有事件处理器
 */
export class EventSetupManager {
  private handlerFactory: HandlerFactory;
  private hubClient?: EdgeControlClient;
  private voiceManager?: VoiceManager;
  private hubDataManager?: HubDataManager;
  private banHandler?: BanHandler;
  private messageManager?: MessageManager;
  private config: any;

  constructor(
    handlerFactory: HandlerFactory,
    config: any,
    hubClient?: EdgeControlClient,
    voiceManager?: VoiceManager,
    hubDataManager?: HubDataManager,
    banHandler?: BanHandler,
    messageManager?: MessageManager
  ) {
    this.handlerFactory = handlerFactory;
    this.config = config;
    this.hubClient = hubClient;
    this.voiceManager = voiceManager;
    this.hubDataManager = hubDataManager;
    this.banHandler = banHandler;
    this.messageManager = messageManager;
  }

  /**
   * 设置事件处理器
   */
  setupEventHandlers(): void {
    // 消息处理器事件
    this.handlerFactory.messageHandler.on(
      'sendMessage',
      (session_id: number, messageType: number, messageData: Buffer) => {
        this.messageManager!.sendMessageToClient(session_id, messageType, messageData);
      }
    );

    this.handlerFactory.messageHandler.on('version', (session_id: number, data: Buffer) => {
      this.handlerFactory.protocolHandlers.handleVersion(session_id, data);
    });

    this.handlerFactory.messageHandler.on('authenticate', (session_id: number, data: Buffer) => {
      void this.handlerFactory.authHandlers.handleAuthenticate(session_id, data);
    });

    this.handlerFactory.messageHandler.on('ping', (session_id: number, data: Buffer) => {
      this.handlerFactory.protocolHandlers.handlePing(session_id, data);
    });

    this.handlerFactory.messageHandler.on('banListQuery', (session_id: number) => {
      void this.banHandler!.handleBanListQuery(session_id);
    });

    this.handlerFactory.messageHandler.on(
      'banListUpdate',
      (
         session_id: number,
        bans: Array<{
          address?: Buffer;
          mask?: number;
          hash?: string;
          name?: string;
          reason?: string;
          start?: number;
          duration?: number;
        }>
      ) => {
        void this.banHandler!.handleBanListUpdate(session_id, bans);
      }
    );

    // mumbleproto.UserState 事件
    this.handlerFactory.messageHandler.on('userState', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.stateHandlers) {
        this.handlerFactory.stateHandlers.handleUserState(session_id, data);
      }
    });

    // mumbleproto.UserRemove 事件（踢出/封禁）
    this.handlerFactory.messageHandler.on('userRemove', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.stateHandlers) {
        void this.handlerFactory.stateHandlers.handleUserRemove(session_id, data);
      }
    });

    // mumbleproto.ChannelState 事件（频道创建/编辑）
    this.handlerFactory.messageHandler.on('channelState', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.stateHandlers) {
        void this.handlerFactory.stateHandlers.handleChannelState(session_id, data);
      }
    });

    // mumbleproto.ChannelRemove 事件（频道删除）
    this.handlerFactory.messageHandler.on('channelRemove', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.stateHandlers) {
        void this.handlerFactory.stateHandlers.handleChannelRemove(session_id, data);
      }
    });

    // mumbleproto.ACL 事件
    this.handlerFactory.messageHandler.on('acl', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.permissionHandlers) {
        void this.handlerFactory.permissionHandlers.handleACL(session_id, data);
      }
    });

    // TextMessage 事件
    this.handlerFactory.messageHandler.on('textMessage', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.messageHandlers) {
        this.handlerFactory.messageHandlers.handleTextMessage(session_id, data);
      }
    });

    // PluginDataTransmission 事件
    this.handlerFactory.messageHandler.on('pluginDataTransmission', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.messageHandlers) {
        this.handlerFactory.messageHandlers.handlePluginDataTransmission(session_id, data);
      }
    });

    // PermissionQuery 事件
    this.handlerFactory.messageHandler.on('permissionQuery', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.permissionHandlers) {
        this.handlerFactory.permissionHandlers.handlePermissionQuery(session_id, data);
      }
    });

    // CryptSetup 事件
    this.handlerFactory.messageHandler.on('cryptSetup', (session_id: number, data: Buffer) => {
      this.handlerFactory.protocolHandlers.handleCryptSetup(session_id, data);
    });

    // QueryUsers 事件
    this.handlerFactory.messageHandler.on('queryUsers', (session_id: number, data: Buffer) => {
      void this.handlerFactory.protocolHandlers.handleQueryUsers(session_id, data);
    });

    // UserStats 事件
    this.handlerFactory.messageHandler.on('userStats', (session_id: number, data: Buffer) => {
      // 创建一个权限检查函数包装器
      const hasPermission = (client: any, channel: any, perm: number): boolean => {
        if (!this.handlerFactory.permissionHandlers) return false;
        // PermissionHandlers.checkPermission 是异步的，但 handleUserStats 需要同步
        // 这里我们使用同步方式，直接调用 PermissionManager
        const channelTree = this.handlerFactory.channelManager.getChannelTree();
        const aclMap = this.handlerFactory.aclMap;
        return this.handlerFactory.permissionManager.hasPermission(
          channel,
          client,
          perm,
          channelTree,
          aclMap
        );
      };
      this.handlerFactory.protocolHandlers.handleUserStats(session_id, data, hasPermission);
    });

    // userStatsForward 转发事件 - 转发到 Hub 处理
    this.handlerFactory.messageHandler.on('userStatsForward', (params: any) => {
      if (this.hubClient) {
        this.hubClient.notify('hub.handleUserStats', params);
        logger.debug(`Forwarded UserStats request to Hub: actor=${params.actor_session}, target=${params.target_session}`);
      } else {
        logger.error('Cannot forward UserStats: Hub client not available');
      }
    });

    // VoiceTarget 事件
    this.handlerFactory.messageHandler.on('voiceTarget', (session_id: number, data: Buffer) => {
      this.handlerFactory.protocolHandlers.handleVoiceTarget(session_id, data);
    });

    // UDPTunnel 事件 - TCP语音传输
    this.handlerFactory.messageHandler.on('udpTunnel', (session_id: number, data: Buffer) => {
      // 将TCP隧道语音包路由到voiceRouter处理
      this.handlerFactory.voiceRouter.handleVoiceTunnel(session_id, data);
    });

    // RequestBlob 事件
    this.handlerFactory.messageHandler.on('requestBlob', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.adminHandlers) {
        void this.handlerFactory.adminHandlers.handleRequestBlob(session_id, data);
      }
    });

    // UserList 事件
    this.handlerFactory.messageHandler.on('userList', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.adminHandlers) {
        this.handlerFactory.adminHandlers.handleUserList(session_id, data);
      }
    });

    // Context Actions 事件
    this.handlerFactory.messageHandler.on('contextAction', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.adminHandlers) {
        void this.handlerFactory.adminHandlers.handleContextAction(session_id, data);
      }
    });

    this.handlerFactory.messageHandler.on('contextActionModify', (session_id: number, data: Buffer) => {
      if (this.handlerFactory.adminHandlers) {
        this.handlerFactory.adminHandlers.handleContextActionModify(session_id, data);
      }
    });

    // ContextActions 组件事件
    this.handlerFactory.contextActions.on(
      'sendContextActionModify',
      (session_id: number, message: any) => {
        if (this.handlerFactory.adminHandlers) {
          this.handlerFactory.adminHandlers.sendContextActionModify(session_id, message);
        }
      }
    );

    this.handlerFactory.contextActions.on(
      'moveChannelMembers',
      (actorSession: number, fromChannel: number, toChannel: number) => {
        if (this.handlerFactory.adminHandlers) {
          this.handlerFactory.adminHandlers.handleMoveChannelMembers(actorSession, fromChannel, toChannel);
        }
      }
    );

    this.handlerFactory.contextActions.on('setPromiscuousMode', (session_id: number, enabled: boolean) => {
      if (this.handlerFactory.adminHandlers) {
        this.handlerFactory.adminHandlers.handleSetPromiscuousMode(session_id, enabled);
      }
    });

    this.handlerFactory.contextActions.on('clearUserCache', (session_id: number) => {
      if (this.handlerFactory.adminHandlers) {
        this.handlerFactory.adminHandlers.handleClearUserCache(session_id);
      }
    });

    this.handlerFactory.contextActions.on('permissionDenied', (session_id: number, reason: string) => {
      if (this.handlerFactory.adminHandlers) {
        this.handlerFactory.adminHandlers.sendPermissionDenied(session_id, 'contextAction', reason);
      }
    });

    // 客户端事件
    this.handlerFactory.clientManager.on('clientConnected', (client) => {
      // 根据 Mumble 协议，服务器应该在连接后立即发送版本消息
      this.sendServerVersion(client.session);
    });

    this.handlerFactory.clientManager.on('clientData', (session_id: number, data: Buffer) => {
      // 解析 Mumble 协议消息
      this.messageManager!.parseAndHandleMessage(session_id, data);
    });

    this.handlerFactory.clientManager.on('clientDisconnected', (client) => {
      // 清理 PreConnect 状态（如果存在）
      if (this.handlerFactory.stateHandlers) {
        this.handlerFactory.stateHandlers.clearPreConnectUserState(client.session);
      }

      // 清理语音路由器的客户端加密状态
      this.handlerFactory.voiceRouter.removeClientCrypto(client.session);

      // 清理UDP地址映射
      if (this.handlerFactory.connectionHandlers) {
        this.handlerFactory.connectionHandlers.clearUDPMapping(client.session);
      }

      // 清理消息缓冲区
      this.messageManager!.clearClientBuffer(client.session);

      // 在集群模式下，通知Hub用户已离开
      // 通知Hub用户离开（Hub会广播给所有Edge，包括本Edge）
      this.hubClient!.notify('hub.userLeft', {
        session_id: client.session,
        edge_id: this.config.server_id,
        user_id: client.user_id,
        username: client.username,
      });

      logger.info(`User ${client.username} (session ${client.session}) left, notified Hub for broadcast`);
    });

    this.handlerFactory.clientManager.on(
      'clientMoved',
      (client, oldchannel_id: number, newchannel_id: number) => {
        // 频道移动的广播由 handleUserState 统一处理
        // 这里只记录日志
        if (client.user_id > 0) {
          logger.debug(
            `Client ${client.username} moved from channel ${oldchannel_id} to ${newchannel_id}`
          );
        }
        
        // 性能优化：用户移动频道不影响路由缓存，因为索引会自动更新
        // 无需重建缓存
      }
    );
    
    // 频道管理器事件 - 主动重建缓存
    this.handlerFactory.channelManager.on('channelsLinked', (channel_id1: number, channel_id2: number) => {
      // 频道链接变化，重建相关的PTT缓存
      logger.debug(`Channels linked: ${channel_id1} <-> ${channel_id2}, rebuilding cache`);
      this.handlerFactory.voiceRouter.rebuildChannelCache(channel_id1);
      this.handlerFactory.voiceRouter.rebuildChannelCache(channel_id2);
      // 由于链接是传递的，需要重建所有相关频道的缓存
      // 为简化起见，可以考虑重建所有PTT缓存
      // this.handlerFactory.voiceRouter.rebuildAllPTTCache();
    });
    
    this.handlerFactory.channelManager.on('channelsUnlinked', (channel_id1: number, channel_id2: number) => {
      // 频道链接取消，重建相关的PTT缓存
      logger.debug(`Channels unlinked: ${channel_id1} <-> ${channel_id2}, rebuilding cache`);
      this.handlerFactory.voiceRouter.rebuildChannelCache(channel_id1);
      this.handlerFactory.voiceRouter.rebuildChannelCache(channel_id2);
    });
    
    this.handlerFactory.channelManager.on('channelUpdated', (channel: any) => {
      // 频道更新可能包括链接变化，重建该频道的PTT缓存
      if (channel && channel.id !== undefined) {
        logger.debug(`Channel ${channel.id} updated, rebuilding cache`);
        this.handlerFactory.voiceRouter.rebuildChannelCache(channel.id);
      }
    });
    
    this.handlerFactory.clientManager.on('clientDisconnected', (client) => {
      // 客户端断开连接，清理其相关的缓存
      if (client && client.session) {
        this.handlerFactory.voiceRouter.clearClientCache(client.session);
      }
    });

    // 语音事件
    this.handlerFactory.voiceRouter.on('voicePacket', (_packet) => {
      // 这里可以处理语音包事件，如果需要
    });

    // TCP语音包发送事件
    this.handlerFactory.voiceRouter.on('sendTCPVoicePacket', (session_id: number, voiceData: Buffer) => {
      try {
        // 通过TCP隧道（UDPTunnel消息）发送语音包
        // 注意：根据 Mumble 协议，UDPTunnel 消息的 payload 直接就是语音包数据
        // 不需要 protobuf 包装，这是一个性能优化
        logger.info(`[TCP-VOICE] Sending voice data (${voiceData.length} bytes) as UDPTunnel to session ${session_id}`);
        this.messageManager!.sendMessageToClient(session_id, MessageType.UDPTunnel, voiceData);
        logger.info(`[TCP-VOICE] UDPTunnel message sent successfully to session ${session_id}`);
      } catch (error) {
        logger.error(`Failed to send UDPTunnel message for session ${session_id}:`, error);
      }
    });

    // Hub 事件
    if (this.hubClient) {
      this.hubClient.on('connected', () => {
        void (async () => {
          logger.info('Connected to Hub Server');

          // 加载频道和ACL数据
          await this.hubDataManager!.loadDataFromHub();

          // 连接成功后立即请求完整同步
          try {
            logger.info('Requesting full sync from Hub...');
            const syncData = await this.hubClient.requestFullSync();
            // Process sync data
            this.handlerFactory.stateManager.loadSnapshot(syncData);
            logger.info('Full sync completed successfully');
          } catch (error) {
            logger.error('Failed to sync with Hub:', error);
          }

          // Important: Re-report all authenticated local sessions to Hub
          // This ensures that after Hub restarts, existing users on Edge are properly tracked by Hub
          // Problem scenario: After Hub restart, only reconnecting clients get reported,
          // while clients that stayed connected won't be known to Hub, causing incomplete user lists
          await this.reReportLocalSessionsToHub();

          // Edge voice port registration is handled via Hub notification (edgeJoined event)
          // No need to manually register here
        })();
      });

      this.hubClient.on('disconnected', () => {
        logger.warn('Disconnected from Hub Server');
      });

      this.hubClient.on('error', (error) => {
        logger.error('Hub client error:', error);
      });

      this.hubClient.on('registered', (response) => {
        logger.info('Successfully registered with Hub:', response);
        
        // 重连后重新报告所有本地已认证用户到Hub
        // 这解决了Edge断线重连后，Hub丢失用户会话信息的问题
        this.reReportLocalSessionsToHub();
      });

      this.hubClient.on('heartbeat', (response) => {
        logger.debug('Hub heartbeat response:', response);
      });

      this.hubClient.on('heartbeatFailed', (error) => {
        logger.warn('Hub heartbeat failed:', error);
      });

      this.hubClient.on('sessionUpdate', (data) => {
        logger.debug('Session update:', data);
      });

      this.hubClient.on('voiceTargetUpdate', (data) => {
        logger.debug('Voice target update:', data);
      });

      // 监听来自 Hub 的 VoiceTarget 同步
      this.hubClient.on('syncVoiceTarget', (params: any) => {
        logger.info(
          `Received VoiceTarget sync from Hub: Edge ${params.edge_id}, Session ${params.client_session}, Target ${params.target_id}`
        );
        
        // 更新本地 VoiceRouter 的配置
        if (params.config === null) {
          // 删除 VoiceTarget
          logger.info(`Removing VoiceTarget: session=${params.client_session}, target=${params.target_id}`);
          this.handlerFactory.voiceRouter.removeVoiceTarget(params.client_session, params.target_id);
        } else if (params.config) {
          // 将Hub-Edge格式转换回Mumble protocol格式
          // Hub-Edge格式: { sessions: VoiceTargetSession[], channels: ChannelTarget[] }
          // Mumble格式: targets数组，每个target有session/channel_id/links/children/group
          const targets: any[] = [];
          
          // 转换sessions - 从VoiceTargetSession对象数组提取session ID
          if (params.config.sessions && params.config.sessions.length > 0) {
            const sessionIds = params.config.sessions.map((s: any) => s.session);
            targets.push({
              session: sessionIds,
              has_channel_id: false,
            });
          }
          
          // 转换channels
          if (params.config.channels && params.config.channels.length > 0) {
            for (const channel of params.config.channels) {
              targets.push({
                session: [],
                has_channel_id: true,
                channel_id: channel.channel_id,
                children: channel.include_subchannels || false,
                links: channel.include_links || false,
                group: channel.group,
              });
            }
          }
          
          if (targets.length > 0) {
            logger.info(`Setting VoiceTarget: session=${params.client_session}, target=${params.target_id}, targets count=${targets.length}`);
            this.handlerFactory.voiceRouter.setVoiceTarget(
              params.client_session,
              params.target_id,
              targets
            );
          } else {
            logger.warn(`VoiceTarget has no targets: ${JSON.stringify(params)}`);
          }
        } else {
          logger.warn(`Invalid VoiceTarget config: ${JSON.stringify(params)}`);
        }
      });

      this.hubClient.on('voiceData', (data, respond) => {
        // 处理来自Hub的语音数据路由
        this.voiceManager!.handleVoiceDataFromHub(data, respond);
      });

      // 监听来自Hub的所有通知消息（合并多个监听器）
      this.hubClient.on('notification', (message) => {
        // 处理集群事件
        if (message.method === 'edge.peerJoined') {
          const data = message.params;
          logger.info('Edge joined cluster:', data);

          // 尝试注册新Edge的语音端口（非强制，允许失败）
          if (this.voiceManager && this.voiceManager.getVoiceTransport() && data.voicePort && data.id !== this.config.server_id) {
            try {
              this.voiceManager.getVoiceTransport()!.registerEndpoint(data.id, data.host, data.voicePort);
              logger.info(`Registered voice endpoint for new Edge ${data.id}: ${data.host}:${data.voicePort}`);
            } catch (error) {
              // 端点注册失败不影响其他功能
              logger.warn(`Failed to register voice endpoint for Edge ${data.id}:`, error);
            }
          }
        } else if (message.method === 'edge.peerLeft') {
          const data = message.params;
          logger.info('Edge left cluster:', data);

          // 移除该Edge的语音端口注册
          if (this.voiceManager && this.voiceManager.getVoiceTransport() && data.id) {
            this.voiceManager.getVoiceTransport()!.unregisterEndpoint(data.id);
            logger.info(`Unregistered voice endpoint for Edge ${data.id}`);
          }
        }
        // 处理用户事件
        else if (message.method === 'hub.userJoined') {
          console.error(`[EDGE-DEBUG] Received hub.userJoined notification: ${JSON.stringify(message.params)}`);
          this.hubDataManager!.handleRemoteUserJoined(message.params);
        } else if (message.method === 'hub.userLeft') {
          this.hubDataManager!.handleRemoteUserLeft(message.params);
        } else if (message.method === 'hub.userStateChanged') {
          this.hubDataManager!.handleRemoteUserStateChanged(message.params);
        } else if (message.method === 'hub.userStateBroadcast') {
          // 新的UserState广播处理
          this.handlerFactory.hubMessageHandlers.handleUserStateBroadcastFromHub(message.params);
        } else if (message.method === 'hub.userStateResponse') {
          // Hub对UserState请求的响应
          this.handlerFactory.hubMessageHandlers.handleUserStateResponseFromHub(message.params);
        } else if (message.method === 'hub.channelStateBroadcast') {
          // ChannelState广播处理
          this.handlerFactory.hubMessageHandlers.handleChannelStateBroadcastFromHub(message.params);
        } else if (message.method === 'hub.channelStateResponse') {
          // Hub对ChannelState请求的响应
          this.handlerFactory.hubMessageHandlers.handleChannelStateResponseFromHub(message.params);
        } else if (message.method === 'hub.userRemoveBroadcast') {
          // UserRemove广播处理
          this.handlerFactory.hubMessageHandlers.handleUserRemoveBroadcastFromHub(message.params);
        } else if (message.method === 'hub.userRemoveResponse') {
          // Hub对UserRemove请求的响应
          this.handlerFactory.hubMessageHandlers.handleUserRemoveResponseFromHub(message.params);
        } else if (message.method === 'hub.textMessageBroadcast') {
          // TextMessage广播处理
          this.handlerFactory.hubMessageHandlers.handleTextMessageBroadcastFromHub(message.params);
        } else if (message.method === 'hub.pluginDataBroadcast') {
          // PluginData广播处理
          this.handlerFactory.hubMessageHandlers.handlePluginDataBroadcastFromHub(message.params);
        } else if (message.method === 'edge.aclUpdated') {
          // ACL更新通知 - 触发权限刷新
          this.handlerFactory.hubMessageHandlers.handleACLUpdatedNotification(message.params);
        } else if (message.method === 'hub.userStatsResponse') {
          // UserStats 响应
          this.handlerFactory.hubMessageHandlers.handleUserStatsResponseFromHub(message.params);
        } else if (message.method === 'hub.channelRemoveBroadcast') {
          // ChannelRemove广播处理
          this.handlerFactory.hubMessageHandlers.handleChannelRemoveBroadcastFromHub(message.params);
        }
      });
    }
  }

  /**
   * 发送服务器版本信息给客户端
   */
  private sendServerVersion(session_id: number): void {
    try {
      const version = new mumbleproto.Version({
        version: 0x010400, // 1.4.0
        release: 'MuNode Edge Server',
        os: 'Linux',
        os_version: process.version,
      });

      this.messageManager?.sendMessageToClient(
        session_id,
        MessageType.Version,
        Buffer.from(version.serializeBinary())
      );

      // 发送 Version 后，更新客户端状态为 ServerSentVersion
      this.handlerFactory.clientManager.updateClient(session_id, {
        state: ClientState.ServerSentVersion,
      });

      logger.debug(`Sent server version to session ${session_id}, state updated to ServerSentVersion`);
    } catch (error) {
      logger.error(`Failed to send server version to session ${session_id}:`, error);
    }
  }

  /**
   * Re-report all authenticated local sessions to Hub
   * 
   * This method is called after Edge reconnects to Hub, ensuring Hub knows about all existing users on Edge.
   * Scenario: After Hub restarts, there may be clients on Edge that haven't disconnected. These clients
   * won't re-authenticate automatically, so Edge needs to proactively inform Hub about their existence.
   * 
   * 重新报告所有本地已认证用户到Hub
   * 当Edge重连到Hub后调用，确保Hub有完整的用户会话信息
   * 这解决了：用户A登录很久后，用户B登录看不到用户A的问题
   */
  private async reReportLocalSessionsToHub(): Promise<void> {
    if (!this.hubClient || !this.hubClient.isConnected()) {
      logger.warn('Cannot re-report sessions: Hub client not connected');
      return;
    }

    const allClients = this.handlerFactory.clientManager.getAllClients();
    const authenticatedClients = allClients.filter(client => client.user_id > 0);

    if (authenticatedClients.length === 0) {
      logger.debug('No authenticated users to re-report to Hub');
      return;
    }

    logger.info(`Re-reporting ${authenticatedClients.length} local users to Hub after reconnection`);

    for (const client of authenticatedClients) {
      try {
        await this.hubClient.reportSession({
          session_id: client.session,
          user_id: client.user_id,
          username: client.username,
          channel_id: client.channel_id,
          startTime: client.connected_at || new Date(),
          ip_address: client.ip_address,
          groups: client.groups,
          cert_hash: client.cert_hash,
          version: client.version,
          release: client.client_name,
          os: client.os_name,
          os_version: client.os_version,
        });
        logger.debug(`Re-reported session ${client.session} (${client.username}) to Hub`);
      } catch (error) {
        logger.error(`Failed to re-report session ${client.session} to Hub:`, error);
      }
    }

    logger.info(`Completed re-reporting ${authenticatedClients.length} users to Hub`);
  }
}