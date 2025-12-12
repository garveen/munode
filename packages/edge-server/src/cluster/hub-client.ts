import { EventEmitter } from 'events';
import { createHmac } from 'crypto';
import type { Logger } from 'winston';
import { ControlChannelClient, ControlChannelClientConfig, type ChannelNotificationParams } from '@munode/protocol';
import type {
  RPCParams,
  RPCResult,
  EdgeToHubMethods,
  VoiceTarget,
} from '@munode/protocol';
import type {
  ServerStats,
  ChannelData,
  ACLData,
} from '@munode/protocol';
import type { EdgeConfig } from '../types.js';

/**
 * Edge 控制通道客户端
 * 连接到 Hub 的控制服务，处理集群协调
 */
export class EdgeControlClient extends EventEmitter {
  private client: ControlChannelClient;
  private config: EdgeConfig;
  private logger: Logger;
  private connected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private registered = false;
  private isStopping = false; // 标记是否正在停止，避免重连

  private useExternalClient = false;

  constructor(config: EdgeConfig, logger: Logger, client?: ControlChannelClient) {
    super();
    this.config = config;
    this.logger = logger;

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
      this.logger.info(`Connecting to Hub control service at ${this.clientConfig.host}:${this.clientConfig.port}`);

      await this.client.connect();
      this.connected = true;

      // 注册到 Hub
      await this.register();

      // 启动心跳
      this.startHeartbeat();

      this.emit('connected');
    } catch (error) {
      // 只在非停止状态下重连
      if (!this.isStopping) {
        this.logger.error('Failed to connect to Hub control service:', error);
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.isStopping = true; // 设置停止标志，阻止重连
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
    
    // 移除所有事件监听器以防止内存泄漏
    this.client.removeAllListeners();
    this.removeAllListeners();
    
    this.emit('disconnected');
  }

  /**
   * 注册到 Hub
   * 实现 HMAC 挑战-响应认证
   */
  private async register(): Promise<void> {
    const registerParams: RPCParams<'edge.register'> = {
      server_id: this.config.server_id || 1,
      name: this.config.name,
      host: this.config.network.externalHost || this.config.network.host,
      port: this.config.network.externalPort ?? this.config.network.port,
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
      // 第一阶段：请求挑战码
      this.logger.debug('Requesting challenge from Hub...');
      const challengeResponse = await this.client.call('edge.register', registerParams);
      
      // 如果 Hub 返回了 challenge，进行第二阶段认证
      if (!challengeResponse.success && challengeResponse.challenge) {
        const challenge = challengeResponse.challenge;
        this.logger.debug('Received challenge, computing response...');
        
        // 计算 HMAC 签名
        const hmacSecret = this.config.hubServer?.hmacSecret;
        if (!hmacSecret) {
          throw new Error('HMAC secret not configured in Edge config');
        }
        
        const challengeResponseValue = this.computeHmac(challenge, this.config.server_id, hmacSecret);
        
        // 第二阶段：提交签名
        const authParams: RPCParams<'edge.register'> = {
          ...registerParams,
          challenge,
          challenge_response: challengeResponseValue,
        };
        
        this.logger.debug('Submitting challenge response...');
        const finalResponse = await this.client.call('edge.register', authParams);
        
        if (!finalResponse.success) {
          throw new Error(finalResponse.error || 'Registration failed after authentication');
        }
        
        this.registered = true;
        this.logger.debug(`Registered with Hub: ${JSON.stringify(finalResponse)}`);
        this.emit('registered', finalResponse);
      } else if (challengeResponse.success) {
        // Hub 未启用认证，直接注册成功
        this.registered = true;
        this.logger.info(`Registered with Hub (no auth): ${JSON.stringify(challengeResponse)}`);
        this.emit('registered', challengeResponse);
      } else {
        throw new Error(challengeResponse.error || 'Registration failed');
      }
    } catch (error) {
      this.logger.error('Registration failed:', error);
      throw error;
    }
  }

  /**
   * 计算 HMAC 签名
   */
  private computeHmac(challenge: string, serverId: number, secret: string): string {
    const message = `${challenge}:${serverId}`;
    const hmac = createHmac('sha256', secret);
    hmac.update(message);
    return hmac.digest('hex');
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

      const response = await this.client.call('edge.heartbeat', params);

      this.emit('heartbeat', response);
    } catch (error) {
      this.logger.error('Heartbeat failed:', error);
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
    // 如果正在停止，不要重连
    if (this.isStopping || this.reconnectTimer || !this.config.hubServer) {
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
      this.logger.info('Connected to Hub control service');
      this.connected = true;
      this.emit('connected');
    });

    this.client.on('disconnect', () => {
      this.logger.info('Disconnected from Hub control service');
      this.connected = false;
      this.registered = false;
      // 只在非停止状态下重连
      if (!this.isStopping) {
        this.scheduleReconnect();
      }
    });

    this.client.on('error', (error) => {
      this.logger.error('Control client error:', error);
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
        this.logger.warn('Unknown request method:', method);
        respond({ success: false, error: 'Unknown method' });
    }
  }  /**
   * 处理来自 Hub 的通知
   */
  private handleIncomingNotification(message: { method: string; params: unknown }): void {
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

        case 'hub.syncVoiceTarget':
          // VoiceTarget 同步通知
          this.emit('syncVoiceTarget', message.params);
          break;

        case 'hub.voiceRoutingConfig':
          // 语音路由配置通知
          this.emit('voiceRoutingConfig', message.params);
          break;

        case 'hub.routeTableUpdate':
          // 路由表更新通知
          this.emit('routeTableUpdate', message.params);
          break;

        default:
          this.logger.debug('Notification forwarded to upper layer:', message.method);
      }
    } catch (error) {
      this.logger.error('Error handling incoming notification:', error);
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
      const response = await this.client.call('edge.allocateSessionId', params);
      return response.session_id;
    } catch (error) {
      this.logger.error('Failed to allocate session ID:', error);
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
    version?: string;
    release?: string;
    os?: string;
    os_version?: string;
    // User state fields
    mute?: boolean;
    deaf?: boolean;
    suppress?: boolean;
    self_mute?: boolean;
    self_deaf?: boolean;
    priority_speaker?: boolean;
    recording?: boolean;
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
      this.logger.error('Failed to report session:', error);
    }
  }

  /**
   * 同步语音目标配置
   */
  async syncVoiceTarget(config: {
    client_session: number;
    target_id: number;
    config: VoiceTarget | null;
    timestamp: number;
  }): Promise<void> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      return;
    }

    try {
      const params: RPCParams<'edge.syncVoiceTarget'> = {
        edge_id: this.config.server_id,
        ...config,
      };
      await this.client.call('edge.syncVoiceTarget', params);
    } catch (error) {
      this.logger.error('Failed to sync voice target:', error);
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
      this.logger.error('Failed to route voice:', error);
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
      return await this.client.call('edge.fullSync', {});
    } catch (error) {
      this.logger.error('Failed to request full sync:', error);
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
      const response = await this.client.call('edge.getChannels', {});
      return response.channels || [];
    } catch (error) {
      this.logger.error('Failed to get channels:', error);
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
      const response = await this.client.call('edge.getACLs', params);
      return response.acls || [];
    } catch (error) {
      this.logger.error('Failed to get ACLs:', error);
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
      const response = await this.client.call('edge.saveChannel', params);
      return response.channel_id;
    } catch (error) {
      this.logger.error('Failed to save channel:', error);
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
      const response = await this.client.call('edge.saveACL', params);
      return response.aclIds;
    } catch (error) {
      this.logger.error('Failed to save ACL:', error);
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
      return await this.client.call('edge.adminOperation', params);
    } catch (error) {
      this.logger.error('Failed to execute admin operation:', error);
      throw error;
    }
  }

  /**
   * 报告到其他Edge的连接质量
   */
  async reportQuality(targetEdgeId: number, quality: {
    rtt: number;
    packetLoss: number;
    jitter: number;
    samples: number;
  }): Promise<RPCResult<'edge.reportQuality'>> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      throw new Error('Not connected to Hub');
    }

    try {
      const params: RPCParams<'edge.reportQuality'> = {
        edge_id: this.config.server_id,
        target_edge_id: targetEdgeId,
        quality,
      };

      const result = await this.client.call('edge.reportQuality', params);
      this.logger.debug(`Reported quality to Edge ${targetEdgeId}:`, quality);
      return result;
    } catch (error) {
      this.logger.error(`Failed to report quality to Edge ${targetEdgeId}:`, error);
      throw error;
    }
  }
  
  /**
   * 通知Hub与目标Edge的UDP连接失败
   */
  async notifyConnectionFailure(targetEdgeId: number): Promise<void> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      this.logger.warn('Cannot notify connection failure: not connected to Hub');
      return;
    }

    try {
      this.notify('edge.connectionFailure', {
        edge_id: this.config.server_id,
        target_edge_id: targetEdgeId,
        timestamp: Date.now(),
      });
      this.logger.info(`Notified Hub about connection failure with Edge ${targetEdgeId}`);
    } catch (error) {
      this.logger.error(`Failed to notify connection failure with Edge ${targetEdgeId}:`, error);
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
  notify(method: string, params?: unknown): void {
    if (!this.isConnected()) {
      this.logger.warn(`Cannot send notification ${method}: not connected to Hub`);
      return;
    }

    try {
      this.client.notify(method, params as ChannelNotificationParams);
    } catch (error) {
      this.logger.error(`Failed to send notification ${method}:`, error);
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
      this.logger.error(`Failed to call ${method}:`, error);
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
    return await this.client.call('blob.getUserTexture', { user_id });
  }

  /**
   * 获取用户评论
   */
  async getUserComment(user_id: number): Promise<RPCResult<'blob.getUserComment'>> {
    return await this.client.call('blob.getUserComment', { user_id });
  }

  /**
   * 设置用户纹理
   */
  async setUserTexture(user_id: number, data: Buffer): Promise<RPCResult<'blob.setUserTexture'>> {
    return await this.client.call('blob.setUserTexture', { user_id, data });
  }

  /**
   * 设置用户评论
   */
  async setUserComment(user_id: number, data: Buffer): Promise<RPCResult<'blob.setUserComment'>> {
    return await this.client.call('blob.setUserComment', { user_id, data });
  }

  // ============================================================================
  // Client Message Relay Methods
  // ============================================================================

  /**
   * 发送客户端消息中转到 Hub
   */
  async sendRelay(relay: unknown): Promise<void> {
    // TODO: 实现通过 WebSocket 发送 ClientMessageRelay
    // 当前暂时通过 RPC 模拟
    this.logger.debug(`Sending relay to Hub: session=${typeof relay === 'object' && relay !== null && 'session_id' in relay ? (relay as { session_id: unknown }).session_id : 'unknown'}`);
    this.emit('relay', relay);
  }

  /**
   * 批量发送客户端消息中转到 Hub
   */
  async sendRelayBatch(relays: unknown[]): Promise<void> {
    // TODO: 实现批量发送优化
    for (const relay of relays) {
      await this.sendRelay(relay);
    }
  }
}