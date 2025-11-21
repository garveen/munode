import { logger } from '@munode/common';
import { HandlerFactory } from '../core/handler-factory.js';
import { EdgeControlClient } from '../cluster/hub-client.js';
import { VoiceManager } from './voice-manager.js';
import { HubDataManager } from '../cluster/hub-data-sync.js';
import { BanHandler } from './ban-handler.js';
import { MessageManager } from './message-manager.js';
import { mumbleproto, MessageType } from '@munode/protocol';

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

    // VoiceTarget 事件
    this.handlerFactory.messageHandler.on('voiceTarget', (session_id: number, data: Buffer) => {
      this.handlerFactory.protocolHandlers.handleVoiceTarget(session_id, data);
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
      }
    );

    // 语音事件
    this.handlerFactory.voiceRouter.on('voicePacket', (_packet) => {
      // 这里可以处理语音包事件，如果需要
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
            // 处理同步数据
            this.handlerFactory.stateManager.loadSnapshot(syncData);
            logger.info('Full sync completed successfully');
          } catch (error) {
            logger.error('Failed to sync with Hub:', error);
          }

          // Edge的语音端口注册会在Hub通知时处理（edgeJoined事件）
          // 无需在这里手动注册
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

          // 注册新Edge的语音端口
          if (this.voiceManager && this.voiceManager.getVoiceTransport() && data.voicePort && data.id !== this.config.server_id) {
            this.voiceManager.getVoiceTransport()!.registerEndpoint(data.id, data.host, data.voicePort);
            logger.info(`Registered voice endpoint for new Edge ${data.id}: ${data.host}:${data.voicePort}`);
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
        } else if (message.method === 'edge.aclUpdated') {
          // ACL更新通知 - 触发权限刷新
          this.handlerFactory.hubMessageHandlers.handleACLUpdatedNotification(message.params);
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

      logger.debug(`Sent server version to session ${session_id}`);
    } catch (error) {
      logger.error(`Failed to send server version to session ${session_id}:`, error);
    }
  }
}