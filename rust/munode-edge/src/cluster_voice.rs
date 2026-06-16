use bytes::{Bytes, BytesMut};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use tracing::{debug, trace, warn};

use munode_protocol::transport::EDGE_MAGIC;

use crate::hub_client::HubClient;
use crate::state::EdgeState;

const EDGE_PKT_VOICE: u8 = 0x01;
const EDGE_PKT_RELAY: u8 = 0x02;
const EDGE_PKT_ENC_VOICE: u8 = 0x11;
const EDGE_PKT_ENC_RELAY: u8 = 0x12;

const LOGICAL_FRAME_EXTENDED: u8 = 0x80;
const LOGICAL_CONTROL_EMERGENCY_FLOOD: u8 = 0x01;
const LOGICAL_CONTROL_HOP_SHIFT: u8 = 4;

static TEST_DROP_COUNTER: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone, Copy)]
struct ParsedLogicalFrame {
    source_edge_id: u32,
    transport_packet_seq: u16,
    control: Option<u8>,
    payload_offset: usize,
}

pub async fn forward_source_voice_packet(
    state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
    sender_session: u32,
    plaintext: &[u8],
    voice_context: u8,
    fallback_target_edges: &[u32],
) {
    let source_edge_id = state.get_edge_id();
    let payload = crate::voice::inject_session_into_voice(plaintext, sender_session, voice_context);
    let Some(frame) =
        encode_base_logical_frame(source_edge_id, state.next_transport_packet_seq(), &payload)
    else {
        return;
    };

    trace!(
        source_edge_id,
        sender_session,
        payload_len = payload.len(),
        "Cluster voice source packet"
    );

    forward_logical_frame(frame, None, state, hub_client, Some(fallback_target_edges)).await;
}

pub async fn handle_incoming_logical_frame(
    frame: Bytes,
    ingress_peer: Option<u32>,
    state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
) {
    let Some(parsed) = parse_logical_frame(frame.as_ref()) else {
        debug!(
            "Cluster voice: invalid logical frame ({} bytes)",
            frame.len()
        );
        return;
    };

    if !state.accept_disseminated_packet(parsed.source_edge_id, parsed.transport_packet_seq) {
        trace!(
            "Cluster voice: dropped duplicate source={} seq={}",
            parsed.source_edge_id, parsed.transport_packet_seq
        );
        return;
    }

    trace!(
        source_edge_id = parsed.source_edge_id,
        seq = parsed.transport_packet_seq,
        ingress_peer = ingress_peer.unwrap_or(0),
        payload_len = frame.len().saturating_sub(parsed.payload_offset),
        "Cluster voice packet accepted"
    );

    if ingress_peer == Some(parsed.source_edge_id) {
        let endpoint = state
            .peer_registry
            .load()
            .get(parsed.source_edge_id)
            .and_then(|info| info.preferred_endpoint().cloned());
        state
            .observe_direct_peer_voice_packet(
                parsed.source_edge_id,
                endpoint.as_ref().map(|endpoint| endpoint.host.as_str()),
                endpoint.as_ref().map(|endpoint| endpoint.udp_addr.port()),
                parsed.transport_packet_seq,
            )
            .await;
    }

    crate::voice::deliver_relayed_voice(frame.slice(parsed.payload_offset..), state, hub_client)
        .await;

    forward_logical_frame(frame, ingress_peer, state, hub_client, None).await;
}

fn encode_base_logical_frame(
    source_edge_id: u32,
    transport_packet_seq: u16,
    payload: &Bytes,
) -> Option<Bytes> {
    if source_edge_id == 0 || source_edge_id > 0x7f {
        return None;
    }

    let mut buf = BytesMut::with_capacity(3 + payload.len());
    buf.extend_from_slice(&[source_edge_id as u8]);
    buf.extend_from_slice(&transport_packet_seq.to_be_bytes());
    buf.extend_from_slice(payload.as_ref());
    Some(buf.freeze())
}

fn encode_extended_logical_frame(
    source_edge_id: u32,
    transport_packet_seq: u16,
    control: u8,
    payload: &Bytes,
) -> Option<Bytes> {
    if source_edge_id == 0 || source_edge_id > 0x7f {
        return None;
    }

    let mut buf = BytesMut::with_capacity(4 + payload.len());
    buf.extend_from_slice(&[(source_edge_id as u8) | LOGICAL_FRAME_EXTENDED]);
    buf.extend_from_slice(&transport_packet_seq.to_be_bytes());
    buf.extend_from_slice(&[control]);
    buf.extend_from_slice(payload.as_ref());
    Some(buf.freeze())
}

