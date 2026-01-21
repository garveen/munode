import { Server as TCPServer } from 'net';
import { createSocket, type Socket as UDPSocket } from 'dgram';
import * as tls from 'tls';
import { TLSSocket, createServer as createTLSServer, type Server as TLSServer } from 'tls';
import type { Logger } from 'winston';
import { EdgeConfig } from '../types.js';
import { EdgeClusterManager } from '../cluster/cluster-manager.js';
import { VoiceUDPTransport } from '@munode/protocol';
import { HandlerFactory } from './handler-factory.js';
import { VoiceManager } from '../managers/voice-manager.js';
import type { VirtualHostManager } from '../virtual-host/virtual-host-manager.js';
import { SecureContextManager } from '../virtual-host/secure-context-manager.js';

/**
 * Extended TLSSocket with SNI servername
 */
interface TLSSocketWithSNI extends TLSSocket {
  sniServername?: string;
}

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
  // 多租户支持
  private virtualHostManager?: VirtualHostManager;
  private secureContextManager?: SecureContextManager;
  // Store servername for TLS connections
  private currentServername?: string;

  constructor(
    config: EdgeConfig,
    handlerFactory: HandlerFactory,
    logger: Logger,
    clusterManager: EdgeClusterManager,
    voiceTransport: VoiceUDPTransport,
    voiceManager?: VoiceManager,
    virtualHostManager?: VirtualHostManager
  ) {
    this.config = config;
    this.handlerFactory = handlerFactory;
    this.logger = logger;
    this.clusterManager = clusterManager;
    this.voiceTransport = voiceTransport;
    this.voiceManager = voiceManager;
    this.virtualHostManager = virtualHostManager;
    
    // 如果启用多租户，初始化 SecureContextManager
    if (virtualHostManager) {
      this.secureContextManager = new SecureContextManager(logger);
    }
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

      // 设置语音传输处理器（VoiceUDPTransport 使用统一入口模式）
      if (this.voiceTransport && this.voiceManager) {
        // 不需要调用 voiceTransport.start()，它通过 setSendFunction 使用统一的 UDP 入口
        this.voiceManager.setupVoiceTransportHandlers();
        this.logger.info('Voice transport handlers setup complete (unified entry mode)');
      }

      // 加入集群（如果是集群模式）
      if (this.clusterManager) {
        try {
          await this.clusterManager.joinCluster();
          this.logger.info('Successfully joined cluster');

          // 尝试注册已有 peers 的语音端点（使用主UDP端口，非强制，允许部分失败）
          if (this.voiceTransport) {
            const peers = this.clusterManager.getPeers();
            for (const peer of peers) {
              if (peer.id !== this.config.server_id) {
                try {
                  // 使用主UDP端口（不再使用 +1）
                  const peerVoicePort = peer.voicePort || peer.port;
                  this.voiceTransport.registerEndpoint(peer.id, peer.host, peerVoicePort);
                  this.logger.info(`Registered voice endpoint for peer ${peer.id}: ${peer.host}:${peerVoicePort}`);
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
        this.tcpServer.removeAllListeners();
        this.tcpServer.close();
      }

      if (this.udpServer) {
        this.udpServer.removeAllListeners();
        this.udpServer.close();
      }

      if (this.tlsServer) {
        this.tlsServer.removeAllListeners();
        this.tlsServer.close();
      }

      // VoiceUDPTransport 不需要独立停止（使用统一入口模式）
      // 只需要清理内部状态（定时器、连接状态等）
      if (this.voiceTransport) {
        this.voiceTransport.stop();
        this.logger.info('Voice UDP transport stopped (timers and state cleared)');
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
        // 根据魔数区分客户端包和Edge间包
        if (msg.length >= 2 && msg.readUInt16BE(0) === 0x0000) {
          // Edge间通信包：前两字节是0x0000
          if (this.voiceTransport) {
            // 直接传递给VoiceUDPTransport处理（包含魔数）
            this.voiceTransport['handleIncomingPacket'](msg, rinfo);
          }
        } else {
          // 客户端Mumble包：前两字节不可能都是0x00
          this.handlerFactory.connectionHandlers.handleUDPMessage(msg, rinfo);
        }
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
        
        // 设置 VoiceUDPTransport 使用发送回调（统一入口模式）
        if (this.voiceTransport && this.udpServer) {
          const udpServerRef = this.udpServer;
          this.voiceTransport.setSendFunction((buffer, host, port) => {
            udpServerRef.send(buffer, port, host, (error) => {
              if (error) {
                this.logger.error('Failed to send UDP packet:', error);
              }
            });
          });
          this.logger.info('VoiceUDPTransport configured with send function (unified entry mode)');
        }

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

    // 多租户模式：使用 SNI 回调
    if (this.virtualHostManager && this.secureContextManager) {
      await this.startMultiTenantTLSServer();
      return;
    }

    // 单租户模式：使用默认证书
    await this.startSingleTenantTLSServer();
  }

  /**
   * 启动单租户 TLS 服务器（向后兼容）
   */
  private async startSingleTenantTLSServer(): Promise<void> {
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
   * 启动多租户 TLS 服务器（支持 SNI）
   */
  private async startMultiTenantTLSServer(): Promise<void> {
    if (!this.virtualHostManager || !this.secureContextManager) {
      throw new Error('VirtualHostManager or SecureContextManager not initialized');
    }

    // 为所有虚拟主机加载证书
    const hostNames = this.virtualHostManager.getHostNames();
    for (const hostName of hostNames) {
      const host = this.virtualHostManager.getHost(hostName);
      await this.secureContextManager.createContext(host.config);
    }

    const defaultHost = this.virtualHostManager.getDefaultHost();
    const fs = await import('fs/promises');
    const defaultCertData = await fs.readFile(defaultHost.config.tls.cert, 'utf8');
    const defaultKeyData = await fs.readFile(defaultHost.config.tls.key, 'utf8');
    const defaultCaData = defaultHost.config.tls.ca 
      ? await fs.readFile(defaultHost.config.tls.ca, 'utf8') 
      : undefined;

    return new Promise((resolve, reject) => {
      const tlsOptions = {
        cert: defaultCertData,
        key: defaultKeyData,
        ca: defaultCaData,
        requestCert: true,
        rejectUnauthorized: false,
        // SNI 回调
        SNICallback: (servername: string, callback: (err: Error | null, ctx?: tls.SecureContext) => void) => {
          this.logger.debug(`SNI callback triggered for: ${servername}`);
          
          // Store servername for the next connection
          this.currentServername = servername;
          
          const context = this.secureContextManager!.getContext(servername);
          if (context) {
            callback(null, context);
          } else {
            // 使用默认证书
            this.logger.warn(`No certificate found for ${servername}, using default`);
            callback(null);
          }
        },
      };

      this.tlsServer = createTLSServer(tlsOptions);

      this.tlsServer.on('secureConnection', (socket: TLSSocketWithSNI) => {
        // Get servername from SNI callback
        const servername = this.currentServername;
        this.logger.debug(`TLS connection from ${socket.remoteAddress}, SNI: ${servername || '(none)'}`);
        
        // Store servername in socket for handler access
        socket.sniServername = servername;
        
        // Clear current servername
        this.currentServername = undefined;
        
        void this.handlerFactory.connectionHandlers.handleTLSConnection(socket);
      });

      this.tlsServer.on('error', (error: Error) => {
        this.logger.error('TLS Server error:', error);
        reject(error);
      });

      this.tlsServer.listen(this.config.network.port, this.config.network.host, () => {
        this.logger.info(
          `Multi-tenant TLS Server listening on ${this.config.network.host}:${this.config.network.port}`
        );
        this.logger.info(`Loaded ${hostNames.length} virtual hosts: ${hostNames.join(', ')}`);
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
