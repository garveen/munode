import { EventEmitter } from 'events';
// import { logger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, ClientState } from './types.js';
import { mumbleproto } from '@munode/protocol';
import { MessageType } from '@munode/protocol';

/**
 * 消息处理器 - 处理 Mumble 协议消息
 */
export class MessageHandler extends EventEmitter {
  private logger: Logger;
  private clientManager: {
    getClient: (session: number) => { state: ClientState } | undefined;
  } | null = null;

  constructor(_config: EdgeConfig, logger: Logger) {
    super();
    this.logger = logger;
  }

  /**
   * 设置 ClientManager 引用（在 HandlerFactory 中调用）
   */
  setClientManager(clientManager: {
    getClient: (session: number) => { state: ClientState } | undefined;
  }): void {
    this.clientManager = clientManager;
  }

  /**
   * 处理客户端消息
   */
  handleMessage( session_id: number, messageType: number, messageData: Buffer): void {
    try {
      // 获取客户端状态
      const client = this.clientManager?.getClient(session_id);
      const clientState = client?.state;

      this.logger.debug(
        `Handling message: session=${session_id}, type=${messageType}, size=${messageData.length}, state=${clientState}`
      );

      // UDPTunnel 消息不受状态检查限制（与 Mumble 官方实现保持一致）
      // 这是性能优化：语音包是高优先级数据，不应该通过同步路径
      // 参考：murmur/Server.cpp line 1712 和 go-implement/client.go line 869
      if (messageType === MessageType.UDPTunnel) {
        this.handleUDPTunnel(session_id, messageData);
        return;
      }

      // 根据客户端状态检查消息是否合法
      if (!this.isMessageAllowedInState(messageType, clientState)) {
        this.logger.warn(
          `Message type ${messageType} not allowed in state ${clientState} for session ${session_id}`
        );
        return;
      }

      switch (messageType) {
        case MessageType.Version:
          this.handleVersion(session_id, messageData);
          break;
        case MessageType.Authenticate:
          this.handleAuthenticate(session_id, messageData);
          break;
        case MessageType.Ping:
          this.handlePing(session_id, messageData);
          break;
        case MessageType.Reject:
          this.handleReject(session_id, messageData);
          break;
        case MessageType.ServerSync:
          this.handleServerSync(session_id, messageData);
          break;
        case MessageType.ChannelRemove:
          this.handleChannelRemove(session_id, messageData);
          break;
        case MessageType.ChannelState:
          this.handleChannelState(session_id, messageData);
          break;
        case MessageType.UserRemove:
          this.handleUserRemove(session_id, messageData);
          break;
        case MessageType.UserState:
          this.handleUserState(session_id, messageData);
          break;
        case MessageType.BanList:
          this.handleBanList(session_id, messageData);
          break;
        case MessageType.TextMessage:
          this.handleTextMessage(session_id, messageData);
          break;
        case MessageType.PermissionDenied:
          this.handlePermissionDenied(session_id, messageData);
          break;
        case MessageType.ACL:
          this.handleACL(session_id, messageData);
          break;
        case MessageType.QueryUsers:
          this.handleQueryUsers(session_id, messageData);
          break;
        case MessageType.CryptSetup:
          this.handleCryptSetup(session_id, messageData);
          break;
        case MessageType.ContextActionModify:
          this.handleContextActionModify(session_id, messageData);
          break;
        case MessageType.ContextAction:
          this.handleContextAction(session_id, messageData);
          break;
        case MessageType.UserList:
          this.handleUserList(session_id, messageData);
          break;
        case MessageType.VoiceTarget:
          this.handleVoiceTarget(session_id, messageData);
          break;
        case MessageType.PermissionQuery:
          this.handlePermissionQuery(session_id, messageData);
          break;
        case MessageType.CodecVersion:
          this.handleCodecVersion(session_id, messageData);
          break;
        case MessageType.UserStats:
          this.handleUserStats(session_id, messageData);
          break;
        case MessageType.RequestBlob:
          this.handleRequestBlob(session_id, messageData);
          break;
        case MessageType.ServerConfig:
          this.handleServerConfig(session_id, messageData);
          break;
        case MessageType.SuggestConfig:
          this.handleSuggestConfig(session_id, messageData);
          break;
        case MessageType.PluginDataTransmission:
          this.handlePluginDataTransmission(session_id, messageData);
          break;
        default:
          this.logger.warn(`Unknown message type: ${messageType}`);
          break;
      }
    } catch (error) {
      this.logger.error(`Error handling message type ${messageType}:`, error);
    }
  }

