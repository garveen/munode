import { BlobStore } from '@munode/common';
import type { Logger } from '@munode/common';
import type { HubConfig } from './types.js';
import { ServiceRegistry } from './registry.js';
import { GlobalSessionManager } from './session-manager.js';
import { VoiceTargetSyncService } from './voice-target-sync.js';
import { CertificateExchangeService } from './certificate-exchange.js';
import type { HubDatabase } from './database.js';
import { ACLManager } from './acl-manager.js';
import { ChannelManager } from './channel-manager.js';
import { ChannelGroupManager } from './channel-group-manager.js';
import { BanManager } from './ban-manager.js';
import { HubAuthManager } from './auth-manager.js';
import { HubPermissionChecker } from './permission-checker.js';
import { NetworkTopologyManager } from './network-topology-manager.js';
import { VoiceEncryptionManager } from './voice-encryption-manager.js';
import { UserStateHandler, type IUserStateHandler } from './handlers/user-state-handler.js';
import { ChannelStateHandler, type IChannelStateHandler } from './handlers/channel-state-handler.js';
import { AuthenticationHandler, type IAuthenticationHandler } from './handlers/authentication-handler.js';
import { DatabaseOperations, type IDatabaseOperations } from './database-operations.js';
import { VoiceRoutingHandler, type IVoiceRoutingHandler } from './handlers/voice-routing-handler.js';
import { TextMessageHandler, type ITextMessageHandler } from './handlers/text-message-handler.js';
import { NotificationHandler, type INotificationHandler } from './handlers/notification-handler.js';
import { AdminOperationHandler, type IAdminOperationHandler } from './handlers/admin-operation-handler.js';
import { CertificateExchangeHandler, type ICertificateExchangeHandler } from './handlers/certificate-exchange-handler.js';
import { SyncHandler, type ISyncHandler } from './handlers/sync-handler.js';
import { ACLHandler, type IACLHandler } from './handlers/acl-handler.js';
import { ChannelHandler, type IChannelHandler } from './handlers/channel-handler.js';
import { ClusterHandler, type IClusterHandler } from './handlers/cluster-handler.js';
import { BlobHandler, type IBlobHandler } from './handlers/blob-handler.js';
import { HubControlService } from './control-service.js';
import { PermissionWorkerManager } from './permission-worker-manager.js';
import type { ServerLimitsConfig } from '@munode/protocol';

/**
 * Build ServerLimitsConfig from HubConfig to push down to Edge servers.
 */
function buildServerLimitsConfig(config: HubConfig): ServerLimitsConfig {
  return {
    max_bandwidth: config.bandwidth,
    text_message_length: config.text_message_length,
    image_message_length: config.image_message_length,
    message_rate: config.message_limit,
    message_burst: config.message_burst,
    max_users: config.max_users,
    listeners_per_channel: config.listeners_per_channel,
    listeners_per_user: config.listeners_per_user,
    suggest_version: config.suggest?.version !== undefined ? Number(config.suggest.version) : undefined,
    suggest_positional: config.suggest?.positional ?? undefined,
    suggest_push_to_talk: config.suggest?.push_to_talk ?? undefined,
    welcome_text: config.welcome_text,
  };
}


/**
 * Hub处理器工厂 - 使用单例模式管理各种处理器实例
 */
export class HubHandlerFactory {
  private static instance: HubHandlerFactory;

  // 核心服务实例
  private config: HubConfig;
  private logger: Logger;
  private registry: ServiceRegistry;
  private sessionManager: GlobalSessionManager;
  private voiceTargetSync: VoiceTargetSyncService;
  private certExchange: CertificateExchangeService;
  private database: HubDatabase;
  private aclManager: ACLManager;
  private channelManager: ChannelManager;
  private channelGroupManager: ChannelGroupManager;
  private banManager: BanManager;
  private blobStore: BlobStore;
  private authManager: HubAuthManager;

