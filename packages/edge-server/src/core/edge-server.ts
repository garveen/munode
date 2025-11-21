import { EventEmitter } from 'events';
import { logger } from '@munode/common';
import { EdgeConfig, ClientInfo, ChannelInfo, ServerStats } from '../types.js';
import { GeoIPManager } from '../util/geoip-manager.js';
import { UserCache } from '../state/user-cache.js';
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
  private userCache?: UserCache;
  private voiceTransport?: VoiceUDPTransport; // 语音 UDP 传输

  // 服务器状态
  private isRunning = false;
  private startTime: Date;
  private stats: ServerStats;

  // 便捷访问器 - 从 HandlerFactory 获取组件
  private get clientManager() { return this.handlerFactory.clientManager; }
  private get channelManager() { return this.handlerFactory.channelManager; }


  constructor(config: EdgeConfig) {
    super();
    this.config = config;
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
      this.geoIPManager = new GeoIPManager(this.config, logger);
    }

    if (this.config.features.userCache) {
      this.userCache = new UserCache(this.config, logger);
    }

    // 初始化集群组件
    this.clusterManager = new EdgeClusterManager(this.config, logger, {
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
    this.hubClient = new EdgeControlClient(this.config, this.clusterManager.getHubClient());

    // 初始化语音 UDP 传输（集群模式下启用）
    const voicePort = this.config.network.port + 1; // 使用主端口+1作为语音端口
    this.voiceTransport = new VoiceUDPTransport({
      port: voicePort,
      host: this.config.network.host,
    });


    // 初始化处理器工厂（自动创建所有核心组件和处理器）
    this.handlerFactory = new HandlerFactory(
      this.config,
      this.hubClient,
      this.userCache
    );

    // 初始化管理器（注意：VoiceManager必须在ServerLifecycleManager之前创建）
    this.banHandler = new BanHandler(this.handlerFactory);
    this.messageManager = new MessageManager(this.handlerFactory);
    this.voiceManager = new VoiceManager(this.config, this.handlerFactory, this.voiceTransport);
    this.hubDataManager = new HubDataManager(this.handlerFactory, this.hubClient);
    
    this.serverLifecycleManager = new ServerLifecycleManager(
      this.config,
      this.handlerFactory,
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

      if (this.userCache) {
        await this.userCache.initialize();
      }

      await this.serverLifecycleManager.start();
      this.isRunning = true;
    } catch (error) {
      logger.error('Failed to start Edge Server:', error);
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

      if (this.userCache) {
        await this.userCache.shutdown();
      }

      logger.info('Edge Server stopped successfully');
      this.emit('stopped');
    } catch (error) {
      logger.error('Failed to stop Edge Server:', error);
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



}
