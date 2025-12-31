/**
 * 多租户 VoiceRouter 扩展
 * 
 * 为 VoiceRouter 添加多租户支持，通过复合键系统实现虚拟主机隔离
 */

import { CryptoKeyRegistry } from '../virtual-host/crypto-key-registry.js';
import { OCB2AES128 } from '@munode/common';
import type { Logger } from 'winston';

/**
 * 多租户 VoiceRouter Mixin
 * 
 * 通过 CryptoKeyRegistry 实现虚拟主机级别的会话隔离
 */
export class MultiTenantVoiceRouterSupport {
  private cryptoRegistry: CryptoKeyRegistry;
  private logger: Logger;
  
  // 虚拟主机上下文映射：session_id -> vhostName
  private sessionToVhost: Map<number, string> = new Map();
  
  constructor(logger: Logger) {
    this.logger = logger;
    this.cryptoRegistry = new CryptoKeyRegistry({ expirationMs: 5 * 60 * 1000 });
    this.cryptoRegistry.startAutoCleanup(60000); // 每分钟清理一次过期密钥
  }

  /**
   * 注册客户端的加密密钥（多租户模式）
   * 
   * @param vhostName 虚拟主机名称
   * @param sessionId 会话 ID（虚拟主机内）
   * @param crypto 加密器实例
   */
  registerCrypto(vhostName: string, sessionId: number, crypto: OCB2AES128): void {
    this.cryptoRegistry.register(vhostName, sessionId, crypto);
    this.sessionToVhost.set(sessionId, vhostName);
    
    this.logger.debug(
      `Registered crypto for session ${sessionId} in vhost ${vhostName}`
    );
  }

  /**
   * 获取客户端的加密器（通过复合键）
   * 
   * @param sessionId 会话 ID
   * @returns 加密器实例或 undefined
   */
  getCryptoBySession(sessionId: number): OCB2AES128 | undefined {
    const vhostName = this.sessionToVhost.get(sessionId);
    if (!vhostName) {
      return undefined;
    }
    
    return this.cryptoRegistry.getByVhostAndSession(vhostName, sessionId);
  }

  /**
   * 获取客户端的加密器（通过虚拟主机名和会话ID）
   * 
   * @param vhostName 虚拟主机名称
   * @param sessionId 会话 ID
   * @returns 加密器实例或 undefined
   */
  getCryptoByVhostAndSession(vhostName: string, sessionId: number): OCB2AES128 | undefined {
    return this.cryptoRegistry.getByVhostAndSession(vhostName, sessionId);
  }

  /**
   * 移除客户端的加密状态
   * 
   * @param sessionId 会话 ID
   */
  removeCrypto(sessionId: number): void {
    const vhostName = this.sessionToVhost.get(sessionId);
    if (vhostName) {
      this.cryptoRegistry.deleteByVhostAndSession(vhostName, sessionId);
      this.sessionToVhost.delete(sessionId);
      
      this.logger.debug(
        `Removed crypto for session ${sessionId} in vhost ${vhostName}`
      );
    }
  }

  /**
   * 清除虚拟主机的所有会话
   * 
   * @param vhostName 虚拟主机名称
   * @returns 清除的会话数量
   */
  clearVhost(vhostName: string): number {
    const count = this.cryptoRegistry.clearVhost(vhostName);
    
    // 清理 sessionToVhost 映射
    const sessionsToRemove: number[] = [];
    for (const [session, vhost] of this.sessionToVhost.entries()) {
      if (vhost === vhostName) {
        sessionsToRemove.push(session);
      }
    }
    
    for (const session of sessionsToRemove) {
      this.sessionToVhost.delete(session);
    }
    
    this.logger.info(`Cleared ${count} sessions from vhost ${vhostName}`);
    return count;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalKeys: number;
    vhostCount: number;
    vhostStats: Map<string, number>;
  } {
    return this.cryptoRegistry.getStats();
  }

  /**
   * 获取所有虚拟主机名称
   */
  getAllVhosts(): Set<string> {
    return this.cryptoRegistry.getAllVhosts();
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.cryptoRegistry.stopAutoCleanup();
    this.cryptoRegistry.clear();
    this.sessionToVhost.clear();
  }

  /**
   * 检查会话是否属于指定虚拟主机
   * 
   * @param sessionId 会话 ID
   * @param vhostName 虚拟主机名称
   * @returns 是否属于该虚拟主机
   */
  isSessionInVhost(sessionId: number, vhostName: string): boolean {
    const sessionVhost = this.sessionToVhost.get(sessionId);
    return sessionVhost === vhostName;
  }

  /**
   * 获取会话所属的虚拟主机
   * 
   * @param sessionId 会话 ID
   * @returns 虚拟主机名称或 undefined
   */
  getVhostForSession(sessionId: number): string | undefined {
    return this.sessionToVhost.get(sessionId);
  }

  /**
   * 获取虚拟主机下的所有会话
   * 
   * @param vhostName 虚拟主机名称
   * @returns 会话 ID 数组
   */
  getSessionsInVhost(vhostName: string): number[] {
    const sessions: number[] = [];
    for (const [session, vhost] of this.sessionToVhost.entries()) {
      if (vhost === vhostName) {
        sessions.push(session);
      }
    }
    return sessions;
  }
}
