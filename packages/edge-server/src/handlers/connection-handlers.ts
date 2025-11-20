import type { TLSSocket } from 'tls';
import type { RemoteInfo } from 'dgram';
import { logger } from '@munode/common';
import type { ClientInfo } from '../types.js';
import type { HandlerFactory } from '../handler-factory.js';

/**
 * 连接处理器 - 处理TLS连接和UDP消息
 */
export class ConnectionHandlers {
  private udpAddressToSession: Map<string, number> = new Map(); // "ip:port" -> session_id

  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get voiceRouter() { return this.factory.voiceRouter; }
  private get banManager() { return this.factory.banManager; }
  private get hubClient() { return this.factory.hubClient; }

  /**
   * 处理 TLS 连接
   */
  async handleTLSConnection(socket: TLSSocket): Promise<void> {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.debug(`New TLS connection from ${clientAddress}`);

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
  handleUDPMessage(msg: Buffer, rinfo: RemoteInfo): void {
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
   * 清理客户端的UDP映射
   */
  clearUDPMapping(session_id: number): void {
    const client = this.clientManager.getClient(session_id);
    if (client && client.udp_ip && client.udp_port) {
      const addressKey = `${client.udp_ip}:${client.udp_port}`;
      this.udpAddressToSession.delete(addressKey);
      logger.debug(`Cleared UDP mapping for session ${session_id}: ${addressKey}`);
    }
  }

  /**
   * 获取所有UDP映射
   */
  getAllUDPMappings(): Map<string, number> {
    return new Map(this.udpAddressToSession);
  }
}
