import { Server as TCPServer } from 'net';
import { createSocket, type Socket as UDPSocket } from 'dgram';
import { TLSSocket, createServer as createTLSServer, type Server as TLSServer } from 'tls';
import { EventEmitter } from 'events';
import { randomFillSync } from 'crypto';
import { logger } from '@munode/common';
import { EdgeConfig, ClientInfo, ChannelInfo, ServerStats, AuthResult } from './types.js';
import { ClientManager } from './client.js';
import { ChannelManager } from './channel.js';
import { MessageHandler } from './message-handler.js';
import { MessageType } from '@munode/protocol';
import { VoiceRouter } from './voice-router.js';
import { AuthManager } from './auth-manager.js';
import { EdgeControlClient } from './edge-control-client.js';
import { BanManager } from './ban-manager.js';
import { ContextActions } from './context-actions.js';
import { GeoIPManager } from './geoip-manager.js';
import { UserCache } from './user-cache.js';
import { EdgeStateManager } from './state-manager.js';
import { PermissionManager, Permission, type ACLEntry } from '@munode/protocol';
import { EdgeClusterManager } from './cluster-manager.js';
import { VoiceUDPTransport } from '@munode/protocol/src/voice/voice-udp-transport.js';
import type { RemoteInfo } from 'dgram';
import type { ChannelData } from '@munode/protocol/src/hub-edge-types.js';
// import { PacketConnPool } from './packet-pool.js';
// import { UDPMonitor } from './udp-monitor.js';
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';


/**
 * Edge Server - Mumble 分布式服务器的边缘节点
 * 负责处理客户端连接、语音路由、频道管理等核心功能
 */
export class EdgeServer extends EventEmitter {
  private config: EdgeConfig;
  private tcpServer?: TCPServer;
  private udpServer?: UDPSocket;
  private udpAddressToSession: Map<string, number> = new Map(); // "ip:port" -> session_id
  private tlsServer?: TLSServer;

  // 核心组件
  private clientManager: ClientManager;
  private channelManager: ChannelManager;
  private messageHandler: MessageHandler;
  private voiceRouter: VoiceRouter;
  private authManager: AuthManager;
  private hubClient?: EdgeControlClient;
  private clusterManager?: EdgeClusterManager;
  private banManager: BanManager;
  private contextActions: ContextActions;
  private geoIPManager?: GeoIPManager;
  private userCache?: UserCache;
  private stateManager?: EdgeStateManager; // 内存状态管理器
  private permissionManager: PermissionManager; // 权限管理器
  private aclMap: Map<number, ACLEntry[]> = new Map(); // 频道 mumbleproto.ACL 映射
  private voiceTransport?: VoiceUDPTransport; // 语音 UDP 传输
  // private packetPool?: PacketConnPool;
  // private udpMonitor?: UDPMonitor;

  // PreConnect 用户状态 - 存储认证前客户端发送的 UserState
  private preConnectUserState: Map<number, {
    self_mute?: boolean;
    self_deaf?: boolean;
    plugin_context?: Buffer;
    plugin_identity?: string;
    comment?: string;
  }> = new Map();

  // 服务器状态
  private isRunning = false;
  private startTime: Date;
  private stats: ServerStats;

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

    // 初始化核心组件
    this.clientManager = new ClientManager(this.config, logger);
    this.channelManager = new ChannelManager(this.config, logger);
    this.messageHandler = new MessageHandler(this.config, logger);
    this.voiceRouter = new VoiceRouter(this.config, logger);
    
    // 设置 VoiceRouter 的依赖
    this.voiceRouter.setClientManager(this.clientManager);
    
    this.authManager = new AuthManager(this.config, logger, this.userCache);
    this.banManager = new BanManager(this.config.databasePath, 1024);
    this.contextActions = new ContextActions();
    this.permissionManager = new PermissionManager(logger);

    // 初始化可选组件
    if (this.config.features.geoip) {
      this.geoIPManager = new GeoIPManager(this.config, logger);
    }

    if (this.config.features.userCache) {
      this.userCache = new UserCache(this.config, logger);
    }

    // if (this.config.features.packetPool) {
    //   this.packetPool = new PacketConnPool(this.config, logger);
    // }

    // if (this.config.features.udpMonitor) {
    //   this.udpMonitor = new UDPMonitor(this.config, logger);
    // }

