// 主要导出
export { EdgeServer } from './core/edge-server.js';

// 控制通道组件
export { ControlChannelClient, type ControlChannelClientConfig } from './control/control-client.js';
export { ClientConnectionPool, type ClientConnectionPoolConfig } from './control/edge-pool.js';

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
  VirtualHostConfig,
  VirtualHostContext,
} from './types.js';

// 配置管理
export { loadEdgeConfig, validateConfig } from './config.js';
export { validateAndParseEdgeConfig } from './config-schema.js';

// 核心组件
export { ClientManager } from './client/client-manager.js';
export { ChannelManager } from './models/channel.js';
export { MessageHandler } from './message-handler.js';
export { VoiceRouter } from './voice/voice-router.js';
export { AuthManager } from './auth/auth-manager.js';
export { EdgeControlClient } from './cluster/hub-client.js';
export { BanManager } from './ban/ban-manager.js';
export { ContextActions } from './handlers/context-action.js';
export { GeoIPManager } from './util/geoip-manager.js';
export { PacketConnPool } from './network/packet-pool.js';
export { UDPMonitor } from './network/udp-monitor.js';
export { ClientMessageRelayHandler } from './relay/client-message-relay-handler.js';

// 多租户组件
export { VirtualHostManager } from './virtual-host/virtual-host-manager.js';
export { SecureContextManager } from './virtual-host/secure-context-manager.js';
export { CryptoKeyRegistry, type CryptoKeyEntry } from './virtual-host/crypto-key-registry.js';
export { makeCompositeKey, parseCompositeKey, isValidCompositeKey, makeCompositeKeyFromContext } from './virtual-host/composite-key.js';
export { MultiTenantVoiceRouterSupport } from './voice/multi-tenant-voice-router.js';

// Worker Thread 组件
export { CryptoWorkerPool } from './voice/crypto-worker-pool.js';
export type {
  WorkerMessage,
  WorkerResponse,
  WorkerStats,
  CryptoWorkerPoolConfig,
} from './voice/crypto-worker-types.js';
