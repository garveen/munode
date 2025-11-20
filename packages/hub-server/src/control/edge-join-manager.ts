/**
 * Edge加入管理器
 *
 * 管理Edge服务器的集群加入流程：
 * - 串行化加入请求，避免并发冲突
 * - 管理加入令牌和超时机制
 * - 验证连接状态
 * - 处理加入完成确认
 */

export interface JoinRequest {
  serverId: number;
  name: string;
  host: string;
  port: number;
  voicePort: number;
  capacity: number;
}

export interface JoinResponse {
  success: boolean;
  token: string;
  peers: PeerInfo[];
  timeout: number;
  error?: string;
}

export interface PeerInfo {
  id: number;
  name: string;
  host: string;
  port: number;
  voicePort: number;
}

export interface JoinCompleteRequest {
  token: string;
  connectedPeers: number[];
}

export interface JoinCompleteResponse {
  success: boolean;
  error?: string;
}

export interface JoinCallbacks {
  onJoinStarted: (edgeId: number) => void;
  onJoinCompleted: (edgeId: number) => void;
  onJoinFailed: (edgeId: number, reason: string) => void;
  onJoinTimeout: (edgeId: number) => void;
  getAllPeers: () => PeerInfo[];
  generateToken: () => string;
}

export class EdgeJoinManager {
  private joinLock: {
    edgeId: number;
    token: string;
    startTime: number;
    timeout: NodeJS.Timeout;
  } | null = null;

  private pendingJoins: Array<{
    edgeId: number;
    resolve: (peers: PeerInfo[]) => void;
    reject: (error: Error) => void;
  }> = [];

  private callbacks: JoinCallbacks;
  private joinTimeout: number = 60000; // 60秒

  constructor(callbacks: JoinCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * 处理Edge加入请求
   */
  async requestJoin(request: JoinRequest): Promise<JoinResponse> {
    // 检查是否有其他Edge正在加入
    if (this.joinLock) {
      // 挂起请求，等待当前加入完成
      return new Promise((resolve, reject) => {
        this.pendingJoins.push({
          edgeId: request.serverId,
          resolve: (peers) =>
            resolve({
              success: true,
              token: this.callbacks.generateToken(),
              peers,
              timeout: this.joinTimeout,
            }),
          reject,
        });

        // 设置等待超时（5分钟）
        setTimeout(() => {
          const index = this.pendingJoins.findIndex((p) => p.edgeId === request.serverId);
          if (index !== -1) {
            this.pendingJoins.splice(index, 1);
            reject(new Error('Join queue timeout'));
          }
        }, 300000);
      });
    }

    // 创建加入令牌
    const token = this.callbacks.generateToken();
    const peers = this.callbacks.getAllPeers();

    // 设置加入锁
    this.joinLock = {
      edgeId: request.serverId,
      token,
      startTime: Date.now(),
      timeout: setTimeout(() => {
        this.handleJoinTimeout(request.serverId);
      }, this.joinTimeout),
    };

    // 通知加入开始
    this.callbacks.onJoinStarted(request.serverId);

    return {
      success: true,
      token,
      peers,
      timeout: this.joinTimeout,
    };
  }

  /**
   * 处理Edge加入完成确认
   */
  async confirmJoin(request: JoinCompleteRequest): Promise<JoinCompleteResponse> {
    // 验证令牌
    if (!this.joinLock || this.joinLock.token !== request.token) {
      return {
        success: false,
        error: 'Invalid join token',
      };
    }

    const edgeId = this.joinLock.edgeId;

    // 验证连接状态：检查所有Peer是否确认连接
    const allPeers = this.callbacks.getAllPeers().map((p) => p.id);
    const missingPeers = allPeers.filter((id) => !request.connectedPeers.includes(id));

    if (missingPeers.length > 0) {
      return {
        success: false,
        error: `Missing connections to peers: ${missingPeers.join(', ')}`,
      };
    }

    // 清除超时
    clearTimeout(this.joinLock.timeout);

    // 释放锁
    this.joinLock = null;

    // 通知加入完成
    this.callbacks.onJoinCompleted(edgeId);

    // 处理挂起的加入请求
    this.processNextJoin();

    return {
      success: true,
    };
  }

  /**
   * 处理加入超时
   */
  private handleJoinTimeout(edgeId: number): void {
    if (this.joinLock && this.joinLock.edgeId === edgeId) {
      console.warn(`Edge ${edgeId} join timeout, releasing lock`);

      // 通知加入失败
      this.callbacks.onJoinFailed(edgeId, 'Join timeout');
      this.callbacks.onJoinTimeout(edgeId);

      // 释放锁
      this.joinLock = null;

      // 处理下一个
      this.processNextJoin();
    }
  }

  /**
   * 处理下一个挂起的加入请求
   */
  private processNextJoin(): void {
    if (this.pendingJoins.length > 0) {
      const next = this.pendingJoins.shift();
      if (next) {
        try {
          const peers = this.callbacks.getAllPeers();
          next.resolve(peers);
        } catch (error) {
          next.reject(error as Error);
        }
      }
    }
  }

  /**
   * 取消Edge的加入请求
   */
  cancelJoin(edgeId: number): void {
    // 如果是当前正在加入的Edge
    if (this.joinLock && this.joinLock.edgeId === edgeId) {
      clearTimeout(this.joinLock.timeout);
      this.joinLock = null;
      this.callbacks.onJoinFailed(edgeId, 'Join cancelled');
      this.processNextJoin();
    }

    // 如果在等待队列中
    const index = this.pendingJoins.findIndex((p) => p.edgeId === edgeId);
    if (index !== -1) {
      this.pendingJoins.splice(index, 1);
    }
  }

  /**
   * 获取当前加入状态
   */
  getJoinStatus(): {
    currentJoin?: number;
    pendingJoins: number[];
    isLocked: boolean;
  } {
    return {
      currentJoin: this.joinLock?.edgeId,
      pendingJoins: this.pendingJoins.map((p) => p.edgeId),
      isLocked: this.joinLock !== null,
    };
  }

  /**
   * 检查Edge是否正在加入
   */
  isJoining(edgeId: number): boolean {
    return this.joinLock?.edgeId === edgeId ||
      this.pendingJoins.some((p) => p.edgeId === edgeId);
  }

  /**
   * 获取加入统计信息
   */
  getStats(): {
    currentJoin?: number;
    pendingCount: number;
    totalProcessed: number;
  } {
    // 这里可以添加统计信息
    return {
      currentJoin: this.joinLock?.edgeId,
      pendingCount: this.pendingJoins.length,
      totalProcessed: 0, // 可以添加计数器
    };
  }

  /**
   * 清理所有状态
   */
  clear(): void {
    if (this.joinLock) {
      clearTimeout(this.joinLock.timeout);
      this.callbacks.onJoinFailed(this.joinLock.edgeId, 'Manager shutdown');
      this.joinLock = null;
    }

    for (const pending of this.pendingJoins) {
      pending.reject(new Error('Manager shutdown'));
    }
    this.pendingJoins = [];
  }
}