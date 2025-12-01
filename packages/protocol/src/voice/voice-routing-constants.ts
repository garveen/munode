/**
 * 语音路由默认配置常量
 * 
 * 这些常量在 Hub 和 Edge 之间共享，确保默认值一致
 */

/**
 * 默认路由策略配置
 */
export const DEFAULT_ROUTING_POLICY = {
  directRttThreshold: 200,        // 直连 RTT 上限 (ms)
  directLossThreshold: 0.05,      // 直连丢包率上限
  enableRelay: true,              // 是否启用中转
  maxRelayHops: 1,                // 最大中转跳数
  relayCostFactor: 1.2,           // 中转成本因子
  routeSwitchHysteresis: 5000,    // 切换滞后时间 (ms)
  routeSwitchCostDelta: 0.3,      // 切换成本差异阈值
  maxRelayLoadPerEdge: 0.7,       // 单 Edge 最大中转负载
  probeInterval: 10000,           // 探测间隔 (ms)
  routeTableUpdateInterval: 30000, // Hub 推送路由表间隔 (ms)
} as const;

/**
 * 默认 Hub 中转配置
 */
export const DEFAULT_HUB_RELAY_CONFIG = {
  enableUdpRelay: false,          // 完全移除 Hub 的 UDP 中转功能
  enableTcpFallback: true,        // 仅保留 TCP 降级功能
  tcpRelayPriority: 'last' as const,  // TCP 中转作为最后手段
} as const;

/**
 * 默认 Edge 本地决策配置
 */
export const DEFAULT_LOCAL_DECISION_CONFIG = {
  enabled: true,
  updateInterval: 5000,
  qualityCheckInterval: 10000,
  directRttThreshold: 200,
  directLossThreshold: 0.05,
} as const;

/**
 * 默认 Edge 中转配置
 */
export const DEFAULT_EDGE_RELAY_CONFIG = {
  enabled: true,
  maxRelayCpuLoad: 0.7,
  maxRelayBandwidth: 10000,       // kbps
  softLimitThreshold: 0.7,
  hardLimitThreshold: 0.9,
  recoveryThreshold: 0.6,
  priority: 1,
} as const;

/**
 * 默认网络探测配置
 */
export const DEFAULT_PROBE_CONFIG = {
  enabled: true,
  method: 'passive' as const,
  updateInterval: 10000,
  lossWindowSize: 100,
  rttSmoothFactor: 0.2,
  metricsTTL: 30000,
} as const;

/**
 * 默认降级策略配置
 */
export const DEFAULT_FALLBACK_CONFIG = {
  enableTcpFallback: true,
  tcpFallbackDelay: 10000,
  udpRecoveryCheckInterval: 30000,
} as const;
