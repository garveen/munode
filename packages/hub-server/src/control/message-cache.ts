/**
 * 消息缓存
 *
 * 缓存广播消息给断开的Edge服务器：
 * - 限制缓存大小和时间
 * - FIFO淘汰策略
 * - 支持按Edge ID缓存
 */

export interface CachedMessage {
  id: string;
  type: string;
  method: string;
  params: any;
  timestamp: number;
  sequence: number; // 消息序列号，用于排序
}

export interface MessageCacheConfig {
  maxMessagesPerEdge: number;     // 每个Edge的最大缓存消息数
  maxCacheTime: number;          // 最大缓存时间（毫秒）
  cleanupInterval: number;       // 清理间隔（毫秒）
}

export class MessageCache {
  private cache = new Map<number, CachedMessage[]>(); // edgeId -> messages
  private messageSequence = 0;
  private cleanupTimer?: NodeJS.Timeout;
  private config: MessageCacheConfig;

  constructor(config: Partial<MessageCacheConfig> = {}) {
    this.config = {
      maxMessagesPerEdge: 1000,
      maxCacheTime: 10 * 60 * 1000, // 10分钟
      cleanupInterval: 60 * 1000,   // 1分钟
      ...config,
    };

    this.startCleanupTimer();
  }

  /**
   * 缓存消息给指定的Edge
   */
  cacheMessage(edgeId: number, message: Omit<CachedMessage, 'sequence'>): void {
    if (!this.cache.has(edgeId)) {
      this.cache.set(edgeId, []);
    }

    const messages = this.cache.get(edgeId)!;
    const cachedMessage: CachedMessage = {
      ...message,
      sequence: ++this.messageSequence,
    };

    messages.push(cachedMessage);

    // 限制缓存大小
    if (messages.length > this.config.maxMessagesPerEdge) {
      messages.shift(); // 移除最旧的消息
    }
  }

  /**
   * 广播消息给所有Edge（自动缓存给断开的Edge）
   */
  broadcastMessage(
    message: Omit<CachedMessage, 'sequence'>,
    connectedEdges: Set<number>
  ): void {
    // 给所有Edge缓存消息
    for (const edgeId of this.cache.keys()) {
      this.cacheMessage(edgeId, message);
    }

    // 给新连接的Edge也创建缓存
    for (const edgeId of connectedEdges) {
      if (!this.cache.has(edgeId)) {
        this.cache.set(edgeId, []);
        this.cacheMessage(edgeId, message);
      }
    }
  }

  /**
   * 获取Edge的缓存消息
   */
  getCachedMessages(edgeId: number): CachedMessage[] {
    const messages = this.cache.get(edgeId) || [];
    return [...messages].sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * 清空Edge的缓存消息
   */
  clearCache(edgeId: number): CachedMessage[] {
    const messages = this.cache.get(edgeId) || [];
    this.cache.delete(edgeId);
    return messages;
  }

  /**
   * Edge重连成功后，获取并清空缓存
   */
  getAndClearCache(edgeId: number): CachedMessage[] {
    const messages = this.getCachedMessages(edgeId);
    this.clearCache(edgeId);
    return messages;
  }

  /**
   * 检查Edge是否有缓存消息
   */
  hasCache(edgeId: number): boolean {
    const messages = this.cache.get(edgeId);
    return messages ? messages.length > 0 : false;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    totalEdges: number;
    totalMessages: number;
    messagesPerEdge: Record<number, number>;
    oldestMessage?: number;
    newestMessage?: number;
  } {
    const messagesPerEdge: Record<number, number> = {};
    let totalMessages = 0;
    let oldestMessage: number | undefined;
    let newestMessage: number | undefined;

    for (const [edgeId, messages] of this.cache) {
      messagesPerEdge[edgeId] = messages.length;
      totalMessages += messages.length;

      for (const message of messages) {
        if (!oldestMessage || message.timestamp < oldestMessage) {
          oldestMessage = message.timestamp;
        }
        if (!newestMessage || message.timestamp > newestMessage) {
          newestMessage = message.timestamp;
        }
      }
    }

    return {
      totalEdges: this.cache.size,
      totalMessages,
      messagesPerEdge,
      oldestMessage,
      newestMessage,
    };
  }

  /**
   * 清理过期的缓存消息
   */
  private cleanupExpiredMessages(): void {
    const now = Date.now();
    const maxAge = this.config.maxCacheTime;

    for (const [edgeId, messages] of this.cache) {
      const validMessages = messages.filter(
        message => (now - message.timestamp) <= maxAge
      );

      if (validMessages.length !== messages.length) {
        this.cache.set(edgeId, validMessages);
      }

      // 如果没有有效消息，删除整个Edge的缓存
      if (validMessages.length === 0) {
        this.cache.delete(edgeId);
      }
    }
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredMessages();
    }, this.config.cleanupInterval);
  }

  /**
   * 停止清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 移除Edge的所有缓存
   */
  removeEdge(edgeId: number): void {
    this.cache.delete(edgeId);
  }

  /**
   * 清空所有缓存
   */
  clearAll(): void {
    this.cache.clear();
    this.messageSequence = 0;
  }

  /**
   * 销毁缓存管理器
   */
  destroy(): void {
    this.stopCleanupTimer();
    this.clearAll();
  }
}