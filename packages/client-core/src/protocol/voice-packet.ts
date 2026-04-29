/**
 * Mumble voice packet (UDP body / `UDPTunnel` payload) parsing & encoding.
 *
 * Layout (legacy/non-protobuf):
 *   byte 0:   header      (codec << 5) | (target & 0x1F)
 *   varint:   session_id  (server -> client; absent when client -> server)
 *   varint:   sequence
 *   one or more codec frames (Opus uses a single varint-prefixed frame whose
 *   high bit indicates the end-of-talk terminator).
 *
 * For Opus the payload is a single Opus frame preceded by its size as a Mumble
 * varint, with the high bit (0x2000 in the resulting varint) set on terminator
 * frames.
 */

import { encodeVarint, readVarint } from './varint.js';

export interface IncomingVoicePacket {
  sessionId: number;
  sequence: number;
  target: number;
  codec: number;
  /**
   * Raw payload bytes after the sequence varint. For Opus this still includes
   * the size-varint prefix; consumers that want the bare Opus frame should
   * use `opusFrame` instead. Kept for backward compatibility with the legacy
   * client that emitted everything after sequence as `data`.
   */
  data: Uint8Array;
  /** Just the Opus frame bytes (codec === 4, terminator bit stripped). */
  opusFrame?: Uint8Array;
  /** Opus end-of-talk terminator bit. */
  terminator: boolean;
}

/**
 * Parse a UDP / UDPTunnel voice packet (server -> client, includes session id).
 * Returns null on malformed input.
 */
export function parseIncomingVoicePacket(buf: Uint8Array): IncomingVoicePacket | null {
  if (buf.length < 1) return null;

  const header = buf[0]!;
  const codec = (header >> 5) & 0x07;
  const target = header & 0x1f;

  const session = readVarint(buf, 1);
  if (!session) return null;
  const sequence = readVarint(buf, session.newOffset);
  if (!sequence) return null;

  let offset = sequence.newOffset;
  let terminator = false;
  const rawRest = buf.slice(offset);
  let opusFrame: Uint8Array | undefined;

  if (codec === 4 /* Opus */) {
    const sizeVar = readVarint(buf, offset);
    if (sizeVar) {
      const rawSize = sizeVar.value;
      const size = rawSize & 0x1fff;
      terminator = (rawSize & 0x2000) !== 0;
      const frameStart = sizeVar.newOffset;
      if (frameStart + size <= buf.length) {
        opusFrame = buf.slice(frameStart, frameStart + size);
      }
    }
  }

  return {
    sessionId: session.value,
    sequence: sequence.value,
    target,
    codec,
    data: rawRest,
    opusFrame,
    terminator,
  };
}

/**
 * Encode a client -> server voice packet for the Opus codec.
 * Format: [header][varint(seq)][varint(size|terminator)][opusFrame]
 *
 * Note: the client direction omits the session_id (the server attributes it
 * from the connection).
 */
export function encodeOutgoingOpusVoicePacket(opts: {
  target: number;
  sequence: number;
  opusFrame: Uint8Array;
  terminator?: boolean;
}): Uint8Array {
  const codec = 4; // Opus
  const header = ((codec & 0x07) << 5) | (opts.target & 0x1f);
  const seqVar = encodeVarint(opts.sequence);
  const sizeField = (opts.opusFrame.length & 0x1fff) | (opts.terminator ? 0x2000 : 0);
  const sizeVar = encodeVarint(sizeField);

  const total = 1 + seqVar.length + sizeVar.length + opts.opusFrame.length;
  const out = new Uint8Array(total);
  let off = 0;
  out[off++] = header;
  out.set(seqVar, off); off += seqVar.length;
  out.set(sizeVar, off); off += sizeVar.length;
  out.set(opts.opusFrame, off);
  return out;
}

/**
 * Detect a UDP Ping response: header byte type field (bits 7..5) === 1.
 */
export function isUdpPing(buf: Uint8Array): boolean {
  if (buf.length < 1) return false;
  return ((buf[0]! >> 5) & 0x07) === 1;
}
