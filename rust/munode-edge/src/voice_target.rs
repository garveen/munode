use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use munode_protocol::{hubedge, mumbleproto};
use smallvec::SmallVec;

use crate::channel_manager::ChannelManager;

type ResolvedVoiceTargetSnapshot = (u32, u32, HashMap<u32, Option<Vec<String>>>);

/// A single voice target configuration (whisper/shout destinations).
#[derive(Debug, Clone)]
pub struct VoiceTargetConfig {
    pub sessions: Vec<u32>,
    pub channels: Vec<VoiceTargetChannelConfig>,
    /// Pre-computed expanded channel set, built once at config-write time.
    /// Maps channel_id → group filter (None = no filter, Some = user must be
    /// in at least one of the named groups). Rebuilt whenever the config
    /// changes OR when the channel link/tree structure changes.
    pub resolved_channels: HashMap<u32, Option<Vec<String>>>,
}

#[derive(Debug, Clone)]
pub struct VoiceTargetChannelConfig {
    pub channel_id: u32,
    pub links: bool,
    pub children: bool,
    pub group: Option<String>,
}

/// Cached local whisper route for one `(sender_session, target_id)` pair.
///
/// This is the fully materialized result of expanding a VoiceTarget against the
/// current local Edge state. It intentionally mirrors the transport-facing split
/// between direct whisper targets and channel shout targets.
#[derive(Debug, Clone)]
pub struct WhisperRouteCacheEntry {
    pub direct_sessions: SmallVec<[u32; 8]>,
    pub channel_sessions: SmallVec<[u32; 16]>,
    pub relay_edge_ids: SmallVec<[u32; 8]>,
}

/// Per-sender whisper cache state.
///
/// `topology_version` is compared against `EdgeState::topology_version` before a
/// cached target entry may be reused.
#[derive(Debug, Clone, Default)]
pub struct SessionWhisperRouteCache {
    pub topology_version: u64,
    pub targets: HashMap<u32, WhisperRouteCacheEntry>,
}

/// Convert a `HashMap<u32, VoiceTargetConfig>` to a `HotVoiceTargetMap` for storage in
/// `HotSlot::voice_targets`.
pub fn build_hot_vt_map(
    session_vts: &std::collections::HashMap<u32, VoiceTargetConfig>,
) -> crate::hot_slot::HotVoiceTargetMap {
    session_vts
        .iter()
        .map(|(&tid, vt)| {
            (
                tid,
                Arc::new(crate::hot_slot::HotVoiceTarget {
                    sessions: vt.sessions.clone(),
                    resolved_channels: vt.resolved_channels.clone(),
                }),
            )
        })
        .collect()
}

pub async fn get_routing_voice_target(
    edge_state: &crate::state::EdgeState,
    sender_session: u32,
    target_id: u32,
) -> Option<Arc<crate::hot_slot::HotVoiceTarget>> {
    let slot = crate::hot_slot::get_hot_slot(sender_session);
    if slot.is_active_for(sender_session) {
        let vt_guard = slot.voice_targets.load();
        if let Some(map) = &**vt_guard {
            return map.get(&target_id).cloned();
        }
    }

    let cache = edge_state.voice_targets.read().await;
    cache
        .get(&sender_session)
        .and_then(|targets| targets.get(&target_id))
        .map(|voice_target| {
            Arc::new(crate::hot_slot::HotVoiceTarget {
                sessions: voice_target.sessions.clone(),
                resolved_channels: voice_target.resolved_channels.clone(),
            })
        })
}

pub fn voice_target_config_to_proto(config: &VoiceTargetConfig) -> hubedge::VoiceTargetConfigProto {
    let sessions = config
        .sessions
        .iter()
        .map(|&session| hubedge::VoiceTargetSession { session })
        .collect();
    let channels = config
        .channels
        .iter()
        .map(|channel| hubedge::VoiceTargetChannel {
            channel_id: channel.channel_id,
            links: Some(channel.links),
            children: Some(channel.children),
            group: channel.group.clone(),
        })
        .collect();

    hubedge::VoiceTargetConfigProto { sessions, channels }
}