fn parse_logical_frame(frame: &[u8]) -> Option<ParsedLogicalFrame> {
    let header = *frame.first()?;
    let extended = (header & LOGICAL_FRAME_EXTENDED) != 0;
    let payload_offset = if extended { 4 } else { 3 };
    if frame.len() <= payload_offset {
        return None;
    }

    Some(ParsedLogicalFrame {
        source_edge_id: (header & !LOGICAL_FRAME_EXTENDED) as u32,
        transport_packet_seq: u16::from_be_bytes([frame[1], frame[2]]),
        control: extended.then_some(frame[3]),
        payload_offset,
    })
}

fn make_emergency_control(hop_budget: u8) -> u8 {
    LOGICAL_CONTROL_EMERGENCY_FLOOD | (hop_budget.min(15) << LOGICAL_CONTROL_HOP_SHIFT)
}

fn control_hop_budget(control: u8) -> u8 {
    control >> LOGICAL_CONTROL_HOP_SHIFT
}

fn should_test_drop(state: &Arc<EdgeState>, next_hop: u32) -> bool {
    if state.test_network_faults.blocks_udp_to(next_hop) {
        return true;
    }

    let drop_rate = state
        .test_udp_drop_rate
        .load(Ordering::Relaxed)
        .max(state.test_network_faults.udp_drop_rate());
    if drop_rate == 0 {
        return false;
    }
    let counter = TEST_DROP_COUNTER.fetch_add(1, Ordering::Relaxed);
    counter % 100 < drop_rate
}

fn build_udp_packet_template(
    frame: &Bytes,
    state: &Arc<EdgeState>,
    extended: bool,
) -> Option<Vec<u8>> {
    let needs_magic_prefix = {
        let edge_socket = state.edge_udp_socket.load();
        let client_socket = state.client_udp_socket.load();
        match (&**edge_socket, &**client_socket) {
            (Some(edge), Some(client)) => edge.local_addr().ok() == client.local_addr().ok(),
            _ => false,
        }
    };

    if let Some(crypto) = &state.edge_crypto {
        let (counter, ciphertext) = crypto.encrypt_owned(frame.to_vec(), state.get_edge_id(), &[]);
        let mut packet = Vec::with_capacity(
            EDGE_MAGIC.len() * usize::from(needs_magic_prefix) + 1 + 8 + ciphertext.len(),
        );
        if needs_magic_prefix {
            packet.extend_from_slice(&EDGE_MAGIC);
        }
        packet.push(if extended {
            EDGE_PKT_ENC_RELAY
        } else {
            EDGE_PKT_ENC_VOICE
        });
        packet.extend_from_slice(&counter.to_be_bytes());
        packet.extend_from_slice(&ciphertext);
        Some(packet)
    } else {
        let mut packet = Vec::with_capacity(
            EDGE_MAGIC.len() * usize::from(needs_magic_prefix) + 1 + frame.len(),
        );
        if needs_magic_prefix {
            packet.extend_from_slice(&EDGE_MAGIC);
        }
        packet.push(if extended {
            EDGE_PKT_RELAY
        } else {
            EDGE_PKT_VOICE
        });
        packet.extend_from_slice(frame.as_ref());
        Some(packet)
    }
}

fn dispatch_udp_batch(state: &Arc<EdgeState>, next_hops: &[u32], frame: &Bytes) -> Vec<u32> {
    let socket_guard = state.edge_udp_socket.load();
    let Some(socket) = &**socket_guard else {
        return next_hops.to_vec();
    };

    let extended = parse_logical_frame(frame.as_ref())
        .and_then(|parsed| parsed.control)
        .is_some();
    let Some(packet_template) = build_udp_packet_template(frame, state, extended) else {
        return next_hops.to_vec();
    };

    let peer_guard = state.peer_registry.load();
    let mut pkts = Vec::new();
    let mut metas = Vec::new();
    let mut unsent = Vec::new();

    for &next_hop in next_hops {
        let Some(addr) = peer_guard.preferred_udp_addr(next_hop) else {
            unsent.push(next_hop);
            continue;
        };

        if should_test_drop(state, next_hop) {
            unsent.push(next_hop);
            continue;
        }

        pkts.push((packet_template.clone(), addr));
        metas.push(next_hop);
    }

    if pkts.is_empty() {
        return unsent;
    }

    #[cfg(target_os = "linux")]
    let sent_count = crate::udp::batch_sendmmsg(socket.as_raw_fd(), &pkts);
    #[cfg(not(target_os = "linux"))]
    let sent_count = crate::udp::batch_sendmmsg_fallback_seq(socket, &pkts);

    for next_hop in metas.into_iter().skip(sent_count) {
        unsent.push(next_hop);
    }

    unsent
}

