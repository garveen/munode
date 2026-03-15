import type { Logger } from '@munode/common';
import {
  RPCChannel,
  Message,
  TypedRPCServer,
  createTypedRPCServer,
  RPCParams,
  RPCResult,
  EdgeNotificationParams,
  DEFAULT_ROUTING_POLICY,
  DEFAULT_HUB_RELAY_CONFIG,
  hubedgeRpc,
  EdgeToHubMethods,
  ChannelNotificationParams,
} from '@munode/protocol';
import { ControlChannelServer, type ControlChannelConfig } from './control/control-server.js';
import { type VirtualEdgeChannel } from './control/hub-pool.js';
import type { HubConfig } from './types.js';
import type { ServiceRegistry } from './registry.js';
import { NetworkTopologyManager } from './network-topology-manager.js';
import type { RouteEntry } from '@munode/protocol';
import { VoiceEncryptionManager } from './voice-encryption-manager.js';
import { HubHandlerFactory as HubFactory } from './factory.js';
import { type IUserStateHandler } from './handlers/user-state-handler.js';
import { type IChannelStateHandler } from './handlers/channel-state-handler.js';
import { type ITextMessageHandler } from './handlers/text-message-handler.js';

// Import new handlers
import { type INotificationHandler } from './handlers/notification-handler.js';
import { type IAdminOperationHandler } from './handlers/admin-operation-handler.js';
import { type ICertificateExchangeHandler } from './handlers/certificate-exchange-handler.js';
import { type ISyncHandler } from './handlers/sync-handler.js';
import { type IACLHandler } from './handlers/acl-handler.js';
import { type IChannelHandler } from './handlers/channel-handler.js';
import { type IClusterHandler } from './handlers/cluster-handler.js';
import { type IBlobHandler } from './handlers/blob-handler.js';

// Import TypedRPCResponse type
type TypedRPCResponse = hubedgeRpc.TypedRPCResponse;

/**
 * Hub Server 控制信道服务
 * 基于 MessagePack + WebSocket 的 RPC 服务
 */
export class HubControlService {
  private server: ControlChannelServer;
  private typedServer: TypedRPCServer;
  private config: HubConfig;
  private _registry: ServiceRegistry;
  private _ninjaChannels: Set<number>; // Set of channel IDs that are ninja channels
  private _networkTopologyManager: NetworkTopologyManager; // 网络拓扑管理器
  private _voiceEncryptionManager: VoiceEncryptionManager; // 语音加密管理器
  private isStopping = false; // 标记服务是否正在停止
  private logger: Logger;

  // 处理器实例 - 通过工厂获取
  private userStateHandler: IUserStateHandler;
  private channelStateHandler: IChannelStateHandler;
  private textMessageHandler: ITextMessageHandler;
  private notificationHandler: INotificationHandler;
  private adminOperationHandler: IAdminOperationHandler;
  private certificateExchangeHandler: ICertificateExchangeHandler;
  private syncHandler: ISyncHandler;
  private aclHandler: IACLHandler;
  private channelHandler: IChannelHandler;
  private clusterHandler: IClusterHandler;
  private blobHandler: IBlobHandler;
  private factory: HubFactory;

  constructor(
    config: HubConfig,
    logger: Logger,
  ) {
    this.config = config;
    this.logger = logger;
  }
  async initialize(factory: HubFactory): Promise<void> {
    this.factory = factory;

    const config = this.config;

    // 初始化处理器工厂


    // Initialize ninja channels set from config
    this.logger.info(`Channel Ninja config: channel_ninja=${config.channel_ninja}, ninja_channels=${JSON.stringify(config.ninja_channels)}`);
    this._ninjaChannels = new Set(config.ninja_channels || []);
    if (this._ninjaChannels.size > 0) {
      this.logger.info(`Channel Ninja enabled with ${this._ninjaChannels.size} ninja channels: [${Array.from(this._ninjaChannels).join(', ')}]`);
    }

    // 从 factory 获取网络拓扑管理器和语音加密管理器
    this._networkTopologyManager = factory.getNetworkTopologyManager();
    this._voiceEncryptionManager = factory.getVoiceEncryptionManager();
    this.setupNetworkTopologyEvents();

    const controlConfig: ControlChannelConfig = {
      port: config.control_port || 8443,
      host: config.host,
    };

    this.server = new ControlChannelServer(controlConfig, this.logger);

    this._registry = this.factory.getRegistry();

    // 获取用户状态处理器
    this.userStateHandler = this.factory.getUserStateHandler();

    // 获取频道状态处理器
    this.channelStateHandler = this.factory.getChannelStateHandler();

    // 获取文本消息处理器
    this.textMessageHandler = this.factory.getTextMessageHandler();

    // 获取通知处理器
    this.notificationHandler = this.factory.getNotificationHandler();

    // 获取管理操作处理器
    this.adminOperationHandler = this.factory.getAdminOperationHandler();

    // 获取证书交换处理器
    this.certificateExchangeHandler = this.factory.getCertificateExchangeHandler();

    // 获取同步处理器
    this.syncHandler = this.factory.getSyncHandler();

    // 获取ACL处理器
    this.aclHandler = this.factory.getACLHandler();

    // 获取频道处理器
    this.channelHandler = this.factory.getChannelHandler();

    // 获取集群处理器
    this.clusterHandler = this.factory.getClusterHandler();

    // 获取Blob处理器
    this.blobHandler = this.factory.getBlobHandler();

    this.typedServer = createTypedRPCServer();
    this.setupEventHandlers();
    this.registerHandlers();
  }
  
