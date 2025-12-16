/**
 * 语音UDP传输层
 * 
 * 处理集群内的语音包UDP传输：
 * - Hub和Edge之间的语音包转发
 * - Edge和Edge之间的语音包转发
 * - UDP丢包处理
 * - 端到端加密传输
 * 
 * Note: VoiceChannel class (previously in voice-packet.ts) has been merged into this file
 * for better code organization and maintainability.
 */

import dgram from 'dgram';
import crypto from 'crypto';
import { type Logger, TypedEventEmitter, type EventMap } from '@munode/common';

// Constants
const HANDSHAKE_RETRY_INTERVAL_MS = 2000;
const HANDSHAKE_MAX_ATTEMPTS = 5;
const HEARTBEAT_INTERVAL_MS = 10000; // Heartbeat interval: 10 seconds
const HEARTBEAT_TIMEOUT_MS = 30000; // Connection timeout: 30 seconds without response
const RECONNECT_DELAY_MS = 3000; // Delay before reconnect attempt
const TIMESTAMP_MASK = 0xFFFFFFFF; // Mask for 32-bit timestamp

export interface VoiceUDPConfig {
  port: number;
  host?: string;
  encryptionKey?: Buffer;
  encryptionAlgorithm?: string;
  localEdgeId?: number; // Local edge ID for determining active/passive side
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

export interface VoicePacket {
  version: number;
  senderId: number;
  targetId: number;
  sequence: number;
  codec: number;
  data: Buffer;
}

export interface VoiceEncryptionConfig {
  algorithm: string; // 'aes-128-cbc' 或 'aes-256-cbc'
  key: Buffer;       // 加密密钥
}

export interface EdgeConnectionStatus {
  edgeId: number;
  connected: boolean;
  lastSeen: number;
  handshakeAttempts: number;
  handshakeComplete: boolean;
  lastHeartbeatSent: number;
  lastHeartbeatReceived: number;
  reconnecting: boolean;
  reconnectAttempts: number;
  isActiveSide: boolean; // true if this edge is the active side (initiator) for heartbeat
}

/**
 * VoiceUDPTransport 事件类型定义
 */
export interface VoiceUDPTransportEvents extends EventMap {
  'error': [error: Error];
  'listening': [address: ReturnType<dgram.Socket['address']>];
  'handshake-failed': [edgeId: number];
  'edge-connected': [edgeId: number];
  'edge-disconnected': [edgeId: number];
  'reconnect-failed': [edgeId: number];
  'voice-packet': [packet: VoicePacket, rinfo: dgram.RemoteInfo];
}

export class VoiceUDPTransport extends TypedEventEmitter<VoiceUDPTransportEvents> {
  private socket: dgram.Socket | null = null;
  private config: VoiceUDPConfig;
  private encryptionConfig: VoiceEncryptionConfig | null = null;
  private remoteEndpoints = new Map<number, RemoteEndpoint>(); // edgeId -> endpoint
  private connectionStatus = new Map<number, EdgeConnectionStatus>(); // edgeId -> connection status
  private encryptedPacketCache = new Map<string, Buffer>(); // cacheKey -> encrypted packet
  private logger: Logger;
  private localEdgeId: number;
  private stats = {
    packetsSent: 0,
    packetsReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    errors: 0,
    handshakeSent: 0,
    handshakeReceived: 0,
    heartbeatsSent: 0,
    heartbeatsReceived: 0,
  };
  private bufferPool: Buffer[] = [];
  private maxPoolSize = 10;
  private heartbeatTimer?: NodeJS.Timeout;
  private connectionCheckTimer?: NodeJS.Timeout;

  constructor(config: VoiceUDPConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    // Default to 0 if not provided (used by Hub, though Hub doesn't participate in edge-to-edge connections)
    this.localEdgeId = config.localEdgeId ?? 0;

    // Setup encryption config if encryption key is provided
    if (config.encryptionKey) {
      const algorithm = config.encryptionAlgorithm || 'aes-128-cbc';
      this.encryptionConfig = {
        algorithm,
        key: config.encryptionKey,
      };
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
        this.logger.error('Voice UDP error:', error);
        this.emit('error', error);
      });

