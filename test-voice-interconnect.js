#!/usr/bin/env node

/**
 * 语音互联测试脚本
 * 模拟多个客户端连接到不同的Edge服务器，测试语音包转发
 */

import { createLogger } from '@munode/common';
import * as net from 'net';
import * as crypto from 'crypto';

const logger = createLogger({ service: 'voice-interconnect-test' });

/**
 * 简单的Mumble协议客户端
 */
class SimpleMumbleClient {
  private socket: net.Socket;
  private session = 0;
  private authenticated = false;
  private serverId: number;
  private username: string;

  constructor(serverId: number, username: string, host: string, port: number) {
    this.serverId = serverId;
    this.username = username;
    this.socket = new net.Socket();

    this.socket.connect(port, host, () => {
      logger.info(`Client ${username} connected to Edge ${serverId} (${host}:${port})`);
      this.sendVersion();
      this.sendAuthenticate();
    });

    this.socket.on('data', (data) => {
      this.handleMessage(data);
    });

    this.socket.on('error', (error) => {
      logger.error(`Client ${username} error:`, error);
    });

    this.socket.on('close', () => {
      logger.info(`Client ${username} disconnected`);
    });
  }

  private sendVersion() {
    // Mumble version message
    const version = Buffer.alloc(12);
    version.writeUInt32BE(1, 0); // version
    version.writeUInt32BE(0, 4); // release
    version.writeUInt32BE(0, 8); // os

    const message = this.createMessage(0, version); // Version message type = 0
    this.socket.write(message);
  }

  private sendAuthenticate() {
    // Authenticate message
    const auth = Buffer.alloc(4 + this.username.length + 1);
    auth.writeUInt32BE(this.username.length + 1, 0);
    auth.write(this.username, 4);
    auth.writeUInt8(0, 4 + this.username.length); // null terminator

    const message = this.createMessage(2, auth); // Authenticate message type = 2
    this.socket.write(message);
  }

  private createMessage(type: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt16BE(type, 0);
    header.writeUInt32BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  private handleMessage(data: Buffer) {
    let offset = 0;
    while (offset < data.length) {
      if (offset + 6 > data.length) break;

      const type = data.readUInt16BE(offset);
      const length = data.readUInt32BE(offset + 2);
      offset += 6;

      if (offset + length > data.length) break;

      const payload = data.slice(offset, offset + length);
      offset += length;

      this.processMessage(type, payload);
    }
  }

  private processMessage(type: number, payload: Buffer) {
    switch (type) {
      case 0: // Version
        logger.debug(`Client ${this.username} received version`);
        break;
      case 2: // Authenticate response (actually UDPTunnel)
        // This is actually UDPTunnel message containing voice data
        logger.debug(`Client ${this.username} received voice data (${payload.length} bytes)`);
        break;
      case 3: // Ping
        // Send pong
        const pong = this.createMessage(3, payload);
        this.socket.write(pong);
        break;
      case 5: // ServerSync
        this.session = payload.readUInt32BE(0);
        this.authenticated = true;
        logger.info(`Client ${this.username} authenticated with session ${this.session}`);
        break;
      case 7: // ChannelState
        logger.debug(`Client ${this.username} received channel state`);
        break;
      case 9: // UserState
        logger.debug(`Client ${this.username} received user state`);
        break;
      case 12: // ServerConfig
        logger.debug(`Client ${this.username} received server config`);
        break;
      case 15: // PermissionQuery
        logger.debug(`Client ${this.username} received permission query`);
        break;
      default:
        logger.debug(`Client ${this.username} received message type ${type} (${payload.length} bytes)`);
    }
  }

  /**
   * 发送语音包
   */
  sendVoicePacket(codec: number = 4) {
    if (!this.authenticated) {
      logger.warn(`Client ${this.username} not authenticated, cannot send voice`);
      return;
    }

    // 创建简单的语音包
    // Mumble语音包格式: [header][session_varint][sequence_varint][voice_data]
    const header = Buffer.alloc(1);
    header.writeUInt8((codec << 5) | 0x80, 0); // codec in high 3 bits, normal talking flag

    // session = 1 (varint)
    const sessionVarint = Buffer.from([0x01]);

    // sequence = 0 (varint)
    const sequenceVarint = Buffer.from([0x00]);

    // 简单的语音数据 (OPUS frame)
    const voiceData = crypto.randomBytes(20); // 随机数据作为测试

    const voicePayload = Buffer.concat([header, sessionVarint, sequenceVarint, voiceData]);

    // 包装成UDPTunnel消息
    const message = this.createMessage(1, voicePayload); // UDPTunnel type = 1
    this.socket.write(message);

    logger.info(`Client ${this.username} (session ${this.session}) sent voice packet to channel 0`);
  }

  disconnect() {
    this.socket.end();
  }

  isConnected(): boolean {
    return !this.socket.destroyed;
  }
}

/**
 * 运行语音互联测试
 */
async function runVoiceInterconnectTest() {
  logger.info('Starting voice interconnect test...');

  const clients: SimpleMumbleClient[] = [];

  try {
    // 连接客户端到不同的Edge服务器
    // Edge 1: localhost:63000
    const client1 = new SimpleMumbleClient(1, 'testuser1', 'localhost', 63000);
    clients.push(client1);

    // Edge 2: localhost:63002
    const client2 = new SimpleMumbleClient(2, 'testuser2', 'localhost', 63002);
    clients.push(client2);

    // Edge 3: localhost:63004
    const client3 = new SimpleMumbleClient(3, 'testuser3', 'localhost', 63004);
    clients.push(client3);

    // 等待所有客户端连接和认证
    logger.info('Waiting for clients to connect and authenticate...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 检查连接状态
    const connectedClients = clients.filter(c => c.isConnected());
    logger.info(`${connectedClients.length}/${clients.length} clients connected`);

    if (connectedClients.length < 2) {
      logger.error('Not enough clients connected for interconnect test');
      return;
    }

    // 发送语音包测试
    logger.info('Sending voice packets from different clients...');

    // 从第一个客户端发送语音
    if (connectedClients[0]) {
      connectedClients[0].sendVoicePacket();
    }

    // 等待一会儿
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 从第二个客户端发送语音
    if (connectedClients[1]) {
      connectedClients[1].sendVoicePacket();
    }

    // 等待一会儿观察日志
    await new Promise(resolve => setTimeout(resolve, 3000));

    logger.info('Voice interconnect test completed');

  } catch (error) {
    logger.error('Test failed:', error);
  } finally {
    // 断开所有客户端
    logger.info('Disconnecting clients...');
    clients.forEach(client => {
      try {
        client.disconnect();
      } catch (error) {
        logger.error('Error disconnecting client:', error);
      }
    });
  }
}

// 运行测试
runVoiceInterconnectTest().catch(console.error);