  // 处理器实例
  private permissionChecker: HubPermissionChecker;
  private permissionWorkerManager: PermissionWorkerManager;
  private networkTopologyManager: NetworkTopologyManager;
  private voiceEncryptionManager: VoiceEncryptionManager;
  private userStateHandler: IUserStateHandler;
  private channelStateHandler: IChannelStateHandler;
  private databaseOperations: IDatabaseOperations;
  private authenticationHandler: IAuthenticationHandler;
  private voiceRoutingHandler: IVoiceRoutingHandler;
  private textMessageHandler: ITextMessageHandler;
  private notificationHandler: INotificationHandler;
  private adminOperationHandler: IAdminOperationHandler;
  private certificateExchangeHandler: ICertificateExchangeHandler;
  private syncHandler: ISyncHandler;
  private aclHandler: IACLHandler;
  private channelHandler: IChannelHandler;
  private clusterHandler: IClusterHandler;
  private blobHandler: IBlobHandler;

  private controlService: HubControlService;

  private constructor(config: HubConfig, database: HubDatabase, logger: Logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;

    // 初始化同步广播器

    // 初始化业务逻辑层
    this.channelManager = new ChannelManager(this.database, this.logger);
    this.aclManager = new ACLManager(this.database, this.logger);
    this.channelGroupManager = new ChannelGroupManager(this.database, this.logger);
    this.banManager = new BanManager(this.database, this.logger);

    // 初始化核心服务
    this.registry = new ServiceRegistry(this.config.registry, this.database, this.logger, buildServerLimitsConfig(this.config));
    this.sessionManager = new GlobalSessionManager(this.logger); // 传递logger
    this.voiceTargetSync = new VoiceTargetSyncService(this.sessionManager, this.logger);
    this.certExchange = new CertificateExchangeService(this.registry, this.logger);
    this.authManager = new HubAuthManager(this.config, this.logger);
    this.syncHandler = new SyncHandler(this);
    this.authenticationHandler = new AuthenticationHandler(this);
    this.permissionChecker = new HubPermissionChecker(this);
    this.permissionWorkerManager = new PermissionWorkerManager(this.logger, { workerCount: 2 });
    this.networkTopologyManager = new NetworkTopologyManager(this.config.voice_routing, this.logger);
    this.voiceEncryptionManager = new VoiceEncryptionManager(this.config.voice_routing?.encryption, this.logger);
    this.userStateHandler = new UserStateHandler(this);
    this.channelStateHandler = new ChannelStateHandler(this);
    this.databaseOperations = new DatabaseOperations(this.database, this.logger);
    this.voiceRoutingHandler = new VoiceRoutingHandler(this);
    this.textMessageHandler = new TextMessageHandler(this);
    this.notificationHandler = new NotificationHandler(this);
    this.adminOperationHandler = new AdminOperationHandler(this);
    this.certificateExchangeHandler = new CertificateExchangeHandler(this);
    this.aclHandler = new ACLHandler(this);
    this.channelHandler = new ChannelHandler(this);
    this.clusterHandler = new ClusterHandler(this);
    this.blobHandler = new BlobHandler(this);
  }

  static async getInstance(config: HubConfig, database: HubDatabase, controlService: HubControlService, logger: Logger): Promise<HubHandlerFactory> {
    if (!HubHandlerFactory.instance) {
      HubHandlerFactory.instance = new HubHandlerFactory(config, database, logger);
      HubHandlerFactory.instance.controlService = controlService;
      
      // 初始化 BlobStore（如果启用）
      if (config.blob_store.enabled) {
        HubHandlerFactory.instance.blobStore = new BlobStore(config.blob_store.path, true, logger);
        await HubHandlerFactory.instance.blobStore.init();
        // 将BlobStore设置到DatabaseOperations中
        if (HubHandlerFactory.instance.databaseOperations.setBlobStore) {
          HubHandlerFactory.instance.databaseOperations.setBlobStore(HubHandlerFactory.instance.blobStore);
        }
        logger.info(`BlobStore initialized at ${config.blob_store.path}`);
      } else {
        logger.debug('BlobStore disabled');
      }
      
      await HubHandlerFactory.instance.permissionWorkerManager.initialize();
      await HubHandlerFactory.instance.channelManager.init();
      await HubHandlerFactory.instance.aclManager.init();
      await HubHandlerFactory.instance.channelGroupManager.init();
      await HubHandlerFactory.instance.banManager.init();
    }
    return HubHandlerFactory.instance;
  }