      this.socket.on('listening', () => {
        const address = this.socket.address();
        this.logger.info(`Voice UDP listening on ${address.address}:${address.port}`);
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
    // 停止心跳定时器
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    
    // 停止连接检查定时器
    if (this.connectionCheckTimer) {
      clearInterval(this.connectionCheckTimer);
      this.connectionCheckTimer = undefined;
    }
    
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * 注册远程端点并发起握手
   */
  registerEndpoint(edgeId: number, host: string, port: number): void {
    this.remoteEndpoints.set(edgeId, { host, port });
    
    const now = Date.now();
    // Determine if this is the active side
    // Rule: The edge with the smaller ID acts as the active side for heartbeats
    const isActiveSide = this.localEdgeId < edgeId;
    
    // Initialize connection status
    this.connectionStatus.set(edgeId, {
      edgeId,
      connected: false,
      lastSeen: 0,
      handshakeAttempts: 0,
      handshakeComplete: false,
      lastHeartbeatSent: now,
      lastHeartbeatReceived: now,
      reconnecting: false,
      reconnectAttempts: 0,
      isActiveSide,
    });
    
    this.logger.info(
      `Registered voice endpoint for edge ${edgeId}: ${host}:${port} ` +
      `(role: ${isActiveSide ? 'active/initiator' : 'passive/responder'})`
    );
    
    // Initiate handshake (both active and passive sides need handshake)
    this.initiateHandshake(edgeId);
    
    // 启动心跳和连接检查（如果还没启动）
    this.startHeartbeatIfNeeded();
  }

  /**
   * 移除远程端点
   */
  unregisterEndpoint(edgeId: number): void {
    this.remoteEndpoints.delete(edgeId);
    this.connectionStatus.delete(edgeId);
    this.logger.debug(`Unregistered voice endpoint for edge ${edgeId}`);
  }
  
  /**
   * 发起UDP握手
   */
  private initiateHandshake(edgeId: number): void {
    const endpoint = this.remoteEndpoints.get(edgeId);
    const status = this.connectionStatus.get(edgeId);
    
    if (!endpoint || !status) {
      this.logger.warn(`Cannot initiate handshake for edge ${edgeId}: endpoint or status not found`);
      return;
    }
    
    // 构造握手包
    const handshakePacket = this.createHandshakePacket('SYN');
    
    // 发送握手包
    this.sendPacket(handshakePacket, endpoint.host, endpoint.port);
    status.handshakeAttempts++;
    this.stats.handshakeSent++;
    
    this.logger.debug(`Sent handshake SYN to edge ${edgeId} (attempt ${status.handshakeAttempts})`);
    
    // 设置超时重试
    setTimeout(() => {
      const currentStatus = this.connectionStatus.get(edgeId);
      if (currentStatus && !currentStatus.handshakeComplete && currentStatus.handshakeAttempts < HANDSHAKE_MAX_ATTEMPTS) {
        this.initiateHandshake(edgeId);
      } else if (currentStatus && !currentStatus.handshakeComplete) {
        this.logger.warn(`Handshake with edge ${edgeId} failed after ${HANDSHAKE_MAX_ATTEMPTS} attempts`);
        this.emit('handshake-failed', edgeId);
      }
    }, HANDSHAKE_RETRY_INTERVAL_MS);
  }
  
  /**
   * Create handshake packet
   */
  private createHandshakePacket(type: 'SYN' | 'SYN-ACK' | 'ACK'): Buffer {
    const packet = Buffer.alloc(9); // Magic(4) + Type(1) + Timestamp(4) = 9 bytes
    packet.write('MUHS', 0); // MUNode HandShake magic
    
    switch (type) {
      case 'SYN':
        packet.writeUInt8(1, 4);
        break;
      case 'SYN-ACK':
        packet.writeUInt8(2, 4);
        break;
      case 'ACK':
        packet.writeUInt8(3, 4);
        break;
    }
    
    packet.writeUInt32BE(Date.now() & TIMESTAMP_MASK, 5); // Timestamp (lower 32 bits)
    return packet;
  }
  
  /**
   * Create heartbeat packet
   */
  private createHeartbeatPacket(type: 'PING' | 'PONG'): Buffer {
    const packet = Buffer.alloc(9); // Magic(4) + Type(1) + Timestamp(4) = 9 bytes
    packet.write('MUHB', 0); // MUNode HeartBeat magic
    packet.writeUInt8(type === 'PING' ? 1 : 2, 4);
    packet.writeUInt32BE(Date.now() & TIMESTAMP_MASK, 5); // Timestamp (lower 32 bits)
    return packet;
  }
  
  /**
   * Handle handshake packet
   */
  private handleHandshakePacket(data: Buffer, rinfo: dgram.RemoteInfo): void {
    if (data.length < 9 || data.toString('utf8', 0, 4) !== 'MUHS') {
      return; // Not a handshake packet
    }
    
    const type = data.readUInt8(4);
    
    // 找到对应的edge
    let edgeId: number | undefined;
    for (const [id, endpoint] of this.remoteEndpoints) {
      if (endpoint.host === rinfo.address && endpoint.port === rinfo.port) {
        edgeId = id;
        break;
      }
    }
    
    if (!edgeId) {
      this.logger.debug(`Received handshake from unknown endpoint: ${rinfo.address}:${rinfo.port}`);
      return;
    }
    
    const status = this.connectionStatus.get(edgeId);
    if (!status) return;
    
    const now = Date.now();
    status.lastSeen = now;
    status.lastHeartbeatReceived = now;
    this.stats.handshakeReceived++;
    
    if (type === 1) { // SYN
      this.logger.debug(`Received handshake SYN from edge ${edgeId}`);
      // 发送 SYN-ACK
      const synAck = this.createHandshakePacket('SYN-ACK');
      this.sendPacket(synAck, rinfo.address, rinfo.port);
      this.stats.handshakeSent++;
      status.handshakeComplete = true;
      status.connected = true;
      status.reconnecting = false;
      status.reconnectAttempts = 0;
      this.logger.info(`UDP handshake complete with edge ${edgeId} (received SYN)`);
      this.emit('edge-connected', edgeId);
    } else if (type === 2) { // SYN-ACK
      this.logger.debug(`Received handshake SYN-ACK from edge ${edgeId}`);
      // 发送 ACK
      const ack = this.createHandshakePacket('ACK');
      this.sendPacket(ack, rinfo.address, rinfo.port);
      this.stats.handshakeSent++;
      status.handshakeComplete = true;
      status.connected = true;
      status.reconnecting = false;
      status.reconnectAttempts = 0;
      this.logger.info(`UDP handshake complete with edge ${edgeId} (received SYN-ACK)`);
      this.emit('edge-connected', edgeId);
    } else if (type === 3) { // ACK
      this.logger.debug(`Received handshake ACK from edge ${edgeId}`);
      status.handshakeComplete = true;
      status.connected = true;
      status.reconnecting = false;
      status.reconnectAttempts = 0;
      this.logger.info(`UDP handshake complete with edge ${edgeId} (received ACK)`);
      this.emit('edge-connected', edgeId);
    }
  }
  
  /**
   * Handle heartbeat packet
   */
  private handleHeartbeatPacket(data: Buffer, rinfo: dgram.RemoteInfo): void {
    if (data.length < 9 || data.toString('utf8', 0, 4) !== 'MUHB') {
      return; // Not a heartbeat packet
    }
    
    const type = data.readUInt8(4);
    
    // 找到对应的edge
    let edgeId: number | undefined;
    for (const [id, endpoint] of this.remoteEndpoints) {
      if (endpoint.host === rinfo.address && endpoint.port === rinfo.port) {
        edgeId = id;
        break;
      }
    }
    
    if (!edgeId) {
      this.logger.debug(`Received heartbeat from unknown endpoint: ${rinfo.address}:${rinfo.port}`);
      return;
    }
    
    const status = this.connectionStatus.get(edgeId);
    if (!status) return;
    
    const now = Date.now();
    status.lastSeen = now;
    status.lastHeartbeatReceived = now;
    
    if (type === 1) { // PING
      this.logger.debug(`Received heartbeat PING from edge ${edgeId}`);
      // 回复 PONG
      const pong = this.createHeartbeatPacket('PONG');
      this.sendPacket(pong, rinfo.address, rinfo.port);
      this.stats.heartbeatsReceived++;
    } else if (type === 2) { // PONG
      this.logger.debug(`Received heartbeat PONG from edge ${edgeId}`);
      this.stats.heartbeatsReceived++;
    }
  }
  
  /**
   * 启动心跳定时器（如果需要）
   */
  private startHeartbeatIfNeeded(): void {
    if (this.heartbeatTimer || this.connectionCheckTimer) {
      return; // 已经启动
    }
    
    // 心跳发送定时器
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
    }, HEARTBEAT_INTERVAL_MS);
    
    // 连接检查定时器
    this.connectionCheckTimer = setInterval(() => {
      this.checkConnections();
    }, HEARTBEAT_INTERVAL_MS);
    
    this.logger.debug('Heartbeat and connection check timers started');
  }
  
