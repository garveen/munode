import type { Logger } from 'winston';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import {
  hubedge,
  mumbleproto,
  MessageType,
} from '@munode/protocol';
import type { EdgeControlClient } from '../cluster/hub-client.js';
import type { ClientManager } from '../client/client-manager.js';
import type { MessageHandler } from '../message-handler.js';

/**
 * ClientMessageRelayHandler 事件类型定义
 */
export interface ClientMessageRelayHandlerEvents extends EventMap {
  // ClientMessageRelayHandler 当前没有发出事件，保留用于未来扩展
}

/**
 * 客户端消息中转处理器 (Edge 端)
 * 
 * 功能：
 * 1. 将客户端的 Mumble 消息转发到 Hub
 * 2. 将 Hub 的消息转发到客户端
 * 3. 直接引用 Mumble.proto 消息，避免二次序列化
 */
export class ClientMessageRelayHandler extends TypedEventEmitter<ClientMessageRelayHandlerEvents> {
  private hubClient: EdgeControlClient;
  private clientManager: ClientManager;
  private messageHandler: MessageHandler;
  private edgeId: number;
  private logger: Logger;

  constructor(
    hubClient: EdgeControlClient,
    clientManager: ClientManager,
    messageHandler: MessageHandler,
    edgeId: number,
    logger: Logger
  ) {
    super();
    this.hubClient = hubClient;
    this.clientManager = clientManager;
    this.messageHandler = messageHandler;
    this.edgeId = edgeId;
    this.logger = logger;
    
    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // 监听来自 Hub 的中转消息
    this.hubClient.on('relay', (relay: hubedge.ClientMessageRelay) => {
      this.handleRelayFromHub(relay).catch((error) => {
        this.logger.error('Error handling relay from Hub:', error);
      });
    });
  }

  /**
   * 将客户端消息中转到 Hub
   * 
   * @param sessionId 客户端会话 ID
   * @param messageType Mumble 消息类型
   * @param messageData 消息数据（Buffer）
   */
  async relayToHub(
    sessionId: number,
    messageType: MessageType,
    messageData: Buffer
  ): Promise<void> {
    try {
      // 解析 Mumble 消息
      const mumbleMessage = this.parseMumbleMessage(messageType, messageData);
      if (!mumbleMessage) {
        this.logger.warn(`Failed to parse Mumble message type ${messageType}`);
        return;
      }

      // 创建 ClientMessageRelay
      const relay = this.createRelayMessage(
        sessionId,
        messageType,
        mumbleMessage,
        hubedge.RelayDirection.RELAY_DIRECTION_CLIENT_TO_HUB
      );

      // 发送到 Hub
      await this.hubClient.sendRelay(relay);

      this.logger.debug(
        `Relayed message from client to Hub: session=${sessionId}, type=${MessageType[messageType]}`
      );
    } catch (error) {
      this.logger.error(`Error relaying message to Hub: session=${sessionId}`, error);
      throw error;
    }
  }

  /**
   * 处理来自 Hub 的中转消息
   * 
   * @param relay ClientMessageRelay 消息
   */
  private async handleRelayFromHub(relay: hubedge.ClientMessageRelay): Promise<void> {
    try {
      const sessionId = relay.session_id;

      // 检查客户端是否存在
      const client = this.clientManager.getClient(sessionId);
      if (!client) {
        this.logger.warn(`Client not found for relay: session=${sessionId}`);
        return;
      }

      // 提取 Mumble 消息
      const { messageType, message } = this.extractMumbleMessage(relay);
      if (!messageType || !message) {
        this.logger.warn('No valid Mumble message in relay');
        return;
      }

      // 序列化 Mumble 消息并发送给客户端
      // Type assertion: we know message has serialize() based on messageType
      const messageData = (message as { serialize(): Uint8Array }).serialize();
      this.messageHandler.sendMessage(sessionId, messageType, Buffer.from(messageData));

      this.logger.debug(
        `Relayed message from Hub to client: session=${sessionId}, type=${MessageType[messageType]}`
      );
    } catch (error) {
      this.logger.error('Error relaying message to client:', error);
      throw error;
    }
  }