pub fn mumble_voice_target_to_proto(
    voice_target: &mumbleproto::VoiceTarget,
) -> Option<hubedge::VoiceTargetConfigProto> {
    if voice_target.targets.is_empty() {
        return None;
    }

    let mut sessions = Vec::new();
    let mut channels = Vec::new();
    for target in &voice_target.targets {
        sessions.extend(
            target
                .session
                .iter()
                .copied()
                .map(|session| hubedge::VoiceTargetSession { session }),
        );
        if let Some(channel_id) = target.channel_id {
            channels.push(hubedge::VoiceTargetChannel {
                channel_id,
                links: Some(target.links.unwrap_or(false)),
                children: Some(target.children.unwrap_or(false)),
                group: target.group.clone(),
            });
        }
    }

    Some(hubedge::VoiceTargetConfigProto { sessions, channels })
}

/// Recursively collect all descendant channel IDs into `out`.
pub(crate) fn collect_children_into(
    ch_id: u32,
    out: &mut HashSet<u32>,
    children_map: &HashMap<u32, Vec<u32>>,
) {
    if let Some(children) = children_map.get(&ch_id) {
        for &child in children {
            if out.insert(child) {
                collect_children_into(child, out, children_map);
            }
        }
    }
}

pub(crate) fn collect_linked_channels_into(
    ch_id: u32,
    out: &mut HashSet<u32>,
    link_graph: &HashMap<u32, Vec<u32>>,
) {
    let mut queue = std::collections::VecDeque::new();
    if out.insert(ch_id) {
        queue.push_back(ch_id);
    }
    while let Some(current) = queue.pop_front() {
        if let Some(links) = link_graph.get(&current) {
            for &linked in links {
                if out.insert(linked) {
                    queue.push_back(linked);
                }
            }
        }
    }
}

pub(crate) fn collect_affected_link_channels(
    channel_id: u32,
    old_links: &[u32],
    new_links: &[u32],
    link_graph: &HashMap<u32, Vec<u32>>,
) -> HashSet<u32> {
    let mut affected = HashSet::new();
    let mut seeds = HashSet::from([channel_id]);
    seeds.extend(old_links.iter().copied());
    seeds.extend(new_links.iter().copied());
    for seed in seeds {
        collect_linked_channels_into(seed, &mut affected, link_graph);
    }
    affected
}

pub(crate) fn resolve_voice_target_channels_with_snapshot(
    channels: &[VoiceTargetChannelConfig],
    link_graph: &HashMap<u32, Vec<u32>>,
    children_map: &HashMap<u32, Vec<u32>>,
) -> HashMap<u32, Option<Vec<String>>> {
    let mut resolved: HashMap<u32, Option<Vec<String>>> = HashMap::new();
    for ch_cfg in channels {
        let mut ch_ids = HashSet::new();
        if ch_cfg.links {
            collect_linked_channels_into(ch_cfg.channel_id, &mut ch_ids, link_graph);
        } else {
            ch_ids.insert(ch_cfg.channel_id);
        }
        if ch_cfg.children {
            let snapshot: Vec<u32> = ch_ids.iter().copied().collect();
            for ch_id in snapshot {
                collect_children_into(ch_id, &mut ch_ids, children_map);
            }
        }
        let effective_group: Option<&str> = ch_cfg.group.as_deref().filter(|s| !s.is_empty());
        for ch_id in ch_ids {
            resolved
                .entry(ch_id)
                .and_modify(|existing| match (effective_group, existing.as_mut()) {
                    (None, _) => *existing = None,
                    (Some(_), None) => {}
                    (Some(g), Some(groups)) => {
                        if !groups.iter().any(|e| e == g) {
                            groups.push(g.to_owned());
                        }
                    }
                })
                .or_insert_with(|| effective_group.map(|g| vec![g.to_owned()]));
        }
    }
    resolved
}

/// Expand a slice of `VoiceTargetChannelConfig` into a flat map of
/// `channel_id → group filter` by resolving `links` and `children` flags.
/// Multiple entries targeting the same channel are merged: a no-filter entry
/// wins over any group restriction (union semantics).
///
/// Resolution order (matches Mumble C++ server behaviour):
///
/// 1. Start with the base channel.
/// 2. If `links=true`, extend with all transitively linked channels.
/// 3. If `children=true`, extend with all recursive sub-channels of EVERY
///    channel collected so far (base + links), not just the base channel.
///
/// An empty-string group is treated the same as no group (no filter).
pub async fn resolve_voice_target_channels(
    channels: &[VoiceTargetChannelConfig],
    channel_manager: &ChannelManager,
) -> HashMap<u32, Option<Vec<String>>> {
    let (link_graph, children_map) = channel_manager.get_voice_target_resolution_snapshot().await;
    resolve_voice_target_channels_with_snapshot(channels, &link_graph, &children_map)
}