  /**
   * 发送心跳包到所有已连接的Edge
   * 
   * 心跳策略：
   * - 主动方（active side，ID较小的一方）发送PING
   * - 被动方（passive side）回复PONG
   * - 双方都检测心跳超时
   */
  private sendHeartbeats(): void {
    const now = Date.now();
    for (const [edgeId, status] of this.connectionStatus) {
      // Only active side sends heartbeat when connection is established
      if (status.handshakeComplete && !status.reconnecting && status.isActiveSide) {
        const endpoint = this.remoteEndpoints.get(edgeId);
        if (endpoint) {
          const ping = this.createHeartbeatPacket('PING');
          this.sendPacket(ping, endpoint.host, endpoint.port);
          status.lastHeartbeatSent = now;
          this.stats.heartbeatsSent++;
          this.logger.debug(`Sent heartbeat PING to edge ${edgeId} (active side)`);
        }
      }
    }
  }
  
  /**
   * Check connection status, handle timeouts and reconnection
   * 
   * Disconnection detection strategy:
   * - Active side: If no PONG received for HEARTBEAT_TIMEOUT_MS, consider disconnected
   * - Passive side: If no PING received for HEARTBEAT_TIMEOUT_MS, consider disconnected
   * - Both sides detect timeout independently
   * 
   * Reconnection strategy:
   * - Both active and passive sides attempt reconnection when timeout detected
   * - This ensures reconnection even if active side fails
   * - Connection is considered restored if EITHER direction succeeds
   * - Only report to Hub if BOTH directions fail after retries
   */
  private checkConnections(): void {
    const now = Date.now();
    for (const [edgeId, status] of this.connectionStatus) {
      if (!status.handshakeComplete) {
        continue; // Skip connections that haven't completed handshake
      }
      
      const timeSinceLastHeartbeat = now - status.lastHeartbeatReceived;
      
      if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS && status.connected) {
        // Connection timeout
        const role = status.isActiveSide ? 'active/initiator' : 'passive/responder';
        this.logger.warn(
          `Edge ${edgeId} connection timeout (no heartbeat for ${timeSinceLastHeartbeat}ms, ` +
          `role: ${role})`
        );
        status.connected = false;
        status.handshakeComplete = false;
        this.emit('edge-disconnected', edgeId);
        
        // Initiate reconnection (both sides attempt reconnection)
        this.initiateReconnect(edgeId);
      }
    }
  }
  
