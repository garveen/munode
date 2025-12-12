import type { Socket as UDPSocket } from 'dgram';
import type { TLSConfig } from '@munode/common';
import { mumbleproto } from '@munode/protocol';
import type { EdgeInfo, ChannelUserMap } from '@munode/protocol';

// 从 protocol 包导入共享类型并重新导出供本地使用
export type {
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
export { ClientState } from '@munode/protocol';

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
  voiceRouting?: EdgeVoiceRoutingConfig;  // 语音路由配置
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
  host: string;            // 实际监听的地址
  port: number;            // 实际监听的端口
  externalHost: string;    // 用于其它edge连接的地址（公网地址）
  externalPort?: number;   // 用于其它edge连接的端口（公网端口），如果未指定则使用port
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
  
  // HMAC 挑战-响应认证
  hmacSecret?: string; // HMAC 共享密钥（需与 Hub 配置一致）
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

// 语音路由配置 (Edge 侧)
export interface EdgeVoiceRoutingConfig {
  // 由 Hub 推送控制的配置
  enabled?: boolean;                   // 功能总开关，由 Hub 控制
  hubPolicy?: EdgeRoutingPolicy;       // Hub 推送的路由策略
  
  // 本地路由决策配置
  localDecision?: {
    enabled: boolean;                  // 启用本地决策
    updateInterval: number;            // 本地路由更新间隔 (ms)
    qualityCheckInterval: number;      // 质量检查间隔 (ms)
    directRttThreshold: number;        // 本地直连 RTT 阈值
    directLossThreshold: number;       // 本地直连丢包率阈值
  };
  
  // 中转功能配置
  relay?: {
    enabled: boolean;                  // 允许作为中转节点
    maxRelayCpuLoad: number;           // CPU 上限
    maxRelayBandwidth: number;         // 带宽上限 (kbps)
    softLimitThreshold: number;        // 软限制阈值
    hardLimitThreshold: number;        // 硬限制阈值
    recoveryThreshold: number;         // 恢复阈值
    priority: number;                  // 中转优先级 (1-10)
  };
  
  // 网络质量探测配置
  probe?: {
    enabled: boolean;
    method: 'passive';                 // 被动探测
    updateInterval: number;            // 质量指标更新间隔 (ms)
    lossWindowSize: number;            // 丢包率统计窗口
    rttSmoothFactor: number;           // RTT 平滑参数
    metricsTTL: number;                // 质量指标过期时间 (ms)
  };
  
  // 降级策略配置
  fallback?: {
    enableTcpFallback: boolean;        // 启用 TCP 降级
    tcpFallbackDelay: number;          // 切换到 TCP 的延迟 (ms)
    udpRecoveryCheckInterval: number;  // UDP 恢复检查间隔 (ms)
  };
}

// Hub 推送的路由策略
export interface EdgeRoutingPolicy {
  directRttThreshold: number;
  directLossThreshold: number;
  enableRelay: boolean;
  maxRelayHops: number;
  relayCostFactor: number;
  routeSwitchHysteresis: number;
  routeSwitchCostDelta: number;
  maxRelayLoadPerEdge: number;
  probeInterval: number;
  routeTableUpdateInterval: number;
}

// 路由类型枚举
export enum RouteType {
  DIRECT = 'direct',       // 直连
  RELAY = 'relay',         // Edge 中转
  FALLBACK = 'fallback',   // TCP 降级
}

// 路由表条目
export interface RouteEntry {
  targetEdgeId: number;
  type: RouteType;
  nextHop?: number;        // 中转时的下一跳 Edge ID
  cost: number;            // 路由成本
  timestamp: number;       // 更新时间戳
  source: 'hub' | 'local'; // 路由来源
  ttl?: number;            // 生存时间 (ms)
}

// Edge 间连接质量
export interface EdgeConnectionQuality {
  rtt: number;             // RTT (ms)
  packetLoss: number;      // 丢包率 (0-1)
  jitter: number;          // 抖动 (ms)
  lastUpdate: number;      // 最后更新时间戳
  samples: number;         // 样本数量
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
