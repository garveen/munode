import type { Socket as UDPSocket } from 'dgram';
import { mumbleproto } from '@munode/protocol';
import type { EdgeInfo, ChannelUserMap } from '@munode/protocol';

// 从 config-schema 导入配置类型（这些类型由 Zod schema 生成）
export type {
  EdgeConfig,
  NetworkConfig,
  TLSConfig,
  HubServerConfig,
  EdgeVoiceRoutingConfig,
  ServerConfig,
  ClientConfig,
  FeatureConfig,
  VirtualHostConfig,
} from './config-schema.js';

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

// EdgeRoutingPolicy 不在 config-schema 中，在此定义
export interface EdgeRoutingPolicy {
  direct_rtt_threshold: number;
  direct_loss_threshold: number;
  enable_relay: boolean;
  max_relay_hops: number;
  relay_cost_factor: number;
  route_switch_hysteresis: number;
  route_switch_cost_delta: number;
  max_relay_load_per_edge: number;
  network_probe_interval: number;
  route_table_update_interval: number;
}

// RouteType 和 RouteEntry 从 @munode/protocol 导入并在此重新导出
export { RouteType } from '@munode/protocol';
export type { RouteEntry } from '@munode/protocol';

// Edge 间连接质量
export interface EdgeConnectionQuality {
  rtt: number;             // RTT (ms)
  packetLoss: number;      // 丢包率 (0-1)
  jitter: number;          // 抖动 (ms)
  lastUpdate: number;      // 最后更新时间戳
  samples: number;         // 样本数量
}

// 认证结果
export interface AuthResult {
  success: boolean;
  user_id?: number;
  username?: string;
  displayName?: string;
  groups?: string[];
  channel_id?: number; // Hub 决定的目标频道（包括 last channel 逻辑）
  cert_hash?: string; // 返回证书哈希（如果有）
  metadata?: Record<string, string | number | boolean>;
  reason?: string;
  rejectType?: mumbleproto.Reject_RejectType;
  // PreConnect state fields - user's initial state returned by Hub
  mute?: boolean;
  deaf?: boolean;
  suppress?: boolean;
  self_mute?: boolean;
  self_deaf?: boolean;
  priority_speaker?: boolean;
  recording?: boolean;
  // Server configuration
  cert_required?: boolean; // Hub 要求客户端证书
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

// ==================== 多租户相关类型 ====================

// 导入 VirtualHostConfig（从 config-schema）
import type { VirtualHostConfig as ImportedVirtualHostConfig } from './config-schema.js';

/**
 * 虚拟主机上下文
 * 包含每个虚拟主机独立的管理器实例和状态
 */
export interface VirtualHostContext {
  config: ImportedVirtualHostConfig;
  // 核心管理器实例（每个虚拟主机独立）
  clientManager: import('./client/client-manager.js').ClientManager;
  channelManager: import('./models/channel.js').ChannelManager;
  voiceRouter: import('./voice/voice-router.js').VoiceRouter;
  // Hub 客户端（可选，每个虚拟主机可能连接不同的 Hub）
  hubClient?: import('./cluster/hub-client.js').EdgeControlClient;
  // 其他管理器根据需要添加
}
