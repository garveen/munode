import type { Logger } from '@munode/common';
import { createHmac, randomBytes } from 'crypto';
import type {
  RegisteredEdge,
  RegistryConfig,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  EdgeInfo,
} from './types.js';
import { EdgeConnectionState } from './types.js';
import type { HubDatabase } from './database.js';


/**
 * 挑战码信息
 */
interface ChallengeInfo {
  challenge: string;
  serverId: number;
  createdAt: number;
}

/**
 * 服务注册表
 * 管理 Edge Server 的注册、心跳和状态
 */
export class ServiceRegistry {
  private edges = new Map<number, RegisteredEdge>();
  private heartbeatTimers = new Map<number, NodeJS.Timeout>();
  private config: RegistryConfig;
  
  // HMAC 挑战-响应认证
  private challenges = new Map<string, ChallengeInfo>(); // challenge -> ChallengeInfo
  private challengeCleanupTimer?: NodeJS.Timeout;
  
  // Edge信息不再持久化到数据库，仅存储在内存中

    private logger: Logger;

  constructor(config: RegistryConfig, _database: HubDatabase, logger: Logger) {
    this.logger = logger;
    this.config = config;
    // database参数保留以兼容旧代码，但不再使用
    
    // 启动挑战码清理定时器
    if (this.config.enableAuth !== false && this.config.hmacSecret) {
      this.startChallengeCleanup();
    }
  }

  /**
   * 注册新的 Edge Server
   * 支持两阶段 HMAC 挑战-响应认证：
   * 1. 第一次调用（无 challenge_response）：生成并返回 challenge
   * 2. 第二次调用（带 challenge_response）：验证签名并完成注册
   */
  async register(request: RegisterRequest): Promise<RegisterResponse> {
    const { server_id: reqserver_id, name, host, port, region, capacity, certificate } = request;
    const server_id = reqserver_id || 1;

    // HMAC 挑战-响应认证
    const enableAuth = this.config.enableAuth !== false;
    const hasSecret = !!this.config.hmacSecret;
    
    if (enableAuth && hasSecret) {
      const challengeResponse = (request as { challenge_response?: string }).challenge_response;
      const challenge = (request as { challenge?: string }).challenge;
      
      // 第一阶段：生成挑战码
      if (!challengeResponse) {
        const newChallenge = this.generateChallenge(server_id);
        const challengeTimeout = this.config.challengeTimeout || 60000;
        
    this.logger.debug(`Generated challenge for Edge ${server_id}`);
        
        return {
          success: false,
          challenge: newChallenge,
          challenge_timeout: challengeTimeout,
          hub_server_id: 0,
          edge_list: [],
        };
      }
      
      // 第二阶段：验证签名
      if (!challenge) {
    this.logger.warn(`Edge ${server_id} missing challenge in response`);
        return {
          success: false,
          error: 'Missing challenge',
          hub_server_id: 0,
          edge_list: [],
        };
      }
      
      // challenge 和 challengeResponse 已经是字符串格式
      const isValid = this.verifyChallenge(server_id, challenge, challengeResponse);
      if (!isValid) {
    this.logger.warn(`Edge ${server_id} authentication failed`);
        return {
          success: false,
          error: 'Authentication failed',
          hub_server_id: 0,
          edge_list: [],
        };
      }
      
      // 验证通过，清理挑战码
      this.challenges.delete(challenge);
    this.logger.debug(`Edge ${server_id} authenticated successfully`);
    }

    // 检查是否已存在
    const existingEdge = this.edges.get(server_id);
    if (existingEdge) {
      // 如果Edge在等待重连状态中重连，恢复会话
      if (existingEdge.connectionState === EdgeConnectionState.DISCONNECTED_WAITING) {
        this.logger.info(`Edge Server ${server_id} reconnected within grace period`);
        
        // 清理cleanup timer
        if (existingEdge.cleanupTimer) {
          clearTimeout(existingEdge.cleanupTimer);
          existingEdge.cleanupTimer = undefined;
        }
        
        // 更新状态为已连接
        existingEdge.connectionState = EdgeConnectionState.CONNECTED;
        existingEdge.disconnectedAt = undefined;
        existingEdge.last_seen = Date.now();
        existingEdge.name = name;
        existingEdge.host = host;
        existingEdge.port = port;
        existingEdge.region = region;
        existingEdge.capacity = capacity;
        existingEdge.certificate = certificate;
        
        // 重启心跳监控
        this.startHeartbeatMonitor(server_id);
        
        return {
          success: true,
          hub_server_id: 0,
          edge_list: this.getEdgeList(),
          reconnected: true, // 标识这是重连
        };
      } else if (existingEdge.connectionState === EdgeConnectionState.DISCONNECTED_TIMEOUT) {
        // Edge已经超时被清理，拒绝重连
        this.logger.warn(`Edge Server ${server_id} reconnection rejected: session already cleaned up`);
        return {
          success: false,
          error: 'Session timeout - cold restart required',
          session_expired: true, // 标识会话已过期，需要冷启动
          hub_server_id: 0,
          edge_list: [],
        };
      } else {
        this.logger.warn(`Edge Server ${server_id} already registered in CONNECTED state, updating...`);
      }
    }

    // 创建或更新 Edge 信息
    const edge: RegisteredEdge = existingEdge || {
      server_id,
      name,
      host,
      port,
      region,
      capacity,
      current_load: 0,
      certificate,
      last_seen: Date.now(),
      stats: {
        user_count: 0,
        channel_count: 0,
        cpu_usage: 0,
        memory_usage: 0,
        bandwidth: { in: 0, out: 0 },
      },
      connectionState: EdgeConnectionState.CONNECTED,
    };
    
    // 更新基本信息（如果是新Edge或更新现有Edge）
    edge.name = name;
    edge.host = host;
    edge.port = port;
    edge.region = region;
    edge.capacity = capacity;
    edge.certificate = certificate;
    edge.last_seen = Date.now();
    edge.connectionState = EdgeConnectionState.CONNECTED;

    this.edges.set(server_id, edge);
    this.startHeartbeatMonitor(server_id);

    // Edge信息仅存储在内存中，不持久化到数据库
    // Edge是临时运行时节点，重启后需要重新注册

    this.logger.info(`Edge Server ${server_id} (${name}) registered`, {
      host: `${host}:${port}`,
      region,
      capacity,
    });

    // 返回响应
    return {
      success: true,
      hub_server_id: 0, // Hub Server ID
      edge_list: this.getEdgeList(),
    };
  }

