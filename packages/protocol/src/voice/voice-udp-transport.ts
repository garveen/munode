/**
 * 语音UDP传输层 (Phase 2 Refactored)
 * 
 * 重构后的职责：
 * - 数据传输：序列化、加密、质量监控  
 * - 连接管理：委托给 EdgeConnectionManager
 * 
 * 保持向后兼容：
 * - Edge模式：sendVoicePacket(edgeId, packet), broadcast(packet, exclude)
 * - Hub模式：sendToEdge(edgeId, header, data), broadcast(header, data, sender)
 */

import crypto from 'crypto';
import type dgram from 'dgram';
import { type Logger, TypedEventEmitter, type EventMap } from '@munode/common';
import { EdgeConnectionManager, type EdgeConnectionManagerConfig } from '../connection/edge-connection-manager.js';
import type { ConnectionStatus, ConnectionQualityMetrics } from '../connection/connection-types.js';

// 保持原有导出以维持向后兼容
export interface VoiceUDPConfig {
  port: number;
  host?: string;
  encryptionKey?: Buffer;
  encryptionAlgorithm?: string;
  localEdgeId?: number;
  sharedSecret?: Buffer;
}

export interface VoicePacketHeader {
  senderId: number;
  targetId: number;
  sequence: number;
}

export interface RemoteEndpoint {
  host: string;
  port: number;
}

export interface VoicePacket {
  senderId: number;
  targetId: number;
  sequence: number;
  data: Buffer;
}

export interface VoiceEncryptionConfig {
  algorithm: string;
  key: Buffer;
}

/**
 * VoiceUDPTransport 事件类型定义
 */
export interface VoiceUDPTransportEvents extends EventMap {
  'error': [error: Error];
  'listening': [address: ReturnType<typeof dgram.Socket.prototype.address>];
  'handshake-failed': [edgeId: number];
  'edge-connected': [edgeId: number];
  'edge-disconnected': [edgeId: number];
  'reconnect-failed': [edgeId: number];
  'voice-packet': [packet: VoicePacket, rinfo?: dgram.RemoteInfo];
  'quality-measured': [edgeId: number, rtt: number, packetLoss: number, sequence: number];
}

/**
 * 语音UDP传输层
 * 
 * Phase 3: 使用 EdgeConnectionManager 管理连接，质量监控移至连接层
 */
export class VoiceUDPTransport extends TypedEventEmitter<VoiceUDPTransportEvents> {
  private config: VoiceUDPConfig;
  private encryptionConfig: VoiceEncryptionConfig | null = null;
  private logger: Logger;
  private localEdgeId: number;
  private connectionManager: EdgeConnectionManager;
  
  // 性能优化：加密包缓存
  private encryptedPacketCache = new Map<string, Buffer>();
  private readonly CACHE_MAX_SIZE = 500;
  
  // 统计
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

  constructor(config: VoiceUDPConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.localEdgeId = config.localEdgeId ?? 0;

    // 初始化加密配置
    if (config.encryptionKey) {
      const algorithm = config.encryptionAlgorithm || 'aes-128-cbc';
      this.encryptionConfig = {
        algorithm,
        key: config.encryptionKey,
      };
    }

    // 创建连接管理器
    const connConfig: EdgeConnectionManagerConfig = {
      localEdgeId: this.localEdgeId,
      sharedSecret: config.sharedSecret,
    };
    this.connectionManager = new EdgeConnectionManager(connConfig, logger);
    
    // 设置连接管理器事件监听
    this.setupConnectionManagerEvents();
    
    this.logger.info('VoiceUDPTransport initialized (Phase 2: using EdgeConnectionManager)');
  }

  /**
   * 设置UDP发送函数（用于统一入口模式）
   */
  setSendFunction(sendFunc: (buffer: Buffer, host: string, port: number) => void): void {
    this.connectionManager.setUDPSendFunction(sendFunc);
    this.logger.info('VoiceUDPTransport using external send function (via EdgeConnectionManager)');
  }

