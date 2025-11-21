// Hub Server 配置
// 导入共享类型
import type { ServerStats, EdgeInfo, RegisterRequest, RegisterResponse, HeartbeatRequest, HeartbeatResponse } from '@munode/protocol';
export type { ServerStats, EdgeInfo, RegisterRequest, RegisterResponse, HeartbeatRequest, HeartbeatResponse };

export interface HubConfig {
   server_id: number;
  name: string;
  registerName?: string; // Root频道的显示名称（默认为"Root"）
  host: string;
  port: number;
  controlPort?: number; // 控制信道端口
  voicePort?: number;   // 语音信道端口
  tls: TLSConfig;
  registry: RegistryConfig;
  database: DatabaseConfig;
  blobStore: BlobStoreConfig; // Blob存储配置
  webApi: WebApiConfig;
  logLevel: string;
  logFile?: string;
}

// TLS 配置
export interface TLSConfig {
  cert?: string;
  key?: string;
  ca?: string;
  requireClientCert?: boolean;
  rejectUnauthorized?: boolean;
}

// 注册表配置
export interface RegistryConfig {
  heartbeatInterval: number;
  timeout: number;
  maxEdges: number;
}

// 数据库配置
export interface DatabaseConfig {
  path: string;
  backupDir: string;
  backupInterval: number;
}

// Blob存储配置
export interface BlobStoreConfig {
  enabled: boolean;  // 是否启用blob存储
  path: string;      // blob存储目录
}

// Web API 配置
export interface WebApiConfig {
  enabled: boolean;
  port: number;
  cors: boolean;
}

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
  stats: ServerStats;
}

// VoiceTarget 配置
export interface VoiceTargetConfig {
   edge_id: number;
   client_session: number;
   target_id: number;
  config: import('@munode/protocol').VoiceTarget | null;
  timestamp: number;
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
