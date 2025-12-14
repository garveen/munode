// Mumble protocol types
export { mumbleproto } from './generated/proto/Mumble.js';

// Hub-Edge protocol types
export { hubedge } from './generated/proto/HubEdge.js';

// Hub-Edge RPC types (typed protobuf messages)
export { hubedge as hubedgeRpc } from './generated/proto/HubEdgeRPC.js';

export {
  type EdgeToHubMethods as ProtobufEdgeToHubMethods,
  type HubToEdgeMethods,
  type RPCParams as ProtobufRPCParams,
  type RPCResult as ProtobufRPCResult,
  type RPCCallOptions,
  RPCError, // Export as RPCError (this is the new Protobuf version)
  RPCErrorCode,
  type EdgeRegisterMethod as ProtobufEdgeRegisterMethod,
  type EdgeAllocateSessionIdMethod,
  type EdgeAuthenticateUserMethod,
  type EdgeQueryPermissionMethod,
  type EdgeQueryUserMethod,
  type EdgeQueryChannelACLMethod,
  type EdgeQueryChannelTreeMethod,
  type EdgeQueryOnlineUsersMethod,
  type HubDisconnectClientMethod,
  type HubReloadConfigMethod,
  type HubRequestStatsMethod,
} from './rpc/rpc-methods.js';

// WebSocket transport layer
export {
  EdgeHubWebSocketClient,
  type WebSocketClientConfig,
} from './transport/websocket-client.js';

export {
  EdgeHubWebSocketServer,
  type EdgeClient,
  type WebSocketServerConfig,
} from './transport/websocket-server.js';

export {
  PacketCodec,
} from './transport/packet-codec.js';

// Generated Protobuf types (for direct usage if needed)
// These will be available after build
// export {
//   EdgeHubPacket,
//   PacketType,
//   RPCRequest,
//   RPCResponse,
//   RPCError as ProtoRPCError,
//   ClientMessageRelay,
//   RelayDirection,
//   RelayRouting,
//   RoutingType,
//   Heartbeat,
//   HeartbeatAck,
//   ServerStats as ProtoServerStats,
//   ConfigUpdate,
//   ConfigItem,
// } from './generated/HubEdge.js';

// export {
//   SyncData,
//   SyncType,
//   UserStateSync,
//   UserOperation,
//   UserInfo,
//   ChannelStateSync,
//   ChannelOperation,
//   ChannelInfo as SyncChannelInfo,
//   ACLSync,
//   ACLEntry as ProtoACLEntry,
//   ChannelGroup as SyncChannelGroup,
//   BatchSync,
//   FullSyncRequest,
//   FullSyncResponse,
//   FullSyncDataType,
//   ShardInfo,
//   GlobalConfig,
//   VoiceTargetSync,
//   VoiceTarget as ProtoVoiceTarget,
//   ChannelTarget as ProtoChannelTarget,
//   UserTarget,
//   PermissionQuery as SyncPermissionQuery,
//   PermissionResult,
//   ConnectionEvent,
//   ConnectionEventType,
// } from './generated/HubEdgeSync.js';

// Re-export types for convenience
import { mumbleproto } from './generated/proto/Mumble.js';
export type Version = mumbleproto.Version;
export type UDPTunnel = mumbleproto.UDPTunnel;
export type Authenticate = mumbleproto.Authenticate;
export type Ping = mumbleproto.Ping;
export type Reject = mumbleproto.Reject;
export type ServerSync = mumbleproto.ServerSync;
export type ChannelRemove = mumbleproto.ChannelRemove;
export type ChannelState = mumbleproto.ChannelState;
export type UserRemove = mumbleproto.UserRemove;
export type UserState = mumbleproto.UserState;
export type BanList = mumbleproto.BanList;
export type TextMessage = mumbleproto.TextMessage;
export type PermissionDenied = mumbleproto.PermissionDenied;
export type ACL = mumbleproto.ACL;
export type QueryUsers = mumbleproto.QueryUsers;
export type CryptSetup = mumbleproto.CryptSetup;
export type ContextActionModify = mumbleproto.ContextActionModify;
export type ContextAction = mumbleproto.ContextAction;
export type UserList = mumbleproto.UserList;
export type MumbleVoiceTarget = mumbleproto.VoiceTarget;
export type PermissionQuery = mumbleproto.PermissionQuery;
export type CodecVersion = mumbleproto.CodecVersion;
export type UserStats = mumbleproto.UserStats;
export type RequestBlob = mumbleproto.RequestBlob;
export type ServerConfig = mumbleproto.ServerConfig;
export type SuggestConfig = mumbleproto.SuggestConfig;
export type PermissionDenied_DenyType = mumbleproto.PermissionDenied.DenyType;
export type Reject_RejectType = mumbleproto.Reject.RejectType;

// Shared types (Client and Server)
export type {
  ClientInfo,
  ChannelGroup,
  ChannelInfo,
  VoicePacket as SharedVoicePacket,
  VoiceBroadcast,
  BanInfo,
  BanCheckResult,
  GeoIPResult,
  UDPStats,
} from './shared-types.js';
// 导出 ClientState 和 RouteType 枚举（既作为类型也作为值）
export { ClientState, RouteType } from './shared-types.js';

