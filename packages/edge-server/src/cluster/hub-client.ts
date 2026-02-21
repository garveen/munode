import { createHmac } from 'crypto';
import type { Logger } from 'winston';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import { 
  type ChannelNotificationParams, 
  RPCChannel,
  hubedgeRpc,
} from '@munode/protocol';
import { ControlChannelClient, type ControlChannelClientConfig } from '../control/control-client.js';
import type {
  RPCParams,
  RPCResult,
  EdgeToHubMethods,
  VoiceTarget,
  HubToEdgeNotifications,
} from '@munode/protocol';
import type {
  ServerStats,
  ChannelData,
  ACLData,
} from '@munode/protocol';
import type { EdgeConfig } from '../types.js';

/**
 * VoiceTarget 同步参数
 */
export interface SyncVoiceTargetParams {
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
}

/**
 * VoiceData 参数
 */
export interface VoiceDataParams {
  packetData: Buffer;
  targetEdgeId: number;
}

/**
 * VoiceRoutingConfig 参数
 */
export interface VoiceRoutingConfigParams {
  enabled: boolean;
  encryption?: {
    algorithm: string;
    key: string;
    version: number;
  };
}

/**
 * Hub 通知消息类型
 * 直接使用 protocol 包定义的类型，确保类型安全
 */
export type HubNotificationMessage = HubToEdgeNotifications;

/**
 * Extended registration response with additional runtime fields
 * Extends the protobuf type with edge-specific session management fields
 */
export type ExtendedRegisterResponse = RPCResult<'edge.register'> & {
  reconnected?: boolean;
  session_expired?: boolean;
  cold_restart?: boolean;
  need_cleanup?: boolean;
};

/**
 * Extended heartbeat response
 */
export type ExtendedHeartbeatResponse = RPCResult<'edge.heartbeat'>;

/**
 * EdgeControlClient 事件类型定义
 */
export interface EdgeControlClientEvents extends EventMap {
  'connected': [];
  'disconnected': [];
  'session-expired': [];
  'reconnected': [response: ExtendedRegisterResponse];
  'registered': [response: ExtendedRegisterResponse];
  'heartbeat': [response: ExtendedHeartbeatResponse];
  'heartbeatFailed': [error: Error];
  'error': [error: Error];
  'broadcast': [params: ChannelNotificationParams];
  'syncChannel': [params: { channelData: ChannelData }];
  'syncACL': [params: { channelId: number; acl: ACLData }];
  'deleteChannel': [params: { channelId: number }];
  'syncVoiceTarget': [params: SyncVoiceTargetParams];
  'notification': [message: HubNotificationMessage];
  'voiceData': [data: VoiceDataParams, respond: (response: { success: boolean }) => void];
  'voiceRoutingConfig': [config: VoiceRoutingConfigParams];
}

/**
 * Edge 控制通道客户端
 * 连接到 Hub 的控制服务，处理集群协调
 */