  /**
   * Initiate reconnection attempt
   * 
   * Note: Each side independently attempts reconnection when it detects timeout.
   * If the other direction succeeds first, this reconnection will be cancelled.
   */
  private initiateReconnect(edgeId: number): void {
    const status = this.connectionStatus.get(edgeId);
    if (!status || status.reconnecting) {
      return;
    }
    
    status.reconnecting = true;
    status.reconnectAttempts = 0;
    
    this.logger.info(`Initiating reconnect to edge ${edgeId}`);
    
    // Delay before starting reconnection
    setTimeout(() => {
      this.performReconnect(edgeId);
    }, RECONNECT_DELAY_MS);
  }
  
  /**
   * 执行重连
   */
  private performReconnect(edgeId: number): void {
    const status = this.connectionStatus.get(edgeId);
    const endpoint = this.remoteEndpoints.get(edgeId);
    
    if (!status || !endpoint) {
      return;
    }
    
    if (!status.reconnecting) {
      return; // 已经重连成功或被取消
    }
    
    status.reconnectAttempts++;
    this.logger.debug(`Reconnecting to edge ${edgeId}, attempt ${status.reconnectAttempts}`);
    
    // 重新发起握手
    const handshakePacket = this.createHandshakePacket('SYN');
    this.sendPacket(handshakePacket, endpoint.host, endpoint.port);
    this.stats.handshakeSent++;
    
    // 如果重连次数达到上限，检查连接状态再决定是否报告失败
    if (status.reconnectAttempts >= HANDSHAKE_MAX_ATTEMPTS) {
      // 重要：只有在连接仍然断开的情况下才报告失败
      // 如果另一个方向已经成功重连（收到对方的握手包），则不报告失败
      if (!status.connected || !status.handshakeComplete) {
        this.logger.error(
          `Failed to reconnect to edge ${edgeId} after ${HANDSHAKE_MAX_ATTEMPTS} attempts, ` +
          `connection still broken, notifying Hub`
        );
        status.reconnecting = false;
        this.emit('reconnect-failed', edgeId);
      } else {
        this.logger.info(
          `Reconnect attempts to edge ${edgeId} exhausted, but connection was restored ` +
          `from the other direction, no need to notify Hub`
        );
        status.reconnecting = false;
        status.reconnectAttempts = 0;
      }
      return;
    }
    
    // 继续尝试重连
    setTimeout(() => {
      this.performReconnect(edgeId);
    }, HANDSHAKE_RETRY_INTERVAL_MS);
  }

