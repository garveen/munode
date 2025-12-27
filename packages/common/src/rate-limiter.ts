/**
 * 速率限制器 - 漏桶算法实现
 * 
 * 基于 C++ Mumble 服务器的漏桶算法实现
 * 用于限制消息发送频率，防止滥用和 DoS 攻击
 */

/**
 * 漏桶配置
 */
export interface LeakyBucketConfig {
  /** 最大令牌数 (burst size) */
  capacity: number;
  /** 每秒恢复的令牌数 (rate) */
  tokensPerSecond: number;
}

/**
 * 漏桶速率限制器
 * 
 * 算法原理:
 * - 桶有固定容量 (capacity)
 * - 令牌以固定速率恢复 (tokensPerSecond)
 * - 每个操作消耗指定数量的令牌
 * - 如果令牌不足，操作被限制
 * 
 * 这允许突发流量 (burst) 但限制长期平均速率
 */
export class LeakyBucket {
  private tokens: number;
  private lastUpdate: number;
  private readonly capacity: number;
  private readonly tokensPerSecond: number;

  constructor(config: LeakyBucketConfig) {
    this.capacity = config.capacity;
    this.tokensPerSecond = config.tokensPerSecond;
    this.tokens = config.capacity; // 初始时桶是满的
    this.lastUpdate = Date.now();
  }

  /**
   * 尝试消耗指定数量的令牌
   * 
   * @param tokens 要消耗的令牌数，默认为 1
   * @returns 如果成功消耗返回 false，如果超出限制返回 true
   */
  ratelimit(tokens: number = 1): boolean {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return false; // 未被限制
    }

    return true; // 被限制
  }

  /**
   * 检查是否会被限制（不消耗令牌）
   * 
   * @param tokens 要检查的令牌数
   * @returns 如果会被限制返回 true
   */
  wouldRatelimit(tokens: number = 1): boolean {
    this.refill();
    return this.tokens < tokens;
  }

  /**
   * 根据时间流逝补充令牌
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastUpdate) / 1000; // 转换为秒

    if (elapsed > 0) {
      const newTokens = elapsed * this.tokensPerSecond;
      this.tokens = Math.min(this.capacity, this.tokens + newTokens);
      this.lastUpdate = now;
    }
  }

  /**
   * 获取当前可用令牌数
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * 重置漏桶到满状态
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastUpdate = Date.now();
  }

  /**
   * 获取配置信息
   */
  getConfig(): LeakyBucketConfig {
    return {
      capacity: this.capacity,
      tokensPerSecond: this.tokensPerSecond,
    };
  }
}

/**
 * 多类型速率限制器
 * 
 * 为不同类型的操作使用不同的漏桶
 * 例如: 普通消息、插件消息、命令等
 */
export class MultiTypeRateLimiter {
  private readonly buckets: Map<string, LeakyBucket>;

  constructor() {
    this.buckets = new Map();
  }

  /**
   * 注册一个速率限制器
   * 
   * @param type 限制器类型
   * @param config 漏桶配置
   */
  register(type: string, config: LeakyBucketConfig): void {
    this.buckets.set(type, new LeakyBucket(config));
  }

  /**
   * 检查指定类型的操作是否被限制
   * 
   * @param type 限制器类型
   * @param tokens 要消耗的令牌数
   * @returns 如果被限制返回 true
   */
  ratelimit(type: string, tokens: number = 1): boolean {
    const bucket = this.buckets.get(type);
    if (!bucket) {
      // 如果没有为该类型注册限制器，不限制
      return false;
    }
    return bucket.ratelimit(tokens);
  }

  /**
   * 检查是否会被限制（不消耗令牌）
   */
  wouldRatelimit(type: string, tokens: number = 1): boolean {
    const bucket = this.buckets.get(type);
    if (!bucket) {
      return false;
    }
    return bucket.wouldRatelimit(tokens);
  }

  /**
   * 重置指定类型的限制器
   */
  reset(type: string): void {
    const bucket = this.buckets.get(type);
    if (bucket) {
      bucket.reset();
    }
  }

  /**
   * 重置所有限制器
   */
  resetAll(): void {
    for (const bucket of this.buckets.values()) {
      bucket.reset();
    }
  }

  /**
   * 获取所有注册的限制器类型
   */
  getTypes(): string[] {
    return Array.from(this.buckets.keys());
  }

  /**
   * 获取指定类型的可用令牌数
   */
  getAvailableTokens(type: string): number | undefined {
    const bucket = this.buckets.get(type);
    return bucket?.getAvailableTokens();
  }
}

/**
 * 默认的速率限制配置
 * 
 * 基于 C++ Mumble 服务器的默认值
 */
export const DEFAULT_RATE_LIMITS = {
  /** 普通消息限制: 10条/秒，最多突发30条 */
  message: {
    capacity: 30,
    tokensPerSecond: 10,
  },
  /** 插件消息限制: 5条/秒，最多突发15条 */
  pluginMessage: {
    capacity: 15,
    tokensPerSecond: 5,
  },
  /** 命令限制: 2条/秒，最多突发5条 */
  command: {
    capacity: 5,
    tokensPerSecond: 2,
  },
  /** 状态更新限制: 5条/秒，最多突发10条 */
  stateUpdate: {
    capacity: 10,
    tokensPerSecond: 5,
  },
} as const;