  /**
   * 检查消息类型在当前状态下是否允许
   */
  private isMessageAllowedInState(messageType: number, clientState?: ClientState): boolean {
    // 如果客户端状态未定义，拒绝所有消息（除了连接初期）
    if (clientState === undefined) {
      return false;
    }

    switch (clientState) {
      case ClientState.Connected:
        // 刚连接时允许接收 Version、Authenticate 和 Ping（与 C 实现保持一致）
        return messageType === MessageType.Version || 
               messageType === MessageType.Authenticate || 
               messageType === MessageType.Ping;

      case ClientState.ServerSentVersion:
        // 服务器已发送 Version，接受客户端的 Version、Authenticate 和 Ping
        return messageType === MessageType.Version || 
               messageType === MessageType.Authenticate || 
               messageType === MessageType.Ping;

      case ClientState.ClientSentVersion:
        // 客户端已发送 Version，只接受 Authenticate、UserState（PreConnect）和 Ping
        return (
          messageType === MessageType.Authenticate ||
          messageType === MessageType.UserState ||
          messageType === MessageType.Ping
        );

      case ClientState.Authenticated:
      case ClientState.Ready:
        // 认证完成后，接受大部分消息
        return true;

      case ClientState.Dead:
        // 客户端已断开，不接受任何消息
        return false;

      default:
        return false;
    }
  }

  /**
   * 处理版本消息
   */
  private handleVersion( session_id: number, data: Buffer): void {
    // 解析版本信息
    this.emit('version', session_id, data);
  }

  /**
   * 处理 UDP 隧道消息
   */
  private handleUDPTunnel( session_id: number, data: Buffer): void {
    // 添加日志便于调试
    this.logger.info(`[MESSAGE-HANDLER] Received UDPTunnel from session ${session_id}, data length: ${data.length}`);
    // 转发给语音路由器
    this.emit('udpTunnel', session_id, data);
    this.logger.info(`[MESSAGE-HANDLER] UDPTunnel event emitted for session ${session_id}`);
  }

  /**
   * 处理认证消息
   */
  private handleAuthenticate( session_id: number, data: Buffer): void {
    this.emit('authenticate', session_id, data);
  }

  /**
   * 处理 Ping 消息
   */
  private handlePing( session_id: number, data: Buffer): void {
    this.emit('ping', session_id, data);
  }

  /**
   * 处理拒绝消息
   */
  private handleReject( session_id: number, data: Buffer): void {
    this.emit('reject', session_id, data);
  }

  /**
   * 处理服务器同步消息
   */
  private handleServerSync( session_id: number, data: Buffer): void {
    this.emit('serverSync', session_id, data);
  }

  /**
   * 处理频道移除消息
   */
  private handleChannelRemove( session_id: number, data: Buffer): void {
    this.emit('channelRemove', session_id, data);
  }

  /**
   * 处理频道状态消息
   */
  private handleChannelState( session_id: number, data: Buffer): void {
    this.emit('channelState', session_id, data);
  }

  /**
   * 处理用户移除消息
   */
  private handleUserRemove( session_id: number, data: Buffer): void {
    this.emit('userRemove', session_id, data);
  }

  /**
   * 处理用户状态消息
   */
  private handleUserState( session_id: number, data: Buffer): void {
    this.emit('userState', session_id, data);
  }

