/**
 * Inbound TCP message dispatcher.
 *
 * Decodes a single `[type][payload]` frame and routes it to the appropriate
 * handler in `MumbleClientCore`. Pure function — no I/O.
 */

import { mumbleproto, MessageType } from '@munode/protocol';
import type { ClientOptions } from '../client-options.js';
import type { StateManager } from '../state/state-manager.js';
import type { VoiceFrame } from '../types.js';
import { parseIncomingVoicePacket } from './voice-packet.js';

export interface DispatchContext {
  options: ClientOptions;
  state: StateManager;
  /** Called for each parsed inbound voice frame (already pushed to jitter buffer by caller). */
  handleVoiceFrame: (frame: VoiceFrame) => void;
  /** Called when a `Reject` is received; lets the auth flow reject its promise. */
  handleReject: (msg: mumbleproto.Reject) => void;
  /** Called when `ServerSync` is received; lets the auth flow resolve. */
  handleServerSync: (msg: mumbleproto.ServerSync) => void;
}

export function dispatchFrame(ctx: DispatchContext, type: number, payload: Uint8Array): void {
  const { options, state } = ctx;
  try {
    switch (type) {
      case MessageType.Version:
        options.onVersion?.(mumbleproto.Version.decode(payload));
        return;
      case MessageType.UDPTunnel: {
        // Voice tunneled over TCP. Not OCB2-encrypted (TLS already protects).
        options.onUDPTunnel?.(payload);
        const parsed = parseIncomingVoicePacket(payload);
        if (parsed) {
          const frame: VoiceFrame = {
            session: parsed.sessionId,
            sequence: parsed.sequence,
            target: parsed.target,
            codec: parsed.codec,
            data: parsed.data,
            terminator: parsed.terminator,
          };
          ctx.handleVoiceFrame(frame);
        }
        return;
      }
      case MessageType.Authenticate:
        // Server should not send this; ignore.
        return;
      case MessageType.Ping:
        options.onPing?.(mumbleproto.Ping.decode(payload));
        return;
      case MessageType.Reject: {
        const msg = mumbleproto.Reject.decode(payload);
        ctx.handleReject(msg);
        return;
      }
      case MessageType.ServerSync: {
        const msg = mumbleproto.ServerSync.decode(payload);
        state.handleServerSync(msg);
        ctx.handleServerSync(msg);
        return;
      }
      case MessageType.ChannelRemove:
        state.handleChannelRemove(mumbleproto.ChannelRemove.decode(payload));
        return;
      case MessageType.ChannelState:
        state.handleChannelState(mumbleproto.ChannelState.decode(payload));
        return;
      case MessageType.UserRemove:
        state.handleUserRemove(mumbleproto.UserRemove.decode(payload));
        return;
      case MessageType.UserState:
        state.handleUserState(mumbleproto.UserState.decode(payload));
        return;
      case MessageType.BanList:
        options.onBanList?.(mumbleproto.BanList.decode(payload));
        return;
      case MessageType.TextMessage:
        options.onTextMessage?.(mumbleproto.TextMessage.decode(payload));
        return;
      case MessageType.PermissionDenied:
        state.handlePermissionDenied(mumbleproto.PermissionDenied.decode(payload));
        return;
      case MessageType.ACL:
        options.onACL?.(mumbleproto.ACL.decode(payload));
        return;
      case MessageType.QueryUsers:
        options.onQueryUsers?.(mumbleproto.QueryUsers.decode(payload));
        return;
      case MessageType.CryptSetup:
        options.onCryptSetup?.(mumbleproto.CryptSetup.decode(payload));
        return;
      case MessageType.ContextActionModify:
        options.onContextActionModify?.(mumbleproto.ContextActionModify.decode(payload));
        return;
      case MessageType.ContextAction:
        options.onContextAction?.(mumbleproto.ContextAction.decode(payload));
        return;
      case MessageType.UserList:
        options.onUserList?.(mumbleproto.UserList.decode(payload));
        return;
      case MessageType.VoiceTarget:
        options.onVoiceTarget?.(mumbleproto.VoiceTarget.decode(payload));
        return;
      case MessageType.PermissionQuery:
        options.onPermissionQuery?.(mumbleproto.PermissionQuery.decode(payload));
        return;
      case MessageType.CodecVersion:
        options.onCodecVersion?.(mumbleproto.CodecVersion.decode(payload));
        return;
      case MessageType.UserStats:
        options.onUserStats?.(mumbleproto.UserStats.decode(payload));
        return;
      case MessageType.RequestBlob:
        options.onRequestBlob?.(mumbleproto.RequestBlob.decode(payload));
        return;
      case MessageType.ServerConfig:
        state.handleServerConfig(mumbleproto.ServerConfig.decode(payload));
        return;
      case MessageType.SuggestConfig:
        options.onSuggestConfig?.(mumbleproto.SuggestConfig.decode(payload));
        return;
      case MessageType.PluginDataTransmission:
        options.onPluginData?.(mumbleproto.PluginDataTransmission.decode(payload));
        return;
      default:
        options.onUnknownMessage?.({ type, payload });
        return;
    }
  } catch (error) {
    options.onMessageError?.({ type, payload, error: error as Error });
  }
}
