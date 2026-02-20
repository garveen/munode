/**
 * Shared types between Edge Server and Client
 * These types define data structures used by both server and client implementations
 */

import type { OCB2AES128 } from '@munode/common';
import type { ConnectionPurpose } from './connection/connection-types.js';

/**
 * 客户端状态枚举
 * 与 Go 实现的状态机保持一致
 */
/**
 * 路由类型
 */
export enum RouteType {
  DIRECT = 'direct',       // 直连
  RELAY = 'relay',         // Edge 中转
  FALLBACK = 'hub_relay',  // Hub 中转降级（通过 Hub 控制通道中转语音）
}

/**
 * 路由表条目（权威定义，供 Edge 和 Hub 共同使用）
 */
export interface RouteEntry {
  targetEdgeId: number;
  type: RouteType;
  nextHop?: number;                    // 中转时的下一跳 Edge ID
  cost: number;                        // 路由成本
  timestamp: number;                   // 更新时间戳
  source: 'hub' | 'local';             // 路由来源
  ttl?: number;                        // 生存时间 (ms)
  connectionPurpose?: ConnectionPurpose; // 连接用途（决定是否强制TCP，Edge 侧使用）
}

export enum ClientState {
  Connected = 0,           // StateClientConnected - 客户端已连接
  ServerSentVersion = 1,   // StateServerSentVersion - 服务器已发送Version
  ClientSentVersion = 2,   // StateClientSentVersion - 客户端已发送Version
  Authenticated = 3,       // StateClientAuthenticated - 认证完成
  Ready = 4,               // StateClientReady - 客户端准备就绪
  Dead = 5,                // StateClientDead - 客户端已断开
}

/**
 * 客户端信息
 * 用于服务器端管理连接的客户端
 */
export interface ClientInfo {
  session: number;
  user_id: number;
  username: string;
  channel_id: number;
  state: ClientState; // 客户端连接状态
  mute?: boolean;
  deaf?: boolean;
  self_mute?: boolean;
  self_deaf?: boolean;
  suppress?: boolean;
  priority_speaker?: boolean;
  recording?: boolean;
  groups: string[];
  comment: string;
  hash: string;
  cert_hash?: string;
  ip_address: string;
  udp_ip?: string; // UDP IP 地址
  udp_port?: number; // UDP 端口
  udp?: boolean; // UDP 连接是否已建立
  connected_at: Date;
  last_active: Date;
  last_ping?: number; // 最后 ping 时间戳（毫秒）
  version: string; // 版本号（十六进制字符串）
  version_number?: number; // 版本号（数字格式，例如：66051 代表 1.2.3）
  client_name: string;
  os_name: string;
  os_version: string;
  promiscuous_mode?: boolean; // 混杂模式 - 监听所有频道
  has_full_user_list?: boolean; // 标记客户端是否已接收完整用户列表
  crypt?: OCB2AES128; // 加密状态实例
  listeningChannels?: Set<number>; // 正在监听的频道ID列表
}

/**
 * 频道组信息
 */
export interface ChannelGroup {
  name: string;
  inherited: boolean; // 是否从父频道继承（只读）
  inherit: boolean; // 是否继承成员
  inheritable: boolean; // 是否可被子频道继承
  add: number[]; // 明确添加的用户ID
  remove: number[]; // 明确移除的用户ID（用于继承组）
  inherited_members: number[]; // 继承的成员ID
}

/**
 * 频道信息
 */
export interface ChannelInfo {
  id: number;
  name: string;
  parent_id?: number;
  description: string;
  position: number;
  max_users: number;
  temporary: boolean;
  inherit_acl: boolean; // 是否继承父频道的 ACL
  children: number[];
  links: number[]; // 链接的频道ID列表
  groups?: Map<string, ChannelGroup>; // 频道组定义
}

/**
 * 语音包信息
 */
export interface VoicePacket {
  sender_session: number;
  target: number;
  sequence: number;
  codec: number;
  data: Buffer;
  timestamp: number;
}

/**
 * 语音广播
 */
export interface VoiceBroadcast {
  sender_id: number;
  sender_edge_id: number;
  sender_username: string;
  target: number;
  packet: Buffer;
  timestamp: number;
  routing_info: {
    channel_id?: number;
    voice_target_id?: number;
  };
}

/**
 * 封禁信息
 */
export interface BanInfo {
  id?: number;
  address?: string;
  mask?: number;
  name?: string;
  hash?: string;
  reason: string;
  startDate: Date;
  duration: number;
  createdBy?: string;
  createdAt?: Date;
}

/**
 * 封禁检查结果
 */
export interface BanCheckResult {
  banned: boolean;
  reason?: string;
  expiresAt?: Date;
  banId?: number;
}

/**
 * GeoIP 信息
 */
export interface GeoIPResult {
  ip: string;
  countryCode: string;
  country: string;
  continentCode: string;
  latitude: number;
  longitude: number;
  asn: number;
  organization: string;
  timezone: string;
}

/**
 * UDP 监控统计
 */
export interface UDPStats {
  pingAvg: number;
  pingVar: number;
  packets: number;
  totalPackets: number;
  volume: number;
  unstable: boolean;
}
