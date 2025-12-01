/**
 * VoiceRoutingManager - Edge 间语音路由管理器
 * 
 * 职责:
 * - 维护到其他 Edge 的路由表
 * - 收集网络质量指标（被动探测）
 * - 执行本地路由决策
 * - 处理来自 Hub 的路由表更新
 * - 管理中转转发功能
 */

import { EventEmitter } from 'events';
import { createLogger } from '@munode/common';
import {
  DEFAULT_ROUTING_POLICY,
  DEFAULT_LOCAL_DECISION_CONFIG,
  DEFAULT_EDGE_RELAY_CONFIG,
  DEFAULT_PROBE_CONFIG,
  DEFAULT_FALLBACK_CONFIG,
} from '@munode/protocol';
import type {
  EdgeConfig,
  EdgeVoiceRoutingConfig,
  EdgeRoutingPolicy,
  RouteEntry,
  EdgeConnectionQuality,
} from '../types.js';
import { RouteType } from '../types.js';

const logger = createLogger({ service: 'voice-routing-manager' });

/**
 * 中转统计信息
 */
interface RelayStats {
  packetsRelayed: number;        // 中转的包数量
  bytesRelayed: number;          // 中转的字节数
  activeRelays: number;          // 当前活跃的中转连接数
  cpuLoad: number;               // 当前 CPU 负载
  bandwidthUsage: number;        // 当前带宽使用 (kbps)
  lastUpdate: number;            // 最后更新时间
}

/**
 * 网络质量样本
 */
interface QualitySample {
  rtt: number;
  timestamp: number;
  sequence: number;
}

/**
 * 默认 Edge 语音路由配置（使用共享常量）
 */
const DEFAULT_VOICE_ROUTING_CONFIG: Required<EdgeVoiceRoutingConfig> = {
  enabled: false,
  hubPolicy: { ...DEFAULT_ROUTING_POLICY },
  localDecision: { ...DEFAULT_LOCAL_DECISION_CONFIG },
  relay: { ...DEFAULT_EDGE_RELAY_CONFIG },
  probe: { ...DEFAULT_PROBE_CONFIG },
  fallback: { ...DEFAULT_FALLBACK_CONFIG },
};

export class VoiceRoutingManager extends EventEmitter {
  private config: EdgeConfig;
  private voiceRoutingConfig: Required<EdgeVoiceRoutingConfig>;
  private serverId: number;
  
  // 路由表: targetEdgeId -> RouteEntry
  private routingTable: Map<number, RouteEntry> = new Map();
  
  // 网络质量: targetEdgeId -> EdgeConnectionQuality
  private connectionQualities: Map<number, EdgeConnectionQuality> = new Map();
  
  // 质量样本: targetEdgeId -> QualitySample[]
  private qualitySamples: Map<number, QualitySample[]> = new Map();
  
  // 序列号追踪: targetEdgeId -> { expected: number, received: Set<number> }
  private sequenceTracking: Map<number, { expected: number; received: Set<number> }> = new Map();
  
  // 中转统计
  private relayStats: RelayStats;
  
  // 定时器
  private localRouteUpdateTimer?: NodeJS.Timeout;
  private qualityCheckTimer?: NodeJS.Timeout;
  private metricsCleanupTimer?: NodeJS.Timeout;
  
  // Hub 推送的路由表
  private hubRouteTable: Map<number, RouteEntry> = new Map();
  
  // 功能启用状态
  private _isEnabled: boolean = false;

  constructor(config: EdgeConfig) {
    super();
    this.config = config;
    this.serverId = config.server_id;
    
    // 合并配置
    this.voiceRoutingConfig = this.mergeConfig(this.config.voiceRouting);
    
    // 初始化中转统计
    this.relayStats = this.initRelayStats();
    
    logger.info(`VoiceRoutingManager initialized for Edge ${this.serverId}`);
  }

