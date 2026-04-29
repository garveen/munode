/**
 * Mumble TCP frame layer.
 *
 * Wire format: `[type:u16 BE][length:u32 BE][payload bytes]`.
 *
 * `FrameAssembler` accumulates inbound bytes from the host transport and emits
 * complete frames in order. It performs no allocation in the steady state
 * beyond a single growing receive buffer.
 */

export interface ParsedFrame {
  type: number;
  payload: Uint8Array;
}

export const FRAME_HEADER_SIZE = 6;

export function wrapFrame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  out[0] = (type >> 8) & 0xff;
  out[1] = type & 0xff;
  const len = payload.length;
  out[2] = (len >>> 24) & 0xff;
  out[3] = (len >>> 16) & 0xff;
  out[4] = (len >>> 8) & 0xff;
  out[5] = len & 0xff;
  out.set(payload, FRAME_HEADER_SIZE);
  return out;
}

export class FrameAssembler {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): ParsedFrame[] {
    if (chunk.length === 0) return [];
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames: ParsedFrame[] = [];
    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      const type = (this.buffer[0]! << 8) | this.buffer[1]!;
      const length =
        (this.buffer[2]! * 0x1000000) +
        ((this.buffer[3]! << 16) | (this.buffer[4]! << 8) | this.buffer[5]!);
      if (this.buffer.length < FRAME_HEADER_SIZE + length) break;

      const payload = this.buffer.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + length);
      frames.push({ type, payload });
      this.buffer = this.buffer.slice(FRAME_HEADER_SIZE + length);
    }
    return frames;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}
