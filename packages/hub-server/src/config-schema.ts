/**
 * Hub Server 配置验证和默认值（基于 Zod）
 */

import { z } from 'zod';

// ===== TLS 配置 Schema =====
const TLSConfigSchema = z.object({
  cert: z.string(),
  key: z.string(),
  ca: z.string().optional(),
  require_client_cert: z.boolean().default(false),
  reject_unauthorized: z.boolean().default(false),
}).strict();

// ===== 连接配置 Schema =====
const ConnectionConfigSchema = z.object({
  type: z.enum(['websocket', 'grpc', 'smux', 'kcp']).default('websocket'),
  options: z.object({
    max_stream_window_size: z.number().int().positive().optional(),
    max_session_window_size: z.number().int().positive().optional(),
    keepalive_interval: z.number().int().positive().optional(),
    keepalive_time_ms: z.number().int().positive().optional(),
    keepalive_timeout_ms: z.number().int().positive().optional(),
  }).optional(),
}).strict().optional();

// ===== 注册表配置 Schema =====
const RegistryConfigSchema = z.object({
  heartbeat_interval: z.number().int().positive().default(30000),
  timeout: z.number().int().positive().default(90000),
  max_edges: z.number().int().positive().default(100),
  hmac_secret: z.string().optional(),
  challenge_timeout: z.number().int().positive().default(60000),
  enable_auth: z.boolean().default(true),
}).strict();

// ===== 数据库配置 Schema =====
const DatabaseConfigSchema = z.object({
  path: z.string().min(1, 'database.path cannot be empty'),
  backup_dir: z.string().optional(),
  backup_interval: z.number().int().positive().default(86400000), // 24小时
  wal_mode: z.boolean().default(false),
}).strict();

// ===== Blob 存储配置 Schema =====
const BlobStoreConfigSchema = z.object({
  enabled: z.boolean().default(false),
  path: z.string().optional(),
}).strict();

// ===== Web API 配置 Schema =====
const WebApiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).optional(),
  host: z.string().default('0.0.0.0'),
  cors: z.boolean().default(false),
}).strict();

// ===== 认证配置 Schema =====
// 定义 callback 的输入和输出类型
const AuthCallbackInputSchema = z.object({
  username: z.string(),
  password: z.string(),
  tokens: z.array(z.string()),
  session_id: z.number(),
  server_id: z.number(),
  ip_address: z.string(),
  ip_version: z.string(),
  release: z.string(),
  version: z.number().optional(),
  os: z.string(),
  os_version: z.string(),
  certificate_hash: z.string().optional(),
});

const AuthCallbackOutputSchema = z.object({
  success: z.boolean(),
  user_id: z.number().optional(),
  username: z.string().optional(),
  display_name: z.string().optional(),
  groups: z.array(z.string()).optional(),
  reason: z.string().optional(),
  reject_type: z.number().optional(),
});

// 从 schema 导出认证结果类型
export type ExternalAuthResult = z.infer<typeof AuthCallbackOutputSchema>;

// 方案1: 使用 callback 函数
const HubAuthConfigWithCallbackSchema = z.object({
  callback: z.function({
    input: [AuthCallbackInputSchema],
    output: z.promise(AuthCallbackOutputSchema),
  }),
  // Cache 配置（可选）
  cache_ttl: z.number().int().positive().default(300000), // 5分钟
  allow_cache_fallback: z.boolean().default(true),
}).strict();

// 方案2: 使用 HTTP API
const HubAuthConfigWithApiSchema = z.object({
  api_url: z.string().url('auth.api_url must be a valid URL'),
  api_key: z.string().optional(),
  content_type: z.string().default('application/json'),
  method: z.enum(['POST', 'GET']).default('POST'),
  timeout: z.number().int().positive().default(5000),
  cache_ttl: z.number().int().positive().default(300000), // 5分钟
  pull_interval: z.number().int().positive().default(300000), // 5分钟
  track_sessions: z.boolean().default(false),
  allow_cache_fallback: z.boolean().default(true),
  // HTTP 请求头配置
  headers: z.object({
    auth_header_name: z.string().default('Authorization'),
    auth_header_format: z.string().default('Bearer {apiKey}'),
  }).optional(),
  // 响应字段映射配置
  response_fields: z.object({
    success_field: z.string().default('success'),
    success_value: z.union([z.boolean(), z.string(), z.number()]).default(true),
    user_id_field: z.string().default('user_id'),
    username_field: z.string().default('username'),
    display_name_field: z.string().default('displayName'),
    groups_field: z.string().default('groups'),
    reason_field: z.string().default('reason'),
  }).optional(),
}).strict();

