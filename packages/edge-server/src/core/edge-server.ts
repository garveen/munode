import { EventEmitter } from 'events';
import { createLogger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, ClientInfo, ChannelInfo, ServerStats } from '../types.js';
import { GeoIPManager } from '../util/geoip-manager.js';
import { EdgeClusterManager } from '../cluster/cluster-manager.js';
import { VoiceUDPTransport } from '@munode/protocol';
import { HandlerFactory } from './handler-factory.js';
import { EdgeControlClient } from '../cluster/hub-client.js';
import { ServerLifecycleManager } from './lifecycle-manager.js';
import { BanHandler } from '../managers/ban-handler.js';
import { MessageManager } from '../managers/message-manager.js';
import { VoiceManager } from '../managers/voice-manager.js';
import { HubDataManager } from '../cluster/hub-data-sync.js';
import { EventSetupManager } from '../managers/event-setup-manager.js';


/**
 * Edge Server - Mumble 分布式服务器的边缘节点
 * 负责处理客户端连接、语音路由、频道管理等核心功能
 */
export class EdgeServer extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;

  // 核心组件工厂
  private handlerFactory: HandlerFactory;

  // 管理器
  private serverLifecycleManager: ServerLifecycleManager;
  private banHandler: BanHandler;
  private messageManager: MessageManager;
  private voiceManager: VoiceManager;
  private hubDataManager: HubDataManager;
  private eventSetupManager: EventSetupManager;
  
  // 可选组件
  private hubClient?: EdgeControlClient;
  private clusterManager?: EdgeClusterManager;
  private geoIPManager?: GeoIPManager;
  private voiceTransport?: VoiceUDPTransport; // 语音 UDP 传输

  // 服务器状态
  private isRunning = false;
  private startTime: Date;
  private stats: ServerStats;

  // 便捷访问器 - 从 HandlerFactory 获取组件
  private get clientManager() { return this.handlerFactory.clientManager; }
  private get channelManager() { return this.handlerFactory.channelManager; }
  
  // 公开属性访问器
  get serverId() { return this.config.server_id; }


  constructor(config: EdgeConfig) {
    super();
    this.config = config;
    this.logger = createLogger({
      level: config.logLevel || 'info',
      service: `edge-${config.server_id}`,
    });
    this.startTime = new Date();

    this.stats = {
       user_count: 0,
       channel_count: 0,
       cpu_usage: 0,
       memory_usage: 0,
      bandwidth: { in: 0, out: 0 },
    };

    // 初始化可选组件
    if (this.config.features.geoip) {
      this.geoIPManager = new GeoIPManager(this.config, this.logger);
    }

    // 初始化集群组件
    this.clusterManager = new EdgeClusterManager(this.config, this.logger, {
      onDisconnectAllClients: () => {
        // 断开所有客户端
        const clients = this.handlerFactory.clientManager.getAllClients();
        for (const client of clients) {
          const socket = this.handlerFactory.clientManager.getSocket(client.session);
          if (socket) {
            socket.destroy();
          }
        }
      },
      onClearState: () => {
        // 清理状态，但保留配置
        // 状态管理器会自动清理
      },
    });
    this.hubClient = new EdgeControlClient(this.config, this.logger, this.clusterManager.getHubClient());

    // 初始化语音 UDP 传输（集群模式下启用）
    const voicePort = this.config.network.port + 1; // 使用主端口+1作为语音端口
    this.voiceTransport = new VoiceUDPTransport(
      {
        port: voicePort,
        host: this.config.network.host,
      }, 
      this.logger,
    );


    // 初始化处理器工厂（自动创建所有核心组件和处理器）
    this.handlerFactory = new HandlerFactory(
      this.config,
      this.hubClient,
      this.logger
    );

    // 初始化管理器（注意：VoiceManager必须在ServerLifecycleManager之前创建）
    this.banHandler = new BanHandler(this.handlerFactory);
    this.messageManager = new MessageManager(this.handlerFactory);
    this.voiceManager = new VoiceManager(this.config, this.handlerFactory, this.voiceTransport);
    this.hubDataManager = new HubDataManager(this.handlerFactory, this.hubClient);
    
    this.serverLifecycleManager = new ServerLifecycleManager(
      this.config,
      this.handlerFactory,
      this.logger,
      this.clusterManager,
      this.voiceTransport,
      this.voiceManager
    );

    this.eventSetupManager = new EventSetupManager(
      this.handlerFactory,
      this.config,
      this.hubClient,
      this.voiceManager,
      this.hubDataManager,
      this.banHandler,
      this.messageManager
    );

    this.setupEventHandlers();
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    try {
      // 初始化可选组件
      if (this.geoIPManager) {
        await this.geoIPManager.initialize();
      }

      await this.serverLifecycleManager.start();
      this.isRunning = true;
    } catch (error) {
      this.logger.error('Failed to start Edge Server:', error);
      throw error;
    }
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    try {
      this.isRunning = false;

      await this.serverLifecycleManager.stop();

      // 断开 Hub 客户端连接
      if (this.hubClient) {
        this.hubClient.disconnect();
        this.logger.info('Hub client disconnected');
      }

      this.logger.info('Edge Server stopped successfully');
      this.emit('stopped');
    } catch (error) {
      this.logger.error('Failed to stop Edge Server:', error);
      throw error;
    }
  }

  /**
   * 获取服务器统计信息
   */
  getStats(): ServerStats {
    const memUsage = process.memoryUsage();
    this.stats.memory_usage = memUsage.heapUsed / memUsage.heapTotal;
    this.stats.user_count = this.clientManager.getClientCount();
    this.stats.channel_count = this.channelManager.getChannelCount();

    return { ...this.stats };
  }

  /**
   * 获取客户端信息
   */
  getClients(): ClientInfo[] {
    return this.clientManager.getAllClients();
  }

  /**
   * 获取频道信息
   */
  getChannels(): ChannelInfo[] {
    return this.channelManager.getAllChannels();
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    this.eventSetupManager.setupEventHandlers();
    
    // 监听 Hub 拒绝重连事件（会话过期）
    if (this.hubClient) {
      this.hubClient.on('session-expired', () => {
        this.handleSessionExpired();
      });
    }
  }

  /**
   * 处理会话过期（Hub拒绝重连）
   * 执行冷启动流程：断开所有客户端，清理状态，重新加入集群
   */
  private async handleSessionExpired(): Promise<void> {
    this.logger.error('=== Session expired on Hub, performing cold restart ===');
    
    try {
      // 1. 断开所有客户端连接（并行处理以提高效率）
      this.logger.info('Disconnecting all clients...');
      const clients = this.clientManager.getAllClients();
      const disconnectPromises = clients.map(client => {
        return new Promise<void>((resolve) => {
          const socket = this.clientManager.getSocket(client.session);
          if (socket) {
            socket.once('close', () => resolve());
            socket.destroy();
            // Fallback timeout in case close event doesn't fire
            setTimeout(resolve, 1000);
          } else {
            resolve();
          }
        });
      });
      await Promise.all(disconnectPromises);
      
      // 2. 清理本地状态
      this.logger.info('Clearing local state...');
      // Clear all clients from manager
      const remainingClients = this.clientManager.getAllClients();
      for (const client of remainingClients) {
        this.clientManager.removeClient(client.session);
      }
      // channelManager 保留，因为频道结构需要从 Hub 重新同步
      
      // 3. 等待一下让连接完全关闭
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 4. 重新加入集群
      this.logger.info('Rejoining cluster with cold start...');
      if (this.clusterManager) {
        await this.clusterManager.joinCluster();
      }
      
      this.logger.info('=== Cold restart completed successfully ===');
    } catch (error) {
      this.logger.error('Failed to perform cold restart:', error);
      // 可能需要完全重启服务器
      throw error;
    }
  }

  /**
   * 检查服务器是否运行中
   */
  isServerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * 获取服务器配置
   */
  getConfig(): EdgeConfig {
    return { ...this.config };
  }

  /**
   * 获取服务器运行时间
   */
  getUptime(): number {
    return Date.now() - this.startTime.getTime();
  }

  /**
   * 获取 UDP socket（用于测试和网络质量模拟）
   */
  getUDPSocket() {
    return this.serverLifecycleManager.getUDPSocket();
  }

  /**
   * 获取 VoiceManager（用于测试监控语音路由）
   */
  getVoiceManager() {
    return this.voiceManager;
  }

}
