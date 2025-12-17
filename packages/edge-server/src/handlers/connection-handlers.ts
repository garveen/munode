import type { TLSSocket } from 'tls';
import type { RemoteInfo } from 'dgram';
import type { Logger } from 'winston';
import type { ClientInfo } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

/**
 * 连接处理器 - 处理TLS连接和UDP消息
 */
export class ConnectionHandlers {
  private udpAddressToSession: Map<string, number> = new Map(); // "ip:port" -> session_id
  private logger: Logger;
  
  // UDP Ping 频率限制
  private lastPingCycleTime: number = 0; // 上次 ping 周期的开始时间
  private currentCycleIPs: Set<string> = new Set(); // 当前周期已响应的 IP 地址

  constructor(private factory: HandlerFactory) {
    this.logger = factory.logger;
  }

  private get clientManager() { return this.factory.clientManager; }
  private get voiceRouter() { return this.factory.voiceRouter; }
  private get banManager() { return this.factory.banManager; }
  private get hubClient() { return this.factory.hubClient; }
  private get config() { return this.factory.config; }
  private get udpServer() { return this.voiceRouter.getUDPServer(); }

  /**
   * 处理 TLS 连接
   */
  async handleTLSConnection(socket: TLSSocket): Promise<void> {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.debug(`New TLS connection from ${clientAddress}`);

    // Set connection timeout (30 seconds for initial handshake)
    const connectionTimeout = setTimeout(() => {
      this.logger.warn(`Connection timeout for ${clientAddress}, destroying socket`);
      socket.destroy();
    }, 30000);

    try {
      // 获取证书哈希
      let cert_hash: string | undefined;
      try {
        const cert = socket.getPeerCertificate();
        if (cert && cert.fingerprint) {
          cert_hash = cert.fingerprint.replace(/:/g, '').toLowerCase();
        }
      } catch (error) {
        // 证书获取失败，继续处理
        this.logger.debug('Failed to get peer certificate:', error);
      }

      // 检查封禁
      const banCheck = await this.banManager.checkConnection(socket.remoteAddress, cert_hash);
      if (banCheck.banned) {
        this.logger.warn(
          `Rejected TLS connection from banned client: ${socket.remoteAddress}, cert: ${cert_hash?.substring(0, 8)}..., reason: ${banCheck.reason}`
        );
        clearTimeout(connectionTimeout);
        socket.destroy();
        return;
      }

      // 在集群模式下，从 Hub 分配 session ID
      let sessionId: number;
      try {
        sessionId = await this.hubClient.allocateSessionId();
        this.logger.debug(`Allocated session ID ${sessionId} from Hub for ${clientAddress}`);
      } catch (error) {
        this.logger.error('Failed to allocate session ID from Hub:', error);
        clearTimeout(connectionTimeout);
        socket.destroy();
        return;
      }

      // Clear timeout once session is allocated
      clearTimeout(connectionTimeout);

      // 创建客户端（使用从 Hub 分配的 session ID，并传递证书哈希）
      this.clientManager.createClient(socket, sessionId, cert_hash);
      
      // 记录证书信息
      if (cert_hash) {
        this.logger.debug(`Client session ${sessionId} has certificate hash: ${cert_hash.substring(0, 16)}...`);
      }
    } catch (error) {
      this.logger.error('Error handling TLS connection:', error);
      clearTimeout(connectionTimeout);
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
  handleUDPMessage(msg: Buffer, rinfo: RemoteInfo): void {
    const addressKey = `${rinfo.address}:${rinfo.port}`;
    this.logger.debug(`[UDP] Received ${msg.length} bytes from ${addressKey}`);
    
    // 检查是否是 UDP ping 包（长度为 12 字节）
    if (msg.length === 12) {
      this.handleUDPPing(msg, rinfo);
      return;
    }
    
    let session_id: number | undefined;
    let needsUpdate = false;
    let decryptedData: Buffer | null = null; // 存储解密后的数据

    // 1. 首先查找精确的IP:Port映射
    session_id = this.udpAddressToSession.get(addressKey);

    if (!session_id) {
      // 2. 没有精确映射，尝试匹配同一IP的客户端
        this.logger.debug(`No UDP mapping for ${addressKey}, trying to match by IP and decryption`);

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
            decryptedData = decrypted.data; // 保存解密后的数据
        this.logger.debug(`UDP address matched by decryption: ${addressKey} -> session ${client.session} (${client.username})`);
            break;
          }
        } catch (_error) {
          // 解密失败，继续尝试下一个客户端
        this.logger.debug(`Failed to decrypt UDP packet with client ${client.session} key`);
        }
      }

      if (!matchedClient) {
        this.logger.warn(`Unable to match any client for UDP address: ${addressKey}`);
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
        this.logger.debug(`UDP address changed for session ${session_id}: ${client.udp_ip}:${client.udp_port} -> ${rinfo.address}:${rinfo.port}`);
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

        this.logger.debug(`Updated UDP mapping: ${addressKey} -> session ${session_id}`);
    }

    // 6. 转发消息到 VoiceRouter
    // 如果在匹配阶段已经解密过，传递解密后的数据
    if (decryptedData) {
      this.voiceRouter.handleUDPPacket(session_id, decryptedData, rinfo, true);
    } else {
      this.voiceRouter.handleUDPPacket(session_id, msg, rinfo, false);
    }
  }