  /**
   * 解析 Mumble 消息
   * 
   * @param messageType 消息类型
   * @param messageData 消息数据
   * @returns 解析后的 Mumble 消息对象
   */
  private parseMumbleMessage(
    messageType: MessageType,
    messageData: Buffer
  ): unknown | null {
    try {
      switch (messageType) {
        case MessageType.Version:
          return mumbleproto.Version.decode(messageData);
        case MessageType.UDPTunnel:
          return mumbleproto.UDPTunnel.decode(messageData);
        case MessageType.Authenticate:
          return mumbleproto.Authenticate.decode(messageData);
        case MessageType.Ping:
          return mumbleproto.Ping.decode(messageData);
        case MessageType.Reject:
          return mumbleproto.Reject.decode(messageData);
        case MessageType.ServerSync:
          return mumbleproto.ServerSync.decode(messageData);
        case MessageType.ChannelRemove:
          return mumbleproto.ChannelRemove.decode(messageData);
        case MessageType.ChannelState:
          return mumbleproto.ChannelState.decode(messageData);
        case MessageType.UserRemove:
          return mumbleproto.UserRemove.decode(messageData);
        case MessageType.UserState:
          return mumbleproto.UserState.decode(messageData);
        case MessageType.BanList:
          return mumbleproto.BanList.decode(messageData);
        case MessageType.TextMessage:
          return mumbleproto.TextMessage.decode(messageData);
        case MessageType.PermissionDenied:
          return mumbleproto.PermissionDenied.decode(messageData);
        case MessageType.ACL:
          return mumbleproto.ACL.decode(messageData);
        case MessageType.QueryUsers:
          return mumbleproto.QueryUsers.decode(messageData);
        case MessageType.CryptSetup:
          return mumbleproto.CryptSetup.decode(messageData);
        case MessageType.ContextActionModify:
          return mumbleproto.ContextActionModify.decode(messageData);
        case MessageType.ContextAction:
          return mumbleproto.ContextAction.decode(messageData);
        case MessageType.UserList:
          return mumbleproto.UserList.decode(messageData);
        case MessageType.VoiceTarget:
          return mumbleproto.VoiceTarget.decode(messageData);
        case MessageType.PermissionQuery:
          return mumbleproto.PermissionQuery.decode(messageData);
        case MessageType.CodecVersion:
          return mumbleproto.CodecVersion.decode(messageData);
        case MessageType.UserStats:
          return mumbleproto.UserStats.decode(messageData);
        case MessageType.RequestBlob:
          return mumbleproto.RequestBlob.decode(messageData);
        case MessageType.ServerConfig:
          return mumbleproto.ServerConfig.decode(messageData);
        case MessageType.SuggestConfig:
          return mumbleproto.SuggestConfig.decode(messageData);
        default:
          this.logger.warn(`Unsupported message type: ${messageType}`);
          return null;
      }
    } catch (error) {
      this.logger.error(`Error parsing Mumble message type ${messageType}:`, error);
      return null;
    }
  }

  /**
   * 创建 ClientMessageRelay 消息
   * 
   * @param sessionId 会话 ID
   * @param messageType Mumble 消息类型
   * @param message Mumble 消息对象
   * @param direction 中转方向
   * @returns ClientMessageRelay 对象
   */
  private createRelayMessage(
    sessionId: number,
    messageType: MessageType,
    message: unknown,
    direction: hubedge.RelayDirection
  ): hubedge.ClientMessageRelay {
    const relayData: hubedge.ClientMessageRelay = {
      session_id: sessionId,
      edge_id: this.edgeId,
      direction: direction,
      timestamp: Date.now(),
    };

    // 根据消息类型设置对应的字段
    switch (messageType) {
      case MessageType.Version:
        relayData.version = message as mumbleproto.Version;
        break;
      case MessageType.UDPTunnel:
        relayData.udp_tunnel = message as mumbleproto.UDPTunnel;
        break;
      case MessageType.Authenticate:
        relayData.authenticate = message as mumbleproto.Authenticate;
        break;
      case MessageType.Ping:
        relayData.ping = message as mumbleproto.Ping;
        break;
      case MessageType.Reject:
        relayData.reject = message as mumbleproto.Reject;
        break;
      case MessageType.ServerSync:
        relayData.server_sync = message as mumbleproto.ServerSync;
        break;
      case MessageType.ChannelRemove:
        relayData.channel_remove = message as mumbleproto.ChannelRemove;
        break;
      case MessageType.ChannelState:
        relayData.channel_state = message as mumbleproto.ChannelState;
        break;
      case MessageType.UserRemove:
        relayData.user_remove = message as mumbleproto.UserRemove;
        break;
      case MessageType.UserState:
        relayData.user_state = message as mumbleproto.UserState;
        break;
      case MessageType.BanList:
        relayData.ban_list = message as mumbleproto.BanList;
        break;
      case MessageType.TextMessage:
        relayData.text_message = message as mumbleproto.TextMessage;
        break;
      case MessageType.PermissionDenied:
        relayData.permission_denied = message as mumbleproto.PermissionDenied;
        break;
      case MessageType.ACL:
        relayData.acl = message as mumbleproto.ACL;
        break;
      case MessageType.QueryUsers:
        relayData.query_users = message as mumbleproto.QueryUsers;
        break;
      case MessageType.CryptSetup:
        relayData.crypt_setup = message as mumbleproto.CryptSetup;
        break;
      case MessageType.ContextActionModify:
        relayData.context_action_modify = message as mumbleproto.ContextActionModify;
        break;
      case MessageType.ContextAction:
        relayData.context_action = message as mumbleproto.ContextAction;
        break;
      case MessageType.UserList:
        relayData.user_list = message as mumbleproto.UserList;
        break;
      case MessageType.VoiceTarget:
        relayData.voice_target = message as mumbleproto.VoiceTarget;
        break;
      case MessageType.PermissionQuery:
        relayData.permission_query = message as mumbleproto.PermissionQuery;
        break;
      case MessageType.CodecVersion:
        relayData.codec_version = message as mumbleproto.CodecVersion;
        break;
      case MessageType.UserStats:
        relayData.user_stats = message as mumbleproto.UserStats;
        break;
      case MessageType.RequestBlob:
        relayData.request_blob = message as mumbleproto.RequestBlob;
        break;
      case MessageType.ServerConfig:
        relayData.server_config = message as mumbleproto.ServerConfig;
        break;
      case MessageType.SuggestConfig:
        relayData.suggest_config = message as mumbleproto.SuggestConfig;
        break;
      default:
        this.logger.warn(`Unsupported message type for relay: ${messageType}`);
    }

    return relayData;
  }

