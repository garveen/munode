import { Server as TCPServer } from 'net';
import { createSocket, type Socket as UDPSocket } from 'dgram';
import { TLSSocket, createServer as createTLSServer, type Server as TLSServer } from 'tls';
import type { Logger } from 'winston';
import { EdgeConfig } from '../types.js';
import { EdgeClusterManager } from '../cluster/cluster-manager.js';
import { VoiceUDPTransport } from '@munode/protocol';
import { HandlerFactory } from './handler-factory.js';
import { VoiceManager } from '../managers/voice-manager.js';

/**
 * 服务器生命周期管理器
 * 负责服务器的启动、停止和相关配置
 */
export class ServerLifecycleManager {
  private config: EdgeConfig;
  private logger: Logger;
  private tcpServer?: TCPServer;
  private udpServer?: UDPSocket;
  private tlsServer?: TLSServer;
  private voiceTransport?: VoiceUDPTransport;
  private clusterManager?: EdgeClusterManager;
  private handlerFactory: HandlerFactory;
  private voiceManager?: VoiceManager;

  constructor(
    config: EdgeConfig,
    handlerFactory: HandlerFactory,
    logger: Logger,
    clusterManager: EdgeClusterManager,
    voiceTransport: VoiceUDPTransport,
    voiceManager?: VoiceManager
  ) {
    this.config = config;
    this.handlerFactory = handlerFactory;
    this.logger = logger;
    this.clusterManager = clusterManager;
    this.voiceTransport = voiceTransport;
    this.voiceManager = voiceManager;
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    try {
      this.logger.info('Starting Edge Server...');

      // 初始化可选组件
      if (this.handlerFactory.banManager) {
        await this.handlerFactory.banManager.initialize();
      }

      // 启动 UDP 服务器
      await this.startUDPServer();

      // 启动 TLS 服务器（主端口）
      await this.startTLSServer();

      // 不启动 TCP 服务器 - Mumble 客户端使用 TLS
      // await this.startTCPServer();

      this.logger.info(
        `Edge Server started successfully on ${this.config.network.host}:${this.config.network.port}`
      );

      // 启动语音 UDP 传输（如果启用）
      if (this.voiceTransport) {
        await this.voiceTransport.start();
        const voicePort = this.config.network.port + 1;
        this.logger.info(`Voice UDP transport started on port ${voicePort}`);
        
        // 设置语音传输处理器（必须在启动后立即设置）
        if (this.voiceManager) {
          this.voiceManager.setupVoiceTransportHandlers();
          this.logger.info('Voice transport handlers setup complete');
        }
      }

      // 加入集群（如果是集群模式）
      if (this.clusterManager) {
        try {
          await this.clusterManager.joinCluster();
          this.logger.info('Successfully joined cluster');

          // 尝试注册已有 peers 的语音端点（非强制，允许部分失败）
          if (this.voiceTransport) {
            const peers = this.clusterManager.getPeers();
            for (const peer of peers) {
              if (peer.id !== this.config.server_id && peer.voicePort) {
                try {
                  this.voiceTransport.registerEndpoint(peer.id, peer.host, peer.voicePort);
                  this.logger.info(`Registered voice endpoint for peer ${peer.id}: ${peer.host}:${peer.voicePort}`);
                } catch (endpointError) {
                  // 单个端点注册失败不影响其他端点
                  this.logger.warn(`Failed to register voice endpoint for peer ${peer.id}:`, endpointError);
                }
              }
            }
          }
        } catch (error) {
          this.logger.error('Failed to join cluster:', error);
          // Edge must connect to Hub - no standalone mode supported
          throw new Error('Edge server requires Hub connection to operate');
        }
      }
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
      this.logger.info('Stopping Edge Server...');

      // 停止服务器
      if (this.tcpServer) {
        this.tcpServer.close();
      }

      if (this.udpServer) {
        this.udpServer.close();
      }

      if (this.tlsServer) {
        this.tlsServer.close();
      }

      // 停止语音 UDP 传输
      if (this.voiceTransport) {
        this.voiceTransport.stop();
        this.logger.info('Voice UDP transport stopped');
      }

      // 停止集群管理器
      if (this.clusterManager) {
        await this.clusterManager.disconnect();
      }

      if (this.handlerFactory.banManager) {
        await this.handlerFactory.banManager.close();
      }

      this.logger.info('Edge Server stopped successfully');
    } catch (error) {
      this.logger.error('Failed to stop Edge Server:', error);
      throw error;
    }
  }

  /**
   * 启动 UDP 服务器
   */
  private async startUDPServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.udpServer = createSocket('udp4');

      this.udpServer.on('message', (msg, rinfo) => {
        this.handlerFactory.connectionHandlers.handleUDPMessage(msg, rinfo);
      });

      this.udpServer.on('error', (error) => {
        this.logger.error('UDP Server error:', error);
        reject(error);
      });

      this.udpServer.bind(this.config.network.port, this.config.network.host, () => {
        this.logger.info(
          `UDP Server listening on ${this.config.network.host}:${this.config.network.port}`
        );

        // 设置 VoiceRouter 的 UDP 服务器引用
        this.handlerFactory.voiceRouter.setUDPServer(this.udpServer);

        resolve();
      });
    });
  }

  /**
   * 启动 TLS 服务器
   */
  private async startTLSServer(): Promise<void> {
    if (!this.config.tls.cert || !this.config.tls.key) {
      this.logger.warn('TLS certificates not configured, skipping TLS server');
      return;
    }

    // 读取证书文件内容
    const fs = await import('fs/promises');
    const certData = await fs.readFile(this.config.tls.cert, 'utf8');
    const keyData = await fs.readFile(this.config.tls.key, 'utf8');
    const caData = this.config.tls.ca ? await fs.readFile(this.config.tls.ca, 'utf8') : undefined;

    return new Promise((resolve, reject) => {
      const tlsOptions: {
        cert: string;
        key: string;
        requestCert: boolean;
        rejectUnauthorized: boolean;
        ca?: string;
      } = {
        cert: certData,
        key: keyData,
        requestCert: true,
        rejectUnauthorized: false,
      };

      if (caData) {
        tlsOptions.ca = caData;
      }

      this.tlsServer = createTLSServer(tlsOptions);

      this.tlsServer.on('secureConnection', (socket: TLSSocket) => {
        void this.handlerFactory.connectionHandlers.handleTLSConnection(socket);
      });

      this.tlsServer.on('error', (error: Error) => {
        this.logger.error('TLS Server error:', error);
        reject(error);
      });

      this.tlsServer.listen(this.config.network.port, this.config.network.host, () => {
        this.logger.info(
          `TLS Server listening on ${this.config.network.host}:${this.config.network.port}`
        );
        resolve();
      });
    });
  }

  /**
   * 获取语音传输实例
   */
  getVoiceTransport(): VoiceUDPTransport | undefined {
    return this.voiceTransport;
  }

  /**
   * 获取 UDP socket
   */
  getUDPSocket(): UDPSocket | undefined {
    return this.udpServer;
  }
}