  /**
   * 处理 UDP Ping 请求
   * 参考 Go 实现的 handleUDPMOTD 函数
   * 
   * 频率限制：
   * - 每秒最多触发一次
   * - 在同一个触发周期内对每个源IP只响应一次
   */
  private handleUDPPing(msg: Buffer, rinfo: RemoteInfo): void {
    // 检查是否启用 UDP ping 功能
    if (!this.config.features.allowPing) {
      this.logger.debug(`UDP ping from ${rinfo.address} ignored (allowPing disabled)`);
      return;
    }

    const now = Date.now();
    const sourceIP = rinfo.address;

    // 检查是否进入新的周期（每秒一个周期）
    if (now - this.lastPingCycleTime >= 1000) {
      // 进入新周期，重置
      this.lastPingCycleTime = now;
      this.currentCycleIPs.clear();
      this.logger.debug(`New UDP ping cycle started at ${now}`);
    }

    // 检查当前周期内是否已响应过该 IP
    if (this.currentCycleIPs.has(sourceIP)) {
      this.logger.debug(`UDP ping from ${sourceIP} ignored (already responded in current cycle)`);
      return;
    }

    // 解析 ping 请求
    try {
      const requestVersion = msg.readUInt32BE(0);
      const requestRand = msg.readBigUInt64BE(4);

      this.logger.debug(
        `Received UDP ping from ${rinfo.address}:${rinfo.port}, version: ${requestVersion}, rand: ${requestRand}`
      );

      // 构造响应包
      const response = Buffer.allocUnsafe(24);
      let offset = 0;

      // Protocol version (from mumbleproto, typically 0x010204 for 1.2.4)
      // 使用协议版本号，参考 Go 实现的 verProtover
      const protocolVersion = 0x010204; // Version 1.2.4
      response.writeUInt32BE(protocolVersion, offset);
      offset += 4;

      // Echo back the random number
      response.writeBigUInt64BE(requestRand, offset);
      offset += 8;

      // Current user count
      const currentUsers = this.clientManager.getClientCount();
      response.writeUInt32BE(currentUsers, offset);
      offset += 4;

      // Maximum users (0xFFFFFFFF for unlimited)
      const maxUsers = this.config.capacity || 0xFFFFFFFF;
      response.writeUInt32BE(maxUsers, offset);
      offset += 4;

      // Bandwidth (in bits per second)
      const bandwidth = this.config.max_bandwidth || 0;
      response.writeUInt32BE(bandwidth, offset);

      // 发送响应
      const udpSocket = this.udpServer;
      if (udpSocket) {
        udpSocket.send(response, rinfo.port, rinfo.address, (err) => {
          if (err) {
            this.logger.error(`Failed to send UDP ping response to ${rinfo.address}:${rinfo.port}:`, err);
          } else {
            this.logger.debug(
              `Sent UDP ping response to ${rinfo.address}:${rinfo.port} (users: ${currentUsers}/${maxUsers})`
            );
          }
        });

        // 记录本周期已响应该 IP
        this.currentCycleIPs.add(sourceIP);
      } else {
        this.logger.warn('UDP server not available for ping response');
      }
    } catch (error) {
      this.logger.error(`Error handling UDP ping from ${rinfo.address}:`, error);
    }
  }

  /**
   * 清理客户端的UDP映射
   */
  clearUDPMapping(session_id: number): void {
    const client = this.clientManager.getClient(session_id);
    if (client && client.udp_ip && client.udp_port) {
      const addressKey = `${client.udp_ip}:${client.udp_port}`;
      this.udpAddressToSession.delete(addressKey);
      this.logger.debug(`Cleared UDP mapping for session ${session_id}: ${addressKey}`);
    }
  }

  /**
   * 获取所有UDP映射
   */
  getAllUDPMappings(): Map<string, number> {
    return new Map(this.udpAddressToSession);
  }
}