  /**
   * 从 ClientMessageRelay 中提取 Mumble 消息
   * 
   * @param relay ClientMessageRelay 对象
   * @returns 消息类型和消息对象
   */
  private extractMumbleMessage(
    relay: hubedge.ClientMessageRelay
  ): { messageType: MessageType | null; message: unknown | null } {
    // 检查每个可能的 Mumble 消息字段
    if (relay !== undefined) {
      return { messageType: MessageType.Version, message: relay.version };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.UDPTunnel, message: relay.udp_tunnel };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.Authenticate, message: relay.authenticate };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.Ping, message: relay.ping };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.Reject, message: relay.reject };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.ServerSync, message: relay.server_sync };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.ChannelRemove, message: relay.channel_remove };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.ChannelState, message: relay.channel_state };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.UserRemove, message: relay.user_remove };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.UserState, message: relay.user_state };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.BanList, message: relay.ban_list };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.TextMessage, message: relay.text_message };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.PermissionDenied, message: relay.permission_denied };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.ACL, message: relay.acl };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.QueryUsers, message: relay.query_users };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.CryptSetup, message: relay.crypt_setup };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.ContextActionModify, message: relay.context_action_modify };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.ContextAction, message: relay.context_action };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.UserList, message: relay.user_list };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.VoiceTarget, message: relay.voice_target };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.PermissionQuery, message: relay.permission_query };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.CodecVersion, message: relay.codec_version };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.UserStats, message: relay.user_stats };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.RequestBlob, message: relay.request_blob };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.ServerConfig, message: relay.server_config };
    }
    if (relay !== undefined) {
      return { messageType: MessageType.SuggestConfig, message: relay.suggest_config };
    }

    return { messageType: null, message: null };
  }

  /**
   * 批量中转消息到 Hub
   * 性能优化：一次性发送多个消息
   * 
   * @param messages 消息数组
   */
  async relayBatchToHub(
    messages: Array<{
      sessionId: number;
      messageType: MessageType;
      messageData: Buffer;
    }>
  ): Promise<void> {
    try {
      const relays: hubedge.ClientMessageRelay[] = [];

      for (const { sessionId, messageType, messageData } of messages) {
        const mumbleMessage = this.parseMumbleMessage(messageType, messageData);
        if (mumbleMessage) {
          const relay = this.createRelayMessage(
            sessionId,
            messageType,
            mumbleMessage,
            hubedge.RelayDirection.RELAY_DIRECTION_CLIENT_TO_HUB
          );
          relays.push(relay);
        }
      }

      if (relays.length > 0) {
        await this.hubClient.sendRelayBatch(relays);
        this.logger.debug(`Relayed ${relays.length} messages in batch to Hub`);
      }
    } catch (error) {
      this.logger.error('Error relaying batch to Hub:', error);
      throw error;
    }
  }

  /**
   * 清理资源
   */
  destroy(): void {
    this.removeAllListeners();
  }
}
