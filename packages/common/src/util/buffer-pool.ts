/**
 * Buffer 池 - 用于复用常见大小的 Buffer，减少 GC 压力
 * 
 * 性能优化：语音包通常在 50-350 字节范围内，复用这些 Buffer 可以显著减少分配和 GC
 * 
 * Mumble 语音包大小分析：
 * - 持续时间：10-60ms
 * - 码率：10-40kbps
 * - 原始载荷：~50-300字节
 * - 带头部/加密：~70-350字节
 */

interface PoolEntry {
  buffer: Buffer;
  inUse: boolean;
  acquireCount: number; // 被获取的总次数（用于统计）
  lastUsed: number; // 最后使用时间戳
}

/**
 * Buffer 池统计信息
 */
export interface BufferPoolStats {
  poolSize: number;
  total: number;
  inUse: number;
  available: number;
  acquireCount: number; // 总获取次数
  hitRate: number; // 命中率（从池中获取 vs 新建）
}

export class BufferPool {
  private pools: Map<number, PoolEntry[]> = new Map();
  private maxPoolSize: number;
  
  // 常见的语音包大小（字节）- 针对 Mumble 协议优化
  private static readonly COMMON_SIZES = [128, 256, 512];
  
  // 统计信息
  private stats: Map<number, { acquires: number; misses: number }> = new Map();
  
  constructor(maxPoolSize: number = 100) {
    this.maxPoolSize = maxPoolSize;
    
    // 预分配常见大小的 Buffer 池
    for (const size of BufferPool.COMMON_SIZES) {
      this.pools.set(size, []);
      this.stats.set(size, { acquires: 0, misses: 0 });
    }
  }
  
  /**
   * 获取指定大小的 Buffer
   * 如果池中有可用的，返回池中的；否则创建新的
   * 
   * @param size 需要的 Buffer 大小
   * @param zeroFill 是否需要零填充（默认 false，性能更好）
   * @returns Buffer 实例（可能是池中的或新创建的）
   * 
   * 性能优化：
   * - 使用反向遍历以提高查找效率（最近释放的更可能被重用）
   * - 避免不必要的时间戳更新
   */
  acquire(size: number, zeroFill: boolean = false): Buffer {
    // 找到最接近且大于等于请求大小的池
    const poolSize = this.findNearestPoolSize(size);
    
    if (poolSize === -1) {
      // 没有合适的池，直接分配
      const stat = this.stats.get(0) || { acquires: 0, misses: 0 };
      stat.misses++;
      return zeroFill ? Buffer.alloc(size) : Buffer.allocUnsafe(size);
    }
    
    let pool = this.pools.get(poolSize);
    let stat = this.stats.get(poolSize);
    if (!pool) {
      // 创建新池
      pool = [];
      this.pools.set(poolSize, pool);
      stat = { acquires: 0, misses: 0 };
      this.stats.set(poolSize, stat);
    }
    
    stat.acquires++;
    
    // 性能优化：反向遍历，最近释放的 buffer 更可能在末尾
    for (let i = pool.length - 1; i >= 0; i--) {
      const entry = pool[i];
      if (!entry.inUse) {
        entry.inUse = true;
        entry.acquireCount++;
        // 只在需要统计时更新时间戳（减少开销）
        // entry.lastUsed = Date.now();
        
        // 返回请求大小的 subarray，避免浪费
        const buf = entry.buffer.subarray(0, size);
        // 如果需要零填充，清零 buffer
        if (zeroFill) {
          buf.fill(0);
        }
        return buf;
      }
    }
    
    // 池中没有可用的
    stat.misses++;
    
    // 如果池未满，创建新的并加入池
    if (pool.length < this.maxPoolSize) {
      const buffer = Buffer.allocUnsafe(poolSize);
      const entry: PoolEntry = { 
        buffer, 
        inUse: true, 
        acquireCount: 1,
        lastUsed: Date.now()
      };
      pool.push(entry);
      return buffer.subarray(0, size);
    }
    
    // 池已满，创建临时 Buffer（不加入池）
    return zeroFill ? Buffer.alloc(size) : Buffer.allocUnsafe(size);
  }
  
