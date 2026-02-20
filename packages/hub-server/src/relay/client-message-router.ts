import type { Logger } from '@munode/common';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import {
  hubedge,
  mumbleproto,
  MessageType,
  ChannelNotificationParams,
} from '@munode/protocol';
import type { GlobalSessionManager } from '../session-manager.js';

/**
 * ClientMessageRouter 事件类型定义
 */
export interface ClientMessageRouterEvents extends EventMap {
  'clientMessage': [data: {
    sessionId: number;
    edgeId: number;
    messageType: number;
    relay: hubedge.ClientMessageRelay;
  }];
}

/**
 * 客户端消息路由器 (Hub 端)
 * 
 * 功能：
 * 1. 接收来自 Edge 的客户端消息
 * 2. 处理消息路由（单播、多播、频道广播、全局广播）
 * 3. 将消息转发到目标 Edge
 */
export class ClientMessageRouter extends TypedEventEmitter<ClientMessageRouterEvents> {
  private sessionManager: GlobalSessionManager;
  private controlService: {
    notify: (edgeId: number, method: string, params?: ChannelNotificationParams) => void;
    sendRelayToEdge?: (edgeId: number, message: hubedge.ClientMessageRelay) => void;
  } | null = null;
  private logger: Logger;

  constructor(
    sessionManager: GlobalSessionManager,
    logger: Logger
  ) {
    super();
    this.sessionManager = sessionManager;
    this.logger = logger;
  }

  /**
   * 设置 ControlService 引用（循环依赖，延迟设置）
   */
  setControlService(controlService: {
    notify: (edgeId: number, method: string, params?: ChannelNotificationParams) => void;
    sendRelayToEdge?: (edgeId: number, message: hubedge.ClientMessageRelay) => void;
  }): void {
    this.controlService = controlService;
  }

  /**
   * 路由客户端消息
   * 
   * @param relay ClientMessageRelay 对象
   */
  async route(relay: hubedge.ClientMessageRelay): Promise<void> {
    try {
      const { session_id, direction, routing } = relay;

      this.logger.debug(
        `Routing message: session=${session_id}, direction=${direction}, ` +
        `routing=${routing ? hubedge.RoutingType[routing.type] : 'none'}`
      );

      // 根据方向处理
      if (direction === hubedge.RelayDirection.RELAY_DIRECTION_CLIENT_TO_HUB) {
        // 客户端 -> Hub：处理消息逻辑
        await this.handleClientMessage(relay);
      } else if (direction === hubedge.RelayDirection.RELAY_DIRECTION_HUB_TO_CLIENT) {
        // Hub -> 客户端：根据路由信息分发
        await this.distributeToClients(relay);
      }
    } catch (error) {
      this.logger.error('Error routing message:', error);
      throw error;
    }
  }

  /**
   * 处理来自客户端的消息
   * 
   * @param relay ClientMessageRelay 对象
   */
  private async handleClientMessage(relay: hubedge.ClientMessageRelay): Promise<void> {
    // 提取消息类型
    const messageType = this.getMessageType(relay);
    if (!messageType) {
      this.logger.warn('No valid message type in relay');
      return;
    }

    this.logger.debug(
      `Handling client message: session=${relay.session_id}, type=${MessageType[messageType]}`
    );

    // 这里可以添加消息处理逻辑
    // 例如：认证、权限检查、状态更新等
    // 当前只记录日志，实际处理逻辑由具体的 Handler 完成

    this.emit('clientMessage', {
      sessionId: relay.session_id,
      edgeId: relay.edge_id,
      messageType,
      relay,
    });
  }

  /**
   * 将消息分发到客户端
   * 
   * @param relay ClientMessageRelay 对象
   */
  private async distributeToClients(relay: hubedge.ClientMessageRelay): Promise<void> {
    const routing = relay.routing;

    if (!routing) {
      // 没有路由信息，默认单播到 session_id
      await this.sendToSession(relay.session_id, relay);
      return;
    }

    switch (routing.type) {
      case hubedge.RoutingType.ROUTING_TYPE_UNICAST:
        // 单播：发送给特定会话
        await this.handleUnicast(relay, routing);
        break;

      case hubedge.RoutingType.ROUTING_TYPE_MULTICAST:
        // 多播：发送给多个特定会话
        await this.handleMulticast(relay, routing);
        break;

      case hubedge.RoutingType.ROUTING_TYPE_CHANNEL:
        // 频道广播：发送给频道内所有用户
        await this.handleChannelBroadcast(relay, routing);
        break;

      case hubedge.RoutingType.ROUTING_TYPE_BROADCAST:
        // 全局广播：发送给所有用户
        await this.handleGlobalBroadcast(relay, routing);
        break;

      default:
        this.logger.warn(`Unknown routing type: ${routing.type}`);
    }
  }

  /**
   * 单播：发送给特定会话
   */
  private async handleUnicast(
    relay: hubedge.ClientMessageRelay,
    routing: hubedge.RelayRouting
  ): Promise<void> {
    if (routing.target_sessions.length === 0) {
      this.logger.warn('Unicast without target sessions');
      return;
    }

    const targetSession = routing.target_sessions[0];
    await this.sendToSession(targetSession, relay);
  }

