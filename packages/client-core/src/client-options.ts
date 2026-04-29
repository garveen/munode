/**
 * Public callback contract between the host (transport + I/O) and the
 * platform-neutral core.
 *
 * `send` is the only required member: the core uses it to push outbound
 * framed bytes into the host's transport. Every other entry is an optional
 * notification fired by the core when an inbound message has been parsed
 * and applied.
 *
 * Hosts in turn drive the core via:
 *   - `core.receive(bytes)`        when transport delivers raw inbound bytes
 *   - `core.onTransportClosed()`   when the transport disconnects
 *   - `core.reset()`               before reusing the core after reconnect
 *
 * Voice frames are delivered as raw Opus payload to `onVoiceFrame`. The host
 * is responsible for codec decoding (e.g. AudioWorklet or @discordjs/opus).
 */

import type { mumbleproto } from '@munode/protocol';
import type { VoiceFrame } from './types.js';

export interface ClientOptions {
  /**
   * Required. Transmit a fully-framed Mumble message to the server.
   * Implementations must not buffer or reorder; the core has already
   * prepended `[type:u16][length:u32]`.
   */
  send(data: Uint8Array): void | Promise<void>;

  /**
   * Optional. Send a raw UDP voice packet (already serialized with
   * `encodeOutgoingOpusVoicePacket`). If omitted or returns `false`, the
   * core falls back to TCP tunneling via `send()`.
   *
   * Hosts that have UDP available (Node, native) should encrypt with OCB2
   * inside this callback before sending.
   */
  sendVoiceUdp?(packet: Uint8Array): void | Promise<void> | boolean | Promise<boolean>;

  // Lifecycle ---------------------------------------------------------------
  onConnected?(): void;
  onDisconnected?(reason?: string): void;
  onError?(error: Error): void;
  onAuthenticated?(message: mumbleproto.ServerSync): void;
  onAuthenticationFailed?(info: { type: number; reason: string; message: mumbleproto.Reject }): void;

  // State -------------------------------------------------------------------
  onServerSync?(message: mumbleproto.ServerSync): void;
  onServerConfig?(message: mumbleproto.ServerConfig): void;
  onSuggestConfig?(message: mumbleproto.SuggestConfig): void;
  onChannelState?(message: mumbleproto.ChannelState): void;
  onChannelRemove?(message: mumbleproto.ChannelRemove): void;
  onUserState?(message: mumbleproto.UserState): void;
  onUserRemove?(message: mumbleproto.UserRemove): void;
  onKicked?(message: mumbleproto.UserRemove): void;

  // Permissions / ACL -------------------------------------------------------
  onPermissionDenied?(message: mumbleproto.PermissionDenied): void;
  onChannelDenied?(message: mumbleproto.PermissionDenied): void;
  onACL?(message: mumbleproto.ACL): void;
  onPermissionQuery?(message: mumbleproto.PermissionQuery): void;
  onQueryUsers?(message: mumbleproto.QueryUsers): void;

  // Messaging ---------------------------------------------------------------
  onTextMessage?(message: mumbleproto.TextMessage): void;
  onContextActionModify?(message: mumbleproto.ContextActionModify): void;
  onContextAction?(message: mumbleproto.ContextAction): void;

  // Admin -------------------------------------------------------------------
  onBanList?(message: mumbleproto.BanList): void;
  onUserList?(message: mumbleproto.UserList): void;
  onUserStats?(message: mumbleproto.UserStats): void;

  // Voice -------------------------------------------------------------------
  /**
   * Called for each parsed inbound voice frame. The core has already pushed
   * the frame into its jitter buffer; this callback is purely informational
   * for hosts that want their own playback policy.
   */
  onVoiceFrame?(frame: VoiceFrame): void;
  onVoiceTarget?(message: mumbleproto.VoiceTarget): void;

  // Crypto / low-level ------------------------------------------------------
  /**
   * Server sent a `CryptSetup` message. Hosts that own the UDP socket should
   * initialize OCB2-AES128 here. The core itself does not implement OCB2.
   */
  onCryptSetup?(message: mumbleproto.CryptSetup): void;
  onPing?(message: mumbleproto.Ping): void;
  onVersion?(message: mumbleproto.Version): void;
  onCodecVersion?(message: mumbleproto.CodecVersion): void;
  onPluginData?(message: mumbleproto.PluginDataTransmission): void;
  onRequestBlob?(message: mumbleproto.RequestBlob): void;
  onUDPTunnel?(payload: Uint8Array): void;

  // Diagnostics -------------------------------------------------------------
  onUnknownMessage?(info: { type: number; payload: Uint8Array }): void;
  onMessageError?(info: { type: number; payload: Uint8Array; error: Error }): void;
}
