import { EventEmitter } from 'events';
import { createLogger } from '@munode/common';
import { ControlChannelClient, ControlChannelClientConfig } from '@munode/protocol';
import type {
  RPCParams,
  RPCResult,
  EdgeToHubMethods,
} from '@munode/protocol/src/rpc/rpc-types.js';
import type {
  ServerStats,
  ChannelData,
  ACLData,
} from '@munode/protocol/src/hub-edge-types.js';
import type { EdgeConfig } from '../types.js';

const logger = createLogger({ service: 'edge-control-client' });

/**
 * Edge 控制通道客户端
 * 连接到 Hub 的控制服务，处理集群协调
 */
export class EdgeControlClient extends EventEmitter {
  private client: ControlChannelClient;
  private config: EdgeConfig;
  private connected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private registered = false;

  private useExternalClient = false;

  constructor(config: EdgeConfig, client?: ControlChannelClient) {
    super();
    this.config = config;

    if (client) {
      this.client = client;
      this.useExternalClient = true;
    } else {
      const clientConfig: ControlChannelClientConfig = {
        host: config.hubServer?.host || 'localhost',
        port: config.hubServer?.controlPort || 8443,
        tls: config.hubServer?.tls ? true : false,
      };

      this.client = new ControlChannelClient(clientConfig);
    }
    this.setupEventHandlers();
  }

  /**
   * 连接到 Hub 控制服务
   */
  async connect(): Promise<void> {
    if (!this.config.hubServer) {
      throw new Error('Hub server configuration is required');
    }

    try {
      logger.info(`Connecting to Hub control service at ${this.clientConfig.host}:${this.clientConfig.port}`);

      await this.client.connect();
      this.connected = true;

      // 注册到 Hub
      await this.register();

      // 启动心跳
      this.startHeartbeat();

      this.emit('connected');
    } catch (error) {
      logger.error('Failed to connect to Hub control service:', error);
      this.scheduleReconnect();
      throw error;
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.connected = false;
    this.registered = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.client.disconnect();
    this.emit('disconnected');
  }

  /**
   * 注册到 Hub
   */
  private async register(): Promise<void> {
    const registerParams: RPCParams<'edge.register'> = {
      server_id: this.config.server_id || 1,
      name: this.config.name,
      host: this.config.network.externalHost || this.config.network.host,
      port: this.config.network.port,
      region: this.config.network.region || '',
      capacity: this.config.capacity,
      certificate: '', // TODO: 获取证书
      metadata: {
        version: '1.0.0',
        features: Object.keys(this.config.features)
          .filter((key) => this.config.features[key as keyof typeof this.config.features])
          .join(','),
      },
    };

    try {
      const response = await this.client.call('edge.register', registerParams) as RPCResult<'edge.register'>;
      this.registered = true;
      logger.info(`Registered with Hub: ${JSON.stringify(response)}`);
      this.emit('registered', response);
    } catch (error) {
      logger.error('Registration failed:', error);
      throw error;
    }
  }

  /**
   * 发送心跳
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.connected || !this.registered) {
      return;
    }

    try {
      const stats = await this.getServerStats();

      const params: RPCParams<'edge.heartbeat'> = {
        server_id: this.config.server_id,
        stats,
      };

      const response = await this.client.call('edge.heartbeat', params) as RPCResult<'edge.heartbeat'>;

      this.emit('heartbeat', response);
    } catch (error) {
      logger.error('Heartbeat failed:', error);
      this.emit('heartbeatFailed', error);
    }
  }

  /**
   * 启动心跳定时器
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    if (!this.config.hubServer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, this.config.hubServer.heartbeatInterval || 30000);
  }

  /**
   * 调度重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.config.hubServer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, this.config.hubServer.reconnectInterval || 5000);
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.info('Connected to Hub control service');
      this.connected = true;
      this.emit('connected');
    });

    this.client.on('disconnect', () => {
      logger.info('Disconnected from Hub control service');
      this.connected = false;
      this.registered = false;
      this.scheduleReconnect();
    });

    this.client.on('error', (error) => {
      logger.error('Control client error:', error);
      this.emit('error', error);
    });

    this.client.on('request', (message, respond) => {
      // 处理来自 Hub 的请求
      this.handleIncomingRequest(message, respond);
    });

    this.client.on('notification', (message) => {
      // 处理来自 Hub 的通知
      this.handleIncomingNotification(message);
    });
  }

  /**
   * 处理来自Hub的请求
   * TODO: 在 protocol 中定义 Hub->Edge 通知类型后，使用强类型
   */
  private handleIncomingRequest(
    request: { method: string; params: unknown },
    respond: (result: unknown) => void
  ): void {
    const { method, params } = request;

    switch (method) {
      case 'hub.broadcast': {
        this.emit('broadcast', params);
        respond({ success: true });
        break;
      }
      case 'hub.syncChannel': {
        this.emit('syncChannel', params);
        respond({ success: true });
        break;
      }
      case 'hub.syncACL': {
        this.emit('syncACL', params);
        respond({ success: true });
        break;
      }
      case 'hub.deleteChannel': {
        this.emit('deleteChannel', params);
        respond({ success: true });
        break;
      }
      case 'hub.routeVoice': {
        this.emit('routeVoice', params);
        respond({ success: true });
        break;
      }
      case 'hub.syncVoiceTarget': {
        this.emit('syncVoiceTarget', params);
        respond({ success: true });
        break;
      }
      default:
        logger.warn('Unknown request method:', method);
        respond({ success: false, error: 'Unknown method' });
    }
  }  /**
   * 处理来自 Hub 的通知
   */
  private handleIncomingNotification(message: any): void {
    try {
      // 首先触发通用的notification事件，供上层直接处理
      this.emit('notification', message);

      // 然后根据特定方法触发特定事件（向后兼容）
      switch (message.method) {
        case 'hub.edgeJoined':
          this.emit('edgeJoined', message.params);
          break;

        case 'hub.edgeLeft':
          this.emit('edgeLeft', message.params);
          break;

        case 'hub.sessionUpdate':
          this.emit('sessionUpdate', message.params);
          break;

        case 'hub.voiceTargetUpdate':
          this.emit('voiceTargetUpdate', message.params);
          break;

        default:
          logger.debug('Notification forwarded to upper layer:', message.method);
      }
    } catch (error) {
      logger.error('Error handling incoming notification:', error);
    }
  }

  /**
   * 上报用户会话
   */
  /**
   * 从 Hub 分配新的 session ID
   */
  async allocateSessionId(): Promise<number> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      throw new Error('Not connected to Hub');
    }

