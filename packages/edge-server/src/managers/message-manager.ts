import { logger } from '@munode/common';
import { HandlerFactory } from '../core/handler-factory.js';

/**
 * 消息管理器
 * 负责解析和处理客户端消息，以及发送消息给客户端
 */
export class MessageManager {
  private handlerFactory: HandlerFactory;

  constructor(handlerFactory: HandlerFactory) {
    this.handlerFactory = handlerFactory;
  }

  /**
   * 解析并处理 Mumble 协议消息
   */
  parseAndHandleMessage(session_id: number, data: Buffer): void {
    try {
      let offset = 0;
      const client = this.handlerFactory.clientManager.getClient(session_id);

      if (!client) {
        logger.warn(`Received data for unknown session: ${session_id}`);
        return;
      }

      // Mumble 协议：每条消息的格式是 [type(2字节)][length(4字节)][data(length字节)]
      while (offset < data.length) {
        if (offset + 6 > data.length) {
          // 数据不完整，等待更多数据
          logger.warn(
            `Incomplete message from session ${session_id}, offset=${offset}, length=${data.length}`
          );
          break;
        }

        // 读取消息类型 (2字节，大端序)
        const messageType = data.readUInt16BE(offset);
        offset += 2;

        // 读取消息长度 (4字节，大端序)
        const messageLength = data.readUInt32BE(offset);
        offset += 4;

        // 检查消息长度是否合法
        if (messageLength > 10000000) {
          logger.error(
            `Oversized message from session ${session_id}: type=${messageType}, length=${messageLength}`
          );
          this.handlerFactory.clientManager.removeClient(session_id);
          return;
        }

        if (offset + messageLength > data.length) {
          // 消息体不完整，等待更多数据
          logger.warn(
            `Incomplete message body from session ${session_id}, type=${messageType}, expected=${messageLength}, available=${data.length - offset}`
          );
          break;
        }

        // 提取消息数据
        const messageData = data.subarray(offset, offset + messageLength);
        offset += messageLength;

        // 处理消息
        logger.debug(
          `Received message(tcp): session=${session_id}, type=${messageType}, length=${messageLength}`
        );
        this.handlerFactory.messageHandler.handleMessage(session_id, messageType, messageData);
      }
    } catch (error) {
      logger.error(`Error parsing message from session ${session_id}:`, error);
      this.handlerFactory.clientManager.removeClient(session_id);
    }
  }

  /**
   * 发送消息给客户端
   */
  sendMessageToClient(session_id: number, messageType: number, messageData: Buffer): void {
    try {
      const socket = this.handlerFactory.clientManager.getSocket(session_id);
      if (!socket) {
        logger.warn(`Cannot send message to unknown session: ${session_id}`);
        return;
      }

      // 构造 Mumble 协议消息：[type(2字节)][length(4字节)][data]
      const header = Buffer.allocUnsafe(6);
      header.writeUInt16BE(messageType, 0);
      header.writeUInt32BE(messageData.length, 2);

      // 发送消息
      socket.write(header);
      socket.write(messageData);

      logger.debug(
        `Sent message: session=${session_id}, type=${messageType}, length=${messageData.length}`
      );
    } catch (error) {
      logger.error(`Error sending message to session ${session_id}:`, error);
      this.handlerFactory.clientManager.removeClient(session_id);
    }
  }
}