fn split_locally_failed_next_hops(
    state: &Arc<EdgeState>,
    next_hops: &[u32],
) -> (Vec<u32>, Vec<u32>) {
    let threshold = state.consecutive_failure_threshold;
    if threshold == 0 || next_hops.is_empty() {
        return (next_hops.to_vec(), Vec::new());
    }

    let Ok(failures) = state.next_hop_failures.read() else {
        return (next_hops.to_vec(), Vec::new());
    };

    let mut healthy = Vec::with_capacity(next_hops.len());
    let mut locally_failed = Vec::new();
    for &next_hop in next_hops {
        let failure_count = failures
            .get(&next_hop)
            .map(|counter| counter.load(Ordering::Relaxed))
            .unwrap_or(0);
        if failure_count >= threshold {
            locally_failed.push(next_hop);
        } else {
            healthy.push(next_hop);
        }
    }

    (healthy, locally_failed)
}

fn dispatch_peer_tcp(state: &Arc<EdgeState>, next_hop: u32, frame: &Bytes) -> bool {
    if state.test_network_faults.blocks_voice_tcp_to(next_hop) {
        return false;
    }

    let pools = state.voice_tcp_conns.load();
    let Some(pool) = pools.get(&next_hop) else {
        return false;
    };

    let mut packet = Vec::with_capacity(1 + frame.len());
    packet.push(EDGE_PKT_VOICE);
    packet.extend_from_slice(frame.as_ref());
    pool.try_send(packet)
}