    try {
      const params: RPCParams<'edge.allocateSessionId'> = {
        edge_id: this.config.server_id,
      };
      const response = await this.client.call('edge.allocateSessionId', params) as RPCResult<'edge.allocateSessionId'>;
      return response.session_id;
    } catch (error) {
      logger.error('Failed to allocate session ID:', error);
      throw error;
    }
  }

  /**
   * 上报会话信息到 Hub
   */
  async reportSession(session: {
    session_id: number;
    user_id: number;
    username: string;
    channel_id?: number;
    startTime: Date;
    ip_address: string;
    groups?: string[];
    cert_hash?: string;
  }): Promise<void> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      return;
    }

    try {
      const params: RPCParams<'edge.reportSession'> = {
        ...session,
        edge_server_id: this.config.server_id,
      };
      await this.client.call('edge.reportSession', params);
    } catch (error) {
      logger.error('Failed to report session:', error);
    }
  }

  /**
   * 同步语音目标配置
   */
  async syncVoiceTarget(config: {
    target_id: number;
    config: any; // VoiceTarget | null
    timestamp: number;
  }): Promise<void> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      return;
    }

    try {
      const params: RPCParams<'edge.syncVoiceTarget'> = {
        edge_id: this.config.server_id,
        client_session: 0, // TODO: 获取当前会话ID
        ...config,
      };
      await this.client.call('edge.syncVoiceTarget', params);
    } catch (error) {
      logger.error('Failed to sync voice target:', error);
    }
  }

  /**
   * 路由语音数据
   */
  async routeVoice(voiceData: {
    fromSessionId: number;
    target_id: number;
    voiceData: Buffer;
    timestamp: number;
  }): Promise<void> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      return;
    }

    try {
      const params: RPCParams<'edge.routeVoice'> = {
        fromEdgeId: this.config.server_id,
        ...voiceData,
      };
      await this.client.call('edge.routeVoice', params);
    } catch (error) {
      logger.error('Failed to route voice:', error);
    }
  }

  /**
   * 请求完整同步
   */
  async requestFullSync(): Promise<RPCResult<'edge.fullSync'>> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      throw new Error('Not connected to Hub');
    }

    try {
      return await this.client.call('edge.fullSync', {}) as RPCResult<'edge.fullSync'>;
    } catch (error) {
      logger.error('Failed to request full sync:', error);
      throw error;
    }
  }

  /**
   * 获取频道列表
   */
  async getChannels(): Promise<ChannelData[]> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      throw new Error('Not connected to Hub');
    }

    try {
      const response = await this.client.call('edge.getChannels', {}) as RPCResult<'edge.getChannels'>;
      return response.channels || [];
    } catch (error) {
      logger.error('Failed to get channels:', error);
      throw error;
    }
  }

  /**
   * 获取ACL列表
   */
  async getACLs(channel_id: number): Promise<ACLData[]> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      throw new Error('Not connected to Hub');
    }

    try {
      const params: RPCParams<'edge.getACLs'> = { channel_id };
      const response = await this.client.call('edge.getACLs', params) as RPCResult<'edge.getACLs'>;
      return response.acls || [];
    } catch (error) {
      logger.error('Failed to get ACLs:', error);
      throw error;
    }
  }

  /**
   * 保存频道
   */
  async saveChannel(channel: RPCParams<'edge.saveChannel'>['channel']): Promise<number> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      throw new Error('Not connected to Hub');
    }

    try {
      const params: RPCParams<'edge.saveChannel'> = { channel };
      const response = await this.client.call('edge.saveChannel', params) as RPCResult<'edge.saveChannel'>;
      return response.channel_id;
    } catch (error) {
      logger.error('Failed to save channel:', error);
      throw error;
    }
  }

  /**
   * 保存ACL
   */
  async saveACL(channelId: number, acls: ACLData[]): Promise<number[]> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      throw new Error('Not connected to Hub');
    }

    try {
      const params: RPCParams<'edge.saveACL'> = {
        channel_id: channelId,
        acls: acls.map(acl => ({
          id: acl.id,
          user_id: acl.user_id,
          group: acl.group,
          apply_here: acl.apply_here,
          apply_subs: acl.apply_subs,
          allow: acl.allow,
          deny: acl.deny,
        })),
      };
      const response = await this.client.call('edge.saveACL', params) as RPCResult<'edge.saveACL'>;
      return response.aclIds;
    } catch (error) {
      logger.error('Failed to save ACL:', error);
      throw error;
    }
  }

  /**
   * 执行管理操作
   */
  async adminOperation(operation: string, data?: unknown): Promise<RPCResult<'edge.adminOperation'>> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      throw new Error('Not connected to Hub');
    }

    try {
      const params: RPCParams<'edge.adminOperation'> = { operation, data };
      return await this.client.call('edge.adminOperation', params) as RPCResult<'edge.adminOperation'>;
    } catch (error) {
      logger.error('Failed to execute admin operation:', error);
      throw error;
    }
  }

  /**
   * 获取服务器统计信息
   */
  private async getServerStats(): Promise<ServerStats> {
    return new Promise((resolve) => {
      this.emit('getStats', (stats: ServerStats) => {
        resolve(stats);
      });
    });
  }

  /**
   * 发送通知到Hub（不等待响应）
   */
  notify(method: string, params?: any): void {
    if (!this.isConnected()) {
      logger.warn(`Cannot send notification ${method}: not connected to Hub`);
      return;
    }

    try {
      this.client.notify(method, params);
    } catch (error) {
      logger.error(`Failed to send notification ${method}:`, error);
    }
  }

  /**
   * 发送 RPC 调用到 Hub（等待响应）
   */
  async call<M extends EdgeToHubMethods['method']>(
    method: M, 
    params?: RPCParams<M>
  ): Promise<RPCResult<M>> {
    if (!this.isConnected()) {
      throw new Error(`Cannot call ${method}: not connected to Hub`);
    }

    try {
      return await this.client.call(method, params);
    } catch (error) {
      logger.error(`Failed to call ${method}:`, error);
      throw error;
    }
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.client.isConnected();
  }

  /**
   * 是否已注册
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(): {
    connected: boolean;
    registered: boolean;
    hubHost?: string;
    hubPort?: number;
  } {
    return {
      connected: this.isConnected(),
      registered: this.registered,
      hubHost: this.config.hubServer?.host,
      hubPort: this.config.hubServer?.controlPort,
    };
  }

  /**
   * 获取客户端配置
   */
  private get clientConfig(): ControlChannelClientConfig {
    return {
      host: this.config.hubServer?.host || 'localhost',
      port: this.config.hubServer?.controlPort || 8443,
      tls: this.config.hubServer?.tls ? true : false,
    };
  }

  // ============================================================================
  // Blob Storage Methods
  // ============================================================================

  /**
   * 获取用户纹理
   */
  async getUserTexture(user_id: number): Promise<RPCResult<'blob.getUserTexture'>> {
    return await this.client.call('blob.getUserTexture', { user_id }) as RPCResult<'blob.getUserTexture'>;
  }

  /**
   * 获取用户评论
   */
  async getUserComment(user_id: number): Promise<RPCResult<'blob.getUserComment'>> {
    return await this.client.call('blob.getUserComment', { user_id }) as RPCResult<'blob.getUserComment'>;
  }

  /**
   * 设置用户纹理
   */
  async setUserTexture(user_id: number, data: Buffer): Promise<RPCResult<'blob.setUserTexture'>> {
    return await this.client.call('blob.setUserTexture', { user_id, data }) as RPCResult<'blob.setUserTexture'>;
  }

  /**
   * 设置用户评论
   */
  async setUserComment(user_id: number, data: Buffer): Promise<RPCResult<'blob.setUserComment'>> {
    return await this.client.call('blob.setUserComment', { user_id, data }) as RPCResult<'blob.setUserComment'>;
  }
}