/**
 * Core types for @munode/client-core.
 * Platform-neutral, no Node `Buffer`.
 */

export interface Channel {
  channel_id: number;
  parent: number;
  name: string;
  description?: string;
  temporary: boolean;
  position: number;
  links: number[];
  max_users: number;
  children: number[];
}

export interface User {
  session: number;
  user_id?: number;
  name: string;
  channel_id: number;
  mute: boolean;
  deaf: boolean;
  suppress: boolean;
  self_mute: boolean;
  self_deaf: boolean;
  recording: boolean;
  priority_speaker: boolean;
  hash?: string;
  comment?: string;
  comment_hash?: string;
  texture?: Uint8Array;
  texture_hash?: string;
}

export interface ServerInfo {
  version: number;
  release: string;
  os: string;
  maxBandwidth: number;
  maxUsers: number;
  welcomeText: string;
  allowHtml: boolean;
  messageLength: number;
}

export interface SessionState {
  session: number;
  user_id?: number;
  channel_id: number;
  mute: boolean;
  deaf: boolean;
  self_mute: boolean;
  self_deaf: boolean;
  suppress: boolean;
  recording: boolean;
  priority_speaker: boolean;
  listeningChannels: number[];
}

export interface MessageTarget {
  channelId?: number;
  userId?: number;
  tree?: boolean;
}

export interface AuthOptions {
  username: string;
  password?: string;
  tokens?: string[];
  /** If true, send `self_mute`/`self_deaf` UserState immediately after Authenticate. */
  preConnectState?: {
    self_mute?: boolean;
    self_deaf?: boolean;
  };
}

export interface UserStateUpdate {
  session?: number;
  channel_id?: number;
  mute?: boolean;
  deaf?: boolean;
  suppress?: boolean;
  self_mute?: boolean;
  self_deaf?: boolean;
  priority_speaker?: boolean;
  recording?: boolean;
  comment?: string;
  texture?: Uint8Array;
  listening_channel_add?: number[];
  listening_channel_remove?: number[];
  listening_volume_adjustment?: Array<{ listening_channel?: number; volume_adjustment?: number }>;
}

export interface ChannelStateUpdate {
  channel_id?: number;
  parent?: number;
  name?: string;
  description?: string;
  position?: number;
  temporary?: boolean;
  max_users?: number;
  links?: number[];
  links_add?: number[];
  links_remove?: number[];
}

export interface VoiceFrame {
  /** Speaker session ID. */
  session: number;
  /** Voice packet sequence number. */
  sequence: number;
  /** Voice target / whisper id (0 = normal, 1..30 = whisper, 31 = server-loopback). */
  target: number;
  /** Codec hint from packet header (bits 7..5). 4 = Opus. */
  codec: number;
  /** Raw codec frame payload (Opus bytes). The host is responsible for decoding. */
  data: Uint8Array;
  /** True if this frame carries the end-of-talk terminator marker. */
  terminator: boolean;
}
