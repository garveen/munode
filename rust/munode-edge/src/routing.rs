//! Shared voice packet routing: local target selection.
//!
//! Both the UDP path (`udp.rs`) and the TCP-tunnel path (`server.rs`) call
//! [`compute_voice_targets`] to determine which local sessions and remote
//! edges should receive a voice packet.  Transport-specific concerns — OCB2
//! encryption and UDP socket writes (UDP path) or UdpTunnel framing and
//! mpsc sends (TCP path) — remain in the respective modules.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{atomic::Ordering, Arc};
use smallvec::SmallVec;
use crate::hub_client::HubClient;
use crate::hot_slot::{BroadcastCache, get_hot_slot};

/// Which local sessions and remote edges should receive a voice packet.
///
/// Populated by [`compute_voice_targets`]; consumed by the transport layer.
pub struct VoiceTargets {
    /// Sessions targeted directly (WHISPER context, byte = 2).
    /// Populated only in whisper mode.
    pub direct_sessions: SmallVec<[u32; 8]>,
    /// Sessions targeted via channel expansion (SHOUT context, byte = 1).
    /// Populated only in whisper mode.
    pub channel_sessions: SmallVec<[u32; 16]>,
    /// Sessions targeted in normal broadcast mode (context byte = 0).
    /// Populated only in broadcast mode.
    pub local_sessions: SmallVec<[u32; 32]>,
    /// Remote edge IDs that need a relay copy of this packet.
    pub relay_edge_ids: SmallVec<[u32; 8]>,
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
    hub_client: &HubClient,
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
    let current_version = edge_state.topology_version.load(Ordering::Acquire);

    if voice_target >= 1 && voice_target <= 30 {
        // ── Whisper / shout targeting ────────────────────────────────────────
        if let Some(cached) = edge_state.get_cached_whisper_route(
            sender_session,
            voice_target,
            current_version,
        ) {
            return Some(VoiceTargets {
                direct_sessions: cached.direct_sessions,
                channel_sessions: cached.channel_sessions,
                local_sessions: SmallVec::new(),
                relay_edge_ids: cached.relay_edge_ids,
                is_whisper: true,
            });
        }

        let vt_config: Option<Arc<crate::hot_slot::HotVoiceTarget>> = {
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
                    .map(|vt| std::sync::Arc::new(crate::hot_slot::HotVoiceTarget {
                        sessions: vt.sessions.clone(),
                        resolved_channels: vt.resolved_channels.clone(),
                    }))
            }
        };

        let vt = vt_config?;

        let direct_set: HashSet<u32> = vt.sessions.iter().copied().collect();
        let mut whisper_perm_cache: HashMap<u32, bool> = HashMap::new();

        async fn can_whisper_to_channel(
            hub_client: &HubClient,
            edge_state: &crate::state::EdgeState,
            sender_session: u32,
            channel_id: u32,
            local_cache: &mut HashMap<u32, bool>,
        ) -> bool {
            if let Some(&allowed) = local_cache.get(&channel_id) {
                return allowed;
            }

            let allowed = crate::server::connection::get_perm_cached(
                hub_client,
                edge_state,
                sender_session,
                channel_id,
                false,
            )
            .await
                & munode_common::permission::WHISPER
                != 0;
            local_cache.insert(channel_id, allowed);
            allowed
        }

