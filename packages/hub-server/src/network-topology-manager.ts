/**
 * NetworkTopologyManager - Hub 侧网络拓扑管理器
 * 
 * 职责:
 * - 维护全局网络拓扑（Edge 间连接质量）
 * - 使用 Dijkstra 算法计算最优路由
 * - 生成并推送路由表到各 Edge
 * - 管理 Edge 网络质量上报
 */

import { EventEmitter } from 'events';
import { createLogger } from '@munode/common';
import { DEFAULT_ROUTING_POLICY } from '@munode/protocol';
import type { RoutingPolicy, VoiceRoutingConfig } from './types.js';

const logger = createLogger({ service: 'network-topology-manager' });

/**
 * Edge 间连接质量
 */
export interface EdgeConnectionQuality {
  rtt: number;             // RTT (ms)
  packetLoss: number;      // 丢包率 (0-1)
  jitter: number;          // 抖动 (ms)
  lastUpdate: number;      // 最后更新时间戳
  samples: number;         // 样本数量
}

/**
 * Edge 间连接信息
 */
export interface EdgeLink {
  sourceEdgeId: number;
  targetEdgeId: number;
  quality: EdgeConnectionQuality;
  bidirectional: boolean;  // 是否双向测量
}

/**
 * 路由类型
 */
export enum RouteType {
  DIRECT = 'direct',       // 直连
  RELAY = 'relay',         // Edge 中转
  FALLBACK = 'fallback',   // TCP 降级
}

/**
 * 路由表条目
 */
export interface RouteEntry {
  targetEdgeId: number;
  type: RouteType;
  nextHop?: number;        // 中转时的下一跳 Edge ID
  cost: number;            // 路由成本
  timestamp: number;       // 更新时间戳
  source: 'hub' | 'local'; // 路由来源
  ttl?: number;            // 生存时间 (ms)
}

/**
 * Dijkstra 算法路径结果
 */
interface PathResult {
  path: number[];          // Edge ID 序列
  totalCost: number;       // 总成本
  hops: number;            // 跳数
}

/**
 * 网络拓扑管理器
 */
export class NetworkTopologyManager extends EventEmitter {
  // 所有已知的 Edge
  private edges: Set<number> = new Set();
  
  // Edge 间连接: "sourceId->targetId" -> EdgeLink
  private links: Map<string, EdgeLink> = new Map();
  
  // 每个 Edge 的路由表: edgeId -> (targetEdgeId -> RouteEntry)
  private routingTables: Map<number, Map<number, RouteEntry>> = new Map();
  
  // 路由策略配置
  private policy: Required<RoutingPolicy>;
  
  // 路由表更新定时器
  private updateTimer?: NodeJS.Timeout;
  
  // 功能启用状态
  private _isEnabled: boolean = false;

  constructor(config?: VoiceRoutingConfig) {
    super();
    this.policy = {
      directRttThreshold: config?.policy?.directRttThreshold ?? DEFAULT_ROUTING_POLICY.directRttThreshold,
      directLossThreshold: config?.policy?.directLossThreshold ?? DEFAULT_ROUTING_POLICY.directLossThreshold,
      enableRelay: config?.policy?.enableRelay ?? DEFAULT_ROUTING_POLICY.enableRelay,
      maxRelayHops: config?.policy?.maxRelayHops ?? DEFAULT_ROUTING_POLICY.maxRelayHops,
      relayCostFactor: config?.policy?.relayCostFactor ?? DEFAULT_ROUTING_POLICY.relayCostFactor,
      routeSwitchHysteresis: config?.policy?.routeSwitchHysteresis ?? DEFAULT_ROUTING_POLICY.routeSwitchHysteresis,
      routeSwitchCostDelta: config?.policy?.routeSwitchCostDelta ?? DEFAULT_ROUTING_POLICY.routeSwitchCostDelta,
      maxRelayLoadPerEdge: config?.policy?.maxRelayLoadPerEdge ?? DEFAULT_ROUTING_POLICY.maxRelayLoadPerEdge,
      probeInterval: config?.policy?.probeInterval ?? DEFAULT_ROUTING_POLICY.probeInterval,
      probeTimeout: 5000,
      routeTableUpdateInterval: config?.policy?.routeTableUpdateInterval ?? DEFAULT_ROUTING_POLICY.routeTableUpdateInterval,
    };
    
    this._isEnabled = config?.enabled ?? false;
    
    logger.info('NetworkTopologyManager initialized', {
      enabled: this._isEnabled,
      policy: this.policy,
    });
  }

