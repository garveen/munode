import { EventEmitter } from 'events';
import { createLogger } from '@munode/common';
import {
  hubedge,
  mumbleproto,
  MessageType,
} from '@munode/protocol';
import type { EdgeControlClient } from '../cluster/hub-client.js';
import type { ClientManager } from '../client/client-manager.js';
import type { MessageHandler } from '../message-handler.js';

const logger = createLogger({ service: 'edge-relay-handler' });

/**
 * 客户端消息中转处理器 (Edge 端)
 * 
 * 功能：
 * 1. 将客户端的 Mumble 消息转发到 Hub
 * 2. 将 Hub 的消息转发到客户端
 * 3. 直接引用 Mumble.proto 消息，避免二次序列化
 */
export class ClientMessageRelayHandler extends EventEmitter {
  private hubClient: EdgeControlClient;
  private clientManager: ClientManager;
  private messageHandler: MessageHandler;
  private edgeId: number;

  constructor(
    hubClient: EdgeControlClient,
    clientManager: ClientManager,
    messageHandler: MessageHandler,
    edgeId: number
  ) {
    super();
    this.hubClient = hubClient;
    this.clientManager = clientManager;
    this.messageHandler = messageHandler;
    this.edgeId = edgeId;
    
    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // 监听来自 Hub 的中转消息
    this.hubClient.on('relay', (relay: hubedge.ClientMessageRelay) => {
      this.handleRelayFromHub(relay).catch((error) => {
        logger.error('Error handling relay from Hub:', error);
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
        logger.warn(`Failed to parse Mumble message type ${messageType}`);
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

      logger.debug(
        `Relayed message from client to Hub: session=${sessionId}, type=${MessageType[messageType]}`
      );
    } catch (error) {
      logger.error(`Error relaying message to Hub: session=${sessionId}`, error);
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
        logger.warn(`Client not found for relay: session=${sessionId}`);
        return;
      }

      // 提取 Mumble 消息
      const { messageType, message } = this.extractMumbleMessage(relay);
      if (!messageType || !message) {
        logger.warn('No valid Mumble message in relay');
        return;
      }

      // 序列化 Mumble 消息并发送给客户端
      const messageData = message.serialize();
      this.messageHandler.sendMessage(sessionId, messageType, Buffer.from(messageData));

      logger.debug(
        `Relayed message from Hub to client: session=${sessionId}, type=${MessageType[messageType]}`
      );
    } catch (error) {
      logger.error('Error relaying message to client:', error);
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
  ): any {
    try {
      switch (messageType) {
        case MessageType.Version:
          return mumbleproto.Version.deserialize(messageData);
        case MessageType.UDPTunnel:
          return mumbleproto.UDPTunnel.deserialize(messageData);
        case MessageType.Authenticate:
          return mumbleproto.Authenticate.deserialize(messageData);
        case MessageType.Ping:
          return mumbleproto.Ping.deserialize(messageData);
        case MessageType.Reject:
          return mumbleproto.Reject.deserialize(messageData);
        case MessageType.ServerSync:
          return mumbleproto.ServerSync.deserialize(messageData);
        case MessageType.ChannelRemove:
          return mumbleproto.ChannelRemove.deserialize(messageData);
        case MessageType.ChannelState:
          return mumbleproto.ChannelState.deserialize(messageData);
        case MessageType.UserRemove:
          return mumbleproto.UserRemove.deserialize(messageData);
        case MessageType.UserState:
          return mumbleproto.UserState.deserialize(messageData);
        case MessageType.BanList:
          return mumbleproto.BanList.deserialize(messageData);
        case MessageType.TextMessage:
          return mumbleproto.TextMessage.deserialize(messageData);
        case MessageType.PermissionDenied:
          return mumbleproto.PermissionDenied.deserialize(messageData);
        case MessageType.ACL:
          return mumbleproto.ACL.deserialize(messageData);
        case MessageType.QueryUsers:
          return mumbleproto.QueryUsers.deserialize(messageData);
        case MessageType.CryptSetup:
          return mumbleproto.CryptSetup.deserialize(messageData);
        case MessageType.ContextActionModify:
          return mumbleproto.ContextActionModify.deserialize(messageData);
        case MessageType.ContextAction:
          return mumbleproto.ContextAction.deserialize(messageData);
        case MessageType.UserList:
          return mumbleproto.UserList.deserialize(messageData);
        case MessageType.VoiceTarget:
          return mumbleproto.VoiceTarget.deserialize(messageData);
        case MessageType.PermissionQuery:
          return mumbleproto.PermissionQuery.deserialize(messageData);
        case MessageType.CodecVersion:
          return mumbleproto.CodecVersion.deserialize(messageData);
        case MessageType.UserStats:
          return mumbleproto.UserStats.deserialize(messageData);
        case MessageType.RequestBlob:
          return mumbleproto.RequestBlob.deserialize(messageData);
        case MessageType.ServerConfig:
          return mumbleproto.ServerConfig.deserialize(messageData);
        case MessageType.SuggestConfig:
          return mumbleproto.SuggestConfig.deserialize(messageData);
        default:
          logger.warn(`Unsupported message type: ${messageType}`);
          return null;
      }
    } catch (error) {
      logger.error(`Error parsing Mumble message type ${messageType}:`, error);
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
    message: any,
    direction: hubedge.RelayDirection
  ): hubedge.ClientMessageRelay {
    const relay = new hubedge.ClientMessageRelay({
      session_id: sessionId,
      edge_id: this.edgeId,
      direction: direction,
      timestamp: Date.now(),
    });

    // 根据消息类型设置对应的字段
    switch (messageType) {
      case MessageType.Version:
        relay.version = message as mumbleproto.Version;
        break;
      case MessageType.UDPTunnel:
        relay.udp_tunnel = message as mumbleproto.UDPTunnel;
        break;
      case MessageType.Authenticate:
        relay.authenticate = message as mumbleproto.Authenticate;
        break;
      case MessageType.Ping:
        relay.ping = message as mumbleproto.Ping;
        break;
      case MessageType.Reject:
        relay.reject = message as mumbleproto.Reject;
        break;
      case MessageType.ServerSync:
        relay.server_sync = message as mumbleproto.ServerSync;
        break;
      case MessageType.ChannelRemove:
        relay.channel_remove = message as mumbleproto.ChannelRemove;
        break;
      case MessageType.ChannelState:
        relay.channel_state = message as mumbleproto.ChannelState;
        break;
      case MessageType.UserRemove:
        relay.user_remove = message as mumbleproto.UserRemove;
        break;
      case MessageType.UserState:
        relay.user_state = message as mumbleproto.UserState;
        break;
      case MessageType.BanList:
        relay.ban_list = message as mumbleproto.BanList;
        break;
      case MessageType.TextMessage:
        relay.text_message = message as mumbleproto.TextMessage;
        break;
      case MessageType.PermissionDenied:
        relay.permission_denied = message as mumbleproto.PermissionDenied;
        break;
      case MessageType.ACL:
        relay.acl = message as mumbleproto.ACL;
        break;
      case MessageType.QueryUsers:
        relay.query_users = message as mumbleproto.QueryUsers;
        break;
      case MessageType.CryptSetup:
        relay.crypt_setup = message as mumbleproto.CryptSetup;
        break;
      case MessageType.ContextActionModify:
        relay.context_action_modify = message as mumbleproto.ContextActionModify;
        break;
      case MessageType.ContextAction:
        relay.context_action = message as mumbleproto.ContextAction;
        break;
      case MessageType.UserList:
        relay.user_list = message as mumbleproto.UserList;
        break;
      case MessageType.VoiceTarget:
        relay.voice_target = message as mumbleproto.VoiceTarget;
        break;
      case MessageType.PermissionQuery:
        relay.permission_query = message as mumbleproto.PermissionQuery;
        break;
      case MessageType.CodecVersion:
        relay.codec_version = message as mumbleproto.CodecVersion;
        break;
      case MessageType.UserStats:
        relay.user_stats = message as mumbleproto.UserStats;
        break;
      case MessageType.RequestBlob:
        relay.request_blob = message as mumbleproto.RequestBlob;
        break;
      case MessageType.ServerConfig:
        relay.server_config = message as mumbleproto.ServerConfig;
        break;
      case MessageType.SuggestConfig:
        relay.suggest_config = message as mumbleproto.SuggestConfig;
        break;
      default:
        logger.warn(`Unsupported message type for relay: ${messageType}`);
    }

    return relay;
  }

  /**
   * 从 ClientMessageRelay 中提取 Mumble 消息
   * 
   * @param relay ClientMessageRelay 对象
   * @returns 消息类型和消息对象
   */
  private extractMumbleMessage(
    relay: hubedge.ClientMessageRelay
  ): { messageType: MessageType | null; message: any } {
    // 检查每个可能的 Mumble 消息字段
    if (relay.has_version) {
      return { messageType: MessageType.Version, message: relay.version };
    }
    if (relay.has_udp_tunnel) {
      return { messageType: MessageType.UDPTunnel, message: relay.udp_tunnel };
    }
    if (relay.has_authenticate) {
      return { messageType: MessageType.Authenticate, message: relay.authenticate };
    }
    if (relay.has_ping) {
      return { messageType: MessageType.Ping, message: relay.ping };
    }
    if (relay.has_reject) {
      return { messageType: MessageType.Reject, message: relay.reject };
    }
    if (relay.has_server_sync) {
      return { messageType: MessageType.ServerSync, message: relay.server_sync };
    }
    if (relay.has_channel_remove) {
      return { messageType: MessageType.ChannelRemove, message: relay.channel_remove };
    }
    if (relay.has_channel_state) {
      return { messageType: MessageType.ChannelState, message: relay.channel_state };
    }
    if (relay.has_user_remove) {
      return { messageType: MessageType.UserRemove, message: relay.user_remove };
    }
    if (relay.has_user_state) {
      return { messageType: MessageType.UserState, message: relay.user_state };
    }
    if (relay.has_ban_list) {
      return { messageType: MessageType.BanList, message: relay.ban_list };
    }
    if (relay.has_text_message) {
      return { messageType: MessageType.TextMessage, message: relay.text_message };
    }
    if (relay.has_permission_denied) {
      return { messageType: MessageType.PermissionDenied, message: relay.permission_denied };
    }
    if (relay.has_acl) {
      return { messageType: MessageType.ACL, message: relay.acl };
    }
    if (relay.has_query_users) {
      return { messageType: MessageType.QueryUsers, message: relay.query_users };
    }
    if (relay.has_crypt_setup) {
      return { messageType: MessageType.CryptSetup, message: relay.crypt_setup };
    }
    if (relay.has_context_action_modify) {
      return { messageType: MessageType.ContextActionModify, message: relay.context_action_modify };
    }
    if (relay.has_context_action) {
      return { messageType: MessageType.ContextAction, message: relay.context_action };
    }
    if (relay.has_user_list) {
      return { messageType: MessageType.UserList, message: relay.user_list };
    }
    if (relay.has_voice_target) {
      return { messageType: MessageType.VoiceTarget, message: relay.voice_target };
    }
    if (relay.has_permission_query) {
      return { messageType: MessageType.PermissionQuery, message: relay.permission_query };
    }
    if (relay.has_codec_version) {
      return { messageType: MessageType.CodecVersion, message: relay.codec_version };
    }
    if (relay.has_user_stats) {
      return { messageType: MessageType.UserStats, message: relay.user_stats };
    }
    if (relay.has_request_blob) {
      return { messageType: MessageType.RequestBlob, message: relay.request_blob };
    }
    if (relay.has_server_config) {
      return { messageType: MessageType.ServerConfig, message: relay.server_config };
    }
    if (relay.has_suggest_config) {
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
        logger.debug(`Relayed ${relays.length} messages in batch to Hub`);
      }
    } catch (error) {
      logger.error('Error relaying batch to Hub:', error);
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
