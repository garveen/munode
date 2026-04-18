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
    let mut tmp = Vec::with_capacity(5);
    crate::udp::write_mumble_varint(sender_session, &mut tmp);
    result.extend_from_slice(&tmp);
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