        // Deaf-filter direct session targets.
        let mut direct_sessions: SmallVec<[u32; 8]> = SmallVec::new();
        for &target in &direct_set {
            if target == sender_session {
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

            let target_channel = slot.channel_id.load(std::sync::atomic::Ordering::Relaxed);
            if !can_whisper_to_channel(
                hub_client,
                edge_state,
                sender_session,
                target_channel,
                &mut whisper_perm_cache,
            )
            .await
            {
                continue;
            }

            direct_sessions.push(target);
        }

        // Expand channel targets (with optional group filter) and deaf-filter.
        // Includes both channel members AND sessions listening to the channel —
        // a listener of channel X must hear whatever a member of X would hear.
        let mut channel_sessions: SmallVec<[u32; 16]> = SmallVec::new();
        let mut seen_channel_targets: HashSet<u32> = HashSet::new();
        for (&ch_id, group_filter) in &vt.resolved_channels {
            if !can_whisper_to_channel(
                hub_client,
                edge_state,
                sender_session,
                ch_id,
                &mut whisper_perm_cache,
            )
            .await
            {
                continue;
            }
            let ch_members = edge_state.client_manager.get_channel_sessions(ch_id).await;
            let ch_listeners = edge_state.client_manager.get_listening_sessions(ch_id).await;
            for target in ch_members.into_iter().chain(ch_listeners.into_iter()) {
                if target == sender_session || direct_set.contains(&target) {
                    continue;
                }
                if !seen_channel_targets.insert(target) {
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
                    let slot = crate::hot_slot::get_hot_slot(target);
                    let grps = slot.groups.load();
                    let in_group = (**grps).iter().any(|g| groups.contains(g));
                    if !in_group {
                        continue;
                    }
                }
                channel_sessions.push(target);
            }
        }

        // Relay whisper to every peer edge — each receiving edge applies its
        // own local VoiceTarget cache to decide which of its users hears it.
        let relay_edge_ids: SmallVec<[u32; 8]> = edge_state
            .peer_registry
            .load()
            .udp_peer_ids_except(my_edge_id);

        edge_state.store_cached_whisper_route(
            sender_session,
            voice_target,
            current_version,
            crate::state::WhisperRouteCacheEntry {
                direct_sessions: direct_sessions.clone(),
                channel_sessions: channel_sessions.clone(),
                relay_edge_ids: relay_edge_ids.clone(),
            },
        );

        Some(VoiceTargets {
            direct_sessions,
            channel_sessions,
            local_sessions: SmallVec::new(),
            relay_edge_ids,
            is_whisper: true,
        })
    } else {
        // ── Normal broadcast (voice_target == 0) ─────────────────────────────
        // Check per-sender BroadcastCache for a version match.
        //
        // HotSlot is indexed by `sender_session % HOT_SLOT_COUNT`.  Local session IDs
        // follow the pattern `edge_id × 10_000 + local_seq`, so within a single Edge
        // process the index is always unique.  However, relayed voice packets carry a
        // *remote* Edge's session ID, whose modulo collides with a local session that
        // happens to share the same `local_seq`.  We guard every cache read *and* write
        // with `is_active_for(sender_session)` to prevent:
        //   • reading a different session's stale cache on a collision, and
        //   • overwriting a different session's valid cache on a write.
        // Remote-sender packets always miss the cache and compute fresh — acceptable
        // because relayed packets are far less frequent than local-sender packets.
        let cache_hit: Option<Arc<BroadcastCache>> = {
            let slot = get_hot_slot(sender_session);
            if slot.is_active_for(sender_session)
                && slot.broadcast_cache_version.load(Ordering::Acquire) == current_version
            {
                let guard = slot.broadcast_cache.load();
                (**guard).clone()
            } else {
                None
            }
        };

        let (raw_sessions, relay_edge_ids): (Cow<'_, [u32]>, SmallVec<[u32; 8]>) = if let Some(ref c) = cache_hit {
            // Cache hit: borrow the cached session slice directly to avoid a per-packet Vec clone.
            (Cow::Borrowed(c.local_sessions.as_slice()), c.relay_edge_ids.clone())
        } else {
            // Cache miss: full computation.
            let linked_channels = edge_state
                .channel_manager
                .get_all_linked_channels(sender_channel)
                .await;

            let sessions = edge_state
                .client_manager
                .get_channel_session_ids_with_listeners_in_set(&linked_channels, sender_session)
                .await;

            let remote_users = edge_state
                .channel_manager
                .get_remote_users_in_channels(&linked_channels)
                .await;

            let relay_ids: SmallVec<[u32; 8]> = {
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

            // Atomically write cache before returning — only when the slot actually
            // belongs to sender_session (i.e. this is a local sender, not a relayed
            // packet whose session ID collides with a local session).
            let slot = get_hot_slot(sender_session);
            if slot.is_active_for(sender_session) {
                slot.broadcast_cache.store(Arc::new(Some(Arc::new(BroadcastCache {
                    local_sessions: SmallVec::from_iter(sessions.iter().copied()),
                    relay_edge_ids: relay_ids.clone(),
                }))));
                slot.broadcast_cache_version.store(current_version, Ordering::Release);
            }

            (Cow::Owned(sessions), relay_ids)
        };

        // Deaf-filter runs on every packet (HotSlot reads are lock-free atomics).
        let local_sessions: SmallVec<[u32; 32]> = raw_sessions
            .iter()
            .copied()
            .filter(|&t| {
                let slot = get_hot_slot(t);
                if !slot.is_active_for(t) {
                    return false;
                }
                if slot.deaf.load(Ordering::Relaxed) || slot.self_deaf.load(Ordering::Relaxed) {
                    return false;
                }
                true
            })
            .collect();

        // Plugin context filter: if the sender has a non-empty plugin_context,
        // only route to sessions with the same context.  This implements
        // Murmur's positional audio isolation (game plugin context segregation).
        let local_sessions: SmallVec<[u32; 32]> = {
            let sender_ctx = {
                let slot = get_hot_slot(sender_session);
                if slot.is_active_for(sender_session) {
                    slot.plugin_context.load_full()
                } else {
                    Arc::new(edge_state.client_manager.get_plugin_context(sender_session).await)
                }
            };
            if sender_ctx.is_empty() {
                // Sender has no context — no filtering needed.
                local_sessions
            } else {
                // Filter recipients to those sharing the same plugin_context.
                let mut filtered: SmallVec<[u32; 32]> = SmallVec::new();
                for sid in local_sessions {
                    let slot = get_hot_slot(sid);
                    let ctx = slot.plugin_context.load();
                    if ctx.as_slice() == sender_ctx.as_slice() {
                        filtered.push(sid);
                    }
                }
                filtered
            }
        };

        Some(VoiceTargets {
            direct_sessions: SmallVec::new(),
            channel_sessions: SmallVec::new(),
            local_sessions,
            relay_edge_ids,
            is_whisper: false,
        })
    }
}
