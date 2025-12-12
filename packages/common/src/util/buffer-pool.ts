/**
 * Buffer 池 - 用于复用常见大小的 Buffer，减少 GC 压力
 * 
 * 性能优化：语音包通常在 100-500 字节范围内，复用这些 Buffer 可以显著减少分配和 GC
 */

interface PoolEntry {
  buffer: Buffer;
  inUse: boolean;
}

export class BufferPool {
  private pools: Map<number, PoolEntry[]> = new Map();
  private maxPoolSize: number;
  
  // 常见的语音包大小（字节）
  private static readonly COMMON_SIZES = [128, 256, 512, 1024, 2048];
  
  constructor(maxPoolSize: number = 100) {
    this.maxPoolSize = maxPoolSize;
    
    // 预分配常见大小的 Buffer 池
    for (const size of BufferPool.COMMON_SIZES) {
      this.pools.set(size, []);
    }
  }
  
  /**
   * 获取指定大小的 Buffer
   * 如果池中有可用的，返回池中的；否则创建新的
   */
  acquire(size: number): Buffer {
    // 找到最接近且大于等于请求大小的池
    const poolSize = this.findNearestPoolSize(size);
    
    if (poolSize === -1) {
      // 没有合适的池，直接分配
      return Buffer.allocUnsafe(size);
    }
    
    let pool = this.pools.get(poolSize);
    if (!pool) {
      // 创建新池
      pool = [];
      this.pools.set(poolSize, pool);
    }
    
    // 查找可用的 Buffer
    for (const entry of pool) {
      if (!entry.inUse) {
        entry.inUse = true;
        // 返回请求大小的 slice，避免浪费
        return entry.buffer.subarray(0, size);
      }
    }
    
    // 池中没有可用的，创建新的
    const buffer = Buffer.allocUnsafe(poolSize);
    pool.push({ buffer, inUse: true });
    
    // 限制池大小
    if (pool.length > this.maxPoolSize) {
      // 移除未使用的条目
      const filtered = pool.filter(e => e.inUse);
      this.pools.set(poolSize, filtered);
    }
    
    return buffer.subarray(0, size);
  }
  
  /**
   * 释放 Buffer 回池中
   * 注意：Buffer 必须是从 acquire 获取的
   */
  release(buffer: Buffer): void {
    // 获取原始 Buffer（如果是 slice）
    const originalBuffer = buffer.buffer as unknown as Buffer;
    const poolSize = originalBuffer.length;
    
    const pool = this.pools.get(poolSize);
    if (!pool) {
      // 不是池中的 Buffer，忽略
      return;
    }
    
    // 标记为未使用
    for (const entry of pool) {
      if (entry.buffer === originalBuffer) {
        entry.inUse = false;
        break;
      }
    }
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
  getStats(): { poolSize: number; total: number; inUse: number; available: number }[] {
    const stats: { poolSize: number; total: number; inUse: number; available: number }[] = [];
    
    for (const [poolSize, pool] of this.pools) {
      const inUse = pool.filter(e => e.inUse).length;
      stats.push({
        poolSize,
        total: pool.length,
        inUse,
        available: pool.length - inUse,
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
   */
  warmup(count: number = 50): void {
    for (const size of BufferPool.COMMON_SIZES) {
      let pool = this.pools.get(size);
      if (!pool) {
        pool = [];
        this.pools.set(size, pool);
      }
      
      for (let i = 0; i < count; i++) {
        const buffer = Buffer.allocUnsafe(size);
        pool.push({ buffer, inUse: false });
      }
    }
  }
}

// 导出单例实例用于全局使用
export const globalBufferPool = new BufferPool(100);
