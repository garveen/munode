// Mumble protocol types - ts-proto exports individual types, not a namespace
// Export everything except conflicting helper types
export type {
  Version,
  UDPTunnel,
  Authenticate,
  Ping,
  Reject,
  ServerSync,
  ChannelRemove,
  ChannelState,
  UserRemove,
  UserState,
  BanList,
  TextMessage,
  PermissionDenied,
  ACL,
  QueryUsers,
  CryptSetup,
  ContextActionModify,
  ContextAction,
  UserList,
  VoiceTarget,
  PermissionQuery,
  CodecVersion,
  UserStats,
  RequestBlob,
  ServerConfig,
  SuggestConfig,
  PluginDataTransmission,
} from './generated/proto/Mumble.js';

// Export all Mumble types as a namespace for backward compatibility
import * as MumbleProto from './generated/proto/Mumble.js';
export { MumbleProto as mumbleproto };

// Export all HubEdge types as namespaces for backward compatibility
import * as HubEdgeProto from './generated/proto/HubEdge.js';
export { HubEdgeProto as hubedge };

import * as HubEdgeRPCProto from './generated/proto/HubEdgeRPC.js';
export { HubEdgeRPCProto as hubedgeRpc };

// Export enums and MessageFns
export {
  PermissionDenied_DenyType,
  Reject_RejectType,
} from './generated/proto/Mumble.js';

// Hub-Edge protocol types
export type {
  EdgeHubPacket,
  RPCError as ProtoRPCError,
  Heartbeat,
  HeartbeatAck,
  ClientMessageRelay,
  ServerStats as ProtoServerStats,
  ConfigUpdate,
} from './generated/proto/HubEdge.js';

export {
  PacketType,
  RelayDirection,
  RoutingType,
} from './generated/proto/HubEdge.js';

// Hub-Edge RPC types (typed protobuf messages)
export type {
  TypedRPCRequest,
  TypedRPCResponse,
  TypedRPCNotification,
} from './generated/proto/HubEdgeRPC.js';

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

// Re-export commonly used protobuf types with simplified names
import type { VoiceTarget } from './generated/proto/Mumble.js';
export type { VoiceTarget as MumbleVoiceTarget };

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
export type { IRPCChannel } from './rpc/rpc-channel.js';
export type { 
  Message, 
  PendingRequest,
  // Union type for all notification parameters - use when method name is dynamic
  // This type is now derived from rpc-types.ts and includes all Hub->Edge and Edge->Hub notifications
  NotificationParams,
  NotificationParams as ChannelNotificationParams, // Keep backward compatibility
  // Note: Individual notification parameter types are no longer exported from rpc-channel.ts
  // Use HubNotificationParams<'method.name'> or EdgeNotificationParams<'method.name'> instead
  // for compile-time type safety with specific notification methods
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
  HubSyncVoiceTargetNotification,
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

// Control Channel (基础 RPC 通道 - ControlChannelServer/Client 已移至各自的服务器包)
// Protocol 包只导出基础的 RPC 通道和消息类型

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
  VoiceTarget as HubVoiceTarget,
  ChannelTarget,
  GlobalSession,
  ChannelUserMap,
  CertificateExchangeRequest,
  CertificateExchangeResponse,
  SyncHeartbeatResponse,
  MissingUpdatesResponse,
  ChecksumResponse,
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