fn split_voice_target_proto(
    config: hubedge::VoiceTargetConfigProto,
) -> (Vec<u32>, Vec<VoiceTargetChannelConfig>) {
    let sessions = config
        .sessions
        .into_iter()
        .map(|session| session.session)
        .collect();
    let channels = config
        .channels
        .into_iter()
        .map(|channel| VoiceTargetChannelConfig {
            channel_id: channel.channel_id,
            links: channel.links.unwrap_or(false),
            children: channel.children.unwrap_or(false),
            group: channel.group,
        })
        .collect();
    (sessions, channels)
}

async fn prepare_voice_target_config(
    channel_manager: &ChannelManager,
    config: Option<hubedge::VoiceTargetConfigProto>,
) -> Option<VoiceTargetConfig> {
    let config = config?;
    let (sessions, channels) = split_voice_target_proto(config);
    if sessions.is_empty() && channels.is_empty() {
        return None;
    }
    let resolved_channels = resolve_voice_target_channels(&channels, channel_manager).await;
    Some(VoiceTargetConfig {
        sessions,
        channels,
        resolved_channels,
    })
}

async fn apply_prepared_voice_target_updates(
    edge_state: &crate::state::EdgeState,
    updates: Vec<(u32, u32, Option<VoiceTargetConfig>)>,
) -> HashSet<u32> {
    let mut cache = edge_state.voice_targets.write().await;
    let mut touched_sessions = HashSet::new();

    for (client_session, target_id, config) in updates {
        match config {
            Some(config) => {
                cache
                    .entry(client_session)
                    .or_default()
                    .insert(target_id, config);
                touched_sessions.insert(client_session);
            }
            None => {
                let mut removed = false;
                let mut remove_session = false;
                if let Some(session_vts) = cache.get_mut(&client_session) {
                    removed = session_vts.remove(&target_id).is_some();
                    remove_session = session_vts.is_empty();
                }
                if remove_session {
                    cache.remove(&client_session);
                }
                if removed {
                    touched_sessions.insert(client_session);
                }
            }
        }
    }

    if touched_sessions.is_empty() {
        return touched_sessions;
    }

    let hot_map_updates: Vec<(u32, Option<crate::hot_slot::HotVoiceTargetMap>)> = touched_sessions
        .iter()
        .map(|&client_session| {
            (
                client_session,
                cache.get(&client_session).map(build_hot_vt_map),
            )
        })
        .collect();
    drop(cache);

    for (client_session, hot_map) in hot_map_updates {
        let slot = crate::hot_slot::get_hot_slot(client_session);
        if slot.is_active_for(client_session) {
            slot.voice_targets.store(Arc::new(hot_map.map(Arc::new)));
        }
    }

    touched_sessions
}

pub async fn apply_voice_target_proto(
    edge_state: &crate::state::EdgeState,
    client_session: u32,
    target_id: u32,
    config: Option<hubedge::VoiceTargetConfigProto>,
) {
    let prepared = prepare_voice_target_config(&edge_state.channel_manager, config).await;
    apply_prepared_voice_target_updates(edge_state, vec![(client_session, target_id, prepared)])
        .await;
    edge_state.clear_cached_whisper_target(client_session, target_id);
}

pub async fn apply_voice_target_proto_batch(
    edge_state: &crate::state::EdgeState,
    entries: Vec<(u32, u32, Option<hubedge::VoiceTargetConfigProto>)>,
) -> HashSet<u32> {
    let mut updates = Vec::with_capacity(entries.len());
    for (client_session, target_id, config) in entries {
        let prepared = prepare_voice_target_config(&edge_state.channel_manager, config).await;
        updates.push((client_session, target_id, prepared));
    }

    let touched_sessions = apply_prepared_voice_target_updates(edge_state, updates).await;
    for &client_session in &touched_sessions {
        edge_state.clear_cached_whisper_session(client_session);
    }
    touched_sessions
}