  /**
   * 设置网络拓扑管理器事件处理
   */
  private setupNetworkTopologyEvents(): void {
    // 监听路由表更新事件，推送到对应的 Edge
    this._networkTopologyManager.on('routeTableUpdated', (edgeId: number, routes: RouteEntry[]) => {
      this.pushRouteTable(edgeId, routes);
    });
  }
  
  /**
   * 推送路由表到指定 Edge
   */
  private pushRouteTable(edgeId: number, routes: RouteEntry[]): void {
    if (!this.config.voice_routing?.enabled) {
      return;
    }
    
    this.logger.info(`Pushing route table to Edge ${edgeId}:`, {
      routeCount: routes.length,
      routes: routes.map(r => ({
        target: r.targetEdgeId,
        type: r.type,
        nextHop: r.nextHop,
      })),
    });
    
    this.notify(edgeId, 'hub.routeTableUpdate', { 
      routes: routes.map(r => ({
        targetEdgeId: r.targetEdgeId,
        type: r.type,
        nextHop: r.nextHop,
        cost: r.cost,
        timestamp: r.timestamp,
        source: r.source,
        ttl: r.ttl,
      }))
    });
  }
  
  /**
   * 获取网络拓扑管理器
   */
  getNetworkTopologyManager(): NetworkTopologyManager {
    return this._networkTopologyManager;
  }

  private setupEventHandlers(): void {
    // 监听 Edge 连接（使用连接池事件）
    this.server.on('edgeConnected', (edgeId: number, _virtualChannel: VirtualEdgeChannel) => {
      this.logger.info(`Edge ${edgeId} connected to control channel`);
    });

    // 监听 Edge 断开（使用连接池事件）
    this.server.on('edgeDisconnected', (edgeId: number) => {
      this.logger.info(`Edge ${edgeId} disconnected from control channel`);
      
      // 使用延迟清理机制，而不是立即清理会话
      // Edge在宽限期内重连则恢复会话，超时后才清理
      this._registry.handleEdgeDisconnect(edgeId, (cleanupEdgeId) => {
        // 超时后的清理回调
        this.logger.warn(`Cleaning up sessions for Edge ${cleanupEdgeId} after reconnection timeout`);
        this.cleanupEdgeSessions(cleanupEdgeId);
      });
    });

    // 保留旧的 connect 事件用于未注册的连接
    this.server.on('connect', (_channel: RPCChannel) => {
      this.logger.debug('New connection to control channel (not yet registered)');
    });

    // Handle requests
    this.server.on('request', (channel: RPCChannel, message: Message, respond: (result?: TypedRPCResponse, error?: { code: number; message: string }) => void) => {
      // 如果服务正在停止，拒绝所有新请求
      if (this.isStopping) {
        respond(undefined, { code: -32000, message: 'Hub server is shutting down' });
        return;
      }
      
      if (message.params) {
        void this.typedServer.handleRequest(channel, message.params, respond);
      } else {
        respond({ request_id: message.id || '0' }, { code: -32600, message: `Invalid request: missing params: method: ${message.method || ""}` });
      }
    });

    // 监听通知（notification不需要响应）
    this.server.on('notification', (channel: RPCChannel, message: Message) => {
      this.handleNotification(channel, message);
    });
  }

