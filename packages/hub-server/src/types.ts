// Hub Server 配置
// 导入共享类型
import type { EdgeInfo, RegisterRequest, RegisterResponse, HeartbeatRequest, HeartbeatResponse, EdgeServerStats } from '@munode/protocol';
export type { EdgeInfo, RegisterRequest, RegisterResponse, HeartbeatRequest, HeartbeatResponse, EdgeServerStats };

// 从 config-schema 导入配置类型（这些类型由 Zod schema 生成）
export type {
  HubConfig,
  TLSConfig,
  ConnectionConfig,
  RegistryConfig,
  DatabaseConfig,
  BlobStoreConfig,
  WebApiConfig,
  HubAuthConfig,
  AutoBanConfig,
  ClientSuggestConfig,
  VoiceRoutingConfig,
  RoutingPolicy,
} from './config-schema.js';

// Edge连接状态
export enum EdgeConnectionState {
  CONNECTED = 'connected',          // 正常连接
  DISCONNECTED_WAITING = 'disconnected_waiting',  // 断开但等待重连
  DISCONNECTED_TIMEOUT = 'disconnected_timeout',  // 超时，会话已清理
}

/**
 * 外部认证请求参数
 */
export interface ExternalAuthRequest {
  username: string;
  password: string;
  tokens: string[];
  session_id: number;
  server_id: number;
  ip_address: string;
  ip_version: string;
  release: string;
  version?: number;
  os: string;
  os_version: string;
  certificate_hash?: string;
}

// 从 config-schema 导出认证结果类型（保持 snake_case 配置风格）
import type { ExternalAuthResult } from './config-schema.js';
export { ExternalAuthResult };

/**
 * 外部认证回调函数
 */
export type ExternalAuthCallback = (
  request: ExternalAuthRequest
) => Promise<ExternalAuthResult>;

// 已注册的 Edge 服务器信息
export interface RegisteredEdge {
   server_id: number;
  name: string;
  host: string;
  port: number;
  region?: string;
  capacity: number;
   current_load: number;
  certificate: string;
   last_seen: number;
  stats: EdgeServerStats;
  connectionState?: EdgeConnectionState;  // 连接状态
  disconnectedAt?: number;  // 断开时间戳（仅在DISCONNECTED_WAITING状态时有效）
  cleanupTimer?: NodeJS.Timeout;  // 清理定时器
}

// VoiceTarget 配置
export interface VoiceTargetConfig {
   edge_id: number;
   client_session: number;
   target_id: number;
  config: import('@munode/protocol').VoiceTarget | null;
}

// 导出 VoiceTarget 类型别名
export type VoiceTarget = import('@munode/protocol').VoiceTarget;

// 证书信息
export interface CertificateInfo {
   server_id: number;
  pem: string;
  fingerprint: string;
  notBefore: Date;
  notAfter: Date;
  subject: unknown;
  issuer: unknown;
}

// 证书交换结果
export interface CertificateExchangeResult {
  success: boolean;
  certificates?: Record<number, string>;
  error?: string;
}

// 服务器统计信息
export interface ServiceRegistry {
  register(request: RegisterRequest): Promise<RegisterResponse>;
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
  unregister( server_id: number): Promise<void>;
  getEdge( server_id: number): RegisteredEdge | undefined;
  getEdgeList(): EdgeInfo[];
  getEdgeCount(): number;
  cleanup(): void;
}
