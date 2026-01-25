/**
 * Edge 间 TCP 语音传输模块
 * 
 * 提供 Edge 节点之间的 TCP 语音传输能力：
 * - TCP 服务器监听来自其他 Edge 的连接
 * - TCP 客户端连接到其他 Edge
 * - 连接管理和保活
 * - 自动重连机制
 */

import { createServer, type Server as TCPServer, Socket } from 'node:net';
import { TypedEventEmitter, type EventMap, type Logger } from '@munode/common';

/**
 * TCP 连接配置
 */
export interface EdgeTCPConfig {
  enabled: boolean;
  port?: number;
  connection_timeout: number;
  keepalive_interval: number;
  prefer_over_udp: boolean;
  auto_switch_threshold?: {
    rtt: number;
    packet_loss: number;
  };
}

/**
 * Edge 连接信息
 */
interface EdgeConnection {
  edgeId: number;
  socket: Socket;
  host: string;
  port: number;
  lastActivity: number;
  bytesSent: number;
  bytesReceived: number;
}

/**
 * EdgeTCPTransport 事件类型
 */
export interface EdgeTCPTransportEvents extends EventMap {
  'edge-connected': [edgeId: number, host: string, port: number];
  'edge-disconnected': [edgeId: number];
  'voice-packet': [edgeId: number, buffer: Buffer];
  'error': [error: Error];
}

/**
 * Edge 间 TCP 传输管理器
 */
export class EdgeTCPTransport extends TypedEventEmitter<EdgeTCPTransportEvents> {
  private config: EdgeTCPConfig;
  private logger: Logger;
  private server?: TCPServer;
  private connections: Map<number, EdgeConnection> = new Map();
  private keepaliveTimer?: NodeJS.Timeout;
  private running = false;

