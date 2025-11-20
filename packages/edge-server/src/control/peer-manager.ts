/**
 * Peer连接管理器
 *
 * 管理Edge服务器之间的RPC连接（控制信道）：
 * - 建立和维护Edge-Edge RPC连接
 * - 处理Peer断开和重连
 * - 提供Peer连接状态查询
 * 
 * 注意：Peer连接仅用于控制信令（如集群协调、状态同步等），
 * 不应该用于语音包传输。语音包应该通过UDP直接传输（VoiceUDPTransport）。
 */

import { ControlChannelClient } from '@munode/protocol';
import { RPCChannel } from '@munode/protocol';
import { EventEmitter } from 'events';

export interface PeerInfo {
  id: number;
  name: string;
  host: string;
  port: number;
  voicePort: number;
}

export interface PeerConnection {
  info: PeerInfo;
  client: ControlChannelClient;
  channel: RPCChannel | null;
  connectedAt: number;
  lastHeartbeat: number;
  reconnectAttempts: number;
  isReconnecting: boolean;
}

export interface PeerManagerCallbacks {
  onPeerConnected: (peerId: number) => void;
  onPeerDisconnected: (peerId: number, reason?: string) => void;
  onPeerReconnected: (peerId: number) => void;
  onPeerFailed: (peerId: number, reason: string) => void;
  reportPeerDisconnect: (
    peerId: number,
    localClientCount: number
  ) => Promise<{ action: 'wait' | 'disconnect' }>;
}

export class PeerManager extends EventEmitter {
  private peers = new Map<number, PeerConnection>();
  private callbacks: PeerManagerCallbacks;
  private reconnectTimeout = 3000; // 3秒
  private reconnectInterval = 1000; // 1秒

  constructor(callbacks: PeerManagerCallbacks) {
    super();
    this.callbacks = callbacks;
  }

  /**
   * 添加并连接到Peer
   */
  async connectToPeer(info: PeerInfo): Promise<void> {
    // 检查是否已存在
    if (this.peers.has(info.id)) {
      throw new Error(`Peer ${info.id} already exists`);
    }

    // 创建控制信道客户端
    const client = new ControlChannelClient({
      host: info.host,
      port: info.voicePort,
      tls: false, // TODO: 根据配置启用TLS
    });

    // 创建连接记录
    const connection: PeerConnection = {
      info,
      client,
      channel: null,
      connectedAt: 0,
      lastHeartbeat: 0,
      reconnectAttempts: 0,
      isReconnecting: false,
    };

    this.peers.set(info.id, connection);

    // 设置事件监听
    this.setupClientEvents(info.id, client);

    // 执行连接
    try {
      await client.connect();
      connection.connectedAt = Date.now();
      connection.lastHeartbeat = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      connection.channel = (client as any).channel as RPCChannel; // 获取底层channel

      this.callbacks.onPeerConnected(info.id);
      this.emit('peer-connected', info.id);
    } catch (error) {
      this.peers.delete(info.id);
      throw error;
    }
  }

  /**
   * 设置客户端事件监听
   */
  private setupClientEvents(peerId: number, client: ControlChannelClient): void {
    // 监听断开事件
    client.on('disconnect', () => {
      void this.handlePeerDisconnect(peerId);
    });

    // 监听错误事件
    client.on('error', (error) => {
      console.warn(`Peer ${peerId} error:`, error);
    });

    // 监听通知
    client.on('notification', (message) => {
      this.emit('peer-notification', peerId, message);
    });
  }

  /**
   * 处理Peer断开
   */
  private async handlePeerDisconnect(peerId: number): Promise<void> {
    const connection = this.peers.get(peerId);
    if (!connection || connection.isReconnecting) {
      return;
    }

    console.warn(`Peer ${peerId} disconnected, attempting reconnect`);
    connection.isReconnecting = true;

    // 通知断开
    this.callbacks.onPeerDisconnected(peerId);

    // 尝试重连
    const success = await this.attemptReconnect(peerId);

    if (!success) {
      // 重连失败，向Hub报告
      console.error(`Peer ${peerId} reconnect failed, reporting to hub`);
      await this.handleReconnectFailed(peerId);
    }
  }

  /**
   * 尝试重连Peer
   */
  private async attemptReconnect(peerId: number): Promise<boolean> {
    const connection = this.peers.get(peerId);
    if (!connection) {
      return false;
    }

    const startTime = Date.now();
    let attempts = 0;

    while (Date.now() - startTime < this.reconnectTimeout) {
      attempts++;
      connection.reconnectAttempts = attempts;

      console.debug(`Peer ${peerId} reconnect attempt ${attempts}`);

      try {
        await connection.client.reconnect();
        
        // 重连成功
        connection.connectedAt = Date.now();
        connection.lastHeartbeat = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        connection.channel = (connection.client as any).channel as RPCChannel;
        connection.isReconnecting = false;
        connection.reconnectAttempts = 0;

        console.info(`Peer ${peerId} reconnected successfully`);
        this.callbacks.onPeerReconnected(peerId);
        this.emit('peer-reconnected', peerId);
        
        return true;
      } catch (error) {
        console.debug(`Peer ${peerId} reconnect attempt ${attempts} failed:`, error);
        
        // 等待下次重试
        if (Date.now() - startTime < this.reconnectTimeout) {
          await new Promise((resolve) => setTimeout(resolve, this.reconnectInterval));
        }
      }
    }

    return false;
  }