  /**
   * 处理心跳
   */
  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    const { server_id, stats } = request;

    const edge = this.edges.get(server_id);
    if (!edge) {
      return { success: false };
    }

    // 更新状态（仅内存）
    edge.current_load = stats.user_count;
    edge.stats = stats;
    edge.last_seen = Date.now();

    // Edge状态仅在内存中，不持久化

    // 重置心跳定时器
    this.resetHeartbeatTimer(server_id);

    // 检查是否有更新
    const updates = this.getUpdatedEdges(edge.last_seen - 5000);

    return {
      success: true,
      updated_edges: updates.length > 0 ? updates : undefined,
    };
  }

  /**
   * 处理 Edge 断开连接（带宽限期重连）
   */
  handleEdgeDisconnect(server_id: number, onCleanup?: (edgeId: number) => void): void {
    const edge = this.edges.get(server_id);
    if (!edge) {
      this.logger.warn(`Cannot handle disconnect for unknown Edge ${server_id}`);
      return;
    }

    // 如果已经在等待状态，不重复处理
    if (edge.connectionState === EdgeConnectionState.DISCONNECTED_WAITING) {
      this.logger.debug(`Edge ${server_id} already in waiting state`);
      return;
    }

    // 清理可能存在的旧定时器（防止竞态条件）
    if (edge.cleanupTimer) {
      clearTimeout(edge.cleanupTimer);
      edge.cleanupTimer = undefined;
    }

    // 标记为等待重连状态
    edge.connectionState = EdgeConnectionState.DISCONNECTED_WAITING;
    edge.disconnectedAt = Date.now();

    const gracePeriod = this.config.edgeReconnectGracePeriod ?? 30000; // 默认30秒
    
    this.logger.info(`Edge Server ${server_id} disconnected, waiting ${gracePeriod}ms for reconnection...`);

    // 停止心跳监控
    const timer = this.heartbeatTimers.get(server_id);
    if (timer) {
      clearTimeout(timer);
      this.heartbeatTimers.delete(server_id);
    }

    // 设置清理定时器
    edge.cleanupTimer = setTimeout(() => {
      this.logger.warn(`Edge Server ${server_id} reconnection timeout, marking as timed out...`);
      
      // ⚠️ 线程安全：先标记为超时状态，再执行清理
      // 这样在清理过程中如果 Edge 尝试重连，会被拒绝
      edge.connectionState = EdgeConnectionState.DISCONNECTED_TIMEOUT;
      edge.cleanupTimer = undefined;
      
      this.logger.info(`Edge Server ${server_id} marked as timed out, starting cleanup...`);
      
      // 调用清理回调
      if (onCleanup) {
        onCleanup(server_id);
      }
      
      // 注销Edge
      void this.unregister(server_id);
    }, gracePeriod);
  }

  /**
   * 注销 Edge Server
   */
  async unregister( server_id: number): Promise<void> {
    const edge = this.edges.get(server_id);
    if (!edge) return;

    // 清理cleanup timer
    if (edge.cleanupTimer) {
      clearTimeout(edge.cleanupTimer);
      edge.cleanupTimer = undefined;
    }

    this.edges.delete(server_id);

    const timer = this.heartbeatTimers.get(server_id);
    if (timer) {
      clearTimeout(timer);
      this.heartbeatTimers.delete(server_id);
    }

    this.logger.info(`Edge Server ${server_id} (${edge.name}) unregistered`);
  }

  /**
   * 获取 Edge 信息
   */
  getEdge( server_id: number): RegisteredEdge | undefined {
    return this.edges.get(server_id);
  }

  /**
   * 获取所有 Edge 列表
   */
  getEdgeList(): EdgeInfo[] {
    return Array.from(this.edges.values()).map((edge) => ({
       server_id: edge.server_id,
      name: edge.name,
      host: edge.host,
      port: edge.port,
      region: edge.region,
       current_load: edge.current_load,
      capacity: edge.capacity,
      certificate: edge.certificate,
       last_seen: edge.last_seen,
    }));
  }

  /**
   * 获取按区域分组的 Edge
   */
  getEdgesByRegion(region: string): RegisteredEdge[] {
    return Array.from(this.edges.values()).filter((edge) => edge.region === region);
  }

  /**
   * 获取负载最小的 Edge
   */
  getBestEdge(): RegisteredEdge | null {
    let best: RegisteredEdge | null = null;
    let lowestLoad = Infinity;

    for (const edge of this.edges.values()) {
      const loadPercentage = edge.current_load / edge.capacity;
      if (loadPercentage < lowestLoad) {
        lowestLoad = loadPercentage;
        best = edge;
      }
    }

    return best;
  }

  /**
   * 获取 Edge 数量
   */
  getEdgeCount(): number {
    return this.edges.size;
  }

  /**
   * 获取所有已注册的 Edge（包含完整信息和统计数据）
   */
  getAllEdges(): RegisteredEdge[] {
    return Array.from(this.edges.values());
  }

  /**
   * 清理超时的 Edge
   */
  cleanup(): void {
    const now = Date.now();
    const timeout = this.config.timeout * 1000;

    for (const [server_id, edge] of this.edges.entries()) {
      if (now - edge.last_seen > timeout) {
    this.logger.warn(`Edge Server ${server_id} heartbeat timeout, removing...`);
        void this.unregister(server_id);
      }
    }
  }

  /**
   * 启动心跳监控
   */
  private startHeartbeatMonitor( server_id: number): void {
    const timer = setTimeout(() => {
      this.handleHeartbeatTimeout(server_id);
    }, this.config.timeout * 1000);

    this.heartbeatTimers.set(server_id, timer);
  }

  /**
   * 重置心跳定时器
   */
  private resetHeartbeatTimer( server_id: number): void {
    const timer = this.heartbeatTimers.get(server_id);
    if (timer) {
      clearTimeout(timer);
    }
    this.startHeartbeatMonitor(server_id);
  }

  /**
   * 处理心跳超时
   */
  private handleHeartbeatTimeout( server_id: number): void {
    this.logger.warn(`Edge Server ${server_id} heartbeat timeout`);
    void this.unregister(server_id);
  }

  /**
   * 获取指定时间后更新的 Edge
   */
  private getUpdatedEdges(since: number): EdgeInfo[] {
    return Array.from(this.edges.values())
      .filter((edge) => edge.last_seen > since)
      .map((edge) => ({
         server_id: edge.server_id,
        name: edge.name,
        host: edge.host,
        port: edge.port,
        region: edge.region,
         current_load: edge.current_load,
        capacity: edge.capacity,
        certificate: edge.certificate,
         last_seen: edge.last_seen,
      }));
  }

  /**
   * 生成挑战码
   */
  private generateChallenge(serverId: number): string {
    const challenge = randomBytes(32).toString('hex');
    
    this.challenges.set(challenge, {
      challenge,
      serverId,
      createdAt: Date.now(),
    });
    
    return challenge;
  }

  /**
   * 验证挑战码响应
   */
  private verifyChallenge(serverId: number, challenge: string, response: string): boolean {
    const challengeInfo = this.challenges.get(challenge);
    
    if (!challengeInfo) {
    this.logger.warn(`Challenge not found: ${challenge}`);
      return false;
    }
    
    // 检查 server_id 是否匹配
    if (challengeInfo.serverId !== serverId) {
    this.logger.warn(`Server ID mismatch: expected ${challengeInfo.serverId}, got ${serverId}`);
      return false;
    }
    
    // 检查是否超时
    const challengeTimeout = this.config.challengeTimeout || 60000;
    if (Date.now() - challengeInfo.createdAt > challengeTimeout) {
    this.logger.warn(`Challenge expired for server ${serverId}`);
      this.challenges.delete(challenge);
      return false;
    }
    
    // 计算期望的 HMAC 签名
    const expectedResponse = this.computeHmac(challenge, serverId);
    
    // 使用常量时间比较防止时序攻击
    const isValid = this.constantTimeCompare(response, expectedResponse);
    
    if (!isValid) {
    this.logger.warn(`Invalid HMAC response from server ${serverId}`);
    }
    
    return isValid;
  }

  /**
   * 计算 HMAC 签名
   */
  private computeHmac(challenge: string, serverId: number): string {
    if (!this.config.hmacSecret) {
      throw new Error('HMAC secret not configured');
    }
    
    const message = `${challenge}:${serverId}`;
    const hmac = createHmac('sha256', this.config.hmacSecret);
    hmac.update(message);
    return hmac.digest('hex');
  }

  /**
   * 常量时间字符串比较（防止时序攻击）
   */
  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
  }

  /**
   * 启动挑战码清理定时器
   */
  private startChallengeCleanup(): void {
    const cleanupInterval = 60000; // 每分钟清理一次
    
    this.challengeCleanupTimer = setInterval(() => {
      this.cleanupExpiredChallenges();
    }, cleanupInterval);
  }

  /**
   * 清理过期的挑战码
   */
  private cleanupExpiredChallenges(): void {
    const now = Date.now();
    const challengeTimeout = this.config.challengeTimeout || 60000;
    
    for (const [challenge, info] of this.challenges.entries()) {
      if (now - info.createdAt > challengeTimeout) {
        this.challenges.delete(challenge);
    this.logger.debug(`Cleaned up expired challenge for server ${info.serverId}`);
      }
    }
  }

  /**
   * 停止服务（清理资源）
   */
  stop(): void {
    if (this.challengeCleanupTimer) {
      clearInterval(this.challengeCleanupTimer);
      this.challengeCleanupTimer = undefined;
    }
    
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer);
    }
    this.heartbeatTimers.clear();
  }
}
