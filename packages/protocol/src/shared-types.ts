/**
 * Shared types between Edge Server and Client
 * These types define data structures used by both server and client implementations
 */

import type { OCB2AES128 } from '@munode/common';

/**
 * 客户端状态枚举
 */
export enum ClientState {
  Connecting = 0,
  Handshaking = 1,
  Authenticated = 2,
  Ready = 3,
  Disconnected = 4,
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
