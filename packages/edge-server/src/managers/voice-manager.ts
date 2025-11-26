import { logger } from '@munode/common';
import { VoiceUDPTransport } from '@munode/protocol';
import { HandlerFactory } from '../core/handler-factory.js';
import { EdgeConfig } from '../types.js';

/**
 * 语音管理器
 * 负责处理语音数据路由、UDP传输和相关逻辑
 */
export class VoiceManager {
  private config: EdgeConfig;
  private handlerFactory: HandlerFactory;
  private voiceTransport?: VoiceUDPTransport;

  constructor(config: EdgeConfig, handlerFactory: HandlerFactory, voiceTransport?: VoiceUDPTransport) {
    this.config = config;
    this.handlerFactory = handlerFactory;
    this.voiceTransport = voiceTransport;
  }

  /**
   * 获取语音传输实例
   */
  getVoiceTransport(): VoiceUDPTransport | undefined {
    return this.voiceTransport;
  }

  /**
   * 处理来自Hub的语音数据路由
   */
  handleVoiceDataFromHub(data: any, respond: (result?: any, error?: any) => void): void {
    try {
      // TODO: 实现VoiceRouter.handleVoiceDataFromHub方法
      // 处理来自Hub的语音数据，路由到本地客户端
      // this.handlerFactory.voiceRouter.handleVoiceDataFromHub(data);
      logger.debug('Received voice data from Hub:', data);
      respond({ success: true });
    } catch (error) {
      logger.error('Error handling voice data from Hub:', error);
      respond(undefined, { code: -32603, message: 'Internal error' });
    }
  }

  /**
   * 设置语音UDP传输处理器
   * 监听VoiceRouter的广播事件，通过UDP转发到其他Edge
   */
  setupVoiceTransportHandlers(): void {
    if (!this.voiceTransport) {
      logger.debug('Voice transport not available, skipping setup');
      return;
    }

    logger.debug(`Setting up voice transport handlers for server ${this.config.server_id}`);

    // 监听VoiceRouter的统一广播事件
    this.handlerFactory.voiceRouter.on('broadcastVoicePacket', (broadcast: any) => {
      logger.debug(`Received broadcastVoicePacket event: sender=${broadcast.sender_id}, target=${broadcast.target}`);

      // 从 Mumble 语音包中提取 codec
      const header = broadcast.packet.readUInt8(0);
      const codec = (header >> 5) & 0x07;
      const target = header & 0x1f;

      const voicePacket = {
        version: 1,
        senderId: broadcast.sender_id,
        targetId: target,
        sequence: 0,
        codec: codec,
      };

      // 获取所有已注册的Edge
      const allEdges = this.handlerFactory.stateManager.getAllEdges();
      
      // 广播到所有其他Edge
      let sentCount = 0;
      for (const edgeId of allEdges) {
        // 跳过本地Edge（本地用户已经在routeVoicePacket中处理了）
        if (edgeId !== this.config.server_id) {
          try {
            logger.debug(`Sending voice to edge ${edgeId}`);
            this.voiceTransport.sendToEdge(edgeId, voicePacket, broadcast.packet);
            sentCount++;
            logger.debug(`Sent voice packet to edge ${edgeId}`);
          } catch (error) {
            logger.error(`Failed to send voice to edge ${edgeId}:`, error);
          }
        } else {
          logger.debug(`Skipping local edge ${edgeId}`);
        }
      }

      logger.debug(
        `Broadcasted voice to ${sentCount} edges: ` +
        `sender=${broadcast.sender_id}, target=${target}, codec=${codec}, packet_size=${broadcast.packet.length}`
      );
    });

    // 监听接收到的UDP语音包（来自其他Edge）
    this.voiceTransport.on('voice-packet', (packet: any, _rinfo: any) => {
      const { header, voiceData } = packet;
      logger.debug(
        `[VOICE-REMOTE] Received voice packet: ` +
        `sender_edge=${header.senderId}, target=${header.targetId}, ` +
        `codec=${header.codec}, data_size=${voiceData.length}`
      );

      // voiceData是完整的Mumble语音包（header+session+sequence+voice_data）
      // targetId 是 Mumble 原始 target 值：0=PTT, 1-30=whisper, 31=loopback
      
      // 忽略loopback包（远程用户的loopback不应该到达这里）
      if (header.targetId === 31) {
        logger.debug(`[VOICE-REMOTE] Ignoring remote loopback packet`);
        return;
      }

      // 统一处理所有远程语音包
      this.handleRemoteVoicePacket(voiceData, header.targetId);
    });

    this.voiceTransport.on('error', (error: Error) => {
      logger.error('Voice UDP transport error:', error);
    });

    logger.debug('Voice transport handlers setup complete');
  }

