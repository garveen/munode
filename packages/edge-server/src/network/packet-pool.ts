import { EventEmitter } from 'events';
// import { logger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, UDPConnection } from '../types.js';
import { createSocket } from 'dgram';
// import { Socket as UDPSocket } from 'dgram';

/**
 * 包连接池管理器 - 优化UDP连接管理
 */
export class PacketConnPool extends EventEmitter {
  // private config: EdgeConfig;
  private logger: Logger;
  private connections: Map<string, UDPConnection> = new Map();
  private maxConnections: number = 100;
  private connectionTimeout: number = 300000; // 5分钟

  constructor(_config: EdgeConfig, _logger: Logger) {
    super();
    // this._config = _config;
    this.logger = _logger;
  }

  /**
   * 获取或创建UDP连接
   */
  getConnection(remoteAddress: string, remotePort: number): UDPConnection {
    const key = `${remoteAddress}:${remotePort}`;

    let connection = this.connections.get(key);
    if (connection) {
      // 更新最后使用时间
      connection.lastUsed = Date.now();
      connection.packetCount++;
      return connection;
    }

    // 创建新连接
    connection = this.createConnection(remoteAddress, remotePort);
    this.connections.set(key, connection);

    this.logger.debug(`Created UDP connection: ${key}`);
    this.emit('connectionCreated', connection);

    // 清理过期连接
    this.cleanupConnections();

    return connection;
  }

  /**
   * 创建UDP连接
   */
  private createConnection(remoteAddress: string, remotePort: number): UDPConnection {
    const socket = createSocket('udp4');

    const connection: UDPConnection = {
      id: `${remoteAddress}:${remotePort}`,
      socket,
      localAddress: '',
      lastUsed: Date.now(),
      packetCount: 0,
    };

    // 设置socket事件处理器
    socket.on('listening', () => {
      const address = socket.address();
      connection.localAddress = `${address.address}:${address.port}`;
    });

    socket.on('error', (error) => {
      this.logger.error(`UDP connection error for ${connection.id}:`, error);
      this.removeConnection(connection.id);
    });

    socket.on('close', () => {
      this.logger.debug(`UDP connection closed: ${connection.id}`);
      this.removeConnection(connection.id);
    });

    // 绑定到随机端口
    socket.bind(0);

    return connection;
  }

  /**
   * 发送数据包
   */
  async sendPacket(
    connectionId: string,
    data: Buffer,
    remoteAddress: string,
    remotePort: number
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    return new Promise((resolve, reject) => {
      connection.socket.send(data, 0, data.length, remotePort, remoteAddress, (error) => {
        if (error) {
          reject(error);
        } else {
          connection.lastUsed = Date.now();
          connection.packetCount++;
          resolve();
        }
      });
    });
  }

  /**
   * 移除连接
   */
  removeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.socket.close();
      this.connections.delete(connectionId);
      this.emit('connectionRemoved', connection);
    }
  }

  /**
   * 清理过期连接
   */
  private cleanupConnections(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, connection] of this.connections) {
      if (now - connection.lastUsed > this.connectionTimeout) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.logger.debug(`Cleaning up expired UDP connection: ${id}`);
      this.removeConnection(id);
    }

    if (toRemove.length > 0) {
      this.logger.info(`Cleaned up ${toRemove.length} expired UDP connections`);
    }
  }

  /**
   * 获取连接统计
   */
  getStats(): any {
    const totalPackets = Array.from(this.connections.values()).reduce(
      (sum, conn) => sum + conn.packetCount,
      0
    );

    return {
      activeConnections: this.connections.size,
      maxConnections: this.maxConnections,
      totalPackets,
      averagePacketsPerConnection:
        this.connections.size > 0 ? totalPackets / this.connections.size : 0,
    };
  }

  /**
   * 获取所有连接
   */
  getAllConnections(): UDPConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * 设置最大连接数
   */
  setMaxConnections(max: number): void {
    this.maxConnections = max;
  }

  /**
   * 设置连接超时时间
   */
  setConnectionTimeout(timeout: number): void {
    this.connectionTimeout = timeout;
  }
}