async fn forward_logical_frame(
    frame: Bytes,
    ingress_peer: Option<u32>,
    state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
    fallback_target_edges: Option<&[u32]>,
) {
    let Some(parsed) = parse_logical_frame(frame.as_ref()) else {
        return;
    };

    if let Some(control) = parsed.control
        && control & LOGICAL_CONTROL_EMERGENCY_FLOOD != 0
    {
        forward_emergency_flood(frame, ingress_peer, state, hub_client).await;
        return;
    }

    let hub_escape_targets: Vec<u32> = fallback_target_edges
        .unwrap_or(&[])
        .iter()
        .copied()
        .filter(|edge_id| Some(*edge_id) != ingress_peer)
        .collect();

    let plan = {
        let routes = state.dissemination_routes.load();
        routes.get(&parsed.source_edge_id).cloned()
    };
    let Some(plan) = plan else {
        // No dissemination plan for this source — fall back to Hub relay
        // for every edge that has remote listeners (hub_escape_targets).
        // Track failures here as well: if Hub relay is the only path and
        // it consistently fails, the peer is partitioned.
        if state.hub_tcp_relay_allowed() {
            for target_edge_id in hub_escape_targets {
                if hub_client
                    .relay_voice_via_hub(target_edge_id, frame.clone())
                    .await
                {
                    state.reset_voice_forward_failure(target_edge_id);
                } else if let Some(count) = state.incr_voice_forward_failure(target_edge_id)
                    && count >= crate::state::VOICE_FORWARD_FAILURE_PARTITION_THRESHOLD
                {
                    warn!(
                        target_edge_id,
                        consecutive_failures = count,
                        "All voice forwarding paths failed for peer edge \
                         {target_edge_id} (no dissemination plan) — \
                         triggering partition arbitration"
                    );
                    let _ = state
                        .event_tx
                        .send(crate::state::EdgeEvent::PeerVoiceTcpFailed {
                            peer_edge_id: target_edge_id,
                        });
                }
            }
        }
        return;
    };

    let next_hops: Vec<u32> = plan
        .active_children
        .into_iter()
        .filter(|edge_id| Some(*edge_id) != ingress_peer)
        .collect();
    trace!(
        source_edge_id = parsed.source_edge_id,
        seq = parsed.transport_packet_seq,
        ingress_peer = ingress_peer.unwrap_or(0),
        next_hops = ?next_hops,
        duplicate_children = ?plan.duplicate_children,
        "Cluster voice forward plan"
    );
    if next_hops.is_empty() {
        // Dissemination plan exists but has no active children for this
        // source — fall back to Hub relay via hub_escape_targets.
        if state.hub_tcp_relay_allowed() {
            for target_edge_id in hub_escape_targets {
                if hub_client
                    .relay_voice_via_hub(target_edge_id, frame.clone())
                    .await
                {
                    state.reset_voice_forward_failure(target_edge_id);
                } else if let Some(count) = state.incr_voice_forward_failure(target_edge_id)
                    && count >= crate::state::VOICE_FORWARD_FAILURE_PARTITION_THRESHOLD
                {
                    warn!(
                        target_edge_id,
                        consecutive_failures = count,
                        "All voice forwarding paths failed for peer edge \
                         {target_edge_id} (empty plan) — triggering \
                         partition arbitration"
                    );
                    let _ = state
                        .event_tx
                        .send(crate::state::EdgeEvent::PeerVoiceTcpFailed {
                            peer_edge_id: target_edge_id,
                        });
                }
            }
        }
        return;
    }

    let duplicate_next_hops: Vec<u32> = plan
        .duplicate_children
        .iter()
        .flat_map(|primary_child| {
            plan.branch_backups
                .get(primary_child)
                .into_iter()
                .flat_map(|backups| backups.iter().copied())
        })
        .filter(|edge_id| Some(*edge_id) != ingress_peer)
        .collect();

    let (healthy_next_hops, mut unresolved) = split_locally_failed_next_hops(state, &next_hops);
    unresolved.extend(dispatch_udp_batch(state, &healthy_next_hops, &frame));
    if !duplicate_next_hops.is_empty() {
        let (healthy_duplicate_next_hops, _) =
            split_locally_failed_next_hops(state, &duplicate_next_hops);
        let _ = dispatch_udp_batch(state, &healthy_duplicate_next_hops, &frame);
    }
    let mut need_emergency_flood = false;

    for next_hop in unresolved.drain(..) {
        let backup_dispatched = plan
            .branch_backups
            .get(&next_hop)
            .map(|backups| {
                let backup_next_hops: Vec<u32> = backups
                    .iter()
                    .copied()
                    .filter(|edge_id| Some(*edge_id) != ingress_peer)
                    .collect();
                if backup_next_hops.is_empty() {
                    return false;
                }

                let (healthy_backup_next_hops, mut backup_unresolved) =
                    split_locally_failed_next_hops(state, &backup_next_hops);
                backup_unresolved.extend(dispatch_udp_batch(
                    state,
                    &healthy_backup_next_hops,
                    &frame,
                ));
                backup_unresolved.len() < backup_next_hops.len()
            })
            .unwrap_or(false);
        if backup_dispatched {
            trace!(
                next_hop,
                source_edge_id = parsed.source_edge_id,
                seq = parsed.transport_packet_seq,
                "Cluster voice branch backup dispatched"
            );
        }

        // Branch backups are only best-effort alternate next hops. The media
        // packet does not carry per-branch destination metadata, so a backup
        // send cannot prove the original primary child edge itself will still
        // receive the frame. Keep the failed primary child on the reliable
        // fallback ladder (peer TCP -> Hub relay -> emergency flood).

        let peer_tcp_ok = dispatch_peer_tcp(state, next_hop, &frame);
        let hub_relay_ok = if !peer_tcp_ok && state.hub_tcp_relay_allowed() {
            hub_client
                .relay_voice_via_hub(next_hop, frame.clone())
                .await
        } else {
            false
        };

        if peer_tcp_ok || hub_relay_ok {
            // At least one path reached the peer — reset the all-methods failure
            // counter so that a transient blip does not trigger partition.
            state.reset_voice_forward_failure(next_hop);
            continue;
        }

        // Neither peer TCP nor Hub relay succeeded for this next_hop.
        // Track the failure so the system can detect a true partition when
        // every available forwarding path is consistently down.
        if let Some(count) = state.incr_voice_forward_failure(next_hop)
            && count >= crate::state::VOICE_FORWARD_FAILURE_PARTITION_THRESHOLD
        {
            warn!(
                next_hop,
                consecutive_failures = count,
                "All voice forwarding paths (UDP, peer TCP, Hub relay) failed \
                 for peer edge {next_hop} — threshold exceeded, triggering \
                 partition arbitration"
            );
            let _ = state
                .event_tx
                .send(crate::state::EdgeEvent::PeerVoiceTcpFailed {
                    peer_edge_id: next_hop,
                });
        }

        if !state.hub_tcp_relay_allowed() {
            need_emergency_flood = true;
        }
    }

    if need_emergency_flood {
        let hop_budget = state.max_ttl.load(Ordering::Relaxed).min(15) as u8;
        if hop_budget > 0 {
            let payload = frame.slice(parsed.payload_offset..);
            if let Some(flood_frame) = encode_extended_logical_frame(
                parsed.source_edge_id,
                parsed.transport_packet_seq,
                make_emergency_control(hop_budget),
                &payload,
            ) {
                forward_emergency_flood(flood_frame, ingress_peer, state, hub_client).await;
            }
        }
    }
}