  /**
   * 处理重连失败
   */
  private async handleReconnectFailed(peerId: number): Promise<void> {
    try {
      // 向Hub报告Peer连接失败
      const response = await this.callbacks.reportPeerDisconnect(
        peerId,
        0 // TODO: 传入实际的客户端数量
      );

      if (response.action === 'disconnect') {
        console.warn('Hub instructed to disconnect and rejoin');
        this.callbacks.onPeerFailed(peerId, 'Hub instructed disconnect');
      }
    } catch (error) {
      console.error('Failed to report peer disconnect:', error);
      this.callbacks.onPeerFailed(peerId, 'Failed to report to hub');
    }
  }

  /**
   * 断开Peer连接
   */
  disconnectPeer(peerId: number): void {
    const connection = this.peers.get(peerId);
    if (connection) {
      connection.client.disconnect();
      this.peers.delete(peerId);
      this.callbacks.onPeerDisconnected(peerId, 'Manual disconnect');
    }
  }

  /**
   * 断开所有Peer连接
   */
  disconnectAll(): void {
    for (const [peerId] of this.peers) {
      this.disconnectPeer(peerId);
    }
  }

  /**
   * 发送RPC请求到Peer
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callPeer(peerId: number, method: string, params?: any): Promise<any> {
    const connection = this.peers.get(peerId);
    if (!connection) {
      throw new Error(`Peer ${peerId} not found`);
    }

    if (!connection.client.isConnected()) {
      throw new Error(`Peer ${peerId} not connected`);
    }

    return connection.client.call(method, params);
  }

  /**
   * 发送通知到Peer
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notifyPeer(peerId: number, method: string, params?: any): void {
    const connection = this.peers.get(peerId);
    if (!connection) {
      console.warn(`Peer ${peerId} not found, cannot send notification`);
      return;
    }

    if (!connection.client.isConnected()) {
      console.warn(`Peer ${peerId} not connected, cannot send notification`);
      return;
    }

    connection.client.notify(method, params);
  }

  /**
   * 广播通知到所有Peer
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broadcastToPeers(method: string, params?: any, excludePeer?: number): void {
    for (const [peerId, connection] of this.peers) {
      if (peerId === excludePeer) continue;

      if (connection.client.isConnected()) {
        try {
          connection.client.notify(method, params);
        } catch (error) {
          console.warn(`Failed to broadcast to peer ${peerId}:`, error);
        }
      }
    }
  }

  /**
   * 更新Peer心跳时间
   */
  updateHeartbeat(peerId: number): void {
    const connection = this.peers.get(peerId);
    if (connection) {
      connection.lastHeartbeat = Date.now();
    }
  }

  /**
   * 检查Peer是否连接
   */
  isPeerConnected(peerId: number): boolean {
    const connection = this.peers.get(peerId);
    return connection !== undefined && connection.client.isConnected();
  }

  /**
   * 获取所有连接的Peer ID
   */
  getConnectedPeerIds(): number[] {
    const ids: number[] = [];
    for (const [peerId, connection] of this.peers) {
      if (connection.client.isConnected()) {
        ids.push(peerId);
      }
    }
    return ids;
  }

  /**
   * 获取Peer信息
   */
  getPeerInfo(peerId: number): PeerInfo | undefined {
    return this.peers.get(peerId)?.info;
  }

  /**
   * 获取所有Peer信息
   */
  getAllPeers(): PeerInfo[] {
    return Array.from(this.peers.values()).map((conn) => conn.info);
  }

  /**
   * 获取连接统计
   */
  getStats(): {
    totalPeers: number;
    connectedPeers: number;
    reconnectingPeers: number;
    peerDetails: Array<{
      peerId: number;
      name: string;
      connected: boolean;
      reconnectAttempts: number;
      lastHeartbeat: number;
    }>;
  } {
    let connectedCount = 0;
    let reconnectingCount = 0;
    const peerDetails: Array<{
      peerId: number;
      name: string;
      connected: boolean;
      reconnectAttempts: number;
      lastHeartbeat: number;
    }> = [];

    for (const [peerId, connection] of this.peers) {
      const connected = connection.client.isConnected();
      if (connected) connectedCount++;
      if (connection.isReconnecting) reconnectingCount++;

      peerDetails.push({
        peerId,
        name: connection.info.name,
        connected,
        reconnectAttempts: connection.reconnectAttempts,
        lastHeartbeat: connection.lastHeartbeat,
      });
    }

    return {
      totalPeers: this.peers.size,
      connectedPeers: connectedCount,
      reconnectingPeers: reconnectingCount,
      peerDetails,
    };
  }

  /**
   * 清理所有连接
   */
  clear(): void {
    this.disconnectAll();
  }
}
