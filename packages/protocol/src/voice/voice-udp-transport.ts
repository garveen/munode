/**
 * 语音UDP传输层
 * 
 * 处理集群内的语音包UDP传输：
 * - Hub和Edge之间的语音包转发
 * - Edge和Edge之间的语音包转发
 * - UDP丢包处理
 */

import dgram from 'dgram';
import { EventEmitter } from 'events';
import { VoiceChannel } from './voice-packet.js';

export interface VoiceUDPConfig {
  port: number;
  host?: string;
  encryptionKey?: Buffer;
}

export interface VoicePacketHeader {
  version: number;
  senderId: number;
  targetId: number;
  sequence: number;
  codec: number;
}

export interface RemoteEndpoint {
  host: string;
  port: number;
}

export class VoiceUDPTransport extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private config: VoiceUDPConfig;
  private voiceChannel: VoiceChannel | null = null;
  private remoteEndpoints = new Map<number, RemoteEndpoint>(); // edgeId -> endpoint
  private stats = {
    packetsSent: 0,
    packetsReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    errors: 0,
  };

  constructor(config: VoiceUDPConfig) {
    super();
    this.config = config;

    // 如果提供了加密密钥，创建VoiceChannel
    if (config.encryptionKey) {
      this.voiceChannel = new VoiceChannel({
        algorithm: 'aes-128-cbc',
        key: config.encryptionKey,
      });
    }
  }

  /**
   * 启动UDP监听
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        this.handleIncomingPacket(msg, rinfo);
      });

      this.socket.on('error', (error) => {
        this.stats.errors++;
        console.error('Voice UDP error:', error);
        this.emit('error', error);
      });

      this.socket.on('listening', () => {
        const address = this.socket!.address();
        console.info(`Voice UDP listening on ${address.address}:${address.port}`);
        this.emit('listening', address);
        resolve();
      });

      this.socket.bind(this.config.port, this.config.host || '0.0.0.0', () => {
        // Binding complete
      });

      this.socket.once('error', reject);
    });
  }

  /**
   * 停止UDP监听
   */
  stop(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * 注册远程端点
   */
  registerEndpoint(edgeId: number, host: string, port: number): void {
    this.remoteEndpoints.set(edgeId, { host, port });
    console.debug(`Registered voice endpoint for edge ${edgeId}: ${host}:${port}`);
  }

  /**
   * 移除远程端点
   */
  unregisterEndpoint(edgeId: number): void {
    this.remoteEndpoints.delete(edgeId);
    console.debug(`Unregistered voice endpoint for edge ${edgeId}`);
  }

  /**
   * 发送语音包到指定Edge
   */
  sendToEdge(edgeId: number, packet: VoicePacketHeader, voiceData: Buffer): void {
    const endpoint = this.remoteEndpoints.get(edgeId);
    if (!endpoint) {
      console.warn(`No endpoint registered for edge ${edgeId}`);
      return;
    }

    // 编码包头
    const headerBuffer = this.encodePacketHeader(packet);
    const fullPacket = Buffer.concat([headerBuffer, voiceData]);

    // 加密（如果启用）
    let finalPacket: Buffer;
    if (this.voiceChannel) {
      finalPacket = this.voiceChannel.encodePacket({
        ...packet,
        data: fullPacket,
      });
    } else {
      finalPacket = fullPacket;
    }

    // 发送
    this.sendPacket(finalPacket, endpoint.host, endpoint.port);
  }

  /**
   * 广播语音包到所有Edge（除了excludeEdge）
   */
  broadcast(
    packet: VoicePacketHeader,
    voiceData: Buffer,
    excludeEdge?: number
  ): void {
    // 编码包头（自定义14字节header，用于Edge间通信）
    const headerBuffer = this.encodePacketHeader(packet);
    // voiceData 是完整的 Mumble 语音包格式：[header][session][sequence][voice_data]
    const fullPacket = Buffer.concat([headerBuffer, voiceData]);

    // 加密（如果启用）
    let finalPacket: Buffer;
    if (this.voiceChannel) {
      finalPacket = this.voiceChannel.encodePacket({
        ...packet,
        data: fullPacket,
      });
    } else {
      finalPacket = fullPacket;
    }

    // 发送给所有端点
    let sentCount = 0;
    for (const [edgeId, endpoint] of this.remoteEndpoints) {
      if (edgeId === excludeEdge) {
        console.debug(`Skipping broadcast to self edge ${edgeId}`);
        continue;
      }
      this.sendPacket(finalPacket, endpoint.host, endpoint.port);
      sentCount++;
    }
    
    if (sentCount > 0) {
      console.debug(
        `Broadcasted voice packet to ${sentCount} peers: ` +
        `sender=${packet.senderId}, target=${packet.targetId}, ` +
        `codec=${packet.codec}, total_size=${finalPacket.length}`
      );
    }
  }

  /**
   * 处理收到的语音包
   */
  private handleIncomingPacket(data: Buffer, rinfo: dgram.RemoteInfo): void {
    this.stats.packetsReceived++;
    this.stats.bytesReceived += data.length;

    try {
      // 解密（如果启用）
      let decryptedData: Buffer;
      if (this.voiceChannel) {
        const decrypted = this.voiceChannel.decodePacket(data);
        if (!decrypted) {
          console.warn('Failed to decrypt voice packet');
          this.stats.errors++;
          return;
        }
        decryptedData = Buffer.concat([
          this.encodePacketHeader({
            version: decrypted.version,
            senderId: decrypted.senderId,
            targetId: decrypted.targetId,
            sequence: decrypted.sequence,
            codec: decrypted.codec,
          }),
          decrypted.data,
        ]);
      } else {
        decryptedData = data;
      }

      // 解析包头（自定义14字节header）
      const packet = this.decodePacket(decryptedData);
      if (!packet) {
        console.warn('Failed to parse voice packet');
        this.stats.errors++;
        return;
      }

      console.debug(
        `Received voice packet from ${rinfo.address}:${rinfo.port}: ` +
        `sender=${packet.header.senderId}, target=${packet.header.targetId}, ` +
        `codec=${packet.header.codec}, voice_data_size=${packet.voiceData.length}`
      );

      // 发出事件
      // voiceData 是去除了自定义header后的完整 Mumble 语音包
      this.emit('voice-packet', packet, rinfo);
    } catch (error) {
      this.stats.errors++;
      console.error('Error handling incoming voice packet:', error);
    }
  }

  /**
   * 编码包头（14字节）
   */
  private encodePacketHeader(packet: VoicePacketHeader): Buffer {
    const buffer = Buffer.allocUnsafe(14);
    buffer.writeUInt8(packet.version, 0);
    buffer.writeUInt32BE(packet.senderId, 1);
    buffer.writeUInt32BE(packet.targetId, 5);
    buffer.writeUInt32BE(packet.sequence, 9);
    buffer.writeUInt8(packet.codec, 13);
    return buffer;
  }

  /**
   * 解码语音包
   */
  private decodePacket(data: Buffer): {
    header: VoicePacketHeader;
    voiceData: Buffer;
  } | null {
    if (data.length < 14) {
      return null;
    }

    const header: VoicePacketHeader = {
      version: data.readUInt8(0),
      senderId: data.readUInt32BE(1),
      targetId: data.readUInt32BE(5),
      sequence: data.readUInt32BE(9),
      codec: data.readUInt8(13),
    };

    const voiceData = data.slice(14);

    return { header, voiceData };
  }

  /**
   * 发送UDP包
   */
  private sendPacket(data: Buffer, host: string, port: number): void {
    if (!this.socket) {
      console.warn('UDP socket not initialized');
      return;
    }

    this.socket.send(data, port, host, (error) => {
      if (error) {
        this.stats.errors++;
        console.error('Error sending voice packet:', error);
      } else {
        this.stats.packetsSent++;
        this.stats.bytesSent += data.length;
      }
    });
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    packetsSent: number;
    packetsReceived: number;
    bytesSent: number;
    bytesReceived: number;
    errors: number;
    registeredEndpoints: number;
  } {
    return {
      ...this.stats,
      registeredEndpoints: this.remoteEndpoints.size,
    };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      packetsSent: 0,
      packetsReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      errors: 0,
    };
  }

  /**
   * 更新加密密钥
   */
  updateEncryptionKey(key: Buffer): void {
    if (this.voiceChannel) {
      this.voiceChannel.updateKey(key);
    } else {
      this.voiceChannel = new VoiceChannel({
        algorithm: 'aes-128-cbc',
        key,
      });
    }
    console.info('Voice UDP encryption key updated');
  }

  /**
   * 检查是否已启动
   */
  isRunning(): boolean {
    return this.socket !== null;
  }
}