  /**
   * Clear the singleton instance (for testing)
   */
  static clearInstance(): void {
    // only used in tests
    HubHandlerFactory.instance = null as unknown as HubHandlerFactory;
  }

  getControlService(): HubControlService {
    return this.controlService;
  }

  /**
   * 获取Logger实例
   */
  getLogger(): Logger {
    return this.logger;
  }

  /**
   * 获取用户状态处理器
   */
  getUserStateHandler(): IUserStateHandler {
    return this.userStateHandler;
  }

  /**
   * 获取频道状态处理器
   */
  getChannelStateHandler(): IChannelStateHandler {
    return this.channelStateHandler;
  }

  /**
   * 获取认证处理器
   */
  getAuthenticationHandler(): IAuthenticationHandler {

    return this.authenticationHandler;
  }

  /**
   * 获取语音路由处理器
   */
  getVoiceRoutingHandler(): IVoiceRoutingHandler {

    return this.voiceRoutingHandler;
  }

  /**
   * 获取文本消息处理器
   */
  getTextMessageHandler(): ITextMessageHandler {
    return this.textMessageHandler;
  }

  /**
   * 获取通知处理器
   */
  getNotificationHandler(): INotificationHandler {
    return this.notificationHandler;
  }

  /**
   * 获取管理操作处理器
   */
  getAdminOperationHandler(): IAdminOperationHandler {
    return this.adminOperationHandler;
  }

  /**
   * 获取证书交换处理器
   */
  getCertificateExchangeHandler(): ICertificateExchangeHandler {
    return this.certificateExchangeHandler;
  }

  /**
   * 获取同步处理器
   */
  getSyncHandler(): ISyncHandler {
    return this.syncHandler;
  }

  /**
   * 获取ACL处理器
   */
  getACLHandler(): IACLHandler {
    return this.aclHandler;
  }

  /**
   * 获取频道处理器
   */
  getChannelHandler(): IChannelHandler {
    return this.channelHandler;
  }

  /**
   * 获取集群处理器
   */
  getClusterHandler(): IClusterHandler {
    return this.clusterHandler;
  }

  /**
   * 获取Blob处理器
   */
  getBlobHandler(): IBlobHandler {
    return this.blobHandler;
  }

  // 其他getter方法用于访问核心服务
  getConfig(): HubConfig { return this.config; }
  getRegistry(): ServiceRegistry { return this.registry; }
  getSessionManager(): GlobalSessionManager { return this.sessionManager; }
  getVoiceTargetSync(): VoiceTargetSyncService { return this.voiceTargetSync; }
  getCertExchange(): CertificateExchangeService { return this.certExchange; }
  getDatabase(): HubDatabase { return this.database; }
  getAclManager(): ACLManager { return this.aclManager; }
  getChannelManager(): ChannelManager { return this.channelManager; }
  getChannelGroupManager(): ChannelGroupManager { return this.channelGroupManager; }
  getBanManager(): BanManager { return this.banManager; }
  getBlobStore(): BlobStore { return this.blobStore; }
  getAuthManager(): HubAuthManager { return this.authManager; }
  getPermissionChecker(): HubPermissionChecker { return this.permissionChecker; }
  getPermissionWorkerManager(): PermissionWorkerManager { return this.permissionWorkerManager; }
  getNetworkTopologyManager(): NetworkTopologyManager { return this.networkTopologyManager; }
  getVoiceEncryptionManager(): VoiceEncryptionManager { return this.voiceEncryptionManager; }
  getDatabaseOperations(): IDatabaseOperations { return this.databaseOperations; }
}
