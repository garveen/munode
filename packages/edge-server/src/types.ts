import type { Socket as UDPSocket } from 'dgram';
import type { TLSConfig } from '@munode/common';
import { mumbleproto } from '@munode/protocol';
import type { EdgeInfo, ChannelUserMap } from '@munode/protocol';

// 从 protocol 包导入共享类型并重新导出供本地使用
export type {
  ClientState,
  ClientInfo,
  ChannelGroup,
  ChannelInfo,
  SharedVoicePacket as VoicePacket,
  VoiceBroadcast,
  BanInfo,
  BanCheckResult,
  GeoIPResult,
  UDPStats,
  EdgeInfo,
  ServerStats,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  ChannelUserMap,
} from '@munode/protocol';
export { ClientStateEnum } from '@munode/protocol';

// Edge Server 配置
export interface EdgeConfig {
   server_id: number;
  name: string;
  mode: 'cluster';
  network: NetworkConfig;
  tls: TLSConfig;
  hubServer?: HubServerConfig;
  peerServers: PeerServersConfig;
  relay: RelayConfig;
  auth: AuthConfig;
  capacity: number;
  max_bandwidth: number;
  defaultChannel: number;
  logLevel: string;
  features: FeatureConfig;
  welcomeText?: string;
  maxTextMessageLength?: number;
  maxImageMessageLength?: number;
  suggestVersion?: number; // 建议的客户端版本号
  suggestPositional?: boolean; // 建议启用位置音频
  suggestPushToTalk?: boolean; // 建议启用按键发言
}

// 网络配置
export interface NetworkConfig {
  host: string;
  port: number;
  externalHost: string;
  region?: string;
}

// Hub 服务器配置
export interface HubServerConfig {
  host: string;
  port: number;
  controlPort: number;
  tls: {
    ca?: string;
    rejectUnauthorized: boolean;
  };
  connectionType: 'websocket' | 'grpc' | 'smux' | 'kcp';
  reconnectInterval: number;
  heartbeatInterval: number;
  options?: SmuxOptions | GrpcOptions | KcpOptions;
}

// SMUX 连接选项
export interface SmuxOptions {
  maxStreamWindowSize: number;
  maxSessionWindowSize: number;
}

// gRPC 连接选项
export interface GrpcOptions {
  keepaliveTimeMs: number;
  keepaliveTimeoutMs: number;
}

// KCP 连接选项
export interface KcpOptions {
  mtu: number;
  sndwnd: number;
  rcvwnd: number;
  nodelay: number;
  interval: number;
  resend: number;
  nc: number;
}

// P2P 服务器配置
export interface PeerServersConfig {
  enableP2P: boolean;
  connectionTimeout: number;
  maxConnections: number;
}

// Relay 配置
export interface RelayConfig {
  enabled: boolean;
  preferredRelay?: number;
  fallbackRelays?: number[];
}

// 认证配置
export interface AuthConfig {
  apiUrl: string;
  apiKey: string;
  timeout: number;
  retry: number;
  insecure: boolean;
  cacheTTL: number;
  pullInterval: number;
  trackSessions: boolean;
  allowCacheFallback: boolean;
}

// 认证结果
export interface AuthResult {
  success: boolean;
  user_id?: number;
  username?: string;
  displayName?: string;
  groups?: string[];
  metadata?: Record<string, string | number | boolean>;
  reason?: string;
  rejectType?: mumbleproto.Reject.RejectType;
}

// 功能开关配置
export interface FeatureConfig {
  geoip: boolean;
  banSystem: boolean;
  contextActions: boolean;
  packetPool: boolean;
  udpMonitor: boolean;
  allowHtml?: boolean;
}

// 注意：ClientState, ClientInfo, ChannelGroup, ChannelInfo, VoicePacket, VoiceBroadcast 等共享类型
// 已从 @munode/protocol 导入并重新导出，不需要在此重复定义

// 完整同步数据
export interface FullSyncData {
  voiceTargets: VoiceTargetConfig[];
  sessions: import('@munode/protocol').GlobalSession[];
  channelUsers: ChannelUserMap[];
  edges: EdgeInfo[];
  timestamp: number;
}

// VoiceTarget 配置
export interface VoiceTargetConfig {
   edge_id: number;
   client_session: number;
   target_id: number;
  config: import('@munode/protocol').VoiceTarget | null;
  timestamp: number;
}

// 管理操作
export interface AdminOperation {
  type: string;
  operatorSessionId: number;
  targetEdgeId?: number;
  data: Record<string, unknown>;
  timestamp: number;
}

// 证书交换
export interface CertificateExchangeRequest {
  serverId1: number;
  serverId2: number;
}

export interface CertificateExchangeResponse {
  success: boolean;
  certificates?: Record<number, string>;
  error?: string;
}

// 用户缓存
export interface CachedUser {
  user_id: string;
  password: string;
  username: string;
  groups: string[];
  metadata?: Record<string, string | number | boolean>;
  cachedAt: number;
}

// UDP 连接信息
export interface UDPConnection {
  id: string;
  socket: UDPSocket;
  localAddress: string;
  lastUsed: number;
  packetCount: number;
}
