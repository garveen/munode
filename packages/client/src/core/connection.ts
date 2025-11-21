/**
 * ConnectionManager - 连接管理器
 * 
 * 主要职责:
 * - TCP/UDP 连接建立和管理
 * - TLS/SSL 证书验证
 * - 自动重连机制
 * - 消息发送和接收
 * - 心跳维护
 */

import { TLSSocket } from 'tls';
import * as tls from 'tls';
import { Socket as UDPSocket } from 'dgram';
import type { MumbleClient } from './mumble-client.js';
import type { ConnectOptions } from '../types/client-types.js';
import { mumbleproto } from '@munode/protocol';
import { MessageType } from '@munode/protocol';

export enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Authenticating = 'authenticating',
  Ready = 'ready',
  Disconnecting = 'disconnecting',
}

interface VoicePacketInfo {
  sessionId: number;
  sequence: number;
  target: number;
  codec: number;
  audioData: Buffer;
}

export class ConnectionManager {
  private client: MumbleClient;
  private tcpSocket: TLSSocket | null = null;
  private udpSocket: UDPSocket | null = null;
  private state: ConnectionState = ConnectionState.Disconnected;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private receiveBuffer: Buffer = Buffer.alloc(0);

  constructor(client: MumbleClient) {
    this.client = client;
  }

  /**
   * 建立 TCP 连接
   */
  async connectTCP(options: ConnectOptions): Promise<void> {
    if (this.tcpSocket) {
      throw new Error('Already connected');
    }

    this.setState(ConnectionState.Connecting);

    return new Promise((resolve, reject) => {
      const tlsOptions: any = {
        host: options.host,
        port: options.port || 64738,
        rejectUnauthorized: options.rejectUnauthorized !== false,
        timeout: options.connectTimeout || 10000,
      };

      // 如果有客户端证书，添加到选项中
      if (options.clientCert && options.clientKey) {
        tlsOptions.cert = options.clientCert;
        tlsOptions.key = options.clientKey;
      }

      this.tcpSocket = tls.connect(tlsOptions);

      this.tcpSocket.on('secureConnect', () => {
        this.setState(ConnectionState.Connected);
        resolve();
      });

      this.tcpSocket.on('error', (error) => {
        this.setState(ConnectionState.Disconnected);
        reject(error);
      });

      this.tcpSocket.on('timeout', () => {
        this.tcpSocket?.destroy(new Error('Connection timeout'));
      });

      this.tcpSocket.on('data', (data) => {
        this.handleTCPMessage(data);
      });

      this.tcpSocket.on('close', () => {
        this.setState(ConnectionState.Disconnected);
        this.tcpSocket = null;
        this.receiveBuffer = Buffer.alloc(0); // 清空接收缓冲区
      });
    });
  }

  /**
   * 建立 UDP 连接
   */
  async connectUDP(_host: string, _port: number): Promise<void> {
    if (this.udpSocket) {
      throw new Error('UDP socket already exists');
    }

    // 创建 UDP socket
    const dgram = await import('dgram');
    this.udpSocket = dgram.createSocket('udp4');

    // 设置消息接收处理器
    this.udpSocket.on('message', (msg, _rinfo) => {
      this.handleUDPMessage(msg);
    });

    this.udpSocket.on('error', (error) => {
      console.error('UDP socket error:', error);
    });

    // 绑定到随机本地端口
    return new Promise((resolve, reject) => {
      this.udpSocket!.bind(0, () => {
        resolve();
      });

      this.udpSocket!.on('error', reject);
    });
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.setState(ConnectionState.Disconnecting);

    this.stopReconnect();
    this.stopPing();
    
    if (this.tcpSocket) {
      this.tcpSocket.end();
      this.tcpSocket = null;
    }
    
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
    
    this.setState(ConnectionState.Disconnected);
  }

