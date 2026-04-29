/**
 * Mumble varint codec — a custom variable-length integer format used in Mumble
 * voice packets. NOT the same as protobuf varint.
 *
 * Encoding rules (see Go reference: packetdata/packetdata.go):
 *   0x00-0x7F : 1 byte (value in lower 7 bits)
 *   0x80-0xBF : 2 bytes (lower 14 bits)
 *   0xC0-0xDF : 3 bytes (lower 21 bits)
 *   0xE0-0xEF : 4 bytes (lower 28 bits)
 *   0xF0      : full 32-bit big-endian integer in next 4 bytes
 *   0xF4      : full 64-bit big-endian integer in next 8 bytes (we keep low 32)
 *   0xF8      : negated varint follows
 *   0xFC-0xFF : small negatives (-1..-4)
 */

export interface VarintReadResult {
  value: number;
  newOffset: number;
}

export function readVarint(buffer: Uint8Array, offset: number): VarintReadResult | null {
  if (offset >= buffer.length) return null;

  const v = buffer[offset]!;
  offset++;

  if ((v & 0x80) === 0x00) {
    return { value: v & 0x7f, newOffset: offset };
  }

  if ((v & 0xc0) === 0x80) {
    if (offset >= buffer.length) return null;
    const value = ((v & 0x3f) << 8) | buffer[offset]!;
    return { value, newOffset: offset + 1 };
  }

  if ((v & 0xf0) === 0xf0) {
    switch (v & 0xfc) {
      case 0xf0: {
        if (offset + 3 >= buffer.length) return null;
        const value =
          (buffer[offset]! << 24) |
          (buffer[offset + 1]! << 16) |
          (buffer[offset + 2]! << 8) |
          buffer[offset + 3]!;
        return { value: value >>> 0, newOffset: offset + 4 };
      }
      case 0xf4: {
        if (offset + 7 >= buffer.length) return null;
        const value =
          (buffer[offset + 4]! << 24) |
          (buffer[offset + 5]! << 16) |
          (buffer[offset + 6]! << 8) |
          buffer[offset + 7]!;
        return { value: value >>> 0, newOffset: offset + 8 };
      }
      case 0xf8: {
        const result = readVarint(buffer, offset);
        if (!result) return null;
        return { value: ~result.value, newOffset: result.newOffset };
      }
      case 0xfc:
        return { value: ~(v & 0x03), newOffset: offset };
      default:
        return null;
    }
  }

  if ((v & 0xe0) === 0xc0) {
    if (offset + 1 >= buffer.length) return null;
    const value = ((v & 0x1f) << 16) | (buffer[offset]! << 8) | buffer[offset + 1]!;
    return { value, newOffset: offset + 2 };
  }

  if ((v & 0xf0) === 0xe0) {
    if (offset + 2 >= buffer.length) return null;
    const value =
      ((v & 0x0f) << 24) |
      (buffer[offset]! << 16) |
      (buffer[offset + 1]! << 8) |
      buffer[offset + 2]!;
    return { value: value >>> 0, newOffset: offset + 3 };
  }

  return null;
}

/**
 * Encode an unsigned integer as a Mumble varint.
 * Negative numbers are encoded via the 0xF8 prefix.
 */
export function encodeVarint(value: number): Uint8Array {
  if (value < 0) {
    const inverted = encodeVarint(~value);
    const out = new Uint8Array(inverted.length + 1);
    out[0] = 0xf8;
    out.set(inverted, 1);
    return out;
  }

  if (value < 0x80) {
    return Uint8Array.of(value & 0x7f);
  }

  if (value < 0x4000) {
    return Uint8Array.of(0x80 | ((value >> 8) & 0x3f), value & 0xff);
  }

  if (value < 0x200000) {
    return Uint8Array.of(
      0xc0 | ((value >> 16) & 0x1f),
      (value >> 8) & 0xff,
      value & 0xff,
    );
  }

  if (value < 0x10000000) {
    return Uint8Array.of(
      0xe0 | ((value >> 24) & 0x0f),
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    );
  }

  // Fallback: 32-bit literal
  return Uint8Array.of(
    0xf0,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}
