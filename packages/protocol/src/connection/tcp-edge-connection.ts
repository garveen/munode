/**
 * TCP Edge连接实现
 * 
 * 实现基于TCP/TLS的Edge间连接，提供可靠的数据传输
 */

import tls from 'tls';
import type { TLSSocket } from 'tls';
import type { Logger } from '@munode/common';
import { TypedEventEmitter } from '@munode/common';
import type { IEdgeConnection, EdgeConnectionEvents } from './edge-connection-interface.js';
import type { ConnectionStatus, ConnectionConfig, ConnectionQualityMetrics } from './connection-types.js';
import { ConnectionState, ConnectionType } from './connection-types.js';

// 常量定义
const HEARTBEAT_INTERVAL_MS = 15000; // TCP心跳间隔：15秒
const HEARTBEAT_TIMEOUT_MS = 45000; // TCP超时：45秒
const CONNECT_TIMEOUT_MS = 10000; // 连接超时：10秒
const MESSAGE_HEADER_SIZE = 4; // 消息长度前缀：4字节

/**
 * 心跳消息类型
 */
enum MessageType {
  HEARTBEAT_PING = 1,
  HEARTBEAT_PONG = 2,
  DATA = 3,
}

/**
 * 消息格式
 */
interface Message {
  type: MessageType;
  sequence?: number;
  timestamp?: number;
  data?: Buffer;
}

/**
 * 心跳状态
 */
interface HeartbeatState {
  lastSent: number;
  lastReceived: number;
  timer?: NodeJS.Timeout;
  sequence: number;
  sentTime: Map<number, number>; // sequence -> timestamp for RTT
}

/**
 * 质量监控状态
 */
interface QualityTrackingState {
  rttSamples: number[];
  maxRttSamples: number;
  lastRtt: number;
  bandwidthStart: number;
  bandwidthBytesIn: number;
  bandwidthBytesOut: number;
}

/**
 * 接收缓冲区状态
 */
interface ReceiveBufferState {
  buffer: Buffer;
  expectedLength: number;
}

/**
 * TCP Edge连接实现
 */
export class TCPEdgeConnection extends TypedEventEmitter<EdgeConnectionEvents> implements IEdgeConnection {
  readonly edgeId: number;
  readonly type = 'tcp' as const;
  
  private config: ConnectionConfig;
  private logger: Logger;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private socket?: TLSSocket;
  private heartbeatState: HeartbeatState;
  private qualityTracking: QualityTrackingState;
  private receiveBuffer: ReceiveBufferState;
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
  private connectTimeout?: NodeJS.Timeout;

  constructor(config: ConnectionConfig, logger: Logger) {
    super();
    this.edgeId = config.remoteEdgeId;
    this.config = config;
    this.logger = logger;

    // 初始化心跳状态
    const now = Date.now();
    this.heartbeatState = {
      lastSent: now,
      lastReceived: now,
      sequence: 0,
      sentTime: new Map(),
    };

    // 初始化质量监控
    this.qualityTracking = {
      rttSamples: [],
      maxRttSamples: 10,
      lastRtt: 0,
      bandwidthStart: now,
      bandwidthBytesIn: 0,
      bandwidthBytesOut: 0,
    };

    // 初始化接收缓冲区
    this.receiveBuffer = {
      buffer: Buffer.alloc(0),
      expectedLength: 0,
    };
  }

