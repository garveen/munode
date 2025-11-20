import { EventEmitter } from 'events';
// import { logger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, VoicePacket, VoiceBroadcast, ClientInfo } from '../types.js';
import { OCB2AES128 } from '@munode/common';
import type { Socket as UDPSocket } from 'dgram';

/**
 * 语音路由器 - 处理语音包的路由和转发
 */
export class VoiceRouter extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;
  private clientCryptos: Map<number, OCB2AES128> = new Map(); // session_id -> OCB2AES128
  private voiceTargets: Map<number, Map<number, any>> = new Map(); // session_id -> (target_id -> config)
  private udpServer?: UDPSocket; // UDP 服务器引用，用于发送语音包
  private clientManager?: any; // ClientManager 引用，用于获取客户端信息

  constructor(config: EdgeConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
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
    if (!this.udpServer) {
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
          this.logger.info(`Sent UDP ping response to session ${session_id} at ${address}:${port}`);
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
      // 解析语音包
      const packet = this.parseVoicePacket(data);
      if (!packet) {
        return;
      }

      packet.sender_session = session_id;
      this.logger.debug(
        `Voice tunnel: sender=${session_id}, target=${packet.target}`
      );

      // 处理语音包路由
      this.routeVoicePacket(packet);
    } catch (error) {
      this.logger.error('Error handling voice tunnel:', error);
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
   * 路由语音包
   */
  private routeVoicePacket(packet: VoicePacket): void {
    // 根据目标类型路由语音包
    switch (packet.target) {
      case 0: // 普通频道语音
        this.routeToChannel(packet);
        break;
      case 1: // 服务器广播
        this.routeToServer(packet);
        break;
      default: // 语音目标
        this.routeToVoiceTarget(packet);
        break;
    }

    this.emit('voicePacket', packet);
  }

  /**
   * 路由到频道
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

    // 检查发送者是否被mute或suppress
    if (sender.mute || sender.self_mute || sender.suppress) {
      this.logger.debug(`Voice packet from ${sender.username} dropped: muted or suppressed`);
      return;
    }

    // 获取发送者所在频道的所有客户端
    const channelClients = this.clientManager.getClientsInChannel(sender.channel_id);

    // 准备广播的语音包（包含发送者会话ID）
    const broadcastPacket = this.serializeVoicePacket(packet);

    this.logger.debug(
      `Broadcasting voice to channel ${sender.channel_id}, excluding session ${packet.sender_session}`
    );

    // 发送给频道中的所有其他客户端（不包括发送者和被mute/deaf的客户端）
    for (const targetClient of channelClients) {
      // 跳过发送者自己
      if (targetClient.session === packet.sender_session) {
        continue;
      }

      // 跳过deaf或self_deaf的客户端
      if (targetClient.deaf || targetClient.self_deaf) {
        continue;
      }

      // 跳过未连接或断开的客户端
      if (!targetClient.user_id || targetClient.user_id <= 0) {
        continue;
      }

      // 发送语音包
      this.sendVoicePacketToClient(targetClient, broadcastPacket);
    }
    
    // 发送给正在监听此频道的用户（不在该频道内）
    const allClients = this.clientManager.getAllClients();
    for (const targetClient of allClients) {
      // 跳过发送者自己
      if (targetClient.session === packet.sender_session) {
        continue;
      }
      
      // 跳过已经在频道内的用户（上面已经处理过）
      if (targetClient.channel_id === sender.channel_id) {
        continue;
      }
      
      // 检查是否在监听此频道
      if (targetClient.listeningChannels && targetClient.listeningChannels.has(sender.channel_id)) {
        // 跳过deaf或self_deaf的客户端
        if (targetClient.deaf || targetClient.self_deaf) {
          continue;
        }
        
        // 跳过未连接或断开的客户端
        if (!targetClient.user_id || targetClient.user_id <= 0) {
          continue;
        }
        
        this.logger.debug(`Sending voice to listener ${targetClient.username} (not in channel ${sender.channel_id})`);
        this.sendVoicePacketToClient(targetClient, broadcastPacket);
      }
    }

    // 同时触发事件供外部处理（如集群模式下的跨Edge转发）
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

    this.emit('broadcastToChannel', sender.channel_id, broadcast, packet.sender_session);
  }

  /**
   * 路由到服务器
   */
  private routeToServer(packet: VoicePacket): void {
    const broadcast: VoiceBroadcast = {
       sender_id: packet.sender_session,
       sender_edge_id: this.config.server_id,
       sender_username: '', // 将在调用处设置
      target: packet.target,
      packet: this.serializeVoicePacket(packet),
      timestamp: packet.timestamp,
       routing_info: {},
    };

    // 广播到所有用户
    this.emit('broadcastToServer', broadcast, packet.sender_session);
  }

  /**
   * 路由到语音目标
   */
  private routeToVoiceTarget(packet: VoicePacket): void {
    // 获取语音目标配置
    this.emit('getVoiceTarget', packet.sender_session, packet.target, (targetConfig: any) => {
      if (!targetConfig) {
        return;
      }

      const broadcast: VoiceBroadcast = {
         sender_id: packet.sender_session,
         sender_edge_id: this.config.server_id,
         sender_username: '', // 将在调用处设置
        target: packet.target,
        packet: this.serializeVoicePacket(packet),
        timestamp: packet.timestamp,
         routing_info: {
           voice_target_id: packet.target,
        },
      };

      // 根据语音目标配置路由
      this.emit('broadcastToVoiceTarget', targetConfig, broadcast, packet.sender_session);
    });
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
    // 创建新的header，保留codec类型但清除target（strip target bits）
    // Go: outbuf[0] = buf[0] & 0xe0
    // 注意：target必须清零，因为接收端会根据自己的whisper设置重新设置
    const header = (packet.codec << 5) & 0xe0;
    
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
    if (!this.udpServer) {
      this.logger.warn('UDP server not set, cannot send voice packet');
      return;
    }

    // 检查客户端是否有UDP地址
    if (!client.udp_ip || !client.udp_port) {
      this.logger.debug(`Client ${client.session} has no UDP address, voice packet not sent`);
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
          this.logger.error(`Failed to send voice packet to ${client.username} (${client.session}):`, err);
        }
      });
    } catch (error) {
      this.logger.error(`Error sending voice packet to ${client.username} (${client.session}):`, error);
    }
  }
}
