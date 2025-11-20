/**
 * Edge Server 集群集成模块
 * 
 * 处理Edge Server加入集群的流程
 * 
 * 架构原则：
 * - Edge之间没有RPC连接，只有UDP语音传输
 * - 所有控制信令通过Hub中转
 */

import { ControlChannelClient } from '@munode/protocol';
import { ReconnectManager } from './cluster/reconnect-manager.js';
import type { EdgeConfig } from './types.js';
import type { Logger } from 'winston';

export interface ClusterIntegration {
  hubClient: ControlChannelClient;
  reconnectManager: ReconnectManager;
  isJoined: boolean;
}

export class EdgeClusterManager {
  private hubClient: ControlChannelClient;
  private reconnectManager: ReconnectManager;
  private isJoined = false;
  private config: EdgeConfig;
  private logger: Logger;
  private onDisconnectAllClients?: () => void;
  private onClearState?: () => void;
  private peers: Array<{ id: number; name: string; host: string; port: number; voicePort?: number }> = [];

  constructor(
    config: EdgeConfig,
    logger: Logger,
    callbacks?: {
      onDisconnectAllClients?: () => void;
      onClearState?: () => void;
    }
  ) {
    this.config = config;
    this.logger = logger;
    this.onDisconnectAllClients = callbacks?.onDisconnectAllClients;
    this.onClearState = callbacks?.onClearState;

    // 初始化 Hub 客户端（稍后在 joinCluster 中连接）
    const hubConfig = this.config.hubServer;
    if (!hubConfig) {
      throw new Error('Hub server configuration not found');
    }
    
    this.hubClient = new ControlChannelClient({
      host: hubConfig.host,
      port: hubConfig.controlPort,
      tls: hubConfig.tls?.rejectUnauthorized !== false,
    });

    // 设置 Hub 客户端事件
    this.setupHubClientEvents();

    // Edge之间不需要RPC连接，PeerManager已移除

    // 初始化重连管理器
    this.reconnectManager = new ReconnectManager(
      {
        connectToHub: async () => {
          await this.hubClient.connect();
        },
        disconnectFromHub: () => {
          this.hubClient.disconnect();
        },
        disconnectAllPeers: () => {
          // Edge之间没有RPC连接，无需断开peer
        },
        disconnectAllClients: () => {
          this.onDisconnectAllClients?.();
        },
        clearState: () => {
          this.isJoined = false;
          this.onClearState?.();
        },
        joinCluster: async () => {
          await this.joinCluster();
        },
      },
      {
        hubReconnectTimeout: 10000,
        hubReconnectInterval: 2000,
        rejoinDelay: 5000,
      }
    );
  }

  private setupHubClientEvents(): void {
    this.hubClient.on('connect', () => {
      this.logger.info('Connected to Hub');
    });

    this.hubClient.on('disconnect', () => {
      this.logger.warn('Disconnected from Hub');
      if (this.isJoined) {
        // 触发重连
        void this.reconnectManager.handleHubDisconnect();
      }
    });

    this.hubClient.on('notification', (message) => {
      this.handleHubNotification(message);
    });

    this.hubClient.on('error', (error) => {
      this.logger.error('Hub client error:', error);
    });
  }