  /**
   * 是否已连接
   */
  get isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED && this.socket?.writable === true;
  }

  /**
   * 建立连接
   */
  async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.CONNECTED) {
      this.logger.debug(`Connection to edge ${this.edgeId} already in progress or established`);
      return;
    }

    this.state = ConnectionState.CONNECTING;
    this.logger.info(`Connecting to edge ${this.edgeId} via TCP at ${this.config.host}:${this.config.port}`);

    try {
      await this.establishConnection();
    } catch (error) {
      this.logger.error(`Failed to connect to edge ${this.edgeId}:`, error);
      this.handleDisconnect('connection failed');
      throw error;
    }
  }

  /**
   * 建立TCP/TLS连接
   */
  private async establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 设置连接超时
      this.connectTimeout = setTimeout(() => {
        this.logger.warn(`Connection timeout for edge ${this.edgeId}`);
        if (this.socket) {
          this.socket.destroy();
        }
        reject(new Error('Connection timeout'));
      }, CONNECT_TIMEOUT_MS);

      // 创建TLS连接
      this.socket = tls.connect({
        host: this.config.host,
        port: this.config.port,
        rejectUnauthorized: false, // 对于edge-to-edge连接，先不严格验证证书
      });

      this.socket.on('secureConnect', () => {
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = undefined;
        }

        this.state = ConnectionState.CONNECTED;
        this.connectedAt = Date.now();
        this.reconnectAttempts = 0;
        
        this.logger.info(`Successfully connected to edge ${this.edgeId} via TCP`);
        
        // 启动心跳
        this.startHeartbeat();
        
        this.emit('connected');
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        this.handleIncomingData(data);
      });

      this.socket.on('error', (error: Error) => {
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = undefined;
        }
        
        this.stats.errors++;
        this.logger.error(`Socket error for edge ${this.edgeId}:`, error);
        this.emit('error', error);
        
        if (this.state === ConnectionState.CONNECTING) {
          reject(error);
        }
      });

      this.socket.on('close', () => {
        // handleDisconnect 会记录日志，这里不重复记录
        this.handleDisconnect('socket closed');
      });

      this.socket.on('timeout', () => {
        this.logger.warn(`TCP connection to edge ${this.edgeId} timed out`);
        this.socket?.destroy();
      });
    });
  }

  /**
   * 发送数据
   */
  async send(data: Buffer): Promise<void> {
    if (!this.isConnected || !this.socket) {
      throw new Error(`Cannot send data: connection to edge ${this.edgeId} is not established`);
    }

    const message: Message = {
      type: MessageType.DATA,
      data,
    };

    const encoded = this.encodeMessage(message);
    
    return new Promise((resolve, reject) => {
      this.socket!.write(encoded, (error) => {
        if (error) {
          this.stats.errors++;
          this.logger.error(`Failed to send data to edge ${this.edgeId}:`, error);
          reject(error);
        } else {
          this.stats.packetsSent++;
          this.stats.bytesSent += encoded.length;
          this.qualityTracking.bandwidthBytesOut += encoded.length;
          this.updateLastSeen();
          resolve();
        }
      });
    });
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.logger.info(`Closing TCP connection to edge ${this.edgeId}`);
    this.stopTimers();
    
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = undefined;
    }
    
    this.state = ConnectionState.DISCONNECTED;
  }

  /**
   * 获取连接状态
   */
  getStatus(): ConnectionStatus {
    return {
      edgeId: this.edgeId,
      state: this.state,
      type: ConnectionType.TCP,
      isConnected: this.isConnected,
      lastSeen: this.stats.lastActive,
      connectedAt: this.connectedAt,
      stats: {
        packetsSent: this.stats.packetsSent,
        packetsReceived: this.stats.packetsReceived,
        bytesSent: this.stats.bytesSent,
        bytesReceived: this.stats.bytesReceived,
        errors: this.stats.errors,
        lastActive: this.stats.lastActive,
      },
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * 获取质量指标
   */
  getQualityMetrics(): ConnectionQualityMetrics {
    const now = Date.now();
    const elapsedSec = (now - this.qualityTracking.bandwidthStart) / 1000;
    
    return {
      edgeId: this.edgeId,
      rtt: this.qualityTracking.lastRtt,
      packetLoss: 0, // TCP保证可靠传输，无丢包
      jitter: 0, // TCP有序传输，无抖动
      lastUpdate: now,
      samples: this.qualityTracking.rttSamples.length,
      bandwidth: {
        upload: elapsedSec > 0 ? this.qualityTracking.bandwidthBytesOut / elapsedSec : 0,
        download: elapsedSec > 0 ? this.qualityTracking.bandwidthBytesIn / elapsedSec : 0,
      },
    };
  }

  /**
   * 编码消息
   */
  private encodeMessage(message: Message): Buffer {
    let payloadSize = 1; // type字段
    
    if (message.type === MessageType.HEARTBEAT_PING || message.type === MessageType.HEARTBEAT_PONG) {
      payloadSize += 8 + 8; // sequence + timestamp
    } else if (message.type === MessageType.DATA && message.data) {
      payloadSize += message.data.length;
    }
    
    const buffer = Buffer.allocUnsafe(MESSAGE_HEADER_SIZE + payloadSize);
    
    // 写入长度
    buffer.writeUInt32BE(payloadSize, 0);
    
    // 写入类型
    buffer.writeUInt8(message.type, MESSAGE_HEADER_SIZE);
    
    let offset = MESSAGE_HEADER_SIZE + 1;
    
    if (message.type === MessageType.HEARTBEAT_PING || message.type === MessageType.HEARTBEAT_PONG) {
      // 写入序列号和时间戳
      buffer.writeBigUInt64BE(BigInt(message.sequence || 0), offset);
      offset += 8;
      buffer.writeBigUInt64BE(BigInt(message.timestamp || 0), offset);
    } else if (message.type === MessageType.DATA && message.data) {
      // 写入数据
      message.data.copy(buffer, offset);
    }
    
    return buffer;
  }

  /**
   * 解码消息
   */
  private decodeMessage(buffer: Buffer): Message | null {
    if (buffer.length < 1) {
      return null;
    }
    
    const type = buffer.readUInt8(0) as MessageType;
    let offset = 1;
    
    if (type === MessageType.HEARTBEAT_PING || type === MessageType.HEARTBEAT_PONG) {
      if (buffer.length < 17) {
        return null;
      }
      const sequence = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
      const timestamp = Number(buffer.readBigUInt64BE(offset));
      
      return { type, sequence, timestamp };
    } else if (type === MessageType.DATA) {
      const data = buffer.slice(offset);
      return { type, data };
    }
    
    return null;
  }

  /**
   * 处理接收到的数据
   */
  private handleIncomingData(chunk: Buffer): void {
    // 追加到接收缓冲区
    this.receiveBuffer.buffer = Buffer.concat([this.receiveBuffer.buffer, chunk]);
    
    // 处理所有完整的消息
    while (true) {
      // 如果还没有读取长度头，尝试读取
      if (this.receiveBuffer.expectedLength === 0) {
        if (this.receiveBuffer.buffer.length < MESSAGE_HEADER_SIZE) {
          break; // 等待更多数据
        }
        
        this.receiveBuffer.expectedLength = this.receiveBuffer.buffer.readUInt32BE(0);
        this.receiveBuffer.buffer = this.receiveBuffer.buffer.slice(MESSAGE_HEADER_SIZE);
      }
      
      // 检查是否有完整消息
      if (this.receiveBuffer.buffer.length < this.receiveBuffer.expectedLength) {
        break; // 等待更多数据
      }
      
      // 提取消息
      const messageBuffer = this.receiveBuffer.buffer.slice(0, this.receiveBuffer.expectedLength);
      this.receiveBuffer.buffer = this.receiveBuffer.buffer.slice(this.receiveBuffer.expectedLength);
      this.receiveBuffer.expectedLength = 0;
      
      // 解码并处理消息
      const message = this.decodeMessage(messageBuffer);
      if (message) {
        this.handleMessage(message);
      }
    }
  }

  /**
   * 处理消息
   */
  private handleMessage(message: Message): void {
    this.updateLastSeen();
    this.stats.packetsReceived++;
    
    switch (message.type) {
      case MessageType.HEARTBEAT_PING:
        this.handleHeartbeatPing(message);
        break;
      case MessageType.HEARTBEAT_PONG:
        this.handleHeartbeatPong(message);
        break;
      case MessageType.DATA:
        this.handleDataMessage(message);
        break;
    }
  }

  /**
   * 处理心跳Ping
   */
  private handleHeartbeatPing(message: Message): void {
    this.logger.debug(`Received heartbeat ping from edge ${this.edgeId}, sequence: ${message.sequence}`);
    this.heartbeatState.lastReceived = Date.now();
    
    // 发送Pong
    const pong: Message = {
      type: MessageType.HEARTBEAT_PONG,
      sequence: message.sequence,
      timestamp: Date.now(),
    };
    
    const encoded = this.encodeMessage(pong);
    this.socket?.write(encoded);
  }

  /**
   * 处理心跳Pong
   */
  private handleHeartbeatPong(message: Message): void {
    this.logger.debug(`Received heartbeat pong from edge ${this.edgeId}, sequence: ${message.sequence}`);
    this.heartbeatState.lastReceived = Date.now();
    
    // 计算RTT
    const sentTime = this.heartbeatState.sentTime.get(message.sequence!);
    if (sentTime) {
      const rtt = Date.now() - sentTime;
      this.logger.debug(`RTT to edge ${this.edgeId}: ${rtt}ms`);
      this.heartbeatState.sentTime.delete(message.sequence!);
      
      // 更新质量追踪
      this.updateQualityMetrics(rtt);
    }
  }

  /**
   * 处理数据消息
   */
  private handleDataMessage(message: Message): void {
    if (!message.data) {
      return;
    }
    
    this.stats.bytesReceived += message.data.length;
    this.qualityTracking.bandwidthBytesIn += message.data.length;
    this.emit('data', message.data, Date.now());
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.heartbeatState.timer = setInterval(() => {
      this.sendHeartbeat();
      this.checkHeartbeatTimeout();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 发送心跳
   */
  private sendHeartbeat(): void {
    if (!this.isConnected) {
      return;
    }
    
    this.heartbeatState.sequence++;
    const sequence = this.heartbeatState.sequence;
    const timestamp = Date.now();
    
    const ping: Message = {
      type: MessageType.HEARTBEAT_PING,
      sequence,
      timestamp,
    };
    
    this.heartbeatState.sentTime.set(sequence, timestamp);
    this.heartbeatState.lastSent = timestamp;
    
    const encoded = this.encodeMessage(ping);
    this.socket?.write(encoded);
    
    this.logger.debug(`Sent heartbeat ping to edge ${this.edgeId}, sequence: ${sequence}`);
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
   * 更新质量指标
   */
  private updateQualityMetrics(rtt: number): void {
    const tracking = this.qualityTracking;
    
    tracking.rttSamples.push(rtt);
    if (tracking.rttSamples.length > tracking.maxRttSamples) {
      tracking.rttSamples.shift();
    }
    tracking.lastRtt = rtt;
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(reason: string): void {
    if (this.state === ConnectionState.DISCONNECTED || this.state === ConnectionState.RECONNECTING || this.state === ConnectionState.FAILED) {
      this.logger.debug(`Already handling disconnect for edge ${this.edgeId}, state: ${this.state}`);
      return;
    }
    
    this.state = ConnectionState.DISCONNECTED;
    this.stopTimers();
    
    // 移除所有 socket 事件监听器，防止 destroy() 触发 close 事件导致级联调用
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = undefined;
    }
    
    this.logger.warn(`TCP connection to edge ${this.edgeId} lost: ${reason}`);
    this.emit('disconnected', reason);
    
    this.scheduleReconnect();
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    // 如果已经在重连中，不要重复调度
    if (this.reconnectTimer) {
      this.logger.debug(`Reconnect already scheduled for edge ${this.edgeId}`);
      return;
    }
    
    const maxAttempts = this.config.maxReconnectAttempts || 5;
    
    if (this.reconnectAttempts >= maxAttempts) {
      this.logger.error(`Max reconnect attempts (${maxAttempts}) reached for edge ${this.edgeId}`);
      this.state = ConnectionState.FAILED;
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    
    this.logger.info(`Scheduling reconnect to edge ${this.edgeId} in ${delay}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`);
    
    this.state = ConnectionState.RECONNECTING;
    this.emit('reconnecting', this.reconnectAttempts);
    
    this.reconnectTimer = setTimeout(() => {
      this.logger.info(`Attempting to reconnect to edge ${this.edgeId} (attempt ${this.reconnectAttempts}/${maxAttempts})`);
      void this.connect().catch((error) => {
        this.logger.error(`Reconnect attempt failed:`, error);
      });
    }, delay);
  }

  /**
   * 停止所有定时器
   */
  private stopTimers(): void {
    if (this.heartbeatState.timer) {
      clearInterval(this.heartbeatState.timer);
      this.heartbeatState.timer = undefined;
    }
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = undefined;
    }
  }

  /**
   * 更新最后活跃时间（public，实现IEdgeConnection接口）
   */
  updateLastSeen(): void {
    this.stats.lastActive = Date.now();
  }
}
