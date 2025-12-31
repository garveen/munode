/**
 * 加密密钥注册表
 * 管理虚拟主机下每个客户端的加密密钥映射
 */

import { OCB2AES128 } from '@munode/common';
import { makeCompositeKey } from './composite-key.js';

export interface CryptoKeyEntry {
  /** 虚拟主机名称 */
  vhostName: string;
  /** 会话 ID */
  sessionId: number;
  /** 加密状态 */
  cryptoState: OCB2AES128;
  /** 注册时间戳 */
  registeredAt: number;
  /** 最后使用时间戳 */
  lastUsedAt: number;
}

/**
 * 加密密钥注册表
 * 使用复合键（vhostName:sessionId）作为索引
 */
export class CryptoKeyRegistry {
  /** 密钥存储 Map<compositeKey, CryptoKeyEntry> */
  private readonly keys: Map<string, CryptoKeyEntry> = new Map();
  
  /** 清理定时器 */
  private cleanupTimer?: NodeJS.Timeout;
  
  /** 过期时间（毫秒）默认 5 分钟 */
  private readonly expirationMs: number;

  constructor(options?: { expirationMs?: number }) {
    this.expirationMs = options?.expirationMs ?? 5 * 60 * 1000;
  }

  /**
   * 注册加密密钥
   */
  register(vhostName: string, sessionId: number, cryptoState: OCB2AES128): void {
    const compositeKey = makeCompositeKey(vhostName, sessionId);
    const now = Date.now();
    
    const entry: CryptoKeyEntry = {
      vhostName,
      sessionId,
      cryptoState,
      registeredAt: now,
      lastUsedAt: now,
    };
    
    this.keys.set(compositeKey, entry);
  }

  /**
   * 获取加密密钥
   */
  get(compositeKey: string): OCB2AES128 | undefined {
    const entry = this.keys.get(compositeKey);
    if (entry) {
      entry.lastUsedAt = Date.now();
      return entry.cryptoState;
    }
    return undefined;
  }

  /**
   * 通过虚拟主机和会话ID获取
   */
  getByVhostAndSession(vhostName: string, sessionId: number): OCB2AES128 | undefined {
    const compositeKey = makeCompositeKey(vhostName, sessionId);
    return this.get(compositeKey);
  }

  /**
   * 删除密钥
   */
  delete(compositeKey: string): boolean {
    return this.keys.delete(compositeKey);
  }

  /**
   * 通过虚拟主机和会话ID删除
   */
  deleteByVhostAndSession(vhostName: string, sessionId: number): boolean {
    const compositeKey = makeCompositeKey(vhostName, sessionId);
    return this.delete(compositeKey);
  }

  /**
   * 获取虚拟主机下的所有密钥
   */
  getByVhost(vhostName: string): Map<number, OCB2AES128> {
    const result = new Map<number, OCB2AES128>();
    
    for (const entry of this.keys.values()) {
      if (entry.vhostName === vhostName) {
        result.set(entry.sessionId, entry.cryptoState);
      }
    }
    
    return result;
  }

  /**
   * 清除虚拟主机的所有密钥
   */
  clearVhost(vhostName: string): number {
    let count = 0;
    const keysToDelete: string[] = [];
    
    for (const [compositeKey, entry] of this.keys.entries()) {
      if (entry.vhostName === vhostName) {
        keysToDelete.push(compositeKey);
      }
    }
    
    for (const key of keysToDelete) {
      if (this.keys.delete(key)) {
        count++;
      }
    }
    
    return count;
  }

  /**
   * 获取注册表大小
   */
  get size(): number {
    return this.keys.size;
  }

  /**
   * 清理过期密钥
   */
  cleanupExpired(): number {
    const now = Date.now();
    let count = 0;
    const keysToDelete: string[] = [];
    
    for (const [compositeKey, entry] of this.keys.entries()) {
      if (now - entry.lastUsedAt > this.expirationMs) {
        keysToDelete.push(compositeKey);
      }
    }
    
    for (const key of keysToDelete) {
      if (this.keys.delete(key)) {
        count++;
      }
    }
    
    return count;
  }

  /**
   * 启动自动清理
   */
  startAutoCleanup(intervalMs: number = 60000): void {
    if (this.cleanupTimer) {
      return;
    }
    
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, intervalMs);
  }

  /**
   * 停止自动清理
   */
  stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 清空所有密钥
   */
  clear(): void {
    this.keys.clear();
  }

  /**
   * 获取所有虚拟主机名称
   */
  getAllVhosts(): Set<string> {
    const vhosts = new Set<string>();
    for (const entry of this.keys.values()) {
      vhosts.add(entry.vhostName);
    }
    return vhosts;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalKeys: number;
    vhostCount: number;
    vhostStats: Map<string, number>;
  } {
    const vhostStats = new Map<string, number>();
    
    for (const entry of this.keys.values()) {
      const count = vhostStats.get(entry.vhostName) ?? 0;
      vhostStats.set(entry.vhostName, count + 1);
    }
    
    return {
      totalKeys: this.keys.size,
      vhostCount: vhostStats.size,
      vhostStats,
    };
  }
}