  /**
   * 处理来自Edge的通知消息
   */
  private handleNotification(_channel: RPCChannel, message: Message): void {
    const { method, params } = message;
    // Cast params to unknown first to avoid TypeScript error, then to the proper type
    const typedParams = params as unknown;

    switch (method) {
      case 'hub.handleUserState':
        void this.userStateHandler.handleUserStateNotification(typedParams as EdgeNotificationParams<'edge.userStateNotification'>);
        break;
      
      case 'hub.handleChannelState':
        void this.channelStateHandler.handleChannelStateNotification(typedParams as EdgeNotificationParams<'edge.channelStateNotification'>);
        break;
      
      case 'hub.handleUserRemove':
        void this.notificationHandler.handleUserRemoveNotification(typedParams as EdgeNotificationParams<'edge.userRemoveNotification'>);
        break;
      
      case 'hub.handleChannelRemove':
        void this.channelStateHandler.handleChannelRemoveNotification(typedParams as EdgeNotificationParams<'edge.channelRemoveNotification'>);
        break;
      
      case 'hub.handleUserLeft':
        void this.userStateHandler.handleUserLeftNotification(typedParams as EdgeNotificationParams<'edge.userLeftNotification'>);
        break;

      case 'hub.handleTextMessage':
        void this.textMessageHandler.handleTextMessageNotification(typedParams as EdgeNotificationParams<'edge.textMessageNotification'>);
        break;

      case 'hub.handlePluginDataTransmission':
        void this.notificationHandler.handlePluginDataTransmissionNotification(typedParams as EdgeNotificationParams<'edge.pluginDataTransmissionNotification'>);
        break;

      case 'hub.handleUserStats':
        void this.notificationHandler.handleUserStatsNotification(typedParams as EdgeNotificationParams<'edge.userStatsNotification'>);
        break;

      case 'edge.connectionFailure':
        void this.notificationHandler.handleConnectionFailureNotification(typedParams as { edge_id: number; target_edge_id: number; timestamp: number });
        break;

      case 'edge.reconnectFailure':
        void this.notificationHandler.handleReconnectFailureNotification(typedParams as { edge_id: number; target_edge_id: number; timestamp: number });
        break;

      default:
        this.logger.debug(`Unknown notification method: ${method}`);
    }
  }

