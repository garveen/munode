/**
 * Edge Server 配置验证和默认值（基于 Zod）
 */

import { z } from 'zod';

// ===== 网络配置 Schema =====
export const NetworkConfigSchema = z.object({
  host: z.string().min(1, 'host cannot be empty'),
  port: z.number().int().min(1).max(65535, 'port must be between 1 and 65535'),
  external_host: z.string().min(1, 'externalHost cannot be empty'),
  external_port: z.number().int().min(1).max(65535).optional(),
  region: z.string().optional(),
}).strict();

// ===== TLS 配置 Schema =====
export const TLSConfigSchema = z.object({
  cert: z.string(),
  key: z.string(),
  ca: z.string().optional(),
  require_client_cert: z.boolean().default(false),
  reject_unauthorized: z.boolean().default(false),
}).strict();

// ===== SMUX 选项 Schema =====
export const SmuxOptionsSchema = z.object({
  max_stream_window_size: z.number().int().positive().default(262144),
  max_session_window_size: z.number().int().positive().default(524288),
}).strict();

// ===== Hub 服务器配置 Schema =====
export const HubServerConfigSchema = z.object({
  host: z.string().min(1, 'hubServer.host cannot be empty'),
  port: z.number().int().min(1).max(65535),
  control_port: z.number().int().min(1).max(65535),
  tls: z.object({
    ca: z.string().optional(),
    reject_unauthorized: z.boolean().default(false),
  }).strict(),
  connection_type: z.enum(['websocket', 'smux']).default('websocket'),
  reconnect_interval: z.number().int().positive().default(5000),
  heartbeat_interval: z.number().int().positive().default(30000),
  hmac_secret: z.string().optional(),
  pool_size: z.number().int().min(1).default(2),
  reconnection_timeout: z.number().int().positive().default(30000),
  options: SmuxOptionsSchema.optional(),
}).strict();

// ===== 语音路由配置 Schema =====
export const EdgeVoiceRoutingConfigSchema = z.object({
  shared_secret: z.string().optional(),
  enabled: z.boolean().default(true),
  hub_policy: z.object({
    direct_rtt_threshold: z.number().positive().default(200),
    direct_loss_threshold: z.number().min(0).max(1).default(0.05),
    enable_relay: z.boolean().default(true),
    max_relay_hops: z.number().int().positive().default(1),
    relay_cost_factor: z.number().positive().default(1.2),
    route_switch_hysteresis: z.number().positive().default(5000),
    route_switch_cost_delta: z.number().positive().default(0.3),
    max_relay_load_per_edge: z.number().min(0).max(1).default(0.7),
    probe_interval: z.number().int().positive().default(10000),
    route_table_update_interval: z.number().int().positive().default(30000),
  }).strict().optional(),
  local_decision: z.object({
    enabled: z.boolean().default(true),
    update_interval: z.number().int().positive().default(5000),
    quality_check_interval: z.number().int().positive().default(10000),
    direct_rtt_threshold: z.number().positive().default(100),
    direct_loss_threshold: z.number().min(0).max(1).default(0.05),
  }).strict().optional(),
  relay: z.object({
    enabled: z.boolean().default(true),
    max_relay_cpu_load: z.number().min(0).max(1).default(0.8),
    max_relay_bandwidth: z.number().positive().default(10000),
    soft_limit_threshold: z.number().min(0).max(1).default(0.7),
    hard_limit_threshold: z.number().min(0).max(1).default(0.9),
    recovery_threshold: z.number().min(0).max(1).default(0.6),
    priority: z.number().int().min(1).max(10).default(5),
  }).strict().optional(),
  probe: z.object({
    enabled: z.boolean().default(false),
    method: z.literal('passive').default('passive'),
    update_interval: z.number().int().positive().default(5000),
    loss_window_size: z.number().int().positive().default(100),
    rtt_smooth_factor: z.number().min(0).max(1).default(0.125),
    metrics_ttl: z.number().int().positive().default(30000),
  }).strict().optional(),
  fallback: z.object({
    enable_tcp_fallback: z.boolean().default(false),
    tcp_fallback_delay: z.number().int().positive().default(2000),
    udp_recovery_check_interval: z.number().int().positive().default(5000),
  }).strict().optional(),
}).strict().optional();