export class EdgeControlClient extends TypedEventEmitter<EdgeControlClientEvents> {
  private client: ControlChannelClient;
  private config: EdgeConfig;
  private logger: Logger;
  private connected = false;
  private reconnectTimer?: NodeJS.Timeout;
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
        host: config.hub_server?.host || 'localhost',
        port: config.hub_server?.control_port || 8443,
        // 默认启用 TLS，除非明确设置 rejectUnauthorized: false
        tls: config.hub_server?.tls?.reject_unauthorized ?? true,
        poolSize: config.hub_server?.pool_size ?? 2, // Default to 2 connections
        reconnectInterval: config.hub_server?.reconnect_interval || 5000,
        heartbeat: {
          interval: config.hub_server?.heartbeat_interval || 30000,
          sendHeartbeat: async (connectionId: number, channel: RPCChannel) => {
            await this.sendHeartbeatForConnection(connectionId, channel);
          },
        },
      };

      this.client = new ControlChannelClient(clientConfig, this.logger);
    }
    this.setupEventHandlers();
  }

  /**
   * 连接到 Hub 控制服务
   */
  async connect(): Promise<void> {
    if (!this.config.hub_server) {
      throw new Error('Hub server configuration is required');
    }

    // 防止重复连接或注册
    if (this.connected || this.registered) {
      this.logger.debug('Already connected or registered, skipping connect()');
      return;
    }

    // 重置停止标志，允许连接和重连
    this.isStopping = false;

    try {
      this.logger.info(`Connecting to Hub control service at ${this.clientConfig.host}:${this.clientConfig.port}`);

      await this.client.connect();
      
      // 注意：不要在这里设置 this.connected = true，让 'connect' 事件处理器来设置
      // 这样可以避免在连接池模式下多次触发

      // 注册到 Hub
      await this.register();

      // 注册成功后才发出 connected 事件
      // 这确保 connected 事件只在完整的连接+注册流程完成后触发一次
      if (!this.connected) {
        this.connected = true;
        this.emit('connected');
      }
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
   * 保留client对象以便复用
   */
  disconnect(): void {
    this.isStopping = true; // 设置停止标志，阻止重连
    this.connected = false;
    this.registered = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.client.disconnect();
    
    // 不移除事件监听器，保留用于重连
    // this.client.removeAllListeners();
    // this.removeAllListeners();
    
    this.emit('disconnected');
  }

  /**
   * 注册到 Hub
   * 实现 HMAC 挑战-响应认证
   */
  private async register(): Promise<void> {
    // 检查是否为冷重启：Edge 进程刚启动，没有任何客户端连接
    // 注意：第一次启动时也会标记为冷重启，这是正确的行为
    const isColdRestart = true; // Edge 进程启动/重启时，所有旧连接都已断开
    
    // 读取证书文件并计算hash
    // 优先使用 edge_cert（Edge 间连接专用证书），未配置时回退到 cert（服务器证书）
    let certHash = '';
    try {
      const certFile = this.config.tls?.edge_cert || this.config.tls?.cert;
      if (certFile) {
        const fs = await import('fs/promises');
        const crypto = await import('crypto');
        const certPem = await fs.readFile(certFile, 'utf8');
        // 计算SHA256指纹（DER格式）
        const certDer = certPem.replace(/-----BEGIN CERTIFICATE-----/, '')
          .replace(/-----END CERTIFICATE-----/, '')
          .replace(/\s/g, '');
        const certBuffer = Buffer.from(certDer, 'base64');
        const hash = crypto.createHash('sha256').update(certBuffer).digest('hex');
        certHash = hash.toLowerCase();
        this.logger.debug(`Computed certificate hash (${this.config.tls?.edge_cert ? 'edge_cert' : 'cert'}): ${certHash.substring(0, 16)}...`);
      }
    } catch (error) {
      this.logger.warn('Failed to read/compute certificate hash:', error);
    }
    
    const registerParams: RPCParams<'edge.register'> = {
      server_id: this.config.server_id || 1,
      name: this.config.name,
      host: this.config.network.external_host || this.config.network.host,
      port: this.config.network.external_port ?? this.config.network.port,
      region: this.config.network.region || '',
      capacity: this.config.server.capacity,
      certificate: certHash, // 发送证书hash而不是完整PEM
      cold_restart: isColdRestart, // 报告冷重启状态
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
        const hmacSecret = this.config.hub_server?.hmac_secret;
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
          // 检查是否是会话过期错误
          if ((finalResponse as { session_expired?: boolean }).session_expired) {
            this.logger.error('Hub rejected reconnection: session expired. Cold restart required.');
            this.emit('session-expired');
            throw new Error('Session expired - Hub requires cold restart');
          }
          throw new Error(finalResponse.error || 'Registration failed after authentication');
        }
        
        this.registered = true;
        
        // Check if this is a reconnection
        const extendedFinalResponse = finalResponse as ExtendedRegisterResponse;
        if (extendedFinalResponse.reconnected) {
          this.logger.info('Successfully reconnected to Hub, session restored');
          this.emit('reconnected', extendedFinalResponse);
        } else {
          this.logger.debug(`Registered with Hub: ${JSON.stringify(finalResponse)}`);
          this.emit('registered', extendedFinalResponse);
        }
      } else if (challengeResponse.success) {
        // Hub 未启用认证，直接注册成功
        this.registered = true;
        
        // Check if this is a reconnection
        const extendedChallengeResponse = challengeResponse as ExtendedRegisterResponse;
        if (extendedChallengeResponse.reconnected) {
          this.logger.info('Successfully reconnected to Hub (no auth), session restored');
          this.emit('reconnected', extendedChallengeResponse);
        } else {
          this.logger.info(`Registered with Hub (no auth): ${JSON.stringify(challengeResponse)}`);
          this.emit('registered', extendedChallengeResponse);
        }
      } else {
        // Check if session has expired
        const extendedChallengeResponse = challengeResponse as ExtendedRegisterResponse;
        if (extendedChallengeResponse.session_expired) {
          this.logger.error('Hub rejected reconnection: session expired. Cold restart required.');
          this.emit('session-expired');
          throw new Error('Session expired - Hub requires cold restart');
        }
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
   * 发送心跳（用于连接池中的特定连接）
   */
  private async sendHeartbeatForConnection(connectionId: number, channel: RPCChannel): Promise<void> {
    if (!this.connected || !this.registered) {
      throw new Error('Not connected or registered');
    }

    try {
      const stats = await this.getServerStats();

      this.logger?.debug('Sending heartbeat with stats:', {
        user_count: stats.user_count,
        channel_count: stats.channel_count,
        cpu_usage: stats.cpu_usage,
        memory_usage: stats.memory_usage,
        bandwidth: stats.bandwidth,
      });

      const request = hubedgeRpc.TypedRPCRequest.encode({
        request_id: '',
        method: 'edge.heartbeat',
        edge_heartbeat: {
        server_id: this.config.server_id,
        stats: stats ? {
          user_count: stats.user_count,
          channel_count: stats.channel_count,
          cpu_usage: stats.cpu_usage,
          memory_usage_mb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024)), // 转换为整数MB
          bandwidth_in: stats.bandwidth?.in || 0,
          bandwidth_out: stats.bandwidth?.out || 0,
        } : undefined,
        },
      }).finish();

      const response = await channel.call('edge.heartbeat', hubedgeRpc.TypedRPCRequest.decode(request));

      // Extract heartbeat response data
      if (response.edge_heartbeat) {
        const heartbeatResponse: ExtendedHeartbeatResponse = {
          success: response.edge_heartbeat.success || false,
          updated_edges: response.edge_heartbeat.updated_edges || [],
        };
        this.emit('heartbeat', heartbeatResponse);
      }
      this.logger?.debug(`Heartbeat sent successfully on connection ${connectionId}`);
    } catch (error) {
      this.logger.error(`Heartbeat failed on connection ${connectionId}:`, error);
      this.emit('heartbeatFailed', error);
      // 重新抛出错误，让 HeartbeatManager 检测到失败并触发超时处理
      throw error;
    }
  }

  /**
   * 调度重连
   */
  private scheduleReconnect(): void {
    // 如果正在停止，不要重连
    if (this.isStopping || this.reconnectTimer || !this.config.hub_server) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, this.config.hub_server.reconnect_interval || 5000);
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      // 注意：在使用连接池时，这个事件会被多次触发（每个连接一次）
      // 不要在这里触发 'connected' 事件或调用 register()
      // 实际的注册和 connected 事件触发在 connect() 方法中进行
      this.logger.debug('Underlying connection established');
    });

    this.client.on('disconnect', () => {
      this.logger.info('Disconnected from Hub control service');
      this.connected = false;
      this.registered = false;
      this.emit('disconnected');
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
        this.emit('broadcast', params as ChannelNotificationParams);
        respond({ success: true });
        break;
      }
      case 'hub.syncChannel': {
        this.emit('syncChannel', params as { channelData: ChannelData });
        respond({ success: true });
        break;
      }
      case 'hub.syncACL': {
        this.emit('syncACL', params as { channelId: number; acl: ACLData });
        respond({ success: true });
        break;
      }
      case 'hub.deleteChannel': {
        this.emit('deleteChannel', params as { channelId: number });
        respond({ success: true });
        break;
      }
      // NOTE: hub.routeVoice removed - voice packets flow edge-to-edge directly via UDP
      case 'hub.syncVoiceTarget': {
        this.emit('syncVoiceTarget', params as SyncVoiceTargetParams);
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
      this.emit('notification', message as HubNotificationMessage);
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
   * 同步语音目标配置
   */
  async syncVoiceTarget(config: {
    client_session: number;
    target_id: number;
    config: VoiceTarget | null;
  }): Promise<void> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      return;
    }

    try {
      const params: RPCParams<'edge.syncVoiceTarget'> = {
        edge_id: this.config.server_id,
        client_session: config.client_session,
        target_id: config.target_id,
        config: config.config || { id: 0, targets: [] },
      };
      await this.client.call('edge.syncVoiceTarget', params);
    } catch (error) {
      this.logger.error('Failed to sync voice target:', error);
    }
  }

  /**
   * 通过 Hub TCP 中转发送语音包（降级模式）
   * 当 UDP 直连和中转都不可用时使用
   */
  async relayVoiceViaTcp(targetEdgeId: number, voicePacket: Buffer): Promise<boolean> {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      this.logger.warn('Cannot relay voice via TCP: not connected to Hub');
      return false;
    }

    try {
      const params: RPCParams<'edge.relayVoiceViaTcp'> = {
        from_edge_id: this.config.server_id,
        target_edge_id: targetEdgeId,
        voice_packet: voicePacket,
        timestamp: Date.now(),
      };
      
      const result = await this.client.call('edge.relayVoiceViaTcp', params);
      return result.success;
    } catch (error) {
      this.logger.error(`Failed to relay voice via TCP to Edge ${targetEdgeId}:`, error);
      return false;
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
      return await this.client.call('edge.fullSync', {
        for_user_groups: [], // ts-proto requires array fields to be initialized
      });
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
      // Protobuf toObject() types have optional fields, but business logic ensures required fields are present
      // Cast to ChannelData[] as the response is guaranteed to have all required fields from the server
      return (response.channels || []) as ChannelData[];
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
      // Protobuf toObject() types have optional fields, but business logic ensures required fields are present
      // Cast to ACLData[] as the response is guaranteed to have all required fields from the server
      return (response.acls || []) as ACLData[];
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
      return response.acl_ids;
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
  notifyConnectionFailure(targetEdgeId: number): void {
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
      this.logger.error(`Failed to notify Hub about connection failure with Edge ${targetEdgeId}:`, error);
    }
  }
  
  /**
   * 通知Hub重连失败（双向都失败时需要Hub仲裁）
   */
  notifyReconnectFailure(targetEdgeId: number): void {
    if (!this.isConnected() || (!this.useExternalClient && !this.registered)) {
      this.logger.warn('Cannot notify reconnect failure: not connected to Hub');
      return;
    }

    try {
      this.notify('edge.reconnectFailure', {
        edge_id: this.config.server_id,
        target_edge_id: targetEdgeId,
        timestamp: Date.now(),
      });
      this.logger.info(`Notified Hub about reconnect failure with Edge ${targetEdgeId}, awaiting arbitration`);
    } catch (error) {
      this.logger.error(`Failed to notify Hub about reconnect failure with Edge ${targetEdgeId}:`, error);
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
      hubHost: this.config.hub_server?.host,
      hubPort: this.config.hub_server?.control_port,
    };
  }

  /**
   * 获取客户端配置
   */
  private get clientConfig(): ControlChannelClientConfig {
    return {
      host: this.config.hub_server?.host || 'localhost',
      port: this.config.hub_server?.control_port || 8443,
      tls: this.config.hub_server?.tls ? true : false,
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
  sendRelay(relay: unknown): void {
    // TODO: 实现通过 WebSocket 发送 ClientMessageRelay
    // 当前暂时通过 RPC 模拟
    this.logger.debug(`Sending relay to Hub: session=${typeof relay === 'object' && relay !== null && 'session_id' in relay ? (relay as { session_id: unknown }).session_id : 'unknown'}`);
    this.emit('relay', relay);
  }

  /**
   * 批量发送客户端消息中转到 Hub
   */
  sendRelayBatch(relays: unknown[]): void {
    // TODO: 实现批量发送优化
    for (const relay of relays) {
      this.sendRelay(relay);
    }
  }
}