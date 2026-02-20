import { createLogger, TypedEventEmitter, type EventMap } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, ClientInfo, ChannelInfo, ServerStats } from '../types.js';
import { GeoIPManager } from '../util/geoip-manager.js';
import { EdgeClusterManager } from '../cluster/cluster-manager.js';
import { VoiceUDPTransport, ConnectionStrategy } from '@munode/protocol';
import { HandlerFactory } from './handler-factory.js';
import { EdgeControlClient } from '../cluster/hub-client.js';
import { ServerLifecycleManager } from './lifecycle-manager.js';
import { BanHandler } from '../managers/ban-handler.js';
import { MessageManager } from '../managers/message-manager.js';
import { VoiceManager } from '../managers/voice-manager.js';
import { HubDataManager } from '../cluster/hub-data-sync.js';
import { EventSetupManager } from '../managers/event-setup-manager.js';
import { CryptoWorkerPool } from '../voice/crypto-worker-pool.js';
import { cpus } from 'os';
import { TLSSocket } from 'tls';
import fs from 'fs';

/**
 * EdgeServer 事件类型定义
 */
export interface EdgeServerEvents extends EventMap {
  'stopped': [];
}

/**
 * Edge Server - Mumble 分布式服务器的边缘节点
 * 负责处理客户端连接、语音路由、频道管理等核心功能
 */
export class EdgeServer extends TypedEventEmitter<EdgeServerEvents> {
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
  private cryptoWorkerPool?: CryptoWorkerPool; // 全局共享 Worker Pool
  
  // Edge证书hash映射，用于识别其他Edge的TLS连接
  private knownEdgeCertHashes: Map<string, number> = new Map(); // cert_hash -> edge_id

  // 服务器状态
  private isRunning = false;
  private startTime: Date;
  private stats: ServerStats;
  
  // 从 Hub 接收的服务器配置
  private certRequired = false; // Hub 要求客户端证书
  
  // 带宽统计计数器
  private bandwidthIn = 0;
  private bandwidthOut = 0;
  private lastStatsReset = Date.now();
  
  // CPU统计
  private lastCpuUsage = process.cpuUsage();
  private lastCpuCheck = Date.now();

  // 便捷访问器 - 从 HandlerFactory 获取组件
  private get clientManager() { return this.handlerFactory.clientManager; }
  private get channelManager() { return this.handlerFactory.channelManager; }
  
  // 公开属性访问器
  get serverId() { return this.config.server_id; }
  get isCertRequired() { return this.certRequired; }
  
  setCertRequired(value: boolean) {
    this.certRequired = value;
    this.logger.info(`Server cert_required config updated: ${value}`);
  }
  
  /**
   * 添加已知Edge的证书hash
   * @param edgeId Edge ID
   * @param certHash 证书hash（SHA256，小写hex，无冒号）
   */
  addKnownEdgeCertHash(edgeId: number, certHash: string): void {
    const normalized = certHash.replace(/:/g, '').toLowerCase();
    this.knownEdgeCertHashes.set(normalized, edgeId);
    this.logger.debug(`Added known Edge cert hash: ${normalized.substring(0, 16)}... -> Edge ${edgeId}`);
  }
  
  /**
   * 根据证书hash查询Edge ID
   * @param certHash 证书hash
   * @returns Edge ID，如果不是已知Edge返回undefined
   */
  getEdgeIdByCertHash(certHash: string): number | undefined {
    const normalized = certHash.replace(/:/g, '').toLowerCase();
    return this.knownEdgeCertHashes.get(normalized);
  }


