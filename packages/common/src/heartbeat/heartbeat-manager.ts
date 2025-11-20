/**
 * 心跳管理器
 *
 * 负责管理集群内连接的心跳机制：
 * - 发送心跳包
 * - 检测心跳超时
 * - 管理心跳状态
 */

export interface HeartbeatConfig {
  interval: number;      // 心跳间隔（毫秒）
  timeout: number;       // 心跳超时时间（毫秒）
  maxRetries: number;    // 最大重试次数
}

export interface HeartbeatCallbacks {
  onTimeout: (connectionId: string) => void;
  onHeartbeat?: (connectionId: string, latency: number) => void;
}

export class HeartbeatManager {
  private lastHeartbeat = new Map<string, number>(); // connectionId -> timestamp
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private config: HeartbeatConfig;

  constructor(_callbacks: HeartbeatCallbacks, config: Partial<HeartbeatConfig> = {}) {
    this.config = {
      interval: 1000,
      timeout: 3000,
      maxRetries: 3,
      ...config,
    };
  }

  /**
   * 启动心跳发送
   */
  startSending(connectionId: string, sendHeartbeat: () => void): void {
    // 清除现有的定时器
    this.stop(connectionId);

    // 启动心跳发送定时器
    const timer = setInterval(() => {
      try {
        sendHeartbeat();
        this.recordSentHeartbeat(connectionId);
      } catch (error) {
        console.warn(`Failed to send heartbeat for ${connectionId}:`, error);
      }
    }, this.config.interval);

    this.heartbeatTimers.set(connectionId, timer);
  }

  /**
   * 记录发送的心跳
   */
  private recordSentHeartbeat(_connectionId: string): void {
    // 可以在这里记录发送时间，用于计算往返延迟
    // 暂时不需要实现
  }

  /**
   * 记录收到心跳
   */
  recordHeartbeat(connectionId: string): void {
    this.lastHeartbeat.set(connectionId, Date.now());
  }

  /**
   * 发送ping并等待pong
   */
  ping(_connectionId: string, _sendPing: () => Promise<void>): Promise<number> {
    // 简化实现：暂时不支持ping/pong机制
    return Promise.reject(new Error('Ping/pong not implemented'));
  }

  /**
   * 记录收到pong
   */
  recordPong(_connectionId: string): number | null {
    // 简化实现：暂时不支持ping/pong机制
    return null;
  }

  /**
   * 检查心跳超时
   */
  checkTimeout(connectionId: string): boolean {
    const last = this.lastHeartbeat.get(connectionId);
    if (!last) {
      return true; // 从未收到心跳，视为超时
    }

    const elapsed = Date.now() - last;
    return elapsed > this.config.timeout;
  }

  /**
   * 获取最后心跳时间
   */
  getLastHeartbeat(connectionId: string): number | undefined {
    return this.lastHeartbeat.get(connectionId);
  }

  /**
   * 获取连接延迟（毫秒）
   */
  getLatency(connectionId: string): number | null {
    const last = this.lastHeartbeat.get(connectionId);
    if (!last) return null;

    return Date.now() - last;
  }

  /**
   * 停止心跳管理
   */
  stop(connectionId: string): void {
    // 停止心跳发送定时器
    const heartbeatTimer = this.heartbeatTimers.get(connectionId);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      this.heartbeatTimers.delete(connectionId);
    }

    // 清理状态
    this.lastHeartbeat.delete(connectionId);
  }

  /**
   * 停止所有心跳管理
   */
  stopAll(): void {
    // 停止所有心跳发送定时器
    for (const [_connectionId, timer] of this.heartbeatTimers) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();

    // 清理所有状态
    this.lastHeartbeat.clear();
  }

  /**
   * 获取活跃连接数量
   */
  getActiveConnections(): number {
    return this.lastHeartbeat.size;
  }

  /**
   * 获取所有连接状态
   */
  getConnectionStatuses(): Array<{ connectionId: string; lastHeartbeat: number; latency: number }> {
    const now = Date.now();
    return Array.from(this.lastHeartbeat.entries()).map(([connectionId, lastHeartbeat]) => ({
      connectionId,
      lastHeartbeat,
      latency: now - lastHeartbeat,
    }));
  }
}