  /**
   * 释放 Buffer 回池中
   * 注意：Buffer 必须是从 acquire 获取的
   * 
   * @param buffer 要释放的 Buffer
   */
  release(buffer: Buffer): void {
    if (!buffer || buffer.length === 0) {
      return;
    }
    
    // 获取原始 Buffer（如果是 subarray/slice）
    // TypeScript 中 buffer.buffer 是 ArrayBuffer，我们需要找到池中的原始 Buffer
    const poolSize = this.findPoolSizeForBuffer(buffer);
    
    if (poolSize === -1) {
      // 不是池中的 Buffer，忽略
      return;
    }
    
    const pool = this.pools.get(poolSize);
    if (!pool) {
      return;
    }
    
    // 标记为未使用
    for (const entry of pool) {
      // 检查是否是同一个 Buffer（通过 ArrayBuffer 比较）
      if (entry.buffer.buffer === buffer.buffer) {
        entry.inUse = false;
        break;
      }
    }
  }
  
  /**
   * 查找 Buffer 所属的池大小
   */
  private findPoolSizeForBuffer(buffer: Buffer): number {
    const arrayBuffer = buffer.buffer;
    for (const [poolSize, pool] of this.pools) {
      for (const entry of pool) {
        if (entry.buffer.buffer === arrayBuffer) {
          return poolSize;
        }
      }
    }
    return -1;
  }
  
  /**
   * 找到最接近且大于等于请求大小的池大小
   */
  private findNearestPoolSize(size: number): number {
    for (const poolSize of BufferPool.COMMON_SIZES) {
      if (poolSize >= size) {
        return poolSize;
      }
    }
    
    // 如果超过最大预设大小，检查是否有自定义池
    for (const [poolSize] of this.pools) {
      if (poolSize >= size) {
        return poolSize;
      }
    }
    
    return -1;
  }
  
  /**
   * 获取池统计信息
   */
  getStats(): BufferPoolStats[] {
    const stats: BufferPoolStats[] = [];
    
    for (const [poolSize, pool] of this.pools) {
      const inUse = pool.filter(e => e.inUse).length;
      const stat = this.stats.get(poolSize) || { acquires: 0, misses: 0 };
      const totalAcquireCount = pool.reduce((sum, e) => sum + e.acquireCount, 0);
      const hitRate = stat.acquires > 0 
        ? ((stat.acquires - stat.misses) / stat.acquires) * 100 
        : 0;
      
      stats.push({
        poolSize,
        total: pool.length,
        inUse,
        available: pool.length - inUse,
        acquireCount: totalAcquireCount,
        hitRate: Math.round(hitRate * 100) / 100, // 保留两位小数
      });
    }
    
    return stats;
  }
  
  /**
   * 清空所有池
   */
  clear(): void {
    for (const pool of this.pools.values()) {
      pool.length = 0;
    }
  }
  
  /**
   * 预热池 - 预先分配一定数量的 Buffer
   * 
   * @param count 每个池大小预分配的 Buffer 数量（默认 50）
   */
  warmup(count: number = 50): void {
    const actualCount = Math.min(count, this.maxPoolSize);
    
    for (const size of BufferPool.COMMON_SIZES) {
      let pool = this.pools.get(size);
      if (!pool) {
        pool = [];
        this.pools.set(size, pool);
      }
      
      // 只预热到当前池还没有 buffer 的情况
      const needed = Math.max(0, actualCount - pool.length);
      for (let i = 0; i < needed; i++) {
        const buffer = Buffer.allocUnsafe(size);
        pool.push({ 
          buffer, 
          inUse: false, 
          acquireCount: 0,
          lastUsed: 0
        });
      }
    }
  }
  
  /**
   * 重置统计信息
   */
  resetStats(): void {
    for (const stat of this.stats.values()) {
      stat.acquires = 0;
      stat.misses = 0;
    }
  }
  
  /**
   * 清理长时间未使用的 Buffer（保留最小数量）
   * 
   * @param maxIdleMs 最大空闲时间（毫秒）
   * @param minKeep 每个池保留的最小数量
   */
  cleanup(maxIdleMs: number = 300000, minKeep: number = 10): void {
    const now = Date.now();
    
    for (const [poolSize, pool] of this.pools) {
      // 找出未使用且超过空闲时间的条目
      const activeEntries: PoolEntry[] = [];
      const idleEntries: PoolEntry[] = [];
      
      for (const entry of pool) {
        if (entry.inUse) {
          activeEntries.push(entry);
        } else if (now - entry.lastUsed > maxIdleMs) {
          idleEntries.push(entry);
        } else {
          activeEntries.push(entry);
        }
      }
      
      // 保留最小数量的空闲 buffer
      const keepCount = Math.max(0, minKeep - activeEntries.length);
      const toKeep = idleEntries.slice(0, keepCount);
      
      // 更新池
      this.pools.set(poolSize, [...activeEntries, ...toKeep]);
    }
  }
}

// 导出单例实例用于全局使用
export const globalBufferPool = new BufferPool(100);