  /**
   * 合并配置，使用默认值填充缺失的配置
   */
  private mergeConfig(config?: EdgeVoiceRoutingConfig): Required<EdgeVoiceRoutingConfig> {
    if (!config) {
      return { ...DEFAULT_VOICE_ROUTING_CONFIG };
    }
    
    return {
      enabled: config.enabled ?? DEFAULT_VOICE_ROUTING_CONFIG.enabled,
      hubPolicy: config.hubPolicy 
        ? { ...DEFAULT_ROUTING_POLICY, ...config.hubPolicy }
        : DEFAULT_ROUTING_POLICY,
      localDecision: config.localDecision 
        ? { ...DEFAULT_VOICE_ROUTING_CONFIG.localDecision, ...config.localDecision }
        : DEFAULT_VOICE_ROUTING_CONFIG.localDecision,
      relay: config.relay 
        ? { ...DEFAULT_VOICE_ROUTING_CONFIG.relay, ...config.relay }
        : DEFAULT_VOICE_ROUTING_CONFIG.relay,
      probe: config.probe 
        ? { ...DEFAULT_VOICE_ROUTING_CONFIG.probe, ...config.probe }
        : DEFAULT_VOICE_ROUTING_CONFIG.probe,
      fallback: config.fallback 
        ? { ...DEFAULT_VOICE_ROUTING_CONFIG.fallback, ...config.fallback }
        : DEFAULT_VOICE_ROUTING_CONFIG.fallback,
    };
  }

  /**
   * 初始化中转统计
   */
  private initRelayStats(): RelayStats {
    return {
      packetsRelayed: 0,
      bytesRelayed: 0,
      activeRelays: 0,
      cpuLoad: 0,
      bandwidthUsage: 0,
      lastUpdate: Date.now(),
    };
  }

  /**
   * 启动路由管理器
   */
  async start(): Promise<void> {
    logger.info(`Starting VoiceRoutingManager, enabled: ${this._isEnabled}`);
    
    if (!this._isEnabled) {
      logger.debug('Voice routing is disabled, skipping timer setup');
      return;
    }
    
    // 启动本地路由更新定时器
    if (this.voiceRoutingConfig.localDecision.enabled) {
      this.startLocalRouteUpdate();
    }
    
    // 启动质量检查定时器
    if (this.voiceRoutingConfig.probe.enabled) {
      this.startQualityCheck();
    }
    
    // 启动指标清理定时器
    this.startMetricsCleanup();
    
    logger.info('VoiceRoutingManager started');
  }

  /**
   * 停止路由管理器
   */
  async stop(): Promise<void> {
    logger.info('Stopping VoiceRoutingManager');
    
    if (this.localRouteUpdateTimer) {
      clearInterval(this.localRouteUpdateTimer);
      this.localRouteUpdateTimer = undefined;
    }
    
    if (this.qualityCheckTimer) {
      clearInterval(this.qualityCheckTimer);
      this.qualityCheckTimer = undefined;
    }
    
    if (this.metricsCleanupTimer) {
      clearInterval(this.metricsCleanupTimer);
      this.metricsCleanupTimer = undefined;
    }
    
    logger.info('VoiceRoutingManager stopped');
  }

  /**
   * 设置功能启用状态（由 Hub 配置控制）
   */
  setEnabled(enabled: boolean): void {
    const wasEnabled = this._isEnabled;
    this._isEnabled = enabled;
    
    if (enabled && !wasEnabled) {
      // 启用功能
      logger.info('Voice routing enabled by Hub configuration');
      this.start();
    } else if (!enabled && wasEnabled) {
      // 禁用功能
      logger.info('Voice routing disabled by Hub configuration');
      this.stop();
    }
  }

  /**
   * 更新 Hub 推送的路由策略
   */
  updateHubPolicy(policy: EdgeRoutingPolicy): void {
    this.voiceRoutingConfig.hubPolicy = policy;
    logger.info('Hub routing policy updated', { policy });
    
    // 触发路由重新计算
    this.emit('policy-updated', policy);
  }

  /**
   * 处理 Hub 推送的路由表
   */
  handleHubRouteTable(routes: RouteEntry[]): void {
    logger.info(`Received ${routes.length} routes from Hub`);
    
    this.hubRouteTable.clear();
    for (const route of routes) {
      if (route.targetEdgeId !== this.serverId) {
        this.hubRouteTable.set(route.targetEdgeId, route);
        // 更新本地路由表（Hub 路由优先）
        this.updateRoute(route);
      }
    }
    
    this.emit('routes-updated', Array.from(this.routingTable.values()));
  }

  /**
   * 获取到目标 Edge 的路由
   */
  getRoute(targetEdgeId: number): RouteEntry | undefined {
    return this.routingTable.get(targetEdgeId);
  }