  /**
   * 处理来自其他Edge的语音包
   */
  private handleRemoteVoicePacket(voiceData: Buffer, targetId: number): void {
    try {
      logger.debug(`[VOICE-REMOTE] Processing remote voice packet, target=${targetId}, size=${voiceData.length}`);
      
      // 解析发送者session
      const senderSession = this.parseSessionFromVoicePacket(voiceData);
      if (senderSession === null) {
        logger.warn('[VOICE-REMOTE] Failed to parse session from remote voice packet');
        return;
      }

      // 解析codec（从Mumble包头）
      const header = voiceData.readUInt8(0);
      const codec = (header >> 5) & 0x07;

      // 对于PTT需要发送者频道信息来计算链接频道
      let senderChannelId = 0;
      
      if (targetId === 0) {
        const remoteUser = this.handlerFactory.stateManager.getRemoteUserInfo(senderSession);
        if (!remoteUser) {
          logger.warn(
            `[VOICE-REMOTE] PTT packet from unknown remote user ${senderSession}, ` +
            `cannot determine sender channel`
          );
          return;
        }
        senderChannelId = remoteUser.channel_id;
      }

      logger.info(
        `[VOICE-REMOTE] Routing remote voice: ` +
        `session=${senderSession}, target=${targetId}, channel=${senderChannelId}, codec=${codec}`
      );

      // 构造VoicePacket对象
      const voicePacket = {
        sender_session: senderSession,
        target: targetId,
        sequence: 0,
        codec,
        data: Buffer.alloc(0), // 不需要，因为我们传递了serializedData
        timestamp: Date.now(),
      };

      // 让VoiceRouter使用统一的路由逻辑处理
      // 传递voiceData作为已序列化的数据，避免重复序列化
      this.handlerFactory.voiceRouter.routeRemoteVoicePacket(
        voicePacket,
        senderChannelId,
        voiceData
      );
    } catch (error) {
      logger.error('[VOICE-REMOTE] Error handling remote voice packet:', error);
    }
  }

  /**
   * 从语音包中解析session ID
   */
  private parseSessionFromVoicePacket(data: Buffer): number | null {
    if (data.length < 2) {
      return null;
    }

    // 跳过header（1字节）
    let offset = 1;

    // 解析varint格式的session ID
    const v = data.readUInt8(offset);

    if ((v & 0x80) === 0x00) {
      // 单字节
      return v & 0x7f;
    } else if ((v & 0xc0) === 0x80) {
      // 双字节
      if (offset + 1 >= data.length) return null;
      return ((v & 0x3f) << 8) | data.readUInt8(offset + 1);
    } else if ((v & 0xf0) === 0xf0) {
      // 完整32位整数
      if (offset + 4 >= data.length) return null;
      return (
        (data.readUInt8(offset + 1) << 24) |
        (data.readUInt8(offset + 2) << 16) |
        (data.readUInt8(offset + 3) << 8) |
        data.readUInt8(offset + 4)
      ) >>> 0;
    } else if ((v & 0xe0) === 0xc0) {
      // 3字节
      if (offset + 2 >= data.length) return null;
      return ((v & 0x1f) << 16) | (data.readUInt8(offset + 1) << 8) | data.readUInt8(offset + 2);
    }

    return null;
  }
}