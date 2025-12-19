import type { Logger } from 'winston';
import { HandlerFactory } from '../core/handler-factory.js';

/**
 * 消息队列条目
 */
interface QueuedMessage {
  messageType: number;
  messageData: Buffer;
}

/**
 * 消息管理器
 * 负责解析和处理客户端消息，以及发送消息给客户端
 */
export class MessageManager {
  private handlerFactory: HandlerFactory;
  private messageBuffers: Map<number, Buffer> = new Map(); // 缓存每个客户端的不完整消息
  private messageQueues: Map<number, QueuedMessage[]> = new Map(); // 连接中客户端的消息队列
  private processingQueues: Set<number> = new Set(); // 正在处理队列的会话ID
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
        
        // 对于正在连接的客户端，使用队列顺序处理消息
        // 对于已认证的客户端，直接处理消息
        const isConnecting = this.isClientConnecting(session_id);
        console.log(`[MESSAGE-QUEUE] session=${session_id}, type=${messageType}, isConnecting=${isConnecting}`);
        
        if (isConnecting) {
          // 异步入队，不等待处理完成
          console.log(`[MESSAGE-QUEUE] Enqueueing message for session ${session_id}, type=${messageType}`);
          void this.enqueueMessage(session_id, messageType, messageData);
        } else {
          // 已认证客户端，直接处理
          this.handlerFactory.messageHandler.handleMessage(session_id, messageType, messageData);
        }
      }
      
      // 所有消息都处理完了，清理缓冲区
      this.messageBuffers.delete(session_id);
    } catch (error) {
        this.logger.error(`Error parsing message from session ${session_id}:`, error);
      this.handlerFactory.clientManager.removeClient(session_id);
    }
  }

  /**
   * 判断客户端是否在连接阶段（需要顺序处理消息）
   */
  private isClientConnecting(session_id: number): boolean {
    const client = this.handlerFactory.clientManager.getClient(session_id);
    if (!client) {
      return false;
    }
    // 如果客户端还没有认证完成（user_id <= 0），则认为处于连接阶段
    return !client.user_id || client.user_id <= 0;
  }

  /**
   * 将消息添加到队列并开始处理
   */
  private async enqueueMessage(session_id: number, messageType: number, messageData: Buffer): Promise<void> {
    // 获取或创建队列
    let queue = this.messageQueues.get(session_id);
    if (!queue) {
      queue = [];
      this.messageQueues.set(session_id, queue);
    }

    // 添加消息到队列
    queue.push({ messageType, messageData });

    // 如果没有正在处理，开始处理队列
    if (!this.processingQueues.has(session_id)) {
      await this.processMessageQueue(session_id);
    }
  }

  /**
   * 按顺序处理消息队列
   */
  private async processMessageQueue(session_id: number): Promise<void> {
    // 标记正在处理
    this.processingQueues.add(session_id);

    try {
      const queue = this.messageQueues.get(session_id);
      if (!queue) {
        return;
      }

      // 逐个处理队列中的消息
      while (queue.length > 0) {
        const message = queue.shift();
        if (!message) {
          break;
        }

        // 检查客户端是否还在连接
        const client = this.handlerFactory.clientManager.getClient(session_id);
        if (!client) {
          // 客户端已断开，清理队列
          this.messageQueues.delete(session_id);
          break;
        }

        console.log(
          `[MESSAGE-QUEUE] Processing queued message: session=${session_id}, type=${message.messageType}, queue_length=${queue.length}`
        );

        // 同步处理消息
        try {
          this.handlerFactory.messageHandler.handleMessage(
            session_id,
            message.messageType,
            message.messageData
          );
          
          // 添加短暂延迟以确保状态更新已完成
          // 特别是对于 UserState 消息，需要确保 PreConnect 状态已保存
          await new Promise(resolve => setTimeout(resolve, 10));
        } catch (error) {
          this.logger.error(`Error processing queued message for session ${session_id}:`, error);
        }

        // 如果客户端已经完成认证，停止使用队列
        if (!this.isClientConnecting(session_id)) {
          this.logger.debug(`Client ${session_id} authenticated, clearing message queue`);
          this.messageQueues.delete(session_id);
          break;
        }
      }

      // 如果队列空了，删除队列
      if (queue && queue.length === 0) {
        this.messageQueues.delete(session_id);
      }
    } finally {
      // 移除处理标记
      this.processingQueues.delete(session_id);
    }
  }

  /**
   * 清理客户端的消息缓冲区和队列（在客户端断开时调用）
   */
  clearClientBuffer(session_id: number): void {
    this.messageBuffers.delete(session_id);
    this.messageQueues.delete(session_id);
    this.processingQueues.delete(session_id);
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