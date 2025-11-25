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

    // 监听VoiceRouter的广播事件
    this.handlerFactory.voiceRouter.on('broadcastToChannel', (channel_id: number, broadcast: any, _excludeSession: number) => {
      logger.debug(`Received broadcastToChannel event for channel ${channel_id}, sender ${broadcast.sender_id}`);

      // 在集群模式下，通过UDP直接转发语音包到其他Edge
      // 获取所有目标频道（包括链接频道）中有用户的 Edge 列表
      const targetChannels = new Set<number>();
      targetChannels.add(channel_id);
      
      // 获取所有链接的频道（包括传递链接）
      const linkedChannels = this.handlerFactory.channelManager.getAllLinkedChannels(channel_id);
      for (const linkedId of linkedChannels) {
        targetChannels.add(linkedId);
      }
      
      logger.debug(`PTT broadcast: channel ${channel_id} + ${linkedChannels.size} linked channels: [${Array.from(targetChannels).join(', ')}]`);
      
      // 收集所有目标频道中有用户的Edge
      const targetEdges = new Set<number>();
      for (const channelId of targetChannels) {
        const edgesInChannel = this.handlerFactory.stateManager.getEdgesInChannel(channelId);
        for (const edgeId of edgesInChannel) {
          targetEdges.add(edgeId);
        }
      }
      
      logger.debug(`Target edges for PTT in ${targetChannels.size} channels: ${Array.from(targetEdges)}`);

      if (targetEdges.size === 0) {
        logger.debug(`Skip voice broadcast: no remote users in channel ${channel_id}`);
        return;
      }

      // 从 Mumble 语音包中提取 codec（第一个字节的高3位）
      const header = broadcast.packet.readUInt8(0);
      const codec = (header >> 5) & 0x07;

      const voicePacket = {
        version: 1,
        senderId: broadcast.sender_id,
        targetId: channel_id, // 使用频道ID作为targetId
        sequence: 0, // 序列号在 Mumble 包内部
        codec: codec,
      };

      // 只向有该频道用户的 Edge 发送语音包
      for (const targetEdgeId of targetEdges) {
        if (targetEdgeId !== this.config.server_id) {
          logger.debug(`Forwarding voice to edge ${targetEdgeId}`);
          try {
            this.voiceTransport.sendToEdge(targetEdgeId, voicePacket, broadcast.packet);
            logger.debug(`Sent voice packet to edge ${targetEdgeId}`);
          } catch (error) {
            logger.error(`Failed to send voice to edge ${targetEdgeId}:`, error);
          }
        } else {
          logger.debug(`Skipping self edge ${targetEdgeId}`);
        }
      }

      logger.debug(
        `Forwarded voice to ${targetEdges.size} edges in channel ${channel_id}: ` +
        `sender=${broadcast.sender_id}, codec=${codec}, packet_size=${broadcast.packet.length}, ` +
        `targets=[${Array.from(targetEdges).join(',')}]`
      );

    });

    this.handlerFactory.voiceRouter.on('broadcastToServer', (broadcast: any, excludeSession: number) => {
      if (!this.voiceTransport) {
        return;
      }

      // 广播到所有其他Edge（服务器广播）
      logger.debug(`Broadcasting voice to server via UDP, excluding session ${excludeSession}`);

      const voicePacket = {
        version: 1,
        senderId: broadcast.sender_id,
        targetId: 0xFFFFFFFF, // 服务器广播标记
        sequence: 0,
        codec: 0,
      };

      this.voiceTransport.broadcast(voicePacket, broadcast.packet, this.config.server_id);
    });

    // 监听接收到的UDP语音包（来自其他Edge）
    this.voiceTransport.on('voice-packet', (packetData: { header: any; voiceData: Buffer }) => {
      // 将接收到的语音包路由到本地客户端
      const { header, voiceData } = packetData;
      logger.debug(
        `Received UDP voice packet: ` +
        `sender_edge=${header.senderId}, target=${header.targetId}, ` +
        `codec=${header.codec}, data_size=${voiceData.length}`
      );

      // voiceData是完整的Mumble语音包（header+session+sequence+voice_data）
      // 需要根据targetId确定广播目标
      if (header.targetId === 0xFFFFFFFF) {
        // 服务器广播 - 转发给所有本地用户
        this.handleRemoteServerVoiceBroadcast(voiceData);
      } else if (header.targetId >= 0) {
        // 频道广播（targetId 是频道ID）或普通广播（targetId=0）
        // 转发给本地所有可以接收的客户端
        this.handleRemoteChannelVoiceBroadcast(voiceData);
      } else {
        logger.warn(`Unexpected targetId: ${header.targetId}`);
      }
    });

    this.voiceTransport.on('error', (error: Error) => {
      logger.error('Voice UDP transport error:', error);
    });

    logger.debug('Voice transport handlers setup complete');
  }

  /**
   * 处理来自其他Edge的频道语音广播（通过UDP）
   * 
   * 重要：不要在这里重复实现路由逻辑！
   * 应该解析语音包，然后让VoiceRouter使用统一的路由逻辑处理。
   */
  private handleRemoteChannelVoiceBroadcast(voiceData: Buffer): void {
    try {
      // voiceData格式: [header][session_varint][sequence_varint][voice_data]
      // 这是完整的 Mumble 语音包格式

      // 解析语音包以获取关键信息
      if (voiceData.length < 2) {
        logger.warn('Remote voice packet too short');
        return;
      }

      // 解析header
      const header = voiceData.readUInt8(0);
      const codec = (header >> 5) & 0x07;
      const target = header & 0x1f;

      // 解析session（发送者）
      const senderSession = this.parseSessionFromVoicePacket(voiceData);
      if (senderSession === null) {
        logger.warn('Failed to parse session from remote voice packet');
        return;
      }

      // 从远程用户列表中获取发送者信息
      const remoteUser = this.handlerFactory.stateManager.getRemoteUserInfo(senderSession);
      if (!remoteUser) {
        logger.warn(`Remote user ${senderSession} not found in state`);
        return;
      }

      logger.debug(`Received remote voice: session=${senderSession}, target=${target}, codec=${codec}, channel=${remoteUser.channel_id}`);

      // 构造VoicePacket对象（仅用于携带元数据）
      // 注意：远程语音包已经是完整的序列化格式 [header][session][sequence][data]
      // 我们只需要提取元数据，实际转发时使用原始的 voiceData
      const voicePacket = {
        sender_session: senderSession,
        target,
        sequence: 0, // VoiceRouter不使用这个字段
        codec,
        data: Buffer.alloc(0), // 远程包不需要这个字段，因为我们会传递serializedData
        timestamp: Date.now(),
      };

      // 让VoiceRouter使用统一的路由逻辑处理
      // 传递原始的 voiceData 作为已序列化的数据，避免重复序列化
      this.handlerFactory.voiceRouter.routeRemoteVoicePacket(voicePacket, remoteUser.channel_id, voiceData);
    } catch (error) {
      logger.error('Error handling remote channel voice broadcast:', error);
    }
  }

  /**
   * 处理来自其他Edge的服务器语音广播（通过UDP）
   */
  private handleRemoteServerVoiceBroadcast(voiceData: Buffer): void {
    try {
      logger.debug('Received remote server voice broadcast');

      // 服务器广播：转发给所有本地用户
      const allClients = this.handlerFactory.clientManager.getAllClients();

      for (const client of allClients) {
        if (client.deaf || client.self_deaf) {
          continue;
        }

        if (!client.user_id || client.user_id <= 0) {
          continue;
        }

        this.handlerFactory.voiceRouter.sendVoicePacketToClient(client, voiceData);
      }

      logger.debug(`Forwarded remote server broadcast to ${allClients.length} local clients`);
    } catch (error) {
      logger.error('Error handling remote server voice broadcast:', error);
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