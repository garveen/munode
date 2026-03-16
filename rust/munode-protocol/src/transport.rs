use bytes::{Buf, BufMut, BytesMut};
use prost::Message;
use thiserror::Error;

use crate::message_type::MessageType;

/// Errors that can occur during message framing.
#[derive(Error, Debug)]
pub enum FrameError {
    #[error("incomplete frame: need {needed} bytes, have {available}")]
    Incomplete { needed: usize, available: usize },
    #[error("unknown message type: {0}")]
    UnknownMessageType(u16),
    #[error("message too large: {size} bytes (max {max})")]
    MessageTooLarge { size: usize, max: usize },
    #[error("protobuf decode error: {0}")]
    DecodeError(#[from] prost::DecodeError),
}

/// Maximum message size (8 MB, matching Mumble's limit).
const MAX_MESSAGE_SIZE: usize = 8 * 1024 * 1024;

/// Mumble protocol frame header size: type (2 bytes) + length (4 bytes).
const HEADER_SIZE: usize = 6;

/// A raw Mumble protocol frame before decoding.
#[derive(Debug)]
pub struct RawFrame {
    pub message_type: MessageType,
    pub payload: Vec<u8>,
}

/// Encode a Mumble protocol message into wire format.
///
/// Wire format: [type:u16 big-endian][length:u32 big-endian][protobuf payload]
///
/// Panics if the encoded payload exceeds `u32::MAX` bytes (~4 GiB), which is
/// impossible in practice given the protocol's 8 MiB message size limit.
pub fn encode_message<M: Message>(
    msg_type: MessageType,
    message: &M,
    buf: &mut BytesMut,
) {
    let payload = message.encode_to_vec();
    let len: u32 = payload.len().try_into()
        .expect("encoded message exceeds u32::MAX bytes — impossible given the 8 MiB protocol limit");
    buf.put_u16(msg_type as u16);
    buf.put_u32(len);
    buf.put_slice(&payload);
}

/// Try to decode a raw frame from a buffer.
///
/// Returns `Ok(Some(frame))` if a complete frame was decoded,
/// `Ok(None)` if more data is needed, or `Err` on protocol errors.
pub fn decode_frame(buf: &mut BytesMut) -> Result<Option<RawFrame>, FrameError> {
    if buf.len() < HEADER_SIZE {
        return Ok(None);
    }

    let msg_type_raw = u16::from_be_bytes([buf[0], buf[1]]);
    let payload_len = u32::from_be_bytes([buf[2], buf[3], buf[4], buf[5]]) as usize;

    if payload_len > MAX_MESSAGE_SIZE {
        return Err(FrameError::MessageTooLarge {
            size: payload_len,
            max: MAX_MESSAGE_SIZE,
        });
    }

    let total_len = HEADER_SIZE + payload_len;
    if buf.len() < total_len {
        return Ok(None);
    }

    let message_type = MessageType::from_u16(msg_type_raw)
        .ok_or(FrameError::UnknownMessageType(msg_type_raw))?;

    buf.advance(HEADER_SIZE);
    let payload = buf.split_to(payload_len).to_vec();

    Ok(Some(RawFrame {
        message_type,
        payload,
    }))
}

/// Voice UDP header for Edge-to-Edge voice data.
///
/// Format: [sender_id:u32][target_id:u32][sequence:u32] (12 bytes, big-endian)
pub const VOICE_UDP_HEADER_SIZE: usize = 12;

/// Edge-to-Edge magic number (2 bytes, both 0x00).
pub const EDGE_MAGIC: [u8; 2] = [0x00, 0x00];

/// Encode a voice UDP header.
pub fn encode_voice_header(sender_id: u32, target_id: u32, sequence: u32, buf: &mut BytesMut) {
    buf.put_u32(sender_id);
    buf.put_u32(target_id);
    buf.put_u32(sequence);
}

/// Decode a voice UDP header.
pub fn decode_voice_header(data: &[u8]) -> Option<(u32, u32, u32)> {
    if data.len() < VOICE_UDP_HEADER_SIZE {
        return None;
    }
    let sender_id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    let target_id = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    let sequence = u32::from_be_bytes([data[8], data[9], data[10], data[11]]);
    Some((sender_id, target_id, sequence))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mumbleproto;

    #[test]
    fn test_encode_decode_frame() {
        let version = mumbleproto::Version {
            version: Some(0x0001_0300), // 1.3.0
            release: Some("test".into()),
            os: Some("linux".into()),
            os_version: Some("6.0".into()),
        };

        let mut buf = BytesMut::new();
        encode_message(MessageType::Version, &version, &mut buf);

        let frame = decode_frame(&mut buf).unwrap().unwrap();
        assert_eq!(frame.message_type, MessageType::Version);

        let decoded = mumbleproto::Version::decode(&frame.payload[..]).unwrap();
        assert_eq!(decoded.release(), "test");
    }

    #[test]
    fn test_incomplete_frame() {
        let mut buf = BytesMut::from(&[0u8, 0, 0, 0][..]);
        assert!(matches!(decode_frame(&mut buf), Ok(None)));
    }

    #[test]
    fn test_voice_header() {
        let mut buf = BytesMut::new();
        encode_voice_header(1, 2, 100, &mut buf);
        let (s, t, seq) = decode_voice_header(&buf).unwrap();
        assert_eq!((s, t, seq), (1, 2, 100));
    }
}
