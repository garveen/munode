/**
 * 语音路由默认配置常量
 * 
 * 这些常量在 Hub 和 Edge 之间共享，确保默认值一致
 */

/**
 * 默认路由策略配置
 */
export const DEFAULT_ROUTING_POLICY = {
  direct_rtt_threshold: 500,        // 直连 RTT 上限 (ms)
  direct_loss_threshold: 0.05,      // 直连丢包率上限
  enable_relay: true,              // 是否启用中转
  max_relay_hops: 1,                // 最大中转跳数
  relay_cost_factor: 1.2,           // 中转成本因子
  route_switch_hysteresis: 5000,    // 切换滞后时间 (ms)
  route_switch_cost_delta: 0.3,      // 切换成本差异阈值
  max_relay_load_per_edge: 0.7,       // 单 Edge 最大中转负载
  network_probe_interval: 10000,      // Hub 端网络质量探测间隔 (ms)
  route_table_update_interval: 30000, // Hub 推送路由表间隔 (ms)
} as const;

/**
 * 默认 Hub 中转配置
 */
export const DEFAULT_HUB_RELAY_CONFIG = {
  enable_tcp_fallback: true,        // 仅保留 TCP 降级功能
} as const;

/**
 * 默认 Edge 本地决策配置
 */
export const DEFAULT_LOCAL_DECISION_CONFIG = {
  enabled: true,
  update_interval: 5000,
  quality_check_interval: 10000,
  direct_rtt_threshold: 500,
  direct_loss_threshold: 0.05,
} as const;

/**
 * 默认 Edge 中转配置
 */
export const DEFAULT_EDGE_RELAY_CONFIG = {
  enabled: true,
  max_relay_cpu_load: 0.7,
  max_relay_bandwidth: 10000,       // kbps
  soft_limit_threshold: 0.7,
  hard_limit_threshold: 0.9,
  recovery_threshold: 0.6,
  priority: 1,
} as const;

/**
 * 默认网络探测配置
 */
export const DEFAULT_PROBE_CONFIG = {
  enabled: true,
  method: 'passive' as const,
  update_interval: 10000,
  loss_window_size: 100,
  rtt_smooth_factor: 0.2,
  metrics_ttl: 30000,
} as const;

/**
 * 默认降级策略配置
 */
export const DEFAULT_FALLBACK_CONFIG = {
  enable_tcp_fallback: true,
  tcp_fallback_delay: 10000,
  udp_recovery_check_interval: 30000,
} as const;