// ===== 服务器设置 Schema =====
export const ServerConfigSchema = z.object({
  capacity: z.number().int().positive().default(1000),
  max_bandwidth: z.number().int().positive().default(558000), // 558 Kbps
  default_channel: z.number().int().min(0).default(0),
  welcome_text: z.string().optional(),
  timeout: z.number().int().positive().default(30),
}).strict();

// ===== 客户端设置 Schema =====
export const ClientConfigSchema = z.object({
  max_text_message_length: z.number().int().positive().default(5000),
  max_image_message_length: z.number().int().positive().default(131072), // 128 KB
  suggest_version: z.number().int().optional(),
  suggest_positional: z.boolean().optional(),
  suggest_push_to_talk: z.boolean().optional(),
}).strict();

// ===== 功能开关 Schema =====
export const FeatureConfigSchema = z.object({
  geoip: z.boolean().default(false),
  ban_system: z.boolean().default(true),
  context_actions: z.boolean().default(true),
  packet_pool: z.boolean().default(true),
  udp_monitor: z.boolean().default(true),
  allow_ping: z.boolean().default(true),
  allow_html: z.boolean().default(true),
}).strict();

// ===== 主配置 Schema =====
export const EdgeConfigSchema = z.object({
  server_id: z.number().int().positive('server_id must be a positive integer'),
  name: z.string().min(1, 'name cannot be empty'),
  mode: z.literal('cluster'),
  network: NetworkConfigSchema,
  tls: TLSConfigSchema,
  hub_server: HubServerConfigSchema.optional(),
  voice_routing: EdgeVoiceRoutingConfigSchema,
  server: ServerConfigSchema,
  client: ClientConfigSchema,
  features: FeatureConfigSchema,
  log_level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
}).strict();

/**
 * 验证并应用默认值
 */
export function validateAndParseEdgeConfig(rawConfig: unknown): EdgeConfig {
  try {
    return EdgeConfigSchema.parse(rawConfig) as EdgeConfig;
  } catch (error) {
    if (error && typeof error === 'object' && 'issues' in error) {
      const zodError = error as { issues: Array<{ path: (string | number)[]; message: string }> };
      const errorMessages = zodError.issues.map(err => {
        const path = err.path.join('.');
        return `  - ${path}: ${err.message}`;
      });
      
      throw new Error(
        `Edge Server configuration validation failed:\n${errorMessages.join('\n')}\n\n` +
        'Please check your configuration file and ensure all required fields are present and valid.'
      );
    }
    throw error;
  }
}

/**
 * 获取默认配置
 */
export function getDefaultEdgeConfig(): z.infer<typeof EdgeConfigSchema> {
  return EdgeConfigSchema.parse({
    server_id: 1,
    name: 'Edge Server',
    mode: 'cluster',
    network: {
      host: '0.0.0.0',
      port: 64738,
      external_host: 'localhost',
    },
    tls: {
      cert: '',
      key: '',
    },
    server: {},
    client: {},
    features: {},
  });
}

// ===== 从 Zod schema 导出类型 =====
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;
export type TLSConfig = z.infer<typeof TLSConfigSchema>;
export type SmuxOptions = z.infer<typeof SmuxOptionsSchema>;
export type HubServerConfig = z.infer<typeof HubServerConfigSchema>;
export type EdgeVoiceRoutingConfig = z.infer<typeof EdgeVoiceRoutingConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ClientConfig = z.infer<typeof ClientConfigSchema>;
export type FeatureConfig = z.infer<typeof FeatureConfigSchema>;
export type EdgeConfig = z.infer<typeof EdgeConfigSchema>;
export type EdgeConfigInput = z.input<typeof EdgeConfigSchema>;
