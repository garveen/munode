//! Mumble voice packet construction / parsing and Mumble varint codec.
//!
//! Re-exports the varint functions from `munode_protocol` and provides
//! helpers for building and parsing Mumble voice packets.

pub use munode_protocol::varint::{decode_varint, encode_varint};

/// A decoded voice packet received from the server.
#[derive(Debug, Clone)]
pub struct VoiceData {
    /// Sender session ID.
    pub session: u32,
    /// Codec type (upper 3 bits of header byte).
    pub codec: u8,
    /// Voice target (lower 5 bits of header byte).
    pub target: u8,
    /// Sequence number.
    pub sequence: u64,
    /// Raw audio payload bytes.
    pub audio_data: Vec<u8>,
}

/// Build a client-format voice packet ready to be sent via TCP UDPTunnel or UDP.
///
/// Wire format:
/// ```text
/// [header:1] [sequence:varint] [audio_data_len:varint] [audio_data]
/// ```
/// where `header = (codec << 5) | (target & 0x1F)`.
pub fn build_voice_packet(codec: u8, target: u8, sequence: u64, audio_data: &[u8]) -> Vec<u8> {
    let header = (codec << 5) | (target & 0x1F);
    let mut packet = Vec::with_capacity(1 + 9 + 9 + audio_data.len());
    packet.push(header);
    packet.extend(encode_varint(sequence));
    // Mumble Opus packets: include a length-prefixed varint before the data.
    // For Opus (codec=4) the audio frame is prefixed with its length.
    packet.extend(encode_varint(audio_data.len() as u64));
    packet.extend_from_slice(audio_data);
    packet
}

/// Parse a voice packet received from the server (after decryption for UDP).
///
/// Wire format coming *from* the server to the client:
/// ```text
/// [header:1] [session:varint] [sequence:varint] [audio_data]
/// ```
pub fn parse_voice_packet(data: &[u8]) -> Option<VoiceData> {
    if data.is_empty() {
        return None;
    }
    let header = data[0];
    let codec = header >> 5;
    let target = header & 0x1F;

    let (session, s_len) = decode_varint(data, 1)?;
    let (sequence, seq_len) = decode_varint(data, 1 + s_len)?;

    let audio_start = 1 + s_len + seq_len;
    let audio_data = data.get(audio_start..)?.to_vec();

    Some(VoiceData {
        session: session as u32,
        codec,
        target,
        sequence,
        audio_data,
    })
}

/// Build a UDP Ping packet (used to initiate the UDP handshake).
///
/// Format: `[header=0x20:1][timestamp:varint]`
pub fn build_udp_ping(timestamp_ms: u64) -> Vec<u8> {
    let mut packet = vec![0x20u8]; // type=Ping(1)<<5, target=0
    packet.extend(encode_varint(timestamp_ms));
    packet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_parse_voice_packet() {
        // Build a packet as the server would send it back (session included)
        // The server-to-client format has [header][session][seq][data]
        let header = (4u8 << 5) | 0; // Opus, target=0
        let session = 42u32;
        let sequence = 7u64;
        let audio = vec![0xAB, 0xCD, 0xEF];

        let mut pkt = vec![header];
        pkt.extend(encode_varint(session as u64));
        pkt.extend(encode_varint(sequence));
        pkt.extend_from_slice(&audio);

        let parsed = parse_voice_packet(&pkt).unwrap();
        assert_eq!(parsed.session, session);
        assert_eq!(parsed.codec, 4);
        assert_eq!(parsed.target, 0);
        assert_eq!(parsed.sequence, sequence);
        assert_eq!(parsed.audio_data, audio);
    }

    #[test]
    fn test_udp_ping() {
        let ping = build_udp_ping(12345);
        assert_eq!(ping[0], 0x20);
        let (ts, _) = decode_varint(&ping, 1).unwrap();
        assert_eq!(ts, 12345);
    }
}