  /**
   * 获取所有路由
   */
  getAllRoutes(): RouteEntry[] {
    return Array.from(this.routingTable.values());
  }

  /**
   * 检查功能是否启用
   */
  isEnabled(): boolean {
    return this._isEnabled;
  }

  /**
   * 记录收到的语音包（用于被动探测）
   */
  recordReceivedPacket(
    sourceEdgeId: number, 
    sequence: number, 
    sendTimestamp?: number
  ): void {
    if (!this._isEnabled || !this.voiceRoutingConfig.probe.enabled) {
      return;
    }
    
    const now = Date.now();
    
    // 计算 RTT（如果有发送时间戳）
    if (sendTimestamp) {
      const rtt = now - sendTimestamp;
      this.updateRttSample(sourceEdgeId, rtt, sequence);
    }
    
    // 更新序列号追踪（用于丢包率计算）
    this.updateSequenceTracking(sourceEdgeId, sequence);
  }

  /**
   * 更新 RTT 样本
   */
  private updateRttSample(sourceEdgeId: number, rtt: number, sequence: number): void {
    const samples = this.qualitySamples.get(sourceEdgeId) || [];
    samples.push({
      rtt,
      timestamp: Date.now(),
      sequence,
    });
    
    // 限制样本数量
    const maxSamples = this.voiceRoutingConfig.probe.lossWindowSize;
    while (samples.length > maxSamples) {
      samples.shift();
    }
    
    this.qualitySamples.set(sourceEdgeId, samples);
    
    // 更新质量指标
    this.updateQualityMetrics(sourceEdgeId);
  }

  /**
   * 更新序列号追踪
   */
  private updateSequenceTracking(sourceEdgeId: number, sequence: number): void {
    let tracking = this.sequenceTracking.get(sourceEdgeId);
    if (!tracking) {
      tracking = { expected: sequence, received: new Set() };
      this.sequenceTracking.set(sourceEdgeId, tracking);
    }
    
    tracking.received.add(sequence);
    
    // 更新期望序列号
    if (sequence >= tracking.expected) {
      tracking.expected = sequence + 1;
    }
  }

  /**
   * 更新网络质量指标
   */
  private updateQualityMetrics(sourceEdgeId: number): void {
    const samples = this.qualitySamples.get(sourceEdgeId) || [];
    const tracking = this.sequenceTracking.get(sourceEdgeId);
    
    if (samples.length === 0) {
      return;
    }
    
    // 计算平滑 RTT（指数移动平均）
    const smoothFactor = this.voiceRoutingConfig.probe.rttSmoothFactor;
    let smoothedRtt = samples[0].rtt;
    for (let i = 1; i < samples.length; i++) {
      smoothedRtt = smoothFactor * samples[i].rtt + (1 - smoothFactor) * smoothedRtt;
    }
    
    // 计算抖动
    let jitter = 0;
    if (samples.length > 1) {
      let totalDiff = 0;
      for (let i = 1; i < samples.length; i++) {
        totalDiff += Math.abs(samples[i].rtt - samples[i - 1].rtt);
      }
      jitter = totalDiff / (samples.length - 1);
    }
    
    // 计算丢包率
    let packetLoss = 0;
    if (tracking && tracking.expected > 0) {
      const windowSize = this.voiceRoutingConfig.probe.lossWindowSize;
      const expectedPackets = Math.min(tracking.expected, windowSize);
      const receivedPackets = tracking.received.size;
      packetLoss = Math.max(0, (expectedPackets - receivedPackets) / expectedPackets);
    }
    
    // 更新质量信息
    const quality: EdgeConnectionQuality = {
      rtt: smoothedRtt,
      packetLoss,
      jitter,
      lastUpdate: Date.now(),
      samples: samples.length,
    };
    
    this.connectionQualities.set(sourceEdgeId, quality);
    
    // 触发质量更新事件
    this.emit('quality-updated', sourceEdgeId, quality);
    
    logger.debug(`Quality updated for Edge ${sourceEdgeId}:`, quality);
  }

  /**
   * 获取到目标 Edge 的网络质量
   */
  getQuality(targetEdgeId: number): EdgeConnectionQuality | undefined {
    return this.connectionQualities.get(targetEdgeId);
  }