  /**
   * 多播：发送给多个特定会话
   */
  private async handleMulticast(
    relay: hubedge.ClientMessageRelay,
    routing: hubedge.RelayRouting
  ): Promise<void> {
    const targetSessions = routing.target_sessions;
    const excludeSessions = new Set(routing.exclude_sessions);

    this.logger.debug(
      `Multicasting to ${targetSessions.length} sessions, excluding ${excludeSessions.size}`
    );

    for (const sessionId of targetSessions) {
      if (!excludeSessions.has(sessionId)) {
        await this.sendToSession(sessionId, relay);
      }
    }
  }

  /**
   * 频道广播：发送给频道内所有用户
   */
  private async handleChannelBroadcast(
    relay: hubedge.ClientMessageRelay,
    routing: hubedge.RelayRouting
  ): Promise<void> {
    if (routing.target_channel === undefined || routing.target_channel === 0) {
      this.logger.warn('Channel broadcast without target channel');
      return;
    }

    const channelId = routing.target_channel;
    const excludeSessions = new Set(routing.exclude_sessions);

    // 获取频道内的所有用户
    const sessions = this.sessionManager.getChannelSessions(channelId).map(s => s.session_id);

    this.logger.debug(
      `Broadcasting to channel ${channelId}: ${sessions.length} users, excluding ${excludeSessions.size}`
    );

    for (const sessionId of sessions) {
      if (!excludeSessions.has(sessionId)) {
        await this.sendToSession(sessionId, relay);
      }
    }
  }

  /**
   * 全局广播：发送给所有用户
   */
  private async handleGlobalBroadcast(
    relay: hubedge.ClientMessageRelay,
    routing: hubedge.RelayRouting
  ): Promise<void> {
    const excludeSessions = new Set(routing.exclude_sessions);
    const allSessions = this.sessionManager.getAllSessions();

    this.logger.debug(
      `Broadcasting globally to ${allSessions.length} users, excluding ${excludeSessions.size}`
    );

    for (const session of allSessions) {
      if (!excludeSessions.has(session.session_id)) {
        await this.sendToSession(session.session_id, relay);
      }
    }
  }

