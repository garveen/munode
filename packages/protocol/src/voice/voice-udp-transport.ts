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
import { 
  VoiceUDPPacket, 
  HandshakeSyn, 
  HandshakeSynAck, 
  HandshakeAck,
  HeartbeatPing,
  HeartbeatPong,
  UDPPacketType 
} from '../generated/proto/VoiceUDP.js';

// Constants
const HANDSHAKE_RETRY_INTERVAL_MS = 2000;
const HANDSHAKE_MAX_ATTEMPTS = 5;
const HEARTBEAT_INTERVAL_MS = 10000; // Heartbeat interval: 10 seconds
const HEARTBEAT_TIMEOUT_MS = 30000; // Connection timeout: 30 seconds without response
const RECONNECT_DELAY_MS = 3000; // Delay before reconnect attempt
const PROTOCOL_VERSION = 1; // UDP voice protocol version
const NONCE_SIZE = 32; // Nonce size in bytes for authentication
const EDGE_UDP_MAGIC = 0x0000; // Magic number to identify Edge-to-Edge UDP packets (2 bytes)

export interface VoiceUDPConfig {
  port: number;
  host?: string;
  encryptionKey?: Buffer;
  encryptionAlgorithm?: string;
  localEdgeId?: number; // Local edge ID for determining active/passive side
  sharedSecret?: Buffer; // Shared secret for HMAC authentication
}

export interface VoicePacketHeader {
  senderId: number;    // 发送方 Edge ID (0-65535)
  targetId: number;    // Mumble target (0=PTT, 1-30=whisper, 31=loopback)
  sequence: number;    // 序列号（用于丢包检测和网络质量统计）
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
  localNonce?: Buffer; // Local nonce for handshake
  remoteNonce?: Buffer; // Remote nonce received during handshake
  heartbeatSequence: number; // Heartbeat sequence number
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
  private config: VoiceUDPConfig;
  private encryptionConfig: VoiceEncryptionConfig | null = null;
  private remoteEndpoints = new Map<number, RemoteEndpoint>(); // edgeId -> endpoint
  private connectionStatus = new Map<number, EdgeConnectionStatus>(); // edgeId -> connection status
  private encryptedPacketCache = new Map<string, Buffer>(); // cacheKey -> encrypted packet
  private logger: Logger;
  private localEdgeId: number;
  private sharedSecret: Buffer | null = null; // Shared secret for HMAC authentication
  private sendFunction: ((buffer: Buffer, host: string, port: number) => void) | null = null; // UDP发送回调函数
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

    // Setup shared secret for HMAC authentication
    if (config.sharedSecret) {
      this.sharedSecret = config.sharedSecret;
    } else {
      this.logger.warn('No shared secret provided for UDP voice transport - handshake authentication disabled');
    }

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
   * 设置UDP发送函数（用于统一入口模式）
   * @param sendFunc 发送函数：(buffer, host, port) => void
   */
  setSendFunction(sendFunc: (buffer: Buffer, host: string, port: number) => void): void {
    this.sendFunction = sendFunc;
    this.logger.info('VoiceUDPTransport using external send function (unified entry mode)');
    // 启动心跳和连接检查
    this.startHeartbeatIfNeeded();
  }

  /**
   * 启动UDP监听（独立端口模式，已废弃）
   * 现在推荐使用 setSendFunction() 配合统一UDP入口
   * @deprecated Use setSendFunction() with unified UDP entry instead
   */
  start(): Promise<void> {
    this.logger.warn('VoiceUDPTransport.start() is deprecated, use setSendFunction() instead');
    return Promise.resolve();
  }

  /**
   * 停止UDP传输（清理定时器和状态）
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
    
    // 清除发送函数引用
    this.sendFunction = null;
  }

  /**
   * 规范化主机名，将 localhost 转换为 127.0.0.1
   * 这确保主机名匹配在接收数据包时能正常工作
   */
  private normalizeHost(host: string): string {
    return host === 'localhost' ? '127.0.0.1' : host;
  }

