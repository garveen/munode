import { Socket } from 'net';
import { TLSSocket } from 'tls';
import { EventEmitter } from 'events';
// import { logger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, ClientInfo } from '../types.js';

/**
 * 客户端管理器 - 管理所有连接的客户端
 */
export class ClientManager extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;
  private clients: Map<number, ClientInfo> = new Map();
  private sockets: Map<number, Socket | TLSSocket> = new Map(); // 保存 socket 引用

  constructor(config: EdgeConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * 创建新客户端（使用外部提供的 session ID）
   */
  createClient(socket: Socket | TLSSocket, sessionId: number, cert_hash?: string): ClientInfo {
    const clientAddress = socket.remoteAddress || 'unknown';

    const client: ClientInfo = {
      session: sessionId,
      user_id: 0,
      username: '',
      channel_id: this.config.defaultChannel,
      mute: false,
      deaf: false,
      self_mute: false,
      self_deaf: false,
      suppress: false,
      priority_speaker: false,
      recording: false,
      groups: [],
      comment: '',
      hash: '',
      cert_hash: cert_hash,
       ip_address: clientAddress,
       connected_at: new Date(),
      last_active: new Date(),
      version: '',
       client_name: '',
       os_name: '',
       os_version: '',
    };

    this.clients.set(sessionId, client);
    this.sockets.set(sessionId, socket); // 保存 socket 引用
    this.logger.info(`Client connected: session=${sessionId}, ip=${clientAddress}`);

    // 设置 socket 事件处理器
    this.setupSocketHandlers(socket, sessionId);

    this.emit('clientConnected', client);
    return client;
  }

  /**
   * 移除客户端
   */
  removeClient(sessionId: number): void {
    const client = this.clients.get(sessionId);
    if (client) {
      this.clients.delete(sessionId);
      this.sockets.delete(sessionId); // 删除 socket 引用
      this.logger.info(`Client disconnected: session=${sessionId}, username=${client.username}`);
      this.emit('clientDisconnected', client);
    }
  }

  /**
   * 获取客户端信息
   */
  getClient(sessionId: number): ClientInfo | undefined {
    return this.clients.get(sessionId);
  }

  /**
   * 获取客户端 socket
   */
  getSocket(sessionId: number): Socket | TLSSocket | undefined {
    return this.sockets.get(sessionId);
  }

  /**
   * 获取所有客户端
   */
  getAllClients(): ClientInfo[] {
    return Array.from(this.clients.values());
  }

  /**
   * 获取客户端数量
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * 更新客户端信息
   */
  updateClient(sessionId: number, updates: Partial<ClientInfo>): void {
    const client = this.clients.get(sessionId);
    if (client) {
      Object.assign(client, updates);
      client.last_active = new Date();
      this.emit('clientUpdated', client);
    }
  }

  /**
   * 根据用户名查找客户端
   */
  findClientByUsername(username: string): ClientInfo | undefined {
    for (const client of this.clients.values()) {
      if (client.username === username) {
        return client;
      }
    }
    return undefined;
  }

  /**
   * 获取频道中的所有客户端
   */
  getClientsInChannel(channelId: number): ClientInfo[] {
    return Array.from(this.clients.values()).filter((client) => client.channel_id === channelId);
  }

  /**
   * 移动客户端到指定频道
   */
  moveClient(sessionId: number, channelId: number): void {
    const client = this.clients.get(sessionId);
    if (client) {
      const oldChannelId = client.channel_id;
      client.channel_id = channelId;
      client.last_active = new Date();
      this.logger.info(
        `Client moved: session=${sessionId}, username=${client.username}, from=${oldChannelId}, to=${channelId}`
      );
      this.emit('clientMoved', client, oldChannelId, channelId);
    } else {
      throw new Error(`Client not found: session=${sessionId}`);
    }
  }

  /**
   * 批量移动客户端到指定频道
   */
  moveClientsToChannel(sessionIds: number[], channelId: number): void {
    for (const sessionId of sessionIds) {
      try {
        this.moveClient(sessionId, channelId);
      } catch (error) {
        this.logger.warn(`Failed to move client ${sessionId}: ${error}`);
      }
    }
  }

  /**
   * 强制断开客户端连接
   */
  forceDisconnect(sessionId: number, reason?: string): void {
    const client = this.clients.get(sessionId);
    const socket = this.sockets.get(sessionId);

    if (client && socket) {
      this.logger.info(
        `Force disconnecting client: session=${sessionId}, username=${client.username}, reason=${reason || 'No reason'}`
      );

      // 发送断开连接事件
      this.emit('clientForceDisconnected', client, reason);

      // 关闭socket连接
      try {
        socket.destroy();
      } catch (error) {
        this.logger.error(`Error destroying socket for session ${sessionId}: ${error}`);
      }

      // 清理客户端数据
      this.removeClient(sessionId);
    } else {
      this.logger.warn(
        `Cannot force disconnect: client or socket not found for session ${sessionId}`
      );
    }
  }

  /**
   * 广播消息给所有客户端
   */
  broadcast(message: any, excludeSession?: number): void {
    for (const [sessionId, _client] of this.clients) {
      if (sessionId !== excludeSession) {
        this.sendToClient(sessionId, message);
      }
    }
  }

  /**
   * 发送消息给指定客户端
   */
  sendToClient(sessionId: number, message: any): void {
    // 消息发送逻辑将在 MessageHandler 中实现
    this.emit('sendMessage', sessionId, message);
  }

  /**
   * 发送消息给频道中的所有客户端
   */
  sendToChannel(channelId: number, message: any, excludeSession?: number): void {
    for (const [sessionId, client] of this.clients) {
      if (client.channel_id === channelId && sessionId !== excludeSession) {
        this.sendToClient(sessionId, message);
      }
    }
  }

  /**
   * 设置 socket 事件处理器
   */
  private setupSocketHandlers(socket: Socket | TLSSocket, sessionId: number): void {
    socket.on('data', (data: Buffer) => {
      this.handleClientData(sessionId, data);
    });

    socket.on('close', () => {
      this.removeClient(sessionId);
    });

    socket.on('error', (error) => {
      this.logger.error(`Client socket error: session=${sessionId}, error=${error.message}`);
      this.removeClient(sessionId);
    });

    socket.on('timeout', () => {
      this.logger.warn(`Client timeout: session=${sessionId}`);
      this.removeClient(sessionId);
    });

    // 设置超时
    socket.setTimeout(300000); // 5 minutes
  }

  /**
   * 处理客户端数据
   */
  private handleClientData(sessionId: number, data: Buffer): void {
    const client = this.clients.get(sessionId);
    if (client) {
      client.last_active = new Date();
      // 数据处理逻辑将在 MessageHandler 中实现
      this.emit('clientData', sessionId, data);
    }
  }

  /**
   * 清理不活跃的客户端
   */
  cleanupInactiveClients(maxInactiveTime: number = 3600000): void {
    const now = Date.now();
    const toRemove: number[] = [];

    for (const [sessionId, client] of this.clients) {
      if (now - client.last_active.getTime() > maxInactiveTime) {
        toRemove.push(sessionId);
      }
    }

    for (const sessionId of toRemove) {
      this.logger.info(`Removing inactive client: session=${sessionId}`);
      this.removeClient(sessionId);
    }
  }
}
