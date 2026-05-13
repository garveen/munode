//! Shared voice packet routing: local target selection.
//!
//! Both the UDP path (`udp.rs`) and the TCP-tunnel path (`server.rs`) call
//! [`compute_voice_targets`] to determine which local sessions and remote
//! edges should receive a voice packet.  Transport-specific concerns — OCB2
//! encryption and UDP socket writes (UDP path) or UdpTunnel framing and
//! mpsc sends (TCP path) — remain in the respective modules.

use crate::hot_slot::{BroadcastCache, get_hot_slot};
use crate::hub_client::HubClient;
use smallvec::SmallVec;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, atomic::Ordering};

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
        if let Some(cached) =
            edge_state.get_cached_whisper_route(sender_session, voice_target, current_version)
        {
            return Some(VoiceTargets {
                direct_sessions: cached.direct_sessions,
                channel_sessions: cached.channel_sessions,
                local_sessions: SmallVec::new(),
                relay_edge_ids: cached.relay_edge_ids,
                is_whisper: true,
            });
        }

        let vt_config =
            crate::voice_target::get_routing_voice_target(edge_state, sender_session, voice_target)
                .await;

        let vt = vt_config?;

        let direct_set: HashSet<u32> = vt.sessions.iter().copied().collect();
        #[derive(Clone, Copy)]
        struct WhisperPermissionCheck {
            allowed: bool,
            authoritative: bool,
        }

        let mut whisper_perm_cache: HashMap<u32, WhisperPermissionCheck> = HashMap::new();
        let mut cacheable_route = true;

        async fn can_whisper_to_channel(
            hub_client: &HubClient,
            edge_state: &crate::state::EdgeState,
            sender_session: u32,
            channel_id: u32,
            local_cache: &mut HashMap<u32, WhisperPermissionCheck>,
        ) -> WhisperPermissionCheck {
            if let Some(&cached) = local_cache.get(&channel_id) {
                return cached;
            }

            let outcome = crate::server::connection::get_perm_cached_outcome(
                hub_client,
                edge_state,
                sender_session,
                channel_id,
                false,
            )
            .await;
            let check = WhisperPermissionCheck {
                allowed: outcome.permissions & munode_common::permission::WHISPER != 0,
                authoritative: outcome.authoritative,
            };
            local_cache.insert(channel_id, check);
            check
        }

        let mut relay_edge_set: HashSet<u32> = HashSet::new();

        // Deaf-filter direct session targets.
        let mut direct_sessions: SmallVec<[u32; 8]> = SmallVec::new();
        for &target in &direct_set {
            if target == sender_session {
                continue;
            }
            let slot = crate::hot_slot::get_hot_slot(target);
            if slot.is_active_for(target) {
                if slot.deaf.load(std::sync::atomic::Ordering::Relaxed)
                    || slot.self_deaf.load(std::sync::atomic::Ordering::Relaxed)
                {
                    continue;
                }

                let target_channel = slot.channel_id.load(std::sync::atomic::Ordering::Relaxed);
                let permission = can_whisper_to_channel(
                    hub_client,
                    edge_state,
                    sender_session,
                    target_channel,
                    &mut whisper_perm_cache,
                )
                .await;
                cacheable_route &= permission.authoritative;
                if !permission.allowed {
                    continue;
                }

                direct_sessions.push(target);
                continue;
            }

            let Some(remote_user) = edge_state.channel_manager.get_remote_user(target).await else {
                continue;
            };
            if remote_user.edge_id == 0
                || remote_user.edge_id == my_edge_id
                || remote_user.deaf
                || remote_user.self_deaf
            {
                continue;
            }

            let permission = can_whisper_to_channel(
                hub_client,
                edge_state,
                sender_session,
                remote_user.channel_id,
                &mut whisper_perm_cache,
            )
            .await;
            cacheable_route &= permission.authoritative;
            if !permission.allowed {
                continue;
            }

            relay_edge_set.insert(remote_user.edge_id);
        }

        // Expand channel targets (with optional group filter) and deaf-filter.
        // Includes both channel members AND sessions listening to the channel —
        // a listener of channel X must hear whatever a member of X would hear.
        let mut channel_sessions: SmallVec<[u32; 16]> = SmallVec::new();
        let mut seen_channel_targets: HashSet<u32> = HashSet::new();
        for (&ch_id, group_filter) in &vt.resolved_channels {
            let permission = can_whisper_to_channel(
                hub_client,
                edge_state,
                sender_session,
                ch_id,
                &mut whisper_perm_cache,
            )
            .await;
            cacheable_route &= permission.authoritative;
            if !permission.allowed {
                continue;
            }
            let ch_members = edge_state.client_manager.get_channel_sessions(ch_id).await;
            let ch_listeners = edge_state
                .client_manager
                .get_listening_sessions(ch_id)
                .await;
            for target in ch_members.into_iter().chain(ch_listeners.into_iter()) {
                if target == sender_session {
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

        if !direct_sessions.is_empty() && !seen_channel_targets.is_empty() {
            // Match Murmur's receiver merge semantics: if a user matches both a
            // direct whisper and a channel shout target, SHOUT wins.
            direct_sessions.retain(|target| !seen_channel_targets.contains(target));
        }

        if !vt.resolved_channels.is_empty() {
            let target_channels: HashSet<u32> = vt.resolved_channels.keys().copied().collect();
            let remote_candidates = edge_state
                .channel_manager
                .get_remote_users_in_channels(&target_channels)
                .await;

            for remote_user in remote_candidates {
                if remote_user.session_id == sender_session
                    || remote_user.edge_id == 0
                    || remote_user.edge_id == my_edge_id
                    || remote_user.deaf
                    || remote_user.self_deaf
                {
                    continue;
                }

                let matches_channel_target = vt.resolved_channels.iter().any(|(&ch_id, group_filter)| {
                    let in_target = remote_user.channel_id == ch_id
                        || remote_user.listening_channels.contains(&ch_id);
                    if !in_target {
                        return false;
                    }

                    match group_filter {
                        None => true,
                        Some(groups) => remote_user.groups.iter().any(|group| groups.contains(group)),
                    }
                });

                if matches_channel_target {
                    relay_edge_set.insert(remote_user.edge_id);
                }
            }
        }

        let mut relay_edges: Vec<u32> = relay_edge_set.into_iter().collect();
        relay_edges.sort_unstable();
        let relay_edge_ids: SmallVec<[u32; 8]> = relay_edges.into_iter().collect();

        // Never pin a route derived from fail-closed permission lookups. That
        // would turn one transient Hub/RPC miss into a long-lived empty route.
        if cacheable_route {
            edge_state.store_cached_whisper_route(
                sender_session,
                voice_target,
                current_version,
                crate::voice_target::WhisperRouteCacheEntry {
                    direct_sessions: direct_sessions.clone(),
                    channel_sessions: channel_sessions.clone(),
                    relay_edge_ids: relay_edge_ids.clone(),
                },
            );
        }

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

        let (raw_sessions, relay_edge_ids): (Cow<'_, [u32]>, SmallVec<[u32; 8]>) =
            if let Some(ref c) = cache_hit {
                // Cache hit: borrow the cached session slice directly to avoid a per-packet Vec clone.
                (
                    Cow::Borrowed(c.local_sessions.as_slice()),
                    c.relay_edge_ids.clone(),
                )
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
                            !ru.deaf && !ru.self_deaf && ru.edge_id != 0 && ru.edge_id != my_edge_id
                        })
                        .filter_map(|ru| seen.insert(ru.edge_id).then_some(ru.edge_id))
                        .collect()
                };

                // Atomically write cache before returning — only when the slot actually
                // belongs to sender_session (i.e. this is a local sender, not a relayed
                // packet whose session ID collides with a local session).
                let slot = get_hot_slot(sender_session);
                if slot.is_active_for(sender_session) {
                    slot.broadcast_cache
                        .store(Arc::new(Some(Arc::new(BroadcastCache {
                            local_sessions: SmallVec::from_iter(sessions.iter().copied()),
                            relay_edge_ids: relay_ids.clone(),
                        }))));
                    slot.broadcast_cache_version
                        .store(current_version, Ordering::Release);
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
                    Arc::new(
                        edge_state
                            .client_manager
                            .get_plugin_context(sender_session)
                            .await,
                    )
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

#[cfg(test)]
mod tests {
    use super::compute_voice_targets;
    use crate::channel_manager::{ChannelManager, RemoteUser};
    use crate::client::ClientManager;
    use crate::hub_client::HubClient;
    use crate::state::EdgeState;
    use crate::voice_target::{VoiceTargetChannelConfig, VoiceTargetConfig};
    use munode_common::config::{EdgeConfig, HubServerConfig, NetworkConfig, ServerConfig, TlsConfig};
    use munode_common::permission;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    fn test_config() -> EdgeConfig {
        EdgeConfig {
            server_id: 1,
            name: "test".to_string(),
            network: NetworkConfig {
                host: "127.0.0.1".to_string(),
                port: 64738,
                edge_port: None,
                external_host: "127.0.0.1".to_string(),
                external_port: None,
                region: None,
                proxy_protocol: false,
                trusted_proxy_ips: Vec::new(),
            },
            tls: TlsConfig {
                cert: "test.pem".to_string(),
                key: "test.key".to_string(),
                ca: None,
            },
            hub_server: HubServerConfig {
                host: "localhost".to_string(),
                control_port: 8080,
                reconnect_interval: 5000,
                heartbeat_interval: 10000,
                hmac_secret: None,
                pool_size: 1,
                static_peers: vec![],
                tls: false,
            },
            server: ServerConfig::default(),
            voice_routing: munode_common::config::EdgeVoiceRoutingConfig::default(),
            web_api: munode_common::config::EdgeWebApiConfig::default(),
            webtransport: munode_common::config::WebtransportConfig::default(),
            log_level: "info".to_string(),
            log_format: "text".to_string(),
        }
    }

    #[tokio::test]
    async fn whisper_relay_targets_include_remote_target_edges_without_peer_registry() {
        let channel_manager = ChannelManager::new();
        let client_manager = ClientManager::new();
        let edge_state = EdgeState::new(channel_manager.clone(), client_manager, false);
        edge_state.edge_id.store(1, Ordering::Relaxed);

        channel_manager
            .upsert_remote_user(RemoteUser {
                session_id: 20_001,
                edge_id: 2,
                user_id: 2,
                username: "remote-user".to_string(),
                channel_id: 7,
                cert_hash: None,
                groups: vec![],
                mute: false,
                deaf: false,
                suppress: false,
                self_mute: false,
                self_deaf: false,
                priority_speaker: false,
                recording: false,
                listening_channels: vec![],
            })
            .await;

        edge_state
            .voice_targets
            .write()
            .await
            .entry(10_001)
            .or_default()
            .insert(
                3,
                VoiceTargetConfig {
                    sessions: vec![],
                    channels: vec![VoiceTargetChannelConfig {
                        channel_id: 7,
                        links: false,
                        children: false,
                        group: None,
                    }],
                    resolved_channels: HashMap::from([(7, None)]),
                },
            );
        edge_state
            .permission_cache
            .insert((10_001, 7), permission::WHISPER);

        let hub_client = HubClient::new(&test_config(), Arc::clone(&edge_state));
        let targets = compute_voice_targets(&[3], 10_001, 7, &edge_state, &hub_client)
            .await
            .expect("voice target should resolve");

        assert_eq!(
            targets.relay_edge_ids.as_slice(),
            &[2],
            "whisper sender should relay to remote edges that host matching target users even before peer_registry is populated"
        );
    }

    #[tokio::test]
    async fn whisper_relay_targets_include_remote_direct_sessions_without_peer_registry() {
        let channel_manager = ChannelManager::new();
        let client_manager = ClientManager::new();
        let edge_state = EdgeState::new(channel_manager.clone(), client_manager, false);
        edge_state.edge_id.store(1, Ordering::Relaxed);

        channel_manager
            .upsert_remote_user(RemoteUser {
                session_id: 20_001,
                edge_id: 2,
                user_id: 2,
                username: "remote-user".to_string(),
                channel_id: 9,
                cert_hash: None,
                groups: vec![],
                mute: false,
                deaf: false,
                suppress: false,
                self_mute: false,
                self_deaf: false,
                priority_speaker: false,
                recording: false,
                listening_channels: vec![],
            })
            .await;

        edge_state
            .voice_targets
            .write()
            .await
            .entry(10_001)
            .or_default()
            .insert(
                4,
                VoiceTargetConfig {
                    sessions: vec![20_001],
                    channels: vec![],
                    resolved_channels: HashMap::new(),
                },
            );
        edge_state
            .permission_cache
            .insert((10_001, 9), permission::WHISPER);

        let hub_client = HubClient::new(&test_config(), Arc::clone(&edge_state));
        let targets = compute_voice_targets(&[4], 10_001, 7, &edge_state, &hub_client)
            .await
            .expect("voice target should resolve");

        assert_eq!(
            targets.relay_edge_ids.as_slice(),
            &[2],
            "whisper sender should relay to remote direct-session targets even before peer_registry is populated"
        );
    }
}
