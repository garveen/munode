//! Shared voice packet utilities used by both the TCP (server.rs) and UDP (udp.rs) paths.

use crate::hub_client::HubClient;
use crate::state::EdgeState;
use dashmap::DashMap;
use smallvec::SmallVec;
use std::net::SocketAddr;
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::sync::Arc;
use tokio::net::UdpSocket;
use tracing::{debug, trace};

pub const AUDIO_CONTEXT_NORMAL: u8 = 0;
pub const AUDIO_CONTEXT_SHOUT: u8 = 1;
pub const AUDIO_CONTEXT_WHISPER: u8 = 2;

pub struct LocalDeliveryGroup<'a> {
    pub sessions: &'a [u32],
    pub context: u8,
}

pub fn local_delivery_groups<'a>(
    targets: &'a crate::routing::VoiceTargets,
) -> SmallVec<[LocalDeliveryGroup<'a>; 2]> {
    let mut groups = SmallVec::new();

    if targets.is_whisper {
        if !targets.direct_sessions.is_empty() {
            groups.push(LocalDeliveryGroup {
                sessions: targets.direct_sessions.as_slice(),
                context: AUDIO_CONTEXT_WHISPER,
            });
        }

        if !targets.channel_sessions.is_empty() {
            groups.push(LocalDeliveryGroup {
                sessions: targets.channel_sessions.as_slice(),
                context: AUDIO_CONTEXT_SHOUT,
            });
        }
    } else if !targets.local_sessions.is_empty() {
        groups.push(LocalDeliveryGroup {
            sessions: targets.local_sessions.as_slice(),
            context: AUDIO_CONTEXT_NORMAL,
        });
    }

    groups
}

#[inline]
fn rewrite_voice_context(data: &[u8], context: u8) -> bytes::Bytes {
    use bytes::BytesMut;

    if data.is_empty() {
        return bytes::Bytes::new();
    }

    let mut buf = BytesMut::with_capacity(data.len());
    buf.extend_from_slice(&[((data[0] & 0xe0) | (context & 0x1f))]);
    buf.extend_from_slice(&data[1..]);
    buf.freeze()
}

