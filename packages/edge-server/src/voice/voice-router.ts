import { EventEmitter } from 'events';
// import { logger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, VoicePacket, VoiceBroadcast, ClientInfo } from '../types.js';
import { OCB2AES128 } from '@munode/common';
import type { Socket as UDPSocket } from 'dgram';
import { mumbleproto } from '@munode/protocol';
import { LRUCache } from 'lru-cache';

/**
 * 路由缓存条目
 */
interface RouteCacheEntry {
  targetSessions: Set<number>; // 目标会话ID集合
  timestamp: number; // 缓存创建时间
}

/**
 * 语音路由器 - 处理语音包的路由和转发
 * 性能优化：使用索引和缓存实现 O(1) 查找
 */
export class VoiceRouter extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;
  private clientCryptos: Map<number, OCB2AES128> = new Map(); // session_id -> OCB2AES128
  private voiceTargets: Map<number, Map<number, any>> = new Map(); // session_id -> (target_id -> config)
  private udpServer?: UDPSocket; // UDP 服务器引用，用于发送语音包
  private clientManager?: any; // ClientManager 引用，用于获取客户端信息
  private channelManager?: any; // ChannelManager 引用，用于获取频道链接信息
  
  // 性能优化：路由缓存（事件驱动，主动重建）
  private routingCache: Map<string, RouteCacheEntry> = new Map(); // cacheKey -> RouteCacheEntry
  
  // 性能优化：使用 LRU 缓存替代 Map，自动淘汰旧条目
  private serializedPacketCache = new LRUCache<string, Buffer>({
    max: 500, // 最多缓存 500 个序列化包
    ttl: 1000, // 1秒 TTL，语音包时效性很强
    updateAgeOnGet: false, // 获取时不更新 TTL
  });

  constructor(config: EdgeConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.logger.info('VoiceRouter initialized with event-driven cache');
  }

  /**
   * 设置 UDP 服务器引用（用于发送语音包）
   */
  setUDPServer(udpServer: UDPSocket): void {
    this.udpServer = udpServer;
  }

  /**
   * 设置 ClientManager 引用（用于获取客户端信息）
   */
  setClientManager(clientManager: any): void {
    this.clientManager = clientManager;
  }

  /**
   * 设置 ChannelManager 引用（用于获取频道链接信息）
   */
  setChannelManager(channelManager: any): void {
    this.channelManager = channelManager;
  }

  /**
   * 获取客户端的加密器（用于UDP地址匹配）
   */
  getClientCrypto(session_id: number): OCB2AES128 | undefined {
    return this.clientCryptos.get(session_id);
  }

  /**
   * 设置客户端的加密密钥
   */
  setClientCrypto(session_id: number, key: Buffer, encryptIV: Buffer, decryptIV: Buffer): void {
    const crypto = new OCB2AES128();
    crypto.setKey(key, encryptIV, decryptIV);
    this.clientCryptos.set(session_id, crypto);
    
    // 同时更新 ClientInfo 中的 crypt 引用
    if (this.clientManager) {
      const client = this.clientManager.getClient(session_id);
      if (client) {
        client.crypt = crypto;
      }
    }
    
    this.logger.info(
      `Set crypto for client ${session_id}: ` +
      `key=${key.toString('hex')}, ` +
      `encryptIV=${encryptIV.toString('hex')}, ` +
      `decryptIV=${decryptIV.toString('hex')}`
    );
  }

  /**
   * 移除客户端的加密状态
   */
  removeClientCrypto(session_id: number): void {
    this.clientCryptos.delete(session_id);
    this.logger.debug(`Removed crypto for client ${session_id}`);
  }

  /**
   * 处理 UDP 语音包
   * @param session_id 客户端会话 ID
   * @param data 加密的 UDP 数据
   * @param rinfo UDP 源地址信息
   * @param alreadyDecrypted 是否已经解密过（用于地址匹配）
   */
  handleUDPPacket(session_id: number, data: Buffer, rinfo: any, alreadyDecrypted: boolean = false): void {
    this.logger.debug(`[UDP] handleUDPPacket: session=${session_id}, size=${data.length}, alreadyDecrypted=${alreadyDecrypted}`);
    this.logger.debug(`[UDP] handleUDPPacket: session=${session_id}, size=${data.length}, alreadyDecrypted=${alreadyDecrypted}`);
    try {
      let decrypted;

      // 如果在地址匹配阶段已经解密过，crypto 的 decryptIV 已经被修改
      // 不需要再次解密，直接使用数据
      if (alreadyDecrypted) {
        decrypted = data;
      } else {
        // 正常路径：需要解密
        // 获取客户端的加密器
        const crypto = this.clientCryptos.get(session_id);
        if (crypto) {
          // 解密UDP包
          const cryptoDecrypted = crypto.decrypt(data);
          if (!cryptoDecrypted.valid) {
            this.logger.warn(
              `Failed to decrypt UDP packet from client ${session_id}: ` +
              `packet_size=${data.length}, ` +
              `packet_ivbyte=0x${data[0].toString(16)}, ` +
              `crypto_ready=${crypto.ready()}`
            );
            return;
          }
          decrypted = cryptoDecrypted.data;
        } else {
          this.logger.warn(`No crypto for client ${session_id}, cannot process UDP packet`);
          return;
        }
      }

      // 参考 Go 实现: 成功接收任何 UDP 包（包括 Ping）后，标记 client.udp = true
      // 这告诉客户端可以使用 UDP 发送语音数据
      // 注意：现在只在接收 UDP Ping 时才更新 UDP 地址信息
      // if (this.clientManager) {
      //   this.clientManager.updateClient(session_id, { udp: true });
      // }

      // 检查是否是UDP Ping包 (type = 1)
      const header = decrypted.readUInt8(0);
      const type = (header >> 5) & 0x07;
      this.logger.debug(`[UDP] Packet type: ${type}, header: 0x${header.toString(16)}`);
      
      if (type === 1) {
        // UDP Ping packet (type=1) - 回显明文数据（会在 handleUDPPing 中重新加密）
        // 使用 rinfo 中的地址信息回复,不依赖存储的 client.udp_address
        this.handleUDPPing(session_id, decrypted, rinfo);
        return;
      }

      // 处理语音包 (type=0,2,3,4)

      // 解析语音包
      const packet = this.parseVoicePacket(decrypted);
      if (!packet) {
        return;
      }

      packet.sender_session = session_id;
      this.logger.debug(
        `Voice packet: sender=${session_id}, target=${packet.target}, codec=${packet.codec}`
      );

      // 处理语音包路由
      this.routeVoicePacket(packet);
    } catch (error) {
      this.logger.error('Error handling UDP packet:', error);
    }
  }

  /**
   * 处理 UDP Ping 包 - 回显给客户端
   * 重要: 
   * 1. 接收明文数据，重新加密后发送（类似 Go 的 client.SendUDP）
   * 2. 使用 rinfo 中的地址回复，而不是依赖 client.udp_address
   * 3. 只在接收 UDP Ping 时才更新客户端的 UDP 地址信息
   * 这样可以在第一次 UDP Ping 时就建立 UDP 连接
   */
  private handleUDPPing(session_id: number, plaintextData: Buffer, rinfo: any): void {
    this.logger.debug(`[UDP] Handling ping from session ${session_id}, data size: ${plaintextData.length}`);
    if (!this.udpServer) {
      this.logger.warn('[UDP] No UDP server available for ping response');
      return;
    }

    // 更新客户端的 UDP 地址信息（只在接收 ping 时更新）
    if (this.clientManager) {
      this.clientManager.updateClient(session_id, {
        udp_ip: rinfo.address,
        udp_port: rinfo.port,
        udp: true
      });
    }

    // 获取客户端的加密器
    const crypto = this.clientCryptos.get(session_id);
    if (!crypto) {
      this.logger.warn(`No crypto for session ${session_id}, cannot send UDP ping response`);
      return;
    }

    try {
      // 重新加密明文数据
      const encrypted = crypto.encrypt(plaintextData);

      // 使用接收包的源地址回复
      const address = rinfo.address;
      const port = rinfo.port;
      
      this.udpServer.send(encrypted, port, address, (err) => {
        if (err) {
          this.logger.error(`Failed to send UDP ping response to session ${session_id}:`, err);
        } else {
          this.logger.debug(`Sent UDP ping response to session ${session_id} at ${address}:${port}`);
        }
      });
    } catch (error) {
      this.logger.error(`Failed to encrypt UDP ping response for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 TCP 语音隧道消息
   */
  handleVoiceTunnel(session_id: number, data: Buffer): void {
    try {
      this.logger.info(`[TCP-VOICE] Received voice tunnel from session ${session_id}, data length: ${data.length}`);
      
      // 注意：根据 Mumble 协议，UDPTunnel 消息的 data 直接就是语音包数据
      // 不像其他消息类型需要 protobuf 反序列化
      // 这是一个性能优化，避免对高频语音数据进行不必要的 protobuf 包装
      
      if (data.length === 0) {
        this.logger.warn(`Empty voice packet from session ${session_id}`);
        return;
      }
      
      // 关键修复：TCP隧道中的语音包也是加密的，需要先解密
      // 参考 C 实现：mumble/ServerHandler.cpp 和 murmur/Server.cpp
      // 参考 Go 实现：client.go handleUDPPacket
      const crypto = this.clientCryptos.get(session_id);
      if (!crypto) {
        this.logger.warn(`[TCP-VOICE] No crypto for client ${session_id}, cannot process TCP voice tunnel`);
        return;
      }

      this.logger.info(`[TCP-VOICE] Decrypting voice packet from session ${session_id}`);
      // 解密语音包
      const decrypted = crypto.decrypt(data);
      if (!decrypted.valid) {
        this.logger.warn(`[TCP-VOICE] Failed to decrypt TCP voice tunnel from session ${session_id}`);
        return;
      }

      const voicePacketData = decrypted.data;
      this.logger.info(`[TCP-VOICE] Voice packet decrypted: ${data.length} -> ${voicePacketData.length} bytes`);
      
      // 解析语音包
      const packet = this.parseVoicePacket(voicePacketData);
      if (!packet) {
        this.logger.warn(`Failed to parse voice packet from session ${session_id}`);
        return;
      }

      packet.sender_session = session_id;
      this.logger.info(
        `[TCP-VOICE] Voice tunnel: sender=${session_id}, target=${packet.target}, codec=${packet.codec}, packet_size=${voicePacketData.length}`
      );

      // 处理语音包路由
      this.routeVoicePacket(packet);
    } catch (error) {
      this.logger.error('[TCP-VOICE] Error handling voice tunnel:', error);
    }
  }

  /**
   * 解析语音包
   * Mumble 语音包格式（客户端发送）: 
   * - byte 0: type (高3位) | target (低5位)
   * - byte 1+: varint(sequence) + voice data
   * 
   * 注意：客户端发送的包中没有session字段！
   * 只有sequence number + 语音数据
   */
  private parseVoicePacket(data: Buffer): VoicePacket | null {
    if (data.length < 2) {
      return null;
    }

    try {
      const header = data.readUInt8(0);
      const type = (header >> 5) & 0x07; // 高3位是类型
      const target = header & 0x1f; // 低5位是目标

      // Mumble UDP packet types:
      // 0 = CELT Alpha voice
      // 1 = Ping
      // 2 = Speex voice
      // 3 = CELT Beta voice
      // 4 = Opus voice
      // 5-7 = Unused
      
      if (type === 1) {
        // Ping packet - 应该由handleUDPPacket中的ping处理逻辑处理
        return null;
      }

      if (type > 4) {
        // type > 4 是无效类型
        this.logger.warn(`Unsupported voice packet type: ${type}`);
        return null;
      }

      // 客户端发送的payload：[varint(sequence)][voice_data]
      // 我们保留整个payload，在转发时添加session varint
      const payload = data.slice(1);

      return {
        sender_session: 0, // 将在调用处设置为实际发送者
        target,
        sequence: 0,
        codec: type,
        data: payload,  // 保留完整payload（sequence + voice_data）
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error('Error parsing voice packet:', error);
      return null;
    }
  }

  /**
   * 路由远程语音包（来自其他Edge服务器）
   * 
   * @param packet 语音包（已包含sender_session和target）
   * @param senderChannelId 发送者所在的频道ID
   * @param serializedData 已序列化的语音数据（可选，如果提供则直接使用而不重新序列化）
   */
  routeRemoteVoicePacket(packet: VoicePacket, senderChannelId: number, serializedData?: Buffer): void {
    this.logger.debug(
      `Routing remote voice: session=${packet.sender_session}, ` +
      `target=${packet.target}, channel=${senderChannelId}`
    );
    
    // 根据目标类型路由
    if (packet.target === 0) {
      // PTT: 路由到发送者频道及其链接频道
      this.routeToChannelById(packet, senderChannelId, serializedData);
    } else if (packet.target >= 1 && packet.target <= 30) {
      // Whisper: 使用与本地whisper相同的逻辑
      // 检查是否有VoiceTarget配置
      const voiceTarget = this.getVoiceTarget(packet.sender_session, packet.target);
      if (!voiceTarget) {
        this.logger.warn(
          `[VOICE-REMOTE] No VoiceTarget configuration for remote whisper: ` +
          `session=${packet.sender_session}, target=${packet.target}`
        );
        return;
      }
      
      this.logger.info(
        `[VOICE-REMOTE] Found VoiceTarget for session ${packet.sender_session}, ` +
        `target ${packet.target}, config=${JSON.stringify(voiceTarget)}`
      );
      
      // skipBroadcast=true 避免远程语音包被再次广播
      this.routeToVoiceTarget(packet, true, serializedData);
    } else if (packet.target === 31) {
      // Loopback: 远程用户的loopback不应该到达这里，忽略
      this.logger.debug(`Ignoring remote loopback packet from session ${packet.sender_session}`);
    } else {
      this.logger.warn(`Invalid voice target: ${packet.target}`);
    }

    this.emit('voicePacket', packet);
  }

  /**
   * 路由语音包（本地客户端）
   * 
   * 根据 target 字段路由:
   * - target = 0: Push-to-Talk (普通频道语音)
   * - target = 1-30: VoiceTarget (耳语/whisper)
   * - target = 31 (0x1F): Server loopback (服务器回环，发送回自己)
   */
  private routeVoicePacket(packet: VoicePacket): void {
    // 根据目标类型路由语音包
    if (packet.target === 0) {
      // 普通频道语音 (Push-to-Talk)
      this.routeToChannel(packet);
    } else if (packet.target >= 1 && packet.target <= 30) {
      // 语音目标 (Whisper)
      this.routeToVoiceTarget(packet);
    } else if (packet.target === 31) {
      // 服务器回环 - 发送回发送者自己（用于测试）
      this.routeToSender(packet);
    } else {
      this.logger.warn(`Invalid voice target: ${packet.target}`);
    }

    this.emit('voicePacket', packet);
  }

  /**
   * 路由到频道 (Push-to-Talk, target=0) - 用于远程语音包
   * 
   * 与routeToChannel相同的逻辑，但发送者频道ID由参数提供（因为远程用户不在本地clientManager中）
   * 
   * @param packet 语音包
   * @param senderChannelId 发送者频道ID
   * @param serializedData 已序列化的数据（远程语音包已经是正确格式，无需重新序列化）
   * 
   * 性能优化：使用索引 + 缓存实现 O(1) 查找
   */
  private routeToChannelById(packet: VoicePacket, senderChannelId: number, serializedData?: Buffer): void {
    if (!this.clientManager) {
      this.logger.warn('ClientManager not set, cannot route voice packet');
      return;
    }

    this.logger.debug(`Routing remote voice from session ${packet.sender_session} in channel ${senderChannelId}`);

    // 使用已序列化的数据，或者重新序列化（针对本地语音包）
    const broadcastPacket = serializedData || this.serializeVoicePacket(packet);

    // 生成缓存键（与 routeToChannel 使用相同的缓存）
    const cacheKey = `ptt_${senderChannelId}`;
    
    // 从缓存获取目标频道列表
    let cached = this.routingCache.get(cacheKey);
    if (!cached) {
      // 缓存不存在，立即构建
      const targetChannels = this.calculateTargetChannels(senderChannelId);
      cached = {
        targetSessions: targetChannels,
        timestamp: Date.now(),
      };
      this.routingCache.set(cacheKey, cached);
      this.logger.debug(`[VOICE-CACHE] Remote PTT cache built for channel ${senderChannelId}, channels: ${Array.from(targetChannels).join(', ')}`);
    } else {
      this.logger.debug(`[VOICE-CACHE] Using cached PTT route for channel ${senderChannelId}`);
    }
    
    const targetChannels = cached.targetSessions;

    // 使用索引快速收集目标用户
    const targetSessions = new Set<number>();
    for (const channelId of targetChannels) {
      // 获取频道中的用户（O(1)）
      const channelUsers = this.clientManager.getChannelUserSessions(channelId);
      for (const sessionId of channelUsers) {
        targetSessions.add(sessionId);
      }
      
      // 获取监听该频道的用户（O(1)）
      const listeningUsers = this.clientManager.getListeningUserSessions(channelId);
      for (const sessionId of listeningUsers) {
        targetSessions.add(sessionId);
      }
    }

    // 发送给目标频道中的所有客户端
    let sentCount = 0;
    for (const sessionId of targetSessions) {
      // 跳过发送者自己（远程session可能与本地session冲突，这里也检查一下）
      if (sessionId === packet.sender_session) {
        continue;
      }

      const targetClient = this.clientManager.getClient(sessionId);
      if (!targetClient) {
        continue;
      }

      // 跳过deaf或self_deaf的客户端
      if (targetClient.deaf || targetClient.self_deaf) {
        continue;
      }

      // 跳过未认证的客户端
      if (!targetClient.user_id || targetClient.user_id <= 0) {
        continue;
      }

      this.logger.debug(`[VOICE-DEBUG] Sending remote voice to ${targetClient.username} (session ${targetClient.session}, channel ${targetClient.channel_id})`);
      this.sendVoicePacketToClient(targetClient, broadcastPacket);
      sentCount++;
    }
    
  }

  /**
   * 路由到频道 (Push-to-Talk, target=0)
   * 
   * 语音将发送给:
   * 1. 在发送者所在频道的所有用户
   * 2. 监听发送者所在频道的所有用户
   * 3. 在发送者所在频道的链接频道中的所有用户
   * 4. 监听发送者所在频道的链接频道的所有用户
   * 
   * 注意: 链接是传递的，如果 A 链接 B，B 链接 C，则 A 也链接 C
   * 
   * 性能优化：使用索引 + 缓存实现 O(1) 查找
   */
  private routeToChannel(packet: VoicePacket): void {
    if (!this.clientManager) {
      this.logger.warn('ClientManager not set, cannot route voice packet');
      return;
    }

    // 获取发送者信息
    const sender = this.clientManager.getClient(packet.sender_session);
    if (!sender) {
      this.logger.warn(`Cannot route voice: sender ${packet.sender_session} not found`);
      return;
    }

    this.logger.debug(`Routing voice from ${sender.username} (session ${packet.sender_session}) in channel ${sender.channel_id}`);

    // 检查发送者是否被mute或suppress
    if (sender.mute || sender.self_mute || sender.suppress) {
      this.logger.debug(`Voice packet from ${sender.username} dropped: muted or suppressed`);
      return;
    }

    // 生成缓存键
    const cacheKey = `ptt_${sender.channel_id}`;
    
    // 从缓存获取目标频道列表（缓存由事件系统维护）
    let cached = this.routingCache.get(cacheKey);
    if (!cached) {
      // 缓存不存在，立即构建
      const targetChannels = this.calculateTargetChannels(sender.channel_id);
      cached = {
        targetSessions: targetChannels,
        timestamp: Date.now(),
      };
      this.routingCache.set(cacheKey, cached);
      this.logger.debug(`[VOICE-CACHE] PTT cache built for channel ${sender.channel_id}: ${targetChannels.size} channels`);
    }
    
    const targetChannels = cached.targetSessions;

    // 准备广播的语音包（包含发送者会话ID）
    // 优化：使用 LRU 缓存避免重复序列化（自动淘汰旧条目）
    const packetCacheKey = `${packet.sender_session}_${packet.timestamp}`;
    let broadcastPacket: Buffer;
    const cachedPacket = this.serializedPacketCache.get(packetCacheKey);
    if (cachedPacket) {
      broadcastPacket = cachedPacket;
      this.logger.debug(`[VOICE-CACHE] Using cached serialized packet`);
    } else {
      broadcastPacket = this.serializeVoicePacket(packet);
      this.serializedPacketCache.set(packetCacheKey, broadcastPacket);
    }

    // 使用索引快速收集目标用户
    // O(1) 查找每个频道的用户，而不是 O(n) 遍历所有用户
    const targetSessions = new Set<number>();
    for (const channelId of targetChannels) {
      // 获取频道中的用户（O(1)）
      const channelUsers = this.clientManager.getChannelUserSessions(channelId);
      for (const sessionId of channelUsers) {
        targetSessions.add(sessionId);
      }
      
      // 获取监听该频道的用户（O(1)）
      const listeningUsers = this.clientManager.getListeningUserSessions(channelId);
      for (const sessionId of listeningUsers) {
        targetSessions.add(sessionId);
      }
    }

    // 发送语音包给所有目标用户
    let sentCount = 0;
    for (const sessionId of targetSessions) {
      // 跳过发送者自己
      if (sessionId === packet.sender_session) {
        continue;
      }

      const targetClient = this.clientManager.getClient(sessionId);
      if (!targetClient) {
        continue;
      }

      // 跳过deaf或self_deaf的客户端
      if (targetClient.deaf || targetClient.self_deaf) {
        continue;
      }

      // 跳过未认证的客户端
      if (!targetClient.user_id || targetClient.user_id <= 0) {
        continue;
      }

      this.logger.debug(`[VOICE-DEBUG] Sending voice to ${targetClient.username} (session ${sessionId}, channel ${targetClient.channel_id})`);
      this.sendVoicePacketToClient(targetClient, broadcastPacket);
      sentCount++;
    }
    
    // 触发事件供VoiceManager进行跨Edge广播
    // VoiceManager会将语音包广播到所有其他Edge
    // 每个Edge（包括本地）都会独立计算应该接收的用户
    const broadcast: VoiceBroadcast = {
      sender_id: packet.sender_session,
      sender_edge_id: this.config.server_id,
      sender_username: sender.username,
      target: packet.target,
      packet: broadcastPacket,
      timestamp: packet.timestamp,
      routing_info: {
        channel_id: sender.channel_id,
      },
    };

    this.emit('broadcastVoicePacket', broadcast);
  }

  /**
   * 计算目标频道列表（包括链接频道）
   * 用于 PTT 路由缓存
   */
  private calculateTargetChannels(channelId: number): Set<number> {
    const targetChannels = new Set<number>();
    targetChannels.add(channelId); // 发送者所在频道

    // 获取所有链接的频道（包括传递链接）
    if (this.channelManager) {
      const linkedChannels = this.channelManager.getAllLinkedChannels(channelId);
      for (const linkedId of linkedChannels) {
        targetChannels.add(linkedId);
      }
      this.logger.debug(`Calculated target channels for ${channelId}: [${Array.from(targetChannels).join(', ')}], linked=${linkedChannels.size}`);
    } else {
    }

    return targetChannels;
  }

  /**
   * 路由回发送者自己（Server loopback, target=31）
   * 主要用于测试语音回环
   */
  private routeToSender(packet: VoicePacket): void {
    if (!this.clientManager) {
      return;
    }

    const sender = this.clientManager.getClient(packet.sender_session);
    if (!sender) {
      return;
    }

    // 检查发送者是否被mute或suppress（即使是loopback也要检查）
    if (sender.mute || sender.self_mute || sender.suppress) {
      return;
    }

    const broadcastPacket = this.serializeVoicePacket(packet);
    this.sendVoicePacketToClient(sender, broadcastPacket);
    
    this.logger.debug(`Voice loopback sent to sender ${sender.username}`);
  }

  /**
   * 路由到语音目标 (Whisper, target=1-30)
   * 
   * VoiceTarget 可以指定多个目标，每个目标可以包含:
   * - sessions: 直接指定的用户会话ID列表
   * - channel_id: 目标频道
   * - links: 是否包含链接的频道
   * - children: 是否包含子频道
   * - group: ACL组名（限制只有该组成员能听到）
   * 
   * 语音路由规则:
   * 1. links=false, children=false: 只发送给在/监听目标频道的用户
   * 2. links=true, children=false: 发送给在/监听目标频道及其链接频道的用户
   * 3. links=false, children=true: 发送给在/监听目标频道及其子频道的用户
   * 4. links=true, children=true: 发送给在/监听目标频道、链接频道、子频道及子频道的链接频道的用户
   * 
   * 如果指定了 group，则以上所有情况都会额外过滤，只有属于该组的用户才能收到语音。
   * 组成员来源有两个：
   * 1. 频道ACL组（channel.groups，基于 user_id 匹配）
   * 2. 用户认证组（client.groups，来自认证服务器）
   * 用户只要在任一来源的组中，就可以收到语音
   * 
   * 性能优化：使用索引 + 缓存实现 O(1) 查找
   * 
   * @param packet 语音包
   * @param skipBroadcast 是否跳过跨Edge广播（用于远程语音包，避免循环）
   */
  private routeToVoiceTarget(packet: VoicePacket, skipBroadcast: boolean = false, serializedData?: Buffer): void {
    this.logger.debug(`routeToVoiceTarget: sender=${packet.sender_session}, target=${packet.target}`);
    
    if (!this.clientManager) {
      this.logger.warn('ClientManager not set, cannot route voice packet');
      return;
    }

    // 获取发送者信息（对于远程语音包，发送者可能不在本地）
    const sender = this.clientManager.getClient(packet.sender_session);
    
    // 对于本地发送者，检查mute/suppress状态
    if (sender) {
      if (sender.mute || sender.self_mute || sender.suppress) {
        this.logger.debug(`Voice packet from ${sender.username} dropped: muted or suppressed`);
        return;
      }
    }

    // 获取语音目标配置
    const voiceTarget = this.getVoiceTarget(packet.sender_session, packet.target);
    if (!voiceTarget) {
      this.logger.debug(`No voice target ${packet.target} configured for session ${packet.sender_session}`);
      return;
    }

    this.logger.debug(`Routing whisper from ${sender ? sender.username : 'remote-' + packet.sender_session} using voice target ${packet.target} with ${voiceTarget.length} target(s)`);

    // 生成缓存键（VoiceTarget缓存需要考虑发送者和目标ID）
    const cacheKey = `whisper_${packet.sender_session}_${packet.target}`;
    
    // 从缓存获取目标会话列表
    let cached = this.routingCache.get(cacheKey);
    if (!cached) {
      // 缓存不存在，立即构建
      const targetSessions = this.calculateWhisperTargets(voiceTarget);
      cached = {
        targetSessions,
        timestamp: Date.now(),
      };
      this.routingCache.set(cacheKey, cached);
      this.logger.debug(`[VOICE-CACHE] Whisper cache built for session ${packet.sender_session} target ${packet.target}: ${targetSessions.size} sessions`);
    }
    
    const targetSessions = cached.targetSessions;

    // 准备广播的语音包：如果提供了serializedData则直接使用，否则重新序列化
    const broadcastPacket = serializedData || this.serializeVoicePacket(packet);

    // 发送语音包给所有目标用户（只对本地连接的session）
    let sentCount = 0;
    for (const sessionId of targetSessions) {
      // 跳过发送者自己
      if (sessionId === packet.sender_session) {
        continue;
      }

      const targetClient = this.clientManager.getClient(sessionId);
      if (!targetClient) {
        // session不在本地，跳过（其他Edge会处理）
        continue;
      }

      // 跳过deaf或self_deaf的客户端
      if (targetClient.deaf || targetClient.self_deaf) {
        continue;
      }

      // 跳过未认证的客户端
      if (!targetClient.user_id || targetClient.user_id <= 0) {
        continue;
      }
      this.sendVoicePacketToClient(targetClient, broadcastPacket);
      sentCount++;
    }

    this.logger.info(`[VOICE] Whisper from ${sender ? sender.username : 'remote-' + packet.sender_session} sent to ${sentCount} clients using voice target ${packet.target} (indexed lookup)`);

    // 触发事件供VoiceManager进行跨Edge广播
    // 但如果是远程语音包处理（skipBroadcast=true），则跳过广播避免循环
    if (!skipBroadcast) {
      const broadcast: VoiceBroadcast = {
        sender_id: packet.sender_session,
        sender_edge_id: this.config.server_id,
        sender_username: sender ? sender.username : 'remote-' + packet.sender_session,
        target: packet.target,
        packet: broadcastPacket,
        timestamp: packet.timestamp,
        routing_info: {
          voice_target_id: packet.target,
        },
      };

      this.emit('broadcastVoicePacket', broadcast);
    }
  }

  /**
   * 计算 VoiceTarget 的目标会话列表
   * 使用索引实现高效查找
   */
  private calculateWhisperTargets(
    voiceTarget: ReturnType<typeof mumbleproto.VoiceTarget.Target.deserialize>[]
  ): Set<number> {
    const targetSessions = new Set<number>();

    // 处理每个目标
    for (const target of voiceTarget) {
      // 情况1: 基于session的目标 - 使用protobuf标准属性
      const sessions: number[] = target.session || [];
      
      if (sessions.length > 0) {
        for (const sessionId of sessions) {
          targetSessions.add(sessionId);
        }
      }

      // 情况2: 基于频道的目标
      // protobuf对象：使用 has_channel_id 判断是否显式设置了 channel_id
      const hasChannelId = target.has_channel_id;

      if (hasChannelId) {
        const targetChannels = new Set<number>();
        targetChannels.add(target.channel_id);

        // 是否包含链接的频道
        const includeLinks = target.links === true;
        // 是否包含子频道
        const includeChildren = target.children === true;
        // 是否限制为特定ACL组
        const groupName = target.group;

        this.logger.debug(`Whisper target: channel=${target.channel_id}, links=${includeLinks}, children=${includeChildren}, group=${groupName || 'none'}`);

        // 添加链接的频道
        if (includeLinks && this.channelManager) {
          const linkedChannels = this.channelManager.getAllLinkedChannels(target.channel_id);
          for (const linkedId of linkedChannels) {
            targetChannels.add(linkedId);
          }
          this.logger.debug(`Added ${linkedChannels.size} linked channels`);
        }

        // 添加子频道
        if (includeChildren && this.channelManager) {
          const descendants = this.channelManager.getAllDescendants(target.channel_id);
          for (const descendantId of descendants) {
            targetChannels.add(descendantId);
            
            // 如果同时包含 links，则还要添加每个子频道的链接频道
            if (includeLinks) {
              const descendantLinks = this.channelManager.getAllLinkedChannels(descendantId);
              for (const linkedId of descendantLinks) {
                targetChannels.add(linkedId);
              }
            }
          }
          this.logger.debug(`Added ${descendants.size} descendant channels`);
        }

        // 如果指定了组，预先收集ACL频道组成员
        let channelGroupMembers: Set<number> | undefined;
        if (groupName && this.channelManager) {
          channelGroupMembers = this.getGroupMembersInChannels(groupName, targetChannels);
          this.logger.debug(`Channel ACL group '${groupName}' has ${channelGroupMembers.size} members in target channels`);
        }

        // 使用索引收集这些频道中的所有用户（O(1) 查找）
        for (const channelId of targetChannels) {
          // 获取频道中的用户（O(1)）
          const channelUsers = this.clientManager.getChannelUserSessions(channelId);
          for (const sessionId of channelUsers) {
            const client = this.clientManager.getClient(sessionId);
            if (client && this.shouldReceiveWhisper(client, groupName, channelGroupMembers)) {
              targetSessions.add(sessionId);
            }
          }
          
          // 获取监听该频道的用户（O(1)）
          const listeningUsers = this.clientManager.getListeningUserSessions(channelId);
          for (const sessionId of listeningUsers) {
            const client = this.clientManager.getClient(sessionId);
            if (client && this.shouldReceiveWhisper(client, groupName, channelGroupMembers)) {
              targetSessions.add(sessionId);
            }
          }
        }

        this.logger.debug(`Collected ${targetSessions.size} sessions from ${targetChannels.size} target channels`);
      }
    }

    return targetSessions;
  }

  /**
   * 检查客户端是否应该接收 whisper
   * 如果指定了组，检查用户是否在组中
   */
  private shouldReceiveWhisper(
    client: ClientInfo,
    groupName: string | undefined,
    channelGroupMembers: Set<number> | undefined
  ): boolean {
    if (!groupName) {
      // 没有组限制，所有用户都可以接收
      return true;
    }

    // 检查两个来源：
    // 1. 频道ACL组（基于 user_id）
    // 2. 用户认证组（来自认证服务器，存储在 client.groups 中）
    const inChannelGroup = channelGroupMembers && channelGroupMembers.has(client.user_id);
    const inUserGroup = client.groups && client.groups.includes(groupName);
    
    if (inChannelGroup || inUserGroup) {
      if (inChannelGroup && inUserGroup) {
        this.logger.debug(`Client ${client.username} in group '${groupName}' (both channel ACL and user auth)`);
      } else if (inChannelGroup) {
        this.logger.debug(`Client ${client.username} in group '${groupName}' (channel ACL)`);
      } else {
        this.logger.debug(`Client ${client.username} in group '${groupName}' (user auth)`);
      }
      return true;
    } else {
      this.logger.debug(`Client ${client.username} not in group '${groupName}' (checked both channel ACL and user auth), skipping`);
      return false;
    }
  }

  /**
   * 序列化语音包用于转发
   * 参照Go实现: client.go handleUDPPacket
   * 
   * 客户端发送格式: [header][varint(sequence)][voice_data]
   * 服务器转发格式: [header][varint(session)][varint(sequence)][voice_data]
   * 
   * Go代码逻辑：
   * 1. incoming := packetdata.New(buf[1:])  // 原始payload（sequence+voice）
   * 2. _ = incoming.GetUint32()  // 读取sequence（仅用于验证，不修改buf）
   * 3. outgoing.PutUint32(client.Session())  // 写入session ID
   * 4. outgoing.PutBytes(buf[1:])  // 写入整个原始payload（未被修改）
   * 5. outbuf[0] = buf[0] & 0xe0  // 清除target位
   * 
   * 因此转发格式为: [header][varint(session)][原始buf[1:]]
   * 最终包结构: [header][session][sequence][voice_data]
   */
  private serializeVoicePacket(packet: VoicePacket): Buffer {
    // 创建新的header，保留codec和target
    // target信息对于跨Edge转发至关重要（1-30=whisper, 0=PTT, 31=loopback）
    // Go中对于本地转发会清零target，但跨Edge转发需要保留
    const header = (packet.codec << 5) | (packet.target & 0x1f);
    
    // 编码新的会话ID为varint格式（使用发送者的session ID）
    // Go: outgoing.PutUint32(client.Session())
    const sessionVarint = this.encodeVarint(packet.sender_session);
    
    // packet.data 是原始接收包中byte 1之后的所有数据
    // 包含了：[varint(sequence)] + [voice_data]
    // Go: outgoing.PutBytes(buf[1:])
    // 所以转发包是: [header] + [session varint] + [sequence varint] + [voice_data]
    const totalLength = 1 + sessionVarint.length + packet.data.length;
    const buffer = Buffer.allocUnsafe(totalLength);
    
    // 写入header
    buffer.writeUInt8(header, 0);
    
    // 写入新的session varint
    sessionVarint.copy(buffer, 1);
    
    // 写入整个原始payload（sequence + voice_data）
    packet.data.copy(buffer, 1 + sessionVarint.length);
    
    return buffer;
  }

    /**
   * 编码整数为Mumble varint格式（不是protobuf varint）
   * 参照Go实现: packetdata/packetdata.go addVarint
   * 
   * Mumble的varint编码规则:
   * - 0x00-0x7F: 单字节（最高位为0）
   * - 0x80-0x3FFF: 双字节（最高2位为10）
   * - 0xC0-0x1FFFFFFF: 3字节（最高3位为110）
   * - 0xF0: 4字节完整32位整数前缀
   * - 0xF4: 8字节完整64位整数前缀
   */
  private encodeVarint(value: number): Buffer {
    const i = value >>> 0; // 确保是无符号32位整数
    
    if (i < 0x80) {
      // 单字节: 0x00-0x7F
      return Buffer.from([i]);
    } else if (i < 0x4000) {
      // 双字节: 0x80-0x3FFF
      // 最高2位为10，后14位存储值
      return Buffer.from([
        (i >> 8) | 0x80,
        i & 0xff
      ]);
    } else if (i < 0x200000) {
      // 3字节: 0xC0-0x1FFFFFFF
      // 最高3位为110，后21位存储值
      return Buffer.from([
        (i >> 16) | 0xc0,
        (i >> 8) & 0xff,
        i & 0xff
      ]);
    } else if (i < 0x100000000) {
      // 完整32位整数: 前缀0xF0 + 4字节数据
      return Buffer.from([
        0xf0,
        (i >> 24) & 0xff,
        (i >> 16) & 0xff,
        (i >> 8) & 0xff,
        i & 0xff
      ]);
    } else {
      // 理论上不应该到这里（32位session ID）
      this.logger.warn(`Session ID ${value} too large for varint encoding`);
      return Buffer.from([
        0xf0,
        (i >> 24) & 0xff,
        (i >> 16) & 0xff,
        (i >> 8) & 0xff,
        i & 0xff
      ]);
    }
  }

  /**
   * 解码Mumble varint格式
   * 参照Go实现: packetdata/packetdata.go getVarint
   * 
   * @param data Buffer包含varint数据
   * @param offset 开始读取的偏移量
   * @returns {value: number, offset: number} 解码的值和新的偏移量，失败返回null
   * 
   * 注意：当前未使用，但保留以备将来需要（如解析sequence number）
   */
  // @ts-ignore - 保留以备将来使用
  private decodeVarint(data: Buffer, offset: number): { value: number; offset: number } | null {
    if (offset >= data.length) {
      return null;
    }

    const v = data.readUInt8(offset);
    offset++;

    if ((v & 0x80) === 0x00) {
      // 单字节: 0x00-0x7F
      return { value: v & 0x7f, offset };
    } else if ((v & 0xc0) === 0x80) {
      // 双字节: 0x80-0xBF
      if (offset >= data.length) return null;
      const value = ((v & 0x3f) << 8) | data.readUInt8(offset);
      return { value, offset: offset + 1 };
    } else if ((v & 0xf0) === 0xf0) {
      // 特殊格式
      switch (v & 0xfc) {
        case 0xf0: {
          // 完整32位整数
          if (offset + 3 >= data.length) return null;
          const value =
            (data.readUInt8(offset) << 24) |
            (data.readUInt8(offset + 1) << 16) |
            (data.readUInt8(offset + 2) << 8) |
            data.readUInt8(offset + 3);
          return { value: value >>> 0, offset: offset + 4 };
        }
        case 0xf4: {
          // 64位整数（我们只支持低32位）
          if (offset + 7 >= data.length) return null;
          // 跳过高32位，只读取低32位
          const value =
            (data.readUInt8(offset + 4) << 24) |
            (data.readUInt8(offset + 5) << 16) |
            (data.readUInt8(offset + 6) << 8) |
            data.readUInt8(offset + 7);
          return { value: value >>> 0, offset: offset + 8 };
        }
        case 0xf8:
          // 负数（反转），递归解码
          {
            const result = this.decodeVarint(data, offset);
            if (!result) return null;
            return { value: ~result.value, offset: result.offset };
          }
        case 0xfc:
          // 小负数: -1 to -4
          return { value: ~(v & 0x03), offset };
        default:
          return null;
      }
    } else if ((v & 0xe0) === 0xc0) {
      // 3字节: 0xC0-0xDF
      if (offset + 1 >= data.length) return null;
      const value = ((v & 0x1f) << 16) | (data.readUInt8(offset) << 8) | data.readUInt8(offset + 1);
      return { value, offset: offset + 2 };
    } else if ((v & 0xf0) === 0xe0) {
      // 4字节: 0xE0-0xEF
      if (offset + 2 >= data.length) return null;
      const value =
        ((v & 0x0f) << 24) |
        (data.readUInt8(offset) << 16) |
        (data.readUInt8(offset + 1) << 8) |
        data.readUInt8(offset + 2);
      return { value: value >>> 0, offset: offset + 3 };
    }

    return null;
  }

  /**
   * 处理来自 Hub 的语音广播
   */
  handleHubBroadcast(broadcast: VoiceBroadcast): void {
    // 如果是来自其他 Edge 服务器的广播，转发给本地客户端
    if (broadcast.sender_edge_id !== this.config.server_id) {
      this.emit('forwardBroadcast', broadcast);
    }
  }

  /**
   * 获取指定频道ACL组在多个频道中的所有成员
   * 注意：这只检查频道ACL组（channel.groups），不包括用户认证组（client.groups）
   * @param groupName 组名
   * @param channelIds 频道ID集合
   * @returns 用户ID集合
   */
  private getGroupMembersInChannels(groupName: string, channelIds: Set<number>): Set<number> {
    const members = new Set<number>();
    
    if (!this.channelManager) {
      return members;
    }

    // 遍历所有目标频道，收集组成员
    for (const channelId of channelIds) {
      const channel = this.channelManager.getChannel(channelId);
      if (!channel || !channel.groups) {
        continue;
      }

      const group = channel.groups.get(groupName);
      if (!group) {
        continue;
      }

      // 添加明确添加到组的用户
      if (group.add && Array.isArray(group.add)) {
        for (const userId of group.add) {
          members.add(userId);
        }
      }

      // 添加继承的成员
      if (group.inherited_members && Array.isArray(group.inherited_members)) {
        for (const userId of group.inherited_members) {
          members.add(userId);
        }
      }

      // 注意：group.remove 中的用户应该被排除，即使他们在 inherited_members 中
      if (group.remove && Array.isArray(group.remove)) {
        for (const userId of group.remove) {
          members.delete(userId);
        }
      }
    }

    return members;
  }

  /**
   * 类型安全地检查 VoiceTarget 是否设置了 channel_id
   * 处理 protobuf 对象（有 has_channel_id 属性）和普通对象的情况
   * @param target VoiceTarget 目标对象
   * @returns 是否显式设置了 channel_id
   */
  /**
   * 获取语音统计信息
   */
  getVoiceStats(): any {
    return {
      packetsProcessed: 0,
      bytesProcessed: 0,
      activeTargets: 0,
    };
  }

  /**
   * 获取客户端的加密IV（用于重同步）
   */
  getClientEncryptIV(session_id: number): Buffer | undefined {
    const crypto = this.clientCryptos.get(session_id);
    if (crypto) {
      return crypto.getEncryptIV();
    }
    return undefined;
  }

  /**
   * 更新客户端的解密IV（用于重同步）
   */
  updateClientDecryptIV(session_id: number, nonce: Buffer): void {
    const crypto = this.clientCryptos.get(session_id);
    if (crypto) {
      crypto.setDecryptIV(nonce);
      crypto.incrementResync(); // 增加重同步计数
      this.logger.debug(`Updated decrypt IV for client ${session_id}, resync count: ${crypto.localStats.resync}`);
    } else {
      this.logger.warn(`Cannot update decrypt IV: client ${session_id} not found`);
    }
  }

  /**
   * 设置语音目标
   */
  setVoiceTarget(session_id: number,  target_id: number, targets: any[]): void {
    let clientTargets = this.voiceTargets.get(session_id);
    if (!clientTargets) {
      clientTargets = new Map();
      this.voiceTargets.set(session_id, clientTargets);
    }

    clientTargets.set(target_id, targets);
    this.logger.debug(
      `Set voice target ${target_id} for client ${session_id}: ${targets.length} entries`
    );
    
    // 主动重建缓存
    this.rebuildWhisperCache(session_id, target_id);
  }

  /**
   * 移除语音目标
   */
  removeVoiceTarget(session_id: number,  target_id: number): void {
    const clientTargets = this.voiceTargets.get(session_id);
    if (clientTargets) {
      clientTargets.delete(target_id);
      this.logger.debug(`Removed voice target ${target_id} for client ${session_id}`);

      // 如果客户端没有任何语音目标了，清理整个映射
      if (clientTargets.size === 0) {
        this.voiceTargets.delete(session_id);
      }
    }
    
    // 主动重建缓存（删除情况下会自动清除缓存）
    this.rebuildWhisperCache(session_id, target_id);
  }

  /**
   * 获取语音目标配置
   */
  getVoiceTarget(session_id: number,  target_id: number): any[] | undefined {
    const clientTargets = this.voiceTargets.get(session_id);
    if (clientTargets) {
      return clientTargets.get(target_id);
    }
    return undefined;
  }

  /**
   * 发送语音包到指定客户端（公共方法，供edge-server调用）
   * @param client 目标客户端信息
   * @param voiceData 语音数据（已序列化，包含发送者session ID）
   */
  sendVoicePacketToClient(client: ClientInfo, voiceData: Buffer): void {
    // 检查客户端是否有UDP连接
    const hasUDP = client.udp && client.udp_ip && client.udp_port;
    
    if (hasUDP && this.udpServer) {
      // 尝试使用UDP发送
      this.sendVoicePacketViaUDP(client, voiceData);
    } else {
      // 使用TCP隧道发送
      this.sendVoicePacketViaTCP(client, voiceData);
    }
  }

  /**
   * 通过UDP发送语音包到客户端
   */
  private sendVoicePacketViaUDP(client: ClientInfo, voiceData: Buffer): void {
    if (!this.udpServer) {
      this.logger.warn('UDP server not set, cannot send voice packet via UDP');
      return;
    }

    // 获取客户端的加密器
    const crypto = this.clientCryptos.get(client.session);
    if (!crypto) {
      this.logger.warn(`No crypto for client ${client.session}, voice packet not sent`);
      return;
    }

    // 加密语音数据
    let encrypted: Buffer;
    try {
      encrypted = crypto.encrypt(voiceData);
    } catch (error) {
      this.logger.error(`Failed to encrypt voice packet for client ${client.session}:`, error);
      return;
    }

    // 发送UDP包
    try {
      this.udpServer.send(encrypted, client.udp_port, client.udp_ip, (err) => {
        if (err) {
          this.logger.error(`Failed to send voice packet via UDP to ${client.username} (${client.session}):`, err);
          // UDP发送失败，标记客户端UDP为不可用
          if (this.clientManager) {
            this.clientManager.updateClient(client.session, { udp: false });
          }
        }
      });
    } catch (error) {
      this.logger.error(`Error sending voice packet via UDP to ${client.username} (${client.session}):`, error);
    }
  }

  /**
   * 通过TCP隧道发送语音包到客户端
   */
  private sendVoicePacketViaTCP(client: ClientInfo, voiceData: Buffer): void {
    // 语音数据不需要加密，因为TCP连接本身是TLS加密的
    // 但我们仍需要对payload进行OCB2加密以保持协议一致性
    const crypto = this.clientCryptos.get(client.session);
    if (!crypto) {
      this.logger.warn(`No crypto for client ${client.session}, voice packet not sent via TCP`);
      return;
    }

    this.logger.info(`[TCP-VOICE] Sending voice via TCP to ${client.username} (${client.session}), voice data size: ${voiceData.length}`);

    // 加密语音数据
    let encrypted: Buffer;
    try {
      encrypted = crypto.encrypt(voiceData);
      this.logger.info(`[TCP-VOICE] Encrypted voice data size: ${encrypted.length}`);
    } catch (error) {
      this.logger.error(`Failed to encrypt voice packet for client ${client.session}:`, error);
      return;
    }

    // 将加密的语音数据包装到UDPTunnel protobuf消息中
    // 这样客户端接收时可以正确解析
    this.logger.info(`[TCP-VOICE] Emitting sendTCPVoicePacket event for ${client.username} (${client.session}), encrypted size: ${encrypted.length}`);
    this.emit('sendTCPVoicePacket', client.session, encrypted);
    this.logger.info(`[TCP-VOICE] Event emitted successfully`);
  }
  
  // ===== 缓存管理方法（事件驱动，主动重建） =====
  
  /**
   * 重建 Whisper（VoiceTarget）缓存
   * 当 VoiceTarget 配置变更时调用
   */
  private rebuildWhisperCache(session_id: number, target_id: number): void {
    const cacheKey = `whisper_${session_id}_${target_id}`;
    const edgeId = this.config.server_id || 'unknown';
    
    // 获取 VoiceTarget 配置
    const voiceTarget = this.getVoiceTarget(session_id, target_id);
    if (!voiceTarget) {
      // 配置不存在，删除缓存
      this.routingCache.delete(cacheKey);
      this.logger.debug(`[Edge${edgeId}][VOICE-CACHE] Removed whisper cache: ${cacheKey} (no config)`, { service: 'munode' });
      return;
    }
    
    // 重新计算目标会话
    const targetSessions = this.calculateWhisperTargets(voiceTarget);
    this.routingCache.set(cacheKey, {
      targetSessions,
      timestamp: Date.now(),
    });
    this.logger.debug(`[Edge${edgeId}][VOICE-CACHE] Rebuilt whisper cache: ${cacheKey}, ${targetSessions.size} sessions`, { service: 'munode' });
  }
  
  /**
   * 重建频道相关的 PTT 缓存
   * 当频道链接关系变化时调用
   */
  rebuildChannelCache(channelId: number): void {
    const cacheKey = `ptt_${channelId}`;
    
    // 重新计算目标频道
    const targetChannels = this.calculateTargetChannels(channelId);
    this.routingCache.set(cacheKey, {
      targetSessions: targetChannels,
      timestamp: Date.now(),
    });
    this.logger.debug(`[VOICE-CACHE] Rebuilt PTT cache for channel ${channelId}: ${targetChannels.size} channels`);
  }
  
  /**
   * 重建所有 PTT 缓存
   * 当频道结构或链接发生大规模变化时调用
   */
  rebuildAllPTTCache(): void {
    if (!this.channelManager) {
      return;
    }
    
    // 清除所有 PTT 缓存
    const keys = Array.from(this.routingCache.keys());
    for (const key of keys) {
      if (key.startsWith('ptt_')) {
        this.routingCache.delete(key);
      }
    }
    
    // 为所有频道重建缓存
    const channels = this.channelManager.getAllChannels();
    for (const channel of channels) {
      this.rebuildChannelCache(channel.id);
    }
    
    this.logger.info(`[VOICE-CACHE] Rebuilt PTT cache for ${channels.length} channels`);
  }
  
  /**
   * 清除所有缓存
   * 用于系统重置或配置重载
   */
  clearAllCache(): void {
    const count = this.routingCache.size;
    this.routingCache.clear();
    this.serializedPacketCache.clear();
    
    if (count > 0) {
      this.logger.info(`[VOICE-CACHE] Cleared all caches: ${count} routing entries`);
    }
  }
  
  /**
   * 清除客户端的所有缓存
   * 当客户端断开连接时调用
   */
  clearClientCache(session_id: number): void {
    let count = 0;
    const keys = Array.from(this.routingCache.keys());
    for (const key of keys) {
      if (key.startsWith(`whisper_${session_id}_`)) {
        this.routingCache.delete(key);
        count++;
      }
    }
    
    if (count > 0) {
      this.logger.debug(`[VOICE-CACHE] Cleared ${count} cache entries for session ${session_id}`);
    }
  }
  
  /**
   * 获取缓存统计信息
   */
  getCacheStats(): { routingEntries: number; serializedPackets: number } {
    return {
      routingEntries: this.routingCache.size,
      serializedPackets: this.serializedPacketCache.size,
    };
  }
}
