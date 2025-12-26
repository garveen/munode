import { createLogger, BlobStore } from '@munode/common';
import type { Logger } from '@munode/common';
import type { HubConfig } from './types.js';
import { ServiceRegistry } from './registry.js';
import { GlobalSessionManager } from './session-manager.js';
import { VoiceTargetSyncService } from './voice-target-sync.js';
import { HubControlService } from './control-service.js';
import { HubDatabase } from './database.js';
import { VoiceUDPTransport, type VoicePacket, type VoicePacketHeader } from '@munode/protocol';
import { validateHubConfig } from './config-validator.js';
import { applyConfigDefaults } from './config-defaults.js';
import { WebApiService } from './web-api-service.js';
import { HubHandlerFactory } from './factory.js';

/**
 * Hub Server 主类
 * 负责协调分布式 Mumble 服务器集群
 */
export class HubServer {
  private config: HubConfig;
  private logger: Logger;
  private registry: ServiceRegistry;
  private sessionManager!: GlobalSessionManager;
  private voiceTargetSync!: VoiceTargetSyncService;
  private controlService: HubControlService;
  private database: HubDatabase;
  private blobStore?: BlobStore;
  private voiceTransport?: VoiceUDPTransport;
  private webApiService?: WebApiService;
  private factory: HubHandlerFactory;
  private started = false;
  private stopping = false; // 跟踪是否正在停止

  constructor(config: HubConfig) {
    // 应用默认值
    this.config = applyConfigDefaults(config);
    
    // 验证配置
    validateHubConfig(this.config);
    
    // 创建logger实例
    this.logger = createLogger({ 
      service: `hub-${config.server_id}`,
      level: config.logLevel || 'info'
    });
    
    this.logger.debug('Hub Server configuration validated and initialized');
  }

  /**
   * 初始化 Hub Server
   */
  async init(): Promise<void> {
    // 初始化数据库
    this.database = new HubDatabase(this.config.database, this.logger);
    await this.database.init();
    this.controlService = new HubControlService(
      this.config,
      this.logger,
    );
    this.factory = await HubHandlerFactory.getInstance(this.config, this.database, this.controlService, this.logger);
    await this.controlService.initialize(this.factory);

    this.registry = this.factory.getRegistry();
    this.sessionManager = this.factory.getSessionManager();
    this.voiceTargetSync = this.factory.getVoiceTargetSync();
    this.blobStore = this.factory.getBlobStore(); // 获取从factory初始化的BlobStore



    // 初始化 Web API 服务
    if (this.config.webApi?.enabled) {
      this.webApiService = new WebApiService(
        this.config.webApi,
        this.config.server_id,
        this.registry,
        this.sessionManager,
        this.logger
      );
    }

    // 初始化语音 UDP 传输（如果配置了端口）
    if (this.config.voicePort) {
      this.voiceTransport = new VoiceUDPTransport(
        {
          port: this.config.voicePort,
          host: this.config.host,
          sharedSecret: this.config.voiceUdpSharedSecret 
            ? Buffer.from(this.config.voiceUdpSharedSecret, 'utf-8') 
            : undefined,
        },
        this.logger,
      );

      // 监听语音包事件
      this.voiceTransport.on('voice-packet', (packet) => {
        // 根据 target_id 转发到对应的 Edge
        this.handleVoicePacket(packet);
      });

      this.voiceTransport.on('error', (error) => {
    this.logger.error('Voice UDP transport error:', error);
      });
    }

    this.logger.debug('Hub Server initialized', {
       server_id: this.config.server_id,
      host: this.config.host,
      port: this.config.port,
      voicePort: this.config.voicePort,
      webApiPort: this.config.webApi?.enabled ? this.config.webApi.port : undefined,
    });
  }