  /**
   * 加入集群
   */
  async joinCluster(): Promise<void> {
    try {
      // 1. 连接 Hub
      await this.hubClient.connect();
      this.logger.info('Connected to Hub server');

      // 2. 向 Hub 注册自身
      const registerParams = {
        server_id: this.config.server_id,
        name: this.config.name,
        host: this.config.network.externalHost || this.config.network.host,
        port: this.config.network.port,
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

      const registerResponse = await this.hubClient.call('edge.register', registerParams);
      if (!registerResponse.success) {
        throw new Error(`Registration failed: ${registerResponse.error || 'Unknown error'}`);
      }

      this.logger.info(`Successfully registered with Hub: ${JSON.stringify(registerResponse)}`);

      // 3. 发起 join 请求
      const joinRequest = {
         server_id: this.config.server_id,
        serverName: this.config.name,
      };

      const joinResponse = await this.hubClient.call('edge.join', joinRequest);

      if (!joinResponse.success) {
        throw new Error(`Join failed: ${joinResponse.error || 'Unknown error'}`);
      }

      this.logger.info(`Join request accepted, token: ${joinResponse.token}`);
      this.logger.info(`Peers: ${JSON.stringify(joinResponse.peers)}`);

      // 4. Edge之间不需要RPC连接，只需要UDP语音端点
      // Peer的语音端口会在EdgeServer中注册到VoiceUDPTransport
      const connectedPeers: number[] = [];
      this.peers = []; // 清空旧的 peers
      for (const peer of joinResponse.peers) {
        // 保存 peer 信息，包含 voicePort
        this.peers.push({
          id: peer.id,
          name: peer.name,
          host: peer.host,
          port: peer.port,
          voicePort: peer.port + 1, // 语音端口 = 主端口 + 1
        });
        connectedPeers.push(peer.id);
        this.logger.info(`Registered peer ${peer.id} (${peer.name}) for voice UDP`);
      }

      // 5. 确认加入完成
      const confirmResponse = await this.hubClient.call('edge.joinComplete', {
         server_id: this.config.server_id,
        token: joinResponse.token,
        connectedPeers,
      });

      if (!confirmResponse.success) {
        throw new Error(`Join confirmation failed: ${confirmResponse.error || 'Unknown error'}`);
      }

      this.isJoined = true;
      this.logger.info('Successfully joined cluster');
    } catch (error) {
      this.logger.error('Failed to join cluster:', error);
      throw error;
    }
  }

  /**
   * 处理 Hub 通知
   */
  private handleHubNotification(message: any): void {
    switch (message.method) {
      case 'edge.peerJoined':
        void this.handlePeerJoined(message.params);
        break;

      case 'edge.peerLeft':
        this.handlePeerLeft(message.params);
        break;

      case 'edge.forceDisconnect':
        void this.handleForceDisconnect(message.params);
        break;

      default:
        // 只处理集群相关的通知，其他通知由 EdgeServer 处理
        if (message.method.startsWith('edge.')) {
          this.logger.debug(`Unknown cluster notification: ${message.method}`);
        }
    }
  }

  /**
   * 处理新 Peer 加入
   */
  private async handlePeerJoined(params: any): Promise<void> {
    this.logger.info(`New peer joined: ${JSON.stringify(params)}`);
    
    // 添加到 peers 列表
    this.peers.push({
      id: params.id,
      name: params.name,
      host: params.host,
      port: params.port,
      voicePort: params.voicePort || params.port + 1,
    });
    
    // Edge之间不需要RPC连接
    // Peer的语音端口会在EdgeServer中注册到VoiceUDPTransport
    this.logger.info(`Peer ${params.id} ready for voice UDP communication`);
  }

  /**
   * 处理 Peer 离开
   */
  private handlePeerLeft(params: any): void {
    this.logger.info(`Peer left: ${params.id}`);
    
    // 从 peers 列表移除
    this.peers = this.peers.filter(p => p.id !== params.id);
    
    // Edge之间不需要RPC连接，无需断开
    // VoiceUDPTransport的端点会在EdgeServer中注销
  }

  /**
   * 处理强制断开
   */
  private async handleForceDisconnect(params: any): Promise<void> {
    this.logger.warn(`Force disconnect requested: ${params.reason}`);
    await this.reconnectManager.performFullDisconnect();
  }

  /**
   * 获取集群状态
   */
  getStatus(): {
    isJoined: boolean;
    hubConnected: boolean;
    reconnectStats: any;
  } {
    return {
      isJoined: this.isJoined,
      hubConnected: this.hubClient.isConnected(),
      reconnectStats: this.reconnectManager.getStats(),
    };
  }

  /**
   * 断开集群
   */
  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from cluster...');

    this.isJoined = false;
    // Edge之间没有RPC连接，无需断开peer
    this.hubClient.disconnect();

    this.logger.info('Disconnected from cluster');
  }

  /**
   * 获取 Hub 客户端（用于发送RPC调用）
   */
  getHubClient(): ControlChannelClient {
    return this.hubClient;
  }

  /**
   * 获取 peers 列表
   */
  getPeers(): Array<{ id: number; name: string; host: string; port: number; voicePort?: number }> {
    return this.peers;
  }
}
