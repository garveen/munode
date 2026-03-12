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
  private edgeUDPServer?: UDPSocket;  // Edge 间专用 UDP 服务器
  private tlsServer?: TLSServer;
  private edgeTLSServer?: TLSServer; // Edge 间连接专用 TLS 服务器
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

      // 启动 UDP 服务器（主端口，供 Mumble 客户端使用）
      await this.startUDPServer();

      // 启动 Edge 间专用 UDP 服务器（edge_port，与客户端完全隔离）
      await this.startEdgeUDPServer();

      // 启动 TLS 服务器（主端口 - 专供 Mumble 客户端连接）
      await this.startTLSServer();

      // 启动 Edge 间专用 TLS 服务器（edge_port - 专供 Edge 间 TCP/TLS 连接）
      await this.startEdgeTLSServer();

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
                  // 通知语音路由管理器已知 Edge 加入，立即设置临时直连路由
                  if (this.voiceManager) {
                    this.voiceManager.getVoiceRoutingManager().addKnownEdge(peer.id);
                  }
                  // UDP 和 TCP 都使用 voicePort（即 edge_port），不再复用客户端主端口
                  const peerEdgePort = peer.voicePort || peer.port;
                  this.voiceTransport.registerEndpoint(peer.id, peer.host, peerEdgePort, undefined, peerEdgePort);
                  this.logger.info(`Registered edge peer ${peer.id}: ${peer.host}:${peerEdgePort} (UDP+TCP on edge_port)`);
                  // 主动建立与已有 peer 的连接（避免等待对方的 peerJoined 事件）
                  void this.voiceTransport.connectToEdge(peer.id);
                  this.logger.info(`Initiated connection to existing peer ${peer.id}`);
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

      if (this.edgeUDPServer) {
        this.edgeUDPServer.removeAllListeners();
        this.edgeUDPServer.close();
        this.logger.info('Edge UDP server stopped');
      }

      if (this.tlsServer) {
        this.tlsServer.removeAllListeners();
        this.tlsServer.close();
      }

      if (this.edgeTLSServer) {
        this.edgeTLSServer.removeAllListeners();
        this.edgeTLSServer.close();
        this.logger.info('Edge TLS server stopped');
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
        // 客户端 Mumble 包，直接交给客户端处理器
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
   * 启动 Edge 间专用 UDP 服务器
   * 使用 edge_port，与 Mumble 客户端 UDP 完全隔离，无需魔数区分
   */
  private async startEdgeUDPServer(): Promise<void> {
    const edgePort = this.config.network.edge_port ?? (this.config.network.port + 1);

    return new Promise((resolve, reject) => {
      this.edgeUDPServer = createSocket('udp4');

      this.edgeUDPServer.on('message', (msg, rinfo) => {
        // 所有包都是 Edge 间通信包，直接交给 VoiceUDPTransport
        if (this.voiceTransport) {
          this.voiceTransport['handleIncomingPacket'](msg, rinfo);
        }
      });

      this.edgeUDPServer.on('error', (error) => {
        this.logger.error('Edge UDP Server error:', error);
        reject(error);
      });

      this.edgeUDPServer.bind(edgePort, this.config.network.host, () => {
        this.logger.info(
          `Edge UDP Server listening on ${this.config.network.host}:${edgePort} (dedicated Edge-to-Edge port)`
        );

        // 设置 VoiceUDPTransport 使用 Edge 专用 UDP socket 发送
        if (this.voiceTransport && this.edgeUDPServer) {
          const edgeUDPRef = this.edgeUDPServer;
          this.voiceTransport.setSendFunction((buffer, host, port) => {
            edgeUDPRef.send(buffer, port, host, (error) => {
              if (error) {
                this.logger.error('Failed to send Edge UDP packet:', error);
              }
            });
          });
          this.logger.info('VoiceUDPTransport configured with Edge-dedicated UDP socket');
        }

        resolve();
      });
    });
  }

  /**
   * 启动 Edge 间专用 TLS 服务器
   * 专供处理 Edge-to-Edge TCP/TLS 连接，与客户端完全隔离
   */
  private async startEdgeTLSServer(): Promise<void> {
    if (!this.config.tls.cert || !this.config.tls.key) {
      this.logger.warn('TLS certificates not configured, skipping Edge TLS server');
      return;
    }

    const edgePort = this.config.network.edge_port ?? (this.config.network.port + 1);

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
        requestCert: true,   // 要求对方提供客户端证书（用于识别 Edge 身份）
        rejectUnauthorized: false,
      };

      if (caData) {
        tlsOptions.ca = caData;
      }

      this.edgeTLSServer = createTLSServer(tlsOptions);

      this.edgeTLSServer.on('secureConnection', (socket: TLSSocket) => {
        void (async () => { try {
          // 获取客户端证书哈希（SHA-256 of DER，与 hub-client.ts 注册时保持一致）
          let certHash: string | undefined;
          try {
            const cert = socket.getPeerCertificate();
            if (cert && cert.raw) {
              const { createHash } = await import('crypto');
              certHash = createHash('sha256').update(cert.raw).digest('hex').toLowerCase();
            }
          } catch {
            // 证书获取失败不影响后续处理
          }

          if (!certHash) {
            this.logger.warn(
              `Rejected Edge connection from ${socket.remoteAddress}: no client certificate provided`
            );
            socket.destroy();
            return;
          }

          // 通过证书哈希识别对端 Edge
          // 允许最多 2 秒的等待，处理 peerJoined 通知比 TLS 连接晚到的竞态场景
          const resolveEdgeId = (): number | undefined =>
            this.handlerFactory.edgeServer?.getEdgeIdByCertHash(certHash);

          let edgeId = resolveEdgeId();
          if (edgeId === undefined) {
            this.logger.debug(
              `cert hash ${certHash.substring(0, 16)}... not yet registered, waiting up to 2s...`
            );
            // 轮询等待，最多 2000ms，每 100ms 查一次
            const WAIT_INTERVAL_MS = 100;
            const WAIT_MAX_MS = 2000;
            let waited = 0;
            await new Promise<void>((resolve) => {
              const poll = setInterval(() => {
                edgeId = resolveEdgeId();
                waited += WAIT_INTERVAL_MS;
                if (edgeId !== undefined || waited >= WAIT_MAX_MS) {
                  clearInterval(poll);
                  resolve();
                }
              }, WAIT_INTERVAL_MS);
            });
          }

          if (edgeId === undefined) {
            this.logger.warn(
              `Rejected Edge connection from ${socket.remoteAddress}: ` +
              `unknown cert hash ${certHash.substring(0, 16)}... (peer not registered after 2s wait)`
            );
            socket.destroy();
            return;
          }

          this.logger.info(
            `Accepting Edge-to-Edge connection from Edge ${edgeId} ` +
            `(${socket.remoteAddress}:${socket.remotePort}, cert: ${certHash.substring(0, 16)}...)`
          );

          // 直接交给 VoiceUDPTransport 处理，不经过客户端处理流程
          this.voiceTransport?.acceptIncomingEdgeConnection(socket, edgeId);
        } catch (error) {
          this.logger.error('Error handling Edge TLS connection:', error);
          socket.destroy();
        } })();
      });

      this.edgeTLSServer.on('error', (error: Error) => {
        this.logger.error('Edge TLS Server error:', error);
        reject(error);
      });

      this.edgeTLSServer.listen(edgePort, this.config.network.host, () => {
        this.logger.info(
          `Edge TLS Server listening on ${this.config.network.host}:${edgePort} (dedicated Edge-to-Edge port)`
        );
        resolve();
      });
    });
  }

  /**
   * 启动 TLS 服务器（主端口，供 Mumble 客户端连接）
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
