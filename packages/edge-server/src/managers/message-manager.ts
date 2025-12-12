import type { Logger } from 'winston';
import { HandlerFactory } from '../core/handler-factory.js';

/**
 * 消息管理器
 * 负责解析和处理客户端消息，以及发送消息给客户端
 */
export class MessageManager {
  private handlerFactory: HandlerFactory;
  private messageBuffers: Map<number, Buffer> = new Map(); // 缓存每个客户端的不完整消息
  private logger: Logger;

  constructor(handlerFactory: HandlerFactory) {
    this.handlerFactory = handlerFactory;
    this.logger = handlerFactory.logger;
  }

  /**
   * 解析并处理 Mumble 协议消息
   */
  parseAndHandleMessage(session_id: number, data: Buffer): void {
    try {
      // 获取或创建该会话的缓冲区
      const existingBuffer = this.messageBuffers.get(session_id);
      const buffer = existingBuffer ? Buffer.concat([existingBuffer, data]) : data;
      
      let offset = 0;
      const client = this.handlerFactory.clientManager.getClient(session_id);

      if (!client) {
        this.logger.warn(`Received data for unknown session: ${session_id}`);
        this.messageBuffers.delete(session_id); // 清理缓冲区
        return;
      }

      // Mumble 协议：每条消息的格式是 [type(2字节)][length(4字节)][data(length字节)]
      while (offset < buffer.length) {
        if (offset + 6 > buffer.length) {
          // 数据不完整，保存到缓冲区等待更多数据
        this.logger.debug(
            `Incomplete message header from session ${session_id}, offset=${offset}, length=${buffer.length}, buffering...`
          );
          this.messageBuffers.set(session_id, buffer.subarray(offset));
          return;
        }

        // 读取消息类型 (2字节，大端序)
        const messageType = buffer.readUInt16BE(offset);
        offset += 2;

        // 读取消息长度 (4字节，大端序)
        const messageLength = buffer.readUInt32BE(offset);
        offset += 4;

        // 检查消息长度是否合法
        if (messageLength > 10000000) {
        this.logger.error(
            `Oversized message from session ${session_id}: type=${messageType}, length=${messageLength}`
          );
          this.messageBuffers.delete(session_id); // 清理缓冲区
          this.handlerFactory.clientManager.removeClient(session_id);
          return;
        }

        if (offset + messageLength > buffer.length) {
          // 消息体不完整，保存到缓冲区等待更多数据
        this.logger.debug(
            `Incomplete message body from session ${session_id}, type=${messageType}, expected=${messageLength}, available=${buffer.length - offset}, buffering...`
          );
          // 保存从消息开始的所有数据（包括头部）
          this.messageBuffers.set(session_id, buffer.subarray(offset - 6));
          return;
        }

        // 提取消息数据
        const messageData = buffer.subarray(offset, offset + messageLength);
        offset += messageLength;

        // 处理消息
        this.logger.debug(
          `Received message(tcp): session=${session_id}, type=${messageType}, length=${messageLength}`
        );
        this.handlerFactory.messageHandler.handleMessage(session_id, messageType, messageData);
      }
      
      // 所有消息都处理完了，清理缓冲区
      this.messageBuffers.delete(session_id);
    } catch (error) {
        this.logger.error(`Error parsing message from session ${session_id}:`, error);
      this.handlerFactory.clientManager.removeClient(session_id);
    }
  }

  /**
   * 清理客户端的消息缓冲区（在客户端断开时调用）
   */
  clearClientBuffer(session_id: number): void {
    this.messageBuffers.delete(session_id);
  }

  /**
   * 发送消息给客户端
   */
  sendMessageToClient(session_id: number, messageType: number, messageData: Buffer): void {
    try {
      const socket = this.handlerFactory.clientManager.getSocket(session_id);
      if (!socket) {
        this.logger.warn(`Cannot send message to unknown session: ${session_id}`);
        return;
      }

      // 构造 Mumble 协议消息：[type(2字节)][length(4字节)][data]
      const header = Buffer.allocUnsafe(6);
      header.writeUInt16BE(messageType, 0);
      header.writeUInt32BE(messageData.length, 2);

      // 发送消息
      socket.write(header);
      socket.write(messageData);

        this.logger.debug(
        `Sent message: session=${session_id}, type=${messageType}, length=${messageData.length}`
      );
    } catch (error) {
        this.logger.error(`Error sending message to session ${session_id}:`, error);
      this.handlerFactory.clientManager.removeClient(session_id);
    }
  }
}