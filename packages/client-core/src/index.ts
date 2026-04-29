export { MumbleClientCore } from './client-core.js';
export type { ClientOptions } from './client-options.js';
export type {
  AuthOptions,
  Channel,
  ChannelStateUpdate,
  MessageTarget,
  ServerInfo,
  SessionState,
  User,
  UserStateUpdate,
  VoiceFrame,
} from './types.js';
export { Permission, type PermissionMask } from './acl/permission.js';

// Protocol primitives (useful for hosts implementing custom transports/UDP)
export { FrameAssembler, wrapFrame, FRAME_HEADER_SIZE, type ParsedFrame } from './protocol/framing.js';
export {
  encodeOutgoingOpusVoicePacket,
  parseIncomingVoicePacket,
  isUdpPing,
  type IncomingVoicePacket,
} from './protocol/voice-packet.js';
export { encodeVarint, readVarint, type VarintReadResult } from './protocol/varint.js';

// Voice
export {
  JitterBuffer,
  JitterBufferPool,
  type JitterBufferOptions,
  type JitterStats,
} from './voice/jitter-buffer.js';

// State
export { StateManager, type StateCallbacks } from './state/state-manager.js';
