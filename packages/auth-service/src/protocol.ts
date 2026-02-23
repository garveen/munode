/**
 * Protocol encoder/decoder for the AuthService WebSocket protocol.
 *
 * Uses the same ts-proto generated code as the rest of the project
 * (`@munode/protocol`), relying on @bufbuild/protobuf/wire for binary
 * encode/decode — no additional protobuf runtime is needed.
 */

import {
  AuthServicePacket,
  AuthServiceAuthRequest,
  AuthServiceAuthResponse,
  HelloParams as _HelloParams,
} from '@munode/protocol';

// ---------------------------------------------------------------------------
// Re-export the generated types so consumers only need to import from here.
// ---------------------------------------------------------------------------

export { AuthServicePacket, AuthServicePacket_Type } from '@munode/protocol';
export type AuthRequest = AuthServiceAuthRequest;
export type AuthResponse = AuthServiceAuthResponse;
export type HelloParams = _HelloParams;

// ---------------------------------------------------------------------------
// Codec helpers
// ---------------------------------------------------------------------------

/**
 * Encode an AuthServicePacket to a binary Buffer suitable for a WebSocket
 * binary frame.
 */
export function encodePacket(packet: AuthServicePacket): Buffer {
  return Buffer.from(AuthServicePacket.encode(packet).finish());
}

/**
 * Decode a binary Buffer into an AuthServicePacket.
 * Throws if the buffer cannot be decoded.
 */
export function decodePacket(data: Buffer | Uint8Array): AuthServicePacket {
  return AuthServicePacket.decode(data);
}
