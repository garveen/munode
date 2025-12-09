import { createLogger } from '@munode/common';
import {
  ControlChannelServer,
  ControlChannelConfig,
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
import type { HubConfig } from './types.js';
import type { ServiceRegistry } from './registry.js';
import { NetworkTopologyManager, type RouteEntry } from './network-topology-manager.js';
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

const logger = createLogger({ service: 'hub-control' });

/**
 * Hub Server 控制信道服务
 * 基于 MessagePack + WebSocket 的 RPC 服务
 */
export class HubControlService {
  private server: ControlChannelServer;
  private typedServer: TypedRPCServer;
  private config: HubConfig;
  private _registry: ServiceRegistry;
  private edgeChannels = new Map<number, RPCChannel>(); // edge_id -> channel
  private _ninjaChannels: Set<number>; // Set of channel IDs that are ninja channels
  private _networkTopologyManager: NetworkTopologyManager; // 网络拓扑管理器
  private isStopping = false; // 标记服务是否正在停止

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
  ) {
    this.config = config;
  }
  async initialize(factory: HubFactory): Promise<void> {
    this.factory = factory;

    const config = this.config;

    // 初始化处理器工厂


    // Initialize ninja channels set from config
    logger.info(`Channel Ninja config: channelNinja=${config.channelNinja}, ninjaChannels=${JSON.stringify(config.ninjaChannels)}`);
    this._ninjaChannels = new Set(config.ninjaChannels || []);
    if (this._ninjaChannels.size > 0) {
      logger.info(`Channel Ninja enabled with ${this._ninjaChannels.size} ninja channels: [${Array.from(this._ninjaChannels).join(', ')}]`);
    }

    // 初始化网络拓扑管理器
    this._networkTopologyManager = new NetworkTopologyManager(config.voiceRouting);
    this.setupNetworkTopologyEvents();

    const controlConfig: ControlChannelConfig = {
      port: config.controlPort || 8443,
      host: config.host,
    };

    this.server = new ControlChannelServer(controlConfig);

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
    if (!this.config.voiceRouting?.enabled) {
      return;
    }
    
    logger.info(`Pushing route table to Edge ${edgeId}:`, {
      routeCount: routes.length,
      routes: routes.map(r => ({
        target: r.targetEdgeId,
        type: r.type,
        nextHop: r.nextHop,
      })),
    });
    
    this.notify(edgeId, 'hub.routeTableUpdate', { routes });
  }
  
  /**
   * 获取网络拓扑管理器
   */
  getNetworkTopologyManager(): NetworkTopologyManager {
    return this._networkTopologyManager;
  }

  private setupEventHandlers(): void {
    // 监听连接
    this.server.on('connect', (_channel: RPCChannel) => {
      logger.info('Edge connected to control channel');
    });

    // Handle disconnect
    this.server.on('disconnect', (channel: RPCChannel) => {
      // Find the corresponding edge_id and remove it
      for (const [edge_id, ch] of this.edgeChannels) {
        if (ch === channel) {
          this.edgeChannels.delete(edge_id);
          this.removeEdgeChannel(edge_id);
          logger.info(`Edge ${edge_id} disconnected from control channel`);
          
          // Clean up all user sessions on this Edge and notify other Edges
          this.cleanupEdgeSessions(edge_id);
          break;
        }
      }
    });

    // Handle requests
    this.server.on('request', (channel: RPCChannel, message: Message, respond: (result?: TypedRPCResponse, error?: { code: number; message: string }) => void) => {
      // 如果服务正在停止，拒绝所有新请求
      if (this.isStopping) {
        respond(undefined, { code: -32000, message: 'Hub server is shutting down' });
        return;
      }
      
      if (message.params) {
        this.typedServer.handleRequest(channel, message.params, respond);
      } else {
        respond(new hubedgeRpc.TypedRPCResponse({ request_id: message.id || '0' }), { code: -32600, message: 'Invalid request: missing params' });
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
      
      case 'hub.userLeft':
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

      default:
        logger.debug(`Unknown notification method: ${method}`);
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
      { method: 'edge.reportSession', handler: async (_channel, params) => await this.factory.getAuthenticationHandler().handleReportSession(params as RPCParams<'edge.reportSession'>) },
      
      // VoiceTarget 同步
      { method: 'edge.syncVoiceTarget', handler: async (_channel, params) => await this.factory.getVoiceRoutingHandler().handleSyncVoiceTarget(params as RPCParams<'edge.syncVoiceTarget'>) },
      { method: 'edge.getVoiceTargets', handler: async (_channel, params) => await this.factory.getVoiceRoutingHandler().handleGetVoiceTargets(params as RPCParams<'edge.getVoiceTargets'>) },
      { method: 'edge.routeVoice', handler: async (_channel, params) => await this.factory.getVoiceRoutingHandler().handleRouteVoice(params as RPCParams<'edge.routeVoice'>) },
      
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
    
    logger.info(`Registered ${handlers.length} RPC handlers: ${handlers.map(h => h.method).join(', ')}`);
  }

   
  private async handleEdgeRegister(
    _channel: RPCChannel,
    params: RPCParams<'edge.register'>
  ): Promise<RPCResult<'edge.register'>> {
    // 调用注册服务
    const result = await this._registry.register(params);

    if (result.success) {
      // 将Edge与RPCChannel关联
      this.edgeChannels.set(params.server_id, _channel);
      this.setEdgeChannel(params.server_id, _channel);
      logger.info(`Edge ${params.server_id} registered successfully`);
      
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
    const voiceRoutingConfig = this.config.voiceRouting;
    
    // 只在启用时推送配置
    if (!voiceRoutingConfig?.enabled) {
      logger.debug(`Voice routing disabled, not pushing config to Edge ${edgeId}`);
      return;
    }
    
    const configToPush = {
      enabled: voiceRoutingConfig.enabled,
      policy: voiceRoutingConfig.policy || DEFAULT_ROUTING_POLICY,
      preferredRelayEdges: voiceRoutingConfig.preferredRelayEdges || [],
      hubRelay: voiceRoutingConfig.hubRelay || DEFAULT_HUB_RELAY_CONFIG,
    };
    
    logger.info(`Pushing voice routing config to Edge ${edgeId}:`, {
      enabled: configToPush.enabled,
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
    const voiceRoutingConfig = this.config.voiceRouting;
    
    if (!voiceRoutingConfig?.enabled) {
      logger.debug('Voice routing disabled, not broadcasting config');
      return;
    }
    
    for (const edgeId of this.edgeChannels.keys()) {
      this.pushVoiceRoutingConfig(edgeId);
    }
  }

  /**
   * 启动控制信道服务
   */
  async start(): Promise<void> {
    logger.info(`Starting Hub control channel server on port ${this.config.controlPort || 8443}`);
    // 启动网络拓扑管理器
    this._networkTopologyManager.start();
    // 服务器在构造函数中已经启动
  }

  /**
   * 停止控制信道服务
   */
  async stop(): Promise<void> {
    logger.info('Stopping Hub control channel server');
    this.isStopping = true; // 设置停止标志，拒绝新请求
    
    // 停止网络拓扑管理器
    this._networkTopologyManager.stop();
    
    // 主动关闭所有 Edge 连接
    logger.info(`Closing ${this.edgeChannels.size} edge connections`);
    for (const [edgeId, channel] of this.edgeChannels.entries()) {
      try {
        channel.close();
      } catch (error) {
        logger.warn(`Error closing edge ${edgeId} channel:`, error);
      }
    }
    this.edgeChannels.clear();
    
    // 关闭服务器
    this.server.close();
    
    logger.info('Hub control channel server stopped');
  }

  
  broadcast(method: string, params?: ChannelNotificationParams): void {
    logger.debug(`Broadcasting ${method} to all edges`);
    // Fire and forget - 不等待广播完成
    void this.server.broadcast(method, params);
    
  }

  /**
   * 广播通知给除指定Edge外的所有连接的Edge
   */
  broadcastExcept(excludeEdgeId: number, method: string, params?: ChannelNotificationParams): void {
    logger.debug(`Broadcasting ${method} to all edges except ${excludeEdgeId}`);
    for (const [edgeId, channel] of this.edgeChannels.entries()) {
      if (edgeId === excludeEdgeId) {
        continue;
      }
      try {
        channel.notify(method, params);
      } catch (error) {
        logger.error(`Failed to notify Edge ${edgeId}:`, error);
      }
    }
  }

  notify(edgeId: number, method: string, params?: ChannelNotificationParams): void {
    const channel = this.edgeChannels.get(edgeId);
    if (channel) {
      try {
        channel.notify(method, params);

      } catch (error) {
        logger.error(`Failed to notify Edge ${edgeId}:`, error);
      }
    } else {
      logger.warn(`No channel found for Edge ${edgeId}`);
    }
  }

  setEdgeChannel(edgeId: number, channel: RPCChannel): void {
    this.edgeChannels.set(edgeId, channel);
    logger.debug(`Set channel for Edge ${edgeId}`);
  }

  removeEdgeChannel(edgeId: number): void {
    this.edgeChannels.delete(edgeId);
    logger.debug(`Removed channel for Edge ${edgeId}`);
  }

  /**
   * 清理指定Edge上的所有会话
   */
  private cleanupEdgeSessions(edgeId: number): void {
    try {
      const sessionManager = this.factory.getSessionManager();
      const sessions = sessionManager.getEdgeSessions(edgeId);

      logger.info(`Cleaning up ${sessions.length} sessions from Edge ${edgeId}`);

      // 通知其他Edge这些用户离开了
      for (const session of sessions) {
        // 从会话管理器中移除会话
        sessionManager.removeSession(session.session_id);

        // 广播用户离开消息给其他Edge
        this.broadcast('hub.userLeft', {
          session_id: session.session_id,
          username: session.username,
        });
      }
    } catch (error) {
      logger.error(`Error cleaning up Edge ${edgeId} sessions:`, error);
    }
  }
}