  private registerHandlers(): void {
    // 使用批量注册方式注册所有处理器（列表+循环模式）
    const handlers = [
      // Edge 核心操作
      { method: 'edge.register', handler: (channel: RPCChannel, params: RPCParams<EdgeToHubMethods['method']>) => this.handleEdgeRegister(channel, params as RPCParams<'edge.register'>) },
      { method: 'edge.heartbeat', handler: async (_channel, params) => await this._registry.heartbeat(params as RPCParams<'edge.heartbeat'>) },
      { method: 'edge.allocateSessionId', handler: async (_channel, params) => await this.factory.getAuthenticationHandler().handleAllocateSessionId(params as RPCParams<'edge.allocateSessionId'>) },
      { method: 'edge.authenticateUser', handler: async (_channel, params) => await this.factory.getAuthenticationHandler().handleAuthenticateUser(params as RPCParams<'edge.authenticateUser'>) },
      
      // VoiceTarget 同步
      { method: 'edge.syncVoiceTarget', handler: async (_channel, params) => await this.factory.getVoiceRoutingHandler().handleSyncVoiceTarget(params as RPCParams<'edge.syncVoiceTarget'>) },
      { method: 'edge.getVoiceTargets', handler: async (_channel, params) => await this.factory.getVoiceRoutingHandler().handleGetVoiceTargets(params as RPCParams<'edge.getVoiceTargets'>) },
      { method: 'edge.relayVoiceViaTcp', handler: async (_channel, params) => await this.factory.getVoiceRoutingHandler().handleRelayVoiceViaTcp(params as RPCParams<'edge.relayVoiceViaTcp'>) },
      
      // 管理操作
      { method: 'edge.adminOperation', handler: async (_channel, params) => await this.adminOperationHandler.handleAdminOperation(params as RPCParams<'edge.adminOperation'>) },
      { method: 'edge.exchangeCertificates', handler: async (_channel, params) => await this.certificateExchangeHandler.handleExchangeCertificates(params as RPCParams<'edge.exchangeCertificates'>) },
      
      // 同步操作
      { method: 'edge.fullSync', handler: async (_channel, params) => await this.syncHandler.handleFullSync(params as RPCParams<'edge.fullSync'>) },
      { method: 'edge.getChannels', handler: async (_channel, params) => await this.syncHandler.handleGetChannels(params as RPCParams<'edge.getChannels'>) },
      { method: 'edge.getACLs', handler: async (_channel, params) => await this.syncHandler.handleGetACLs(params as RPCParams<'edge.getACLs'>) },
      { method: 'edge.saveChannel', handler: async (_channel, params) => await this.channelHandler.handleSaveChannel(params as RPCParams<'edge.saveChannel'>) },
      { method: 'edge.saveACL', handler: async (_channel, params) => await this.aclHandler.handleSaveACL(params as RPCParams<'edge.saveACL'>) },
      
      // ACL 和权限
      { method: 'edge.handleACL', handler: async (_channel, params) => await this.aclHandler.handleACLRequest(params as RPCParams<'edge.handleACL'>) },
      { method: 'edge.handlePermissionQuery', handler: async (_channel, params) => await this.aclHandler.handlePermissionQueryRequest(params as RPCParams<'edge.handlePermissionQuery'>) },
      
      // 集群操作
      { method: 'edge.join', handler: async (_channel, params) => await this.clusterHandler.handleEdgeJoin(params as RPCParams<'edge.join'>) },
      { method: 'edge.joinComplete', handler: async (_channel, params) => await this.clusterHandler.handleEdgeJoinComplete(params as RPCParams<'edge.joinComplete'>) },
      { method: 'edge.reportPeerDisconnect', handler: async (_channel, params) => await this.clusterHandler.handleEdgeReportPeerDisconnect(params as RPCParams<'edge.reportPeerDisconnect'>) },
      { method: 'edge.reportQuality', handler: async (_channel, params) => await this.clusterHandler.handleEdgeReportQuality(params as { edge_id: number; target_edge_id: number; quality: { rtt: number; packetLoss: number; jitter: number; samples: number } }) },
      { method: 'cluster.getStatus', handler: async (_channel, params) => await this.clusterHandler.handleGetClusterStatus(params as RPCParams<'cluster.getStatus'>) },
      
      // Blob 存储
      { method: 'blob.put', handler: async (_channel, params) => await this.blobHandler.handleBlobPut(params as RPCParams<'blob.put'>) },
      { method: 'blob.get', handler: async (_channel, params) => await this.blobHandler.handleBlobGet(params as RPCParams<'blob.get'>) },
      { method: 'blob.getUserTexture', handler: async (_channel, params) => await this.blobHandler.handleGetUserTexture(params as RPCParams<'blob.getUserTexture'>) },
      { method: 'blob.getUserComment', handler: async (_channel, params) => await this.blobHandler.handleGetUserComment(params as RPCParams<'blob.getUserComment'>) },
      { method: 'blob.setUserTexture', handler: async (_channel, params) => await this.blobHandler.handleSetUserTexture(params as RPCParams<'blob.setUserTexture'>) },
      { method: 'blob.setUserComment', handler: async (_channel, params) => await this.blobHandler.handleSetUserComment(params as RPCParams<'blob.setUserComment'>) },
    ];

    // 使用批量注册方法
    this.typedServer.registerHandlers(handlers);
    
    this.logger.info(`Registered ${handlers.length} RPC handlers: ${handlers.map(h => h.method).join(', ')}`);
  }

   
  private async handleEdgeRegister(
    _channel: RPCChannel,
    params: RPCParams<'edge.register'>
  ): Promise<RPCResult<'edge.register'>> {
    // 调用注册服务
    const result = await this._registry.register(params);

    if (result.success) {
      // 将 Edge 注册到连接池（连接池会自动管理虚拟通道）
      this.server.registerEdge(params.server_id, _channel);
      
      this.logger.info(`Edge ${params.server_id} registered successfully`);
      
      // 如果需要清理（Edge 重连），立即清理旧会话
      if ((result as { need_cleanup?: boolean }).need_cleanup) {
        this.logger.warn(`Edge ${params.server_id} reconnected, cleaning up old sessions immediately`);
        // 清理时排除当前重连的 Edge（它会自己处理本地客户端清理）
        this.cleanupEdgeSessionsForReconnect(params.server_id);
      }
      
      // 添加 Edge 到网络拓扑
      this._networkTopologyManager.addEdge(params.server_id);
      
      // 推送语音路由配置给新注册的 Edge
      this.pushVoiceRoutingConfig(params.server_id);
    }

    return result;
  }
  
