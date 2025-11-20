/**
 * AuthManager - 认证管理器
 * 
 * 主要职责:
 * - 处理认证流程
 * - 支持多种认证方式 (用户名密码、证书、令牌)
 * - 管理访问令牌
 * - 处理认证失败和重试
 */

import type { MumbleClient } from './mumble-client.js';
import type { ConnectOptions } from '../types/client-types.js';
import { mumbleproto, MessageType } from '@munode/protocol';
import { ConnectionState } from './connection.js';

export class AuthManager {
  private client: MumbleClient;
  private username: string = '';
  private password: string = '';
  private tokens: string[] = [];
  private certificate: Buffer | null = null;
  private privateKey: Buffer | null = null;

  constructor(client: MumbleClient) {
    this.client = client;
  }

  /**
   * 初始化认证信息
   */
  initialize(options: ConnectOptions): void {
    this.username = options.username;
    this.password = options.password || '';
    this.tokens = options.tokens || [];
    
    // 加载证书和私钥
    if (options.clientCert) {
      this.certificate = options.clientCert;
    }
    if (options.clientKey) {
      this.privateKey = options.clientKey;
    }

    // 重置认证状态
    this.reset();
  }

  /**
   * 执行认证
   */
  async authenticate(): Promise<void> {
    // 发送 Authenticate 消息
    await this.sendAuthenticate();

    // 等待 ServerSync 或 Reject 消息
    // 这里通过事件监听来处理认证结果
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 30000); // 30秒超时

      const onServerSync = (message: any) => {
        clearTimeout(timeout);
        this.client.removeListener('serverSync', onServerSync);
        this.client.removeListener('reject', onReject);
        this.handleServerSync(message);
        resolve();
      };

      const onReject = (message: any) => {
        clearTimeout(timeout);
        this.client.removeListener('serverSync', onServerSync);
        this.client.removeListener('reject', onReject);
        this.handleReject(message);
        reject(new Error(`Authentication failed: ${message.reason || 'Unknown reason'}`));
      };

      this.client.on('serverSync', onServerSync);
      this.client.on('reject', onReject);
    });
  }

  /**
   * 发送 Authenticate 消息
   */
  private async sendAuthenticate(): Promise<void> {
    const authMessage = mumbleproto.Authenticate.fromObject({
      username: this.username,
      password: this.password,
      tokens: this.tokens,
      celt_versions: [], // 不支持CELT
      opus: true, // 支持Opus
    });
    
    const serialized = authMessage.serialize();
    const wrappedMessage = this.client.getConnectionManager().wrapMessage(MessageType.Authenticate, serialized);
    await this.client.getConnectionManager().sendTCP(wrappedMessage);
  }

  /**
   * 处理认证成功 (ServerSync)
   */
  handleServerSync(message: any): void {
    // 保存会话信息到状态管理器
    this.client.getStateManager().handleServerSync(message);

    // 触发认证成功事件
    this.client.emit('authenticated', message);

    // 更新连接状态
    this.client.getConnectionManager().setState(ConnectionState.Ready);
  }

  /**
   * 处理认证失败 (Reject)
   */
  handleReject(message: any): void {
    // 解析拒绝原因
    const reason = message.reason || 'Unknown reason';
    const type = message.type || 0;

    // 触发认证失败事件
    this.client.emit('authenticationFailed', {
      reason,
      type,
      message
    });

    // 记录错误日志
    console.error('Authentication failed:', reason);
  }

  /**
   * 添加访问令牌
   */
  addToken(token: string): void {
    if (!this.tokens.includes(token)) {
      this.tokens.push(token);
    }
  }

  /**
   * 移除访问令牌
   */
  removeToken(token: string): void {
    const index = this.tokens.indexOf(token);
    if (index !== -1) {
      this.tokens.splice(index, 1);
    }
  }

  /**
   * 获取当前令牌列表
   */
  getTokens(): string[] {
    return [...this.tokens];
  }

  /**
   * 检查是否使用证书认证
   */
  hasCertificate(): boolean {
    return this.certificate !== null && this.privateKey !== null;
  }

  /**
   * 获取用户名
   */
  getUsername(): string {
    return this.username;
  }

  /**
   * 重置认证状态
   */
  reset(): void {
    // 保留认证信息,只重置状态
  }
}