  constructor(config: EdgeConfig) {
    super();
    this.config = config;
    this.logger = createLogger({
      level: config.log_level || 'info',
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
      onRegisterEdgeCertHash: (edgeId: number, certHash: string) => {
        // 注册Edge证书哈希，用于识别Edge间TLS连接
        this.addKnownEdgeCertHash(edgeId, certHash);
      },
    });
    // 使用 ClusterManager 已创建的 HubClient 实例（避免重复创建）
    this.hubClient = this.clusterManager.getHubClient();

    // 读取Edge间连接证书（同步读取）
    // 优先使用独立的edge_cert/edge_key，未配置时复用服务器证书
    let clientCert: Buffer | undefined;
    let clientKey: Buffer | undefined;
    if (this.config.mode === 'cluster') {
      try {
        
        // 检查是否配置了独立的Edge间连接证书
        if (this.config.tls.edge_cert && this.config.tls.edge_key) {
          // 使用独立的Edge证书
          clientCert = fs.readFileSync(this.config.tls.edge_cert);
          clientKey = fs.readFileSync(this.config.tls.edge_key);
          this.logger.info(
            `Using dedicated Edge client certificates: cert=${this.config.tls.edge_cert}, key=${this.config.tls.edge_key}`
          );
        } else {
          // 复用服务器证书作为客户端证书
          clientCert = fs.readFileSync(this.config.tls.cert);
          clientKey = fs.readFileSync(this.config.tls.key);
          this.logger.info(
            `Reusing server certificates for Edge-to-Edge authentication: cert=${this.config.tls.cert}, key=${this.config.tls.key}`
          );
        }
        
        this.logger.info('Edge client certificates loaded successfully');
      } catch (error) {
        this.logger.error('Failed to load Edge client certificates:', error);
        throw new Error(`Failed to load Edge certificates: ${error}`);
      }
    }

    // 初始化语音 UDP 传输（使用与客户端相同的端口，通过魔数区分）
    // 注意：VoiceUDPTransport 不再独立监听端口，而是复用主 UDP 端口
    // 在 lifecycle-manager 中通过魔数 0x0000 区分 Edge 间包和客户端包
    this.voiceTransport = new VoiceUDPTransport(
      {
        port: this.config.network.port, // 使用主UDP端口（不再+1）
        host: this.config.network.host,
        localEdgeId: this.config.server_id,
        sharedSecret: this.config.voice_routing?.shared_secret 
          ? Buffer.from(this.config.voice_routing.shared_secret, 'utf-8') 
          : undefined,
        clientCert,
        clientKey,
        connectionStrategy: this.config.voice_routing?.connection_strategy as ConnectionStrategy | undefined,
        fallbackThresholds: this.config.voice_routing?.fallback_thresholds
          ? {
              maxRtt: this.config.voice_routing.fallback_thresholds.max_rtt,
              maxPacketLoss: this.config.voice_routing.fallback_thresholds.max_packet_loss,
              maxConsecutiveFailures: this.config.voice_routing.fallback_thresholds.max_consecutive_failures,
            }
          : undefined,
      }, 
      this.logger,
    );


    // 初始化处理器工厂（自动创建所有核心组件和处理器）
    this.handlerFactory = new HandlerFactory(
      this.config,
      this.hubClient,
      this.logger
    );
    
    // 设置 EdgeServer 引用（用于访问服务器级别状态）
    this.handlerFactory.edgeServer = this;

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

      // Initialize global Worker Pool if enabled
      if (this.config.workerThreads?.enabled) {
        const workerCount = this.config.workerThreads.count || cpus().length;
        
        this.cryptoWorkerPool = new CryptoWorkerPool(
          {
            workerCount,
            workerTimeout: this.config.workerThreads.workerTimeout,
            maxQueueLength: this.config.workerThreads.maxQueueLength,
          },
          this.logger
        );
        
        await this.cryptoWorkerPool.initialize();
        
        this.logger.info(
          `Shared CryptoWorkerPool initialized: ${workerCount} workers with session-affinity strategy`
        );

        // Set Worker Pool to VoiceRouter (single-tenant mode uses 'default' vhost)
        const vhostName = this.config.virtualHosts?.[0]?.servername || 'default';
        this.handlerFactory.voiceRouter.setCryptoWorkerPool(this.cryptoWorkerPool, vhostName);
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

      // Cleanup Worker Pool
      if (this.cryptoWorkerPool) {
        await this.cryptoWorkerPool.cleanup();
        this.logger.info('CryptoWorkerPool cleaned up');
      }

      // Disconnect Hub client
      if (this.hubClient) {
        this.hubClient.disconnect();
        this.logger.info('Hub client disconnected');
      }
      
      // 清理所有事件监听器，防止内存泄漏
      this.removeAllListeners();
      if (this.hubClient) {
        this.hubClient.removeAllListeners();
      }
      if (this.handlerFactory?.messageHandler) {
        this.handlerFactory.messageHandler.removeAllListeners();
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
    
    // 计算CPU使用率（百分比）
    const now = Date.now();
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const elapsedMs = now - this.lastCpuCheck;
    if (elapsedMs > 0) {
      // cpuUsage返回微秒，转换为CPU使用率百分比
      const totalCpuTimeUs = currentCpuUsage.user + currentCpuUsage.system;
      this.stats.cpu_usage = totalCpuTimeUs / (elapsedMs * 1000); // 转换为百分比(0-1)
      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuCheck = now;
    }
    
    // 计算带宽（bytes/s）
    const elapsedSeconds = (now - this.lastStatsReset) / 1000;
    if (elapsedSeconds > 0) {
      this.stats.bandwidth.in = Math.round(this.bandwidthIn / elapsedSeconds);
      this.stats.bandwidth.out = Math.round(this.bandwidthOut / elapsedSeconds);
    }

    return { ...this.stats };
  }

  /**
   * 更新带宽统计
   */
  updateBandwidthStats(bytesIn: number, bytesOut: number): void {
    this.bandwidthIn += bytesIn;
    this.bandwidthOut += bytesOut;
    
    // 每60秒重置一次计数器，避免累积过大
    const now = Date.now();
    if (now - this.lastStatsReset > 60000) {
      this.bandwidthIn = 0;
      this.bandwidthOut = 0;
      this.lastStatsReset = now;
    }
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
    
    // 监听客户端数据，统计入站带宽
    this.clientManager.on('clientData', (_session_id: number, data: Buffer) => {
      this.updateBandwidthStats(data.length, 0);
    });
    
    // 监听消息发送，统计出站带宽
    this.handlerFactory.messageHandler.on('sendMessage', (_session_id: number, _messageType: number, messageData: Buffer) => {
      // 消息头部6字节（类型2字节+长度4字节）+ 消息体
      this.updateBandwidthStats(0, 6 + messageData.length);
    });
    
    // 监听 Hub 拒绝重连事件（会话过期）
    if (this.hubClient) {
      this.hubClient.on('session-expired', () => {
        void this.handleSessionExpired();
      });
      
      // 监听 getStats 事件，响应心跳请求
      this.hubClient.on('getStats', (callback: (stats: ServerStats) => void) => {
        const stats = this.getStats();
        this.logger.debug('Heartbeat getStats called, stats:', {
          user_count: stats.user_count,
          channel_count: stats.channel_count,
          cpu_usage: stats.cpu_usage,
          memory_usage: stats.memory_usage,
          bandwidth: stats.bandwidth,
          bandwidthIn: this.bandwidthIn,
          bandwidthOut: this.bandwidthOut,
          lastStatsReset: this.lastStatsReset,
        });
        callback(stats);
      });
    }
    
    // Listen for shutdown requests from Hub (via hub-message-handler)
    this.handlerFactory.messageHandler.on('shutdownRequest', (params: { reason: string; graceful: boolean; clientsDisconnected?: boolean }) => {
      void this.handleShutdownRequest(params);
    });
  }

  /**
   * Handle shutdown request from Hub
   * Performs cold restart after disconnecting all clients
   */
  private async handleShutdownRequest(params: { reason: string; graceful: boolean; clientsDisconnected?: boolean }): Promise<void> {
    this.logger.error('=== Shutdown request received from Hub ===');
    this.logger.error(`Reason: ${params.reason}`);
    this.logger.error(`Graceful: ${params.graceful}`);
    this.logger.error(`Clients already disconnected: ${params.clientsDisconnected ?? false}`);
    
    try {
      // Use the cluster manager's public method to perform cold restart
      // Note: If clientsDisconnected is true, the ReconnectManager will still
      // disconnect them again, which is safe and ensures clean state
      if (this.clusterManager) {
        await this.clusterManager.performColdRestart();
        this.logger.info('=== Cold restart completed successfully ===');
      } else {
        this.logger.error('ClusterManager not available, cannot perform cold restart');
      }
    } catch (error) {
      this.logger.error('Failed to handle shutdown request:', error);
      throw error;
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
   * Get VoiceManager for testing voice routing monitoring
   */
  getVoiceManager() {
    return this.voiceManager;
  }

  /**
   * 接受被动的Edge连接（incoming connection）
   * 统一处理来自其他Edge的连接
   * @param socket 已建立的TLS socket
   * @param edgeId 对端Edge的ID
   */
  acceptIncomingEdgeConnection(socket: TLSSocket, edgeId: number): void {
    this.logger.info(
      `Accepting incoming Edge connection from Edge ${edgeId} (${socket.remoteAddress}:${socket.remotePort})`
    );

    // 转发到VoiceTransport的ConnectionManager
    const voiceTransport = this.voiceManager.getVoiceTransport();
    if (!voiceTransport) {
      this.logger.error(
        `Cannot accept Edge connection: VoiceTransport not available`
      );
      socket.destroy();
      return;
    }

    try {
      voiceTransport.acceptIncomingEdgeConnection(socket, edgeId);
      this.logger.info(
        `Successfully accepted incoming Edge connection from Edge ${edgeId}`
      );
    } catch (error) {
      this.logger.error(
        `Failed to accept incoming Edge connection from Edge ${edgeId}:`,
        error
      );
      socket.destroy();
    }
  }

  /**
   * Get shared CryptoWorkerPool instance
   * Used by VirtualHost/VoiceRouter for encryption operations
   */
  getCryptoWorkerPool(): CryptoWorkerPool | undefined {
    return this.cryptoWorkerPool;
  }

  /**
   * Get cluster status for testing
   */
  getClusterStatus() {
    if (!this.clusterManager) {
      throw new Error('ClusterManager not initialized');
    }
    return this.clusterManager.getStatus();
  }

}