  /**
   * 推送语音路由配置给特定 Edge
   */
  private pushVoiceRoutingConfig(edgeId: number): void {
    const voiceRoutingConfig = this.config.voice_routing;
    
    // 只在启用时推送配置
    if (!voiceRoutingConfig?.enabled) {
      this.logger.debug(`Voice routing disabled, not pushing config to Edge ${edgeId}`);
      return;
    }
    
    // 获取加密密钥
    const encryptionKey = this._voiceEncryptionManager.assignKeyToEdge(edgeId);
    
    // 将 snake_case 的 policy 转换为 camelCase 以匹配 protocol 定义
    const policy = voiceRoutingConfig.policy || DEFAULT_ROUTING_POLICY;
    const policyForProtocol = {
      directRttThreshold: policy.direct_rtt_threshold,
      directLossThreshold: policy.direct_loss_threshold,
      enableRelay: policy.enable_relay,
      maxRelayHops: policy.max_relay_hops,
      relayCostFactor: policy.relay_cost_factor,
      routeSwitchHysteresis: policy.route_switch_hysteresis,
      routeSwitchCostDelta: policy.route_switch_cost_delta,
      maxRelayLoadPerEdge: policy.max_relay_load_per_edge,
      networkProbeInterval: policy.network_probe_interval,
      routeTableUpdateInterval: policy.route_table_update_interval,
    };
    
    const hubRelayForProtocol = voiceRoutingConfig.hub_relay ? {
      enableTcpFallback: voiceRoutingConfig.hub_relay.enable_tcp_fallback,
    } : {
      enableTcpFallback: DEFAULT_HUB_RELAY_CONFIG.enable_tcp_fallback,
    };
    
    const configToPush = {
      enabled: voiceRoutingConfig.enabled,
      policy: policyForProtocol,
      preferredRelayEdges: voiceRoutingConfig.preferred_relay_edges || [],
      hubRelay: hubRelayForProtocol,
      encryption: encryptionKey ? {
        algorithm: encryptionKey.algorithm,
        key: encryptionKey.key.toString('base64'), // 转换为base64字符串传输
        version: encryptionKey.version,
      } : undefined,
    };
    
    this.logger.info(`Pushing voice routing config to Edge ${edgeId}:`, {
      enabled: configToPush.enabled,
      encryptionEnabled: !!configToPush.encryption,
      encryptionVersion: encryptionKey?.version,
      policyThresholds: {
        directRttThreshold: configToPush.policy.directRttThreshold,
        directLossThreshold: configToPush.policy.directLossThreshold,
      },
    });
    
    this.notify(edgeId, 'hub.voiceRoutingConfig', configToPush);
  }
  
  /**
   * 广播语音路由配置给所有 Edge
   */
  broadcastVoiceRoutingConfig(): void {
    const voiceRoutingConfig = this.config.voice_routing;
    
    if (!voiceRoutingConfig?.enabled) {
      this.logger.debug('Voice routing disabled, not broadcasting config');
      return;
    }
    
    // 从连接池获取所有已连接的 Edge ID
    const connectedEdges = this.server.getEdgePool().getConnectedEdges();
    for (const edgeId of connectedEdges) {
      this.pushVoiceRoutingConfig(edgeId);
    }
  }

  /**
   * 启动控制信道服务
   * 必须在所有资源（数据库、频道树等）加载完成后调用
   */
  async start(): Promise<void> {
    this.logger.info(`Starting Hub control channel server on port ${this.config.control_port || 8443}`);
    // 启动网络拓扑管理器
    this._networkTopologyManager.start();
    // 启动 WebSocket 服务器，开始接受 Edge 连接
    await this.server.start();
    this.logger.info('Hub control channel server started and ready to accept Edge connections');
  }

