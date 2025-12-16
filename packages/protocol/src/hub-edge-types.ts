// Hub-Edge communication types
// These types define the message structures for communication between Hub and Edge servers

// Base RPC response interface
export interface RPCResponse {
  success: boolean;
  error?: string;
}

// Channel data structure
export interface ChannelData {
  channel_id: number; // 修改：与protobuf字段名一致
  name?: string;
  parent_id?: number;
  position?: number;
  max_users?: number;
  inherit_acl?: boolean;
  description?: string;
  temporary?: boolean;
  links?: number[];
}

// ACL data structure
export interface ACLData {
  id?: number;
  channel_id: number;
  user_id?: number;
  group?: string;
  apply_here: boolean;
  apply_subs: boolean;
  allow: number;
  deny: number;
}

// Ban data structure
export interface BanData {
  id?: number;
  address: string; // IP地址字符串，如 "192.168.1.1"
  mask: number; // CIDR 掩码长度
  name?: string;
  hash?: string; // 证书哈希
  reason?: string;
  start?: number; // Unix 时间戳（秒）
  duration?: number; // 持续时间（秒），0 表示永久
}

// RPC Response types
export interface ChannelsResponse extends RPCResponse {
  channels: ChannelData[];
}

export interface ACLsResponse extends RPCResponse {
  acls: ACLData[];
}

export interface SaveChannelResponse extends RPCResponse {
  channel_id: number;
}

// Registration request/response types
export interface RegisterRequest {
  server_id: number;
  name: string;
  host: string;
  port: number;
  region?: string;
  capacity: number;
  certificate: string;
  metadata?: Record<string, unknown>;
  
  // HMAC 挑战-响应认证字段
  challenge?: string; // Edge 在第二阶段返回的挑战码
  challenge_response?: string; // Edge 计算的 HMAC 响应
}

export interface RegisterResponse extends RPCResponse {
  hub_server_id: number;
  edge_list: EdgeInfo[];
  sync_data?: FullSyncData;
  
  // HMAC 挑战-响应认证
  challenge?: string; // 服务器生成的挑战码（仅在第一阶段返回）
  challenge_timeout?: number; // 挑战码超时时间（毫秒）
  
  // 重连和会话管理
  reconnected?: boolean; // 标识这是重连（会话恢复），而非新注册
  session_expired?: boolean; // 标识会话已过期，需要冷启动
  cold_restart?: boolean; // 标识这是冷重启（Edge 进程重启，所有旧客户端已断开）
  need_cleanup?: boolean; // 标识需要清理旧会话（Edge 重连时）
}

// Edge server information
export interface EdgeInfo {
  server_id: number;
  name: string;
  host: string;
  port: number;
  region?: string;
  current_load: number;
  capacity: number;
  certificate: string;
  last_seen: number;
}

// Heartbeat request/response types
export interface HeartbeatRequest {
  server_id: number;
  stats: ServerStats;
}

export interface HeartbeatResponse extends RPCResponse {
  updated_edges?: EdgeInfo[];
}

// Server statistics
export interface ServerStats {
  user_count: number;
  channel_count: number;
  cpu_usage: number;
  memory_usage: number;
  bandwidth: {
    in: number;
    out: number;
  };
}

// Full sync data structure
export interface FullSyncData {
  voice_targets: VoiceTargetConfig[];
  sessions: GlobalSession[];
  channel_users: ChannelUserMap[];
  edges: EdgeInfo[];
  timestamp: number;
}

// Voice target configuration
export interface VoiceTargetConfig {
  edge_id: number;
  client_session: number;
  target_id: number;
  config: VoiceTarget | null;
  timestamp: number;
}

// Voice target
export interface VoiceTarget {
  id: number;
  sessions: number[];
  channels: ChannelTarget[];
}

// Channel target
export interface ChannelTarget {
  channel_id: number;
  include_subchannels: boolean;
  include_links: boolean;
  group?: string;
}

// Global session information
export interface GlobalSession {
  session_id: number;
  edge_id: number;
  user_id: number;
  username: string;
  ip_address: string;
  cert_hash?: string;
  is_authenticated: boolean;
  channel_id?: number;
  connected_at: number;
  last_active: number;
  groups?: string[]; // 用户所属的组（如 admin、user 等）
  // 客户端信息
  version?: string; // 客户端版本（如 "1.5.634"）
  release?: string; // 客户端名称（如 "Mumble"）
  os?: string; // 操作系统（如 "Windows"）
  os_version?: string; // 操作系统版本
  // 用户状态字段（由 Edge 上报，Hub 转发）
  mute?: boolean;
  deaf?: boolean;
  suppress?: boolean;
  self_mute?: boolean;
  self_deaf?: boolean;
  priority_speaker?: boolean;
  recording?: boolean;
}

// Channel user mapping
export interface ChannelUserMap {
  channel_id: number;
  users: {
    edge_id: number;
    sessions: number[];
  }[];
}

// Certificate exchange types
export interface CertificateExchangeRequest {
  server_id_1: number;
  server_id_2: number;
}

export interface CertificateExchangeResponse extends RPCResponse {
  certificates?: Record<number, string>;
}

// Sync heartbeat types
export interface SyncHeartbeatRequest {
  edge_server_id: number;
  last_received_sequence: number;
  pending_updates: number;
}

export interface SyncHeartbeatResponse extends RPCResponse {
  need_resync?: boolean;
  sequence?: number;
}

// Missing updates request/response
export interface MissingUpdatesRequest {
  edge_server_id: number;
  sequences: number[];
}

export interface MissingUpdatesResponse extends RPCResponse {
  updates: unknown[]; // TODO: Define specific update types
}

// Checksum response
export interface ChecksumResponse extends RPCResponse {
  checksum: string;
  timestamp: number;
}

// Full snapshot request/response
export interface FullSnapshotRequest {
  edge_server_id: number;
  last_sync_timestamp: number;
}

export interface FullSnapshotResponse extends RPCResponse {
  snapshot: FullSyncData;
  sequence: number;
}

// Subscribe updates request
export interface SubscribeUpdatesRequest {
  from_sequence: number;
}

// Database operation types
export interface GetChannelsRequest {
  edge_id: number;
}

export interface GetACLsRequest {
  edge_id: number;
  channel_id?: number;
}

export interface SaveChannelRequest {
  edge_id: number;
  channel: ChannelData;
}

export interface SaveACLRequest {
  edge_id: number;
  channel_id: number;
  acls: ACLData[];
}