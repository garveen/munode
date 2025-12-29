/**
 * Edge Server 集群集成模块
 * 
 * 处理Edge Server加入集群的流程
 * 
 * 架构原则：
 * - Edge之间没有RPC连接，只有UDP语音传输
 * - 所有控制信令通过Hub中转
 */

import type { HubNotificationParams } from '@munode/protocol';
import { EdgeControlClient } from './hub-client.js';
import { ReconnectManager } from './reconnect-manager.js';
import type { EdgeConfig } from '../types.js';
import type { Logger } from 'winston';

export interface ClusterIntegration {
  hubClient: EdgeControlClient;
  reconnectManager: ReconnectManager;
  isJoined: boolean;
}

export class EdgeClusterManager {
  private hubClient: EdgeControlClient;
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

    // 初始化 Hub 客户端（EdgeControlClient 封装了连接、注册、认证等完整功能）
    this.hubClient = new EdgeControlClient(this.config, this.logger);

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
      this.logger,
      {
        hubReconnectTimeout: 10000,
        hubReconnectInterval: 2000,
        rejoinDelay: 5000,
      }
    );
  }

  private setupHubClientEvents(): void {
    this.hubClient.on('connected', () => {
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
   * 
   * 注意：连接和注册由 HubClient 处理（会触发 registered/reconnected 事件）
   */
  async joinCluster(): Promise<void> {
    try {
      // 1. 连接并注册到 Hub（HubClient.connect() 会自动处理注册）
      await this.hubClient.connect();
      // 注意：不需要在这里记录 "Connected" 日志，HubClient 的事件处理器会记录
      // 也不需要再次调用 registerToHub()，因为 hubClient.connect() 已经完成了注册

      // 2. 发起 join 请求
      const joinRequest = {
         server_id: this.config.server_id,
        name: this.config.name,
        host: this.config.network.external_host || this.config.network.host,
        port: this.config.network.external_port ?? this.config.network.port,
        voicePort: this.config.network.external_port ?? this.config.network.port, // Voice port is main port
        capacity: this.config.server.capacity,
      };

      const joinResponse = await this.hubClient.call('edge.join', joinRequest);

      if (!joinResponse.success) {
        throw new Error(`Join failed: ${(joinResponse as { error?: string }).error || 'Unknown error'}`);
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
          voicePort: peer.port, // 统一UDP端口：语音和控制使用同一端口
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
  private handleHubNotification(message: { method: string; params: unknown }): void {
    switch (message.method) {
      case 'edge.peerJoined':
        void this.handlePeerJoined(message.params as HubNotificationParams<'edge.peerJoined'>);
        break;

      case 'edge.peerLeft':
        this.handlePeerLeft(message.params as { id: number });
        break;

      case 'edge.forceDisconnect':
        void this.handleForceDisconnect(message.params as HubNotificationParams<'edge.forceDisconnect'>);
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
  private handlePeerJoined(params: HubNotificationParams<'edge.peerJoined'>): void {
    this.logger.info(`New peer joined: ${JSON.stringify(params)}`);
    
    // 添加到 peers 列表
    this.peers.push({
      id: params.id,
      name: params.name,
      host: params.host,
      port: params.port,
      voicePort: params.voicePort || params.port,
    });
    
    // Edge之间不需要RPC连接
    // Peer的语音端口会在EdgeServer中注册到VoiceUDPTransport
    this.logger.info(`Peer ${params.id} ready for voice UDP communication`);
  }

  /**
   * 处理 Peer 离开
   */
  private handlePeerLeft(params: { id: number }): void {
    this.logger.info(`Peer left: ${params.id}`);
    
    // 从 peers 列表移除
    this.peers = this.peers.filter(p => p.id !== params.id);
    
    // Edge之间不需要RPC连接，无需断开
    // VoiceUDPTransport的端点会在EdgeServer中注销
  }

  /**
   * 处理强制断开
   */
  private async handleForceDisconnect(params: HubNotificationParams<'edge.forceDisconnect'>): Promise<void> {
    this.logger.warn(`Force disconnect requested: ${params.reason}`);
    await this.reconnectManager.performFullDisconnect();
  }

  /**
   * 获取集群状态
   */
  getStatus(): {
    isJoined: boolean;
    hubConnected: boolean;
    reconnectStats: ReturnType<ReconnectManager['getStats']>;
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
  disconnect(): void {
    this.logger.info('Disconnecting from cluster...');

    this.isJoined = false;
    // Edge之间没有RPC连接，无需断开peer
    this.hubClient.disconnect();

    this.logger.info('Disconnected from cluster');
  }

  /**
   * 执行冷重启（Cold Restart）
   * 
   * 完整流程：
   * 1. 断开所有客户端
   * 2. 断开所有 Peer
   * 3. 断开 Hub
   * 4. 清理本地状态
   * 5. 重新加入集群
   * 
   * 用于处理以下场景：
   * - Hub 检测到网络分区，要求边缘节点重启
   * - 会话过期需要完全重置
   */
  async performColdRestart(): Promise<void> {
    this.logger.warn('=== Performing cold restart ===');
    await this.reconnectManager.performFullDisconnect();
    this.logger.info('=== Cold restart completed ===');
  }

  /**
   * 获取 Hub 客户端（用于发送RPC调用）
   */
  getHubClient(): EdgeControlClient {
    return this.hubClient;
  }

  /**
   * 获取 peers 列表
   */
  getPeers(): Array<{ id: number; name: string; host: string; port: number; voicePort?: number }> {
    return this.peers;
  }
}