  /**
   * 启动 Hub Server
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Hub Server already started');
    }

    try {
    this.logger.debug('Starting Hub Server...');

      // 初始化组件
      await this.init();

      // 加载持久化数据
      await this.loadPersistentData();

      // 启动控制信道服务
      await this.controlService.start();

      // 启动语音 UDP 传输
      if (this.voiceTransport) {
        await this.voiceTransport.start(); 
    this.logger.debug('Voice UDP transport started', {
          port: this.config.voicePort,
        });
      }

      // 启动 Web API 服务
      if (this.webApiService) {
        // 将 NetworkTopologyManager 传递给 Web API 服务（在 controlService 启动后获取）
        const networkTopologyManager = this.controlService.getNetworkTopologyManager();
        if (networkTopologyManager) {
          this.webApiService.setNetworkTopologyManager(networkTopologyManager);
        }
        await this.webApiService.start();
      }

      // 启动定期清理任务
      this.startCleanupTasks();

      this.started = true;
    this.logger.info('Hub Server started successfully', {
        address: `${this.config.host}:${this.config.port}`,
      });
    } catch (error) {
    this.logger.error('Failed to start Hub Server:', error);
      throw error;
    }
  }

  /**
   * 停止 Hub Server
   */
  async stop(): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }

    try {
      this.stopping = true;
    this.logger.info('Stopping Hub Server...');

      // 停止清理任务
      this.stopCleanupTasks();

      // 停止 Web API 服务
      if (this.webApiService) {
        await this.webApiService.stop();
      }

      // 停止语音 UDP 传输
      if (this.voiceTransport) {
        this.voiceTransport.stop();
    this.logger.debug('Voice UDP transport stopped');
      }

      // 停止控制信道服务（这会触发 Edge 断开连接）
      await this.controlService.stop();

      // 等待足够长的时间确保：
      // 1. 所有 Edge 客户端收到断开通知
      // 2. 所有进行中的数据库操作完成
      // 3. 所有 RPC 调用完成
      await new Promise(resolve => setTimeout(resolve, 500));

      // 关闭数据库连接
      await this.database.close();

      // 清除单例实例以允许在测试中创建新实例
      HubHandlerFactory.clearInstance();

      this.started = false;
      this.stopping = false;
    this.logger.info('Hub Server stopped');
    } catch (error) {
      this.stopping = false;
    this.logger.error('Error stopping Hub Server:', error);
      throw error;
    }
  }

  /**
   * 获取服务器状态
   */
  getStatus() {
    return {
      started: this.started,
      config: {
         server_id: this.config.server_id,
        host: this.config.host,
        port: this.config.port,
      },
      stats: {
        edges: this.registry.getEdgeCount(),
        sessions: this.sessionManager.getTotalSessionCount(),
        voiceTargets: this.voiceTargetSync.getTargetCount(),
      },
    };
  }

  /**
   * 获取服务注册表（用于测试）
   */
  getRegistry(): ServiceRegistry {
    return this.registry;
  }

  /**
   * 获取Handler Factory（用于测试）
   */
  getHandlerFactory(): HubHandlerFactory {
    return this.factory;
  }

  /**
   * 获取数据库实例（用于测试）
   */
  getDatabase(): HubDatabase {
    return this.database;
  }

  /**
   * 获取Blob存储实例（用于测试）
   */
  getBlobStore(): BlobStore | undefined {
    return this.blobStore;
  }

  /**
   * 启动定期清理任务
   */
  private startCleanupTasks(): void {
    // 清理超时的 Edge 服务器
    setInterval(() => {
      this.registry.cleanup();
    }, 60000); // 每分钟清理一次

    // 清理离线会话
    setInterval(() => {
      this.sessionManager.cleanup();
    }, 300000); // 每5分钟清理一次

    this.logger.debug('Cleanup tasks started');
  }

  /**
   * 停止清理任务
   */
  private stopCleanupTasks(): void {
    // 清理定时器
    // 注意：实际实现中需要保存定时器引用
    this.logger.debug('Cleanup tasks stopped');
  }

  /**
   * 加载持久化数据
   */
  private async loadPersistentData(): Promise<void> {
    try {
      // 加载活跃的 Edge 服务器
      // 注意：Edge 服务器重启后需要重新注册，这里的数据可能已过期
      // 但我们仍然加载以支持 Hub 重启但 Edge 仍在运行的场景
      const edges = await this.database.getActiveEdges();
      for (const edge of edges) {
        this.registry.getEdge(edge.server_id); // 确保注册表中有记录
      }

      // 注意：会话数据不再持久化
      // 重启后所有用户需要重新登录
      // VoiceTarget 配置也是会话相关的，同样不持久化

    this.logger.debug('Persistent data loaded', {
        edges: edges.length,
      });
    } catch (error) {
    this.logger.error('Failed to load persistent data:', error);
      // 继续启动，但记录错误
    }
  }

  /**
   * 处理接收到的语音包
   * 根据 target_id 转发到对应的 Edge
   */
  private handleVoicePacket(packet: VoicePacket): void {
    if (!this.voiceTransport) {
      return;
    }

    try {
      // packet 包含 senderId, targetId 等信息
      // 在 Hub 中转模式下，根据 targetId 转发到目标 Edge
      const targetEdgeId = packet.targetId;
      
      const header: VoicePacketHeader = {
        senderId: packet.senderId,
        targetId: packet.targetId,
        sequence: packet.sequence,
      };
      
      if (targetEdgeId) {
        // 单播到特定 Edge
        this.voiceTransport.sendToEdge(targetEdgeId, header, Buffer.from(packet.data));
      } else {
        // 广播到所有 Edge（除了发送者）
        this.voiceTransport.broadcast(header, Buffer.from(packet.data), packet.senderId);
      }
    } catch (error) {
    this.logger.error('Error handling voice packet:', error);
    }
  }

  /**
   * 注册 Edge 的语音端点
   * 当 Edge 加入集群时调用
   */
  registerEdgeVoiceEndpoint( edge_id: number, host: string, port: number): void {
    if (this.voiceTransport) {
      this.voiceTransport.registerEndpoint(edge_id, host, port);
    this.logger.debug(`Registered voice endpoint for Edge ${edge_id}: ${host}:${port}`);
    }
  }

  /**
   * 移除 Edge 的语音端点
   * 当 Edge 离开集群时调用
   */
  unregisterEdgeVoiceEndpoint( edge_id: number): void {
    if (this.voiceTransport) {
      this.voiceTransport.unregisterEndpoint(edge_id);
    this.logger.debug(`Unregistered voice endpoint for Edge ${edge_id}`);
    }
  }
}