// 联合类型：支持两种配置方式
const HubAuthConfigSchema = z.union([
  HubAuthConfigWithCallbackSchema,
  HubAuthConfigWithApiSchema,
]).refine(
  (config) => {
    // 验证：必须提供 callback 或 api_url 之一
    const hasCallback = 'callback' in config && typeof config.callback === 'function';
    const hasApiUrl = 'api_url' in config && config.api_url;
    return hasCallback || hasApiUrl;
  },
  {
    message: 'auth config must provide either "callback" function or "api_url"',
  }
).optional();

// ===== 自动封禁配置 Schema =====
const AutoBanConfigSchema = z.object({
  attempts: z.number().int().positive().default(10),
  timeframe: z.number().int().positive().default(120),
  duration: z.number().int().positive().default(300),
  ban_successful_connections: z.boolean().default(true),
}).strict().optional();

// ===== 客户端建议配置 Schema =====
const ClientSuggestConfigSchema = z.object({
  version: z.string().optional(), // 改为 string 类型以匹配 HubConfig
  positional: z.boolean().nullable().optional(),
  push_to_talk: z.boolean().nullable().optional(),
}).strict().optional();

// ===== 语音路由配置 Schema =====
const VoiceRoutingConfigSchema = z.object({
  shared_secret: z.string().optional(),
  enabled: z.boolean().default(false),
  policy: z.object({
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
  preferred_relay_edges: z.array(z.number().int()).optional(),
  hub_relay: z.object({
    enable_tcp_fallback: z.boolean().default(false),
  }).strict().optional(),
  encryption: z.object({
    algorithm: z.enum(['aes-128-cbc', 'aes-256-cbc']).default('aes-128-cbc'),
    key_rotation_interval: z.number().int().min(0).default(0),
  }).strict().optional(),
  debug: z.object({
    log_route_changes: z.boolean().default(false),
    log_quality_metrics: z.boolean().default(false),
    log_relay_stats: z.boolean().default(false),
  }).strict().optional(),
}).strict().optional();

// ===== 主配置 Schema =====
export const HubConfigSchema = z.object({
  server_id: z.number().int().min(0, 'server_id must be non-negative'),
  name: z.string().min(1, 'name cannot be empty'),
  register_name: z.string().optional(),
  host: z.string().min(1, 'host cannot be empty'),
  port: z.number().int().min(1).max(65535, 'port must be between 1 and 65535'),
  control_port: z.number().int().min(1).max(65535, 'control_port must be between 1 and 65535'),
  voice_port: z.number().int().min(1).max(65535).optional(),
  
  // 配置组
  tls: TLSConfigSchema,
  connection: ConnectionConfigSchema,
  registry: RegistryConfigSchema,
  database: DatabaseConfigSchema,
  blob_store: BlobStoreConfigSchema,
  web_api: WebApiConfigSchema,
  auth: HubAuthConfigSchema,
  voice_routing: VoiceRoutingConfigSchema,
  
  // 用户和频道限制
  max_users: z.number().int().positive().default(1000),
  max_users_per_channel: z.number().int().min(0).default(0), // 0 = unlimited
  channel_nesting_limit: z.number().int().positive().default(10),
  channel_count_limit: z.number().int().positive().default(1000),
  
  // 带宽和消息限制
  timeout: z.number().int().positive().default(30),
  bandwidth: z.number().int().positive().default(558000), // 558 Kbps
  text_message_length: z.number().int().positive().default(5000),
  image_message_length: z.number().int().positive().default(131072), // 128 KB
  message_limit: z.number().int().positive().default(1),
  message_burst: z.number().int().positive().default(5),
  plugin_message_limit: z.number().int().positive().default(4),
  plugin_message_burst: z.number().int().positive().default(15),
  
  // 安全配置
  server_password: z.string().optional(),
  kdf_iterations: z.number().int().default(-1), // -1 = auto-benchmark
  obfuscate: z.boolean().default(false),
  
  // 验证正则
  username_regex: z.string().default('[ -=\\w\\[\\]\\{\\}\\(\\)\\@\\|\\.]+'),
  channel_name_regex: z.string().default('[ -=\\w\\#\\[\\]\\{\\}\\(\\)\\@\\|]+'),
  
  // 频道行为
  default_channel: z.number().int().min(0).default(0),
  remember_channel: z.boolean().default(true),
  remember_channel_duration: z.number().int().min(0).default(0), // 0 = forever
  
  // 高级功能
  allow_html: z.boolean().default(true),
  force_external_auth: z.boolean().default(false),
  allow_recording: z.boolean().default(true),
  send_version: z.boolean().default(true),
  allow_ping: z.boolean().default(true),
  hide_cert_hashes: z.boolean().default(false),
  channel_ninja: z.boolean().default(false),
  ninja_channels: z.array(z.number().int()).default([]),
  
  // 监听功能
  listeners_per_channel: z.number().int().min(0).default(0), // 0 = unlimited
  listeners_per_user: z.number().int().min(0).default(0), // 0 = unlimited
  broadcast_listener_volume_adjustments: z.boolean().default(false),
  
  // 服务发现
  bonjour: z.boolean().default(false),
  
  // 日志配置
  log_level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  log_file: z.string().optional(),
  log_days: z.number().int().positive().default(31),
  
  // 可选配置
  auto_ban: AutoBanConfigSchema,
  suggest: ClientSuggestConfigSchema,
}).strict();

/**
 * 验证并应用默认值
 */
export function validateAndParseHubConfig(rawConfig: unknown): z.infer<typeof HubConfigSchema> {
  try {
    return HubConfigSchema.parse(rawConfig);
  } catch (error) {
    if (error && typeof error === 'object' && 'issues' in error) {
      const zodError = error as { issues: Array<{ path: (string | number)[]; message: string }> };
      const errorMessages = zodError.issues.map(err => {
        const path = err.path.join('.');
        return `  - ${path}: ${err.message}`;
      });
      
      throw new Error(
        `Hub Server configuration validation failed:\n${errorMessages.join('\n')}\n\n` +
        'Please check your configuration file and ensure all required fields are present and valid.'
      );
    }
    throw error;
  }
}

/**
 * 获取默认配置（用于生成示例配置）
 */
export function getDefaultHubConfig(): z.infer<typeof HubConfigSchema> {
  return HubConfigSchema.parse({
    server_id: 0,
    name: 'Hub Server',
    host: '0.0.0.0',
    port: 64739,
    control_port: 8443,
    tls: {
      cert: '',
      key: '',
    },
    registry: {},
    database: {
      path: './data/hub.db',
    },
    blob_store: {},
    web_api: {},
  });
}

// ===== 从 Zod schema 导出类型 =====
export type HubConfig = z.infer<typeof HubConfigSchema>;
export type HubConfigInput = z.input<typeof HubConfigSchema>;
export type TLSConfig = z.infer<typeof TLSConfigSchema>;
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type BlobStoreConfig = z.infer<typeof BlobStoreConfigSchema>;
export type WebApiConfig = z.infer<typeof WebApiConfigSchema>;
export type HubAuthConfig = z.infer<typeof HubAuthConfigSchema>;
export type HubAuthConfigWithCallback = z.infer<typeof HubAuthConfigWithCallbackSchema>;
export type HubAuthConfigWithApi = z.infer<typeof HubAuthConfigWithApiSchema>;
export type AutoBanConfig = z.infer<typeof AutoBanConfigSchema>;
export type ClientSuggestConfig = z.infer<typeof ClientSuggestConfigSchema>;
export type VoiceRoutingConfig = z.infer<typeof VoiceRoutingConfigSchema>;
export type RoutingPolicy = z.infer<typeof VoiceRoutingConfigSchema>['policy'];

// 类型守卫函数
export function isAuthConfigWithCallback(config: HubAuthConfig): config is HubAuthConfigWithCallback {
  return config !== undefined && 'callback' in config;
}

export function isAuthConfigWithApi(config: HubAuthConfig): config is HubAuthConfigWithApi {
  return config !== undefined && 'api_url' in config;
}

