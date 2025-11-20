import { EventEmitter } from 'events';
// import { logger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, EdgeInfo } from './types.js';

/**
 * P2P 管理器 - 处理与其他 Edge 服务器的直接连接
 */
export class PeerManager extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;
  private peers: Map<number, any> = new Map(); // EdgeId -> Connection
  private connections: Map<string, any> = new Map(); // ConnectionId -> Connection

  constructor(config: EdgeConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * 初始化 P2P 管理器
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing PeerManager...');

    // 监听来自 Hub 的对等点更新
    this.on('peerListUpdate', (peers: EdgeInfo[]) => {
      this.updatePeerConnections(peers);
    });
  }

  /**
   * 关闭 P2P 管理器
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down PeerManager...');

    // 关闭所有连接
    for (const connection of this.connections.values()) {
      await this.closeConnection(connection);
    }

    this.peers.clear();
    this.connections.clear();
  }

  /**
   * 更新对等点连接
   */
  private async updatePeerConnections(peers: EdgeInfo[]): Promise<void> {
    const currentPeers = new Set(this.peers.keys());
    const newPeers = new Set(peers.map((p) => p.server_id));

    // 断开不再存在的对等点
    for (const peerId of currentPeers) {
      if (!newPeers.has(peerId)) {
        await this.disconnectPeer(peerId);
      }
    }

    // 连接新的对等点
    for (const peer of peers) {
      if (peer.server_id !== this.config.server_id && !currentPeers.has(peer.server_id)) {
        await this.connectToPeer(peer);
      }
    }
  }

  /**
   * 连接到对等点
   */
  private async connectToPeer(peer: EdgeInfo): Promise<void> {
    try {
      this.logger.info(`Connecting to peer: ${peer.name} (${peer.host}:${peer.port})`);

      // 创建连接逻辑
      const _connection = await this.createPeerConnection(peer);

      this.peers.set(peer.server_id, _connection);
      this.connections.set(_connection.id, _connection);

      this.emit('peerConnected', peer);
    } catch (error) {
      this.logger.error(`Failed to connect to peer ${peer.server_id}:`, error);
    }
  }

  /**
   * 断开对等点连接
   */
  private async disconnectPeer(peerId: number): Promise<void> {
    const connection = this.peers.get(peerId);
    if (connection) {
      await this.closeConnection(connection);
      this.peers.delete(peerId);
      this.connections.delete(connection.id);
      this.emit('peerDisconnected', peerId);
    }
  }

  /**
   * 创建对等点连接
   */
  private async createPeerConnection(peer: EdgeInfo): Promise<any> {
    // 实现对等点连接逻辑
    // 这里应该使用 gRPC 或其他协议建立连接

    return {
      id: `${this.config.server_id}-${peer.server_id}`,
      peerId: peer.server_id,
      peer,
      connected: true,
      // 其他连接属性
    };
  }

  /**
   * 关闭连接
   */
  private async closeConnection(connection: any): Promise<void> {
    try {
      // 实现连接关闭逻辑
      connection.connected = false;
      this.logger.debug(`Closed connection to peer ${connection.peerId}`);
    } catch (error) {
      this.logger.error(`Error closing connection to peer ${connection.peerId}:`, error);
    }
  }

  /**
   * 发送消息到对等点
   */
  async sendToPeer(peerId: number, message: any): Promise<void> {
    const connection = this.peers.get(peerId);
    if (!connection) {
      throw new Error(`No connection to peer ${peerId}`);
    }

    // 实现消息发送逻辑
    this.logger.debug(`Sending message to peer ${peerId}:`, message);
  }

  /**
   * 广播消息到所有对等点
   */
  async broadcastToPeers(message: any, excludePeer?: number): Promise<void> {
    for (const [peerId, _connection] of this.peers) {
      if (peerId !== excludePeer) {
        try {
          await this.sendToPeer(peerId, message);
        } catch (error) {
          this.logger.error(`Failed to broadcast to peer ${peerId}:`, error);
        }
      }
    }
  }

  /**
   * 获取连接的对等点列表
   */
  getConnectedPeers(): EdgeInfo[] {
    return Array.from(this.peers.values()).map((conn) => conn.peer);
  }

  /**
   * 获取对等点统计
   */
  getPeerStats(): any {
    return {
      connectedPeers: this.peers.size,
      totalConnections: this.connections.size,
      // 其他统计信息
    };
  }

  /**
   * 检查对等点是否已连接
   */
  isPeerConnected(peerId: number): boolean {
    return this.peers.has(peerId);
  }
}