  /**
   * 注册远程端点并发起握手
   */
  registerEndpoint(edgeId: number, host: string, port: number): void {
    // 规范化主机名以确保匹配
    const normalizedHost = this.normalizeHost(host);
    this.remoteEndpoints.set(edgeId, { host: normalizedHost, port });
    
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
      heartbeatSequence: 0,
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
    
    // 生成本地 nonce
    status.localNonce = crypto.randomBytes(NONCE_SIZE);
    
    // 构造握手包
    const handshakePacket = this.createHandshakeSyn(edgeId, status.localNonce);
    if (!handshakePacket) {
      this.logger.error(`Failed to create handshake SYN for edge ${edgeId}`);
      return;
    }
    
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
   * 创建 HMAC 签名
   */
  private createSignature(data: Buffer): Buffer | null {
    if (!this.sharedSecret) {
      return null;
    }
    const hmac = crypto.createHmac('sha256', this.sharedSecret);
    hmac.update(data);
    return hmac.digest();
  }
  
  /**
   * 验证 HMAC 签名
   */
  private verifySignature(data: Buffer, signature: Buffer): boolean {
    if (!this.sharedSecret) {
      return false;
    }
    const expectedSignature = this.createSignature(data);
    if (!expectedSignature) {
      return false;
    }
    return crypto.timingSafeEqual(signature, expectedSignature);
  }
  
  /**
   * 创建 HandshakeSyn 包
   */
  private createHandshakeSyn(edgeId: number, nonce: Buffer): Buffer | null {
    const timestamp = Date.now();
    
    // 构造待签名数据: edge_id + timestamp + nonce
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([edgeId]).buffer),
      Buffer.from(new BigUint64Array([BigInt(timestamp)]).buffer),
      nonce,
    ]);
    
    const signature = this.createSignature(dataToSign);
    if (!signature) {
      this.logger.error('Failed to create signature for HandshakeSyn');
      return null;
    }
    
    const handshakeSyn: HandshakeSyn = {
      edge_id: edgeId,
      timestamp,
      protocol_version: PROTOCOL_VERSION,
      nonce,
      signature,
    };
    
    const packet: VoiceUDPPacket = {
      type: UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN,
      handshake_syn: handshakeSyn,
    };
    
    const encodedPacket = Buffer.from(VoiceUDPPacket.encode(packet).finish());
    // 添加魔数标识 Edge 间包
    const result = Buffer.allocUnsafe(2 + encodedPacket.length);
    result.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    encodedPacket.copy(result, 2);
    return result;
  }
  
  /**
   * 创建 HandshakeSynAck 包
   */
  private createHandshakeSynAck(edgeId: number, responseNonce: Buffer, localNonce: Buffer): Buffer | null {
    const timestamp = Date.now();
    
    // 构造待签名数据: edge_id + timestamp + response_nonce + nonce
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([edgeId]).buffer),
      Buffer.from(new BigUint64Array([BigInt(timestamp)]).buffer),
      responseNonce,
      localNonce,
    ]);
    
    const signature = this.createSignature(dataToSign);
    if (!signature) {
      this.logger.error('Failed to create signature for HandshakeSynAck');
      return null;
    }
    
    const handshakeSynAck: HandshakeSynAck = {
      edge_id: edgeId,
      timestamp,
      protocol_version: PROTOCOL_VERSION,
      response_nonce: responseNonce,
      nonce: localNonce,
      signature,
    };
    
    const packet: VoiceUDPPacket = {
      type: UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN_ACK,
      handshake_syn_ack: handshakeSynAck,
    };
    
    const encodedPacket = Buffer.from(VoiceUDPPacket.encode(packet).finish());
    // 添加魔数标识 Edge 间包
    const result = Buffer.allocUnsafe(2 + encodedPacket.length);
    result.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    encodedPacket.copy(result, 2);
    return result;
  }
  
  /**
   * 创建 HandshakeAck 包
   */
  private createHandshakeAck(edgeId: number, responseNonce: Buffer): Buffer | null {
    const timestamp = Date.now();
    
    // 构造待签名数据: edge_id + timestamp + response_nonce
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([edgeId]).buffer),
      Buffer.from(new BigUint64Array([BigInt(timestamp)]).buffer),
      responseNonce,
    ]);
    
    const signature = this.createSignature(dataToSign);
    if (!signature) {
      this.logger.error('Failed to create signature for HandshakeAck');
      return null;
    }
    
    const handshakeAck: HandshakeAck = {
      edge_id: edgeId,
      timestamp,
      response_nonce: responseNonce,
      signature,
    };
    
    const packet: VoiceUDPPacket = {
      type: UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_ACK,
      handshake_ack: handshakeAck,
    };
    
    const encodedPacket = Buffer.from(VoiceUDPPacket.encode(packet).finish());
    // 添加魔数标识 Edge 间包
    const result = Buffer.allocUnsafe(2 + encodedPacket.length);
    result.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    encodedPacket.copy(result, 2);
    return result;
  }
  
  /**
   * Create heartbeat packet
   */
  private createHeartbeatPing(edgeId: number, sequence: number): Buffer {
    const timestamp = Date.now();
    
    const heartbeatPing: HeartbeatPing = {
      edge_id: edgeId,
      timestamp,
      sequence,
    };
    
    const packet: VoiceUDPPacket = {
      type: UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PING,
      heartbeat_ping: heartbeatPing,
    };
    
    const encodedPacket = Buffer.from(VoiceUDPPacket.encode(packet).finish());
    // 添加魔数标识 Edge 间包
    const result = Buffer.allocUnsafe(2 + encodedPacket.length);
    result.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    encodedPacket.copy(result, 2);
    return result;
  }
  
  /**
   * Create heartbeat pong packet
   */
  private createHeartbeatPong(edgeId: number, sequence: number): Buffer {
    const timestamp = Date.now();
    
    const heartbeatPong: HeartbeatPong = {
      edge_id: edgeId,
      timestamp,
      sequence,
    };
    
    const packet: VoiceUDPPacket = {
      type: UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PONG,
      heartbeat_pong: heartbeatPong,
    };
    
    const encodedPacket = Buffer.from(VoiceUDPPacket.encode(packet).finish());
    // 添加魔数标识 Edge 间包
    const result = Buffer.allocUnsafe(2 + encodedPacket.length);
    result.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    encodedPacket.copy(result, 2);
    return result;
  }
  
  /**
   * Handle handshake packet
   */
  private handleHandshakePacket(packet: VoiceUDPPacket, rinfo: dgram.RemoteInfo): void {
    // 找到对应的edge（使用规范化的地址进行匹配）
    const normalizedAddress = this.normalizeHost(rinfo.address);
    let edgeId: number | undefined;
    for (const [id, endpoint] of this.remoteEndpoints) {
      if (endpoint.host === normalizedAddress && endpoint.port === rinfo.port) {
        edgeId = id;
        break;
      }
    }
    
    const now = Date.now();
    
    if (packet.type === UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN && packet.handshake_syn) {
      const syn = packet.handshake_syn;
      
      // 验证协议版本
      if (syn.protocol_version !== PROTOCOL_VERSION) {
        this.logger.warn(`Received HandshakeSyn with unsupported protocol version: ${syn.protocol_version}`);
        return;
      }
      
      // 验证签名
      const dataToVerify = Buffer.concat([
        Buffer.from(new Uint32Array([syn.edge_id]).buffer),
        Buffer.from(new BigUint64Array([BigInt(syn.timestamp)]).buffer),
        Buffer.from(syn.nonce),
      ]);
      
      if (!this.verifySignature(dataToVerify, Buffer.from(syn.signature))) {
        this.logger.error(`HandshakeSyn signature verification failed from ${rinfo.address}:${rinfo.port}`);
        return;
      }
      
      // 如果没有预注册的edgeId，使用消息中的edgeId
      if (!edgeId) {
        edgeId = syn.edge_id;
        this.logger.info(`Received HandshakeSyn from unknown endpoint, auto-registering edge ${edgeId}`);
        this.remoteEndpoints.set(edgeId, { host: normalizedAddress, port: rinfo.port });
        
        const isActiveSide = this.localEdgeId < edgeId;
        this.connectionStatus.set(edgeId, {
          edgeId,
          connected: false,
          lastSeen: now,
          handshakeAttempts: 0,
          handshakeComplete: false,
          lastHeartbeatSent: now,
          lastHeartbeatReceived: now,
          reconnecting: false,
          reconnectAttempts: 0,
          isActiveSide,
          heartbeatSequence: 0,
        });
      }
      
      const status = this.connectionStatus.get(edgeId);
      if (!status) return;
      
      status.lastSeen = now;
      status.lastHeartbeatReceived = now;
      status.remoteNonce = Buffer.from(syn.nonce);
      this.stats.handshakeReceived++;
      
      this.logger.debug(`Received HandshakeSyn from edge ${edgeId}`);
      
      // 生成本地 nonce（如果还没有）
      if (!status.localNonce) {
        status.localNonce = crypto.randomBytes(NONCE_SIZE);
      }
      
      // 发送 SYN-ACK
      const synAck = this.createHandshakeSynAck(this.localEdgeId, syn.nonce, status.localNonce);
      if (synAck) {
        this.sendPacket(synAck, rinfo.address, rinfo.port);
        this.stats.handshakeSent++;
        status.handshakeComplete = true;
        status.connected = true;
        status.reconnecting = false;
        status.reconnectAttempts = 0;
        this.logger.info(`UDP handshake complete with edge ${edgeId} (received SYN)`);
        this.emit('edge-connected', edgeId);
      }
    } else if (packet.type === UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN_ACK && packet.handshake_syn_ack) {
      const synAck = packet.handshake_syn_ack;
      
      if (!edgeId) {
        this.logger.warn(`Received HandshakeSynAck from unknown endpoint: ${rinfo.address}:${rinfo.port}`);
        return;
      }
      
      const status = this.connectionStatus.get(edgeId);
      if (!status || !status.localNonce) {
        this.logger.warn(`Received HandshakeSynAck from edge ${edgeId} but no local nonce found`);
        return;
      }
      
      // 验证协议版本
      if (synAck.protocol_version !== PROTOCOL_VERSION) {
        this.logger.warn(`Received HandshakeSynAck with unsupported protocol version: ${synAck.protocol_version}`);
        return;
      }
      
      // 验证响应的nonce是否匹配我们发送的nonce
      const responseNonceBuf = Buffer.from(synAck.response_nonce);
      if (!responseNonceBuf.equals(status.localNonce)) {
        this.logger.error(`HandshakeSynAck response_nonce mismatch from edge ${edgeId}`);
        return;
      }
      
      // 验证签名
      const dataToVerify = Buffer.concat([
        Buffer.from(new Uint32Array([synAck.edge_id]).buffer),
        Buffer.from(new BigUint64Array([BigInt(synAck.timestamp)]).buffer),
        Buffer.from(synAck.response_nonce),
        Buffer.from(synAck.nonce),
      ]);
      
      if (!this.verifySignature(dataToVerify, Buffer.from(synAck.signature))) {
        this.logger.error(`HandshakeSynAck signature verification failed from edge ${edgeId}`);
        return;
      }
      
      status.lastSeen = now;
      status.lastHeartbeatReceived = now;
      status.remoteNonce = Buffer.from(synAck.nonce);
      this.stats.handshakeReceived++;
      
      this.logger.debug(`Received HandshakeSynAck from edge ${edgeId}`);
      
      // 发送 ACK
      const ack = this.createHandshakeAck(this.localEdgeId, synAck.nonce);
      if (ack) {
        this.sendPacket(ack, rinfo.address, rinfo.port);
        this.stats.handshakeSent++;
        status.handshakeComplete = true;
        status.connected = true;
        status.reconnecting = false;
        status.reconnectAttempts = 0;
        this.logger.info(`UDP handshake complete with edge ${edgeId} (received SYN-ACK)`);
        this.emit('edge-connected', edgeId);
      }
    } else if (packet.type === UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_ACK && packet.handshake_ack) {
      const ack = packet.handshake_ack;
      
      if (!edgeId) {
        this.logger.warn(`Received HandshakeAck from unknown endpoint: ${rinfo.address}:${rinfo.port}`);
        return;
      }
      
      const status = this.connectionStatus.get(edgeId);
      if (!status || !status.localNonce) {
        this.logger.warn(`Received HandshakeAck from edge ${edgeId} but no local nonce found`);
        return;
      }
      
      // 验证响应的nonce是否匹配我们发送的nonce
      const responseNonceBuf = Buffer.from(ack.response_nonce);
      if (!responseNonceBuf.equals(status.localNonce)) {
        this.logger.error(`HandshakeAck response_nonce mismatch from edge ${edgeId}`);
        return;
      }
      
      // 验证签名
      const dataToVerify = Buffer.concat([
        Buffer.from(new Uint32Array([ack.edge_id]).buffer),
        Buffer.from(new BigUint64Array([BigInt(ack.timestamp)]).buffer),
        Buffer.from(ack.response_nonce),
      ]);
      
      if (!this.verifySignature(dataToVerify, Buffer.from(ack.signature))) {
        this.logger.error(`HandshakeAck signature verification failed from edge ${edgeId}`);
        return;
      }
      
      status.lastSeen = now;
      status.lastHeartbeatReceived = now;
      this.stats.handshakeReceived++;
      
      this.logger.debug(`Received HandshakeAck from edge ${edgeId}`);
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
  private handleHeartbeatPacket(packet: VoiceUDPPacket, rinfo: dgram.RemoteInfo): void {
    // 找到对应的edge（使用规范化的地址进行匹配）
    const normalizedAddress = this.normalizeHost(rinfo.address);
    let edgeId: number | undefined;
    for (const [id, endpoint] of this.remoteEndpoints) {
      if (endpoint.host === normalizedAddress && endpoint.port === rinfo.port) {
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
    
    if (packet.type === UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PING && packet.heartbeat_ping) {
      const ping = packet.heartbeat_ping;
      this.logger.debug(`Received heartbeat PING from edge ${edgeId}, sequence: ${ping.sequence}`);
      // 回复 PONG
      const pong = this.createHeartbeatPong(this.localEdgeId, ping.sequence);
      this.sendPacket(pong, rinfo.address, rinfo.port);
      this.stats.heartbeatsReceived++;
    } else if (packet.type === UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PONG && packet.heartbeat_pong) {
      const pong = packet.heartbeat_pong;
      this.logger.debug(`Received heartbeat PONG from edge ${edgeId}, sequence: ${pong.sequence}`);
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
          status.heartbeatSequence++;
          const ping = this.createHeartbeatPing(this.localEdgeId, status.heartbeatSequence);
          this.sendPacket(ping, endpoint.host, endpoint.port);
          status.lastHeartbeatSent = now;
          this.stats.heartbeatsSent++;
          this.logger.debug(`Sent heartbeat PING to edge ${edgeId} (active side), sequence: ${status.heartbeatSequence}`);
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
    
    // 重新生成 nonce 进行握手
    status.localNonce = crypto.randomBytes(NONCE_SIZE);
    
    // 重新发起握手
    const handshakePacket = this.createHandshakeSyn(edgeId, status.localNonce);
    if (handshakePacket) {
      this.sendPacket(handshakePacket, endpoint.host, endpoint.port);
      this.stats.handshakeSent++;
    }
    
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

    // 编码明文包头 + 数据（12字节header）
    const plainBuffer = this.getBuffer(12 + packet.data.length);
    plainBuffer.writeUInt32BE(packet.senderId, 0);
    plainBuffer.writeUInt32BE(packet.targetId, 4);
    plainBuffer.writeUInt32BE(packet.sequence, 8);
    packet.data.copy(plainBuffer, 12);

    // 生成随机IV (16字节 for CBC)
    const iv = crypto.randomBytes(16);

    // Note: Cipher instances cannot be persisted because each encryption requires a unique IV for security
    const cipher = crypto.createCipheriv(this.encryptionConfig.algorithm, this.encryptionConfig.key, iv);

    // 加密整个包
    const encryptedData = Buffer.concat([
      cipher.update(plainBuffer),
      cipher.final()
    ]);

    // 返回格式: Magic(2) + IV(16) + 加密数据
    const magicBuffer = Buffer.allocUnsafe(2);
    magicBuffer.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    return Buffer.concat([magicBuffer, iv, encryptedData]);
  }

  /**
   * 解码加密语音包（包含解密）
   * 注意：传入的buffer已经移除了魔数
   */
  private decodeEncryptedPacket(buffer: Buffer): VoicePacket | null {
    if (!this.encryptionConfig) {
      throw new Error('Encryption not configured');
    }

    if (buffer.length < 16 + 12) return null; // IV + 最小包头（12字节）

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

      // 验证解密后的数据长度（12字节header）
      if (decryptedData.length < 12) return null;

      // 解析包头
      return {
        senderId: decryptedData.readUInt32BE(0),
        targetId: decryptedData.readUInt32BE(4),
        sequence: decryptedData.readUInt32BE(8),
        data: decryptedData.slice(12),
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

    // 检查握手状态 - 只发送给已完成握手的Edge
    const status = this.connectionStatus.get(edgeId);
    if (status && !status.handshakeComplete) {
      this.logger.debug(`Cannot send to edge ${edgeId} - handshake not complete`);
      return;
    }

    // 加密（如果启用）
    let finalPacket: Buffer;
    if (this.encryptionConfig) {
      // 加密模式：encodePacket 会自动添加 header，所以直接传递 voiceData
      finalPacket = this.encodePacket({
        ...packet,
        data: voiceData,
      });
    } else {
      // 未加密模式：需要手动添加 header
      const headerBuffer = this.encodePacketHeader(packet);
      finalPacket = Buffer.concat([headerBuffer, voiceData]);
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
    // 编码包头（自定义12字节header，用于Edge间通信）
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
        `seq=${packet.sequence}, total_size=${finalPacket.length}`
      );
    }
  }

  /**
   * 处理收到的语音包
   */
  private handleIncomingPacket(data: Buffer, rinfo: dgram.RemoteInfo): void {
    this.stats.packetsReceived++;
    this.stats.bytesReceived += data.length;

    // 验证并移除魔数（所有 Edge 间包前两字节都是 0x0000）
    if (data.length < 2 || data.readUInt16BE(0) !== EDGE_UDP_MAGIC) {
      this.logger.warn('Received packet without Edge magic number, ignoring');
      this.stats.errors++;
      return;
    }
    
    // 移除魔数，获取实际数据
    const actualData = data.slice(2);

    try {
      // 尝试解析为protobuf控制消息
      try {
        const packet = VoiceUDPPacket.decode(actualData);
        
        // 处理握手消息
        if (packet.type === UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN ||
            packet.type === UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN_ACK ||
            packet.type === UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_ACK) {
          this.handleHandshakePacket(packet, rinfo);
          return;
        }
        
        // 处理心跳消息
        if (packet.type === UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PING ||
            packet.type === UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PONG) {
          this.handleHeartbeatPacket(packet, rinfo);
          return;
        }
        
        // 注意：语音数据不使用 protobuf 格式
        // 语音包使用自定义的 14 字节 header + Mumble 数据格式
        // 这样设计是为了最小化开销，提高实时性能
      } catch (_parseError) {
        // 不是protobuf格式，继续处理为语音数据
      }
      
      // 解密（如果启用）
      if (this.encryptionConfig) {
        const decrypted = this.decodeEncryptedPacket(actualData);
        if (!decrypted) {
          this.logger.warn('Failed to decrypt voice packet');
          this.stats.errors++;
          return;
        }
        
        // 直接使用解密后的数据构建 VoicePacket
        // 不需要重新编码和解码
        const packet: VoicePacket = {
          senderId: decrypted.senderId,
          targetId: decrypted.targetId,
          sequence: decrypted.sequence,
          data: decrypted.data, // 已经是去除了 header 的 Mumble 包
        };

        // 发出事件
        this.emit('voice-packet', packet, rinfo);
      } else {
        // 未加密的情况，需要解析
        const decoded = this.decodePacket(actualData);
        if (!decoded) {
          this.logger.warn('Failed to parse voice packet');
          this.stats.errors++;
          return;
        }

        const packet: VoicePacket = {
          senderId: decoded.header.senderId,
          targetId: decoded.header.targetId,
          sequence: decoded.header.sequence,
          data: decoded.voiceData,
        };

        // 发出事件
        this.emit('voice-packet', packet, rinfo);
      }
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Error handling incoming voice packet:', error);
    }
  }

  /**
   * 编码包头（2字节魔数 + 12字节header）
   * 
   * 格式：
   * - magic (2 bytes): 0x0000 魔数标识
   * - senderId (4 bytes): 发送方 Edge ID
   * - targetId (4 bytes): Mumble target
   * - sequence (4 bytes): 序列号
   */
  private encodePacketHeader(packet: VoicePacketHeader): Buffer {
    const buffer = Buffer.allocUnsafe(14); // 2 + 12
    buffer.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    buffer.writeUInt32BE(packet.senderId, 2);
    buffer.writeUInt32BE(packet.targetId, 6);
    buffer.writeUInt32BE(packet.sequence, 10);
    return buffer;
  }

  /**
   * 解码语音包（注意：传入的data已经移除了魔数）
   */
  private decodePacket(data: Buffer): {
    header: VoicePacketHeader;
    voiceData: Buffer;
  } | null {
    if (data.length < 12) {
      return null;
    }

    const header: VoicePacketHeader = {
      senderId: data.readUInt32BE(0),
      targetId: data.readUInt32BE(4),
      sequence: data.readUInt32BE(8),
    };

    const voiceData = data.slice(12);

    return { header, voiceData };
  }

  /**
   * 发送UDP包（通过回调函数）
   */
  private sendPacket(data: Buffer, host: string, port: number): void {
    if (!this.sendFunction) {
      this.logger.warn('UDP send function not set, call setSendFunction() first');
      return;
    }

    try {
      this.sendFunction(data, host, port);
      this.stats.packetsSent++;
      this.stats.bytesSent += data.length;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Error sending voice packet:', error);
    }
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
    return this.sendFunction !== null;
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
