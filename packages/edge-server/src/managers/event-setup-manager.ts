import type { Logger } from 'winston';
import { HandlerFactory } from '../core/handler-factory.js';
import { EdgeControlClient, type ExtendedRegisterResponse } from '../cluster/hub-client.js';
import { VoiceManager } from './voice-manager.js';
import { HubDataManager } from '../cluster/hub-data-sync.js';
import { BanHandler } from './ban-handler.js';
import { MessageManager } from './message-manager.js';
import { mumbleproto, MessageType, ClientState } from '@munode/protocol';
import type { EdgeConfig, ClientInfo, ChannelInfo } from '../types.js';
import type { FullSnapshot } from '../state/state-manager.js';

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
  private config: EdgeConfig;
  private logger: Logger;
  private suppressClientDisconnectNotifications = false; // 用于批量清理时抑制通知

  constructor(
    handlerFactory: HandlerFactory,
    config: EdgeConfig,
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
    this.logger = handlerFactory.logger;
  }

  /**
   * 设置事件处理器
   */
  setupEventHandlers(): void {
    // 消息处理器事件
    this.handlerFactory.messageHandler.on(
      'sendMessage',
      (session_id: number, messageType: number, messageData: Buffer) => {
        this.messageManager.sendMessageToClient(session_id, messageType, messageData);
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
      void this.banHandler.handleBanListQuery(session_id);
    });

    this.handlerFactory.messageHandler.on(
      'banListUpdate',
      (session_id: number, bans: mumbleproto.BanList.BanEntry[]) => {
        void this.banHandler.handleBanListUpdate(session_id, bans);
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
        void this.handlerFactory.permissionHandlers.handlePermissionQuery(session_id, data);
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
      const hasPermission = (client: ClientInfo, channel: ChannelInfo, perm: number): boolean => {
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
    this.handlerFactory.messageHandler.on('userStatsForward', (params: {
      session_id: number;
      stats_data: Buffer;
    }) => {
      if (this.hubClient) {
        this.hubClient.notify('hub.handleUserStats', params);
        this.logger.debug(`Forwarded UserStats request to Hub: session=${params.session_id}`);
      } else {
        this.logger.error('Cannot forward UserStats: Hub client not available');
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
      (session_id: number, message: mumbleproto.ContextActionModify) => {
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
      // 解析 Mumble 协议消息（异步处理）
      void this.messageManager.parseAndHandleMessage(session_id, data);
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
      this.messageManager.clearClientBuffer(client.session);

      // 在集群模式下，通知Hub用户已离开
      // 但如果正在批量清理（如Edge重连时），则不发送通知（Hub已经清理了会话）
      if (!this.suppressClientDisconnectNotifications) {
        // 通知Hub用户离开（Hub会广播给所有Edge，包括本Edge）
        this.hubClient.notify('hub.handleUserLeft', {
          session_id: client.session,
          edge_id: this.config.server_id,
          reason: undefined,
        });

        this.logger.info(`User ${client.username} (session ${client.session}) left, notified Hub for broadcast`);
      } else {
        this.logger.debug(`User ${client.username} (session ${client.session}) left during batch cleanup, notification suppressed`);
      }
    });

    this.handlerFactory.clientManager.on(
      'clientMoved',
      (client, oldchannel_id: number, newchannel_id: number) => {
        // 频道移动的广播由 handleUserState 统一处理
        // 这里只记录日志
        if (client.user_id > 0) {
        this.logger.debug(
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
        this.logger.debug(`Channels linked: ${channel_id1} <-> ${channel_id2}, rebuilding cache`);
      this.handlerFactory.voiceRouter.rebuildChannelCache(channel_id1);
      this.handlerFactory.voiceRouter.rebuildChannelCache(channel_id2);
      // 由于链接是传递的，需要重建所有相关频道的缓存
      // 为简化起见，可以考虑重建所有PTT缓存
      // this.handlerFactory.voiceRouter.rebuildAllPTTCache();
    });
    
    this.handlerFactory.channelManager.on('channelsUnlinked', (channel_id1: number, channel_id2: number) => {
      // 频道链接取消，重建相关的PTT缓存
        this.logger.debug(`Channels unlinked: ${channel_id1} <-> ${channel_id2}, rebuilding cache`);
      this.handlerFactory.voiceRouter.rebuildChannelCache(channel_id1);
      this.handlerFactory.voiceRouter.rebuildChannelCache(channel_id2);
    });
    
    this.handlerFactory.channelManager.on('channelUpdated', (channel: ChannelInfo) => {
      // 频道更新可能包括链接变化，重建该频道的PTT缓存
      if (channel && channel.id !== undefined) {
        this.logger.debug(`Channel ${channel.id} updated, rebuilding cache`);
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
        this.logger.info(`[TCP-VOICE] Sending voice data (${voiceData.length} bytes) as UDPTunnel to session ${session_id}`);
        this.messageManager.sendMessageToClient(session_id, MessageType.UDPTunnel, voiceData);
        this.logger.info(`[TCP-VOICE] UDPTunnel message sent successfully to session ${session_id}`);
      } catch (error) {
        this.logger.error(`Failed to send UDPTunnel message for session ${session_id}:`, error);
      }
    });

    // Hub 事件
    if (this.hubClient) {
      // 提取 fullSync 逻辑为共享函数
      const performFullSync = async (): Promise<void> => {
        this.logger.info('Performing full sync with Hub...');

        // 加载频道和ACL数据
        await this.hubDataManager.loadDataFromHub();

        // 连接成功后立即请求完整同步
        try {
          this.logger.info('Requesting full sync from Hub...');
          const syncData = await this.hubClient.requestFullSync();
          // Process sync data
          // Note: Protobuf toObject() types mark all fields as optional, but the server guarantees
          // required fields are present. Cast to FullSnapshot which has stricter type requirements.
          this.handlerFactory.stateManager.loadSnapshot(syncData as FullSnapshot);
          this.logger.info('Full sync completed successfully');
          
          // Process sessions from fullSync - broadcast remote users to local clients
          // This is critical after edge reconnection to ensure all clients see users on other edges
          if (syncData.sessions && Array.isArray(syncData.sessions)) {
            const localEdgeId = this.handlerFactory.config.server_id;
            const remoteSessionCount = syncData.sessions.filter(s => s.edge_id !== localEdgeId).length;
            this.logger.info(`Processing ${remoteSessionCount} remote user sessions from fullSync`);
            
            // Import protocol dependencies once before the loop
            const mumbleproto = await import('@munode/protocol').then(m => m.mumbleproto);
            const MessageType = await import('@munode/protocol').then(m => m.MessageType);
            
            // Get local clients once before the loop
            const allClients = this.handlerFactory.clientManager.getAllClients();
            const authenticatedClients = allClients.filter(c => c.user_id > 0 && c.has_full_user_list);
            
            for (const session of syncData.sessions) {
              // Only process sessions from other edges
              if (session.edge_id !== localEdgeId) {
                // Add to remote users map
                this.handlerFactory.stateManager.addRemoteUser(
                  session.session_id,
                  session.edge_id,
                  session.channel_id ?? 0
                );
                
                // Build UserState message for this remote user (once per session)
                const userStateData: {
                  session: number;
                  user_id: number;
                  name: string;
                  channel_id: number;
                  temporary_access_tokens: string[];
                  listening_channel_add: number[];
                  listening_channel_remove: number[];
                  hash?: string;
                } = {
                  session: session.session_id,
                  user_id: session.user_id,
                  name: session.username,
                  channel_id: session.channel_id ?? 0,
                  temporary_access_tokens: [],
                  listening_channel_add: [],
                  listening_channel_remove: [],
                };
                
                // Only registered users can see cert hash
                const includeHash = session.cert_hash !== undefined;
                if (includeHash) {
                  userStateData.hash = session.cert_hash;
                }
                
                const userState = new mumbleproto.UserState(userStateData);
                const userStateMessage = userState.serialize();
                const userStateBuffer = Buffer.from(userStateMessage);
                
                // Broadcast to all local authenticated clients
                for (const client of authenticatedClients) {
                  this.handlerFactory.messageHandler.sendMessage(
                    client.session,
                    MessageType.UserState,
                    userStateBuffer
                  );
                }
              }
            }
            
            if (remoteSessionCount > 0) {
              this.logger.info(`Broadcasted ${remoteSessionCount} remote users to ${authenticatedClients.length} local clients after reconnect`);
            }
          }
        } catch (error) {
          this.logger.error('Failed to sync with Hub:', error);
        }

        // 注意：不要在这里重新报告用户
        // Hub 在宽限期内保留了会话信息，Edge 通过 fullSync 获取
        // 如果 Hub 完全重启（冷启动），会话会丢失，用户需要重新认证
        // 这是正确的行为：会话是临时的，不应该在 Hub 重启后自动恢复
        
        // 如果需要支持 Hub 热重启保留会话，应该由 Hub 持久化会话信息
        // 而不是让 Edge 重新报告，那样会导致 session_id 混乱

        // Edge voice port registration is handled via Hub notification (edgeJoined event)
        // No need to manually register here
      };

      // 注意：register() 方法会根据情况发出 'registered' 或 'reconnected' 事件，
      // 然后 connect() 方法会发出 'connected' 事件。
      // 为了避免重复调用 fullSync，我们只在 'registered' 和 'reconnected' 事件中处理，
      // 不在 'connected' 事件中处理（因为 connected 总是在 registered/reconnected 之后触发）

      this.hubClient.on('registered', () => {
        void (async () => {
          this.logger.info('Successfully registered with Hub (first time or after cold restart)');
          await performFullSync();
        })();
      });

      this.hubClient.on('reconnected', (response: ExtendedRegisterResponse) => {
        void (async () => {
          this.logger.info('Successfully reconnected to Hub (session restored)');
          
          // 如果 Hub 要求清理会话，断开所有本地客户端
          if (response.need_cleanup) {
            this.logger.warn('Hub requested session cleanup - disconnecting all local clients');
            const allClients = this.handlerFactory.clientManager.getAllClients();
            this.logger.info(`Disconnecting ${allClients.length} local clients due to session cleanup`);
            
            // 设置标志以抑制客户端断开通知（Hub已经清理了这些会话）
            this.suppressClientDisconnectNotifications = true;
            
            try {
              for (const client of allClients) {
                try {
                  await this.handlerFactory.clientManager.forceDisconnect(
                    client.session,
                    'Hub requested session cleanup - please reconnect'
                  );
                } catch (error) {
                  this.logger.error(`Failed to disconnect client ${client.session}:`, error);
                }
              }
            } finally {
              // 恢复通知
              this.suppressClientDisconnectNotifications = false;
            }
            
            this.logger.info('All local clients disconnected, performing full sync...');
          }
          
          await performFullSync();
        })();
      });

      this.hubClient.on('connected', () => {
        // connected 事件总是在 registered/reconnected 之后触发
        // fullSync 已经在那些事件中处理，这里只记录日志
        this.logger.info('Connected to Hub Server (connection established)');
      });

      this.hubClient.on('disconnected', () => {
        this.logger.warn('Disconnected from Hub Server');
      });

      this.hubClient.on('error', (error) => {
        this.logger.error('Hub client error:', error);
      });

      this.hubClient.on('heartbeat', (response) => {
        this.logger.debug('Hub heartbeat response:', response);
      });

      this.hubClient.on('heartbeatFailed', (error) => {
        this.logger.warn('Hub heartbeat failed:', error);
      });

      this.hubClient.on('sessionUpdate', (data) => {
        this.logger.debug('Session update:', data);
      });

      this.hubClient.on('voiceTargetUpdate', (data) => {
        this.logger.debug('Voice target update:', data);
      });

      // 监听来自 Hub 的 VoiceTarget 同步
      this.hubClient.on('syncVoiceTarget', (params: {
        edge_id: number;
        client_session: number;
        target_id: number;
        config: {
          sessions?: Array<{ session: number }>;
          channels?: Array<{
            channel_id: number;
            include_subchannels?: boolean;
            include_links?: boolean;
            group?: string;
          }>;
        } | null;
      }) => {
        this.logger.info(
          `Received VoiceTarget sync from Hub: Edge ${params.edge_id}, Session ${params.client_session}, Target ${params.target_id}`
        );
        
        // 更新本地 VoiceRouter 的配置
        if (params.config === null) {
          // 删除 VoiceTarget
        this.logger.info(`Removing VoiceTarget: session=${params.client_session}, target=${params.target_id}`);
          this.handlerFactory.voiceRouter.removeVoiceTarget(params.client_session, params.target_id);
        } else if (params.config) {
          // 将Hub-Edge格式转换回 Mumble protocol格式
          // Hub-Edge格式: { sessions: VoiceTargetSession[], channels: ChannelTarget[] }
          // Mumble格式: targets数组，每个target有session/channel_id/links/children/group
          interface VoiceTargetItem {
            session?: number[];
            channel_id?: number;
            links?: boolean;
            children?: boolean;
            group?: string;
          }
          const targets: VoiceTargetItem[] = [];
          
          // 转换sessions - 从 VoiceTargetSession对象数组提取session ID
          if (params.config.sessions && params.config.sessions.length > 0) {
            const sessionIds = params.config.sessions.map((s: { session: number }) => s.session);
            targets.push({
              session: sessionIds,
            });
          }
          
          // 转换channels
          if (params.config.channels && params.config.channels.length > 0) {
            for (const channel of params.config.channels) {
              targets.push({
                channel_id: channel.channel_id,
                children: channel.include_subchannels || false,
                links: channel.include_links || false,
                group: channel.group,
              });
            }
          }
          
          if (targets.length > 0) {
        this.logger.info(`Setting VoiceTarget: session=${params.client_session}, target=${params.target_id}, targets count=${targets.length}`);
            this.handlerFactory.voiceRouter.setVoiceTarget(
              params.client_session,
              params.target_id,
              targets
            );
          } else {
        this.logger.warn(`VoiceTarget has no targets: ${JSON.stringify(params)}`);
          }
        } else {
        this.logger.warn(`Invalid VoiceTarget config: ${JSON.stringify(params)}`);
        }
      });

      this.hubClient.on('voiceData', (data, respond) => {
        // 处理来自Hub的语音数据路由
        this.voiceManager.handleVoiceDataFromHub(data, respond);
      });
      
      // 监听语音路由配置推送（包含加密密钥）
      this.hubClient.on('voiceRoutingConfig', (config: {
        enabled: boolean;
        encryption?: {
          algorithm: string;
          key: string;
          version: number;
        };
      }) => {
        this.logger.info('Received voice routing config from Hub:', {
          enabled: config.enabled,
          hasEncryption: !!config.encryption,
          encryptionVersion: config.encryption?.version,
        });
        
        // 更新加密密钥
        if (config.encryption && this.voiceManager) {
          this.voiceManager.updateEncryptionKey(
            config.encryption.algorithm,
            config.encryption.key,
            config.encryption.version
          );
        }
      });

      // 监听来自Hub的所有通知消息（合并多个监听器）
      this.hubClient.on('notification', (message) => {
        // 使用 discriminated union 的类型守卫来处理不同消息类型
        switch (message.method) {
          case 'edge.peerJoined': {
            const data = message.params;
            this.logger.info('Edge joined cluster:', data);

            // 尝试注册新Edge的语音端口（非强制，允许失败）
            if (this.voiceManager && this.voiceManager.getVoiceTransport() && data.voicePort && data.id !== this.config.server_id) {
              try {
                this.voiceManager.getVoiceTransport().registerEndpoint(data.id, data.host, data.voicePort);
                this.logger.info(`Registered voice endpoint for new Edge ${data.id}: ${data.host}:${data.voicePort}`);
              } catch (error) {
                // 端点注册失败不影响其他功能
                this.logger.warn(`Failed to register voice endpoint for Edge ${data.id}:`, error);
              }
            }
            break;
          }

          case 'edge.peerLeft': {
            const data = message.params;
            this.logger.info('Edge left cluster:', data);

            // 移除该Edge的语音端点注册
            if (this.voiceManager && this.voiceManager.getVoiceTransport() && data.id) {
              this.voiceManager.getVoiceTransport().unregisterEndpoint(data.id);
              this.logger.info(`Unregistered voice endpoint for Edge ${data.id}`);
            }
            break;
          }

          case 'hub.userJoined':
            this.logger.debug(`[EDGE-DEBUG] Received hub.userJoined notification: ${JSON.stringify(message.params)}`);
            this.hubDataManager.handleRemoteUserJoined(message.params);
            break;

          case 'hub.userStateChanged':
            this.hubDataManager.handleRemoteUserStateChanged(message.params);
            break;

          case 'hub.userStateBroadcast':
            this.handlerFactory.hubMessageHandlers.handleUserStateBroadcastFromHub(message.params);
            break;

          case 'hub.userStateResponse':
            this.handlerFactory.hubMessageHandlers.handleUserStateResponseFromHub(message.params);
            break;

          case 'hub.channelStateBroadcast':
            this.handlerFactory.hubMessageHandlers.handleChannelStateBroadcastFromHub(message.params);
            break;

          case 'hub.channelStateResponse':
            this.handlerFactory.hubMessageHandlers.handleChannelStateResponseFromHub(message.params);
            break;

          case 'hub.userRemoveBroadcast':
            this.handlerFactory.hubMessageHandlers.handleUserRemoveBroadcastFromHub(message.params);
            break;

          case 'hub.userRemoveResponse':
            this.handlerFactory.hubMessageHandlers.handleUserRemoveResponseFromHub(message.params);
            break;

          case 'hub.textMessageBroadcast':
            this.handlerFactory.hubMessageHandlers.handleTextMessageBroadcastFromHub(message.params);
            break;

          case 'hub.pluginDataBroadcast':
            this.handlerFactory.hubMessageHandlers.handlePluginDataBroadcastFromHub(message.params);
            break;

          case 'edge.aclUpdated':
            this.handlerFactory.hubMessageHandlers.handleACLUpdatedNotification(message.params);
            break;

          case 'hub.userStatsResponse':
            this.handlerFactory.hubMessageHandlers.handleUserStatsResponseFromHub(message.params);
            break;

          case 'hub.channelRemoveBroadcast':
            this.handlerFactory.hubMessageHandlers.handleChannelRemoveBroadcastFromHub(message.params);
            break;

          case 'hub.shutdownRequest':
            void this.handlerFactory.hubMessageHandlers.handleShutdownRequestFromHub(message.params);
            break;

          case 'hub.syncVoiceTarget':
            // 转发到已有的事件处理器
            this.hubClient.emit('syncVoiceTarget', message.params);
            break;

          case 'edge.forceDisconnect':
            // ClusterManager 会处理此消息
            this.logger.debug('Received edge.forceDisconnect notification (handled by ClusterManager)');
            break;

          default:
            this.logger.warn(`Unhandled notification method: ${message.method}`);
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

        this.logger.debug(`Sent server version to session ${session_id}, state updated to ServerSentVersion`);
    } catch (error) {
        this.logger.error(`Failed to send server version to session ${session_id}:`, error);
    }
  }

  // 注意：reReportLocalSessionsToHub 方法已移除
  // 原因：
  // 1. Hub 在 Edge 断开时会保留会话信息（30秒宽限期）
  // 2. Edge 重连后通过 fullSync 获取会话列表，无需重新报告
  // 3. 如果 Hub 完全重启（冷启动），会话会丢失，用户需要重新认证
  //    这是正确的行为：会话是临时的，不应该在 Hub 重启后自动恢复
  // 4. 如果需要支持 Hub 热重启保留会话，应该由 Hub 持久化会话信息
}