  constructor(config: EdgeTCPConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * 启动 TCP 服务器
   */
  async start(port?: number): Promise<void> {
    if (this.running) {
      this.logger.warn('EdgeTCPTransport already running');
      return;
    }

    if (!this.config.enabled) {
      this.logger.info('EdgeTCPTransport is disabled');
      return;
    }

    const listenPort = port ?? this.config.port;
    if (!listenPort) {
      throw new Error('TCP port not configured for Edge TCP transport');
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleIncomingConnection(socket);
      });

      this.server.on('error', (error) => {
        this.logger.error('TCP server error', error);
        this.emit('error', error);
        reject(error);
      });

      this.server.listen(listenPort, () => {
        this.running = true;
        this.logger.info(`Edge TCP transport listening on port ${listenPort}`);
        this.startKeepalive();
        resolve();
      });
    });
  }

  /**
   * 停止 TCP 服务器
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // 停止保活定时器
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }

    // 关闭所有连接
    for (const [edgeId, conn] of this.connections) {
      conn.socket.removeAllListeners();
      conn.socket.destroy();
      this.emit('edge-disconnected', edgeId);
    }
    this.connections.clear();

    // 关闭服务器
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.removeAllListeners();
        this.server!.close(() => {
          this.logger.info('Edge TCP transport stopped');
          resolve();
        });
      });
      this.server = undefined;
    }
  }

  /**
   * 连接到另一个 Edge
   */
  async connectToEdge(
    edgeId: number,
    host: string,
    port: number
  ): Promise<void> {
    // 检查是否已存在连接
    if (this.connections.has(edgeId)) {
      this.logger.debug(`Already connected to Edge ${edgeId}`);
      return;
    }

    return new Promise((resolve, reject) => {
      const socket = new Socket();

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to Edge ${edgeId} timed out`));
      }, this.config.connection_timeout);

      socket.connect(port, host, () => {
        clearTimeout(timeout);
        
        // 发送握手消息（Edge ID）
        const handshake = Buffer.alloc(4);
        handshake.writeUInt32BE(edgeId, 0);
        socket.write(handshake);

        const conn: EdgeConnection = {
          edgeId,
          socket,
          host,
          port,
          lastActivity: Date.now(),
          bytesSent: 0,
          bytesReceived: 0,
        };

        this.connections.set(edgeId, conn);
        this.setupSocketHandlers(conn);

        this.logger.info(`Connected to Edge ${edgeId} at ${host}:${port}`);
        this.emit('edge-connected', edgeId, host, port);
        resolve();
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error(`Connection error to Edge ${edgeId}`, error);
        reject(error);
      });
    });
  }

  /**
   * 断开与 Edge 的连接
   */
  disconnectFromEdge(edgeId: number): void {
    const conn = this.connections.get(edgeId);
    if (!conn) {
      return;
    }

    conn.socket.destroy();
    this.connections.delete(edgeId);
    this.emit('edge-disconnected', edgeId);
    this.logger.info(`Disconnected from Edge ${edgeId}`);
  }

  /**
   * 发送语音包到指定 Edge
   */
  async sendVoicePacket(
    targetEdgeId: number,
    buffer: Buffer
  ): Promise<boolean> {
    const conn = this.connections.get(targetEdgeId);
    if (!conn) {
      return false;
    }

    try {
      // 发送包长度（4字节）+ 包数据
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(buffer.length, 0);
      
      conn.socket.write(lengthPrefix);
      conn.socket.write(buffer);
      
      conn.bytesSent += buffer.length + 4;
      conn.lastActivity = Date.now();
      
      return true;
    } catch (error) {
      this.logger.error(`Failed to send voice packet to Edge ${targetEdgeId}`, error);
      return false;
    }
  }

  /**
   * 处理入站连接
   */
  private handleIncomingConnection(socket: Socket): void {
    let edgeId: number | undefined;
    let dataBuffer = Buffer.alloc(0);

    // 等待握手消息（4字节 Edge ID）
    const handshakeHandler = (data: Buffer): void => {
      dataBuffer = Buffer.concat([dataBuffer, data]);

      if (dataBuffer.length >= 4) {
        edgeId = dataBuffer.readUInt32BE(0);
        dataBuffer = dataBuffer.subarray(4);

        // 移除握手处理器
        socket.off('data', handshakeHandler);

        // 检查是否已有连接
        if (this.connections.has(edgeId!)) {
          this.logger.warn(`Edge ${edgeId} already connected, closing old connection`);
          this.connections.get(edgeId!)!.socket.destroy();
        }

        const conn: EdgeConnection = {
          edgeId: edgeId!,
          socket,
          host: socket.remoteAddress || 'unknown',
          port: socket.remotePort || 0,
          lastActivity: Date.now(),
          bytesSent: 0,
          bytesReceived: 0,
        };

        this.connections.set(edgeId!, conn);
        this.setupSocketHandlers(conn);

        this.logger.info(
          `Incoming connection from Edge ${edgeId} at ${conn.host}:${conn.port}`
        );
        this.emit('edge-connected', edgeId!, conn.host, conn.port);

        // 处理握手后剩余的数据
        if (dataBuffer.length > 0) {
          this.processData(conn, dataBuffer);
        }
      }
    };

    socket.on('data', handshakeHandler);

    socket.on('error', (error) => {
      if (edgeId) {
        this.logger.error(`Socket error from Edge ${edgeId}`, error);
      } else {
        this.logger.error('Socket error from unknown Edge', error);
      }
    });

    socket.on('close', () => {
      if (edgeId) {
        this.connections.delete(edgeId);
        this.emit('edge-disconnected', edgeId);
        this.logger.info(`Edge ${edgeId} disconnected`);
      }
    });
  }

  /**
   * 设置 Socket 处理器
   */
  private setupSocketHandlers(conn: EdgeConnection): void {
    let dataBuffer: Buffer = Buffer.alloc(0);

    conn.socket.on('data', (data: Buffer) => {
      conn.lastActivity = Date.now();
      conn.bytesReceived += data.length;
      dataBuffer = Buffer.concat([dataBuffer, data]) as Buffer;
      dataBuffer = this.processData(conn, dataBuffer);
    });

    conn.socket.on('error', (error) => {
      this.logger.error(`Socket error from Edge ${conn.edgeId}`, error);
      this.emit('error', error);
    });

    conn.socket.on('close', () => {
      this.connections.delete(conn.edgeId);
      this.emit('edge-disconnected', conn.edgeId);
      this.logger.info(`Edge ${conn.edgeId} disconnected`);
    });
  }

  /**
   * 处理接收到的数据
   */
  private processData(conn: EdgeConnection, buffer: Buffer): Buffer {
    while (buffer.length >= 4) {
      // 读取包长度
      const packetLength = buffer.readUInt32BE(0);

      // 检查是否接收完整包
      if (buffer.length < 4 + packetLength) {
        break;
      }

      // 提取包数据
      const packetData = buffer.subarray(4, 4 + packetLength);
      buffer = buffer.subarray(4 + packetLength);

      // 发出原始 Buffer，由上层处理解析
      this.emit('voice-packet', conn.edgeId, packetData);
    }

    return buffer;
  }

  /**
   * 启动保活机制
   */
  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.keepalive_interval * 2;

      for (const [edgeId, conn] of this.connections) {
        // 检查连接是否超时
        if (now - conn.lastActivity > timeout) {
          this.logger.warn(`Edge ${edgeId} connection timeout, disconnecting`);
          this.disconnectFromEdge(edgeId);
          continue;
        }

        // 发送保活包（空包）
        const keepalive = Buffer.alloc(4);
        keepalive.writeUInt32BE(0, 0);
        conn.socket.write(keepalive);
      }
    }, this.config.keepalive_interval);
  }

  /**
   * 获取连接统计
   */
  getStats(): {
    activeConnections: number;
    totalBytesSent: number;
    totalBytesReceived: number;
    connections: Array<{
      edgeId: number;
      host: string;
      port: number;
      bytesSent: number;
      bytesReceived: number;
      lastActivity: number;
    }>;
  } {
    let totalBytesSent = 0;
    let totalBytesReceived = 0;
    const connections: Array<{
      edgeId: number;
      host: string;
      port: number;
      bytesSent: number;
      bytesReceived: number;
      lastActivity: number;
    }> = [];

    for (const conn of this.connections.values()) {
      totalBytesSent += conn.bytesSent;
      totalBytesReceived += conn.bytesReceived;
      connections.push({
        edgeId: conn.edgeId,
        host: conn.host,
        port: conn.port,
        bytesSent: conn.bytesSent,
        bytesReceived: conn.bytesReceived,
        lastActivity: conn.lastActivity,
      });
    }

    return {
      activeConnections: this.connections.size,
      totalBytesSent,
      totalBytesReceived,
      connections,
    };
  }

  /**
   * 检查是否已连接到指定 Edge
   */
  isConnectedTo(edgeId: number): boolean {
    return this.connections.has(edgeId);
  }

  /**
   * 获取所有已连接的 Edge ID
   */
  getConnectedEdgeIds(): number[] {
    return Array.from(this.connections.keys());
  }
}