  /**
   * 启动传输层（保持向后兼容，实际连接由EdgeConnectionManager管理）
   * @deprecated 连接管理现在由 EdgeConnectionManager 处理
   */
  start(): Promise<void> {
    this.logger.debug('VoiceUDPTransport.start() called (connections managed by EdgeConnectionManager)');
    return Promise.resolve();
  }

  /**
   * 停止传输层
   */
  stop(): void {
    this.connectionManager.stop();
    this.encryptedPacketCache.clear();
    this.logger.info('VoiceUDPTransport stopped');
  }

  /**
   * 注册远程端点
   */
  registerEndpoint(edgeId: number, host: string, port: number): void {
    this.logger.info(`Registering endpoint for edge ${edgeId}: ${host}:${port}`);
    void this.connectionManager.registerEndpoint(edgeId, host, port);
  }

  /**
   * 移除远程端点
   */
  unregisterEndpoint(edgeId: number): void {
    this.connectionManager.unregisterEndpoint(edgeId);
    this.logger.info(`Unregistered endpoint for edge ${edgeId}`);
  }
  /**
   * 主动连接到指定Edge（已有Edge连接新Edge时使用）
   */
  async connectToEdge(edgeId: number): Promise<void> {
    this.logger.info(`Initiating connection to edge ${edgeId}`);
    // registerEndpoint已经会触发连接，这里不需要额外操作
    // 只是提供一个显式的API供调用者使用
  }