pub async fn clear_session_voice_targets(
    edge_state: &crate::state::EdgeState,
    client_session: u32,
) {
    edge_state
        .voice_targets
        .write()
        .await
        .remove(&client_session);

    let slot = crate::hot_slot::get_hot_slot(client_session);
    if slot.is_active_for(client_session) {
        slot.voice_targets.store(Arc::new(None));
    }

    edge_state.clear_cached_whisper_session(client_session);
}

pub async fn recompute_all_session_voice_targets(edge_state: &crate::state::EdgeState) {
    let (link_graph, children_map) = edge_state
        .channel_manager
        .get_voice_target_resolution_snapshot()
        .await;
    let snapshots: Vec<(u32, u32, Vec<VoiceTargetChannelConfig>)> = {
        let cache = edge_state.voice_targets.read().await;
        cache
            .iter()
            .flat_map(|(&session_id, targets)| {
                targets.iter().map(move |(&target_id, voice_target)| {
                    (session_id, target_id, voice_target.channels.clone())
                })
            })
            .collect()
    };
    if snapshots.is_empty() {
        return;
    }

    recompute_voice_target_snapshots(edge_state, snapshots, &link_graph, &children_map).await;
}

pub async fn recompute_link_affected_voice_targets(
    edge_state: &crate::state::EdgeState,
    channel_id: u32,
    old_links: &[u32],
    new_links: &[u32],
) {
    let (link_graph, children_map) = edge_state
        .channel_manager
        .get_voice_target_resolution_snapshot()
        .await;
    let affected_link_channels =
        collect_affected_link_channels(channel_id, old_links, new_links, &link_graph);
    let snapshots: Vec<(u32, u32, Vec<VoiceTargetChannelConfig>)> = {
        let cache = edge_state.voice_targets.read().await;
        cache
            .iter()
            .flat_map(|(&session_id, targets)| {
                let affected_link_channels = &affected_link_channels;
                targets
                    .iter()
                    .filter(move |(_, voice_target)| {
                        voice_target
                            .channels
                            .iter()
                            .any(|config| {
                                config.links && affected_link_channels.contains(&config.channel_id)
                            })
                    })
                    .map(move |(&target_id, voice_target)| {
                        (session_id, target_id, voice_target.channels.clone())
                    })
            })
            .collect()
    };
    if snapshots.is_empty() {
        return;
    }

    recompute_voice_target_snapshots(edge_state, snapshots, &link_graph, &children_map).await;
}

async fn recompute_voice_target_snapshots(
    edge_state: &crate::state::EdgeState,
    snapshots: Vec<(u32, u32, Vec<VoiceTargetChannelConfig>)>,
    link_graph: &HashMap<u32, Vec<u32>>,
    children_map: &HashMap<u32, Vec<u32>>,
) {
    let resolved_list: Vec<ResolvedVoiceTargetSnapshot> = snapshots
        .iter()
        .map(|(session_id, target_id, channels)| {
            (
                *session_id,
                *target_id,
                resolve_voice_target_channels_with_snapshot(channels, link_graph, children_map),
            )
        })
        .collect();

    let mut cache = edge_state.voice_targets.write().await;
    let mut touched_sessions = HashSet::new();
    for (session_id, target_id, resolved_channels) in resolved_list {
        if let Some(voice_target) = cache
            .get_mut(&session_id)
            .and_then(|targets| targets.get_mut(&target_id))
            && voice_target.resolved_channels != resolved_channels {
                voice_target.resolved_channels = resolved_channels;
                touched_sessions.insert(session_id);
            }
    }
    if touched_sessions.is_empty() {
        return;
    }

    let hot_map_updates: Vec<(u32, crate::hot_slot::HotVoiceTargetMap)> = touched_sessions
        .iter()
        .filter_map(|&session_id| {
            cache
                .get(&session_id)
                .map(|session_targets| (session_id, build_hot_vt_map(session_targets)))
        })
        .collect();
    drop(cache);

    for (session_id, hot_map) in hot_map_updates {
        crate::hot_slot::get_hot_slot(session_id)
            .voice_targets
            .store(Arc::new(Some(Arc::new(hot_map))));
    }
}