  /**
   * Get list of all registered remote Edge IDs
   */
  getRegisteredEdgeIds(): number[] {
    return Array.from(this.remoteEndpoints.keys());
  }

  /**
   * Get buffer from pool or allocate new
   */
  private getBuffer(size: number): Buffer {
    for (let i = 0; i < this.bufferPool.length; i++) {
      if (this.bufferPool[i].length >= size) {
        return this.bufferPool.splice(i, 1)[0].slice(0, size);
      }
    }
    return Buffer.allocUnsafe(size);
  }

  /**
   * Return buffer to pool
   */
  private returnBuffer(buffer: Buffer): void {
    if (this.bufferPool.length < this.maxPoolSize) {
      this.bufferPool.push(buffer);
    }
  }

  /**
   * 编码语音包（包含加密）
   */
  private encodePacket(packet: VoicePacket): Buffer {
    if (!this.encryptionConfig) {
      throw new Error('Encryption not configured');
    }

    // 编码明文包头 + 数据
    const plainBuffer = this.getBuffer(14 + packet.data.length);
    plainBuffer.writeUInt8(packet.version, 0);
    plainBuffer.writeUInt32BE(packet.senderId, 1);
    plainBuffer.writeUInt32BE(packet.targetId, 5);
    plainBuffer.writeUInt32BE(packet.sequence, 9);
    plainBuffer.writeUInt8(packet.codec, 13);
    packet.data.copy(plainBuffer, 14);

    // 生成随机IV (16字节 for CBC)
    const iv = crypto.randomBytes(16);

    // Note: Cipher instances cannot be persisted because each encryption requires a unique IV for security
    const cipher = crypto.createCipheriv(this.encryptionConfig.algorithm, this.encryptionConfig.key, iv);

    // 加密整个包
    const encryptedData = Buffer.concat([
      cipher.update(plainBuffer),
      cipher.final()
    ]);

    // 返回格式: IV(16) + 加密数据
    return Buffer.concat([iv, encryptedData]);
  }

