//! Mumble-specific varint encoding/decoding.
//!
//! This is NOT the standard protobuf varint. Mumble uses its own variable-length
//! integer encoding in voice packets (for session ID and sequence number fields).
//!
//! Encoding rules:
//! - 0x00–0x7F:        1 byte  (7-bit value, 0xxxxxxx)
//! - 0x80–0x3FFF:      2 bytes (14-bit, 10xxxxxx xxxxxxxx)
//! - 0x4000–0x1FFFFF:  3 bytes (21-bit, 110xxxxx xxxxxxxx xxxxxxxx)
//! - 0x200000–0xFFFFFFF: 4 bytes (28-bit, 1110xxxx …)
//! - 0xF0 prefix + 4 bytes: full 32-bit value
//! - 0xF4 prefix + 8 bytes: full 64-bit value
//! - 0xF8: negative (recursive, negated value follows)
//! - 0xFC–0xFF: small negative -1 to -4

/// Encode a `u64` value as a Mumble varint.
pub fn encode_varint(value: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(9);
    if value < 0x80 {
        out.push(value as u8);
    } else if value < 0x4000 {
        out.push(((value >> 8) as u8) | 0x80);
        out.push((value & 0xFF) as u8);
    } else if value < 0x20_0000 {
        out.push(((value >> 16) as u8) | 0xC0);
        out.push(((value >> 8) & 0xFF) as u8);
        out.push((value & 0xFF) as u8);
    } else if value < 0x1000_0000 {
        out.push(((value >> 24) as u8) | 0xE0);
        out.push(((value >> 16) & 0xFF) as u8);
        out.push(((value >> 8) & 0xFF) as u8);
        out.push((value & 0xFF) as u8);
    } else if value < 0x1_0000_0000 {
        out.push(0xF0);
        out.push(((value >> 24) & 0xFF) as u8);
        out.push(((value >> 16) & 0xFF) as u8);
        out.push(((value >> 8) & 0xFF) as u8);
        out.push((value & 0xFF) as u8);
    } else {
        out.push(0xF4);
        out.push(((value >> 56) & 0xFF) as u8);
        out.push(((value >> 48) & 0xFF) as u8);
        out.push(((value >> 40) & 0xFF) as u8);
        out.push(((value >> 32) & 0xFF) as u8);
        out.push(((value >> 24) & 0xFF) as u8);
        out.push(((value >> 16) & 0xFF) as u8);
        out.push(((value >> 8) & 0xFF) as u8);
        out.push((value & 0xFF) as u8);
    }
    out
}

/// Decode a Mumble varint from `buf` starting at `offset`.
///
/// Returns `Some((value, bytes_consumed))` on success, `None` if there are not
/// enough bytes.
pub fn decode_varint(buf: &[u8], offset: usize) -> Option<(u64, usize)> {
    if offset >= buf.len() {
        return None;
    }
    let first = buf[offset];
    if first < 0x80 {
        Some((first as u64, 1))
    } else if first < 0xC0 {
        if offset + 1 >= buf.len() {
            return None;
        }
        let value = (((first & 0x3F) as u64) << 8) | buf[offset + 1] as u64;
        Some((value, 2))
    } else if first < 0xE0 {
        if offset + 2 >= buf.len() {
            return None;
        }
        let value = (((first & 0x1F) as u64) << 16)
            | ((buf[offset + 1] as u64) << 8)
            | buf[offset + 2] as u64;
        Some((value, 3))
    } else if first < 0xF0 {
        if offset + 3 >= buf.len() {
            return None;
        }
        let value = (((first & 0x0F) as u64) << 24)
            | ((buf[offset + 1] as u64) << 16)
            | ((buf[offset + 2] as u64) << 8)
            | buf[offset + 3] as u64;
        Some((value, 4))
    } else if first == 0xF0 {
        if offset + 4 >= buf.len() {
            return None;
        }
        let value = ((buf[offset + 1] as u64) << 24)
            | ((buf[offset + 2] as u64) << 16)
            | ((buf[offset + 3] as u64) << 8)
            | buf[offset + 4] as u64;
        Some((value, 5))
    } else if first == 0xF4 {
        if offset + 8 >= buf.len() {
            return None;
        }
        let value = ((buf[offset + 1] as u64) << 56)
            | ((buf[offset + 2] as u64) << 48)
            | ((buf[offset + 3] as u64) << 40)
            | ((buf[offset + 4] as u64) << 32)
            | ((buf[offset + 5] as u64) << 24)
            | ((buf[offset + 6] as u64) << 16)
            | ((buf[offset + 7] as u64) << 8)
            | buf[offset + 8] as u64;
        Some((value, 9))
    } else if first == 0xF8 {
        // Negative: next varint is the negated value
        let (inner, consumed) = decode_varint(buf, offset + 1)?;
        Some(((!inner).wrapping_add(1), consumed + 1))
    } else {
        // 0xFC–0xFF: small negatives -1 to -4 (encoded as their two's complement u64)
        let small_neg = first & 0x03;
        let value = (!(small_neg as u64)).wrapping_add(1); // -(small_neg+1)
        Some((value, 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roundtrip_small() {
        for v in [0u64, 1, 63, 127] {
            let encoded = encode_varint(v);
            let (decoded, _) = decode_varint(&encoded, 0).unwrap();
            assert_eq!(decoded, v, "roundtrip failed for {v}");
        }
    }

    #[test]
    fn test_roundtrip_medium() {
        for v in [128u64, 255, 16383, 16384, 0x1FFFFF] {
            let encoded = encode_varint(v);
            let (decoded, _) = decode_varint(&encoded, 0).unwrap();
            assert_eq!(decoded, v, "roundtrip failed for {v}");
        }
    }

    #[test]
    fn test_roundtrip_large() {
        for v in [0x1000_0000u64, 0xFFFF_FFFF, 0x1_0000_0000, u64::MAX] {
            let encoded = encode_varint(v);
            let (decoded, _) = decode_varint(&encoded, 0).unwrap();
            assert_eq!(decoded, v, "roundtrip failed for {v}");
        }
    }

    #[test]
    fn test_insufficient_data() {
        assert!(decode_varint(&[], 0).is_none());
        // 2-byte sequence with only first byte
        let two_byte = encode_varint(0x80);
        assert!(decode_varint(&two_byte[..1], 0).is_none());
    }
}