  /**
   * 发送消息到特定会话
   * 
   * @param sessionId 会话 ID
   * @param relay ClientMessageRelay 对象
   */
  private async sendToSession(
    sessionId: number,
    relay: hubedge.ClientMessageRelay
  ): Promise<void> {
    try {
      // 获取会话信息
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        this.logger.debug(`Session not found: ${sessionId}`);
        return;
      }

      // 获取会话所在的 Edge
      const edgeId = session.edge_id;
      if (!edgeId) {
        this.logger.warn(`No edge_id for session ${sessionId}`);
        return;
      }

      // 更新 relay 的目标信息
      const targetRelay: hubedge.ClientMessageRelay = {
        session_id: sessionId,
        edge_id: edgeId,
        direction: hubedge.RelayDirection.RELAY_DIRECTION_HUB_TO_CLIENT,
        timestamp: Date.now(),
      };

      // 复制 Mumble 消息字段
      this.copyMumbleFields(relay, targetRelay);

      // 通过 ControlService 发送到 Edge
      await this.controlService.sendRelayToEdge(edgeId, targetRelay);

      this.logger.debug(`Sent message to session ${sessionId} on edge ${edgeId}`);
    } catch (error) {
      this.logger.error(`Error sending message to session ${sessionId}:`, error);
    }
  }

  /**
   * 复制 Mumble 消息字段
   */
  private copyMumbleFields(
    source: hubedge.ClientMessageRelay,
    target: hubedge.ClientMessageRelay
  ): void {
    // 检查并复制每个可能的 Mumble 消息字段
    if (source.version !== undefined) target.version = source.version;
    if (source.udp_tunnel !== undefined) target.udp_tunnel = source.udp_tunnel;
    if (source.authenticate !== undefined) target.authenticate = source.authenticate;
    if (source.ping !== undefined) target.ping = source.ping;
    if (source.reject !== undefined) target.reject = source.reject;
    if (source.server_sync !== undefined) target.server_sync = source.server_sync;
    if (source.channel_remove !== undefined) target.channel_remove = source.channel_remove;
    if (source.channel_state !== undefined) target.channel_state = source.channel_state;
    if (source.user_remove !== undefined) target.user_remove = source.user_remove;
    if (source.user_state !== undefined) target.user_state = source.user_state;
    if (source.ban_list !== undefined) target.ban_list = source.ban_list;
    if (source.text_message !== undefined) target.text_message = source.text_message;
    if (source.permission_denied !== undefined) target.permission_denied = source.permission_denied;
    if (source.acl !== undefined) target.acl = source.acl;
    if (source.query_users !== undefined) target.query_users = source.query_users;
    if (source.crypt_setup !== undefined) target.crypt_setup = source.crypt_setup;
    if (source.context_action_modify !== undefined) target.context_action_modify = source.context_action_modify;
    if (source.context_action !== undefined) target.context_action = source.context_action;
    if (source.user_list !== undefined) target.user_list = source.user_list;
    if (source.voice_target !== undefined) target.voice_target = source.voice_target;
    if (source.permission_query !== undefined) target.permission_query = source.permission_query;
    if (source.codec_version !== undefined) target.codec_version = source.codec_version;
    if (source.user_stats !== undefined) target.user_stats = source.user_stats;
    if (source.request_blob !== undefined) target.request_blob = source.request_blob;
    if (source.server_config !== undefined) target.server_config = source.server_config;
    if (source.suggest_config !== undefined) target.suggest_config = source.suggest_config;
  }

  /**
   * 获取 Relay 中的消息类型
   */
  private getMessageType(relay: hubedge.ClientMessageRelay): MessageType | null {
    if (relay.version !== undefined) return MessageType.Version;
    if (relay.udp_tunnel !== undefined) return MessageType.UDPTunnel;
    if (relay.authenticate !== undefined) return MessageType.Authenticate;
    if (relay.ping !== undefined) return MessageType.Ping;
    if (relay.reject !== undefined) return MessageType.Reject;
    if (relay.server_sync !== undefined) return MessageType.ServerSync;
    if (relay.channel_remove !== undefined) return MessageType.ChannelRemove;
    if (relay.channel_state !== undefined) return MessageType.ChannelState;
    if (relay.user_remove !== undefined) return MessageType.UserRemove;
    if (relay.user_state !== undefined) return MessageType.UserState;
    if (relay.ban_list !== undefined) return MessageType.BanList;
    if (relay.text_message !== undefined) return MessageType.TextMessage;
    if (relay.permission_denied !== undefined) return MessageType.PermissionDenied;
    if (relay.acl !== undefined) return MessageType.ACL;
    if (relay.query_users !== undefined) return MessageType.QueryUsers;
    if (relay.crypt_setup !== undefined) return MessageType.CryptSetup;
    if (relay.context_action_modify !== undefined) return MessageType.ContextActionModify;
    if (relay.context_action !== undefined) return MessageType.ContextAction;
    if (relay.user_list !== undefined) return MessageType.UserList;
    if (relay.voice_target !== undefined) return MessageType.VoiceTarget;
    if (relay.permission_query !== undefined) return MessageType.PermissionQuery;
    if (relay.codec_version !== undefined) return MessageType.CodecVersion;
    if (relay.user_stats !== undefined) return MessageType.UserStats;
    if (relay.request_blob !== undefined) return MessageType.RequestBlob;
    if (relay.server_config !== undefined) return MessageType.ServerConfig;
    if (relay.suggest_config !== undefined) return MessageType.SuggestConfig;
    return null;
  }

  /**
   * 频道广播（便捷方法）
   * 
   * @param channelId 频道 ID
   * @param messageType 消息类型
   * @param message Mumble 消息对象
   * @param excludeSessions 排除的会话 ID
   */
  async broadcastToChannel<T extends mumbleproto.Version | mumbleproto.TextMessage>(
    channelId: number,
    messageType: MessageType,
    message: T,
    excludeSessions: number[] = []
  ): Promise<void> {
    const relay: hubedge.ClientMessageRelay = {
      session_id: 0, // 广播时不需要特定 session_id
      edge_id: 0, // 由路由器自动填充
      direction: hubedge.RelayDirection.RELAY_DIRECTION_HUB_TO_CLIENT,
      timestamp: Date.now(),
      routing: {
        type: hubedge.RoutingType.ROUTING_TYPE_CHANNEL,
        target_sessions: [], // Required field
        target_channel: channelId,
        exclude_sessions: excludeSessions,
      },
    };

    // 设置消息字段
    this.setMessageField(relay, messageType, message);

    await this.route(relay);
  }

  /**
   * 全局广播（便捷方法）
   * 
   * @param messageType 消息类型
   * @param message Mumble 消息对象
   * @param excludeSessions 排除的会话 ID
   */
  async broadcastGlobal<T extends mumbleproto.Version | mumbleproto.TextMessage>(
    messageType: MessageType,
    message: T,
    excludeSessions: number[] = []
  ): Promise<void> {
    const relay: hubedge.ClientMessageRelay = {
      session_id: 0,
      edge_id: 0,
      direction: hubedge.RelayDirection.RELAY_DIRECTION_HUB_TO_CLIENT,
      timestamp: Date.now(),
      routing: {
        type: hubedge.RoutingType.ROUTING_TYPE_BROADCAST,
        target_sessions: [], // Required field
        exclude_sessions: excludeSessions,
      },
    };

    this.setMessageField(relay, messageType, message);

    await this.route(relay);
  }

  /**
   * 设置 Relay 的消息字段
   */
  private setMessageField(
    relay: hubedge.ClientMessageRelay,
    messageType: MessageType,
    message: unknown
  ): void {
    // Type assertion is safe here because message type matches messageType at runtime
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
    }
  }

  /**
   * 清理资源
   */
  destroy(): void {
    this.removeAllListeners();
  }
}