  /**
   * 解码加密语音包（包含解密）
   */
  private decodeEncryptedPacket(buffer: Buffer): VoicePacket | null {
    if (!this.encryptionConfig) {
      throw new Error('Encryption not configured');
    }

    if (buffer.length < 16 + 14) return null; // IV + 最小包头

    try {
      const iv = buffer.slice(0, 16);
      const encryptedData = buffer.slice(16);

      // Note: Decipher instances cannot be persisted because each decryption requires the specific IV from the packet
      const decipher = crypto.createDecipheriv(this.encryptionConfig.algorithm, this.encryptionConfig.key, iv);

      // 解密数据
      const decryptedData = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final()
      ]);

      // 验证解密后的数据长度
      if (decryptedData.length < 14) return null;

      // 解析包头
      return {
        version: decryptedData.readUInt8(0),
        senderId: decryptedData.readUInt32BE(1),
        targetId: decryptedData.readUInt32BE(5),
        sequence: decryptedData.readUInt32BE(9),
        codec: decryptedData.readUInt8(13),
        data: decryptedData.slice(14),
      };
    } catch (_error) {
      // 解密失败，返回null
      return null;
    }
  }

  /**
   * 发送语音包到指定Edge
   */
  sendToEdge(edgeId: number, packet: VoicePacketHeader, voiceData: Buffer): void {
    const endpoint = this.remoteEndpoints.get(edgeId);
    if (!endpoint) {
      this.logger.warn(`No endpoint registered for edge ${edgeId}`);
      return;
    }

    // 编码包头
    const headerBuffer = this.encodePacketHeader(packet);
    const fullPacket = Buffer.concat([headerBuffer, voiceData]);

    // 加密（如果启用）
    let finalPacket: Buffer;
    if (this.encryptionConfig) {
      finalPacket = this.encodePacket({
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
   * 注意：Edge间broadcast不需要缓存，因为每次都是实时数据
   * 优化：如果发送给多个Edge，复用加密后的数据（但不持久化缓存）
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

    // 加密（如果启用）- 为本次broadcast加密一次，所有edge复用同一个加密结果
    // 不缓存加密结果，因为语音包是实时流数据，不会重复发送
    let finalPacket: Buffer;
    if (this.encryptionConfig) {
      finalPacket = this.encodePacket({
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
        this.logger.debug(`Skipping broadcast to self edge ${edgeId}`);
        continue;
      }
      
      // 只发送给已完成握手的Edge
      const status = this.connectionStatus.get(edgeId);
      if (status && !status.handshakeComplete) {
        this.logger.debug(`Skipping broadcast to edge ${edgeId} - handshake not complete`);
        continue;
      }
      
      this.sendPacket(finalPacket, endpoint.host, endpoint.port);
      sentCount++;
    }
    
    if (sentCount > 0) {
      this.logger.debug(
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
      // Check if it's a handshake packet
      if (data.length >= 9 && data.toString('utf8', 0, 4) === 'MUHS') {
        this.handleHandshakePacket(data, rinfo);
        return;
      }
      
      // Check if it's a heartbeat packet
      if (data.length >= 9 && data.toString('utf8', 0, 4) === 'MUHB') {
        this.handleHeartbeatPacket(data, rinfo);
        return;
      }
      
      // 解密（如果启用）
      let decryptedData: Buffer;
      if (this.encryptionConfig) {
        const decrypted = this.decodeEncryptedPacket(data);
        if (!decrypted) {
          this.logger.warn('Failed to decrypt voice packet');
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
      const decoded = this.decodePacket(decryptedData);
      if (!decoded) {
        this.logger.warn('Failed to parse voice packet');
        this.stats.errors++;
        return;
      }

      // 构建完整的 VoicePacket
      const packet: VoicePacket = {
        version: decoded.header.version,
        senderId: decoded.header.senderId,
        targetId: decoded.header.targetId,
        sequence: decoded.header.sequence,
        codec: decoded.header.codec,
        data: decoded.voiceData,
      };

      // 发出事件
      // voiceData 是去除了自定义header后的完整 Mumble 语音包
      this.emit('voice-packet', packet, rinfo);
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Error handling incoming voice packet:', error);
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
      this.logger.warn('UDP socket not initialized');
      return;
    }

    this.socket.send(data, port, host, (error) => {
      if (error) {
        this.stats.errors++;
        this.logger.error('Error sending voice packet:', error);
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
    handshakeSent: number;
    handshakeReceived: number;
    heartbeatsSent: number;
    heartbeatsReceived: number;
    registeredEndpoints: number;
    connectedEndpoints: number;
  } {
    const connectedCount = Array.from(this.connectionStatus.values())
      .filter(s => s.handshakeComplete).length;
    
    return {
      ...this.stats,
      registeredEndpoints: this.remoteEndpoints.size,
      connectedEndpoints: connectedCount,
    };
  }
  
  /**
   * 获取Edge连接状态
   */
  getConnectionStatus(edgeId: number): EdgeConnectionStatus | undefined {
    return this.connectionStatus.get(edgeId);
  }
  
  /**
   * 获取所有Edge连接状态
   */
  getAllConnectionStatus(): EdgeConnectionStatus[] {
    return Array.from(this.connectionStatus.values());
  }
  
  /**
   * 检查Edge是否已连接
   */
  isEdgeConnected(edgeId: number): boolean {
    const status = this.connectionStatus.get(edgeId);
    return status?.handshakeComplete ?? false;
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
      handshakeSent: 0,
      handshakeReceived: 0,
      heartbeatsSent: 0,
      heartbeatsReceived: 0,
    };
  }

  /**
   * 更新加密密钥
   */
  updateEncryptionKey(key: Buffer, algorithm?: string): void {
    const algo = algorithm || this.config.encryptionAlgorithm || 'aes-128-cbc';
    
    // 更新配置
    this.config.encryptionKey = key;
    this.config.encryptionAlgorithm = algo;
    
    // 更新加密配置
    this.encryptionConfig = {
      algorithm: algo,
      key,
    };
    
    // 清空加密包缓存
    this.encryptedPacketCache.clear();
    
    this.logger.info(`Voice UDP encryption key updated (algorithm: ${algo})`);
  }
  
  /**
   * 获取加密配置
   */
  getEncryptionConfig(): VoiceEncryptionConfig | null {
    return this.encryptionConfig;
  }

  /**
   * 检查是否已启动
   */
  isRunning(): boolean {
    return this.socket !== null;
  }

  /**
   * 生成新的加密配置（用于密钥分发）
   */
  static generateEncryptionConfig(algorithm: 'aes-128-cbc' | 'aes-256-cbc' = 'aes-128-cbc'): VoiceEncryptionConfig {
    const keyLength = algorithm === 'aes-128-cbc' ? 16 : 32;
    const key = crypto.randomBytes(keyLength);

    return {
      algorithm,
      key,
    };
  }

  /**
   * 从密钥数据创建配置
   */
  static createEncryptionConfig(algorithm: string, keyData: Buffer): VoiceEncryptionConfig {
    return {
      algorithm,
      key: keyData,
    };
  }
}
