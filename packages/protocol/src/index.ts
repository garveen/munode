// Mumble protocol types
export { mumbleproto } from './generated/proto/Mumble.js';

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
  ClientState,
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
export { ClientState as ClientStateEnum } from './shared-types.js';

// RPC Channel
export { RPCChannel } from './rpc/rpc-channel.js';
export type { Message, PendingRequest } from './rpc/rpc-channel.js';

// Typed RPC
export { TypedRPCClient, createTypedRPCClient } from './rpc/typed-rpc-client.js';
export { TypedRPCServer, createTypedRPCServer } from './rpc/typed-rpc-server.js';
export type { RPCHandler, RPCError } from './rpc/typed-rpc-server.js';
export type {
  EdgeToHubMethods,
  HubToEdgeNotifications,
  RPCMethodMap,
  NotificationMethodMap,
  RPCParams,
  RPCResult,
  NotificationParams,
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
} from './rpc/rpc-types.js';

// Voice Channel
export { VoiceChannel } from './voice/voice-packet.js';
export type { VoicePacket, VoiceEncryptionConfig } from './voice/voice-packet.js';
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
