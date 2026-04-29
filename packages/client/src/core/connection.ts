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
import {
  FrameAssembler,
  wrapFrame,
  parseIncomingVoicePacket,
  encodeVarint,
} from '@munode/client-core';

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
  private assembler: FrameAssembler = new FrameAssembler();
  private useTcpVoice: boolean = false; // 是否使用TCP传输语音
  private udpFailed: boolean = false; // UDP是否失败
  private serverHost: string = '';
  private serverPort: number = 0;
  private udpPort: number = 0; // UDP 端口（通常是 TCP 端口，但在某些实现中可能是 TCP+1）

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
      const tlsOptions: tls.ConnectionOptions = {
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
        // 保存服务器信息用于后续 UDP 连接
        this.serverHost = options.host;
        this.serverPort = options.port || 64738;
        // UDP 端口：如果指定了 udpPort，使用它；否则使用 TCP 端口
        // 注意：Go/C 实现使用相同端口，但我们的实现使用 TCP+1
        this.udpPort = options.udpPort || this.serverPort;
        resolve();
      });

      this.tcpSocket.on('error', (error) => {
        this.setState(ConnectionState.Disconnected);
        // If the promise has already resolved (connected), this is a post-connect
        // error (e.g. ECONNRESET when the server closes the connection).  Emit it
        // as a client event so callers can handle it; don't leave the error unhandled.
        reject(error);
      });

      // Once connected, replace the error handler with a silent one so that
      // post-connection RSTs don't become unhandled errors.
      this.tcpSocket.once('connect', () => {
        this.tcpSocket?.removeAllListeners('error');
        this.tcpSocket?.on('error', (error) => {
          // Silently absorb post-connection errors (ECONNRESET, EPIPE, etc.).
          // The 'close' event will fire next and update state.
          if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET'
            && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
            console.warn('TCP connection error:', error.message);
          }
          this.setState(ConnectionState.Disconnected);
        });
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
        this.assembler.reset();
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

    try {
      // 创建 UDP socket
      const dgram = await import('dgram');
      this.udpSocket = dgram.createSocket('udp4');

      // 先绑定到随机本地端口
      await new Promise<void>((resolve, reject) => {
        const errorHandler = (error: Error) => {
          reject(error);
        };
        
        this.udpSocket.once('error', errorHandler);
        
        this.udpSocket.bind(0, () => {
          // bind 成功，移除临时错误处理器
          this.udpSocket.removeListener('error', errorHandler);
          resolve();
        });
      });

      // bind 成功后设置持久事件处理器
      this.udpSocket.on('message', (msg, _rinfo) => {
        this.handleUDPMessage(msg);
        this.udpFailed = false; // UDP 工作正常
      });

      this.udpSocket.on('error', (error) => {
        console.error('UDP socket error:', error);
        this.udpFailed = true;
        // UDP失败时自动降级为TCP语音
        if (!this.useTcpVoice) {
          console.log('UDP failed, falling back to TCP voice transmission');
          this.useTcpVoice = true;
        }
      });

      // 给 UDP socket 一点时间完全初始化
      // 在某些系统上，bind 回调返回后 socket 可能还没完全准备好发送数据
      await new Promise(resolve => setTimeout(resolve, 10));
      
    } catch (error) {
      console.error('Failed to create UDP socket:', error);
      this.udpFailed = true;
      this.useTcpVoice = true;
      // 不抛出错误，允许使用TCP语音继续
    }
  }

  /**
   * 设置强制使用TCP语音模式
   */
  setForceTcpVoice(force: boolean): void {
    console.log(`[ConnectionManager] setForceTcpVoice: ${force}`);
    this.useTcpVoice = force;
  }

  /**
   * 检查是否使用TCP语音
   */
  isUsingTcpVoice(): boolean {
    return this.useTcpVoice || this.udpFailed;
  }

  /**
   * 获取 UDP socket（用于测试目的）
   * @internal
   */
  getUdpSocket(): UDPSocket | null {
    return this.udpSocket;
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.setState(ConnectionState.Disconnecting);

    this.stopReconnect();
    this.stopPing();
    
    if (this.tcpSocket) {
      const socket = this.tcpSocket;
      this.tcpSocket = null;
      socket.removeAllListeners();
      // Absorb any ECONNRESET/EPIPE that may arrive during graceful close.
      socket.once('error', () => {});
      socket.destroy();
    }
    
    if (this.udpSocket) {
      this.udpSocket.removeAllListeners();
      this.udpSocket.close();
      this.udpSocket = null;
    }
    
    this.setState(ConnectionState.Disconnected);
  }

  /**
   * Abruptly destroy the TCP socket (sends TCP RST).
   * Used in tests to simulate an ungraceful disconnect.
   */
  destroySocket(): void {
    if (this.tcpSocket) {
      this.tcpSocket.destroy();
      this.tcpSocket = null;
    }
  }

  /**
   * 发送 TCP 消息
   */
  async sendTCP(message: Buffer): Promise<void> {
    if (!this.tcpSocket || (this.state !== ConnectionState.Connected && this.state !== ConnectionState.Ready)) {
      throw new Error('Not connected');
    }
    
    return new Promise((resolve, reject) => {
      this.tcpSocket.write(message, (error) => {
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

    // 使用保存的服务器主机和 UDP 端口
    if (!this.serverHost || !this.udpPort) {
      throw new Error('Server connection not established');
    }

    return new Promise((resolve, reject) => {
      this.udpSocket.send(message, 0, message.length, this.udpPort, this.serverHost, (error) => {
        if (error) {
          // UDP发送失败，标记UDP为不可用
          this.udpFailed = true;
          if (!this.useTcpVoice) {
            console.log('UDP send failed, falling back to TCP voice transmission');
            this.useTcpVoice = true;
          }
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 发送语音包（自动选择UDP或TCP）
   */
  async sendVoicePacket(packet: Buffer): Promise<void> {
    // console.log(`[ConnectionManager] sendVoicePacket: size=${packet.length}, isUsingTcpVoice=${this.isUsingTcpVoice()}`);

    if (this.isUsingTcpVoice()) {
      // TCP is already TLS-encrypted; no OCB2 encryption needed
      // console.log('[ConnectionManager] Using TCP tunnel for voice (no OCB2)');
      return this.sendTCPVoicePacket(packet);
    } else {
      // UDP requires OCB2 encryption
      let encryptedPacket = packet;
      if (this.client.getCryptoManager().isInitialized()) {
        encryptedPacket = this.client.getCryptoManager().encrypt(packet);
        console.log(`[ConnectionManager] Voice packet encrypted for UDP: ${packet.length} -> ${encryptedPacket.length} bytes`);
      }
      try {
        return await this.sendUDP(encryptedPacket);
      } catch (error) {
        // UDP failed, fall back to TCP (no encryption for TCP)
        console.warn('UDP voice send failed, falling back to TCP:', error);
        this.udpFailed = true;
        this.useTcpVoice = true;
        return this.sendTCPVoicePacket(packet);
      }
    }
  }

  /**
   * 通过TCP隧道发送语音包
   */
  async sendTCPVoicePacket(packet: Buffer): Promise<void> {
    // console.log(`[ConnectionManager] sendTCPVoicePacket: wrapping ${packet.length} bytes as UDPTunnel message`);
    // 使用 UDPTunnel 消息类型 (MessageType = 1)
    const message = this.wrapMessage(MessageType.UDPTunnel, packet);
    // console.log(`[ConnectionManager] sendTCPVoicePacket: sending ${message.length} bytes via TCP`);
    return this.sendTCP(message);
  }

  /**
   * Handle incoming TCP bytes.
   * Frame assembly is delegated to `@munode/client-core` (`FrameAssembler`).
   */
  private handleTCPMessage(data: Buffer): void {
    const frames = this.assembler.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    for (const frame of frames) {
      // Wrap payload back to a Buffer for the existing routeMessage which uses Buffer APIs.
      this.routeMessage(frame.type, Buffer.from(frame.payload));
    }
  }

  /**
   * 路由消息到相应处理器
   */
  private routeMessage(type: number, payload: Buffer): void {
    try {
      switch (type) {
        case MessageType.Version: {
          // 版本消息，通常是服务器发送的第一个消息
          const versionMessage = mumbleproto.Version.decode(payload);
          this.client.emit('version', versionMessage);
          break;
        }

        case MessageType.UDPTunnel:
          // UDP隧道消息，包含音频数据
          this.handleUDPTunnel(payload);
          break;

        case MessageType.Authenticate:
          // 认证消息，客户端发送，服务器不应该回复
          console.warn('Received unexpected Authenticate message from server');
          break;

        case MessageType.Ping: {
          // Ping消息
          const pingMessage = mumbleproto.Ping.decode(payload);
          this.client.emit('ping', pingMessage);
          break;
        }

        case MessageType.Reject: {
          // 拒绝消息 (认证失败)
          // 先调用 handleReject 触发 authenticationFailed 事件（携带类型信息）
          // 再 emit 'reject' 事件让 authenticate() 的 Promise 能直接捕获
          const rejectMessage = mumbleproto.Reject.decode(payload);
          this.client.getAuthManager().handleReject(rejectMessage);
          this.client.emit('reject', rejectMessage);
          break;
        }

        case MessageType.ServerSync: {
          // 服务器同步消息 (认证成功)
          const serverSyncMessage = mumbleproto.ServerSync.decode(payload);
          this.client.getAuthManager().handleServerSync(serverSyncMessage);
          break;
        }

        case MessageType.ChannelRemove: {
          // 频道删除消息
          const channelRemoveMessage = mumbleproto.ChannelRemove.decode(payload);
          this.client.getStateManager().handleChannelRemove(channelRemoveMessage);
          break;
        }

        case MessageType.ChannelState: {
          // 频道状态消息
          const channelStateMessage = mumbleproto.ChannelState.decode(payload);
          this.client.getStateManager().handleChannelState(channelStateMessage);
          break;
        }

        case MessageType.UserRemove: {
          // 用户删除消息
          const userRemoveMessage = mumbleproto.UserRemove.decode(payload);
          this.client.getStateManager().handleUserRemove(userRemoveMessage);
          break;
        }

        case MessageType.UserState: {
          // 用户状态消息
          const userStateMessage = mumbleproto.UserState.decode(payload);
          this.client.getStateManager().handleUserState(userStateMessage);
          break;
        }

        case MessageType.BanList: {
          // 封禁列表消息
          const banListMessage = mumbleproto.BanList.decode(payload);
          this.client.emit('banList', banListMessage);
          break;
        }

        case MessageType.TextMessage: {
          // 文本消息
          const textMessage = mumbleproto.TextMessage.decode(payload);
          this.client.emit('textMessage', textMessage);
          break;
        }

        case MessageType.PermissionDenied: {
          // 权限拒绝消息
          const permissionDeniedMessage = mumbleproto.PermissionDenied.decode(payload);
          this.client.getStateManager().handlePermissionDenied(permissionDeniedMessage);
          break;
        }

        case MessageType.ACL: {
          // ACL消息
          const aclMessage = mumbleproto.ACL.decode(payload);
          this.client.emit('acl', aclMessage);
          break;
        }

        case MessageType.QueryUsers: {
          // 查询用户消息
          const queryUsersMessage = mumbleproto.QueryUsers.decode(payload);
          this.client.emit('queryUsers', queryUsersMessage);
          break;
        }

        case MessageType.CryptSetup: {
          // 加密设置消息
          console.log('[DEBUG] Received CryptSetup message type');
          const cryptSetupMessage = mumbleproto.CryptSetup.decode(payload);
          // 异步处理，但不阻塞消息处理循环
          console.log('Received CryptSetup message, initializing cryptography');
          this.handleCryptSetup(cryptSetupMessage).catch(error => {
            console.error('Failed to handle CryptSetup:', error);
          });
          break;
        }

        case MessageType.ContextActionModify: {
          // 上下文操作修改消息
          const contextActionModifyMessage = mumbleproto.ContextActionModify.decode(payload);
          this.client.emit('contextActionModify', contextActionModifyMessage);
          break;
        }

        case MessageType.ContextAction: {
          // 上下文操作消息
          const contextActionMessage = mumbleproto.ContextAction.decode(payload);
          this.client.emit('contextAction', contextActionMessage);
          break;
        }

        case MessageType.UserList: {
          // 用户列表消息
          const userListMessage = mumbleproto.UserList.decode(payload);
          this.client.emit('userList', userListMessage);
          break;
        }

        case MessageType.VoiceTarget: {
          // 语音目标消息
          const voiceTargetMessage = mumbleproto.VoiceTarget.decode(payload);
          this.client.emit('voiceTarget', voiceTargetMessage);
          break;
        }

        case MessageType.PermissionQuery: {
          // 权限查询消息
          const permissionQueryMessage = mumbleproto.PermissionQuery.decode(payload);
          this.client.emit('permissionQuery', permissionQueryMessage);
          break;
        }

        case MessageType.CodecVersion: {
          // 编解码器版本消息
          const codecVersionMessage = mumbleproto.CodecVersion.decode(payload);
          this.client.emit('codecVersion', codecVersionMessage);
          break;
        }

        case MessageType.UserStats: {
          // 用户统计消息
          const userStatsMessage = mumbleproto.UserStats.decode(payload);
          this.client.emit('userStats', userStatsMessage);
          break;
        }

        case MessageType.RequestBlob: {
          // 请求Blob消息
          const requestBlobMessage = mumbleproto.RequestBlob.decode(payload);
          this.client.emit('requestBlob', requestBlobMessage);
          break;
        }

        case MessageType.ServerConfig: {
          // 服务器配置消息
          const serverConfigMessage = mumbleproto.ServerConfig.decode(payload);
          this.client.getStateManager().handleServerConfig(serverConfigMessage);
          break;
        }

        case MessageType.SuggestConfig: {
          // 建议配置消息
          const suggestConfigMessage = mumbleproto.SuggestConfig.decode(payload);
          this.client.emit('suggestConfig', suggestConfigMessage);
          break;
        }

        case MessageType.PluginDataTransmission: {
          // 插件数据传输消息
          const pluginDataMessage = mumbleproto.PluginDataTransmission.decode(payload);
          this.client.emit('pluginData', pluginDataMessage);
          break;
        }

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

      // 检查是否是 UDP Ping 响应 (type = 1)
      if (decryptedData.length >= 1) {
        const header = decryptedData[0];
        const type = (header >> 5) & 0x07;
        if (type === 1) {
          // UDP Ping 响应，表示 UDP 连接已就绪
          console.log(`[ConnectionManager] UDP Ping response received, useTcpVoice=${this.useTcpVoice}`);
          this.client.emit('udpReady');
          return;
        }
      }

      // 2. 解析音频包
      const packetInfo = this.parseVoicePacket(decryptedData);
      if (!packetInfo) {
        console.warn('Failed to parse voice packet');
        return;
      }

      // 触发 voice 事件供测试使用
      this.client.emit('voice', {
        session: packetInfo.sessionId,
        codec: packetInfo.codec,
        target: packetInfo.target,
        sequence: packetInfo.sequence,
        data: packetInfo.audioData
      });

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
   * 包装消息 (添加消息类型和长度头) — delegates to client-core's `wrapFrame`.
   */
  wrapMessage(type: number, data: Uint8Array): Buffer {
    return Buffer.from(wrapFrame(type, data));
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
    // UDP隧道消息包含音频数据
    // 注意：根据 Mumble 协议，UDPTunnel 消息的 payload 直接就是语音包数据
    // 不需要 protobuf 反序列化，这是一个性能优化
    try {
      const packetBuffer = payload;
      
      if (packetBuffer.length === 0) {
        console.warn('Received empty UDP tunnel packet');
        return;
      }
      
      // TCP tunnel voice packets are NOT encrypted with OCB2-AES128.
      // The TCP connection is already protected by TLS, so the voice data
      // arrives in plaintext.  Only actual UDP packets need OCB2 decryption.
      const decryptedData: Buffer = packetBuffer;
      
      // 解析语音包
      const voiceInfo = this.parseVoicePacket(decryptedData);
      
      if (voiceInfo) {
        // 发射 voice 事件供应用层使用
        this.client.emit('voice', {
          session: voiceInfo.sessionId,
          codec: voiceInfo.codec,
          target: voiceInfo.target,
          sequence: voiceInfo.sequence,
          data: voiceInfo.audioData,
        });
      }
      
      // 保持向后兼容，继续发射原始 udpTunnel 事件
      this.client.emit('udpTunnel', payload);
    } catch (error) {
      console.debug('Error parsing UDP tunnel message:', error);
      this.client.emit('udpTunnel', payload);
    }
  }

  /**
   * 解析语音包 — delegates to `parseIncomingVoicePacket` from `@munode/client-core`.
   */
  private parseVoicePacket(data: Buffer): VoicePacketInfo | null {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const parsed = parseIncomingVoicePacket(view);
    if (!parsed) return null;
    return {
      sessionId: parsed.sessionId,
      sequence: parsed.sequence,
      target: parsed.target,
      codec: parsed.codec,
      audioData: Buffer.from(parsed.data),
    };
  }

  /**
   * 处理加密设置消息
   */
  private async handleCryptSetup(message: mumbleproto.CryptSetup): Promise<void> {
    // 从CryptSetup消息中提取加密参数
    // 注意：protobuf optional字段需要使用 !== undefined 检查是否设置
    if (message.key !== undefined && message.client_nonce !== undefined && message.server_nonce !== undefined) {
      this.client.getCryptoManager().setKey(
        Buffer.from(message.key),
        Buffer.from(message.client_nonce),
        Buffer.from(message.server_nonce)
      );
      console.log('[ConnectionManager] Cryptographic setup completed');
      this.client.emit('cryptoReady');
      console.log(`[ConnectionManager] useTcpVoice=${this.useTcpVoice}, udpSocket=${!!this.udpSocket}`);
      
      // 初始化 UDP 连接（如果未强制使用 TCP 语音）
      if (!this.useTcpVoice && !this.udpSocket) {
        console.log('[ConnectionManager] Initializing UDP connection...');
        try {
          await this.connectUDP(this.serverHost, this.udpPort);
          console.log('[ConnectionManager] UDP socket established');
          
          // 发送 UDP Ping 包来建立地址映射
          await this.sendUDPPing();
          console.log('[ConnectionManager] UDP Ping sent');
        } catch (error) {
          console.warn('[ConnectionManager] Failed to establish UDP connection, will use TCP for voice:', error);
          this.udpFailed = true;
          this.useTcpVoice = true;
        }
      } else {
        console.log(`[ConnectionManager] Skipping UDP initialization: useTcpVoice=${this.useTcpVoice}, udpSocket=${!!this.udpSocket}`);
      }
      // Still emit cryptoReady even if crypto keys aren't set, so connection can proceed
      this.client.emit('cryptoReady');
    } else {
      console.warn('[ConnectionManager] Incomplete cryptographic setup message', {
        has_key: message.key !== undefined,
        has_client_nonce: message.client_nonce !== undefined,
        has_server_nonce: message.server_nonce !== undefined
      });
      // Still emit cryptoReady so connection can proceed
      this.client.emit('cryptoReady');
    }
  }

  /**
   * 发送 UDP Ping 包
   * UDP Ping 包格式: [type (1 byte)] + [varint timestamp]
   * type = 0x20 (001 << 5, ping type is 1)
   * 参考 C 实现的 encodePingPacket_legacy
   */
  private async sendUDPPing(): Promise<void> {
    if (!this.udpSocket || !this.client.getCryptoManager().isInitialized()) {
      return;
    }

    try {
      // 创建 UDP Ping 包
      // Header: type = 1 (ping) << 5 = 0x20
      const header = 0x20; // 001 00000 (type=1, target=0)
      const timestamp = Date.now(); // 毫秒时间戳
      
      // 编码 timestamp 为 varint (uses client-core's encodeVarint)
      const timestampVarint = Buffer.from(encodeVarint(timestamp));
      
      // 构建 ping 包: [header] + [varint timestamp]
      const pingPacket = Buffer.alloc(1 + timestampVarint.length);
      pingPacket.writeUInt8(header, 0);
      timestampVarint.copy(pingPacket, 1);
      
      // 加密并发送
      const encrypted = this.client.getCryptoManager().encrypt(pingPacket);
      await this.sendUDP(encrypted);
      
      console.debug('UDP Ping sent');
    } catch (error) {
      console.warn('Failed to send UDP Ping:', error);
    }
  }

}
