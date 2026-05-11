//! Shared voice packet utilities used by both the TCP (server.rs) and UDP (udp.rs) paths.

use std::sync::Arc;
use tracing::{debug, trace};
use crate::hub_client::HubClient;
use crate::state::EdgeState;

#[inline]
fn write_mumble_varint_stack(value: u32, dst: &mut [u8; 5]) -> usize {
    if value < 0x80 {
        dst[0] = value as u8;
        1
    } else if value < 0x4000 {
        dst[0] = ((value >> 8) | 0x80) as u8;
        dst[1] = (value & 0xFF) as u8;
        2
    } else if value < 0x200000 {
        dst[0] = ((value >> 16) | 0xC0) as u8;
        dst[1] = ((value >> 8) & 0xFF) as u8;
        dst[2] = (value & 0xFF) as u8;
        3
    } else {
        dst[0] = 0xF0;
        dst[1] = ((value >> 24) & 0xFF) as u8;
        dst[2] = ((value >> 16) & 0xFF) as u8;
        dst[3] = ((value >> 8) & 0xFF) as u8;
        dst[4] = (value & 0xFF) as u8;
        5
    }
}

/// Decode a Mumble varint from a byte slice.
/// Returns `(value, bytes_consumed)` or `None` if insufficient data.
#[inline]
fn decode_varint(data: &[u8]) -> Option<(u32, usize)> {
    let v = *data.first()?;
    if v & 0x80 == 0 { return Some((v as u32, 1)); }
    if v & 0xC0 == 0x80 {
        if data.len() < 2 { return None; }
        return Some((((v & 0x3F) as u32) << 8 | data[1] as u32, 2));
    }
    if v & 0xE0 == 0xC0 {
        if data.len() < 3 { return None; }
        return Some((((v & 0x1F) as u32) << 16 | (data[1] as u32) << 8 | data[2] as u32, 3));
    }
    if v & 0xF0 == 0xE0 {
        if data.len() < 4 { return None; }
        return Some((((v & 0x0F) as u32) << 24 | (data[1] as u32) << 16
            | (data[2] as u32) << 8 | data[3] as u32, 4));
    }
    None
}

/// Deliver a relayed voice packet (received from a peer edge TCP connection or
/// Hub relay) directly to the appropriate local clients.
///
/// This function is the shared hot path for both Hub-relay and Edge-to-Edge TCP
/// voice delivery.  It intentionally bypasses `EdgeEvent::RelayedVoice` and the
/// broadcast channel to avoid filling the control-event bus with high-frequency
/// voice frames.
pub async fn deliver_relayed_voice(
    voice_packet: bytes::Bytes,
    state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
) {
    if voice_packet.len() < 2 {
        return;
    }
    let raw_target = voice_packet[0] & 0x1F;
    if raw_target == 31 {
        // Loopback — ignore cross-edge loopback
        return;
    }

    let (sender_session, _) = match decode_varint(&voice_packet[1..]) {
        Some(v) => v,
        None => {
            debug!("deliver_relayed_voice: failed to parse sender session varint");
            return;
        }
    };

    trace!("edge={} RelayedVoice recv: len={} header=0x{:02X} target={} session={}",
        state.get_edge_id(), voice_packet.len(), voice_packet[0], raw_target, sender_session);

    // For PTT (target=0), the sender's channel is required by compute_voice_targets.
    let sender_channel = if raw_target == 0 {
        match state.channel_manager.get_remote_user(sender_session).await {
            Some(ru) => ru.channel_id,
            None => {
                debug!("edge={} RelayedVoice PTT: unknown remote session {}",
                    state.get_edge_id(), sender_session);
                return;
            }
        }
    } else {
        0 // unused for whisper (target 1..=30)
    };

    // compute_voice_targets handles VoiceTarget lookup, channel + listener expansion,
    // and deaf filtering — identical logic to the local TCP path.
    // relay_edge_ids is intentionally ignored: the sending edge already handled
    // inter-edge relay for this packet.
    let Some(targets) = crate::routing::compute_voice_targets(
        &voice_packet, sender_session, sender_channel, state, hub_client,
    ).await else {
        debug!("edge={} RelayedVoice: no targets for session {} target {}",
            state.get_edge_id(), sender_session, raw_target);
        return;
    };

    if targets.is_whisper {
        // voice_packet[0] carries raw voice_target_id in low 5 bits;
        // overwrite with AudioContext per Mumble protocol while writing the
        // UdpTunnel frame, avoiding an intermediate voice-packet clone.
        let frame_whisper = wrap_udptunnel_with_context(voice_packet.as_ref(), 2);
        let frame_shout = wrap_udptunnel_with_context(voice_packet.as_ref(), 1);
        let d = deliver_voice_tcp(&targets.direct_sessions, &frame_whisper)
            + deliver_voice_tcp(&targets.channel_sessions, &frame_shout);
        trace!("edge={} Delivered relayed whisper from session {} to {} targets",
            state.get_edge_id(), sender_session, d);
    } else {
        // voice_packet[0] already has context=0 (set by the sending edge for PTT).
        let frame = wrap_udptunnel(voice_packet.as_ref());
        let d = deliver_voice_tcp(&targets.local_sessions, &frame);
        trace!("edge={} Delivered relayed broadcast from session {} to {} local clients",
            state.get_edge_id(), sender_session, d);
    }
}

