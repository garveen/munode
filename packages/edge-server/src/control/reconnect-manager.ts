/**
 * 重连管理器
 *
 * 管理Edge服务器的重连逻辑：
 * - Hub连接重连
 * - 完全断开流程
 * - 重新加入集群
 */

import { EventEmitter } from 'events';

export interface ReconnectConfig {
  hubReconnectTimeout: number; // Hub重连超时（毫秒）
  hubReconnectInterval: number; // Hub重连间隔（毫秒）
  rejoinDelay: number; // 重新加入延迟（毫秒）
}

export interface ReconnectCallbacks {
  connectToHub: () => Promise<void>;
  disconnectFromHub: () => void;
  disconnectAllPeers: () => void;
  disconnectAllClients: () => void;
  clearState: () => void;
  joinCluster: () => Promise<void>;
}

export class ReconnectManager extends EventEmitter {
  private config: ReconnectConfig;
  private callbacks: ReconnectCallbacks;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isReconnecting = false;

  constructor(callbacks: ReconnectCallbacks, config: Partial<ReconnectConfig> = {}) {
    super();
    this.callbacks = callbacks;
    this.config = {
      hubReconnectTimeout: 10000, // 10秒
      hubReconnectInterval: 2000, // 2秒
      rejoinDelay: 5000, // 5秒
      ...config,
    };
  }

  /**
   * 处理Hub连接中断
   */
  async handleHubDisconnect(): Promise<boolean> {
    if (this.isReconnecting) {
      console.warn('Hub reconnect already in progress');
      return false;
    }

    console.warn('Hub connection lost, attempting reconnect');
    this.isReconnecting = true;
    this.reconnectAttempts = 0;
    this.emit('reconnect-started');

    const startTime = Date.now();

    try {
      return await new Promise<boolean>((resolve, reject) => {
        // 设置总超时
        const timeoutTimer = setTimeout(() => {
          this.cancelReconnect();
          reject(new Error('Hub reconnect timeout'));
        }, this.config.hubReconnectTimeout);

        // 定期重连
        this.reconnectTimer = setInterval(() => {
          this.reconnectAttempts++;
          const elapsed = Date.now() - startTime;

          console.info(`Hub reconnect attempt ${this.reconnectAttempts} (elapsed: ${elapsed}ms)`);

          this.callbacks
            .connectToHub()
            .then(() => {
              // 重连成功
              clearTimeout(timeoutTimer);
              this.cancelReconnect();
              this.isReconnecting = false;

              const totalTime = Date.now() - startTime;
              console.info(
                `Hub reconnected successfully after ${this.reconnectAttempts} attempts (${totalTime}ms)`
              );

              this.emit('reconnect-success', {
                attempts: this.reconnectAttempts,
                duration: totalTime,
              });

              resolve(true);
            })
            .catch((error: unknown) => {
              console.debug('Hub reconnect attempt failed:', error);
              this.emit('reconnect-attempt-failed', {
                attempt: this.reconnectAttempts,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }, this.config.hubReconnectInterval);
      });
    } catch (error) {
      // 重连超时，执行完全断开
      console.error(
        `Hub reconnect failed after ${this.config.hubReconnectTimeout}ms, performing full disconnect`
      );

      this.emit('reconnect-failed', {
        attempts: this.reconnectAttempts,
        duration: Date.now() - startTime,
      });

      await this.performFullDisconnect();
      return false;
    }
  }

  /**
   * 执行完全断开流程
   */
  async performFullDisconnect(): Promise<void> {
    console.warn('=== Starting full disconnect procedure ===');
    this.emit('full-disconnect-started');

    try {
      // 1. 通知所有客户端（可选，取决于ClientManager的实现）
      console.info('Step 1/5: Notifying clients');
      // this.notifyAllClients('Server is reconnecting, please wait...');

      // 2. 断开所有Peer连接
      console.info('Step 2/5: Disconnecting from peers');
      this.callbacks.disconnectAllPeers();

      // 3. 断开所有客户端
      console.info('Step 3/5: Disconnecting clients');
      this.callbacks.disconnectAllClients();

      // 4. 断开Hub
      console.info('Step 4/5: Disconnecting from Hub');
      this.callbacks.disconnectFromHub();

      // 5. 清理状态
      console.info('Step 5/5: Clearing state');
      this.callbacks.clearState();

      console.warn('=== Full disconnect complete ===');
      this.emit('full-disconnect-complete');

      // 6. 延迟后重新加入
      console.info(`Waiting ${this.config.rejoinDelay}ms before rejoin...`);
      await this.sleep(this.config.rejoinDelay);

      console.info('=== Starting rejoin procedure ===');
      this.emit('rejoin-started');

      await this.callbacks.joinCluster();

      console.info('=== Rejoin complete ===');
      this.emit('rejoin-complete');
    } catch (error) {
      console.error('Failed to rejoin cluster:', error);
      this.emit('rejoin-failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 取消重连
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;
  }

  /**
   * 停止重连管理器
   */
  stop(): void {
    this.cancelReconnect();
    this.reconnectAttempts = 0;
  }

  /**
   * 检查是否正在重连
   */
  isReconnectingHub(): boolean {
    return this.isReconnecting;
  }

  /**
   * 获取重连统计
   */
  getStats(): {
    isReconnecting: boolean;
    reconnectAttempts: number;
  } {
    return {
      isReconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * 辅助函数：睡眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
