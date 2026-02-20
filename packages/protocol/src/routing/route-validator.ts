/**
 * 路由表验证工具
 * 
 * 提供共享的路由验证逻辑，供 Edge 和 Hub 使用
 */

import { RouteType } from '../shared-types.js';
import type { RouteEntry } from '../shared-types.js';

/**
 * 验证结果
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * 路由验证器配置
 */
export interface RouteValidatorOptions {
  sourceEdgeId: number;
  allowedEdgeIds?: Set<number>; // 可选：允许的 Edge ID 集合
}

/**
 * 路由验证器类
 */
export class RouteValidator {
  /**
   * 验证路由类型是否有效
   */
  static validateRouteType(type: RouteType): ValidationResult {
    if (!type || !Object.values(RouteType).includes(type)) {
      return {
        valid: false,
        error: `Invalid route type: ${type}`
      };
    }
    return { valid: true };
  }

  /**
   * 验证目标 Edge ID
   */
  static validateTargetEdgeId(
    targetEdgeId: number,
    sourceEdgeId: number,
    allowedEdgeIds?: Set<number>
  ): ValidationResult {
    // 检查目标 ID 是否存在
    if (!targetEdgeId || targetEdgeId <= 0) {
      return {
        valid: false,
        error: `Invalid targetEdgeId: ${targetEdgeId}`
      };
    }

    // 源和目标不能相同
    if (targetEdgeId === sourceEdgeId) {
      return {
        valid: false,
        error: `Target Edge ${targetEdgeId} cannot equal source Edge ${sourceEdgeId}`
      };
    }

    // 如果提供了允许的 Edge ID 集合，检查目标是否在其中
    if (allowedEdgeIds && !allowedEdgeIds.has(targetEdgeId)) {
      return {
        valid: false,
        error: `Target Edge ${targetEdgeId} does not exist in allowed edges`
      };
    }

    return { valid: true };
  }

  /**
   * 验证中转节点 (nextHop)
   */
  static validateNextHop(
    route: RouteEntry,
    sourceEdgeId: number,
    allowedEdgeIds?: Set<number>
  ): ValidationResult {
    // 只有 RELAY 类型需要 nextHop
    if (route.type !== RouteType.RELAY) {
      return { valid: true };
    }

    // RELAY 必须有 nextHop
    if (!route.nextHop) {
      return {
        valid: false,
        error: 'Relay route must have nextHop'
      };
    }

    // nextHop 不能等于目标
    if (route.nextHop === route.targetEdgeId) {
      return {
        valid: false,
        error: `nextHop (${route.nextHop}) cannot equal targetEdgeId (${route.targetEdgeId})`
      };
    }

    // nextHop 不能等于源
    if (route.nextHop === sourceEdgeId) {
      return {
        valid: false,
        error: `nextHop (${route.nextHop}) cannot equal source (${sourceEdgeId})`
      };
    }

    // 如果提供了允许的 Edge ID 集合，检查 nextHop 是否在其中
    if (allowedEdgeIds && !allowedEdgeIds.has(route.nextHop)) {
      return {
        valid: false,
        error: `nextHop ${route.nextHop} does not exist in allowed edges`
      };
    }

    return { valid: true };
  }

  /**
   * 验证路由成本
   */
  static validateCost(cost: number): ValidationResult {
    if (typeof cost !== 'number' || cost < 0 || !isFinite(cost)) {
      return {
        valid: false,
        error: `Invalid cost: ${cost} (must be non-negative finite number)`
      };
    }
    return { valid: true };
  }

  /**
   * 验证时间戳
   */
  static validateTimestamp(timestamp: number): ValidationResult {
    if (!timestamp || typeof timestamp !== 'number' || timestamp <= 0 || !isFinite(timestamp)) {
      return {
        valid: false,
        error: `Invalid timestamp: ${timestamp}`
      };
    }
    return { valid: true };
  }

  /**
   * 验证路由来源
   */
  static validateSource(source: string): ValidationResult {
    if (source !== 'hub' && source !== 'local') {
      return {
        valid: false,
        error: `Invalid source: ${source} (must be 'hub' or 'local')`
      };
    }
    return { valid: true };
  }

  /**
   * 验证完整的路由条目
   */
  static validateRouteEntry(
    route: RouteEntry,
    options: RouteValidatorOptions
  ): ValidationResult {
    // 验证目标 Edge ID
    let result = this.validateTargetEdgeId(
      route.targetEdgeId,
      options.sourceEdgeId,
      options.allowedEdgeIds
    );
    if (!result.valid) return result;

    // 验证路由类型
    result = this.validateRouteType(route.type);
    if (!result.valid) return result;

    // 验证中转节点
    result = this.validateNextHop(route, options.sourceEdgeId, options.allowedEdgeIds);
    if (!result.valid) return result;

    // 验证成本
    result = this.validateCost(route.cost);
    if (!result.valid) return result;

    // 验证时间戳
    result = this.validateTimestamp(route.timestamp);
    if (!result.valid) return result;

    // 验证来源
    result = this.validateSource(route.source);
    if (!result.valid) return result;

    return { valid: true };
  }

  /**
   * 检测循环路由
   * 
   * @param routes 路由表 Map
   * @param sourceEdgeId 源 Edge ID
   * @param targetEdgeId 目标 Edge ID
   * @returns 如果存在循环则返回循环路径，否则返回 null
   */
  static detectCircularRoute(
    routes: Map<number, RouteEntry>,
    sourceEdgeId: number,
    targetEdgeId: number
  ): number[] | null {
    const visited = new Set<number>();
    const path: number[] = [sourceEdgeId];

    let currentEdge = sourceEdgeId;
    const route = routes.get(targetEdgeId);

    if (!route) return null;

    // 跟踪路由路径
    while (route && route.type === RouteType.RELAY && route.nextHop) {
      if (visited.has(route.nextHop)) {
        // 发现循环
        path.push(route.nextHop);
        return path;
      }

      visited.add(route.nextHop);
      path.push(route.nextHop);

      // 检查反向路由
      const reverseRoute = routes.get(currentEdge);
      if (reverseRoute && reverseRoute.type === RouteType.RELAY && reverseRoute.nextHop === route.nextHop) {
        // 发现对称循环
        return path;
      }

      currentEdge = route.nextHop;
      break; // 只检查一跳，避免过度计算
    }

    return null;
  }

  /**
   * 获取路由统计信息
   */
  static getRouteStats(routes: Map<number, RouteEntry>): {
    totalRoutes: number;
    directRoutes: number;
    relayRoutes: number;
    fallbackRoutes: number;
    hubRoutes: number;
    localRoutes: number;
  } {
    let directRoutes = 0;
    let relayRoutes = 0;
    let fallbackRoutes = 0;
    let hubRoutes = 0;
    let localRoutes = 0;

    for (const route of routes.values()) {
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

      if (route.source === 'hub') {
        hubRoutes++;
      } else {
        localRoutes++;
      }
    }

    return {
      totalRoutes: routes.size,
      directRoutes,
      relayRoutes,
      fallbackRoutes,
      hubRoutes,
      localRoutes,
    };
  }
}
