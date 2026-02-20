/**
 * UDP Edge连接实现
 * 
 * 实现基于UDP的Edge间连接，包含握手和心跳机制
 */

import crypto from 'crypto';
import type { Logger } from '@munode/common';
import { TypedEventEmitter } from '@munode/common';
import type { IEdgeConnection, EdgeConnectionEvents } from './edge-connection-interface.js';
import type { ConnectionStatus, ConnectionConfig, ConnectionQualityMetrics } from './connection-types.js';
import { ConnectionState, ConnectionType } from './connection-types.js';
import {
  VoiceUDPPacket,
  HandshakeSyn,
  HandshakeSynAck,
  HandshakeAck,
  HeartbeatPing,
  HeartbeatPong,
  UDPPacketType,
} from '../generated/proto/VoiceUDP.js';

// 常量定义
const HANDSHAKE_RETRY_INTERVAL_MS = 2000;
const HANDSHAKE_MAX_ATTEMPTS = 5;
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const PROTOCOL_VERSION = 1;
const NONCE_SIZE = 32;
const EDGE_UDP_MAGIC = 0x0000;

/**
 * UDP发送函数类型
 */
type UDPSendFunction = (buffer: Buffer, host: string, port: number) => void;

/**
 * 握手状态
 */
interface HandshakeState {
  localNonce?: Buffer;
  remoteNonce?: Buffer;
  attempts: number;
  complete: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * 心跳状态
 */
interface HeartbeatState {
  lastSent: number;
  lastReceived: number;
  timer?: NodeJS.Timeout;
  isActiveSide: boolean; // 主动方发送心跳
  unifiedSequence: number; // 统一序列号
  sentTime: Map<number, number>; // sequence -> timestamp for RTT
}

/**
 * 质量监控状态
 */
interface QualityTrackingState {
  rttSamples: number[]; // RTT样本
  maxRttSamples: number; // 最大样本数
  receivedSequences: Set<number>; // 接收到的序列号
  maxWindowSize: number; // 滑动窗口大小
  lastRtt: number;
  lastPacketLoss: number;
  lastJitter: number;
  bandwidthStart: number;
  bandwidthBytesIn: number;
  bandwidthBytesOut: number;
}

/**
 * UDP Edge连接实现
 */
export class UDPEdgeConnection extends TypedEventEmitter<EdgeConnectionEvents> implements IEdgeConnection {
  readonly edgeId: number;
  readonly type = 'udp' as const;
  
  private config: ConnectionConfig;
  private logger: Logger;
  private sendFunction: UDPSendFunction;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private handshakeState: HandshakeState;
  private heartbeatState: HeartbeatState;
  private qualityTracking: QualityTrackingState;
  private stats = {
    packetsSent: 0,
    packetsReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    errors: 0,
    lastActive: 0,
  };
  private connectedAt?: number;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false; // 标记是否已被外部显式关闭，防止关闭后仍触发重连

  constructor(
    config: ConnectionConfig,
    sendFunction: UDPSendFunction,
    logger: Logger
  ) {
    super();
    this.edgeId = config.remoteEdgeId;
    this.config = config;
    this.sendFunction = sendFunction;
    this.logger = logger;

    // 初始化握手状态
    this.handshakeState = {
      attempts: 0,
      complete: false,
    };

    // 初始化心跳状态
    const isActiveSide = config.localEdgeId < config.remoteEdgeId;
    const now = Date.now();
    this.heartbeatState = {
      lastSent: now,
      lastReceived: now,
      isActiveSide,
      unifiedSequence: 0,
      sentTime: new Map(),
    };

    // 初始化质量监控
    this.qualityTracking = {
      rttSamples: [],
      maxRttSamples: 10,
      receivedSequences: new Set(),
      maxWindowSize: 100,
      lastRtt: 0,
      lastPacketLoss: 0,
      lastJitter: 0,
      bandwidthStart: now,
      bandwidthBytesIn: 0,
      bandwidthBytesOut: 0,
    };
  }

  get isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED;
  }