  /**
   * 启动拓扑管理器
   */
  start(): void {
    if (!this._isEnabled) {
      logger.debug('NetworkTopologyManager is disabled');
      return;
    }
    
    // 启动定时路由表更新
    this.updateTimer = setInterval(() => {
      this.computeAndPushRouteTables();
    }, this.policy.routeTableUpdateInterval);
    
    logger.info('NetworkTopologyManager started', {
      updateInterval: this.policy.routeTableUpdateInterval,
    });
  }

  /**
   * 停止拓扑管理器
   */
  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }
    
    logger.info('NetworkTopologyManager stopped');
  }

  /**
   * 设置功能启用状态
   */
  setEnabled(enabled: boolean): void {
    const wasEnabled = this._isEnabled;
    this._isEnabled = enabled;
    
    if (enabled && !wasEnabled) {
      this.start();
    } else if (!enabled && wasEnabled) {
      this.stop();
    }
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this._isEnabled;
  }

  /**
   * 添加 Edge
   */
  addEdge(edgeId: number): void {
    if (!this.edges.has(edgeId)) {
      this.edges.add(edgeId);
      this.routingTables.set(edgeId, new Map());
      logger.info(`Edge ${edgeId} added to topology`);
      
      // 触发路由表重新计算
      if (this._isEnabled) {
        this.scheduleRouteTableUpdate();
      }
    }
  }

  /**
   * 移除 Edge
   */
  removeEdge(edgeId: number): void {
    if (this.edges.has(edgeId)) {
      this.edges.delete(edgeId);
      this.routingTables.delete(edgeId);
      
      // 移除所有相关链接
      for (const key of this.links.keys()) {
        if (key.startsWith(`${edgeId}->`) || key.endsWith(`->${edgeId}`)) {
          this.links.delete(key);
        }
      }
      
      logger.info(`Edge ${edgeId} removed from topology`);
      
      // 触发路由表重新计算
      if (this._isEnabled) {
        this.scheduleRouteTableUpdate();
      }
    }
  }

  /**
   * 获取所有 Edge ID
   */
  getAllEdges(): number[] {
    return Array.from(this.edges);
  }

  /**
   * 更新 Edge 间链接质量
   */
  updateLink(link: EdgeLink): void {
    const key = this.getLinkKey(link.sourceEdgeId, link.targetEdgeId);
    this.links.set(key, link);
    
    logger.debug(`Link updated: ${link.sourceEdgeId} -> ${link.targetEdgeId}`, {
      rtt: link.quality.rtt,
      packetLoss: link.quality.packetLoss,
    });
    
    // 触发路由表重新计算
    if (this._isEnabled) {
      this.scheduleRouteTableUpdate();
    }
  }

  /**
   * 获取链接质量
   */
  getLink(sourceEdgeId: number, targetEdgeId: number): EdgeLink | undefined {
    return this.links.get(this.getLinkKey(sourceEdgeId, targetEdgeId));
  }

  /**
   * 计算链接键
   */
  private getLinkKey(sourceId: number, targetId: number): string {
    return `${sourceId}->${targetId}`;
  }

  /**
   * 计算直连成本
   * 成本 = RTT + 丢包惩罚 (每1%丢包相当于10ms RTT)
   */
  private calculateDirectCost(quality: EdgeConnectionQuality): number {
    return quality.rtt + quality.packetLoss * 1000;
  }

  /**
   * 检查直连是否可行
   */
  private isDirectRouteFeasible(quality?: EdgeConnectionQuality): boolean {
    if (!quality) return false;
    
    return (
      quality.rtt <= this.policy.directRttThreshold &&
      quality.packetLoss <= this.policy.directLossThreshold
    );
  }

  /**
   * 使用 Dijkstra 算法计算从源 Edge 到目标 Edge 的最优路径
   */
  findBestPath(sourceEdgeId: number, targetEdgeId: number): PathResult | null {
    if (sourceEdgeId === targetEdgeId) {
      return null;
    }
    
    if (!this.edges.has(sourceEdgeId) || !this.edges.has(targetEdgeId)) {
      return null;
    }
    
    // Dijkstra 算法
    const distances: Map<number, number> = new Map();
    const previous: Map<number, number> = new Map();
    const visited: Set<number> = new Set();
    
    // 初始化
    for (const edgeId of this.edges) {
      distances.set(edgeId, edgeId === sourceEdgeId ? 0 : Infinity);
    }
    
    while (visited.size < this.edges.size) {
      // 找到未访问的最小距离节点
      let minDistance = Infinity;
      let currentNode: number | null = null;
      
      for (const [edgeId, distance] of distances) {
        if (!visited.has(edgeId) && distance < minDistance) {
          minDistance = distance;
          currentNode = edgeId;
        }
      }
      
      if (currentNode === null || minDistance === Infinity) {
        break;
      }
      
      visited.add(currentNode);
      
      // 如果到达目标，提前退出
      if (currentNode === targetEdgeId) {
        break;
      }
      
      // 更新邻居距离
      for (const edgeId of this.edges) {
        if (visited.has(edgeId) || edgeId === currentNode) continue;
        
        const link = this.getLink(currentNode, edgeId);
        if (!link) continue;
        
        const edgeCost = this.calculateDirectCost(link.quality);
        const newDistance = distances.get(currentNode) + edgeCost;
        
        if (newDistance < distances.get(edgeId)) {
          distances.set(edgeId, newDistance);
          previous.set(edgeId, currentNode);
        }
      }
    }
    
    // 构建路径
    if (!previous.has(targetEdgeId) && sourceEdgeId !== targetEdgeId) {
      return null; // 无法到达
    }
    
    const path: number[] = [targetEdgeId];
    let current = targetEdgeId;
    
    while (previous.has(current)) {
      current = previous.get(current)!;
      path.unshift(current);
    }
    
    if (path[0] !== sourceEdgeId) {
      return null; // 路径不完整
    }
    
    return {
      path,
      totalCost: distances.get(targetEdgeId) ?? Infinity,
      hops: path.length - 1,
    };
  }

  /**
   * 为单个 Edge 计算到所有其他 Edge 的路由表
   */
  computeRoutingTableForEdge(edgeId: number): Map<number, RouteEntry> {
    const routeTable = new Map<number, RouteEntry>();
    
    for (const targetEdgeId of this.edges) {
      if (targetEdgeId === edgeId) continue;
      
      // 检查直连质量
      const directLink = this.getLink(edgeId, targetEdgeId);
      const directQuality = directLink?.quality;
      
      // 直连可行
      if (this.isDirectRouteFeasible(directQuality)) {
        routeTable.set(targetEdgeId, {
          targetEdgeId,
          type: RouteType.DIRECT,
          cost: this.calculateDirectCost(directQuality),
          timestamp: Date.now(),
          source: 'hub',
        });
        continue;
      }
      
      // 尝试中转路由
      if (this.policy.enableRelay) {
        const pathResult = this.findBestPath(edgeId, targetEdgeId);
        
        if (pathResult && pathResult.hops <= this.policy.maxRelayHops + 1) {
          // 应用中转成本因子
          const adjustedCost = pathResult.totalCost * this.policy.relayCostFactor;
          
          // 下一跳是路径中的第二个节点
          const nextHop = pathResult.path.length > 1 ? pathResult.path[1] : undefined;
          
          if (nextHop !== undefined) {
            routeTable.set(targetEdgeId, {
              targetEdgeId,
              type: RouteType.RELAY,
              nextHop,
              cost: adjustedCost,
              timestamp: Date.now(),
              source: 'hub',
            });
            continue;
          }
        }
      }
      
      // 降级到 TCP fallback
      routeTable.set(targetEdgeId, {
        targetEdgeId,
        type: RouteType.FALLBACK,
        cost: 9999,
        timestamp: Date.now(),
        source: 'hub',
      });
    }
    
    return routeTable;
  }

  /**
   * 为所有 Edge 计算全局路由表
   */
  computeGlobalRoutingTable(): Map<number, Map<number, RouteEntry>> {
    const globalTable = new Map<number, Map<number, RouteEntry>>();
    
    for (const edgeId of this.edges) {
      globalTable.set(edgeId, this.computeRoutingTableForEdge(edgeId));
    }
    
    return globalTable;
  }

  /**
   * 计算并推送路由表到所有 Edge
   */
  private computeAndPushRouteTables(): void {
    logger.debug('Computing global routing tables');
    
    const globalTable = this.computeGlobalRoutingTable();
    
    // 更新本地缓存
    this.routingTables = globalTable;
    
    // 触发推送事件
    for (const [edgeId, routeTable] of globalTable) {
      const routes = Array.from(routeTable.values());
      this.emit('routeTableUpdated', edgeId, routes);
      
      logger.debug(`Route table for Edge ${edgeId}:`, {
        routes: routes.map(r => ({
          target: r.targetEdgeId,
          type: r.type,
          nextHop: r.nextHop,
          cost: r.cost.toFixed(2),
        })),
      });
    }
    
    logger.info(`Computed routing tables for ${globalTable.size} edges`);
  }

  /**
   * 调度路由表更新（防抖）
   */
  private scheduleUpdateTimeout?: NodeJS.Timeout;
  private scheduleRouteTableUpdate(): void {
    if (this.scheduleUpdateTimeout) {
      clearTimeout(this.scheduleUpdateTimeout);
    }
    
    this.scheduleUpdateTimeout = setTimeout(() => {
      this.computeAndPushRouteTables();
      this.scheduleUpdateTimeout = undefined;
    }, 1000); // 1秒防抖
  }

  /**
   * 获取 Edge 的路由表
   */
  getRouteTableForEdge(edgeId: number): RouteEntry[] {
    const routeTable = this.routingTables.get(edgeId);
    if (!routeTable) {
      return [];
    }
    return Array.from(routeTable.values());
  }

  /**
   * 获取拓扑统计信息
   */
  getTopologyStats(): {
    edgeCount: number;
    linkCount: number;
    avgRtt: number;
    avgPacketLoss: number;
  } {
    let totalRtt = 0;
    let totalPacketLoss = 0;
    let linkCount = 0;
    
    for (const link of this.links.values()) {
      totalRtt += link.quality.rtt;
      totalPacketLoss += link.quality.packetLoss;
      linkCount++;
    }
    
    return {
      edgeCount: this.edges.size,
      linkCount,
      avgRtt: linkCount > 0 ? totalRtt / linkCount : 0,
      avgPacketLoss: linkCount > 0 ? totalPacketLoss / linkCount : 0,
    };
  }

  /**
   * 验证路由表条目
   * 
   * 检查路由条目是否有效：
   * - 目标 Edge ID 必须在拓扑中存在
   * - 路由类型必须有效
   * - 中转模式必须有 nextHop 且 nextHop 存在于拓扑中
   * - nextHop 不能等于 targetEdgeId
   * - cost 必须为非负数
   * - timestamp 必须有效
   */
  validateRouteEntry(sourceEdgeId: number, route: RouteEntry): { valid: boolean; error?: string } {
    // 检查源 Edge
    if (!this.edges.has(sourceEdgeId)) {
      return {
        valid: false,
        error: `Source Edge ${sourceEdgeId} does not exist in topology`
      };
    }

    // 检查目标 Edge
    if (!this.edges.has(route.targetEdgeId)) {
      return {
        valid: false,
        error: `Target Edge ${route.targetEdgeId} does not exist in topology`
      };
    }

    // 源和目标不能相同
    if (sourceEdgeId === route.targetEdgeId) {
      return {
        valid: false,
        error: `Source (${sourceEdgeId}) and target (${route.targetEdgeId}) cannot be the same`
      };
    }

    // 检查路由类型
    if (!route.type || !Object.values(RouteType).includes(route.type)) {
      return {
        valid: false,
        error: `Invalid route type: ${route.type}`
      };
    }

    // 中转模式必须有 nextHop
    if (route.type === RouteType.RELAY) {
      if (!route.nextHop) {
        return {
          valid: false,
          error: 'Relay route must have nextHop'
        };
      }

      // nextHop 必须存在于拓扑中
      if (!this.edges.has(route.nextHop)) {
        return {
          valid: false,
          error: `nextHop ${route.nextHop} does not exist in topology`
        };
      }

      // nextHop 不能等于源或目标
      if (route.nextHop === route.targetEdgeId) {
        return {
          valid: false,
          error: `nextHop (${route.nextHop}) cannot equal targetEdgeId (${route.targetEdgeId})`
        };
      }

      if (route.nextHop === sourceEdgeId) {
        return {
          valid: false,
          error: `nextHop (${route.nextHop}) cannot equal source (${sourceEdgeId})`
        };
      }
    }

    // 检查 cost
    if (typeof route.cost !== 'number' || route.cost < 0) {
      return {
        valid: false,
        error: `Invalid cost: ${route.cost} (must be non-negative number)`
      };
    }

    // 检查 timestamp
    if (!route.timestamp || typeof route.timestamp !== 'number' || route.timestamp <= 0) {
      return {
        valid: false,
        error: `Invalid timestamp: ${route.timestamp}`
      };
    }

    // 检查 source
    if (route.source !== 'hub' && route.source !== 'local') {
      return {
        valid: false,
        error: `Invalid source: ${route.source} (must be 'hub' or 'local')`
      };
    }

    return { valid: true };
  }

  /**
   * 验证单个 Edge 的路由表
   * 
   * 检查路由表的整体一致性：
   * - 所有路由条目都有效
   * - 没有循环路由
   * - 中转节点可达
   */
  validateRouteTableForEdge(edgeId: number): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.edges.has(edgeId)) {
      return {
        valid: false,
        errors: [`Edge ${edgeId} does not exist in topology`]
      };
    }

    const routeTable = this.routingTables.get(edgeId);
    if (!routeTable) {
      return {
        valid: false,
        errors: [`No route table found for Edge ${edgeId}`]
      };
    }

    // 验证每个路由条目
    for (const [targetEdgeId, route] of routeTable) {
      const validation = this.validateRouteEntry(edgeId, route);
      if (!validation.valid) {
        errors.push(`Route from Edge ${edgeId} to ${targetEdgeId}: ${validation.error}`);
      }

      // 检查路由表键和条目的 targetEdgeId 是否一致
      if (targetEdgeId !== route.targetEdgeId) {
        errors.push(
          `Route table key (${targetEdgeId}) does not match targetEdgeId (${route.targetEdgeId})`
        );
      }

      // 检查中转路由的可达性
      if (route.type === RouteType.RELAY && route.nextHop) {
        // 检查从源到 nextHop 的链接是否存在
        const linkToNextHop = this.getLink(edgeId, route.nextHop);
        if (!linkToNextHop) {
          errors.push(
            `Relay route from Edge ${edgeId} to ${targetEdgeId} via ${route.nextHop}, ` +
            `but no link exists from ${edgeId} to ${route.nextHop}`
          );
        }

        // 检查从 nextHop 到目标的链接是否存在
        const linkFromNextHop = this.getLink(route.nextHop, targetEdgeId);
        if (!linkFromNextHop) {
          errors.push(
            `Relay route from Edge ${edgeId} to ${targetEdgeId} via ${route.nextHop}, ` +
            `but no link exists from ${route.nextHop} to ${targetEdgeId}`
          );
        }
      }
    }

    // 检测简单的循环路由（A -> B via C, B -> A via C）
    for (const [targetEdgeId, route] of routeTable) {
      if (route.type === RouteType.RELAY && route.nextHop) {
        const reverseRouteTable = this.routingTables.get(targetEdgeId);
        if (reverseRouteTable) {
          const reverseRoute = reverseRouteTable.get(edgeId);
          if (reverseRoute && reverseRoute.type === RouteType.RELAY) {
            if (reverseRoute.nextHop === route.nextHop) {
              errors.push(
                `Possible circular route: Edge ${edgeId} -> ${targetEdgeId} via ${route.nextHop}, ` +
                `Edge ${targetEdgeId} -> ${edgeId} via ${reverseRoute.nextHop}`
              );
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 验证所有 Edge 的路由表
   */
  validateAllRouteTables(): { valid: boolean; errors: Map<number, string[]> } {
    const allErrors = new Map<number, string[]>();

    for (const edgeId of this.edges) {
      const validation = this.validateRouteTableForEdge(edgeId);
      if (!validation.valid) {
        allErrors.set(edgeId, validation.errors);
      }
    }

    return {
      valid: allErrors.size === 0,
      errors: allErrors
    };
  }

  /**
   * 获取路由表统计信息（针对特定 Edge）
   */
  getRouteTableStats(edgeId: number): {
    totalRoutes: number;
    directRoutes: number;
    relayRoutes: number;
    fallbackRoutes: number;
    avgCost: number;
  } | null {
    const routeTable = this.routingTables.get(edgeId);
    if (!routeTable) {
      return null;
    }

    let directRoutes = 0;
    let relayRoutes = 0;
    let fallbackRoutes = 0;
    let totalCost = 0;

    for (const route of routeTable.values()) {
      switch (route.type) {
        case RouteType.DIRECT:
          directRoutes++;
          break;
        case RouteType.RELAY:
          relayRoutes++;
          break;
        case RouteType.FALLBACK:
          fallbackRoutes++;
          break;
      }
      totalCost += route.cost;
    }

    return {
      totalRoutes: routeTable.size,
      directRoutes,
      relayRoutes,
      fallbackRoutes,
      avgCost: routeTable.size > 0 ? totalCost / routeTable.size : 0,
    };
  }

  /**
   * 处理 Edge 上报的网络质量
   */
  handleQualityReport(
    reportingEdgeId: number,
    targetEdgeId: number,
    quality: EdgeConnectionQuality
  ): void {
    this.updateLink({
      sourceEdgeId: reportingEdgeId,
      targetEdgeId,
      quality,
      bidirectional: false,
    });
  }
}