#[inline]
pub fn deliver_voice_locally_prefer_udp(
    sessions: &[u32],
    payload: &bytes::Bytes,
    udp_socket: Option<&Arc<UdpSocket>>,
    session_to_addr: &DashMap<u32, SocketAddr>,
) -> usize {
    let mut delivered = 0;
    let mut tcp_targets: SmallVec<[u32; 8]> = SmallVec::new();

    if let Some(socket) = udp_socket {
        let mut client_batch: Vec<(Vec<u8>, SocketAddr)> = Vec::with_capacity(sessions.len());

        for &target in sessions {
            let Some(addr) = session_to_addr.get(&target).map(|entry| *entry.value()) else {
                tcp_targets.push(target);
                continue;
            };

            match crate::udp::encrypt_voice_for_addr(target, addr, payload.as_ref()) {
                Some(packet) => client_batch.push(packet),
                None => tcp_targets.push(target),
            }
        }

        if !client_batch.is_empty() {
            let sent = {
                #[cfg(target_os = "linux")]
                {
                    crate::udp::batch_sendmmsg(socket.as_raw_fd(), &client_batch)
                }
                #[cfg(not(target_os = "linux"))]
                {
                    crate::udp::batch_sendmmsg_fallback_seq(socket, &client_batch)
                }
            };

            if sent < client_batch.len() {
                debug!(
                    "sendmmsg partial: sent {}/{} UDP packets to local sessions",
                    sent,
                    client_batch.len()
                );
            }

            delivered += sent;
        }
    } else {
        tcp_targets.extend_from_slice(sessions);
    }

    if !tcp_targets.is_empty() {
        let frame = wrap_udptunnel(payload.as_ref());
        delivered += deliver_voice_tcp(&tcp_targets, &frame);
    }

    delivered
}

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
    if v & 0x80 == 0 {
        return Some((v as u32, 1));
    }
    if v & 0xC0 == 0x80 {
        if data.len() < 2 {
            return None;
        }
        return Some((((v & 0x3F) as u32) << 8 | data[1] as u32, 2));
    }
    if v & 0xE0 == 0xC0 {
        if data.len() < 3 {
            return None;
        }
        return Some((
            ((v & 0x1F) as u32) << 16 | (data[1] as u32) << 8 | data[2] as u32,
            3,
        ));
    }
    if v & 0xF0 == 0xE0 {
        if data.len() < 4 {
            return None;
        }
        return Some((
            ((v & 0x0F) as u32) << 24
                | (data[1] as u32) << 16
                | (data[2] as u32) << 8
                | data[3] as u32,
            4,
        ));
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

    trace!(
        "edge={} RelayedVoice recv: len={} header=0x{:02X} target={} session={}",
        state.get_edge_id(),
        voice_packet.len(),
        voice_packet[0],
        raw_target,
        sender_session
    );

    // For PTT (target=0), the sender's channel is required by compute_voice_targets.
    let sender_channel = if raw_target == 0 {
        match state.channel_manager.get_remote_user(sender_session).await {
            Some(ru) => ru.channel_id,
            None => {
                debug!(
                    "edge={} RelayedVoice PTT: unknown remote session {}",
                    state.get_edge_id(),
                    sender_session
                );
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
        &voice_packet,
        sender_session,
        sender_channel,
        state,
        hub_client,
    )
    .await
    else {
        debug!(
            "edge={} RelayedVoice: no targets for session {} target {}",
            state.get_edge_id(),
            sender_session,
            raw_target
        );
        return;
    };

    let client_udp_socket = {
        let socket_guard = state.client_udp_socket.load();
        match &**socket_guard {
            Some(socket) => Some(Arc::clone(socket)),
            None => None,
        }
    };

    let mut delivered = 0;
    for group in local_delivery_groups(&targets) {
        let payload = if group.context == AUDIO_CONTEXT_NORMAL {
            // Relay payloads already preserve the original regular-speech context.
            voice_packet.clone()
        } else {
            // Relayed whisper payloads preserve the original target slot; rewrite to
            // receiver-facing AudioContext before local delivery.
            rewrite_voice_context(voice_packet.as_ref(), group.context)
        };
        delivered += deliver_voice_locally_prefer_udp(
            group.sessions,
            &payload,
            client_udp_socket.as_ref(),
            state.udp_session_to_addr.as_ref(),
        );
    }

    if targets.is_whisper {
        trace!(
            "edge={} Delivered relayed whisper from session {} to {} targets",
            state.get_edge_id(),
            sender_session,
            delivered
        );
    } else {
        trace!(
            "edge={} Delivered relayed broadcast from session {} to {} local clients",
            state.get_edge_id(),
            sender_session,
            delivered
        );
    }
}

/// Shared voice packet utilities used by both the TCP (server.rs) and UDP (udp.rs) paths.
///
/// All three functions are on the forwarding hot path, so they are marked `#[inline]`.
///
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
        if let Some(sender) = &**sender_guard
            && sender.try_send(frame.clone()).is_ok()
        {
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::deliver_voice_locally_prefer_udp;
    use crate::client::{ClientInfo, ClientManager, ClientState};
    use crate::crypto::CryptState;
    use dashmap::DashMap;
    use munode_protocol::message_type::MessageType;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::net::UdpSocket;
    use tokio::time::{Duration, timeout};

    fn ready_client(session: u32) -> ClientInfo {
        ClientInfo {
            session,
            user_id: session,
            username: format!("user-{session}"),
            channel_id: 1,
            state: ClientState::Ready,
            mute: false,
            deaf: false,
            suppress: false,
            self_mute: false,
            self_deaf: false,
            priority_speaker: false,
            recording: false,
            ip_address: "127.0.0.1".to_string(),
            connected_at: std::time::Instant::now(),
            last_active: std::time::Instant::now(),
            cert_hash: None,
            groups: Vec::new(),
            opus_supported: true,
            listening_channels: Vec::new(),
            listening_volume_adjustments: HashMap::new(),
            texture_hash: None,
            comment_hash: None,
            client_version: None,
            client_release: String::new(),
            client_os: String::new(),
            client_os_version: String::new(),
            plugin_context: Vec::new(),
            client_cert_chain: Vec::new(),
        }
    }

    #[tokio::test]
    async fn deliver_voice_locally_prefer_udp_uses_udp_when_mapping_exists() {
        let session = 90_001;
        let client_manager = ClientManager::new();
        let (sender, _control_rx, mut voice_rx) = crate::client::test_client_sender();

        client_manager
            .add_client(ready_client(session), sender)
            .await;

        let mut crypt = CryptState::new();
        crypt.set_key(&[1u8; 16], &[2u8; 16], &[3u8; 16]);
        client_manager.set_crypt_state(session, crypt).await;

        let send_socket = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let recv_socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();

        let session_to_addr: DashMap<u32, std::net::SocketAddr> = DashMap::new();
        session_to_addr.insert(session, recv_socket.local_addr().unwrap());

        let payload = bytes::Bytes::from_static(&[0x80, 0x01, 0x02, 0x03]);
        let delivered = deliver_voice_locally_prefer_udp(
            &[session],
            &payload,
            Some(&send_socket),
            &session_to_addr,
        );

        assert_eq!(delivered, 1);

        let mut buf = [0u8; 64];
        let (len, from_addr) = timeout(Duration::from_millis(200), recv_socket.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert!(len > 0);
        assert_eq!(from_addr, send_socket.local_addr().unwrap());
        assert!(voice_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn deliver_voice_locally_prefer_udp_falls_back_to_tcp_without_mapping() {
        let session = 90_002;
        let client_manager = ClientManager::new();
        let (sender, _control_rx, mut voice_rx) = crate::client::test_client_sender();

        client_manager
            .add_client(ready_client(session), sender)
            .await;

        let session_to_addr: DashMap<u32, std::net::SocketAddr> = DashMap::new();
        let payload = bytes::Bytes::from_static(&[0x80, 0x05, 0x06]);
        let delivered =
            deliver_voice_locally_prefer_udp(&[session], &payload, None, &session_to_addr);

        assert_eq!(delivered, 1);

        let frame = timeout(Duration::from_millis(200), voice_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&frame[..2], &(MessageType::UdpTunnel as u16).to_be_bytes());
        assert_eq!(
            u32::from_be_bytes([frame[2], frame[3], frame[4], frame[5]]) as usize,
            payload.len()
        );
        assert_eq!(&frame[6..], payload.as_ref());
    }
}