    this.clusterManager = new EdgeClusterManager(this.config, logger, {
      onDisconnectAllClients: () => {
        // 断开所有客户端
        const clients = this.clientManager.getAllClients();
        for (const client of clients) {
          const socket = this.clientManager.getSocket(client.session);
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
    this.stateManager = new EdgeStateManager(); // 初始化状态管理器

    // 初始化语音 UDP 传输（集群模式下启用）
    const voicePort = this.config.network.port + 1; // 使用主端口+1作为语音端口
    this.voiceTransport = new VoiceUDPTransport({
      port: voicePort,
      host: this.config.network.host,
    });

    // 设置语音包转发事件
    this.setupVoiceTransportHandlers();


    this.setupEventHandlers();
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    try {
      logger.info('Starting Edge Server...');

      // 初始化可选组件
      if (this.geoIPManager) {
        await this.geoIPManager.initialize();
      }

      if (this.userCache) {
        await this.userCache.initialize();
      }

      if (this.banManager) {
        await this.banManager.initialize();
      }

      // 启动 UDP 服务器
      await this.startUDPServer();

      // 启动 TLS 服务器（主端口）
      await this.startTLSServer();

      // 不启动 TCP 服务器 - Mumble 客户端使用 TLS
      // await this.startTCPServer();

      this.isRunning = true;
      logger.info(
        `Edge Server started successfully on ${this.config.network.host}:${this.config.network.port}`
      );

      // 启动语音 UDP 传输（如果启用）
      if (this.voiceTransport) {
        await this.voiceTransport.start();
        const voicePort = this.config.network.port + 1;
        logger.info(`Voice UDP transport started on port ${voicePort}`);
      }

      // 加入集群（如果是集群模式）
      if (this.clusterManager) {
        try {
          await this.clusterManager.joinCluster();
          logger.info('Successfully joined cluster');
          
          // 注册已有 peers 的语音端点
          if (this.voiceTransport) {
            const peers = this.clusterManager.getPeers();
            for (const peer of peers) {
              if (peer.id !== this.config.server_id && peer.voicePort) {
                this.voiceTransport.registerEndpoint(peer.id, peer.host, peer.voicePort);
                logger.info(`Registered voice endpoint for existing peer ${peer.id}: ${peer.host}:${peer.voicePort}`);
              }
            }
          }
        } catch (error) {
          logger.error('Failed to join cluster:', error);
          // 不抛出错误，允许服务器在standalone模式下运行
        }
      }

      this.emit('started');
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
      logger.info('Stopping Edge Server...');

      this.isRunning = false;

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
        logger.info('Voice UDP transport stopped');
      }

      // 停止集群管理器
      if (this.clusterManager) {
        await this.clusterManager.disconnect();
      }

      if (this.userCache) {
        await this.userCache.shutdown();
      }

      if (this.banManager) {
        await this.banManager.close();
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
   * 启动 UDP 服务器
   */
  private async startUDPServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.udpServer = createSocket('udp4');

      this.udpServer.on('message', (msg, rinfo) => {
        this.handleUDPMessage(msg, rinfo);
      });

      this.udpServer.on('error', (error) => {
        logger.error('UDP Server error:', error);
        reject(error);
      });

      this.udpServer.bind(this.config.network.port, this.config.network.host, () => {
        logger.info(
          `UDP Server listening on ${this.config.network.host}:${this.config.network.port}`
        );
        
        // 设置 VoiceRouter 的 UDP 服务器引用
        this.voiceRouter.setUDPServer(this.udpServer!);
        
        resolve();
      });
    });
  }

  /**
   * 启动 TLS 服务器
   */
  private async startTLSServer(): Promise<void> {
    if (!this.config.tls.cert || !this.config.tls.key) {
      logger.warn('TLS certificates not configured, skipping TLS server');
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
        void this.handleTLSConnection(socket);
      });

      this.tlsServer.on('error', (error: Error) => {
        logger.error('TLS Server error:', error);
        reject(error);
      });

      this.tlsServer.listen(this.config.network.port, this.config.network.host, () => {
        logger.info(
          `TLS Server listening on ${this.config.network.host}:${this.config.network.port}`
        );
        resolve();
      });
    });
  }

  /**
   * 处理 TLS 连接
   */
  private async handleTLSConnection(socket: TLSSocket): Promise<void> {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.debug(`New TLS connection from ${clientAddress}`);

    try {
      // 获取证书哈希
      let  cert_hash: string | undefined;
      try {
        const cert = socket.getPeerCertificate();
        if (cert && cert.fingerprint) {
          cert_hash = cert.fingerprint.replace(/:/g, '').toLowerCase();
        }
      } catch (error) {
        // 证书获取失败，继续处理
        logger.debug('Failed to get peer certificate:', error);
      }

      // 检查封禁
      const banCheck = await this.banManager.checkConnection(socket.remoteAddress, cert_hash);
      if (banCheck.banned) {
        logger.warn(
          `Rejected TLS connection from banned client: ${socket.remoteAddress}, cert: ${cert_hash?.substring(0, 8)}..., reason: ${banCheck.reason}`
        );
        socket.destroy();
        return;
      }

      // 在集群模式下，从 Hub 分配 session ID
      let sessionId: number;
      try {
        sessionId = await this.hubClient.allocateSessionId();
        logger.debug(`Allocated session ID ${sessionId} from Hub for ${clientAddress}`);
      } catch (error) {
        logger.error('Failed to allocate session ID from Hub:', error);
        socket.destroy();
        return;
        }

      // 创建客户端（使用从 Hub 分配的 session ID）
      this.clientManager.createClient(socket, sessionId);
    } catch (error) {
      logger.error('Error handling TLS connection:', error);
      socket.destroy();
    }
  }

  /**
   * 处理 UDP 消息
   * 实现类似Go版本的UDP地址匹配逻辑：
   * 1. 首先查找精确的IP:Port映射
   * 2. 如果没有，尝试用同一IP的所有客户端的密钥解密
   * 3. 解密成功的就是正确的客户端，记录其UDP地址
   */
  private handleUDPMessage(msg: Buffer, rinfo: RemoteInfo): void {
    const addressKey = `${rinfo.address}:${rinfo.port}`;
    let session_id: number | undefined;
    let needsUpdate = false;
    let alreadyDecrypted = false; // 标记是否已经解密过
    
    // 1. 首先查找精确的IP:Port映射
    session_id = this.udpAddressToSession.get(addressKey);
    
    if (!session_id) {
      // 2. 没有精确映射，尝试匹配同一IP的客户端
      logger.debug(`No UDP mapping for ${addressKey}, trying to match by IP and decryption`);
      
      const clients = this.clientManager.getAllClients();
      let matchedClient: ClientInfo | null = null;

      for (const client of clients) {
        // 只尝试已认证且来自同一IP的客户端
        if (client.user_id <= 0 || client.ip_address !== rinfo.address) {
          continue;
        }

        // 尝试用该客户端的密钥解密
        const crypto = this.voiceRouter.getClientCrypto(client.session);
        if (!crypto) {
          continue;
        }

        try {
          const decrypted = crypto.decrypt(msg);
          if (decrypted.valid) {
            // ✅ 解密成功！这就是我们要找的客户端
            // 注意：此时 crypto 的 decryptIV 已经被修改了
            // 所以后续不应该再次调用 decrypt
            matchedClient = client;
            alreadyDecrypted = true;
            logger.info(`UDP address matched by decryption: ${addressKey} -> session ${client.session} (${client.username})`);
            break;
          }
        } catch (error) {
          // 解密失败，继续尝试下一个客户端
          logger.debug(`Failed to decrypt UDP packet with client ${client.session} key`);
        }
      }

      if (!matchedClient) {
        logger.warn(`Unable to match any client for UDP address: ${addressKey}`);
        return;
      }

      // 3. 找到匹配的客户端，建立映射
      session_id = matchedClient.session;
      needsUpdate = true;
    }
    
    // 4. 检查客户端的 UDP 地址是否需要更新
    // Go 实现：每次成功接收 UDP 包都会更新 client.udpaddr
    // 这样可以处理 NAT 端口变化的情况
    // 注意：现在只在接收 UDP Ping 时才更新 UDP 地址信息
    const client = this.clientManager.getClient(session_id);
    if (client && (client.udp_ip !== rinfo.address || client.udp_port !== rinfo.port)) {
      needsUpdate = true;
      logger.info(`UDP address changed for session ${session_id}: ${client.udp_ip}:${client.udp_port} -> ${rinfo.address}:${rinfo.port}`);
    }
    
    // 5. 更新映射和客户端信息（如果需要）
    if (needsUpdate) {
      // 如果客户端之前有不同的 UDP 地址，移除旧映射
      if (client && client.udp_ip && client.udp_port) {
        const oldAddressKey = `${client.udp_ip}:${client.udp_port}`;
        this.udpAddressToSession.delete(oldAddressKey);
      }
      
      // 建立新映射
      this.udpAddressToSession.set(addressKey, session_id);
      
      // 更新客户端的 UDP 地址信息
      this.clientManager.updateClient(session_id, {
        udp_ip: rinfo.address,
        udp_port: rinfo.port,
      });
      
      logger.debug(`Updated UDP mapping: ${addressKey} -> session ${session_id}`);
    }
    
    // 6. 转发消息到 VoiceRouter
    // 如果在匹配阶段已经解密过，通知 VoiceRouter 跳过解密
    this.voiceRouter.handleUDPPacket(session_id, msg, rinfo, alreadyDecrypted);
  }

  /**
   * 处理封禁列表查询
   */
  private async handleBanListQuery(session_id: number): Promise<void> {
    try {
      // 检查权限 - 只有管理员可以查询封禁列表
      const client = this.clientManager.getClient(session_id);
      if (!client || !this.checkAdminPermission(client)) {
        this.sendPermissionDenied(session_id, 'ban', 'Permission denied: admin required');
        return;
      }

      // 获取所有活跃封禁
      const bans = await this.banManager.getAllActiveBans();

      // 转换为协议格式
      const banEntries = bans.map((ban) => new mumbleproto.BanList.BanEntry({
        address: ban.address ? Buffer.from(ban.address) : Buffer.alloc(0),
        mask: ban.mask || 32,
        name: ban.name || undefined,
        hash: ban.hash || undefined,
        reason: ban.reason || undefined,
        start: ban.startDate.toISOString(),
        duration: ban.duration || undefined,
      }));

      // 发送封禁列表
      const banListMessage = Buffer.from(new mumbleproto.BanList({ bans: banEntries }).serialize());
      this.messageHandler.sendMessage(session_id, MessageType.BanList, banListMessage); 

      logger.info(`Sent ban list to session ${session_id}: ${bans.length} bans`);
    } catch (error) {
      logger.error('Error handling ban list query:', error);
      this.sendPermissionDenied(session_id, 'ban', 'Internal error');
    }
  }

  /**
   * 处理封禁列表更新（添加/移除封禁）
   */
  private async handleBanListUpdate(
     session_id: number,
    banEntries: Array<{
      address?: Buffer;
      mask?: number;
      hash?: string;
      name?: string;
      reason?: string;
      start?: number;
      duration?: number;
    }>
  ): Promise<void> {
    try {
      // 检查权限
      const client = this.clientManager.getClient(session_id);
      if (!client || !this.checkAdminPermission(client)) {
        this.sendPermissionDenied(session_id, 'ban', 'Permission denied: admin required');
        return;
      }

      for (const entry of banEntries) {
        try {
          if (entry.address && entry.address.length > 0) {
            // IP 封禁
            const ipAddress = entry.address.toString();
            const banId = await this.banManager.addBan({
              address: ipAddress,
              mask: entry.mask || 32,
              reason: entry.reason || 'Banned by admin',
              startDate: entry.start ? new Date(entry.start) : new Date(),
              duration: entry.duration || 0,
              createdBy: client.username,
            });
            logger.info(`Admin ${client.username} banned IP ${ipAddress} (ID: ${banId})`);
          } else if (entry.hash) {
            // 证书封禁
            const banId = await this.banManager.addBan({
              hash: entry.hash,
              reason: entry.reason || 'Certificate banned by admin',
              startDate: entry.start ? new Date(entry.start) : new Date(),
              duration: entry.duration || 0,
              createdBy: client.username,
            });
            logger.info(
              `Admin ${client.username} banned certificate ${entry.hash.substring(0, 8)}... (ID: ${banId})`
            );
          } else if (entry.name) {
            // 用户封禁
            const banId = await this.banManager.addBan({
              name: entry.name,
              reason: entry.reason || 'User banned by admin',
              startDate: entry.start ? new Date(entry.start) : new Date(),
              duration: entry.duration || 0,
              createdBy: client.username,
            });
            logger.info(`Admin ${client.username} banned user ${entry.name} (ID: ${banId})`);
          }
        } catch (error) {
          logger.error('Error processing ban entry:', error);
        }
      }

      // 重新发送更新后的封禁列表
      await this.handleBanListQuery(session_id);
    } catch (error) {
      logger.error('Error handling ban list update:', error);
      this.sendPermissionDenied(session_id, 'ban', 'Internal error');
    }
  }

  /**
   * 检查管理员权限
   */
  private checkAdminPermission(client: ClientInfo): boolean {
    // 检查是否有管理员组
    return (
      client.groups && (client.groups.includes('admin') || client.groups.includes('superuser'))
    );
  }

  /**
   * 检查用户在频道中的权限
   */
  private hasPermission(client: ClientInfo, channel: ChannelInfo, permission: Permission): boolean {
    const channelTree = this.channelManager.getChannelTree();
    return this.permissionManager.hasPermission(
      channel,
      client,
      permission,
      channelTree,
      this.aclMap
    );
  }

  /**
   * 发送权限拒绝消息
   */
  private sendPermissionDenied(
     session_id: number,
    permission: string,
    reason: string,
    channel_id?: number,
    type?: number
  ): void {
    try {
      // 构建 mumbleproto.PermissionDenied 消息
      const permissionDenied = {
        reason: reason,
        session: session_id,
        type: type,
        permission: undefined as number | undefined,
        channel_id: channel_id,
      };

      // 设置 DenyType
      if (type !== undefined) {
        permissionDenied.type = type;
      } else if (permission === 'Text' || permission === 'text') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.Text;
      } else if (permission === 'SuperUser' || permission === 'superuser') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.SuperUser;
      } else if (permission === 'ChannelName' || permission === 'channel_name') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.ChannelName;
      } else if (permission === 'TextTooLong' || permission === 'text_too_long') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.TextTooLong;
      } else if (permission === 'TemporaryChannel' || permission === 'temporary_channel') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.TemporaryChannel;
      } else if (permission === 'MissingCertificate' || permission === 'missing_certificate') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.MissingCertificate;
      } else if (permission === 'UserName' || permission === 'username') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.UserName;
      } else if (permission === 'ChannelFull' || permission === 'channel_full') {
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.ChannelFull;
      } else {
        // 默认为 Permission 类型
        permissionDenied.type = mumbleproto.PermissionDenied.DenyType.Permission;

        // 尝试将权限字符串转换为权限位
        const permissionMap: { [key: string]: Permission } = {
          write: Permission.Write,
          traverse: Permission.Traverse,
          enter: Permission.Enter,
          speak: Permission.Speak,
          mutedeafen: Permission.MuteDeafen,
          move: Permission.Move,
          make_channel: Permission.MakeChannel,
          link_channel: Permission.LinkChannel,
          whisper: Permission.Whisper,
          text_message: Permission.TextMessage,
          temp_channel: Permission.TempChannel,
          kick: Permission.Kick,
          ban: Permission.Ban,
          register: Permission.Register,
          self_register: Permission.SelfRegister,
        };

        const permissionBit = permissionMap[permission.toLowerCase()];
        if (permissionBit !== undefined) {
          permissionDenied.permission = permissionBit;
        }
      }

      // 设置频道ID（如果提供）
      if (channel_id !== undefined) {
        permissionDenied.channel_id = channel_id;
      }

      // 编码并发送消息
      const message = new mumbleproto.PermissionDenied(permissionDenied).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.PermissionDenied, Buffer.from(message)); 

      logger.warn(
        `Permission denied for session ${session_id}: type=${permissionDenied.type}, permission=${permission}, reason=${reason}, channel=${channel_id || 'N/A'}`
      );
    } catch (error) {
      logger.error(`Error sending mumbleproto.PermissionDenied to session ${session_id}:`, error);
    }
  }

  /**
   * 发送 mumbleproto.ContextActionModify 消息
   */
  private sendContextActionModify(session_id: number, message: mumbleproto.ContextActionModify): void {
    try {
      const messageData = Buffer.from(new mumbleproto.ContextActionModify(message).serialize());
      this.messageHandler.sendMessage(session_id, MessageType.ContextActionModify, messageData); 
    } catch (error) {
      logger.error('Error sending mumbleproto.ContextActionModify:', error);
    }
  }

  /**
   * 处理批量移动频道成员
   */
  private handleMoveChannelMembers(
    actorSession: number,
    fromChannel: number,
    toChannel: number
  ): void {
    // 获取执行动作的客户端
    const actorClient = this.clientManager.getClient(actorSession);
    if (!actorClient) {
      logger.warn(`Unknown actor session: ${actorSession}`);
      return;
    }

    // 获取源频道的所有成员
    const members = this.clientManager.getClientsInChannel(fromChannel);
    let movedCount = 0;

    for (const member of members) {
      // 检查是否可以移动（不移动自己）
      if (member.session !== actorSession) {
        try {
          this.clientManager.moveClient(member.session, toChannel);
          movedCount++;
        } catch (error) {
          logger.error(`Failed to move client ${member.session} to channel ${toChannel}:`, error);
        }
      }
    }

    logger.info(
      `User ${actorClient.username} moved ${movedCount} members from channel ${fromChannel} to ${toChannel}`
    );
  }

  /**
   * 处理设置混杂模式
   */
  private handleSetPromiscuousMode(session_id: number, enabled: boolean): void {
    const client = this.clientManager.getClient(session_id);
    if (!client) {
      logger.warn(`Unknown client session: ${session_id}`);
      return;
    }

    // 设置客户端的混杂模式
    client.promiscuous_mode = enabled;

    // 如果启用混杂模式，客户端将接收所有频道的语音
    // 如果禁用，则只接收当前频道的语音

    logger.info(`Set promiscuous mode for ${client.username}: ${enabled}`);
  }

  /**
   * 处理清除用户缓存
   */
  private handleClearUserCache(session_id: number): void {
    // 清除用户相关的缓存
    if (this.userCache) {
      this.userCache.clearUserCache(session_id);
    }

    logger.debug(`Cleared cache for session ${session_id}`);
  }

  /**
   * 处理上下文动作消息
   */
  private async handleContextAction(session_id: number, data: Buffer): Promise<void> {
    try {
      const message = mumbleproto.ContextAction.deserialize(data);
      await this.contextActions.handleContextAction(session_id, message);
    } catch (error) {
      logger.error('Error handling ContextAction:', error);
    }
  }

  /**
   * 处理上下文动作修改消息
   */
  private handleContextActionModify(session_id: number, data: Buffer): void {
    try {
      const message = mumbleproto.ContextActionModify.deserialize(data);
      // mumbleproto.ContextActionModify 消息通常由客户端发送来修改菜单
      // 这里可以处理客户端的菜单修改请求
      logger.debug(`mumbleproto.ContextActionModify from session ${session_id}:`, message);
    } catch (error) {
      logger.error('Error handling mumbleproto.ContextActionModify:', error);
    }
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // 消息处理器事件
    this.messageHandler.on(
      'sendMessage',
      (session_id: number, messageType: number, messageData: Buffer) => {
        this.sendMessageToClient(session_id, messageType, messageData);
      }
    );

    this.messageHandler.on('version', (session_id: number, data: Buffer) => {
      this.handleVersion(session_id, data);
    });

    this.messageHandler.on('authenticate', (session_id: number, data: Buffer) => {
      void this.handleAuthenticate(session_id, data);
    });

    this.messageHandler.on('ping', (session_id: number, data: Buffer) => {
      this.handlePing(session_id, data);
    });

    this.messageHandler.on('banListQuery', (session_id: number) => {
      void this.handleBanListQuery(session_id);
    });

    this.messageHandler.on(
      'banListUpdate',
      (
         session_id: number,
        bans: Array<{
          address?: Buffer;
          mask?: number;
          hash?: string;
          name?: string;
          reason?: string;
          start?: number;
          duration?: number;
        }>
      ) => {
        void this.handleBanListUpdate(session_id, bans);
      }
    );

    // mumbleproto.UserState 事件
    this.messageHandler.on('userState', (session_id: number, data: Buffer) => {
      this.handleUserState(session_id, data);
    });

    // mumbleproto.UserRemove 事件（踢出/封禁）
    this.messageHandler.on('userRemove', (session_id: number, data: Buffer) => {
      void this.handleUserRemove(session_id, data);
    });

    // mumbleproto.ChannelState 事件（频道创建/编辑）
    this.messageHandler.on('channelState', (session_id: number, data: Buffer) => {
      void this.handleChannelState(session_id, data);
    });

    // mumbleproto.ChannelRemove 事件（频道删除）
    this.messageHandler.on('channelRemove', (session_id: number, data: Buffer) => {
      void this.handleChannelRemove(session_id, data);
    });

    // mumbleproto.ACL 事件
    this.messageHandler.on('acl', (session_id: number, data: Buffer) => {
      void this.handleACL(session_id, data);
    });

    // TextMessage 事件
    this.messageHandler.on('textMessage', (session_id: number, data: Buffer) => {
      void this.handleTextMessage(session_id, data);
    });

    // PermissionQuery 事件
    this.messageHandler.on('permissionQuery', (session_id: number, data: Buffer) => {
      void this.handlePermissionQuery(session_id, data);
    });

    // CryptSetup 事件
    this.messageHandler.on('cryptSetup', (session_id: number, data: Buffer) => {
      void this.handleCryptSetup(session_id, data);
    });

    // QueryUsers 事件
    this.messageHandler.on('queryUsers', (session_id: number, data: Buffer) => {
      void this.handleQueryUsers(session_id, data);
    });

    // UserStats 事件
    this.messageHandler.on('userStats', (session_id: number, data: Buffer) => {
      void this.handleUserStats(session_id, data);
    });

    // VoiceTarget 事件
    this.messageHandler.on('voiceTarget', (session_id: number, data: Buffer) => {
      void this.handleVoiceTarget(session_id, data);
    });

    // RequestBlob 事件
    this.messageHandler.on('requestBlob', (session_id: number, data: Buffer) => {
      void this.handleRequestBlob(session_id, data);
    });

    // UserList 事件
    this.messageHandler.on('userList', (session_id: number, data: Buffer) => {
      void this.handleUserList(session_id, data);
    });

    // Context Actions 事件
    this.messageHandler.on('contextAction', (session_id: number, data: Buffer) => {
      void this.handleContextAction(session_id, data);
    });

    this.messageHandler.on('contextActionModify', (session_id: number, data: Buffer) => {
      this.handleContextActionModify(session_id, data);
    });

    // ContextActions 组件事件
    this.contextActions.on(
      'sendContextActionModify',
      (session_id: number, message: mumbleproto.ContextActionModify) => {
        this.sendContextActionModify(session_id, message);
      }
    );

    this.contextActions.on(
      'moveChannelMembers',
      (actorSession: number, fromChannel: number, toChannel: number) => {
        this.handleMoveChannelMembers(actorSession, fromChannel, toChannel);
      }
    );

    this.contextActions.on('setPromiscuousMode', (session_id: number, enabled: boolean) => {
      this.handleSetPromiscuousMode(session_id, enabled);
    });

    this.contextActions.on('clearUserCache', (session_id: number) => {
      this.handleClearUserCache(session_id);
    });

    this.contextActions.on('permissionDenied', (session_id: number, reason: string) => {
      this.sendPermissionDenied(session_id, 'contextAction', reason);
    });

    // 客户端事件
    this.clientManager.on('clientConnected', (client) => {
      this.emit('clientConnected', client);
      // 不要在这里发送版本信息，等待客户端先发送 Version 消息
      // this.sendServerVersion(client.session);
    });

    this.clientManager.on('clientData', (session_id: number, data: Buffer) => {
      // 解析 Mumble 协议消息
      this.parseAndHandleMessage(session_id, data);
    });

    this.clientManager.on('clientDisconnected', (client: ClientInfo) => {
      this.emit('clientDisconnected', client);

      // 清理 PreConnect 状态（如果存在）
      this.preConnectUserState.delete(client.session);

      // 清理语音路由器的客户端加密状态
      this.voiceRouter.removeClientCrypto(client.session);

      // 清理UDP地址映射
      for (const [address, session_id] of this.udpAddressToSession) {
        if (session_id === client.session) {
          this.udpAddressToSession.delete(address);
          break;
        }
      }

      // 在集群模式下，通知Hub用户已离开
      if (this.config.mode === 'cluster' && this.hubClient && client.user_id > 0) {
        // 通知Hub用户离开（Hub会广播给所有Edge，包括本Edge）
        this.hubClient.notify('hub.userLeft', {
          session_id: client.session,
          edge_id: this.config.server_id,
          user_id: client.user_id,
          username: client.username,
        });

        logger.info(`User ${client.username} (session ${client.session}) left, notified Hub for broadcast`);
      }
    });

    this.clientManager.on(
      'clientMoved',
      (client: ClientInfo, oldchannel_id: number, newchannel_id: number) => {
        // 频道移动的广播由 handleUserState 统一处理
        // 这里只记录日志
        if (client.user_id > 0) {
          logger.debug(
            `Client ${client.username} moved from channel ${oldchannel_id} to ${newchannel_id}`
          );
        }
      }
    );

    // 语音事件
    this.voiceRouter.on('voicePacket', (packet) => {
      this.emit('voicePacket', packet);
    });

    // Hub 事件
    if (this.hubClient) {
      this.hubClient.on('connected', () => {
        void (async () => {
          logger.info('Connected to Hub Server');

          // 加载频道和ACL数据
          await this.loadDataFromHub();

          // 连接成功后立即请求完整同步
          if (this.stateManager && this.config.mode === 'cluster') {
            try {
              logger.info('Requesting full sync from Hub...');
              const syncData = await this.hubClient.requestFullSync();
              // 处理同步数据
              this.stateManager.loadSnapshot(syncData);
              logger.info('Full sync completed successfully');
            } catch (error) {
              logger.error('Failed to sync with Hub:', error);
            }
          }
          
          // Edge的语音端口注册会在Hub通知时处理（edgeJoined事件）
          // 无需在这里手动注册
        })();
      });

      this.hubClient.on('disconnected', () => {
        logger.warn('Disconnected from Hub Server');
      });

      this.hubClient.on('error', (error) => {
        logger.error('Hub client error:', error);
      });

      this.hubClient.on('registered', (response) => {
        logger.info('Successfully registered with Hub:', response);
      });

      this.hubClient.on('heartbeat', (response) => {
        logger.debug('Hub heartbeat response:', response);
      });

      this.hubClient.on('heartbeatFailed', (error) => {
        logger.warn('Hub heartbeat failed:', error);
      });

      this.hubClient.on('sessionUpdate', (data) => {
        logger.debug('Session update:', data);
      });

      this.hubClient.on('voiceTargetUpdate', (data) => {
        logger.debug('Voice target update:', data);
      });

      this.hubClient.on('voiceData', (data, respond) => {
        // 处理来自Hub的语音数据路由
        this.handleVoiceDataFromHub(data, respond);
      });

      // 监听来自Hub的所有通知消息（合并多个监听器）
      this.hubClient.on('notification', (message) => {
        // 处理集群事件
        if (message.method === 'edge.peerJoined') {
          const data = message.params;
          logger.info('Edge joined cluster:', data);
          
          // 注册新Edge的语音端口
          if (this.voiceTransport && data.voicePort && data.id !== this.config.server_id) {
            this.voiceTransport.registerEndpoint(data.id, data.host, data.voicePort);
            logger.info(`Registered voice endpoint for new Edge ${data.id}: ${data.host}:${data.voicePort}`);
          }
        } else if (message.method === 'edge.peerLeft') {
          const data = message.params;
          logger.info('Edge left cluster:', data);
          
          // 移除该Edge的语音端口注册
          if (this.voiceTransport && data.id) {
            this.voiceTransport.unregisterEndpoint(data.id);
            logger.info(`Unregistered voice endpoint for Edge ${data.id}`);
          }
        }
        // 处理用户事件
        else if (message.method === 'hub.userJoined') {
          this.handleRemoteUserJoined(message.params);
        } else if (message.method === 'hub.userLeft') {
          this.handleRemoteUserLeft(message.params);
        } else if (message.method === 'hub.userStateChanged') {
          this.handleRemoteUserStateChanged(message.params);
        } else if (message.method === 'hub.userStateBroadcast') {
          // 新的UserState广播处理
          this.handleUserStateBroadcastFromHub(message.params);
        } else if (message.method === 'hub.userStateResponse') {
          // Hub对UserState请求的响应
          this.handleUserStateResponseFromHub(message.params);
        } else if (message.method === 'hub.channelStateBroadcast') {
          // ChannelState广播处理
          this.handleChannelStateBroadcastFromHub(message.params);
        } else if (message.method === 'hub.channelStateResponse') {
          // Hub对ChannelState请求的响应
          this.handleChannelStateResponseFromHub(message.params);
        } else if (message.method === 'hub.userRemoveBroadcast') {
          // UserRemove广播处理
          this.handleUserRemoveBroadcastFromHub(message.params);
        } else if (message.method === 'hub.userRemoveResponse') {
          // Hub对UserRemove请求的响应
          this.handleUserRemoveResponseFromHub(message.params);
        } else if (message.method === 'hub.channelRemoveBroadcast') {
          // ChannelRemove广播处理
          this.handleChannelRemoveBroadcastFromHub(message.params);
        } else if (message.method === 'hub.channelRemoveResponse') {
          // Hub对ChannelRemove请求的响应
          this.handleChannelRemoveResponseFromHub(message.params);
        } else if (message.method === 'hub.textMessageBroadcast') {
          // TextMessage广播处理
          this.handleTextMessageBroadcastFromHub(message.params);
        } else if (message.method === 'edge.aclUpdated') {
          // ACL更新通知 - 触发权限刷新
          this.handleACLUpdatedNotification(message.params);
        }
      });
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
   * 处理用户认证
   */
  private async handleAuthenticate(session_id: number, data: Buffer): Promise<void> {
    try {
      // 解析认证消息
      const authMessage = mumbleproto.Authenticate.deserialize(data);
      const client = this.clientManager.getClient(session_id);

      if (!client) {
        logger.warn(`Authentication attempt for unknown session: ${session_id}`);
        return;
      }

      // 检查是否已经认证（通过 username 判断，而不是 user_id）
      if (client.username) {
        logger.warn(`Session ${session_id} already authenticated`);
        this.sendReject(session_id, 'Already authenticated');
        return;
      }

      // 调用认证管理器
      const authResult = await this.authManager.authenticate(
        session_id,
        authMessage.username || '',
        authMessage.password || '',
        authMessage.tokens || []
      );

      if (authResult.success) {
        // 认证成功
        this.handleAuthSuccess(session_id, client, authResult, authMessage);
      } else {
        // 认证失败
        this.handleAuthFailure(
          session_id,
          authResult.reason || 'Authentication failed',
          authResult.rejectType || mumbleproto.Reject.RejectType.None
        );
      }
    } catch (error) {
      logger.error(`Authentication error for session ${session_id}:`, error);
      this.sendReject(session_id, 'Internal authentication error', mumbleproto.Reject.RejectType.None);
    }
  }

  /**
   * 处理 Ping 消息
   */
  private handlePing(session_id: number, data: Buffer): void {
    try {
      const ping = mumbleproto.Ping.deserialize(data);
      const client = this.clientManager.getClient(session_id);

      if (!client) {
        logger.warn(`Ping from unknown session: ${session_id}`);
        return;
      }

      // 更新最后 ping 时间
      client.last_ping = Date.now();

      // 更新远端统计（从客户端的Ping消息中读取客户端的接收统计）
      // 参照 Go 实现：message.go handlePingMessage 第116-127行
      // 这些字段表示客户端接收服务器数据包的统计
      if (client.crypt && ping.good !== undefined) {
        client.crypt.remoteStats.good = ping.good;
      }
      if (client.crypt && ping.late !== undefined) {
        client.crypt.remoteStats.late = ping.late;
      }
      if (client.crypt && ping.lost !== undefined) {
        client.crypt.remoteStats.lost = ping.lost;
      }
      if (client.crypt && ping.resync !== undefined) {
        client.crypt.remoteStats.resync = ping.resync;
      }

      // 回复 ping 消息，包含服务器端的接收统计（服务器接收客户端包的统计）
      // 参照 Go 实现：message.go 第129-136行
      const pongMessage = new mumbleproto.Ping({
        timestamp: ping.timestamp,
        // 返回服务端的本地接收统计（localStats）
        good: client.crypt?.localStats.good ?? 0,
        late: client.crypt?.localStats.late ?? 0,
        lost: client.crypt?.localStats.lost ?? 0,
        resync: client.crypt?.localStats.resync ?? 0,
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.Ping, Buffer.from(pongMessage)); 

      logger.debug(
        `Handled ping from session ${session_id}, ` +
        `local(receive): good=${client.crypt?.localStats.good ?? 0}, ` +
        `late=${client.crypt?.localStats.late ?? 0}, ` +
        `lost=${client.crypt?.localStats.lost ?? 0}, ` +
        `resync=${client.crypt?.localStats.resync ?? 0}, ` +
        `remote(client receive): good=${client.crypt?.remoteStats.good ?? 0}, ` +
        `late=${client.crypt?.remoteStats.late ?? 0}, ` +
        `lost=${client.crypt?.remoteStats.lost ?? 0}, ` +
        `resync=${client.crypt?.remoteStats.resync ?? 0}`
      );
    } catch (error) {
      logger.error(`Error handling ping for session ${session_id}:`, error);
    }
  }

  /**
   * 处理用户状态变更消息
   * 
   * 架构说明：Edge仅负责转发到Hub，所有业务逻辑在Hub处理
   * Hub处理完成后会广播给所有Edge（包括发起请求的Edge）
   * 
   * 注意：不再支持独立模式，必须连接到Hub才能工作
   * 
   * PreConnectUserState: 允许客户端在认证前设置初始状态（自我静音/自我耳聋等）
   * 参照 Go 实现：message.go:583-618
   */
  private handleUserState(session_id: number, data: Buffer): void {
    try {
      const userState = mumbleproto.UserState.deserialize(data);

      // 获取执行操作的客户端（actor）
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.UserState from unknown session: ${session_id}`);
        return;
      }

      // PreConnectUserState: 处理认证前的状态设置
      if (!actor.user_id || actor.user_id <= 0) {
        // 客户端未认证，保存 PreConnect 状态
        const preState: {
          self_mute?: boolean;
          self_deaf?: boolean;
          plugin_context?: Buffer;
          plugin_identity?: string;
          comment?: string;
        } = {};

        // 只保存允许在认证前设置的字段
        if (userState.has_self_mute) {
          preState.self_mute = userState.self_mute;
        }
        if (userState.has_self_deaf) {
          preState.self_deaf = userState.self_deaf;
        }
        if (userState.has_plugin_context) {
          preState.plugin_context = Buffer.from(userState.plugin_context);
        }
        if (userState.has_plugin_identity) {
          preState.plugin_identity = userState.plugin_identity;
        }
        if (userState.has_comment) {
          preState.comment = userState.comment;
        }

        // 保存 PreConnect 状态
        if (Object.keys(preState).length > 0) {
          this.preConnectUserState.set(session_id, preState);
          logger.debug(`Saved PreConnectUserState for session ${session_id}: ${Object.keys(preState).join(', ')}`);
        }
        
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('UserState rejected: Hub client not available (standalone mode not supported)');
        this.sendPermissionDenied(session_id, 'connection', 'Server must be connected to Hub');
        return;
      }

      // 设置actor信息
      userState.actor = session_id;
      
      // 如果没有指定target session，默认为自己
      if (!userState.session || userState.session === 0) {
        userState.session = session_id;
      }

      // 只转发实际设置的字段，避免发送默认值
      // 参考Edge废弃实现：只检查has_xxx来确定字段是否真正存在
      const userStateToSend: any = {
        session: userState.session,
        actor: userState.actor,
      };

      // 只包含实际设置的字段
      if (userState.has_channel_id) {
        userStateToSend.channel_id = userState.channel_id;
      }
      if (userState.has_self_mute) {
        userStateToSend.self_mute = userState.self_mute;
      }
      if (userState.has_self_deaf) {
        userStateToSend.self_deaf = userState.self_deaf;
      }
      if (userState.has_mute) {
        userStateToSend.mute = userState.mute;
      }
      if (userState.has_deaf) {
        userStateToSend.deaf = userState.deaf;
      }
      if (userState.has_suppress) {
        userStateToSend.suppress = userState.suppress;
      }
      if (userState.has_priority_speaker) {
        userStateToSend.priority_speaker = userState.priority_speaker;
      }
      if (userState.has_recording) {
        userStateToSend.recording = userState.recording;
      }
      if (userState.has_comment) {
        userStateToSend.comment = userState.comment;
      }
      if (userState.has_texture) {
        userStateToSend.texture = userState.texture;
      }
      if (userState.has_plugin_context) {
        userStateToSend.plugin_context = userState.plugin_context;
      }
      if (userState.has_plugin_identity) {
        userStateToSend.plugin_identity = userState.plugin_identity;
      }
      
      // 处理 blob 字段（texture 和 comment）
      // 如果客户端发送了texture或comment数据，需要上传到Hub blob存储
      if (userState.has_texture && userState.texture && userState.texture.length > 0) {
        // 异步上传texture到Hub，不阻塞当前处理
        this.uploadUserTexture(actor.user_id!, userState.texture).catch(error => {
          logger.error(`Failed to upload texture for user ${actor.user_id}:`, error);
        });
      }

      if (userState.has_comment && userState.comment && userState.comment.length > 128) {
        // 如果comment超过128字节，上传到blob存储
        // 参考 Go 实现：小于128字节的comment直接存储在消息中
        this.uploadUserComment(actor.user_id!, Buffer.from(userState.comment, 'utf-8')).catch(error => {
          logger.error(`Failed to upload comment for user ${actor.user_id}:`, error);
        });
      }
      
      // 处理监听频道
      if (userState.listening_channel_add && userState.listening_channel_add.length > 0) {
        userStateToSend.listening_channel_add = userState.listening_channel_add;
      }
      if (userState.listening_channel_remove && userState.listening_channel_remove.length > 0) {
        userStateToSend.listening_channel_remove = userState.listening_channel_remove;
      }

      // 转发到Hub（使用notification，因为不需要等待响应）
      this.hubClient.notify('hub.handleUserState', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        userState: userStateToSend,
      });

      logger.debug(`Forwarded UserState from session ${session_id} to Hub, fields: ${Object.keys(userStateToSend).filter(k => k !== 'session' && k !== 'actor').join(', ')}`);
    } catch (error) {
      logger.error(`Error handling mumbleproto.UserState for session ${session_id}:`, error);
    }
  }

  /**
   * 处理来自Hub的UserState广播
   * Hub已经处理了业务逻辑，Edge只需要更新本地镜像并转发给客户端
   */
  private handleUserStateBroadcastFromHub(params: any): void {
    try {
      logger.info(`Edge: Received UserState broadcast from Hub: ${JSON.stringify(params)}`);
      
      const { session_id, edge_id, userState: userStateObj } = params;

      // 重构UserState对象，只包含实际存在的字段
      // 参考Edge废弃实现：避免设置undefined字段，防止客户端显示不必要的消息
      const userStateInit: any = {
        session: userStateObj.session || session_id,
        actor: userStateObj.actor,
      };
      
      // 只设置实际存在的字段
      if (userStateObj.name !== undefined) {
        userStateInit.name = userStateObj.name;
      }
      if (userStateObj.user_id !== undefined) {
        userStateInit.user_id = userStateObj.user_id;
      }
      if (userStateObj.channel_id !== undefined) {
        userStateInit.channel_id = userStateObj.channel_id;
      }
      if (userStateObj.mute !== undefined) {
        userStateInit.mute = userStateObj.mute;
      }
      if (userStateObj.deaf !== undefined) {
        userStateInit.deaf = userStateObj.deaf;
      }
      if (userStateObj.suppress !== undefined) {
        userStateInit.suppress = userStateObj.suppress;
      }
      if (userStateObj.self_mute !== undefined) {
        userStateInit.self_mute = userStateObj.self_mute;
      }
      if (userStateObj.self_deaf !== undefined) {
        userStateInit.self_deaf = userStateObj.self_deaf;
      }
      if (userStateObj.priority_speaker !== undefined) {
        userStateInit.priority_speaker = userStateObj.priority_speaker;
      }
      if (userStateObj.recording !== undefined) {
        userStateInit.recording = userStateObj.recording;
      }
      
      // 只在有值时才设置 repeated 字段
      if (userStateObj.listening_channel_add && userStateObj.listening_channel_add.length > 0) {
        userStateInit.listening_channel_add = userStateObj.listening_channel_add;
      }
      if (userStateObj.listening_channel_remove && userStateObj.listening_channel_remove.length > 0) {
        userStateInit.listening_channel_remove = userStateObj.listening_channel_remove;
      }
      if (userStateObj.temporary_access_tokens && userStateObj.temporary_access_tokens.length > 0) {
        userStateInit.temporary_access_tokens = userStateObj.temporary_access_tokens;
      }
      
      const userState = new mumbleproto.UserState(userStateInit);

      const targetSession = userState.session || session_id;

      // 更新本地用户状态镜像（如果是本Edge的用户）
      if (edge_id === this.config.server_id) {
        const client = this.clientManager.getClient(targetSession);
        if (client) {
          const updates: Partial<ClientInfo> = {};
          
          if (userState.has_channel_id && userState.channel_id !== undefined) {
            this.clientManager.moveClient(targetSession, userState.channel_id);
          }
          if (userState.has_mute && userState.mute !== undefined) {
            updates.mute = userState.mute;
          }
          if (userState.has_deaf && userState.deaf !== undefined) {
            updates.deaf = userState.deaf;
          }
          if (userState.has_suppress && userState.suppress !== undefined) {
            updates.suppress = userState.suppress;
          }
          if (userState.has_self_mute && userState.self_mute !== undefined) {
            updates.self_mute = userState.self_mute;
          }
          if (userState.has_self_deaf && userState.self_deaf !== undefined) {
            updates.self_deaf = userState.self_deaf;
          }
          if (userState.has_priority_speaker && userState.priority_speaker !== undefined) {
            updates.priority_speaker = userState.priority_speaker;
          }
          if (userState.has_recording && userState.recording !== undefined) {
            updates.recording = userState.recording;
          }
          
          // 处理监听频道状态更新
          if (userState.listening_channel_add && userState.listening_channel_add.length > 0) {
            if (!client.listeningChannels) {
              client.listeningChannels = new Set();
            }
            for (const channelId of userState.listening_channel_add) {
              client.listeningChannels.add(channelId);
            }
            logger.debug(`Client ${client.username} now listening to channels: ${Array.from(client.listeningChannels).join(', ')}`);
          }
          if (userState.listening_channel_remove && userState.listening_channel_remove.length > 0) {
            if (client.listeningChannels) {
              for (const channelId of userState.listening_channel_remove) {
                client.listeningChannels.delete(channelId);
              }
              logger.debug(`Client ${client.username} stopped listening to channels, remaining: ${Array.from(client.listeningChannels).join(', ')}`);
            }
          }

          if (Object.keys(updates).length > 0) {
            this.clientManager.updateClient(targetSession, updates);
          }
        }
      }

      // 广播给所有本地已认证的客户端
      const userStateMessage = userState.serialize();
      const allClients = this.clientManager.getAllClients();
      
      for (const client of allClients) {
        if (client.user_id > 0 && client.has_full_user_list) {
          this.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userStateMessage));
        }
      }

      logger.debug(`Broadcasted UserState from Hub to ${allClients.filter(c => c.user_id > 0 && c.has_full_user_list).length} local clients`);
    } catch (error) {
      logger.error('Error handling UserState broadcast from Hub:', error);
    }
  }

  /**
   * 旧的本地UserState处理逻辑（保留作为独立模式的fallback）
   * 参照 Go 版本实现：message.go handleUserStateMessage
   * 
   * TODO_DELETE_STANDALONE: 此方法仅用于独立模式，集群模式已不再使用
   * 所有业务逻辑已迁移到Hub的handleUserStateNotification
   * 待确认不再需要独立模式后可删除
   * 
   * 包含的业务逻辑:
   * - 频道移动权限检查 (Move/Enter Permission)
   * - Self Mute/Deaf 状态控制及联动
   * - Mute/Deaf/Suppress/PrioritySpeaker 管理员操作
   * - Recording 状态变化处理
   * - 状态广播给所有已认证客户端
   */
  // @ts-expect-error: 保留用于文档和未来可能的独立模式支持
  private handleUserStateLocal_DEPRECATED(session_id: number, data: Buffer): void {
    try {
      const userState = mumbleproto.UserState.deserialize(data);

      // 获取执行操作的客户端（actor）
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.UserState from unknown session: ${session_id}`);
        return;
      }

      // 检查客户端是否已认证
      if (!actor.user_id || actor.user_id <= 0) {
        logger.warn(`mumbleproto.UserState from unauthenticated session: ${session_id}`);
        return;
      }

      // 确定目标用户（如果没有指定session，则操作自己）
      let target = actor;
      let targetSession = session_id;

      if (userState.session !== undefined && userState.session !== null && userState.session !== 0) {
        targetSession = userState.session;
        const targetClient = this.clientManager.getClient(targetSession);
        if (!targetClient) {
          logger.warn(`mumbleproto.UserState target session ${targetSession} not found`);
          // 发送 mumbleproto.UserRemove 消息告知客户端该用户不存在
          const removeMsg = new mumbleproto.UserRemove({ session: targetSession });
          this.messageHandler.sendMessage(session_id, MessageType.UserRemove, Buffer.from(removeMsg.serialize()));
          return;
        }
        target = targetClient;
      }

      // 设置 session 和 actor
      userState.session = targetSession;
      userState.actor = session_id;

      let broadcast = false;

      // 处理频道移动
      if (userState.has_channel_id && userState.channel_id !== undefined) {
        const targetChannel = this.channelManager.getChannel(userState.channel_id);
        if (!targetChannel) {
          logger.warn(`Target channel ${userState.channel_id} not found`);
          return;
        }

        // 权限检查：移动其他用户需要 MovePermission，移动自己需要 EnterPermission
        if (actor.session !== target.session) {
          // 移动其他用户，需要特殊权限
          if (!this.checkAdminPermission(actor)) {
            this.sendPermissionDenied(
              session_id,
              'move',
              'Permission denied: cannot move other users'
            );
            return;
          }
        }

        // 执行频道移动（不触发 clientMoved 事件的广播，由这里统一处理）
        const oldChannel = target.channel_id;
        this.clientManager.moveClient(targetSession, userState.channel_id);
        broadcast = true;
        
        logger.debug(`User ${target.username} moved from channel ${oldChannel} to ${userState.channel_id}`);
      }

      // 防止 actor != target 时应用自我操作字段
      if (actor.session !== target.session && 
          (userState.has_self_deaf || userState.has_self_mute || userState.has_texture || 
           userState.has_plugin_context || userState.has_plugin_identity || userState.has_recording)) {
        logger.warn(`Invalid UserState: actor ${actor.session} trying to set self-fields for target ${target.session}`);
        return;
      }

      // 处理 SelfDeaf/SelfMute（用户自己控制）
      if (userState.has_self_deaf && userState.self_deaf !== undefined) {
        target.self_deaf = userState.self_deaf;
        if (target.self_deaf) {
          // SelfDeaf 会自动 SelfMute
          userState.self_mute = true;
          target.self_mute = true;
        }
        this.clientManager.updateClient(targetSession, { 
          self_deaf: target.self_deaf,
          self_mute: target.self_mute 
        });
        broadcast = true;
      }

      if (userState.has_self_mute && userState.self_mute !== undefined) {
        target.self_mute = userState.self_mute;
        if (!target.self_mute) {
          // Un-SelfMute 会自动 Un-SelfDeaf
          userState.self_deaf = false;
          target.self_deaf = false;
        }
        this.clientManager.updateClient(targetSession, { 
          self_mute: target.self_mute,
          self_deaf: target.self_deaf 
        });
        broadcast = true;
      }

      // 处理 Mute/Deaf/Suppress/PrioritySpeaker（管理员操作）
      if (userState.has_mute || userState.has_deaf || userState.has_suppress || userState.has_priority_speaker) {
        // 权限检查：操作其他用户需要 MuteDeafenPermission
        if (actor.session !== target.session) {
          if (!this.checkAdminPermission(actor)) {
            this.sendPermissionDenied(
              session_id,
              'mutedeafen',
              'Permission denied: cannot mute/deaf other users'
            );
            return;
          }
        }

        // Suppress 只能由服务器设置
        if (userState.has_suppress && userState.suppress === true) {
          this.sendPermissionDenied(
            session_id,
            'mutedeafen',
            'Permission denied: only server can suppress users'
          );
          return;
        }

        const updates: Partial<ClientInfo> = {};

        if (userState.has_deaf && userState.deaf !== undefined) {
          target.deaf = userState.deaf;
          updates.deaf = target.deaf;
          if (target.deaf) {
            // Deaf 会自动 Mute
            userState.mute = true;
            target.mute = true;
            updates.mute = true;
          }
        }

        if (userState.has_mute && userState.mute !== undefined) {
          target.mute = userState.mute;
          updates.mute = target.mute;
          if (!target.mute) {
            // Un-Mute 会自动 Un-Deaf
            userState.deaf = false;
            target.deaf = false;
            updates.deaf = false;
          }
        }

        if (userState.has_suppress && userState.suppress !== undefined) {
          target.suppress = userState.suppress;
          updates.suppress = target.suppress;
        }

        if (userState.has_priority_speaker && userState.priority_speaker !== undefined) {
          target.priority_speaker = userState.priority_speaker;
          updates.priority_speaker = target.priority_speaker;
        }

        this.clientManager.updateClient(targetSession, updates);
        broadcast = true;
      }

      // 处理 Recording 状态变化
      if (userState.has_recording && userState.recording !== undefined && userState.recording !== target.recording) {
        target.recording = userState.recording;
        this.clientManager.updateClient(targetSession, { recording: target.recording });

        // 发送文本消息通知（可选，针对旧版本客户端）
        const recordingMessage = target.recording
          ? `User '${target.username}' started recording`
          : `User '${target.username}' stopped recording`;
        logger.info(recordingMessage);

        broadcast = true;
      }

      // 广播状态变更给所有已获取完整用户列表的客户端
      if (broadcast) {
        const allClients = this.clientManager.getAllClients();

        for (const client of allClients) {
          // 只广播给已获取完整用户列表的客户端
          if (client.has_full_user_list && client.user_id > 0) {
            this.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userState.serialize())); 
          }
        }

        logger.debug(
          `Broadcasted mumbleproto.UserState for session ${targetSession} to ${allClients.filter(c => c.has_full_user_list && c.user_id > 0).length} clients`
        );
      }
    } catch (error) {
      logger.error(`Error handling mumbleproto.UserState for session ${session_id}:`, error);
    }
  }

  /**
   * 处理用户踢出/封禁消息
   * 
   * 架构说明：Edge仅负责转发到Hub，所有业务逻辑在Hub处理
   * 
   * 注意：不再支持独立模式，必须连接到Hub才能工作
   */
  private async handleUserRemove(session_id: number, data: Buffer): Promise<void> {
    try {
      const userRemove = mumbleproto.UserRemove.deserialize(data);

      // 获取执行操作的客户端（actor）
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.UserRemove from unknown session: ${session_id}`);
        return;
      }

      // 获取要被移除的客户端
      if (!userRemove.session) {
        logger.warn(`mumbleproto.UserRemove without target session`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('UserRemove rejected: Hub client not available (standalone mode not supported)');
        this.sendPermissionDenied(session_id, 'kick', 'Server must be connected to Hub');
        return;
      }

      // 转发到Hub处理
      this.hubClient.notify('hub.handleUserRemove', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        target_session: userRemove.session,
        reason: userRemove.reason || '',
        ban: userRemove.ban || false,
      });

      logger.debug(`Forwarded UserRemove from session ${session_id} to Hub`);
    } catch (error) {
      logger.error(`Error handling mumbleproto.UserRemove for session ${session_id}:`, error);
    }
  }

  /**
   * 处理频道状态变更消息（创建/编辑）
   * 
   * 架构说明：Edge仅负责转发到Hub，所有业务逻辑在Hub处理
   * 
   * 注意：不再支持独立模式，必须连接到Hub才能工作
   */
  private async handleChannelState(session_id: number, data: Buffer): Promise<void> {
    try {
      const channelState = mumbleproto.ChannelState.deserialize(data);
      logger.debug(
        `Decoded mumbleproto.ChannelState from session ${session_id}: ${JSON.stringify(channelState)}`
      );

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.ChannelState from unauthenticated session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('ChannelState rejected: Hub client not available (standalone mode not supported)');
        this.sendPermissionDenied(session_id, 'make_channel', 'Server must be connected to Hub');
        return;
      }

      // 转发到Hub处理
      this.hubClient.notify('hub.handleChannelState', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        channelState: channelState.toObject(),
        raw_data: data.toString('base64'),
      });

      logger.debug(`Forwarded ChannelState from session ${session_id} to Hub`);
    } catch (error) {
      logger.error(`Error handling mumbleproto.ChannelState for session ${session_id}:`, error);
    }
  }

  /**
   * 旧的本地ChannelState处理逻辑（保留作为独立模式的fallback）
   * 
   * TODO_DELETE_STANDALONE: 此方法仅用于独立模式，集群模式已不再使用
   * 所有业务逻辑已迁移到Hub的handleChannelStateNotification
   * 待确认不再需要独立模式后可删除
   * 
   * 包含的业务逻辑:
   * - 频道创建 (MakeChannel Permission)
   * - 频道编辑 (Write Permission) - 名称/描述/位置/最大用户数
   * - 频道移动 (Write + MakeChannel Permission)
   * - 频道链接管理 (LinkChannel Permission)
   * - ACL自动创建 (创建者获得Write权限)
   * - 循环引用检测
   * - 同级频道名称重复检测
   * - Hub数据库同步
   * - 受影响频道的级联广播
   */
  // @ts-expect-error: 保留用于文档和未来可能的独立模式支持
  private async handleChannelStateLocal_DEPRECATED(session_id: number, data: Buffer): Promise<void> {
    try {
      const channelState = mumbleproto.ChannelState.deserialize(data);
      logger.debug(
        `Decoded mumbleproto.ChannelState from session ${session_id}: ${JSON.stringify(channelState)}`
      );

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.ChannelState from unauthenticated session: ${session_id}`);
        return;
      }

      const isCreate = !channelState.channel_id || channelState.channel_id === 0;
      const channel = isCreate ? null : this.channelManager.getChannel(channelState.channel_id);

      if (!isCreate && !channel) {
        logger.warn(`mumbleproto.ChannelState for non-existent channel: ${channelState.channel_id}`);
        this.sendPermissionDenied(session_id, 'channel_state', 'Channel not found');
        return;
      }

      // === 创建频道 ===
      if (isCreate) {
        if (!channelState.name || channelState.name.trim().length === 0) {
          this.sendPermissionDenied(session_id, 'channel_state', 'Channel name required');
          return;
        }

        const parent_id = channelState.parent !== undefined ? channelState.parent : 0;
        const parentChannel = this.channelManager.getChannel(parent_id);

        if (!parentChannel) {
          this.sendPermissionDenied(session_id, 'channel_state', 'Parent channel not found');
          return;
        }

        // 权限检查：需要父频道的 MakeChannelPermission
        if (!this.hasPermission(actor, parentChannel, Permission.MakeChannel)) {
          this.sendPermissionDenied(session_id, 'make_channel', parentChannel.name);
          return;
        }

        // 检查同级频道名称是否重复
        const siblings = this.channelManager.getChildChannels(parent_id);
        if (siblings.some((ch) => ch.name === channelState.name)) {
          this.sendPermissionDenied(session_id, 'channel_state', 'Channel name already exists');
          return;
        }

        // 创建频道
        const newChannel = this.channelManager.createChannel({
          name: channelState.name,
          parent_id: parent_id,
          description: channelState.description || '',
          position: channelState.position !== undefined ? channelState.position : 0,
          max_users: channelState.max_users !== undefined ? channelState.max_users : 0,
          temporary: channelState.temporary !== undefined ? channelState.temporary : false,
          inherit_acl: true,
          children: [],
          links: [],
        });

        // 如果用户没有 Write 权限，自动创建 mumbleproto.ACL 授予权限
        if (!this.hasPermission(actor, newChannel, Permission.Write)) {
          const newACL = {
            apply_here: true,
            apply_subs: true,
            inherited: false,
            user_id: actor.user_id,
            group: '',
            allow: Permission.Write | Permission.Traverse | Permission.Enter,
            deny: Permission.None,
          };

          const channelACLs = this.aclMap.get(newChannel.id) || [];
          channelACLs.push(newACL);
          this.aclMap.set(newChannel.id, channelACLs);

          // 清除权限缓存
          this.permissionManager.clearCache();
        }

        logger.info(
          `User ${actor.username} (session ${actor.session}) created channel "${newChannel.name}"`,
          newChannel
        );

          // 保存到Hub数据库
        if (this.hubClient && this.config.mode === 'cluster') {
          // 创建新频道时，不包含id字段（undefined表示创建新频道）
          const hubChannelData = {
            // 不设置id字段，让Hub知道这是创建新频道
            name: newChannel.name,
            parent_id: newChannel.parent_id || 0,
            position: newChannel.position || 0,
            max_users: newChannel.max_users || 0,
            inherit_acl: newChannel.inherit_acl !== undefined ? newChannel.inherit_acl : true,
            description: newChannel.description || '',
          };

          // 从Hub获取实际分配的ID
          const hubchannel_id = await this.hubClient.saveChannel(hubChannelData);
          logger.info(
            `Channel saved to Hub with ID ${hubchannel_id}, edge local ID was ${newChannel.id}`
          );

          // 更新本地频道ID为Hub分配的ID
          const oldId = newChannel.id;
          newChannel.id = hubchannel_id;

          // 更新ChannelManager中的频道
          this.channelManager.updatechannel_id(oldId, hubchannel_id);

          // 更新 StateManager（集群模式）
          if (this.stateManager) {
            const channelData = {
              id: hubchannel_id,
              name: newChannel.name,
              position: newChannel.position || 0,
              max_users: newChannel.max_users || 0,
               parent_id: newChannel.parent_id || 0,
              inheritAcl: newChannel.inherit_acl !== undefined ? newChannel.inherit_acl : true,
              descriptionBlob: newChannel.description || '',
            };
            this.stateManager.addOrUpdateChannel(channelData);
            logger.info(`Updated stateManager with new channel ${hubchannel_id}`);
          }

          logger.info(
            `[Hub Log] Channel Create: actor=${actor.username}(${actor.session}), channel=${newChannel.name}(${hubchannel_id}), parent=${parentChannel.name}(${parent_id})`
          );
        }

        // 广播 mumbleproto.ChannelState（使用实际的频道ID，集群模式下是Hub返回的ID）
        const actualchannel_id = newChannel.id; // 这个ID已经在上面更新为Hub返回的ID了
        const broadcastState = {
          channel_id: actualchannel_id,
          name: newChannel.name,
          parent: this.getChannelParentForProtocol(newChannel),
          description: newChannel.description,
          position: newChannel.position,
          max_users: newChannel.max_users,
          temporary: newChannel.temporary,
          links: [],
          links_add: [],
          links_remove: [],
        };

        logger.debug(`Broadcasting new channel to clients: ${JSON.stringify(broadcastState)}`);

        const stateMessage = new mumbleproto.ChannelState(broadcastState).serialize();
        const hexStr = Buffer.from(stateMessage).toString('hex');
        logger.debug(
          `Encoded mumbleproto.ChannelState message: ${stateMessage.length} bytes, hex: ${hexStr.slice(0, 100)}`
        );

        // 验证编码
        try {
          const decoded = mumbleproto.ChannelState.deserialize(stateMessage);
          logger.debug(`Decoded mumbleproto.ChannelState for verification: ${JSON.stringify(decoded)}`);
        } catch (err) {
          logger.error(`Failed to decode mumbleproto.ChannelState:`, err);
        }

        const allClients = this.clientManager.getAllClients();

        logger.debug(
          `Found ${allClients.length} clients to notify: ${allClients.map((c) => `${c.username}(${c.session})`).join(', ')}`
        );

        for (const client of allClients) {
          if (client.user_id > 0) {
            this.messageHandler.sendMessage(client.session, MessageType.ChannelState, Buffer.from(stateMessage)); 
            logger.debug(
              `Sent ChannelState(type=7) to ${client.username}(${client.session}) for new channel ${newChannel.name}(${newChannel.id})`
            );
          }
        }

        return;
      }

      // === 编辑频道 ===
      if (!channel) return;

      let changed = false;
      const changes: string[] = [];

      // 名称修改
      if (channelState.has_name && channelState.name !== undefined && channelState.name.trim().length > 0 && channelState.name !== channel.name) {
        if (!this.hasPermission(actor, channel, Permission.Write)) {
          this.sendPermissionDenied(session_id, 'write', channel.name);
          return;
        }

        // 检查同级频道名称是否重复
        const siblings = this.channelManager.getChildChannels(channel.parent_id || 0);
        if (siblings.some((ch) => ch.id !== channel.id && ch.name === channelState.name)) {
          this.sendPermissionDenied(session_id, 'channel_state', 'Channel name already exists');
          return;
        }

        channel.name = channelState.name;
        changed = true;
        changes.push(`name: ${channelState.name}`);
      }

      // 描述修改
      if (channelState.has_description && channelState.description !== undefined && channelState.description !== channel.description) {
        if (!this.hasPermission(actor, channel, Permission.Write)) {
          this.sendPermissionDenied(session_id, 'write', channel.name);
          return;
        }
        channel.description = channelState.description;
        changed = true;
        changes.push('description');
      }

      // 位置修改
      if (channelState.has_position && channelState.position !== undefined && channelState.position !== channel.position) {
        if (!this.hasPermission(actor, channel, Permission.Write)) {
          this.sendPermissionDenied(session_id, 'write', channel.name);
          return;
        }
        // 验证position是有效的数字
        const newPosition = typeof channelState.position === 'number' && !isNaN(channelState.position) ? channelState.position : 0;
        channel.position = newPosition;
        changed = true;
        changes.push(`position: ${newPosition}`);
      }

      // maxUsers 修改
      if (channelState.has_max_users && channelState.max_users !== undefined && channelState.max_users !== channel.max_users) {
        if (!this.hasPermission(actor, channel, Permission.Write)) {
          this.sendPermissionDenied(session_id, 'write', channel.name);
          return;
        }
        // 验证max_users是有效的数字
        const newMaxUsers = typeof channelState.max_users === 'number' && !isNaN(channelState.max_users) ? channelState.max_users : 0;
        channel.max_users = newMaxUsers;
        changed = true;
        changes.push(`max_users: ${newMaxUsers}`);
      }

      // 父频道移动
      if (channelState.has_parent && channelState.parent !== undefined && channelState.parent !== channel.parent_id) {
        // 需要当前频道的 Write 权限
        if (!this.hasPermission(actor, channel, Permission.Write)) {
          this.sendPermissionDenied(session_id, 'write', channel.name);
          return;
        }

        // 验证parent是有效的数字
        const newParentId = typeof channelState.parent === 'number' && !isNaN(channelState.parent) ? channelState.parent : 0;
        const newParent = this.channelManager.getChannel(newParentId);
        if (!newParent) {
          this.sendPermissionDenied(
            session_id,
            'channel_state',
            'New parent channel not found'
          );
          return;
        }

        // 需要新父频道的 MakeChannel 权限
        if (!this.hasPermission(actor, newParent, Permission.MakeChannel)) {
          this.sendPermissionDenied(session_id, 'make_channel', newParent.name);
          return;
        }

        // 检查不会造成循环
        let checkParent = newParent;
        while (checkParent && checkParent.id !== 0) {
          if (checkParent.id === channel.id) {
            this.sendPermissionDenied(
              session_id,
              'channel_state',
              'Cannot move channel to its own subtree'
            );
            return;
          }
          checkParent =
            checkParent.parent_id !== undefined
              ? this.channelManager.getChannel(checkParent.parent_id)
              : null;
        }

        // 移动频道到新父频道
        channel.parent_id = newParentId;
        changed = true;
        changes.push(`parent: ${newParentId}`);
      }

      // 处理频道链接
      const actualLinksAdd: number[] = [];
      const actualLinksRemove: number[] = [];
      const affectedChannels = new Set<number>(); // 受影响的频道ID

      if (channelState.links_add && channelState.links_add.length > 0) {
        if (!this.hasPermission(actor, channel, Permission.LinkChannel)) {
          this.sendPermissionDenied(session_id, 'link_channel', channel.name);
          return;
        }

        for (const linkId of channelState.links_add) {
          const targetChannel = this.channelManager.getChannel(linkId);
          if (targetChannel && this.hasPermission(actor, targetChannel, Permission.LinkChannel)) {
            this.channelManager.linkChannels(channel.id, linkId);
            actualLinksAdd.push(linkId);
            affectedChannels.add(linkId); // 记录受影响的频道
            changes.push(`link add: ${linkId}`);
            changed = true;
          } else if (!targetChannel) {
            logger.warn(`Cannot link to non-existent channel ${linkId}`);
          } else {
            logger.warn(
              `User ${actor.username} lacks LinkChannel permission on target channel ${linkId}`
            );
            this.sendPermissionDenied(session_id, 'link_channel', targetChannel.name);
          }
        }
      }

      if (channelState.links_remove && channelState.links_remove.length > 0) {
        if (!this.hasPermission(actor, channel, Permission.LinkChannel)) {
          this.sendPermissionDenied(session_id, 'link_channel', channel.name);
          return;
        }

        for (const linkId of channelState.links_remove) {
          this.channelManager.unlinkChannels(channel.id, linkId);
          actualLinksRemove.push(linkId);
          affectedChannels.add(linkId); // 记录受影响的频道
          changes.push(`link remove: ${linkId}`);
          changed = true;
        }
      }

      if (changed) {
        // 更新频道
        this.channelManager.updateChannel(channel.id, channel);

        // 清除权限缓存
        this.permissionManager.clearCache();

        logger.info(
          `User ${actor.username} (session ${actor.session}) edited channel "${channel.name}" (id: ${channel.id}): ${changes.join(', ')}`
        );

        // 保存到Hub数据库
        if (this.hubClient && this.config.mode === 'cluster') {
          await this.saveChannelToHub(channel);

          logger.info(
            `[Hub Log] Channel Edit: actor=${actor.username}(${actor.session}), channel=${channel.name}(${channel.id}), changes=${changes.join(', ')}`
          );
        }

        // 广播 mumbleproto.ChannelState
        const broadcastState = {
          channel_id: channel.id,
          name: channel.name,
          parent: this.getChannelParentForProtocol(channel),
          description: channel.description,
          position: channel.position,
          max_users: channel.max_users,
          temporary: channel.temporary,
          links: this.channelManager.getChannelLinks(channel.id),
          links_add: actualLinksAdd,
          links_remove: actualLinksRemove,
        };

        const stateMessage = new mumbleproto.ChannelState(broadcastState).serialize();
        const allClients = this.clientManager.getAllClients();

        for (const client of allClients) {
          if (client.user_id > 0) {
            this.messageHandler.sendMessage(client.session, MessageType.ChannelState, Buffer.from(stateMessage)); 
          }
        }

        // 如果有链接变化，也要广播受影响的频道状态
        if (affectedChannels.size > 0) {
          for (const affectedchannel_id of affectedChannels) {
            const affectedChannel = this.channelManager.getChannel(affectedchannel_id);
            if (affectedChannel) {
              // 保存受影响的频道到Hub
              if (this.hubClient && this.config.mode === 'cluster') {
                await this.saveChannelToHub(affectedChannel);
              }

              // 广播受影响频道的状态
              const affectedState = {
                channel_id: affectedChannel.id,
                name: affectedChannel.name,
                parent: this.getChannelParentForProtocol(affectedChannel),
                description: affectedChannel.description,
                position: affectedChannel.position,
                max_users: affectedChannel.max_users,
                temporary: affectedChannel.temporary,
                links: this.channelManager.getChannelLinks(affectedChannel.id),
                links_add: [],
                links_remove: [],
              };

              const affectedMessage = new mumbleproto.ChannelState(affectedState).serialize();
              for (const client of allClients) {
                if (client.user_id > 0) {
                  this.messageHandler.sendMessage(client.session, MessageType.ChannelState, Buffer.from(affectedMessage));
                }
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error(`Error handling mumbleproto.ChannelState for session ${session_id}:`, error);
    }
  }

  /**
   * 处理频道删除消息
   */
  private async handleChannelRemove(session_id: number, data: Buffer): Promise<void> {
    try {
      const channelRemove = mumbleproto.ChannelRemove.deserialize(data);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`mumbleproto.ChannelRemove from unauthenticated session: ${session_id}`);
        return;
      }

      if (channelRemove.channel_id === undefined) {
        logger.warn(`mumbleproto.ChannelRemove without channel_id from session: ${session_id}`);
        return;
      }

      // 集群模式：转发到Hub处理
      if (this.config.mode === 'cluster' && this.hubClient) {
        try {
          await this.hubClient.notify('hub.handleChannelRemove', {
            edge_id: this.config.server_id,
            actor_session: session_id,
            actor_username: actor.username,
            channel_id: channelRemove.channel_id,
          });
          logger.debug(`Forwarded ChannelRemove from session ${session_id} to Hub`);
        } catch (error) {
          logger.error('Error forwarding ChannelRemove to Hub:', error);
          this.sendPermissionDenied(session_id, 'channel_remove', 'Internal error');
        }
        return;
      }

      // 独立模式已废弃，要求连接Hub
      logger.error(`ChannelRemove in standalone mode is deprecated, require Hub connection`);
      this.sendPermissionDenied(session_id, 'channel_remove', 'Hub connection required');

      /* TODO_DELETE_STANDALONE - 以下代码标记为待删除，业务逻辑已迁移到Hub
      const channel = this.channelManager.getChannel(channelRemove.channel_id);
      if (!channel) {
        logger.warn(`mumbleproto.ChannelRemove for non-existent channel: ${channelRemove.channel_id}`);
        return;
      }

      // 不能删除根频道
      if (channel.id === 0) {
        this.sendPermissionDenied(session_id, 'channel_remove', 'Cannot remove root channel');
        return;
      }

      // 权限检查：需要 Write 权限
      if (!this.hasPermission(actor, channel, Permission.Write)) {
        this.sendPermissionDenied(session_id, 'write', channel.name);
        return;
      }

      // 获取所有需要删除的频道（包括子频道）
      const channelsToRemove: number[] = [];
      const collectChannels = (channel_id: number) => {
        channelsToRemove.push(channel_id);
        const ch = this.channelManager.getChannel(channel_id);
        if (ch && ch.children) {
          for (const childId of ch.children) {
            collectChannels(childId);
          }
        }
      };
      collectChannels(channel.id);

      // 移动频道中的用户到父频道
      const parent_id = channel.parent_id !== undefined ? channel.parent_id : 0;
      const allClients = this.clientManager.getAllClients();

      for (const client of allClients) {
        if (channelsToRemove.includes(client.channel_id)) {
          client.channel_id = parent_id;

          // 广播 mumbleproto.UserState 通知用户移动
          const { mumbleproto } = await import('@munode/protocol/src/generated/proto/Mumble.js');
          const userState = {
            session: client.session,
            channel_id: parent_id,
            temporary_access_tokens: [],
            listening_channel_add: [],
            listening_channel_remove: [],
          };

          const stateMessage = new mumbleproto.UserState(userState).serialize();
          for (const otherClient of allClients) {
            if (otherClient.user_id > 0) {
              this.messageHandler.sendMessage(otherClient.session, MessageType.UserState, Buffer.from(stateMessage)); 
            }
          }
        }
      }

      // 删除频道（递归删除子频道）
      for (const channel_id of channelsToRemove) {
        this.channelManager.removeChannel(channel_id);

        // 清除频道的 mumbleproto.ACL
        this.aclMap.delete(channel_id);
      }

      // 清除权限缓存
      this.permissionManager.clearCache();

      logger.info(
        `User ${actor.username} (session ${actor.session}) removed channel "${channel.name}" (id: ${channel.id}) and ${channelsToRemove.length - 1} sub-channels`
      );

      // 通知 Hub 记录日志
      if (this.hubClient && this.config.mode === 'cluster') {
        logger.info(
          `[Hub Log] Channel Remove: actor=${actor.username}(${actor.session}), channel=${channel.name}(${channel.id}), sub-channels=${channelsToRemove.length - 1}`
        );
      }

      // 广播 mumbleproto.ChannelRemove
      const removeMessage = new mumbleproto.ChannelRemove(channelRemove).serialize();

      for (const client of allClients) {
        if (client.user_id > 0) {
          this.messageHandler.sendMessage(client.session, MessageType.ChannelRemove, Buffer.from(removeMessage));
        }
      }
      */
    } catch (error) {
      logger.error(`Error handling mumbleproto.ChannelRemove for session ${session_id}:`, error);
    }
  }


  /**
   * 处理 ACL 消息 (查询或更新)
   * 架构说明：Edge 仅负责转发到 Hub，所有业务逻辑在 Hub 处理
   */
  private async handleACL(session_id: number, data: Buffer): Promise<void> {
    try {
      const acl = mumbleproto.ACL.deserialize(data);
      
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`ACL from unknown session: ${session_id}`);
        return;
      }

      if (!actor.user_id || actor.user_id <= 0) {
        logger.warn(`ACL from unauthenticated session: ${session_id}`);
        return;
      }

      if (acl.channel_id === undefined) {
        logger.warn(`ACL without channel_id from session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('ACL rejected: Hub client not available (standalone mode not supported)');
        this.sendPermissionDenied(session_id, 'write', 'Server must be connected to Hub');
        return;
      }

      const isQuery = acl.query === true || !acl.acls || acl.acls.length === 0;
      
      logger.info(`Forwarding ACL ${isQuery ? 'query' : 'update'} from session ${session_id} to Hub, channel: ${acl.channel_id}`);

      // 转发到 Hub（使用 RPC call）
      const result = await this.hubClient.call('edge.handleACL', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        channel_id: acl.channel_id,
        query: isQuery,
        raw_data: data.toString('base64'),
      });

      logger.debug(`ACL request completed, success: ${result?.success}`);

      // 处理响应
      if (!result?.success) {
        logger.warn(`ACL request failed: ${result?.error}`);
        
        // 如果是权限拒绝，发送 PermissionDenied 消息
        if (result?.permission_denied) {
          this.sendPermissionDenied(session_id, 'write', result.error || 'Permission denied', acl.channel_id);
        }
        return;
      }

      // 如果是查询且有数据，直接发送给客户端
      if (isQuery && result.raw_data) {
        const aclData = Buffer.from(result.raw_data, 'base64');
        this.messageHandler.sendMessage(session_id, MessageType.ACL, aclData);
        logger.info(`Forwarded ACL query response to session ${session_id} for channel ${acl.channel_id}`);
      }
    } catch (error) {
      logger.error(`Error handling ACL for session ${session_id}:`, error);
    }
  }

  /**
   * 处理文本消息
   * 
   * 架构说明：Edge转发到Hub进行权限检查和目标解析，Hub广播给所有Edge
   */
  private handleTextMessage(session_id: number, data: Buffer): void {
    try {
      const textMessage = mumbleproto.TextMessage.deserialize(data);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`TextMessage from unauthenticated session: ${session_id}`);
        return;
      }

      // 检查客户端是否已认证
      if (!actor.user_id || actor.user_id <= 0) {
        logger.warn(`TextMessage from unauthenticated session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        logger.error('TextMessage rejected: Hub client not available (standalone mode not supported)');
        this.sendPermissionDenied(session_id, 'text_message', 'Server must be connected to Hub');
        return;
      }

      // 设置发送者
      textMessage.actor = session_id;

      // 转发到Hub处理（Hub会进行权限检查、目标解析和广播）
      this.hubClient.notify('hub.handleTextMessage', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        actor_channel_id: actor.channel_id,
        textMessage: {
          actor: session_id,
          session: textMessage.session || [],
          channel_id: textMessage.channel_id || [],
          tree_id: textMessage.tree_id || [],
          message: textMessage.message || '',
        },
      });

      logger.debug(`Forwarded TextMessage from session ${session_id} to Hub`);
    } catch (error) {
      logger.error(`Error handling TextMessage for session ${session_id}:`, error);
    }
  }

  /**
   * 处理权限查询消息
   */
  private handlePermissionQuery(session_id: number, data: Buffer): void {
    try {
      const permQuery = mumbleproto.PermissionQuery.deserialize(data);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`PermissionQuery from unauthenticated session: ${session_id}`);
        return;
      }

      if (permQuery.channel_id === undefined) {
        logger.warn(`PermissionQuery without channel_id from session: ${session_id}`);
        return;
      }

      const channel = this.channelManager.getChannel(permQuery.channel_id);
      if (!channel) {
        logger.warn(`PermissionQuery for non-existent channel: ${permQuery.channel_id}`);
        return;
      }

      // 计算用户在该频道的权限
      const channelTree = this.channelManager.getChannelTree();
      const permissions = this.permissionManager.calculatePermission(
        channel,
        actor,
        channelTree,
        this.aclMap
      );

      // 构建响应
      const response = {
        channel_id: permQuery.channel_id,
        permissions: permissions,
      };

      const responseMessage = new mumbleproto.PermissionQuery(response).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.PermissionQuery, Buffer.from(responseMessage)); 

      logger.info(
        `User ${actor.username} (session ${actor.session}) queried permissions for channel "${channel.name}" (id: ${channel.id}), result: ${permissions}`
      );
    } catch (error) {
      logger.error(`Error handling PermissionQuery for session ${session_id}:`, error);
    }
  }

  /**
   * 处理认证成功
   */
  private async handleAuthSuccess(
     session_id: number,
    client: ClientInfo,
    authResult: AuthResult,
    authMessage: mumbleproto.Authenticate
  ): Promise<void> {
    try {
      // 更新客户端信息
      this.clientManager.updateClient(session_id, {
        user_id: authResult.user_id,
        username: authResult.displayName || authResult.username,
        groups: authResult.groups || [],
      });

      // 1. 生成加密密钥并发送 CryptSetup
      // 参照 Go 实现 (server.go 第752-756行):
      //   Key:         client.crypt.Key
      //   ClientNonce: client.crypt.DecryptIV  // 服务器解密IV = 客户端加密IV
      //   ServerNonce: client.crypt.EncryptIV  // 服务器加密IV = 客户端解密IV
      const cryptKey = Buffer.alloc(16);
      const serverEncryptIV = Buffer.alloc(16);  // 服务器用来加密发送给客户端的包
      const serverDecryptIV = Buffer.alloc(16);  // 服务器用来解密客户端发来的包

      // 生成随机密钥和 IV
      randomFillSync(cryptKey);
      randomFillSync(serverEncryptIV);
      randomFillSync(serverDecryptIV);

      const cryptSetupMessage = new mumbleproto.CryptSetup({
        key: cryptKey,
        client_nonce: serverDecryptIV,  // 客户端的 encryptIV = 服务器的 decryptIV
        server_nonce: serverEncryptIV,  // 客户端的 decryptIV = 服务器的 encryptIV
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.CryptSetup, Buffer.from(cryptSetupMessage)); 

      // 设置客户端的 OCB2-AES128 加密密钥
      // setClientCrypto(session_id, key, encryptIV, decryptIV)
      this.voiceRouter.setClientCrypto(session_id, cryptKey, serverEncryptIV, serverDecryptIV);

      // 2. 发送 CodecVersion
      const codecVersionMessage = new mumbleproto.CodecVersion({
        alpha: -2147483637, // CELT 0.7.0
        beta: -2147483632, // CELT 0.11.0
        prefer_alpha: true,
        opus: authMessage.opus || false,
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.CodecVersion, Buffer.from(codecVersionMessage)); 

      // 3. 发送频道树
      this.sendChannelTree(session_id);

      // 5. 发送所有其他用户的状态（不包括自己）
      await this.sendUserListToClient(session_id);

      // 6. 应用 PreConnectUserState（在认证成功后）
      const preState = this.preConnectUserState.get(session_id);
      if (preState) {
        const updateFields: Partial<ClientInfo> = {};
        
        if (preState.self_mute !== undefined) {
          updateFields.self_mute = preState.self_mute;
        }
        if (preState.self_deaf !== undefined) {
          updateFields.self_deaf = preState.self_deaf;
        }
        if (preState.comment !== undefined) {
          updateFields.comment = preState.comment;
        }
        
        // 更新客户端状态
        if (Object.keys(updateFields).length > 0) {
          this.clientManager.updateClient(session_id, updateFields);
          logger.debug(`Applied PreConnectUserState for session ${session_id}: ${Object.keys(updateFields).join(', ')}`);
        }
        
        // 清理 PreConnect 状态
        this.preConnectUserState.delete(session_id);
      }

      // 7. 标记客户端已接收完整用户列表
      this.clientManager.updateClient(session_id, {
         has_full_user_list: true,
      });

      // 8. 获取更新后的客户端信息以便广播
      const updatedClient = this.clientManager.getClient(session_id);
      if (!updatedClient) {
        throw new Error(`Client ${session_id} not found after update`);
      }

      // 9. 确定默认频道（优先使用上次频道，否则使用默认频道）
      let targetchannel_id = updatedClient.channel_id;
      
      // 如果是注册用户，尝试获取上次的频道
      if (authResult.user_id > 0) {
        // TODO: 从数据库或Hub获取用户上次的频道
        // const lastchannel_id = await this.getLastChannel(authResult.user_id);
        // if (lastchannel_id && this.channelManager.getChannel(lastchannel_id)) {
        //   targetchannel_id = lastchannel_id;
        // }
      }

      // 10. 移动用户到目标频道
      this.clientManager.moveClient(session_id, targetchannel_id);
      
      // 构建新用户的 UserState
      // 参考Go版本实现：只包含必需字段（session, actor, name, channel_id, user_id, hash）
      // 不包含状态字段（mute, deaf等），避免客户端显示不必要的状态变更消息
      const newUserState = new mumbleproto.UserState({
        session: session_id,
        actor: session_id,
        user_id: updatedClient.user_id,
        name: updatedClient.username,
        channel_id: targetchannel_id,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      });

      // 如果有证书哈希，添加到消息中
      if (updatedClient.cert_hash) {
        newUserState.hash = updatedClient.cert_hash;
      }

      const newUserStateMessage = newUserState.serialize();

      // 11a. 先发送新用户的 UserState 给自己（必须在 ServerSync 之前！）
      // 这样客户端收到 ServerSync 时才能找到自己的 UserState
      this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(newUserStateMessage));
      logger.debug(`Sent own UserState to session ${session_id} before ServerSync`);

      // 11b. 广播新用户的 UserState 给所有其他已有完整用户列表的客户端
      const allClients = this.clientManager.getAllClients();
      
      for (const otherClient of allClients) {
        // 只广播给其他已获取完整用户列表的客户端（不包括自己）
        if (otherClient.session !== session_id && otherClient.has_full_user_list && otherClient.user_id > 0) {
          this.messageHandler.sendMessage(otherClient.session, MessageType.UserState, Buffer.from(newUserStateMessage)); 
        }
      }

      // 12. 发送 ServerSync（必须在用户列表之后）
      const serverSyncMessage = new mumbleproto.ServerSync({
        session: session_id,
        max_bandwidth: this.config.max_bandwidth || 72000,
        welcome_text: this.config.welcomeText || `Welcome to ${this.config.name}`,
        permissions: this.calculateRootPermissions(authResult),
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.ServerSync, Buffer.from(serverSyncMessage)); 

      // 13. 发送 ServerConfig（必须在 ServerSync 之后）
      const serverConfigMessage = new mumbleproto.ServerConfig({
        allow_html: this.config.features.allowHtml || false,
        message_length: this.config.maxTextMessageLength || 5000,
        image_message_length: this.config.maxImageMessageLength || 131072,
        max_users: this.config.capacity || 1000,
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.ServerConfig, Buffer.from(serverConfigMessage)); 

      // 14. 发送 SuggestConfig（建议配置）
      const suggestConfig: {
        version?: number;
        positional?: boolean;
        push_to_talk?: boolean;
      } = {};
      let hasSuggestions = false;

      // 建议客户端版本
      if (this.config.suggestVersion) {
        suggestConfig.version = this.config.suggestVersion;
        hasSuggestions = true;
      }

      // 建议位置音频设置
      if (this.config.suggestPositional !== undefined) {
        suggestConfig.positional = this.config.suggestPositional;
        hasSuggestions = true;
      }

      // 建议按键发言设置
      if (this.config.suggestPushToTalk !== undefined) {
        suggestConfig.push_to_talk = this.config.suggestPushToTalk;
        hasSuggestions = true;
      }

      // 只有在有建议时才发送
      if (hasSuggestions) {
        const suggestMessage = new mumbleproto.SuggestConfig(suggestConfig);
        this.messageHandler.sendMessage(session_id, MessageType.SuggestConfig, Buffer.from(suggestMessage.serialize())); 
        logger.debug(`Sent SuggestConfig to session ${session_id}`);
      }

      // 客户端现在已完全同步，可以正常通信
      
      // 上报证书指纹（如果有的话）
      if (client.cert_hash) {
        this.reportCertificateFingerprint(authResult.user_id, client.cert_hash).catch((error) => {
          logger.error(
            `Failed to report certificate fingerprint for user ${authResult.user_id}:`,
            error
          );
        });
      }

      // 在集群模式下，上报会话到Hub
      if (this.config.mode === 'cluster' && this.hubClient) {
        this.hubClient.reportSession({
          session_id: session_id,
          user_id: authResult.user_id,
          username: authResult.username,
          channel_id: targetchannel_id,
          startTime: new Date(),
          ip_address: client.ip_address,
          groups: authResult.groups || [], // 传递用户组信息
          cert_hash: client.cert_hash,
        }).catch((error) => {
          logger.error(`Failed to report session to Hub:`, error);
        });
      }

      logger.info(
        `User ${authResult.username} authenticated successfully ` +
        `(session: ${session_id}, user_id: ${authResult.user_id}, channel: ${targetchannel_id})`
      );
    } catch (error) {
      logger.error(`Failed to complete authentication for session ${session_id}:`, error);
      this.sendReject(session_id, 'Authentication completion failed');
    }
  }

  /**
   * 处理认证失败
   */
  private handleAuthFailure(
     session_id: number,
    reason: string,
    rejectType: mumbleproto.Reject.RejectType = mumbleproto.Reject.RejectType.None
  ): void {
    logger.warn(`Authentication failed for session ${session_id}: ${reason}`);
    this.sendReject(session_id, reason, rejectType);
  }

  /**
   * 发送拒绝消息
   */
  private sendReject(
     session_id: number,
    reason: string,
    rejectType: mumbleproto.Reject.RejectType = mumbleproto.Reject.RejectType.None
  ): void {
    logger.debug(`Sending reject to session ${session_id}: type=${rejectType}, reason=${reason}`);

    const rejectMessage = new mumbleproto.Reject({
      type: rejectType,
      reason: reason,
    }).serialize();

    this.messageHandler.sendMessage(session_id, MessageType.Reject, Buffer.from(rejectMessage)); 
  }

  /**
   * 上报证书指纹到外部API
   */
  private async reportCertificateFingerprint(user_id: number,  cert_hash: string): Promise<void> {
    if (!this.config.auth.apiUrl) {
      return;
    }

    try {
      const response = await fetch(`${this.config.auth.apiUrl}/fingerprint`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.auth.apiKey}`,
        },
        body: JSON.stringify({
          user_id: user_id,
          cert_hash: cert_hash,
          timestamp: Date.now(),
        }),
        signal: AbortSignal.timeout(this.config.auth.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      logger.debug(`Reported certificate fingerprint for user ${user_id}`);
    } catch (error) {
      logger.error(`Failed to report certificate fingerprint for user ${user_id}:`, error);
    }
  }

  /**
   * 获取频道的正确 parent 值（用于发送给客户端）
   * 根据 Mumble 协议规范：
   * - 根频道 (ID=0) 不应该包含 parent 字段（返回 undefined）
   * - 其他频道必须有有效的 parent_id，且不能指向自己
   * - 如果 parent_id 无效，默认使用根频道 (0)
   */
  private getChannelParentForProtocol(channel: ChannelInfo): number | undefined {
    if (channel.id === 0) {
      // 根频道不设置 parent 字段
      return undefined;
    }
    
    if (channel.parent_id === undefined || channel.parent_id === null || channel.parent_id === channel.id) {
      // 如果 parent_id 无效或指向自己，使用根频道作为父频道
      logger.warn(
        `Channel ${channel.id} (${channel.name}) has invalid parent_id=${channel.parent_id}, using root channel (0) as parent`
      );
      return 0;
    }
    
    return channel.parent_id;
  }

  /**
   * 发送频道树给客户端
   * 
   * 重要：模仿Go服务器的两次发送策略，避免客户端报错
   * "Server asked to move a channel into itself or one of its children"
   * 
   * 原因：Mumble客户端在收到包含parent字段的ChannelState时会立即执行移动操作，
   * 如果一次性发送所有频道信息（包含parent），可能导致循环引用检查失败。
   * 
   * 解决方案：
   * 1. 第一次：发送所有频道的基本信息（name、description等），但parent设为0（根频道除外）
   * 2. 第二次：仅发送频道的parent关系，此时所有频道都已在客户端创建完毕
   */
  private sendChannelTree(session_id: number): void {
    let channels: ChannelInfo[];

    // 在集群模式下，从stateManager获取频道（Hub同步的数据）
    if (this.config.mode === 'cluster') {
      if (this.stateManager) {
        const stateChannels = this.stateManager.getAllChannels();
        // 转换ChannelData为ChannelInfo
        channels = stateChannels.map((ch) => ({
          id: ch.id,
          name: ch.name,
          parent_id: ch.id === 0 ? -1 : ch.parent_id,
          description: ch.description || '',
          position: ch.position || 0,
          max_users: ch.maxUsers || 0,
          temporary: ch.temporary || false,
          inherit_acl: ch.inheritAcl !== false, // 默认 true
          children: [],
          links: [],
        }));
        logger.info(
          `[sendChannelTree] Cluster mode: sending ${channels.length} channels from stateManager to session ${session_id}`
        );
      } else {
        channels = [];
      }
    } else {
      // 单机模式，从channelManager获取
      channels = this.channelManager.getAllChannels();
      logger.info(
        `[sendChannelTree] Standalone mode: sending ${channels.length} channels from channelManager to session ${session_id}`
      );
    }

    if (!channels || channels.length === 0) {
      logger.warn(`[sendChannelTree] No channels to send`);
      return;
    }

    logger.debug(`[sendChannelTree] Starting two-pass channel tree sync for session ${session_id}`);

    // === 第一次循环：发送所有频道的基本信息，parent字段设为0（根频道除外不设parent） ===
    for (const channel of channels) {
      const links =
        this.config.mode === 'cluster' && this.stateManager
          ? this.stateManager.getChannelLinks(channel.id)
          : this.channelManager.getChannelLinks(channel.id);

      const channelState = new mumbleproto.ChannelState({
        channel_id: channel.id,
        name: channel.name,
        description: channel.description || '',
        position: channel.position,
        temporary: channel.temporary,
        max_users: channel.max_users || 0,
        links: links || [],
        links_add: [],
        links_remove: [],
        // 第一次：根频道(id=0)不设parent，其他频道parent都设为0
        parent: channel.id === 0 ? undefined : 0,
      });

      logger.debug(
        `[sendChannelTree] Pass 1: channel ${channel.id} (${channel.name}), parent=${channel.id === 0 ? 'undefined' : 0}`
      );

      const channelStateMessage = new mumbleproto.ChannelState(channelState).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.ChannelState, Buffer.from(channelStateMessage));
    }

    // === 第二次循环：仅发送parent关系 ===
    for (const channel of channels) {
      // 根频道跳过（根频道没有parent）
      if (channel.id === 0) {
        continue;
      }

      const parentId = this.getChannelParentForProtocol(channel);

      const channelState = new mumbleproto.ChannelState({
        channel_id: channel.id,
        parent: parentId,
        position: channel.position,
        temporary: channel.temporary,
        links: [],
        links_add: [],
        links_remove: [],
      });

      logger.debug(
        `[sendChannelTree] Pass 2: channel ${channel.id} parent relationship, parent=${parentId}`
      );

      const channelStateMessage = new mumbleproto.ChannelState(channelState).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.ChannelState, Buffer.from(channelStateMessage));
    }

    logger.info(
      `[sendChannelTree] Completed two-pass channel tree sync. Sent ${channels.length} channels to session ${session_id}`
    );
  }

  /**
   * 发送用户列表给新认证的客户端（不包括自己）
   * 类似 Go 实现的 sendUserList
   */
  private async sendUserListToClient(session_id: number): Promise<void> {
    // 从Hub获取全部用户会话信息（包括其他Edge的用户）
    if (this.hubClient && this.hubClient.isConnected()) {
      try {
        // 通过fullSync获取所有会话
        const syncData = await this.hubClient.call('edge.fullSync', {});
        const allSessions = syncData.sessions || [];
        
        let sentCount = 0;
        for (const session of allSessions) {
          // 发送所有其他已认证用户的状态（不包括自己）
          if (session.user_id > 0 && session.session_id !== session_id) {
            const userState = new mumbleproto.UserState({
              session: session.session_id,
              user_id: session.user_id,
              name: session.username,
              channel_id: session.channel_id,
              temporary_access_tokens: [],
              listening_channel_add: [],
              listening_channel_remove: [],
            });
            
            // 添加可选字段
            if (session.cert_hash) {
              userState.hash = session.cert_hash;
            }
            
            // 注意：GlobalSession可能不包含mute/deaf等状态字段
            // 这些字段通常在UserState变更时才同步
            // 如果需要，可以扩展GlobalSession接口来包含这些字段

            this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(userState.serialize())); 
            sentCount++;
          }
        }
        
        logger.debug(`Sent user list to session ${session_id} from Hub (${sentCount} users)`);
      } catch (error) {
        logger.error(`Failed to get user list from Hub for session ${session_id}:`, error);
        // Fallback: 只发送本地用户
        this.sendLocalUserListToClient(session_id);
      }
    } else {
      // 如果没有连接到Hub，只发送本地用户
      logger.warn(`Hub not connected, sending local users only to session ${session_id}`);
      this.sendLocalUserListToClient(session_id);
    }
  }

  /**
   * Fallback: 只发送本地Edge的用户列表
   */
  private sendLocalUserListToClient(session_id: number): void {
    const clients = this.clientManager.getAllClients();

    for (const client of clients) {
      // 发送所有其他已认证的客户端状态（不包括自己）
      if (client.user_id > 0 && client.session !== session_id) {
        const userState = new mumbleproto.UserState({
          session: client.session,
          user_id: client.user_id,
          name: client.username,
          channel_id: client.channel_id,
          temporary_access_tokens: [],
          listening_channel_add: [],
          listening_channel_remove: [],
        });
        for (const field of ['cert_hash', 'mute', 'deaf', 'suppress', 'self_mute', 'self_deaf', 'priority_speaker', 'recording'] as const) {
          const value = client[field];
          if (value) {
            (userState as any)[field] = value;
          }
        }

        this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(userState.serialize())); 
      }
    }
    
    logger.debug(`Sent local user list to session ${session_id} (${clients.filter(c => c.user_id > 0 && c.session !== session_id).length} users)`);
  }

  /**
   * 计算根频道权限
   */
  private calculateRootPermissions(authResult: AuthResult): number {
    // 基础权限
    let permissions = 0;

    // Traverse (遍历频道树)
    permissions |= 0x0002;
    // Enter (进入频道)
    permissions |= 0x0004;
    // Speak (说话)
    permissions |= 0x0008;
    // Whisper (密语)
    permissions |= 0x0100;
    // TextMessage (文本消息)
    permissions |= 0x0200;

    // 如果是管理员，给予所有权限
    if (authResult.groups && authResult.groups.includes('admin')) {
      permissions = 0xffffffff;
    }

    return permissions;
  }

  /**
   * 解析并处理 Mumble 协议消息
   */
  private parseAndHandleMessage(session_id: number, data: Buffer): void {
    try {
      let offset = 0;
      const client = this.clientManager.getClient(session_id);

      if (!client) {
        logger.warn(`Received data for unknown session: ${session_id}`);
        return;
      }

      // Mumble 协议：每条消息的格式是 [type(2字节)][length(4字节)][data(length字节)]
      while (offset < data.length) {
        if (offset + 6 > data.length) {
          // 数据不完整，等待更多数据
          logger.warn(
            `Incomplete message from session ${session_id}, offset=${offset}, length=${data.length}`
          );
          break;
        }

        // 读取消息类型 (2字节，大端序)
        const messageType = data.readUInt16BE(offset);
        offset += 2;

        // 读取消息长度 (4字节，大端序)
        const messageLength = data.readUInt32BE(offset);
        offset += 4;

        // 检查消息长度是否合法
        if (messageLength > 10000000) {
          logger.error(
            `Oversized message from session ${session_id}: type=${messageType}, length=${messageLength}`
          );
          this.clientManager.removeClient(session_id);
          return;
        }

        if (offset + messageLength > data.length) {
          // 消息体不完整，等待更多数据
          logger.warn(
            `Incomplete message body from session ${session_id}, type=${messageType}, expected=${messageLength}, available=${data.length - offset}`
          );
          break;
        }

        // 提取消息数据
        const messageData = data.subarray(offset, offset + messageLength);
        offset += messageLength;

        // 处理消息
        logger.debug(
          `Received message(tcp): session=${session_id}, type=${messageType}, length=${messageLength}`
        );
        this.messageHandler.handleMessage(session_id, messageType, messageData);
      }
    } catch (error) {
      logger.error(`Error parsing message from session ${session_id}:`, error);
      this.clientManager.removeClient(session_id);
    }
  }

  /**
   * 发送消息给客户端
   */
  private sendMessageToClient(session_id: number, messageType: number, messageData: Buffer): void {
    try {
      const socket = this.clientManager.getSocket(session_id);
      if (!socket) {
        logger.warn(`Cannot send message to unknown session: ${session_id}`);
        return;
      }

      // 构造 Mumble 协议消息：[type(2字节)][length(4字节)][data]
      const header = Buffer.allocUnsafe(6);
      header.writeUInt16BE(messageType, 0);
      header.writeUInt32BE(messageData.length, 2);

      // 发送消息
      socket.write(header);
      socket.write(messageData);

      logger.debug(
        `Sent message: session=${session_id}, type=${messageType}, length=${messageData.length}`
      );
    } catch (error) {
      logger.error(`Error sending message to session ${session_id}:`, error);
      this.clientManager.removeClient(session_id);
    }
  }

  /**
   * 从Hub加载频道和ACL数据
   */
  private async loadDataFromHub(): Promise<void> {
    try {
      logger.info('Loading channels and ACLs from Hub...');

      if (!this.hubClient || !this.hubClient.isConnected()) {
        logger.warn('Hub client not connected, skipping data load');
        return;
      }

      // 从Hub获取所有频道
      const channels = await this.hubClient.getChannels();
      logger.info(`Loaded ${channels.length} channels from Hub`);

      // 重建频道树结构
      for (const channelData of channels) {
        const channel: ChannelInfo = {
          id: channelData.id,
          name: channelData.name,
          // Hub返回的是parent_id，需要转换为parent_id
          parent_id: channelData.parent_id === null || channelData.parent_id === undefined ? 0 : channelData.parent_id,
          position: channelData.position || 0,
          max_users: channelData.max_users || 0,
          description: channelData.description || '',
          temporary: channelData.temporary || false,
          inherit_acl: channelData.inherit_acl !== undefined ? channelData.inherit_acl : true,
          children: [],
          links: channelData.links || [],
        };

        // 将频道添加到ChannelManager
        this.channelManager.addOrUpdateChannel(channel);
        logger.debug(`Loaded channel: ${channel.name} (${channel.id})`);
      }

      // 从Hub获取所有ACL（channel_id为0表示获取所有频道的ACL）
      try {
        const allAcls = await this.hubClient.getACLs(0);
        logger.info(`Loaded ${allAcls.length} ACL entries from Hub for all channels`);

        // 将ACL按频道分组存储到aclMap
        for (const aclData of allAcls) {
          const channelId = aclData.channel_id;
          if (!this.aclMap.has(channelId)) {
            this.aclMap.set(channelId, []);
          }

          const aclEntry: ACLEntry = {
            user_id: aclData.user_id,
            group: aclData.group || '',
            apply_here: aclData.apply_here,
            apply_subs: aclData.apply_subs,
            allow: aclData.allow,
            deny: aclData.deny,
          };

          this.aclMap.get(channelId)!.push(aclEntry);
          logger.debug(`Loaded ACL for channel ${channelId}: user_id=${aclData.user_id}, group=${aclData.group}`);
        }

        // 清除权限缓存，确保使用新的ACL数据
        this.permissionManager.clearCache();
      } catch (error) {
        logger.warn('Failed to load ACLs from Hub:', error);
      }

      logger.info('Data loading from Hub completed');
    } catch (error) {
      logger.error('Failed to load data from Hub:', error);
      // 不抛出错误，允许服务器以空状态启动
    }
  }

  /**
   * 保存频道数据到Hub
   */
  private async saveChannelToHub(channel: ChannelInfo): Promise<void> {
    try {
      if (!this.hubClient || !this.hubClient.isConnected()) {
        logger.warn('Hub client not connected, channel not saved:', channel.name);
        return;
      }

      // 临时频道不保存到Hub，只存在于内存中
      if (channel.temporary) {
        logger.debug(`Skipping save of temporary channel to Hub: ${channel.name} (${channel.id})`);
        return;
      }

      // 映射ChannelInfo到Hub期望的格式
      // 注意：字段名必须与 RPCParams<'edge.saveChannel'> 匹配
      const hubChannelData: Partial<ChannelData> = {
        id: channel.id,
      };

      // 只添加有值的字段，避免用默认值覆盖数据库中的现有值
      if (channel.name !== undefined && channel.name.trim().length > 0) {
        hubChannelData.name = channel.name;
      }
      if (channel.position !== undefined) {
        hubChannelData.position = channel.position;
      }
      if (channel.max_users !== undefined) {
        hubChannelData.max_users = channel.max_users;
      }
      if (channel.parent_id !== undefined) {
        hubChannelData.parent_id = channel.parent_id;
      }
      if (channel.inherit_acl !== undefined) {
        hubChannelData.inherit_acl = channel.inherit_acl;
      }
      if (channel.description !== undefined && channel.description.trim().length > 0) {
        hubChannelData.description = channel.description;
      }
      if (channel.temporary !== undefined) {
        hubChannelData.temporary = channel.temporary;
      }
      if (channel.links !== undefined) {
        hubChannelData.links = channel.links;
      }

      await this.hubClient.saveChannel(hubChannelData);
      logger.debug(`Channel saved to Hub: ${channel.name} (${channel.id})`);
    } catch (error) {
      logger.error(`Failed to save channel ${channel.id} to Hub:`, error);
    }
  }

  /**
   * 保存ACL数据到Hub
   */
  /**
   * 处理版本消息
   */
  private handleVersion(session_id: number, data: Buffer): void {
    try {
      // 解析客户端版本信息
      const versionMessage = mumbleproto.Version.deserialize(data);

      logger.debug(
        `Client version: session=${session_id}, version=${versionMessage.version}, release=${versionMessage.release}`
      );

      // 回复服务器版本信息
      const serverVersionMessage = new mumbleproto.Version({
        version: 0x010400, // 1.4.0
        release: 'Shitspeak Edge Server',
        os: process.platform,
        os_version: process.version,
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.Version, Buffer.from(serverVersionMessage)); 

      logger.debug(`Sent version response to session ${session_id}`);
    } catch (error) {
      logger.error(`Failed to handle version message for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 CryptSetup 消息
   */
  private handleCryptSetup(session_id: number, data: Buffer): void {
    try {
      const cryptSetup = mumbleproto.CryptSetup.deserialize(data);

      const client = this.clientManager.getClient(session_id);
      if (!client) {
        logger.warn(`CryptSetup from unknown session: ${session_id}`);
        return;
      }

      // 如果客户端没有发送nonce，说明请求重新同步
      if (!cryptSetup.client_nonce || cryptSetup.client_nonce.length === 0) {
        logger.info(`Client ${session_id} requested crypt resync`);

        // 获取当前加密状态的服务器nonce
        const serverNonce = this.voiceRouter.getClientEncryptIV(session_id);

        // 发送服务器nonce给客户端
        const response = new mumbleproto.CryptSetup({
          server_nonce: serverNonce || Buffer.alloc(16),
        }).serialize();

        this.messageHandler.sendMessage(session_id, MessageType.CryptSetup, Buffer.from(response)); 
        logger.debug(`Sent crypt resync response to session ${session_id}`);
      } else {
        // 客户端发送了nonce，更新解密IV
        logger.info(`Received client nonce from session ${session_id}, updating decrypt IV`);

        if (cryptSetup.client_nonce.length === 16) {
          this.voiceRouter.updateClientDecryptIV(session_id, Buffer.from(cryptSetup.client_nonce));
          logger.debug(`Updated decrypt IV for session ${session_id}`);
        } else {
          logger.warn(`Invalid client nonce length: ${cryptSetup.client_nonce.length}`);
        }
      }
    } catch (error) {
      logger.error(`Error handling CryptSetup for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 QueryUsers 消息
   */
  private async handleQueryUsers(session_id: number, data: Buffer): Promise<void> {
    try {
      const query = mumbleproto.QueryUsers.deserialize(data);

      const response = {
        ids: [] as number[],
        names: [] as string[],
      };

      // 根据ID查询用户
      if (query.ids && query.ids.length > 0 && this.userCache) {
        for (const id of query.ids) {
          const user = await this.userCache.getUserById(id);
          if (user) {
            response.ids.push(id);
            response.names.push(user.username);
          }
        }
      }

      // 根据名称查询用户（暂不实现，Mumble很少使用此功能）
      // if (query.names && query.names.length > 0) {
      //   for (const name of query.names) {
      //     // 查询用户ID
      //   }
      // }

      // 发送响应
      const responseMessage = new mumbleproto.QueryUsers(response).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.QueryUsers, Buffer.from(responseMessage)); 

      logger.debug(
        `Sent QueryUsers response to session ${session_id}: ${response.ids.length} users`
      );
    } catch (error) {
      logger.error(`Error handling QueryUsers for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 UserStats 消息
   */
  private handleUserStats(session_id: number, data: Buffer): void {
    try {
      const statsRequest = mumbleproto.UserStats.deserialize(data);

      if (!statsRequest.session) {
        logger.warn(`UserStats request without target session from ${session_id}`);
        return;
      }

      const actor = this.clientManager.getClient(session_id);
      const target = this.clientManager.getClient(statsRequest.session);

      if (!actor || !target) {
        logger.warn(
          `UserStats for invalid sessions: actor=${session_id}, target=${statsRequest.session}`
        );
        return;
      }

      // 权限检查：extended统计需要根频道的Register权限
      const rootChannel = this.channelManager.getChannel(0);
      const extended =
        actor === target ||
        (rootChannel && this.hasPermission(actor, rootChannel, Permission.Register));

      // 如果没有extended权限，还需要检查是否能进入目标用户所在频道
      if (!extended) {
        const targetChannel = this.channelManager.getChannel(target.channel_id);
        if (!targetChannel || !this.hasPermission(actor, targetChannel, Permission.Enter)) {
          this.sendPermissionDenied(
            session_id,
            'enter',
            'Cannot view stats for users in inaccessible channels',
            target.channel_id
          );
          return;
        }
      }

      // 构建响应
      const response: Partial<mumbleproto.UserStats> & { certificates: Buffer[]; celt_versions: number[] } = {
        session: target.session,
        onlinesecs: Math.floor((Date.now() - target.connected_at.getTime()) / 1000),
        idlesecs: Math.floor((Date.now() - target.last_active.getTime()) / 1000),
        certificates: [], // 必需字段，初始化为空数组
        celt_versions: [], // 必需字段，初始化为空数组
      };

      // 详细信息（extended权限）
      if (extended && !statsRequest.stats_only) {
        // 版本信息
        if (target.version || target.client_name || target.os_name) {
          response.version = new mumbleproto.Version({
            version: target.version ? parseInt(target.version, 16) : undefined,
            release: target.client_name || undefined,
            os: target.os_name || undefined,
            os_version: target.os_version || undefined,
          });
        }

        // 证书信息（TLS连接）
        if (target.cert_hash) {
          response.strong_certificate = true; // 简化实现，假设有证书就是强证书
          // 完整证书链需要从TLS连接中提取
        }

        response.address = target.ip_address
          ? Buffer.from(target.ip_address.split('.').map((n) => parseInt(n)))
          : undefined;
      }

      // 网络统计（本地频道或extended权限）
      const local = extended || target.channel_id === actor.channel_id;
      if (local) {
        // TODO: 从voiceRouter获取加密统计
        response.from_client = new mumbleproto.UserStats.Stats({
          good: 0,
          late: 0,
          lost: 0,
          resync: 0,
        });

        response.from_server = new mumbleproto.UserStats.Stats({
          good: 0,
          late: 0,
          lost: 0,
          resync: 0,
        });

        // UDP/TCP统计
        response.udp_packets = 0;
        response.tcp_packets = 0;
        response.udp_ping_avg = 0;
        response.udp_ping_var = 0;
        response.tcp_ping_avg = 0;
        response.tcp_ping_var = 0;
      }

      // 发送响应
      const responseMessage = new mumbleproto.UserStats(response).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.UserStats, Buffer.from(responseMessage)); 

      logger.debug(`Sent UserStats for session ${target.session} to ${session_id}`);
    } catch (error) {
      logger.error(`Error handling UserStats for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 VoiceTarget 消息
   */
  private handleVoiceTarget(session_id: number, data: Buffer): void {
    try {
      const voiceTarget = mumbleproto.VoiceTarget.deserialize(data);

      if (!voiceTarget.id || voiceTarget.id < 1 || voiceTarget.id >= 0x1f) {
        logger.warn(`Invalid voice target ID from session ${session_id}: ${voiceTarget.id}`);
        return;
      }

      // 如果没有targets，表示删除该voice target
      if (!voiceTarget.targets || voiceTarget.targets.length === 0) {
        this.voiceRouter.removeVoiceTarget(session_id, voiceTarget.id);
        logger.debug(`Removed voice target ${voiceTarget.id} for session ${session_id}`);
        return;
      }

      // 保存voice target配置到voice router
      this.voiceRouter.setVoiceTarget(session_id, voiceTarget.id, voiceTarget.targets);

      logger.debug(
        `Set voice target ${voiceTarget.id} for session ${session_id}: ${voiceTarget.targets.length} targets`
      );
    } catch (error) {
      logger.error(`Error handling VoiceTarget for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 RequestBlob 消息
   */
  private async handleRequestBlob(session_id: number, data: Buffer): Promise<void> {
    try {
      const request = mumbleproto.RequestBlob.deserialize(data);

      // 检查 Hub 的 blob 存储是否启用
      if (!this.hubClient) {
        logger.warn('Hub client not available, cannot handle blob requests');
        return;
      }

      // 处理用户纹理请求
      if (request.session_texture && request.session_texture.length > 0) {
        for (const targetSession of request.session_texture) {
          try {
            const targetClient = this.clientManager.getClient(targetSession);
            if (!targetClient || !targetClient.user_id) {
              continue;
            }

            // 从 Hub 获取用户纹理
            const result = await this.hubClient.getUserTexture(targetClient.user_id);

            if (result.success && result.data && result.hash) {
              // 发送 UserState 消息，包含纹理数据
              const userState = new mumbleproto.UserState({
                session: targetSession,
                texture: result.data,
                temporary_access_tokens: [],
                listening_channel_add: [],
                listening_channel_remove: [],
              });
              this.messageHandler.sendMessage(
                session_id,
                MessageType.UserState,
                Buffer.from(userState.serialize())
              );
              logger.debug(`Sent texture for session ${targetSession} to session ${session_id}`);
            }
          } catch (error) {
            logger.error(`Error fetching texture for session ${targetSession}:`, error);
          }
        }
      }

      // 处理用户评论请求
      if (request.session_comment && request.session_comment.length > 0) {
        for (const targetSession of request.session_comment) {
          try {
            const targetClient = this.clientManager.getClient(targetSession);
            if (!targetClient || !targetClient.user_id) {
              continue;
            }

            // 从 Hub 获取用户评论
            const result = await this.hubClient.getUserComment(targetClient.user_id);

            if (result.success && result.data) {
              // 发送 UserState 消息，包含评论
              const userState = new mumbleproto.UserState({
                session: targetSession,
                comment: result.data.toString('utf-8'),
                temporary_access_tokens: [],
                listening_channel_add: [],
                listening_channel_remove: [],
              });
              this.messageHandler.sendMessage(
                session_id,
                MessageType.UserState,
                Buffer.from(userState.serialize())
              );
              logger.debug(`Sent comment for session ${targetSession} to session ${session_id}`);
            }
          } catch (error) {
            logger.error(`Error fetching comment for session ${targetSession}:`, error);
          }
        }
      }

      // 频道描述请求
      if (request.channel_description && request.channel_description.length > 0) {
        for (const channel_id of request.channel_description) {
          const channel = this.channelManager.getChannel(channel_id);
          if (channel && channel.description) {
            const response = new mumbleproto.ChannelState({
              channel_id: channel_id,
              description: channel.description,
              links: [],
              links_add: [],
              links_remove: [],
            }).serialize();

            this.messageHandler.sendMessage(session_id, MessageType.ChannelState, Buffer.from(response)); 
          }
        }
      }

      logger.debug(`Handled RequestBlob from session ${session_id}`);
    } catch (error) {
      logger.error(`Error handling RequestBlob for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 UserList 消息
   */
  private handleUserList(session_id: number, data: Buffer): void {
    try {
      const userList = mumbleproto.UserList.deserialize(data);

      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`UserList from unknown session: ${session_id}`);
        return;
      }

      // 需要根频道的Register权限
      const rootChannel = this.channelManager.getChannel(0);
      if (!rootChannel || !this.hasPermission(actor, rootChannel, Permission.Register)) {
        this.sendPermissionDenied(
          session_id,
          'register',
          'UserList requires Register permission on root channel'
        );
        return;
      }

      // 如果是查询请求（无users字段）
      if (!userList.users || userList.users.length === 0) {
        // 返回所有注册用户
        // TODO: 从Hub或用户缓存获取所有用户
        const response = new mumbleproto.UserList({
          users: [], // 暂时返回空列表
        }).serialize();

        this.messageHandler.sendMessage(session_id, MessageType.UserList, Buffer.from(response)); 
        logger.debug(`Sent UserList response to session ${session_id}`);
      } else {
        // 用户重命名或注销请求
        // TODO: 实现用户管理功能
        logger.warn(`UserList modification not implemented: ${userList.users.length} users`);
      }
    } catch (error) {
      logger.error(`Error handling UserList for session ${session_id}:`, error);
    }
  }

  /**
   * 处理来自Hub的语音数据路由
   */
  private handleVoiceDataFromHub(data: any, respond: (result?: any, error?: any) => void): void {
    try {
      // TODO: 实现VoiceRouter.handleVoiceDataFromHub方法
      // 处理来自Hub的语音数据，路由到本地客户端
      // this.voiceRouter.handleVoiceDataFromHub(data);
      logger.debug('Received voice data from Hub:', data);
      respond({ success: true });
    } catch (error) {
      logger.error('Error handling voice data from Hub:', error);
      respond(undefined, { code: -32603, message: 'Internal error' });
    }
  }

  /**
   * 设置语音UDP传输处理器
   * 监听VoiceRouter的广播事件，通过UDP转发到其他Edge
   */
  private setupVoiceTransportHandlers(): void {
    if (!this.voiceTransport) {
      return;
    }

    // 监听VoiceRouter的广播事件
    this.voiceRouter.on('broadcastToChannel', (channel_id: number, broadcast: any, _excludeSession: number) => {
      // 在集群模式下，通过UDP直接转发语音包到其他Edge
      if (this.config.mode === 'cluster' && this.voiceTransport) {
        // 获取该频道中有用户的 Edge 列表
        const targetEdges = this.stateManager.getEdgesInChannel(channel_id);
        if (targetEdges.size === 0) {
          logger.debug(`Skip voice broadcast: no remote users in channel ${channel_id}`);
          return;
        }
        
        // 从 Mumble 语音包中提取 codec（第一个字节的高3位）
        const header = broadcast.packet.readUInt8(0);
        const codec = (header >> 5) & 0x07;
        
        const voicePacket = {
          version: 1,
          senderId: broadcast.sender_id,
          targetId: channel_id, // 使用频道ID作为targetId
          sequence: 0, // 序列号在 Mumble 包内部
          codec: codec,
        };
        
        // 只向有该频道用户的 Edge 发送语音包
        for (const targetEdgeId of targetEdges) {
          if (targetEdgeId !== this.config.server_id) {
            this.voiceTransport.sendToEdge(targetEdgeId, voicePacket, broadcast.packet);
          }
        }
        
        logger.debug(
          `Forwarded voice to ${targetEdges.size} edges in channel ${channel_id}: ` +
          `sender=${broadcast.sender_id}, codec=${codec}, packet_size=${broadcast.packet.length}, ` +
          `targets=[${Array.from(targetEdges).join(',')}]`
        );
      }
    });

    this.voiceRouter.on('broadcastToServer', (broadcast: any, excludeSession: number) => {
      if (!this.voiceTransport) {
        return;
      }

      // 广播到所有其他Edge（服务器广播）
      logger.debug(`Broadcasting voice to server via UDP, excluding session ${excludeSession}`);
      
      const voicePacket = {
        version: 1,
        senderId: broadcast.sender_id,
        targetId: 0xFFFFFFFF, // 服务器广播标记
        sequence: 0,
        codec: 0,
      };
      
      this.voiceTransport.broadcast(voicePacket, broadcast.packet, this.config.server_id);
    });

    // 监听接收到的UDP语音包（来自其他Edge）
    this.voiceTransport.on('voice-packet', (packetData: { header: any; voiceData: Buffer }) => {
      // 将接收到的语音包路由到本地客户端
      const { header, voiceData } = packetData;
      logger.debug(
        `Received UDP voice packet: ` +
        `sender_edge=${header.senderId}, target=${header.targetId}, ` +
        `codec=${header.codec}, data_size=${voiceData.length}`
      );
      
      // voiceData是完整的Mumble语音包（header+session+sequence+voice_data）
      // 需要根据targetId确定广播目标
      if (header.targetId === 0xFFFFFFFF) {
        // 服务器广播 - 转发给所有本地用户
        this.handleRemoteServerVoiceBroadcast(voiceData);
      } else if (header.targetId >= 0) {
        // 频道广播（targetId 是频道ID）或普通广播（targetId=0）
        // 转发给本地所有可以接收的客户端
        this.handleRemoteChannelVoiceBroadcast(voiceData);
      } else {
        logger.warn(`Unexpected targetId: ${header.targetId}`);
      }
    });

    this.voiceTransport.on('error', (error: Error) => {
      logger.error('Voice UDP transport error:', error);
    });

    logger.debug('Voice transport handlers setup complete');
  }

  /**
   * 处理来自其他Edge的频道语音广播（通过UDP）
   */
  private handleRemoteChannelVoiceBroadcast(voiceData: Buffer): void {
    try {
      // voiceData格式: [header][session_varint][sequence_varint][voice_data]
      // 这是完整的 Mumble 语音包格式，可以直接转发
      
      // 解析session来确定发送者
      const senderSession = this.parseSessionFromVoicePacket(voiceData);
      if (senderSession === null) {
        logger.warn('Failed to parse session from remote voice packet');
        return;
      }
      
      logger.debug(`Received remote voice from session ${senderSession}`);
      
      // 远程用户的状态已经通过 Hub 同步到本地
      // 我们可以从远程用户列表中查找（通过 user.remoteUserJoined 通知同步）
      // 但语音包可以直接转发给频道内的所有用户，不需要查询频道
      
      // 根据发送者的session ID，从本地客户端映射中查找对应的用户信息
      // 注意：远程用户的session ID可能与本地不同，需要通过 Hub 同步的全局用户状态
      
      // 简化方案：直接转发给所有本地客户端
      // 客户端会根据自己的频道和状态决定是否播放
      const allClients = this.clientManager.getAllClients();
      
      let forwardedCount = 0;
      for (const client of allClients) {
        // 跳过 deaf 或 self_deaf 的客户端
        if (client.deaf || client.self_deaf) {
          continue;
        }
        
        // 跳过未认证的客户端
        if (!client.user_id || client.user_id <= 0) {
          continue;
        }
        
        // 跳过发送者自己（如果session匹配）
        if (client.session === senderSession) {
          continue;
        }
        
        // 转发语音包
        this.voiceRouter.sendVoicePacketToClient(client, voiceData);
        forwardedCount++;
      }
      
      logger.debug(`Forwarded remote voice from session ${senderSession} to ${forwardedCount} local clients`);
    } catch (error) {
      logger.error('Error handling remote channel voice broadcast:', error);
    }
  }
  
  /**
   * 处理来自其他Edge的服务器语音广播（通过UDP）
   */
  private handleRemoteServerVoiceBroadcast(voiceData: Buffer): void {
    try {
      logger.debug('Received remote server voice broadcast');
      
      // 服务器广播：转发给所有本地用户
      const allClients = this.clientManager.getAllClients();
      
      for (const client of allClients) {
        if (client.deaf || client.self_deaf) {
          continue;
        }
        
        if (!client.user_id || client.user_id <= 0) {
          continue;
        }
        
        this.voiceRouter.sendVoicePacketToClient(client, voiceData);
      }
      
      logger.debug(`Forwarded remote server broadcast to ${allClients.length} local clients`);
    } catch (error) {
      logger.error('Error handling remote server voice broadcast:', error);
    }
  }
  
  /**
   * 从语音包中解析session ID
   */
  private parseSessionFromVoicePacket(data: Buffer): number | null {
    if (data.length < 2) {
      return null;
    }
    
    // 跳过header（1字节）
    let offset = 1;
    
    // 解析varint格式的session ID
    const v = data.readUInt8(offset);
    
    if ((v & 0x80) === 0x00) {
      // 单字节
      return v & 0x7f;
    } else if ((v & 0xc0) === 0x80) {
      // 双字节
      if (offset + 1 >= data.length) return null;
      return ((v & 0x3f) << 8) | data.readUInt8(offset + 1);
    } else if ((v & 0xf0) === 0xf0) {
      // 完整32位整数
      if (offset + 4 >= data.length) return null;
      return (
        (data.readUInt8(offset + 1) << 24) |
        (data.readUInt8(offset + 2) << 16) |
        (data.readUInt8(offset + 3) << 8) |
        data.readUInt8(offset + 4)
      ) >>> 0;
    } else if ((v & 0xe0) === 0xc0) {
      // 3字节
      if (offset + 2 >= data.length) return null;
      return ((v & 0x1f) << 16) | (data.readUInt8(offset + 1) << 8) | data.readUInt8(offset + 2);
    }
    
    return null;
  }

  /**
   * 处理来自其他Edge的用户加入通知
   */
  private handleRemoteUserJoined(params: any): void {
    try {
      // 不要处理来自本Edge的用户
      if (params.edge_id === this.config.server_id) {
        return;
      }

      logger.info(`Remote user joined: ${params.username} (session ${params.session_id}) from Edge ${params.edge_id}`);

      // 追踪远程用户状态
      this.stateManager.addRemoteUser(params.session_id, params.edge_id, params.channel_id);

      // 构建UserState消息
      const userState = new mumbleproto.UserState({
        session: params.session_id,
        user_id: params.user_id,
        name: params.username,
        channel_id: params.channel_id,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      });

      if (params.cert_hash) {
        userState.hash = params.cert_hash;
      }

      const userStateMessage = userState.serialize();

      // 广播给所有本地已认证的客户端
      const allClients = this.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0 && client.has_full_user_list) {
          this.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userStateMessage));
        }
      }

      logger.debug(`Broadcasted remote user ${params.username} to ${allClients.filter(c => c.user_id > 0 && c.has_full_user_list).length} local clients`);
    } catch (error) {
      logger.error('Error handling remote user joined:', error);
    }
  }

  /**
   * 处理来自Hub的用户离开广播
   * Hub收到userLeft通知后会广播给所有Edge（包括发起的Edge）
   */
  private handleRemoteUserLeft(params: any): void {
    try {
      const { session_id, edge_id, username } = params;

      logger.info(`User left notification from Hub: ${username || 'unknown'} (session ${session_id}) from Edge ${edge_id}`);

      // 构建UserRemove消息
      const userRemove = new mumbleproto.UserRemove({
        session: session_id,
      });

      const userRemoveMessage = userRemove.serialize();

      // 广播给所有本地已认证的客户端
      const allClients = this.clientManager.getAllClients();
      for (const client of allClients) {
        // 跳过用户自己（如果是本Edge的用户断开）
        if (client.session === session_id) {
          continue;
        }
        
        if (client.user_id > 0) {
          this.messageHandler.sendMessage(client.session, MessageType.UserRemove, Buffer.from(userRemoveMessage));
        }
      }

      logger.debug(`Broadcasted user removal (session ${session_id}) to ${allClients.filter(c => c.user_id > 0 && c.session !== session_id).length} local clients`);
    } catch (error) {
      logger.error('Error handling user left from Hub:', error);
    }
  }

  /**
   * 处理来自其他Edge的用户状态变更通知
   */
  private handleRemoteUserStateChanged(params: any): void {
    try {
      // 不要处理来自本Edge的用户
      if (params.edge_id === this.config.server_id) {
        return;
      }

      logger.debug(`Remote user state changed: session ${params.session_id} from Edge ${params.edge_id}`);

      // 更新状态管理器中的远程用户频道信息
      if (params.channel_id !== undefined) {
        this.stateManager.updateRemoteUserChannel(params.session_id, params.channel_id);
      }

      // 构建UserState消息
      const userState = new mumbleproto.UserState({
        session: params.session_id,
        temporary_access_tokens: [],
        listening_channel_add: [],
        listening_channel_remove: [],
      });

      // 只包含变更的字段
      if (params.channel_id !== undefined) {
        userState.channel_id = params.channel_id;
      }
      if (params.mute !== undefined) {
        userState.mute = params.mute;
      }
      if (params.deaf !== undefined) {
        userState.deaf = params.deaf;
      }
      if (params.suppress !== undefined) {
        userState.suppress = params.suppress;
      }
      if (params.self_mute !== undefined) {
        userState.self_mute = params.self_mute;
      }
      if (params.self_deaf !== undefined) {
        userState.self_deaf = params.self_deaf;
      }
      if (params.recording !== undefined) {
        userState.recording = params.recording;
      }
      if (params.priority_speaker !== undefined) {
        userState.priority_speaker = params.priority_speaker;
      }

      const userStateMessage = userState.serialize();

      // 广播给所有本地已认证的客户端
      const allClients = this.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0 && client.has_full_user_list) {
          this.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(userStateMessage));
        }
      }

      logger.debug(`Broadcasted remote user state change to ${allClients.filter(c => c.user_id > 0 && c.has_full_user_list).length} local clients`);
    } catch (error) {
      logger.error('Error handling remote user state changed:', error);
    }
  }

  /**
   * 处理来自Hub的UserState响应
   * 当Hub处理完UserState请求后，会单独回复给发起请求的Edge
   */
  private handleUserStateResponseFromHub(params: any): void {
    try {
      const { success, actor_session, error, permission_denied } = params;

      if (!success) {
        logger.warn(`UserState request from session ${actor_session} failed: ${error}`);
        
        // 如果是权限拒绝，发送PermissionDenied消息给客户端
        if (permission_denied) {
          this.sendPermissionDenied(actor_session, 'userstate', error || 'Permission denied');
        } else {
          // 其他错误，可以考虑发送文本消息通知用户
          logger.debug(`Sending error notification to session ${actor_session}`);
        }
        return;
      }

      logger.debug(`UserState request from session ${actor_session} succeeded`);
      // 成功的响应不需要特别处理，因为Hub会广播更新到所有Edge
    } catch (error) {
      logger.error('Error handling UserState response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelState响应
   */
  private handleChannelStateResponseFromHub(params: any): void {
    try {
      const { success, actor_session, error, permission_denied } = params;

      if (!success) {
        logger.warn(`ChannelState request from session ${actor_session} failed: ${error}`);
        
        if (permission_denied) {
          this.sendPermissionDenied(actor_session, 'channelstate', error || 'Permission denied');
        }
        return;
      }

      logger.debug(`ChannelState request from session ${actor_session} succeeded`);
    } catch (error) {
      logger.error('Error handling ChannelState response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的ChannelState广播
   */
  private handleChannelStateBroadcastFromHub(params: any): void {
    try {
      const { channelState } = params;

      logger.debug(`Received ChannelState broadcast from Hub: channel ${channelState.channel_id}`);

      // 更新本地频道状态镜像
      if (channelState.channel_id !== undefined) {
        const existingChannel = this.channelManager.getChannel(channelState.channel_id);
        
        if (existingChannel) {
          // 更新现有频道
          if (channelState.name !== undefined) {
            existingChannel.name = channelState.name;
          }
          if (channelState.position !== undefined) {
            existingChannel.position = channelState.position;
          }
          if (channelState.max_users !== undefined) {
            existingChannel.max_users = channelState.max_users;
          }
          if (channelState.description !== undefined) {
            existingChannel.description = channelState.description;
          }
        } else {
          // 创建新频道（不包含id，由createChannel自动分配）
          const newChannel = this.channelManager.createChannel({
            name: channelState.name || 'Unnamed Channel',
            parent_id: channelState.parent || 0,
            description: channelState.description || '',
            position: channelState.position || 0,
            max_users: channelState.max_users || 0,
            temporary: channelState.temporary || false,
            inherit_acl: true,
            children: [],
            links: [],
          });
          
          // 手动设置频道ID为Hub分配的ID
          newChannel.id = channelState.channel_id;
        }
      }

      // 广播给所有本地已认证的客户端
      const channelStateMsg = new mumbleproto.ChannelState(channelState);
      const channelStateMessage = channelStateMsg.serialize();
      
      const allClients = this.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0) {
          this.messageHandler.sendMessage(client.session, MessageType.ChannelState, Buffer.from(channelStateMessage));
        }
      }

      logger.debug(`Broadcasted ChannelState to ${allClients.filter(c => c.user_id > 0).length} local clients`);
    } catch (error) {
      logger.error('Error handling ChannelState broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的UserRemove响应
   */
  private handleUserRemoveResponseFromHub(params: any): void {
    try {
      const { success, actor_session, error } = params;

      if (!success) {
        logger.warn(`UserRemove request from session ${actor_session} failed: ${error}`);
        this.sendPermissionDenied(actor_session, 'kick', error || 'Operation failed');
        return;
      }

      logger.debug(`UserRemove request from session ${actor_session} succeeded`);
    } catch (error) {
      logger.error('Error handling UserRemove response from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的UserRemove广播
   */
  private handleUserRemoveBroadcastFromHub(params: any): void {
    try {
      const { actor_session, target_session, target_edge_id, reason, ban } = params;

      logger.debug(`Received UserRemove broadcast from Hub: target ${target_session} on Edge ${target_edge_id}`);

      // 构建UserRemove消息
      const userRemove = new mumbleproto.UserRemove({
        session: target_session,
        actor: actor_session,
        reason: reason || '',
        ban: ban || false,
      });

      const userRemoveMessage = userRemove.serialize();

      // 广播给所有本地已认证的客户端
      const allClients = this.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0) {
          this.messageHandler.sendMessage(client.session, MessageType.UserRemove, Buffer.from(userRemoveMessage));
        }
      }

      // 如果目标用户在本Edge，强制断开连接
      if (target_edge_id === this.config.server_id) {
        const targetClient = this.clientManager.getClient(target_session);
        if (targetClient) {
          this.clientManager.forceDisconnect(
            target_session,
            ban ? `Banned: ${reason}` : `Kicked: ${reason}`
          );
          logger.info(`Disconnected local client ${target_session} due to ${ban ? 'ban' : 'kick'}`);
        }
      }

      logger.debug(`Broadcasted UserRemove to ${allClients.filter(c => c.user_id > 0).length} local clients`);
    } catch (error) {
      logger.error('Error handling UserRemove broadcast from Hub:', error);
    }
  }

  /**
   * Hub返回的ChannelRemove响应
   */
  private handleChannelRemoveResponseFromHub(data: any) {
    try {
      const { success, error, actor_session } = data;
      
      logger.info(`ChannelRemove response from Hub: success=${success}, error=${error}`);
      
      // 找到发起删除的客户端
      const actor = this.clientManager.getClient(actor_session);
      if (!actor) {
        logger.warn(`ChannelRemove actor ${actor_session} not found on this Edge`);
        return;
      }
      
      // 如果失败，返回错误给客户端
      if (!success && error) {
        this.sendPermissionDenied(actor_session, 'write', error, 0, mumbleproto.PermissionDenied.DenyType.Permission);
        logger.info(`Sent PermissionDenied to actor ${actor_session}: ${error}`);
      }
      
      // 成功的情况下，实际的频道删除由broadcast消息处理
      
    } catch (error) {
      logger.error('Error handling ChannelRemove response from Hub:', error);
    }
  }

  /**
   * Hub广播的ChannelRemove通知 - 更新本地镜像并通知客户端
   */
  private handleChannelRemoveBroadcastFromHub(data: any) {
    try {
      const { channel_id, channels_removed, affected_sessions, parent_id } = data;
      
      logger.info(`ChannelRemove broadcast from Hub: channel=${channel_id}, removed=${channels_removed.length}, affected=${affected_sessions.length}`);
      
      // 1. 更新本地频道镜像 - 删除所有被移除的频道
      for (const removed_id of channels_removed) {
        this.channelManager.removeChannel(removed_id);
        logger.debug(`Removed channel ${removed_id} from local mirror`);
      }
      
      // 2. 更新受影响用户的频道位置（他们已被Hub移动到父频道）
      for (const session of affected_sessions) {
        const client = this.clientManager.getClient(session);
        if (client) {
          const oldChannel = client.channel_id;
          client.channel_id = parent_id;
          logger.debug(`Updated session ${session} channel: ${oldChannel} -> ${parent_id}`);
        }
      }
      
      // 3. 构造ChannelRemove消息并广播给所有本地客户端
      const channelRemoveMessage = {
        channel_id,
      };
      const channelRemoveBuffer = Buffer.from(new mumbleproto.ChannelRemove(channelRemoveMessage).serialize());
      
      const allClients = this.clientManager.getAllClients();
      for (const client of allClients) {
        if (client.user_id > 0) { // 只发送给已认证的客户端
          this.messageHandler.sendMessage(client.session, MessageType.ChannelRemove, channelRemoveBuffer);
        }
      }
      
      // 4. 为每个受影响的用户发送UserState更新（新的channel_id）
      for (const session of affected_sessions) {
        const client = this.clientManager.getClient(session);
        if (client) {
          const userStateUpdate = new mumbleproto.UserState({
            session,
            channel_id: parent_id,
            temporary_access_tokens: [],
            listening_channel_add: [],
            listening_channel_remove: [],
          });
          const userStateBuffer = Buffer.from(userStateUpdate.serialize());
          
          // 广播给所有本地客户端
          for (const c of allClients) {
            if (c.user_id > 0) {
              this.messageHandler.sendMessage(c.session, MessageType.UserState, userStateBuffer);
            }
          }
        }
      }
      
      logger.info(`Broadcasted ChannelRemove to ${allClients.filter(c => c.user_id > 0).length} local clients`);
      
    } catch (error) {
      logger.error('Error handling ChannelRemove broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自Hub的TextMessage广播
   */
  private handleTextMessageBroadcastFromHub(params: any): void {
    try {
      const { textMessage, target_sessions } = params;

      logger.debug(`Received TextMessage broadcast from Hub: from ${textMessage.actor}, targets: ${target_sessions.length}`);

      // 构建TextMessage消息
      const textMsg = new mumbleproto.TextMessage({
        actor: textMessage.actor,
        session: textMessage.session || [],
        channel_id: textMessage.channel_id || [],
        tree_id: textMessage.tree_id || [],
        message: textMessage.message || '',
      });

      const textMessageBuffer = Buffer.from(textMsg.serialize());

      // 只发送给本Edge上的目标用户
      let sentCount = 0;
      for (const targetSession of target_sessions) {
        const client = this.clientManager.getClient(targetSession);
        if (client && client.user_id > 0) {
          this.messageHandler.sendMessage(targetSession, MessageType.TextMessage, textMessageBuffer);
          sentCount++;
        }
      }

      logger.debug(`Broadcasted TextMessage to ${sentCount} local clients`);
    } catch (error) {
      logger.error('Error handling TextMessage broadcast from Hub:', error);
    }
  }

  /**
   * 处理来自 Hub 的 ACL 响应
   */

  /**
   * 处理来自 Hub 的 ACL 更新通知
   * 当 Hub 更新频道 ACL 时，通知 Edge 刷新该频道的权限
   */
  private handleACLUpdatedNotification(params: { channel_id: number; timestamp: number }): void {
    try {
      const { channel_id } = params;
      logger.info(`Received ACL update notification for channel ${channel_id}`);
      
      // 触发频道权限刷新
      void this.refreshChannelPermissions(channel_id);
    } catch (error) {
      logger.error('Error handling ACL update notification:', error);
    }
  }

  /**
   * 频道权限动态刷新
   * 当 ACL 变更时，自动更新频道内所有用户的 suppress 状态
   * 参照 Go 实现：server.go:1774-1793
   */
  private async refreshChannelPermissions(channel_id: number): Promise<void> {
    try {
      // 获取频道信息
      const channel = this.channelManager.getChannel(channel_id);
      if (!channel) {
        logger.warn(`Cannot refresh permissions for unknown channel: ${channel_id}`);
        return;
      }

      // 获取频道内的所有用户
      const clientsInChannel = this.clientManager.getClientsInChannel(channel_id);
      
      if (clientsInChannel.length === 0) {
        logger.debug(`No users in channel ${channel_id}, skipping permission refresh`);
        return;
      }

      logger.info(`Refreshing permissions for ${clientsInChannel.length} users in channel ${channel_id}`);

      // 对每个用户重新计算 suppress 状态
      for (const client of clientsInChannel) {
        if (!client.user_id || client.user_id <= 0) {
          continue; // 跳过未认证的客户端
        }

        // 检查用户是否有 Speak 权限
        const hasSpeak = await this.checkPermission(
          client.session,
          channel_id,
          Permission.Speak
        );

        // 计算新的 suppress 状态
        // suppress = 没有 Speak 权限，且不是自我静音
        const newSuppress = !hasSpeak && !client.self_mute;

        // 如果 suppress 状态改变，更新并广播
        if (client.suppress !== newSuppress) {
          logger.debug(
            `User ${client.username} in channel ${channel_id}: suppress changed from ${client.suppress} to ${newSuppress}`
          );

          // 更新本地状态
          this.clientManager.updateClient(client.session, {
            suppress: newSuppress,
          });

          // 广播状态变更给所有客户端
          const userState = new mumbleproto.UserState({
            session: client.session,
            suppress: newSuppress,
            temporary_access_tokens: [],
            listening_channel_add: [],
            listening_channel_remove: [],
          });

          // 广播给所有已认证的客户端
          const allClients = this.clientManager.getAllClients();
          for (const otherClient of allClients) {
            if (otherClient.user_id > 0) {
              this.messageHandler.sendMessage(
                otherClient.session,
                MessageType.UserState,
                Buffer.from(userState.serialize())
              );
            }
          }

          // 在集群模式下，同步到 Hub
          if (this.config.mode === 'cluster' && this.hubClient) {
            this.hubClient.notify('hub.handleUserState', {
              edge_id: this.config.server_id,
              actor_session: 0, // 系统操作
              actor_user_id: 0,
              actor_username: 'System',
              userState: {
                session: client.session,
                suppress: newSuppress,
              },
            });
          }
        }
      }

      logger.info(`Permission refresh completed for channel ${channel_id}`);
    } catch (error) {
      logger.error(`Failed to refresh permissions for channel ${channel_id}:`, error);
    }
  }

  /**
   * 检查用户是否有某个权限
   */
  private async checkPermission(
    session_id: number,
    channel_id: number,
    permission: Permission
  ): Promise<boolean> {
    try {
      const client = this.clientManager.getClient(session_id);
      if (!client || !client.user_id) {
        return false;
      }

      // 如果有 PermissionManager，使用它来检查权限
      if (this.permissionManager) {
        const channel = this.channelManager.getChannel(channel_id);
        if (channel) {
          // 构建客户端信息对象
          const channelTree = new Map<number, ChannelInfo>();
          // 获取所有频道构建频道树
          const allChannels = this.channelManager.getAllChannels();
          for (const ch of allChannels) {
            channelTree.set(ch.id, ch);
          }
          
          return this.permissionManager.hasPermission(
            channel,
            client as ClientInfo,
            permission,
            channelTree,
            this.aclMap
          );
        }
      }

      // Fallback: 如果本地无法检查，返回 false
      // TODO: 可以考虑添加 Hub RPC 接口来检查权限
      logger.debug(`Cannot check permission locally for user ${client.user_id} on channel ${channel_id}`);
      return false;
    } catch (error) {
      logger.error(`Error checking permission:`, error);
      return false;
    }
  }

  /**
   * 上传用户纹理到 Hub blob 存储
   */
  private async uploadUserTexture(user_id: number, data: Uint8Array): Promise<void> {
    if (!this.hubClient) {
      throw new Error('Hub client not available');
    }

    try {
      const result = await this.hubClient.setUserTexture(user_id, Buffer.from(data));

      if (!result.success) {
        throw new Error(result.error || 'Failed to upload texture');
      }

      logger.info(`Uploaded texture for user ${user_id}: ${result.hash}`);
    } catch (error) {
      logger.error(`Error uploading texture for user ${user_id}:`, error);
      throw error;
    }
  }

  /**
   * 上传用户评论到 Hub blob 存储
   */
  private async uploadUserComment(user_id: number, data: Buffer): Promise<void> {
    if (!this.hubClient) {
      throw new Error('Hub client not available');
    }

    try {
      const result = await this.hubClient.setUserComment(user_id, data);

      if (!result.success) {
        throw new Error(result.error || 'Failed to upload comment');
      }

      logger.info(`Uploaded comment for user ${user_id}: ${result.hash}`);
    } catch (error) {
      logger.error(`Error uploading comment for user ${user_id}:`, error);
      throw error;
    }
  }
}
