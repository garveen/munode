/**
 * CryptoManager - 加密管理器
 * 
 * 主要职责:
 * - OCB2-AES128 加密/解密
 * - 密钥交换和管理
 * - Nonce 同步
 * - UDP 音频包加密
 */

import type { MumbleClient } from './mumble-client.js';
import { OCB2AES128 } from '@munode/common';

export class CryptoManager {
  private key: Buffer | null = null;
  private encryptHistory: number[] = [];
  private decryptHistory: number[] = [];
  private ocb2: OCB2AES128 | null = null;

  constructor(_client: MumbleClient) {}

  /**
   * 设置加密密钥 (从 CryptSetup 消息)
   */
  setKey(key: Buffer, clientNonce: Buffer, serverNonce: Buffer): void {
    this.key = key;

    // 初始化 OCB2 加密器
    this.ocb2 = new OCB2AES128();
    this.ocb2.setKey(key, clientNonce, serverNonce);

    // 重置加密历史
    this.encryptHistory = [];
    this.decryptHistory = [];

    console.debug('Cryptographic keys initialized');
  }

  /**
   * 加密 UDP 音频包
   */
  encrypt(plaintext: Buffer): Buffer {
    if (!this.isInitialized()) {
      throw new Error('Cryptography not initialized');
    }

    if (!this.ocb2) {
      throw new Error('OCB2 not initialized');
    }

    // 使用 OCB2 加密
    return this.ocb2.encrypt(plaintext);
  }

  /**
   * 解密 UDP 音频包
   */
  decrypt(ciphertext: Buffer): Buffer {
    if (!this.isInitialized()) {
      throw new Error('Cryptography not initialized');
    }

    if (!this.ocb2) {
      throw new Error('OCB2 not initialized');
    }

    // 使用 OCB2 解密
    const result = this.ocb2.decrypt(ciphertext);
    if (!result.valid) {
      throw new Error('Audio decryption failed: invalid ciphertext');
    }

    // 更新解密历史
    this.decryptHistory.push(Date.now());

    return result.data;
  }

  /**
   * 检查是否需要 nonce resync
   */
  needsResync(): boolean {
    // 简单的resync检查: 如果历史记录过长，认为需要重新同步
    return this.encryptHistory.length > 1000 || this.decryptHistory.length > 1000;
  }

  /**
   * 请求 nonce resync
   */
  requestResync(): void {
    // 发送空的 CryptSetup 消息来请求重新同步
    // 这里应该通过客户端发送消息，但暂时只记录日志
    console.log('Requesting cryptographic resync');
  }

  /**
   * 检查加密是否已初始化
   */
  isInitialized(): boolean {
    return this.key !== null;
  }

  /**
   * 重置加密状态
   */
  reset(): void {
    this.key = null;
    this.encryptHistory = [];
    this.decryptHistory = [];
    this.ocb2 = null;
  }
}