  /**
   * 启动本地路由更新定时器
   */
  private startLocalRouteUpdate(): void {
    const interval = this.voiceRoutingConfig.localDecision.updateInterval;
    
    this.localRouteUpdateTimer = setInterval(() => {
      this.performLocalRouteDecision();
    }, interval);
    
    logger.debug(`Local route update timer started, interval: ${interval}ms`);
  }

  /**
   * 启动质量检查定时器
   */
  private startQualityCheck(): void {
    const interval = this.voiceRoutingConfig.localDecision.qualityCheckInterval;
    
    this.qualityCheckTimer = setInterval(() => {
      this.checkQualityThresholds();
    }, interval);
    
    logger.debug(`Quality check timer started, interval: ${interval}ms`);
  }

  /**
   * 启动指标清理定时器
   */
  private startMetricsCleanup(): void {
    const ttl = this.voiceRoutingConfig.probe.metricsTTL;
    
    this.metricsCleanupTimer = setInterval(() => {
      this.cleanupExpiredMetrics();
    }, ttl);
    
    logger.debug(`Metrics cleanup timer started, interval: ${ttl}ms`);
  }

  /**
   * 执行本地路由决策
   */
  private performLocalRouteDecision(): void {
    for (const [targetEdgeId, quality] of this.connectionQualities) {
      const currentRoute = this.routingTable.get(targetEdgeId);
      const hubRoute = this.hubRouteTable.get(targetEdgeId);
      
      // 如果有 Hub 路由，优先使用
      if (hubRoute && hubRoute.source === 'hub') {
        continue;
      }
      
      // 执行本地决策
      const newRoute = this.calculateLocalRoute(targetEdgeId, quality);
      
      if (newRoute) {
        // 检查是否需要切换路由
        if (this.shouldSwitchRoute(currentRoute, newRoute)) {
          this.updateRoute(newRoute);
        }
      }
    }
  }

  /**
   * 计算本地路由
   */
  private calculateLocalRoute(
    targetEdgeId: number, 
    quality: EdgeConnectionQuality
  ): RouteEntry | null {
    const policy = this.voiceRoutingConfig.hubPolicy;
    
    // 检查直连是否可行
    if (this.isDirectRouteFeasible(quality)) {
      return {
        targetEdgeId,
        type: RouteType.DIRECT,
        cost: this.calculateDirectCost(quality),
        timestamp: Date.now(),
        source: 'local',
      };
    }
    
    // 尝试寻找中转路由
    if (policy.enableRelay) {
      const relayRoute = this.findBestRelayRoute(targetEdgeId);
      if (relayRoute) {
        return relayRoute;
      }
    }
    
    // 降级到 TCP
    if (this.voiceRoutingConfig.fallback.enableTcpFallback) {
      return {
        targetEdgeId,
        type: RouteType.FALLBACK,
        cost: 1000, // TCP 成本很高
        timestamp: Date.now(),
        source: 'local',
      };
    }
    
    return null;
  }

  /**
   * 检查直连是否可行
   */
  private isDirectRouteFeasible(quality?: EdgeConnectionQuality): boolean {
    if (!quality) {
      return true; // 没有质量数据时默认使用直连
    }
    
    const config = this.voiceRoutingConfig.localDecision;
    
    return quality.rtt <= config.directRttThreshold &&
           quality.packetLoss <= config.directLossThreshold;
  }

  /**
   * 计算直连成本
   */
  private calculateDirectCost(quality: EdgeConnectionQuality): number {
    // 成本 = RTT + 丢包惩罚
    // 丢包率每增加 1% 相当于增加 10ms RTT
    return quality.rtt + quality.packetLoss * 1000;
  }

  /**
   * 寻找最佳中转路由
   */
  private findBestRelayRoute(targetEdgeId: number): RouteEntry | null {
    const policy = this.voiceRoutingConfig.hubPolicy;
    let bestRoute: RouteEntry | null = null;
    let bestCost = Infinity;
    
    // 遍历所有已知的 Edge
    for (const [relayEdgeId, relayQuality] of this.connectionQualities) {
      if (relayEdgeId === targetEdgeId || relayEdgeId === this.serverId) {
        continue;
      }
      
      // 检查中转 Edge 是否可达
      if (!this.isDirectRouteFeasible(relayQuality)) {
        continue;
      }
      
      // 计算经过此 Edge 中转的成本
      // 这里简化处理，假设中转 Edge 到目标的质量与到我们的质量相似
      const relayCost = this.calculateDirectCost(relayQuality) * policy.relayCostFactor;
      
      if (relayCost < bestCost) {
        bestCost = relayCost;
        bestRoute = {
          targetEdgeId,
          type: RouteType.RELAY,
          nextHop: relayEdgeId,
          cost: relayCost,
          timestamp: Date.now(),
          source: 'local',
        };
      }
    }
    
    return bestRoute;
  }