async fn forward_emergency_flood(
    frame: Bytes,
    ingress_peer: Option<u32>,
    state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
) {
    let Some(parsed) = parse_logical_frame(frame.as_ref()) else {
        return;
    };
    let Some(control) = parsed.control else {
        return;
    };

    let current_budget = control_hop_budget(control);
    if current_budget == 0 {
        return;
    }

    let next_budget = current_budget.saturating_sub(1);
    if next_budget == 0 {
        return;
    }

    let payload = frame.slice(parsed.payload_offset..);
    let Some(flood_frame) = encode_extended_logical_frame(
        parsed.source_edge_id,
        parsed.transport_packet_seq,
        make_emergency_control(next_budget),
        &payload,
    ) else {
        return;
    };

    let next_hops: Vec<u32> = state
        .peer_registry
        .load()
        .all_udp_peers()
        .into_iter()
        .map(|(edge_id, _)| edge_id)
        .filter(|edge_id| Some(*edge_id) != ingress_peer)
        .collect();
    if next_hops.is_empty() {
        return;
    }

    let (healthy_next_hops, mut unresolved) = split_locally_failed_next_hops(state, &next_hops);
    unresolved.extend(dispatch_udp_batch(state, &healthy_next_hops, &flood_frame));

    for next_hop in unresolved {
        if dispatch_peer_tcp(state, next_hop, &flood_frame) {
            continue;
        }
        if state.hub_tcp_relay_allowed() {
            let _ = hub_client
                .relay_voice_via_hub(next_hop, flood_frame.clone())
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        control_hop_budget, encode_base_logical_frame, encode_extended_logical_frame,
        make_emergency_control, parse_logical_frame, split_locally_failed_next_hops,
    };
    use bytes::Bytes;
    use std::sync::atomic::{AtomicU32, Ordering};

    use crate::{channel_manager::ChannelManager, client::ClientManager, state::EdgeState};

    #[test]
    fn logical_voice_frame_roundtrips() {
        let payload = Bytes::from_static(&[0x84, 0x01, 0x02, 0x03]);

        let base = encode_base_logical_frame(7, 0x1234, &payload).unwrap();
        let parsed_base = parse_logical_frame(base.as_ref()).unwrap();
        assert_eq!(parsed_base.source_edge_id, 7);
        assert_eq!(parsed_base.transport_packet_seq, 0x1234);
        assert_eq!(parsed_base.control, None);
        assert_eq!(&base[parsed_base.payload_offset..], payload.as_ref());

        let control = make_emergency_control(5);
        let extended = encode_extended_logical_frame(7, 0x4321, control, &payload).unwrap();
        let parsed_extended = parse_logical_frame(extended.as_ref()).unwrap();
        assert_eq!(parsed_extended.source_edge_id, 7);
        assert_eq!(parsed_extended.transport_packet_seq, 0x4321);
        assert_eq!(parsed_extended.control, Some(control));
        assert_eq!(control_hop_budget(parsed_extended.control.unwrap()), 5);
        assert_eq!(
            &extended[parsed_extended.payload_offset..],
            payload.as_ref()
        );
    }

    #[test]
    fn prefilters_locally_failed_next_hops() {
        let state = EdgeState::new(ChannelManager::new(), ClientManager::new(), true);
        {
            let mut failures = state.next_hop_failures.write().unwrap();
            failures.insert(7, AtomicU32::new(state.consecutive_failure_threshold));
            failures.insert(
                9,
                AtomicU32::new(state.consecutive_failure_threshold.saturating_sub(1)),
            );
        }

        let (healthy, failed) = split_locally_failed_next_hops(&state, &[5, 7, 9]);

        assert_eq!(healthy, vec![5, 9]);
        assert_eq!(failed, vec![7]);
        assert_eq!(
            state
                .next_hop_failures
                .read()
                .unwrap()
                .get(&7)
                .map(|counter| counter.load(Ordering::Relaxed)),
            Some(state.consecutive_failure_threshold)
        );
    }
}