  /**
   * 发送 TCP 消息
   */
  async sendTCP(message: Buffer): Promise<void> {
    if (!this.tcpSocket || (this.state !== ConnectionState.Connected && this.state !== ConnectionState.Ready)) {
      throw new Error('Not connected');
    }
    
    return new Promise((resolve, reject) => {
      this.tcpSocket!.write(message, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 发送 UDP 消息
   */
  async sendUDP(message: Buffer): Promise<void> {
    if (!this.udpSocket) {
      throw new Error('UDP socket not connected');
    }

    // 获取服务器地址和端口 (从TCP连接中获取)
    const address = this.tcpSocket?.remoteAddress;
    const port = this.tcpSocket?.remotePort;

    if (!address || !port) {
      throw new Error('TCP connection not established');
    }

    return new Promise((resolve, reject) => {
      this.udpSocket!.send(message, 0, message.length, port, address, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 处理接收到的 TCP 消息
   */
  private handleTCPMessage(data: Buffer): void {
    // 将新数据追加到接收缓冲区
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
    
    // 循环处理缓冲区中的所有完整消息
    while (this.receiveBuffer.length >= 6) {
      // 读取消息头
      const type = this.receiveBuffer.readUInt16BE(0);
      const length = this.receiveBuffer.readUInt32BE(2);
      
      // 检查是否有完整的消息
      if (this.receiveBuffer.length < 6 + length) {
        // 数据不完整，等待更多数据
        break;
      }
      
      // 提取消息负载
      const payload = this.receiveBuffer.subarray(6, 6 + length);
      
      // 处理消息
      this.routeMessage(type, payload);
      
      // 从缓冲区移除已处理的消息
      this.receiveBuffer = this.receiveBuffer.subarray(6 + length);
    }
  }

  /**
   * 路由消息到相应处理器
   */
  private routeMessage(type: number, payload: Buffer): void {
    try {
      switch (type) {
        case MessageType.Version:
          // 版本消息，通常是服务器发送的第一个消息
          const versionMessage = mumbleproto.Version.deserialize(payload);
          this.client.emit('version', versionMessage);
          break;

        case MessageType.UDPTunnel:
          // UDP隧道消息，包含音频数据
          this.handleUDPTunnel(payload);
          break;

        case MessageType.Authenticate:
          // 认证消息，客户端发送，服务器不应该回复
          console.warn('Received unexpected Authenticate message from server');
          break;

        case MessageType.Ping:
          // Ping消息
          const pingMessage = mumbleproto.Ping.deserialize(payload);
          this.client.emit('ping', pingMessage);
          break;

        case MessageType.Reject:
          // 拒绝消息 (认证失败)
          const rejectMessage = mumbleproto.Reject.deserialize(payload);
          this.client.getAuthManager().handleReject(rejectMessage);
          break;

        case MessageType.ServerSync:
          // 服务器同步消息 (认证成功)
          const serverSyncMessage = mumbleproto.ServerSync.deserialize(payload);
          this.client.getAuthManager().handleServerSync(serverSyncMessage);
          break;

        case MessageType.ChannelRemove:
          // 频道删除消息
          const channelRemoveMessage = mumbleproto.ChannelRemove.deserialize(payload);
          this.client.getStateManager().handleChannelRemove(channelRemoveMessage);
          break;

        case MessageType.ChannelState:
          // 频道状态消息
          const channelStateMessage = mumbleproto.ChannelState.deserialize(payload);
          this.client.getStateManager().handleChannelState(channelStateMessage);
          break;

        case MessageType.UserRemove:
          // 用户删除消息
          const userRemoveMessage = mumbleproto.UserRemove.deserialize(payload);
          this.client.getStateManager().handleUserRemove(userRemoveMessage);
          break;

        case MessageType.UserState:
          // 用户状态消息
          const userStateMessage = mumbleproto.UserState.deserialize(payload);
          this.client.getStateManager().handleUserState(userStateMessage);
          break;

        case MessageType.BanList:
          // 封禁列表消息
          const banListMessage = mumbleproto.BanList.deserialize(payload);
          this.client.emit('banList', banListMessage);
          break;

        case MessageType.TextMessage:
          // 文本消息
          const textMessage = mumbleproto.TextMessage.deserialize(payload);
          this.client.emit('textMessage', textMessage);
          break;

        case MessageType.PermissionDenied:
          // 权限拒绝消息
          const permissionDeniedMessage = mumbleproto.PermissionDenied.deserialize(payload);
          this.client.getStateManager().handlePermissionDenied(permissionDeniedMessage);
          break;

        case MessageType.ACL:
          // ACL消息
          const aclMessage = mumbleproto.ACL.deserialize(payload);
          this.client.emit('acl', aclMessage);
          break;

        case MessageType.QueryUsers:
          // 查询用户消息
          const queryUsersMessage = mumbleproto.QueryUsers.deserialize(payload);
          this.client.emit('queryUsers', queryUsersMessage);
          break;

        case MessageType.CryptSetup:
          // 加密设置消息
          const cryptSetupMessage = mumbleproto.CryptSetup.deserialize(payload);
          this.handleCryptSetup(cryptSetupMessage);
          break;

        case MessageType.ContextActionModify:
          // 上下文操作修改消息
          const contextActionModifyMessage = mumbleproto.ContextActionModify.deserialize(payload);
          this.client.emit('contextActionModify', contextActionModifyMessage);
          break;

        case MessageType.ContextAction:
          // 上下文操作消息
          const contextActionMessage = mumbleproto.ContextAction.deserialize(payload);
          this.client.emit('contextAction', contextActionMessage);
          break;

        case MessageType.UserList:
          // 用户列表消息
          const userListMessage = mumbleproto.UserList.deserialize(payload);
          this.client.emit('userList', userListMessage);
          break;

        case MessageType.VoiceTarget:
          // 语音目标消息
          const voiceTargetMessage = mumbleproto.VoiceTarget.deserialize(payload);
          this.client.emit('voiceTarget', voiceTargetMessage);
          break;

        case MessageType.PermissionQuery:
          // 权限查询消息
          const permissionQueryMessage = mumbleproto.PermissionQuery.deserialize(payload);
          this.client.emit('permissionQuery', permissionQueryMessage);
          break;

        case MessageType.CodecVersion:
          // 编解码器版本消息
          const codecVersionMessage = mumbleproto.CodecVersion.deserialize(payload);
          this.client.emit('codecVersion', codecVersionMessage);
          break;

        case MessageType.UserStats:
          // 用户统计消息
          const userStatsMessage = mumbleproto.UserStats.deserialize(payload);
          this.client.emit('userStats', userStatsMessage);
          break;

        case MessageType.RequestBlob:
          // 请求Blob消息
          const requestBlobMessage = mumbleproto.RequestBlob.deserialize(payload);
          this.client.emit('requestBlob', requestBlobMessage);
          break;

        case MessageType.ServerConfig:
          // 服务器配置消息
          const serverConfigMessage = mumbleproto.ServerConfig.deserialize(payload);
          this.client.getStateManager().handleServerConfig(serverConfigMessage);
          break;

        case MessageType.SuggestConfig:
          // 建议配置消息
          const suggestConfigMessage = mumbleproto.SuggestConfig.deserialize(payload);
          this.client.emit('suggestConfig', suggestConfigMessage);
          break;

        case MessageType.PluginDataTransmission:
          // 插件数据传输消息
          const pluginDataMessage = mumbleproto.PluginDataTransmission.deserialize(payload);
          this.client.emit('pluginData', pluginDataMessage);
          break;

        default:
          console.warn(`Unknown message type: ${type}`);
          this.client.emit('unknownMessage', { type, payload });
          break;
      }
    } catch (error) {
      console.error(`Error processing message type ${type}:`, error);
      this.client.emit('messageError', { type, payload, error });
    }
  }

  /**
   * 处理接收到的 UDP 消息
   */
  private handleUDPMessage(data: Buffer): void {
    try {
      // 1. 解密 UDP 包 (如果加密)
      let decryptedData = data;
      if (this.client.getCryptoManager().isInitialized()) {
        const decryptResult = this.client.getCryptoManager().decrypt(data);
        decryptedData = decryptResult;
      }

      // 2. 解析音频包
      const packetInfo = this.parseVoicePacket(decryptedData);
      if (!packetInfo) {
        console.warn('Failed to parse voice packet');
        return;
      }

      // 3. 路由到音频处理器
      this.client.getAudioManager().handleAudioPacket(
        packetInfo.sessionId,
        packetInfo.audioData
      );

      console.debug(`Processed voice packet from session ${packetInfo.sessionId}, sequence ${packetInfo.sequence}`);
    } catch (error) {
      console.error('Error processing UDP message:', error);
    }
  }

  /**
   * 开始自动重连
   */
  private startReconnect(delay: number): void {
    this.stopReconnect();

    this.reconnectTimer = setTimeout(async () => {
      try {
        console.log(`Attempting to reconnect in ${delay}ms...`);
        // 这里应该重新建立连接，但需要连接选项
        // 暂时只记录日志
      } catch (error) {
        console.error('Reconnection failed:', error);
        // 指数退避重连
        const nextDelay = Math.min(delay * 2, this.client.getConfig().connection.reconnectMaxDelay);
        this.startReconnect(nextDelay);
      }
    }, delay);
  }

  /**
   * 停止自动重连
   */
  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 停止心跳
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * 包装消息 (添加消息类型和长度头)
   */
  wrapMessage(type: number, data: Uint8Array): Buffer {
    const buffer = Buffer.alloc(6 + data.length);
    buffer.writeUInt16BE(type, 0); // 消息类型 (2字节)
    buffer.writeUInt32BE(data.length, 2); // 消息长度 (4字节)
    Buffer.from(data).copy(buffer, 6); // protobuf数据
    return buffer;
  }

  /**
   * 设置连接状态
   */
  setState(state: ConnectionState): void {
    this.state = state;
    this.client.emit('connectionStateChanged', state);
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.state === ConnectionState.Ready;
  }

  /**
   * 处理 UDP 隧道消息
   */
  private handleUDPTunnel(payload: Buffer): void {
    // UDP隧道消息包含音频数据，暂不实现音频流处理
    console.debug('Received UDP tunnel message, audio streaming not implemented');
    this.client.emit('udpTunnel', payload);
  }

  /**
   * 解析语音包
   */
  private parseVoicePacket(data: Buffer): VoicePacketInfo | null {
    if (data.length < 1) {
      return null;
    }

    let offset = 0;

    // 读取包头 (1字节)
    const header = data[offset++];
    const codec = (header >> 5) & 0x07; // bit 7-5: 音频类型
    const target = header & 0x1F;        // bit 4-0: 目标

    // 读取 Session ID (可变长度)
    const sessionResult = this.readVarint(data, offset);
    if (!sessionResult) return null;
    const sessionId = sessionResult.value;
    offset = sessionResult.newOffset;

    // 读取 Sequence Number (可变长度)
    const sequenceResult = this.readVarint(data, offset);
    if (!sequenceResult) return null;
    const sequence = sequenceResult.value;
    offset = sequenceResult.newOffset;

    // 剩余的是音频数据
    const audioData = data.slice(offset);

    return {
      sessionId,
      sequence,
      target,
      codec,
      audioData
    };
  }

  /**
   * 读取可变长度整数 (Varint)
   */
  private readVarint(buffer: Buffer, offset: number): { value: number; newOffset: number } | null {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;

    while (offset + bytesRead < buffer.length) {
      const byte = buffer[offset + bytesRead];
      value |= (byte & 0x7F) << shift;
      bytesRead++;

      if ((byte & 0x80) === 0) {
        return { value, newOffset: offset + bytesRead };
      }

      shift += 7;
      if (shift >= 32) {
        // 防止溢出
        return null;
      }
    }

    return null; // 数据不完整
  }

  /**
   * 处理加密设置消息
   */
  private handleCryptSetup(message: any): void {
    // 从CryptSetup消息中提取加密参数
    if (message.key && message.client_nonce && message.server_nonce) {
      this.client.getCryptoManager().setKey(
        Buffer.from(message.key),
        Buffer.from(message.client_nonce),
        Buffer.from(message.server_nonce)
      );
      console.debug('Cryptographic setup completed');
    } else {
      console.warn('Incomplete cryptographic setup message');
    }
  }
}
