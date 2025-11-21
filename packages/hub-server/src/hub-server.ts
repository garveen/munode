import { createLogger, BlobStore } from '@munode/common';
import type { HubConfig } from './types.js';
import { ServiceRegistry } from './registry.js';
import { GlobalSessionManager } from './session-manager.js';
import { VoiceTargetSyncService } from './voice-target-sync.js';
import { CertificateExchangeService } from './certificate-exchange.js';
import { HubControlService } from './control-service.js';
import { HubDatabase } from './database.js';
import { SyncBroadcaster } from './sync-broadcaster.js';
import { ChannelManager } from './channel-manager.js';
import { ACLManager } from './acl-manager.js';
import { ChannelGroupManager } from './channel-group-manager.js';
import { BanManager } from './ban-manager.js';
import { VoiceUDPTransport } from '@munode/protocol';
import { validateHubConfig } from './config-validator.js';
import { applyConfigDefaults } from './config-defaults.js';

const logger = createLogger({ service: 'hub-server' });

/**
 * Hub Server 主类
 * 负责协调分布式 Mumble 服务器集群
 */
export class HubServer {
  private config: HubConfig;
  private registry!: ServiceRegistry;
  private sessionManager!: GlobalSessionManager;
  private voiceTargetSync!: VoiceTargetSyncService;
  private certExchange!: CertificateExchangeService;
  private controlService!: HubControlService;
  private database!: HubDatabase;
  private syncBroadcaster!: SyncBroadcaster;
  private channelManager!: ChannelManager;
  private aclManager!: ACLManager;
  private channelGroupManager!: ChannelGroupManager;
  private banManager!: BanManager;
  private blobStore?: BlobStore;
  private voiceTransport?: VoiceUDPTransport;
  private started = false;

  constructor(config: HubConfig) {
    // 应用默认值
    this.config = applyConfigDefaults(config);
    
    // 验证配置
    validateHubConfig(this.config);
    
    logger.info('Hub Server configuration validated and initialized');
  }

  /**
   * 初始化 Hub Server
   */
  async init(): Promise<void> {
    // 初始化数据库
    this.database = new HubDatabase(this.config.database);
    await this.database.init();

    // 初始化 BlobStore（如果启用）
    if (this.config.blobStore.enabled) {
      this.blobStore = new BlobStore(this.config.blobStore.path, true);
      await this.blobStore.init();
      logger.info('BlobStore enabled');
    } else {
      logger.info('BlobStore disabled');
    }

    // 初始化同步广播器
    this.syncBroadcaster = new SyncBroadcaster(this.database);
    await this.syncBroadcaster.init();

    // 初始化业务逻辑层
    this.channelManager = new ChannelManager(this.database, this.syncBroadcaster);
    await this.channelManager.init();
    this.aclManager = new ACLManager(this.database, this.syncBroadcaster);
    await this.aclManager.init();
    this.channelGroupManager = new ChannelGroupManager(this.database, this.syncBroadcaster);
    await this.channelGroupManager.init();
    this.banManager = new BanManager(this.database, this.syncBroadcaster);
    await this.banManager.init();

    // 初始化核心服务
    this.registry = new ServiceRegistry(this.config.registry, this.database);
    this.sessionManager = new GlobalSessionManager(); // 不再传递 database
    this.voiceTargetSync = new VoiceTargetSyncService(this.sessionManager);
    this.certExchange = new CertificateExchangeService(this.registry);

    // 初始化控制信道服务
    this.controlService = new HubControlService(
      this.config,
      this.registry,
      this.sessionManager,
      this.voiceTargetSync,
      this.certExchange,
      this.database,
      this.aclManager,
      this.channelGroupManager,
      this.blobStore
    );

    // 初始化语音 UDP 传输（如果配置了端口）
    if (this.config.voicePort) {
      this.voiceTransport = new VoiceUDPTransport({
        port: this.config.voicePort,
        host: this.config.host,
      });

      // 监听语音包事件
      this.voiceTransport.on('packet', (packet) => {
        // 根据 target_id 转发到对应的 Edge
        this.handleVoicePacket(packet);
      });

      this.voiceTransport.on('error', (error) => {
        logger.error('Voice UDP transport error:', error);
      });
    }

    logger.info('Hub Server initialized', {
       server_id: this.config.server_id,
      host: this.config.host,
      port: this.config.port,
      voicePort: this.config.voicePort,
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
      logger.info('Starting Hub Server...');

      // 初始化组件
      await this.init();

      // 加载持久化数据
      await this.loadPersistentData();

      // 启动控制信道服务
      await this.controlService.start();

      // 启动语音 UDP 传输
      if (this.voiceTransport) {
        await this.voiceTransport.start(); 
        logger.info('Voice UDP transport started', {
          port: this.config.voicePort,
        });
      }

      // 启动定期清理任务
      this.startCleanupTasks();

      this.started = true;
      logger.info('Hub Server started successfully', {
        address: `${this.config.host}:${this.config.port}`,
      });
    } catch (error) {
      logger.error('Failed to start Hub Server:', error);
      throw error;
    }
  }

  /**
   * 停止 Hub Server
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      logger.info('Stopping Hub Server...');

      // 停止控制信道服务
      await this.controlService.stop();

      // 停止语音 UDP 传输
      if (this.voiceTransport) {
        this.voiceTransport.stop();
        logger.info('Voice UDP transport stopped');
      }

      // 停止清理任务
      this.stopCleanupTasks();

      // 关闭数据库连接
      await this.database.close();

      this.started = false;
      logger.info('Hub Server stopped');
    } catch (error) {
      logger.error('Error stopping Hub Server:', error);
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

    logger.debug('Cleanup tasks started');
  }

  /**
   * 停止清理任务
   */
  private stopCleanupTasks(): void {
    // 清理定时器
    // 注意：实际实现中需要保存定时器引用
    logger.debug('Cleanup tasks stopped');
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

      logger.info('Persistent data loaded', {
        edges: edges.length,
      });
    } catch (error) {
      logger.error('Failed to load persistent data:', error);
      // 继续启动，但记录错误
    }
  }

  /**
   * 处理接收到的语音包
   * 根据 target_id 转发到对应的 Edge
   */
  private handleVoicePacket(packet: any): void {
    if (!this.voiceTransport) {
      return;
    }

    try {
      // packet 包含 senderId, target_id 等信息
      // 在 Hub 中转模式下，根据 target_id 转发到目标 Edge
      const targetEdgeId = packet.target_id;
      
      if (targetEdgeId) {
        // 单播到特定 Edge
        this.voiceTransport.sendToEdge(targetEdgeId, packet, packet.data);
      } else {
        // 广播到所有 Edge（除了发送者）
        this.voiceTransport.broadcast(packet, packet.data, packet.sender_id);
      }
    } catch (error) {
      logger.error('Error handling voice packet:', error);
    }
  }

  /**
   * 注册 Edge 的语音端点
   * 当 Edge 加入集群时调用
   */
  registerEdgeVoiceEndpoint( edge_id: number, host: string, port: number): void {
    if (this.voiceTransport) {
      this.voiceTransport.registerEndpoint(edge_id, host, port);
      logger.debug(`Registered voice endpoint for Edge ${edge_id}: ${host}:${port}`);
    }
  }

  /**
   * 移除 Edge 的语音端点
   * 当 Edge 离开集群时调用
   */
  unregisterEdgeVoiceEndpoint( edge_id: number): void {
    if (this.voiceTransport) {
      this.voiceTransport.unregisterEndpoint(edge_id);
      logger.debug(`Unregistered voice endpoint for Edge ${edge_id}`);
    }
  }
}
