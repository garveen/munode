import { createLogger } from '@munode/common';
import type {
  RegisteredEdge,
  RegistryConfig,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  EdgeInfo,
} from './types.js';
import type { HubDatabase } from './database.js';

const logger = createLogger({ service: 'hub-registry' });

/**
 * 服务注册表
 * 管理 Edge Server 的注册、心跳和状态
 */
export class ServiceRegistry {
  private edges = new Map<number, RegisteredEdge>();
  private heartbeatTimers = new Map<number, NodeJS.Timeout>();
  private config: RegistryConfig;
  // Edge信息不再持久化到数据库，仅存储在内存中

  constructor(config: RegistryConfig, _database: HubDatabase) {
    this.config = config;
    // database参数保留以兼容旧代码，但不再使用
  }

  /**
   * 注册新的 Edge Server
   */
  async register(request: RegisterRequest): Promise<RegisterResponse> {
    const {  server_id: reqserver_id, name, host, port, region, capacity, certificate } = request;
    const server_id = reqserver_id || 1;

    // 检查是否已存在
    if (this.edges.has(server_id)) {
      logger.warn(`Edge Server ${server_id} already registered, updating...`);
    }

    // 创建 Edge 信息
    const edge: RegisteredEdge = {
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
    };

    this.edges.set(server_id, edge);
    this.startHeartbeatMonitor(server_id);

    // Edge信息仅存储在内存中，不持久化到数据库
    // Edge是临时运行时节点，重启后需要重新注册

    logger.info(`Edge Server ${server_id} (${name}) registered`, {
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
   * 注销 Edge Server
   */
  async unregister( server_id: number): Promise<void> {
    const edge = this.edges.get(server_id);
    if (!edge) return;

    this.edges.delete(server_id);

    const timer = this.heartbeatTimers.get(server_id);
    if (timer) {
      clearTimeout(timer);
      this.heartbeatTimers.delete(server_id);
    }

    logger.info(`Edge Server ${server_id} (${edge.name}) unregistered`);
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
   * 清理超时的 Edge
   */
  cleanup(): void {
    const now = Date.now();
    const timeout = this.config.timeout * 1000;

    for (const [server_id, edge] of this.edges.entries()) {
      if (now - edge.last_seen > timeout) {
        logger.warn(`Edge Server ${server_id} heartbeat timeout, removing...`);
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
    logger.warn(`Edge Server ${server_id} heartbeat timeout`);
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
}