  /**
   * 检查是否应该切换路由
   */
  private shouldSwitchRoute(
    currentRoute: RouteEntry | undefined, 
    newRoute: RouteEntry
  ): boolean {
    if (!currentRoute) {
      return true;
    }
    
    const policy = this.voiceRoutingConfig.hubPolicy;
    
    // 检查成本差异是否超过阈值
    const costDelta = (currentRoute.cost - newRoute.cost) / currentRoute.cost;
    if (Math.abs(costDelta) < policy.routeSwitchCostDelta) {
      return false;
    }
    
    // 检查滞后时间
    const timeSinceLastUpdate = Date.now() - currentRoute.timestamp;
    if (timeSinceLastUpdate < policy.routeSwitchHysteresis) {
      return false;
    }
    
    return true;
  }

  /**
   * 更新路由
   */
  private updateRoute(route: RouteEntry): void {
    const oldRoute = this.routingTable.get(route.targetEdgeId);
    this.routingTable.set(route.targetEdgeId, route);
    
    if (oldRoute) {
      logger.info(`Route updated: Edge ${route.targetEdgeId}, ` +
                  `${oldRoute.type} -> ${route.type}, cost: ${route.cost.toFixed(2)}`);
    } else {
      logger.info(`Route added: Edge ${route.targetEdgeId}, ` +
                  `type: ${route.type}, cost: ${route.cost.toFixed(2)}`);
    }
    
    this.emit('route-changed', route.targetEdgeId, route, oldRoute);
  }

  /**
   * 检查质量阈值
   */
  private checkQualityThresholds(): void {
    for (const [edgeId, quality] of this.connectionQualities) {
      const config = this.voiceRoutingConfig.localDecision;
      
      if (quality.rtt > config.directRttThreshold ||
          quality.packetLoss > config.directLossThreshold) {
        logger.warn(`Quality degradation detected for Edge ${edgeId}:`, {
          rtt: quality.rtt,
          packetLoss: quality.packetLoss,
        });
        
        this.emit('quality-degraded', edgeId, quality);
      }
    }
  }

  /**
   * 清理过期的质量指标
   */
  private cleanupExpiredMetrics(): void {
    const ttl = this.voiceRoutingConfig.probe.metricsTTL;
    const now = Date.now();
    
    for (const [edgeId, quality] of this.connectionQualities) {
      if (now - quality.lastUpdate > ttl) {
        this.connectionQualities.delete(edgeId);
        this.qualitySamples.delete(edgeId);
        this.sequenceTracking.delete(edgeId);
        
        logger.debug(`Expired quality metrics for Edge ${edgeId}`);
      }
    }
  }

  /**
   * 记录中转的包
   */
  recordRelayedPacket(bytes: number): void {
    this.relayStats.packetsRelayed++;
    this.relayStats.bytesRelayed += bytes;
    this.relayStats.lastUpdate = Date.now();
  }

  /**
   * 获取中转统计信息
   */
  getRelayStats(): RelayStats {
    return { ...this.relayStats };
  }

  /**
   * 检查是否可以接受新的中转请求
   */
  canAcceptRelay(): boolean {
    const relayConfig = this.voiceRoutingConfig.relay;
    
    if (!relayConfig.enabled) {
      return false;
    }
    
    // 检查 CPU 和带宽限制
    if (this.relayStats.cpuLoad >= relayConfig.hardLimitThreshold) {
      return false;
    }
    
    if (this.relayStats.bandwidthUsage >= relayConfig.maxRelayBandwidth * 0.9) {
      return false;
    }
    
    return true;
  }

  /**
   * 获取当前配置
   */
  getConfig(): Required<EdgeVoiceRoutingConfig> {
    return { ...this.voiceRoutingConfig };
  }
}