  /**
   * 建立连接（发起握手）
   */
  async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
      return;
    }

    this.state = ConnectionState.CONNECTING;
    this.logger.info(
      `Connecting to edge ${this.edgeId} at ${this.config.host}:${this.config.port} ` +
      `(role: ${this.heartbeatState.isActiveSide ? 'active' : 'passive'})`
    );

    await this.initiateHandshake();
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.closed = true;
    this.state = ConnectionState.DISCONNECTED;
    this.stopTimers();
    this.emit('disconnected', 'closed by user');
    this.logger.info(`Connection to edge ${this.edgeId} closed`);
  }

  /**
   * 发送数据（raw data，不包含连接协议）
   */
  async send(data: Buffer): Promise<void> {
    if (!this.isConnected) {
      throw new Error(`Cannot send data: connection to edge ${this.edgeId} is not established`);
    }

    // 添加魔数前缀
    const packet = Buffer.allocUnsafe(2 + data.length);
    packet.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    data.copy(packet, 2);

    this.sendFunction(packet, this.config.host, this.config.port);
    this.stats.packetsSent++;
    this.stats.bytesSent += packet.length;
    this.qualityTracking.bandwidthBytesOut += packet.length;
    this.updateLastSeen();
  }

  /**
   * 获取连接状态
   */
  getStatus(): ConnectionStatus {
    return {
      edgeId: this.edgeId,
      state: this.state,
      type: ConnectionType.UDP,
      isConnected: this.isConnected,
      lastSeen: this.stats.lastActive,
      connectedAt: this.connectedAt,
      stats: { ...this.stats },
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * 更新最后活跃时间
   */
  updateLastSeen(): void {
    this.stats.lastActive = Date.now();
  }

  /**
   * 处理接收到的原始数据包（包含魔数）
   */
  handleIncomingPacket(data: Buffer): void {
    // 验证魔数
    if (data.length < 2 || data.readUInt16BE(0) !== EDGE_UDP_MAGIC) {
      this.logger.warn(`Invalid magic number in packet from edge ${this.edgeId}`);
      return;
    }

    // 去除魔数
    const payload = data.slice(2);

    // 尝试解析为协议包
    let packet: VoiceUDPPacket;
    try {
      packet = VoiceUDPPacket.decode(payload);
    } catch (_error) {
      // 不是协议包，可能是数据包
      this.handleDataPacket(payload);
      return;
    }

    // 处理协议包
    this.handleProtocolPacket(packet);
  }

  /**
   * 处理协议包
   */
  private handleProtocolPacket(packet: VoiceUDPPacket): void {
    this.updateLastSeen();
    this.stats.packetsReceived++;

    switch (packet.type) {
      case UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN:
        if (packet.handshake_syn) {
          this.handleHandshakeSyn(packet.handshake_syn);
        }
        break;

      case UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN_ACK:
        if (packet.handshake_syn_ack) {
          this.handleHandshakeSynAck(packet.handshake_syn_ack);
        }
        break;

      case UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_ACK:
        if (packet.handshake_ack) {
          this.handleHandshakeAck(packet.handshake_ack);
        }
        break;

      case UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PING:
        if (packet.heartbeat_ping) {
          this.handleHeartbeatPing(packet.heartbeat_ping);
        }
        break;

      case UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PONG:
        if (packet.heartbeat_pong) {
          this.handleHeartbeatPong(packet.heartbeat_pong);
        }
        break;

      default:
        this.logger.warn(`Unknown packet type: ${packet.type}`);
    }
  }

  /**
   * 处理数据包
   */
  private handleDataPacket(data: Buffer): void {
    if (!this.isConnected) {
      this.logger.debug(`Received data packet from edge ${this.edgeId} but not connected yet, ignoring`);
      return;
    }

    this.updateLastSeen();
    this.stats.packetsReceived++;
    this.stats.bytesReceived += data.length;
    this.qualityTracking.bandwidthBytesIn += data.length;
    this.emit('data', data, Date.now());
  }

  /**
   * 发起握手
   */
  private async initiateHandshake(): Promise<void> {
    if (this.handshakeState.complete) {
      return;
    }

    // 生成本地nonce
    this.handshakeState.localNonce = crypto.randomBytes(NONCE_SIZE);

    const packet = this.createHandshakeSyn(this.handshakeState.localNonce);
    if (!packet) {
      this.logger.error(`Failed to create handshake SYN for edge ${this.edgeId}`);
      this.emit('error', new Error('Failed to create handshake SYN'));
      return;
    }

    this.sendFunction(packet, this.config.host, this.config.port);
    this.handshakeState.attempts++;
    this.logger.debug(`Sent handshake SYN to edge ${this.edgeId} (attempt ${this.handshakeState.attempts})`);

    // 设置超时重试
    this.handshakeState.timer = setTimeout(() => {
      if (!this.handshakeState.complete && this.handshakeState.attempts < HANDSHAKE_MAX_ATTEMPTS) {
        void this.initiateHandshake();
      } else if (!this.handshakeState.complete) {
        this.logger.error(`Handshake with edge ${this.edgeId} failed after ${HANDSHAKE_MAX_ATTEMPTS} attempts`);
        this.state = ConnectionState.FAILED;
        this.emit('error', new Error('Handshake failed'));
        this.scheduleReconnect();
      }
    }, HANDSHAKE_RETRY_INTERVAL_MS);
  }

  /**
   * 处理HandshakeSyn
   */
  private handleHandshakeSyn(syn: HandshakeSyn): void {
    this.logger.debug(`Received handshake SYN from edge ${this.edgeId}`);

    // 验证签名
    if (!this.verifyHandshakeSyn(syn)) {
      this.logger.warn(`Invalid handshake SYN signature from edge ${this.edgeId}`);
      return;
    }

    // 保存远程nonce
    this.handshakeState.remoteNonce = syn.nonce;

    // 生成本地nonce（如果还没有）
    if (!this.handshakeState.localNonce) {
      this.handshakeState.localNonce = crypto.randomBytes(NONCE_SIZE);
    }

    // 发送SYN-ACK
    const packet = this.createHandshakeSynAck(syn.nonce, this.handshakeState.localNonce);
    if (packet) {
      this.sendFunction(packet, this.config.host, this.config.port);
      this.logger.debug(`Sent handshake SYN-ACK to edge ${this.edgeId}`);
    }
  }

  /**
   * 处理HandshakeSynAck
   */
  private handleHandshakeSynAck(synAck: HandshakeSynAck): void {
    this.logger.debug(`Received handshake SYN-ACK from edge ${this.edgeId}`);

    // 验证签名
    if (!this.verifyHandshakeSynAck(synAck)) {
      this.logger.warn(`Invalid handshake SYN-ACK signature from edge ${this.edgeId}`);
      return;
    }

    // 保存远程nonce
    this.handshakeState.remoteNonce = synAck.nonce;

    // 发送ACK
    const packet = this.createHandshakeAck(synAck.nonce);
    if (packet) {
      this.sendFunction(packet, this.config.host, this.config.port);
      this.logger.debug(`Sent handshake ACK to edge ${this.edgeId}`);
      
      // 握手完成
      this.completeHandshake();
    }
  }

  /**
   * 处理HandshakeAck
   */
  private handleHandshakeAck(ack: HandshakeAck): void {
    this.logger.debug(`Received handshake ACK from edge ${this.edgeId}`);

    // 验证签名
    if (!this.verifyHandshakeAck(ack)) {
      this.logger.warn(`Invalid handshake ACK signature from edge ${this.edgeId}`);
      return;
    }

    // 握手完成
    this.completeHandshake();
  }

  /**
   * 完成握手
   */
  private completeHandshake(): void {
    if (this.handshakeState.complete) {
      return;
    }

    this.handshakeState.complete = true;
    this.state = ConnectionState.CONNECTED;
    this.connectedAt = Date.now();
    this.reconnectAttempts = 0;

    // 停止握手定时器
    if (this.handshakeState.timer) {
      clearTimeout(this.handshakeState.timer);
      this.handshakeState.timer = undefined;
    }

    this.logger.info(`Handshake with edge ${this.edgeId} completed successfully`);
    this.emit('connected');

    // 启动心跳（仅主动方）
    if (this.heartbeatState.isActiveSide) {
      this.startHeartbeat();
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    if (this.heartbeatState.timer) {
      return;
    }

    this.heartbeatState.timer = setInterval(() => {
      this.sendHeartbeat();
      this.checkHeartbeatTimeout();
    }, HEARTBEAT_INTERVAL_MS);

    this.logger.debug(`Heartbeat started for edge ${this.edgeId} (active side)`);
  }

  /**
   * 发送心跳
   */
  private sendHeartbeat(): void {
    const sequence = ++this.heartbeatState.unifiedSequence;
    const timestamp = Date.now();

    const packet = this.createHeartbeatPing(sequence, timestamp);
    if (packet) {
      this.sendFunction(packet, this.config.host, this.config.port);
      this.heartbeatState.lastSent = timestamp;
      this.heartbeatState.sentTime.set(sequence, timestamp);
      
      // 清理旧的时间戳
      if (this.heartbeatState.sentTime.size > 100) {
        const oldestSeq = Math.min(...this.heartbeatState.sentTime.keys());
        this.heartbeatState.sentTime.delete(oldestSeq);
      }
    }
  }

  /**
   * 处理心跳Ping
   */
  private handleHeartbeatPing(ping: HeartbeatPing): void {
    this.logger.debug(`Received heartbeat ping from edge ${this.edgeId}, sequence: ${ping.sequence}`);
    this.heartbeatState.lastReceived = Date.now();

    // 发送Pong
    const packet = this.createHeartbeatPong(ping.sequence, ping.timestamp);
    if (packet) {
      this.sendFunction(packet, this.config.host, this.config.port);
    }
  }

  /**
   * 处理心跳Pong
   */
  private handleHeartbeatPong(pong: HeartbeatPong): void {
    this.logger.debug(`Received heartbeat pong from edge ${this.edgeId}, sequence: ${pong.sequence}`);
    this.heartbeatState.lastReceived = Date.now();

    // 计算RTT并更新质量指标
    const sentTime = this.heartbeatState.sentTime.get(pong.sequence);
    if (sentTime) {
      const rtt = Date.now() - sentTime;
      this.logger.debug(`RTT to edge ${this.edgeId}: ${rtt}ms`);
      this.heartbeatState.sentTime.delete(pong.sequence);
      
      // 更新质量追踪
      this.updateQualityMetrics(rtt, pong.sequence);
    }
  }

  /**
   * 更新质量指标
   */
  private updateQualityMetrics(rtt: number, sequence: number): void {
    const tracking = this.qualityTracking;
    
    // 记录序列号用于丢包率计算
    tracking.receivedSequences.add(sequence);
    if (tracking.receivedSequences.size > tracking.maxWindowSize) {
      const sorted = Array.from(tracking.receivedSequences).sort((a, b) => a - b);
      const toRemove = sorted.slice(0, tracking.receivedSequences.size - tracking.maxWindowSize);
      toRemove.forEach(seq => tracking.receivedSequences.delete(seq));
    }
    
    // 计算丢包率
    const packetLoss = this.calculatePacketLoss();
    tracking.lastPacketLoss = packetLoss;
    
    // 更新RTT样本
    tracking.rttSamples.push(rtt);
    if (tracking.rttSamples.length > tracking.maxRttSamples) {
      tracking.rttSamples.shift();
    }
    tracking.lastRtt = rtt;
    
    // 计算抖动
    if (tracking.rttSamples.length >= 2) {
      let totalDiff = 0;
      for (let i = 1; i < tracking.rttSamples.length; i++) {
        totalDiff += Math.abs(tracking.rttSamples[i] - tracking.rttSamples[i - 1]);
      }
      tracking.lastJitter = totalDiff / (tracking.rttSamples.length - 1);
    }
  }

  /**
   * 计算丢包率
   */
  private calculatePacketLoss(): number {
    const sequences = this.qualityTracking.receivedSequences;
    if (sequences.size < 2) {
      return 0;
    }
    
    const sorted = Array.from(sequences).sort((a, b) => a - b);
    let gaps = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1] - 1;
      if (gap > 0) {
        gaps += gap;
      }
    }
    
    const totalExpected = sequences.size + gaps;
    return totalExpected > 0 ? gaps / totalExpected : 0;
  }

  /**
   * 获取连接质量指标
   */
  getQualityMetrics(): ConnectionQualityMetrics {
    const tracking = this.qualityTracking;
    const now = Date.now();
    const elapsedSec = (now - tracking.bandwidthStart) / 1000;
    
    return {
      edgeId: this.edgeId,
      rtt: tracking.lastRtt,
      packetLoss: tracking.lastPacketLoss,
      jitter: tracking.lastJitter,
      lastUpdate: now,
      samples: tracking.rttSamples.length,
      bandwidth: {
        upload: elapsedSec > 0 ? tracking.bandwidthBytesOut / elapsedSec : 0,
        download: elapsedSec > 0 ? tracking.bandwidthBytesIn / elapsedSec : 0,
      },
    };
  }

  /**
   * 检查心跳超时
   */
  private checkHeartbeatTimeout(): void {
    const now = Date.now();
    if (now - this.heartbeatState.lastReceived > HEARTBEAT_TIMEOUT_MS) {
      this.logger.warn(`Heartbeat timeout for edge ${this.edgeId}`);
      this.handleDisconnect('heartbeat timeout');
    }
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(reason: string): void {
    if (this.state === ConnectionState.DISCONNECTED || 
        this.state === ConnectionState.RECONNECTING || 
        this.state === ConnectionState.FAILED) {
      this.logger.debug(`Already handling disconnect for edge ${this.edgeId}, state: ${this.state}`);
      return;
    }

    this.state = ConnectionState.DISCONNECTED;
    this.handshakeState.complete = false;
    this.stopTimers();

    this.logger.warn(`Connection to edge ${this.edgeId} lost: ${reason}`);
    this.emit('disconnected', reason);

    this.scheduleReconnect();
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    // 如果连接已被外部显式关闭，不再重连
    if (this.closed) {
      this.logger.debug(`Connection to edge ${this.edgeId} was explicitly closed, skipping reconnect`);
      return;
    }
    
    // 如果已经在重连中，不要重复调度
    if (this.reconnectTimer) {
      this.logger.debug(`Reconnect already scheduled for edge ${this.edgeId}`);
      return;
    }
    
    const maxAttempts = this.config.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempts >= maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for edge ${this.edgeId}`);
      this.state = ConnectionState.FAILED;
      return;
    }

    const delay = this.config.reconnectDelay ?? 3000;
    this.reconnectAttempts++;
    this.state = ConnectionState.RECONNECTING;

    this.logger.info(`Scheduling reconnect to edge ${this.edgeId} in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  /**
   * 停止所有定时器
   */
  private stopTimers(): void {
    if (this.handshakeState.timer) {
      clearTimeout(this.handshakeState.timer);
      this.handshakeState.timer = undefined;
    }

    if (this.heartbeatState.timer) {
      clearInterval(this.heartbeatState.timer);
      this.heartbeatState.timer = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  // ===== 协议包创建方法 =====

  private createHandshakeSyn(nonce: Buffer): Buffer | null {
    const timestamp = Date.now();
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([this.config.localEdgeId]).buffer),
      Buffer.from(new BigUint64Array([BigInt(timestamp)]).buffer),
      nonce,
    ]);

    const signature = this.createSignature(dataToSign);
    if (!signature) return null;

    const handshakeSyn: HandshakeSyn = {
      edge_id: this.config.localEdgeId,
      timestamp,
      protocol_version: PROTOCOL_VERSION,
      nonce,
      signature,
    };

    return this.encodePacket({
      type: UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN,
      handshake_syn: handshakeSyn,
    });
  }

  private createHandshakeSynAck(responseNonce: Buffer, localNonce: Buffer): Buffer | null {
    const timestamp = Date.now();
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([this.config.localEdgeId]).buffer),
      Buffer.from(new BigUint64Array([BigInt(timestamp)]).buffer),
      responseNonce,
      localNonce,
    ]);

    const signature = this.createSignature(dataToSign);
    if (!signature) return null;

    const handshakeSynAck: HandshakeSynAck = {
      edge_id: this.config.localEdgeId,
      timestamp,
      protocol_version: PROTOCOL_VERSION,
      response_nonce: responseNonce,
      nonce: localNonce,
      signature,
    };

    return this.encodePacket({
      type: UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_SYN_ACK,
      handshake_syn_ack: handshakeSynAck,
    });
  }

  private createHandshakeAck(responseNonce: Buffer): Buffer | null {
    const timestamp = Date.now();
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([this.config.localEdgeId]).buffer),
      Buffer.from(new BigUint64Array([BigInt(timestamp)]).buffer),
      responseNonce,
    ]);

    const signature = this.createSignature(dataToSign);
    if (!signature) return null;

    const handshakeAck: HandshakeAck = {
      edge_id: this.config.localEdgeId,
      timestamp,
      response_nonce: responseNonce,
      signature,
    };

    return this.encodePacket({
      type: UDPPacketType.UDP_PACKET_TYPE_HANDSHAKE_ACK,
      handshake_ack: handshakeAck,
    });
  }

  private createHeartbeatPing(sequence: number, timestamp: number): Buffer | null {
    const heartbeatPing: HeartbeatPing = {
      edge_id: this.config.localEdgeId,
      sequence,
      timestamp,
    };

    return this.encodePacket({
      type: UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PING,
      heartbeat_ping: heartbeatPing,
    });
  }

  private createHeartbeatPong(sequence: number, _requestTimestamp: number): Buffer | null {
    const heartbeatPong: HeartbeatPong = {
      edge_id: this.config.localEdgeId,
      sequence,
      timestamp: Date.now(),
    };

    return this.encodePacket({
      type: UDPPacketType.UDP_PACKET_TYPE_HEARTBEAT_PONG,
      heartbeat_pong: heartbeatPong,
    });
  }

  private encodePacket(packet: VoiceUDPPacket): Buffer {
    const encodedPacket = Buffer.from(VoiceUDPPacket.encode(packet).finish());
    const result = Buffer.allocUnsafe(2 + encodedPacket.length);
    result.writeUInt16BE(EDGE_UDP_MAGIC, 0);
    encodedPacket.copy(result, 2);
    return result;
  }

  // ===== 签名验证方法 =====

  private createSignature(data: Buffer): Buffer | null {
    if (!this.config.sharedSecret) return null;
    const hmac = crypto.createHmac('sha256', this.config.sharedSecret);
    hmac.update(data);
    return hmac.digest();
  }

  private verifySignature(data: Buffer, signature: Buffer): boolean {
    const expected = this.createSignature(data);
    if (!expected) return false;
    return crypto.timingSafeEqual(signature, expected);
  }

  private verifyHandshakeSyn(syn: HandshakeSyn): boolean {
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([syn.edge_id]).buffer),
      Buffer.from(new BigUint64Array([BigInt(syn.timestamp)]).buffer),
      syn.nonce,
    ]);
    return this.verifySignature(dataToSign, syn.signature);
  }

  private verifyHandshakeSynAck(synAck: HandshakeSynAck): boolean {
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([synAck.edge_id]).buffer),
      Buffer.from(new BigUint64Array([BigInt(synAck.timestamp)]).buffer),
      synAck.response_nonce,
      synAck.nonce,
    ]);
    return this.verifySignature(dataToSign, synAck.signature);
  }

  private verifyHandshakeAck(ack: HandshakeAck): boolean {
    const dataToSign = Buffer.concat([
      Buffer.from(new Uint32Array([ack.edge_id]).buffer),
      Buffer.from(new BigUint64Array([BigInt(ack.timestamp)]).buffer),
      ack.response_nonce,
    ]);
    return this.verifySignature(dataToSign, ack.signature);
  }
}