// RPC Channel
export { RPCChannel } from './rpc/rpc-channel.js';
export type { 
  Message, 
  PendingRequest,
  // Union type for all notification parameters - use when method name is dynamic
  NotificationParams as ChannelNotificationParams,
  // Individual notification parameter types
  VoiceDataParams,
  ForceDisconnectParams,
  PeerJoinedParams,
  ACLResponseParams,
  UserJoinedParams,
  UserLeftParams,
  UserMovedParams,
  ChannelCreatedParams,
  ChannelRemovedParams,
  ChannelUpdatedParams,
  SyncVoiceTargetParams,
  // Note: ChannelDataInput removed - use ChannelData from hub-edge-types.ts
} from './rpc/rpc-channel.js';

// Typed RPC (Legacy - will be deprecated)
export { TypedRPCClient, createTypedRPCClient } from './rpc/typed-rpc-client.js';
export { TypedRPCServer, createTypedRPCServer } from './rpc/typed-rpc-server.js';
export type { RPCHandler } from './rpc/typed-rpc-server.js';
// Note: RPCError is now exported from rpc-methods.js (new Protobuf version)
export type {
  EdgeToHubMethods,
  EdgeToHubNotifications,
  HubToEdgeNotifications,
  RPCMethodMap,
  NotificationMethodMap,
  HubToEdgeNotificationMethodMap,
  EdgeToHubNotificationMethodMap,
  RPCParams,
  RPCResult,
  // Generic notification params - use when method name is known at compile time
  // For dynamic method names, use ChannelNotificationParams (union type)
  HubNotificationParams,
  EdgeNotificationParams,
  // Individual method types
  EdgeRegisterMethod,
  EdgeHeartbeatMethod,
  EdgeReportSessionMethod,
  EdgeSyncVoiceTargetMethod,
  EdgeGetVoiceTargetsMethod,
  EdgeRouteVoiceMethod,
  EdgeAdminOperationMethod,
  EdgeExchangeCertificatesMethod,
  EdgeFullSyncMethod,
  EdgeGetChannelsMethod,
  EdgeGetACLsMethod,
  EdgeSaveChannelMethod,
  EdgeSaveACLMethod,
  EdgeJoinMethod,
  EdgeJoinCompleteMethod,
  EdgeReportPeerDisconnectMethod,
  ClusterGetStatusMethod,
  HubVoiceDataNotification,
  HubForceDisconnectNotification,
  HubPeerJoinedNotification,
  // Edge to Hub notification types
  EdgeUserStateNotification,
  EdgeUserLeftNotification,
  EdgeChannelStateNotification,
  EdgeChannelRemoveNotification,
  EdgeUserRemoveNotification,
  EdgeTextMessageNotification,
  EdgePluginDataTransmissionNotification,
  EdgeUserStatsNotification,
} from './rpc/rpc-types.js';

// Voice Channel
// VoiceChannel has been merged into voice-udp-transport.ts
export type { VoicePacket, VoiceEncryptionConfig } from './voice/voice-udp-transport.js';
export { VoiceUDPTransport } from './voice/voice-udp-transport.js';
export type {
  VoiceUDPConfig,
  VoicePacketHeader,
  RemoteEndpoint,
} from './voice/voice-udp-transport.js';

// Control Channel
export { ControlChannelServer } from './control/control-server.js';
export type { ControlChannelConfig } from './control/control-server.js';
export { ControlChannelClient } from './control/control-client.js';
export type { ControlChannelClientConfig } from './control/control-client.js';
export { ConnectionPool } from './control/connection-pool.js';
export type { ConnectionPoolConfig } from './control/connection-pool.js';

// Permission system (shared between client and server)
export { Permission, PermissionManager } from './permission.js';
export type { ACLEntry } from './permission.js';

// Message types (Mumble protocol)
export { MessageType, UDPMessageType } from './message-types.js';

// Hub-Edge communication types
export type {
  RPCResponse,
  ChannelData,
  ACLData,
  BanData,
  ChannelsResponse,
  ACLsResponse,
  SaveChannelResponse,
  RegisterRequest,
  RegisterResponse,
  EdgeInfo,
  HeartbeatRequest,
  HeartbeatResponse,
  ServerStats,
  FullSyncData,
  VoiceTargetConfig,
  VoiceTarget,
  ChannelTarget,
  GlobalSession,
  ChannelUserMap,
  CertificateExchangeRequest,
  CertificateExchangeResponse,
  SyncHeartbeatRequest,
  SyncHeartbeatResponse,
  MissingUpdatesRequest,
  MissingUpdatesResponse,
  ChecksumResponse,
  FullSnapshotRequest,
  FullSnapshotResponse,
  SubscribeUpdatesRequest,
  GetChannelsRequest,
  GetACLsRequest,
  SaveChannelRequest,
  SaveACLRequest,
} from './hub-edge-types.js';

// Transport layer
export * from './transport/index.js';

// Voice routing constants
export {
  DEFAULT_ROUTING_POLICY,
  DEFAULT_HUB_RELAY_CONFIG,
  DEFAULT_LOCAL_DECISION_CONFIG,
  DEFAULT_EDGE_RELAY_CONFIG,
  DEFAULT_PROBE_CONFIG,
  DEFAULT_FALLBACK_CONFIG,
} from './voice/voice-routing-constants.js';

// Route validation utilities
export {
  RouteValidator,
  type RouteEntry as ValidatorRouteEntry,
  type ValidationResult,
  type RouteValidatorOptions,
} from './routing/route-validator.js';