  /**
   * 停止控制信道服务
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping Hub control channel server');
    this.isStopping = true; // 设置停止标志，拒绝新请求
    
    // 停止网络拓扑管理器
    this._networkTopologyManager.stop();
    
    // 停止语音加密管理器
    this._voiceEncryptionManager.destroy();
    
    // ControlChannelServer 会自动关闭所有连接
    this.logger.info('Closing all edge connections');
    
    // 关闭服务器
    this.server.close();
    
    this.logger.info('Hub control channel server stopped');
  }

  
  broadcast(method: string, params?: ChannelNotificationParams): void {
    this.logger.debug(`Broadcasting ${method} to all edges`);
    // 使用 ControlChannelServer 的连接池广播，自动去重
    void this.server.broadcast(method, params);
  }

  /**
   * 广播通知给除指定Edge外的所有连接的Edge
   */
  broadcastExcept(excludeEdgeId: number, method: string, params?: ChannelNotificationParams): void {
    this.logger.debug(`Broadcasting ${method} to all edges except ${excludeEdgeId}`);
    // 使用 ControlChannelServer 的 broadcastExcept 方法，它会自动通过连接池去重
    this.server.broadcastExcept(excludeEdgeId, method, params);
  }

  notify(edgeId: number, method: string, params?: ChannelNotificationParams): void {
    const channel = this.server.getEdgeChannel(edgeId);
    if (channel) {
      try {
        channel.notify(method, params);
      } catch (error) {
        this.logger.error(`Failed to notify Edge ${edgeId}:`, error);
      }
    } else {
      this.logger.warn(`No channel found for Edge ${edgeId}`);
    }
  }

  // Edge channel 管理已由 ControlChannelServer 内部的连接池处理
  // 不再需要 setEdgeChannel 和 removeEdgeChannel 方法

  /**
   * 清理指定Edge上的所有会话及相关资源（用于Edge断开超时后）
   */
  private cleanupEdgeSessions(edgeId: number): void {
    try {
      const sessionManager = this.factory.getSessionManager();
      const sessions = sessionManager.getEdgeSessions(edgeId);

      this.logger.info(`Cleaning up ${sessions.length} sessions from Edge ${edgeId}`);

      // 1. 清理所有会话并广播用户离开消息
      for (const session of sessions) {
        // 从会话管理器中移除会话
        sessionManager.removeSession(session.session_id);

        // 广播用户离开消息给所有Edge（包括已断开的Edge，因为它可能还有连接）
        this.broadcast('hub.userRemoveBroadcast', {
          session: session.session_id,
          reason: 'Edge disconnected',
        });
      }

      // 2. 清理网络拓扑管理器中的 Edge 信息
      this._networkTopologyManager.removeEdge(edgeId);
      this.logger.debug(`Removed Edge ${edgeId} from network topology manager`);

      // 3. 清理语音加密管理器中的 Edge 密钥信息
      this._voiceEncryptionManager.removeEdge(edgeId);
      this.logger.debug(`Removed Edge ${edgeId} from voice encryption manager`);

      // 4. 从注册表中注销 Edge（会清理心跳定时器等）
      void this._registry.unregister(edgeId);
      this.logger.debug(`Unregistered Edge ${edgeId} from registry`);

      this.logger.info(`Successfully cleaned up all resources for Edge ${edgeId}`);
    } catch (error) {
      this.logger.error(`Error cleaning up Edge ${edgeId} sessions:`, error);
    }
  }

  /**
   * 清理指定Edge上的所有会话（用于Edge重连时）
   * 广播给所有Edge（包含正在重连的Edge本身），确保其本地客户端也能收到 UserRemove 消息，
   * 避免产生僵尸用户（见方案C修复）。
   */
  private cleanupEdgeSessionsForReconnect(edgeId: number): void {
    try {
      const sessionManager = this.factory.getSessionManager();
      const sessions = sessionManager.getEdgeSessions(edgeId);

      this.logger.info(`Cleaning up ${sessions.length} sessions from reconnecting Edge ${edgeId}`);

      // 清理所有会话并广播用户离开消息（包含正在重连的Edge本身）
      for (const session of sessions) {
        // 从会话管理器中移除会话
        sessionManager.removeSession(session.session_id);

        // 广播给所有Edge：确保正在重连的Edge也能收到，以便对其本地已连接客户端发送 UserRemove
        this.broadcast('hub.userRemoveBroadcast', {
          session: session.session_id,
          reason: 'Edge reconnected - session cleanup',
        });
      }

      // 注意：不清理网络拓扑和加密管理器，因为Edge正在重连
      // 这些资源会在正常注册流程中更新

      this.logger.info(`Successfully cleaned up sessions for reconnecting Edge ${edgeId}`);
    } catch (error) {
      this.logger.error(`Error cleaning up Edge ${edgeId} sessions for reconnect:`, error);
    }
  }
}