  /**
   * 接受被动的Edge连接（incoming connection）
   * @param socket 已建立的TLS socket
   * @param edgeId 对端Edge的ID
   */
  acceptIncomingEdgeConnection(socket: import('tls').TLSSocket, edgeId: number): void {
    this.connectionManager.acceptIncomingConnection(socket, edgeId);
  }
  /**
   * 发送语音包到指定Edge (Edge模式)
   */
  async sendVoicePacket(targetEdgeId: number, packet: VoicePacket): Promise<void> {
    try {
      const serialized = this.serializeVoicePacket(packet);
      let data = serialized;
      if (this.encryptionConfig) {
        data = this.encryptVoiceData(serialized);
      }
      
      await this.connectionManager.send(targetEdgeId, data);
      
      this.stats.packetsSent++;
      this.stats.bytesSent += data.length;
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Failed to send voice packet to edge ${targetEdgeId}:`, error);
      throw error;
    }
  }

  /**
   * 发送语音包到特定Edge（Hub模式 - hub-server兼容）
   */
  async sendToEdge(targetEdgeId: number, header: VoicePacketHeader, data: Buffer): Promise<void> {
    const packet: VoicePacket = {
      senderId: header.senderId,
      targetId: header.targetId,
      sequence: header.sequence,
      data,
    };
    
    await this.sendVoicePacket(targetEdgeId, packet);
  }

  /**
   * 广播语音包 - 支持两种模式
   */
  async broadcast(packet: VoicePacket, excludeEdges?: Set<number>): Promise<void>;
  async broadcast(header: VoicePacketHeader, data: Buffer, senderEdgeId: number): Promise<void>;
  async broadcast(
    packetOrHeader: VoicePacket | VoicePacketHeader,
    excludeEdgesOrData?: Set<number> | Buffer,
    senderEdgeId?: number
  ): Promise<void> {
    try {
      let data: Buffer;
      let excludeEdges: Set<number>;
      
      // 判断是哪种调用模式
      if ('data' in packetOrHeader && Buffer.isBuffer((packetOrHeader as VoicePacket).data)) {
        // Edge模式：broadcast(packet, excludeEdges)
        const packet = packetOrHeader as VoicePacket;
        excludeEdges = (excludeEdgesOrData as Set<number>) || new Set();
        
        const serialized = this.serializeVoicePacket(packet);
        data = this.encryptionConfig ? this.encryptVoiceData(serialized) : serialized;
      } else {
        // Hub模式：broadcast(header, data, senderEdgeId)
        const header = packetOrHeader as VoicePacketHeader;
        const rawData = excludeEdgesOrData as Buffer;
        
        const packet: VoicePacket = {
          senderId: header.senderId,
          targetId: header.targetId,
          sequence: header.sequence,
          data: rawData,
        };
        
        const serialized = this.serializeVoicePacket(packet);
        data = this.encryptionConfig ? this.encryptVoiceData(serialized) : serialized;
        excludeEdges = senderEdgeId !== undefined ? new Set([senderEdgeId]) : new Set();
      }
      
      await this.connectionManager.broadcast(data, excludeEdges);
      
      this.stats.packetsSent++;
      this.stats.bytesSent += data.length;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to broadcast voice packet:', error);
      throw error;
    }
  }

  /**
   * 获取连接状态（兼容旧API）
   */
  getConnectionStatus(edgeId: number): ConnectionStatus | undefined {
    return this.connectionManager.getConnectionStatus(edgeId);
  }

  /**
   * 获取所有连接状态
   */
  getAllConnectionStatuses(): Map<number, ConnectionStatus> {
    return this.connectionManager.getAllConnectionStatuses();
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * 获取质量指标（委托给连接层）
   */
  getQualityMetrics(edgeId: number): ConnectionQualityMetrics | undefined {
    return this.connectionManager.getQualityMetrics(edgeId);
  }

  /**
   * 更新加密密钥（Edge模式）
   */
  updateEncryptionKey(key: Buffer, algorithm?: string): void {
    const algo = algorithm || this.encryptionConfig?.algorithm || 'aes-128-cbc';
    this.encryptionConfig = {
      algorithm: algo,
      key,
    };
    // 清除缓存以使用新密钥
    this.encryptedPacketCache.clear();
    this.logger.info(`Encryption key updated (algorithm: ${algo})`);
  }

  /**
   * 获取已注册的Edge ID列表
   */
  getRegisteredEdgeIds(): number[] {
    const statuses = this.connectionManager.getAllConnectionStatuses();
    return Array.from(statuses.keys());
  }

  /**
   * 处理接收到的UDP数据包（由外部UDP监听器调用）
   * 保持向后兼容的私有方法签名
   */
  ['handleIncomingPacket'](data: Buffer, rinfo: dgram.RemoteInfo): void;
  ['handleIncomingPacket'](data: Buffer, host: string, port: number): void;
  ['handleIncomingPacket'](data: Buffer, rinfoOrHost: dgram.RemoteInfo | string, port?: number): void {
    let host: string;
    let portNum: number;
    
    if (typeof rinfoOrHost === 'string') {
      host = rinfoOrHost;
      portNum = port!;
    } else {
      host = rinfoOrHost.address;
      portNum = rinfoOrHost.port;
    }
    
    // 委托给连接管理器处理
    this.connectionManager.handleIncomingUDPPacket(data, host, portNum);
  }

  /**
   * 设置连接管理器事件监听
   */
  private setupConnectionManagerEvents(): void {
    this.connectionManager.on('edge-connected', (edgeId) => {
      this.logger.info(`Edge ${edgeId} connected (transport layer)`);
      this.stats.handshakeReceived++; // 兼容统计
      this.emit('edge-connected', edgeId);
    });

    this.connectionManager.on('edge-disconnected', (edgeId, _reason) => {
      this.emit('edge-disconnected', edgeId);
      
      // 质量监控数据由连接层管理，这里不需要清理
    });

    this.connectionManager.on('edge-error', (edgeId, error) => {
      this.logger.error(`Edge ${edgeId} connection error:`, error);
      this.stats.errors++;
      this.emit('error', error);
    });

    this.connectionManager.on('edge-data', (edgeId, data, timestamp) => {
      this.handleVoiceData(edgeId, data, timestamp);
    });

    this.connectionManager.on('edge-reconnecting', (edgeId, attempt) => {
      this.logger.info(`Edge ${edgeId} reconnecting (attempt ${attempt})`);
      // 可以触发reconnect-failed事件如果需要
    });
  }

  /**
   * 处理接收到的语音数据
   */
  private handleVoiceData(edgeId: number, data: Buffer, _timestamp: number): void {
    try {
      // 解密
      let decrypted = data;
      if (this.encryptionConfig) {
        decrypted = this.decryptVoiceData(data);
      }
      
      // 反序列化
      const packet = this.deserializeVoicePacket(decrypted);
      if (!packet) {
        this.logger.warn(`Failed to deserialize voice packet from edge ${edgeId}`);
        return;
      }
      
      // 更新统计
      this.stats.packetsReceived++;
      this.stats.bytesReceived += data.length;
      
      // 触发事件（保持向后兼容，不提供rinfo）
      this.emit('voice-packet', packet);
    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Error handling voice data from edge ${edgeId}:`, error);
    }
  }

  /**
   * 序列化语音包
   */
  private serializeVoicePacket(packet: VoicePacket): Buffer {
    const headerSize = 4 + 1 + 4 + 4; // senderId:4 + targetId:1 + sequence:4 + dataLength:4
    const buffer = Buffer.allocUnsafe(headerSize + packet.data.length);
    
    let offset = 0;
    buffer.writeUInt32BE(packet.senderId, offset);
    offset += 4;
    buffer.writeUInt8(packet.targetId, offset);
    offset += 1;
    buffer.writeUInt32BE(packet.sequence, offset);
    offset += 4;
    buffer.writeUInt32BE(packet.data.length, offset);
    offset += 4;
    packet.data.copy(buffer, offset);
    
    return buffer;
  }

  /**
   * 反序列化语音包
   */
  private deserializeVoicePacket(buffer: Buffer): VoicePacket | null {
    if (buffer.length < 13) {
      return null;
    }
    
    let offset = 0;
    const senderId = buffer.readUInt32BE(offset);
    offset += 4;
    const targetId = buffer.readUInt8(offset);
    offset += 1;
    const sequence = buffer.readUInt32BE(offset);
    offset += 4;
    const dataLength = buffer.readUInt32BE(offset);
    offset += 4;
    
    if (buffer.length < offset + dataLength) {
      return null;
    }
    
    const data = buffer.slice(offset, offset + dataLength);
    
    return {
      senderId,
      targetId,
      sequence,
      data,
    };
  }

  /**
   * 加密语音数据
   */
  private encryptVoiceData(data: Buffer): Buffer {
    if (!this.encryptionConfig) {
      return data;
    }
    
    // 使用缓存优化
    const cacheKey = data.toString('base64').substring(0, 32); // 限制key长度
    const cached = this.encryptedPacketCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    
    const cipher = crypto.createCipheriv(
      this.encryptionConfig.algorithm,
      this.encryptionConfig.key,
      Buffer.alloc(16) // 简化：固定IV，生产环境应使用随机IV
    );
    
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    
    // 更新缓存
    if (this.encryptedPacketCache.size >= this.CACHE_MAX_SIZE) {
      const firstKey = this.encryptedPacketCache.keys().next().value;
      this.encryptedPacketCache.delete(firstKey);
    }
    this.encryptedPacketCache.set(cacheKey, encrypted);
    
    return encrypted;
  }

  /**
   * 解密语音数据
   */
  private decryptVoiceData(data: Buffer): Buffer {
    if (!this.encryptionConfig) {
      return data;
    }
    
    const decipher = crypto.createDecipheriv(
      this.encryptionConfig.algorithm,
      this.encryptionConfig.key,
      Buffer.alloc(16)
    );
    
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

}
