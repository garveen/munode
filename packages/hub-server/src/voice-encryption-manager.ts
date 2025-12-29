/**
 * Voice Encryption Manager
 * 
 * 管理Edge间语音传输的加密密钥：
 * - 生成和分发加密密钥
 * - 支持密钥轮换
 * - 跟踪Edge的密钥状态
 */

import crypto from 'crypto';
import type { Logger } from '@munode/common';
import type { VoiceRoutingConfig } from './types.js';

export interface EdgeEncryptionInfo {
  edgeId: number;
  keyVersion: number;
  keyAssignedAt: number;
}

export interface EncryptionKeyInfo {
  algorithm: string;
  key: Buffer;
  version: number;
  createdAt: number;
}

export class VoiceEncryptionManager {
  private currentKey: EncryptionKeyInfo | null = null;
  private edgeKeys = new Map<number, EdgeEncryptionInfo>();
  private config: VoiceRoutingConfig['encryption'];
  private logger: Logger;
  private rotationTimer?: NodeJS.Timeout;

  constructor(config: VoiceRoutingConfig['encryption'] | undefined, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // 生成初始密钥
    this.generateNewKey();

    // 启动密钥轮换定时器（如果配置了）
    if (this.config?.key_rotation_interval && this.config.key_rotation_interval > 0) {
      this.startKeyRotation();
    }
  }

  /**
   * 生成新的加密密钥
   */
  private generateNewKey(): void {
    const algorithm = this.config?.algorithm || 'aes-128-cbc';
    const keyLength = algorithm === 'aes-128-cbc' ? 16 : 32;
    const key = crypto.randomBytes(keyLength);

    const newVersion = this.currentKey ? this.currentKey.version + 1 : 1;

    this.currentKey = {
      algorithm,
      key,
      version: newVersion,
      createdAt: Date.now(),
    };

    this.logger.info(`Generated new voice encryption key (version ${newVersion}, algorithm: ${algorithm})`);
  }

  /**
   * 启动密钥轮换定时器
   */
  private startKeyRotation(): void {
    if (!this.config?.key_rotation_interval) return;

    const intervalMs = this.config.key_rotation_interval * 1000;

    this.rotationTimer = setInterval(() => {
      this.logger.info('Rotating voice encryption key...');
      this.generateNewKey();
      // 密钥轮换后，需要通知所有Edge更新密钥
      // 这将由ControlService处理
    }, intervalMs);

    this.logger.info(`Voice encryption key rotation enabled (interval: ${this.config.key_rotation_interval}s)`);
  }

  /**
   * 停止密钥轮换
   */
  stopKeyRotation(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
      this.logger.info('Voice encryption key rotation stopped');
    }
  }

  /**
   * 为Edge分配当前密钥
   */
  assignKeyToEdge(edgeId: number): EncryptionKeyInfo {
    if (!this.currentKey) {
      throw new Error('No encryption key available');
    }

    this.edgeKeys.set(edgeId, {
      edgeId,
      keyVersion: this.currentKey.version,
      keyAssignedAt: Date.now(),
    });

    this.logger.debug(`Assigned encryption key (version ${this.currentKey.version}) to Edge ${edgeId}`);

    return { ...this.currentKey };
  }

  /**
   * 移除Edge的密钥信息
   */
  removeEdge(edgeId: number): void {
    this.edgeKeys.delete(edgeId);
    this.logger.debug(`Removed encryption key info for Edge ${edgeId}`);
  }

  /**
   * 获取当前密钥
   */
  getCurrentKey(): EncryptionKeyInfo | null {
    return this.currentKey ? { ...this.currentKey } : null;
  }

  /**
   * 获取Edge的密钥版本
   */
  getEdgeKeyVersion(edgeId: number): number | undefined {
    return this.edgeKeys.get(edgeId)?.keyVersion;
  }

  /**
   * 检查Edge是否需要更新密钥
   */
  needsKeyUpdate(edgeId: number): boolean {
    const edgeInfo = this.edgeKeys.get(edgeId);
    if (!edgeInfo || !this.currentKey) return true;
    return edgeInfo.keyVersion < this.currentKey.version;
  }

  /**
   * 获取所有需要更新密钥的Edge
   */
  getEdgesNeedingUpdate(): number[] {
    if (!this.currentKey) return [];

    const needsUpdate: number[] = [];
    for (const [edgeId, info] of this.edgeKeys.entries()) {
      if (info.keyVersion < this.currentKey.version) {
        needsUpdate.push(edgeId);
      }
    }
    return needsUpdate;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    currentKeyVersion: number;
    edgesWithKey: number;
    edgesNeedingUpdate: number;
    keyRotationEnabled: boolean;
  } {
    return {
      currentKeyVersion: this.currentKey?.version || 0,
      edgesWithKey: this.edgeKeys.size,
      edgesNeedingUpdate: this.getEdgesNeedingUpdate().length,
      keyRotationEnabled: !!this.rotationTimer,
    };
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    this.stopKeyRotation();
    this.edgeKeys.clear();
    this.currentKey = null;
  }
}