  /**
   * 处理封禁列表消息
   */
  private handleBanList( session_id: number, data: Buffer): void {
    // 解析 BanList 消息
    try {
      const banList = mumbleproto.BanList.deserialize(data);

      // 根据 query 字段判断是查询还是更新
      // query=true 或 query 未设置且 bans 为空 → 查询
      // query=false 或有 bans 数据 → 更新（包括清空）
      const isQuery = banList.has_query ? banList.query : (!banList.bans || banList.bans.length === 0);
      
      if (isQuery) {
        // 查询封禁列表
        this.emit('banListQuery', session_id);
      } else {
        // 更新封禁列表（可以是空列表以清除所有封禁）
        this.emit('banListUpdate', session_id, banList.bans || []);
      }
    } catch (error) {
      this.logger.error('Failed to decode BanList message:', error);
    }
  }

  /**
   * 处理文本消息
   */
  private handleTextMessage( session_id: number, data: Buffer): void {
    this.emit('textMessage', session_id, data);
  }

  /**
   * 处理插件数据传输
   */
  private handlePluginDataTransmission(session_id: number, data: Buffer): void {
    this.emit('pluginDataTransmission', session_id, data);
  }

  /**
   * 处理权限拒绝消息
   */
  private handlePermissionDenied( session_id: number, data: Buffer): void {
    this.emit('permissionDenied', session_id, data);
  }

  /**
   * 处理 ACL 消息
   */
  private handleACL( session_id: number, data: Buffer): void {
    this.emit('acl', session_id, data);
  }

  /**
   * 处理查询用户消息
   */
  private handleQueryUsers( session_id: number, data: Buffer): void {
    this.emit('queryUsers', session_id, data);
  }

  /**
   * 处理加密设置消息
   */
  private handleCryptSetup( session_id: number, data: Buffer): void {
    this.emit('cryptSetup', session_id, data);
  }

  /**
   * 处理上下文动作修改消息
   */
  private handleContextActionModify( session_id: number, data: Buffer): void {
    this.emit('contextActionModify', session_id, data);
  }

  /**
   * 处理上下文动作消息
   */
  private handleContextAction( session_id: number, data: Buffer): void {
    this.emit('contextAction', session_id, data);
  }

  /**
   * 处理用户列表消息
   */
  private handleUserList( session_id: number, data: Buffer): void {
    this.emit('userList', session_id, data);
  }

  /**
   * 处理语音目标消息
   */
  private handleVoiceTarget( session_id: number, data: Buffer): void {
    this.emit('voiceTarget', session_id, data);
  }

  /**
   * 处理权限查询消息
   */
  private handlePermissionQuery( session_id: number, data: Buffer): void {
    this.emit('permissionQuery', session_id, data);
  }

  /**
   * 处理编解码器版本消息
   */
  private handleCodecVersion( session_id: number, data: Buffer): void {
    this.emit('codecVersion', session_id, data);
  }

  /**
   * 处理用户统计消息
   */
  private handleUserStats( session_id: number, data: Buffer): void {
    this.emit('userStats', session_id, data);
  }

  /**
   * 处理请求 Blob 消息
   */
  private handleRequestBlob( session_id: number, data: Buffer): void {
    this.emit('requestBlob', session_id, data);
  }

  /**
   * 处理服务器配置消息
   */
  private handleServerConfig( session_id: number, data: Buffer): void {
    this.emit('serverConfig', session_id, data);
  }

  /**
   * 处理建议配置消息
   */
  private handleSuggestConfig( session_id: number, data: Buffer): void {
    this.emit('suggestConfig', session_id, data);
  }

  /**
   * 发送消息给客户端
   */
  sendMessage( session_id: number, messageType: number, messageData: Buffer): void {
    this.emit('sendMessage', session_id, messageType, messageData);
  }

  /**
   * 广播消息
   */
  broadcastMessage(messageType: number, messageData: Buffer, excludeSession?: number): void {
    this.emit('broadcastMessage', messageType, messageData, excludeSession);
  }
}
