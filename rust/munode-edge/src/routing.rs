//! Shared voice packet routing: local target selection.
//!
//! Both the UDP path (`udp.rs`) and the TCP-tunnel path (`server.rs`) call
//! [`compute_voice_targets`] to determine which local sessions and remote
//! edges should receive a voice packet.  Transport-specific concerns — OCB2
//! encryption and UDP socket writes (UDP path) or UdpTunnel framing and
//! mpsc sends (TCP path) — remain in the respective modules.

use std::collections::HashSet;

/// Which local sessions and remote edges should receive a voice packet.
///
/// Populated by [`compute_voice_targets`]; consumed by the transport layer.
pub struct VoiceTargets {
    /// Sessions targeted directly (WHISPER context, byte = 2).
    /// Populated only in whisper mode.
    pub direct_sessions: Vec<u32>,
    /// Sessions targeted via channel expansion (SHOUT context, byte = 1).
    /// Populated only in whisper mode.
    pub channel_sessions: Vec<u32>,
    /// Sessions targeted in normal broadcast mode (context byte = 0).
    /// Populated only in broadcast mode.
    pub local_sessions: Vec<u32>,
    /// Remote edge IDs that need a relay copy of this packet.
    pub relay_edge_ids: Vec<u32>,
    /// `true` = whisper/shout targeting; `false` = normal broadcast.
    pub is_whisper: bool,
}

/// Compute the target set for a voice packet.
///
/// Returns `None` when the packet should be silently dropped:
/// - `voice_target == 31` (loopback — handled by caller)
/// - Whisper mode but no VoiceTarget config is registered for this target ID
///
/// **What callers must handle themselves:**
/// - Codec filtering (CELT/Speex rejection)
/// - Suppress check (suppressed sessions must not send)
/// - Loopback delivery (voice_target == 31)
pub async fn compute_voice_targets(
    voice_packet: &[u8],
    sender_session: u32,
    sender_channel: u32,
    edge_state: &crate::state::EdgeState,
) -> Option<VoiceTargets> {
    if voice_packet.is_empty() {
        return None;
    }
    let voice_target = (voice_packet[0] & 0x1F) as u32;

    if voice_target == 31 {
        // Loopback: caller handles this.
        return None;
    }

    let my_edge_id = edge_state.get_edge_id();

    if voice_target >= 1 && voice_target <= 30 {
        // ── Whisper / shout targeting ────────────────────────────────────────
        let vt_config: Option<crate::hot_slot::HotVoiceTarget> = {
            let slot = crate::hot_slot::get_hot_slot(sender_session);
            if slot.is_active_for(sender_session) {
                let vt_guard = slot.voice_targets.load();
                if let Some(map) = &**vt_guard {
                    map.get(&voice_target).cloned()
                } else {
                    None
                }
            } else {
                // HotSlot not yet initialised — fall back to the EdgeState cache.
                let cache = edge_state.voice_targets.read().await;
                cache
                    .get(&sender_session)
                    .and_then(|m| m.get(&voice_target))
                    .map(|vt| crate::hot_slot::HotVoiceTarget {
                        sessions: vt.sessions.clone(),
                        resolved_channels: vt.resolved_channels.clone(),
                    })
            }
        };

        let vt = vt_config?;

        let direct_set: HashSet<u32> = vt.sessions.iter().copied().collect();

        // Deaf-filter direct session targets.
        let direct_sessions: Vec<u32> = direct_set
            .iter()
            .filter(|&&t| {
                if t == sender_session {
                    return false;
                }
                let slot = crate::hot_slot::get_hot_slot(t);
                if !slot.is_active_for(t) {
                    return false;
                }
                if slot.deaf.load(std::sync::atomic::Ordering::Relaxed)
                    || slot.self_deaf.load(std::sync::atomic::Ordering::Relaxed)
                {
                    return false;
                }
                true
            })
            .copied()
            .collect();

        // Expand channel targets (with optional group filter) and deaf-filter.
        let mut channel_sessions: Vec<u32> = Vec::new();
        for (&ch_id, group_filter) in &vt.resolved_channels {
            let ch_members = edge_state.client_manager.get_channel_sessions(ch_id).await;
            for target in ch_members {
                if target == sender_session || direct_set.contains(&target) {
                    continue;
                }
                let slot = crate::hot_slot::get_hot_slot(target);
                if !slot.is_active_for(target) {
                    continue;
                }
                if slot.deaf.load(std::sync::atomic::Ordering::Relaxed)
                    || slot.self_deaf.load(std::sync::atomic::Ordering::Relaxed)
                {
                    continue;
                }
                if let Some(groups) = group_filter {
                    let in_group = edge_state
                        .client_manager
                        .get_client(target)
                        .await
                        .map(|c| c.groups.iter().any(|g| groups.contains(g)))
                        .unwrap_or(false);
                    if !in_group {
                        continue;
                    }
                }
                channel_sessions.push(target);
            }
        }

        // Relay whisper to every remote edge — each receiving edge applies its
        // own local VoiceTarget cache to decide which of its users hears it.
        let all_remote = edge_state.channel_manager.get_all_remote_users().await;
        let relay_edge_ids: Vec<u32> = {
            let mut seen = HashSet::new();
            all_remote
                .iter()
                .filter(|ru| ru.edge_id != 0 && ru.edge_id != my_edge_id)
                .filter_map(|ru| seen.insert(ru.edge_id).then_some(ru.edge_id))
                .collect()
        };

        Some(VoiceTargets {
            direct_sessions,
            channel_sessions,
            local_sessions: vec![],
            relay_edge_ids,
            is_whisper: true,
        })
    } else {
        // ── Normal broadcast (voice_target == 0) ─────────────────────────────
        let linked_channels: Vec<u32> = edge_state
            .channel_manager
            .get_all_linked_channels(sender_channel)
            .await
            .into_iter()
            .collect();

        let target_sessions = edge_state
            .client_manager
            .get_channel_session_ids_with_listeners(&linked_channels, sender_session)
            .await;

        // Deaf-filter.
        let local_sessions: Vec<u32> = target_sessions
            .into_iter()
            .filter(|&t| {
                let slot = crate::hot_slot::get_hot_slot(t);
                if !slot.is_active_for(t) {
                    return false;
                }
                if slot.deaf.load(std::sync::atomic::Ordering::Relaxed)
                    || slot.self_deaf.load(std::sync::atomic::Ordering::Relaxed)
                {
                    return false;
                }
                true
            })
            .collect();

        // Only relay to edges that have at least one non-deaf user in a linked channel.
        let linked_set: HashSet<u32> = linked_channels.iter().copied().collect();
        let remote_users = edge_state
            .channel_manager
            .get_remote_users_in_channels(&linked_set)
            .await;

        let relay_edge_ids: Vec<u32> = {
            let mut seen = HashSet::new();
            remote_users
                .iter()
                .filter(|ru| {
                    !ru.deaf
                        && !ru.self_deaf
                        && ru.edge_id != 0
                        && ru.edge_id != my_edge_id
                })
                .filter_map(|ru| seen.insert(ru.edge_id).then_some(ru.edge_id))
                .collect()
        };

        Some(VoiceTargets {
            direct_sessions: vec![],
            channel_sessions: vec![],
            local_sessions,
            relay_edge_ids,
            is_whisper: false,
        })
    }
}
