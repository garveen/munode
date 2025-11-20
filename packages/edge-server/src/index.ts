// 主要导出
export { EdgeServer } from './edge-server.js';

// 枚举类型
export { MessageType, UDPMessageType } from '@munode/protocol';

// 类型定义
export type {
  EdgeConfig,
  ClientInfo,
  ChannelInfo,
  ServerStats,
  ClientState,
  VoicePacket,
  VoiceBroadcast,
  BanInfo,
  GeoIPResult,
  CachedUser,
  UDPConnection,
  UDPStats,
} from './types.js';

// 配置管理
export { loadEdgeConfig, validateConfig } from './config.js';

// 核心组件
export { ClientManager } from './client/client-manager.js';
export { ChannelManager } from './channel.js';
export { MessageHandler } from './message-handler.js';
export { VoiceRouter } from './voice-router.js';
export { AuthManager } from './auth/auth-manager.js';
export { EdgeControlClient } from './edge-control-client.js';
export { BanManager } from './ban-manager.js';
export { ContextActions } from './context-actions.js';
export { GeoIPManager } from './geoip-manager.js';
export { UserCache } from './user-cache.js';
export { PacketConnPool } from './network/packet-pool.js';
export { UDPMonitor } from './network/udp-monitor.js';