/// Shared voice packet utilities used by both the TCP (server.rs) and UDP (udp.rs) paths.
///
/// All three functions are on the forwarding hot path, so they are marked `#[inline]`.

/// Build a server-to-client Mumble voice payload.
///
/// Client-to-server format:  `[header(1B)][sequence_varint][audio_data]`
/// Server-to-client format:  `[header(1B)][sender_session_varint][sequence_varint][audio_data]`
///
/// The lower 5 bits of the header byte are replaced with `context`:
///   - `0` = NORMAL (PTT / broadcast)
///   - `1` = SHOUT  (channel whisper target, received as a channel member)
///   - `2` = WHISPER (direct whisper target)
///
/// Pass `payload[0] & 0x1f` as `context` when the original bits must be preserved
/// (e.g., relay payloads forwarded to other edges verbatim).
///
/// Returns `bytes::Bytes` so callers in both TCP and UDP hot paths can share the
/// same allocation without copying (O(1) clone).
#[inline]
pub fn inject_session_into_voice(payload: &[u8], sender_session: u32, context: u8) -> bytes::Bytes {
    use bytes::BytesMut;
    if payload.is_empty() {
        return bytes::Bytes::new();
    }
    // Preserve codec type (high 3 bits), overwrite target/context (low 5 bits).
    let header = (payload[0] & 0xe0) | (context & 0x1f);
    // Worst-case varint length is 5 bytes; over-allocate to avoid realloc.
    let mut result = BytesMut::with_capacity(1 + 5 + payload.len() - 1);
    result.extend_from_slice(&[header]);
    let mut tmp = [0u8; 5];
    let tmp_len = write_mumble_varint_stack(sender_session, &mut tmp);
    result.extend_from_slice(&tmp[..tmp_len]);
    result.extend_from_slice(&payload[1..]);
    result.freeze()
}

/// Wrap a voice payload in a Mumble TCP `UdpTunnel` frame ready for `try_send`.
///
/// Frame layout: `[type:u16 = UdpTunnel][length:u32][payload]`
#[inline]
pub fn wrap_udptunnel(data: &[u8]) -> bytes::Bytes {
    use bytes::BytesMut;
    use munode_protocol::message_type::MessageType;
    let mut buf = BytesMut::with_capacity(6 + data.len());
    bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
    bytes::BufMut::put_u32(&mut buf, data.len() as u32);
    bytes::BufMut::put_slice(&mut buf, data);
    buf.freeze()
}

#[inline]
fn wrap_udptunnel_with_context(data: &[u8], context: u8) -> bytes::Bytes {
    use bytes::BytesMut;
    use munode_protocol::message_type::MessageType;

    if data.is_empty() {
        return bytes::Bytes::new();
    }

    let mut buf = BytesMut::with_capacity(6 + data.len());
    bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
    bytes::BufMut::put_u32(&mut buf, data.len() as u32);
    buf.extend_from_slice(&[((data[0] & 0xe0) | (context & 0x1f))]);
    buf.extend_from_slice(&data[1..]);
    buf.freeze()
}

/// Send `frame` to each session in `sessions` via its hot_slot TCP sender channel.
///
/// Sessions that are inactive or have no sender are silently skipped (voice is
/// best-effort). Returns the number of sessions that had an active sender.
#[inline]
pub fn deliver_voice_tcp(sessions: &[u32], frame: &bytes::Bytes) -> usize {
    let mut count = 0;
    for &target in sessions {
        let slot = crate::hot_slot::get_hot_slot(target);
        if !slot.is_active_for(target) {
            continue;
        }
        let sender_guard = slot.sender.load();
        if let Some(sender) = &**sender_guard {
            sender.try_send(frame.clone()).ok();
            count += 1;
        }
    }
    count
}
