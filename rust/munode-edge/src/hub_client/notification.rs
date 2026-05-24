//! Hub notification dispatch.
//!
//! This module extends `HubClient` with `handle_notification` and
//! `apply_server_limits`, which together translate Hub-pushed JSON notifications
//! into `EdgeEvent`s on the in-process broadcast channel.

use futures_util::stream::{self, StreamExt};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use tracing::{debug, info, warn};

use munode_protocol::hubedge::{
    HubDisseminationUpdateParams, ServerLimitsConfig, TypedRpcNotification,
};
use munode_protocol::message_type::MessageType;

use crate::channel_manager::{ChannelData, RemoteUser};
use crate::peer_registry::PeerEdgeInfo;
use crate::state::EdgeEvent;
use crate::voice_target::{apply_voice_target_proto, clear_session_voice_targets};

use super::HubClient;

const WHISPER_PERMISSION_PREFETCH_CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DisseminationEpochDecision {
    Apply {
        clear_dedupe: bool,
    },
    DropStale {
        current_epoch: u64,
        incoming_epoch: u64,
    },
}

fn decide_dissemination_epoch_update(
    edge_state: &crate::state::EdgeState,
    incoming_epoch: u64,
) -> DisseminationEpochDecision {
    use std::sync::atomic::Ordering;

    let mut current_epoch = edge_state.dissemination_route_epoch.load(Ordering::Acquire);
    loop {
        if incoming_epoch < current_epoch {
            return DisseminationEpochDecision::DropStale {
                current_epoch,
                incoming_epoch,
            };
        }

        match edge_state.dissemination_route_epoch.compare_exchange(
            current_epoch,
            incoming_epoch,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => {
                return DisseminationEpochDecision::Apply {
                    clear_dedupe: current_epoch != incoming_epoch,
                };
            }
            Err(actual_epoch) => current_epoch = actual_epoch,
        }
    }
}

fn build_dissemination_routes(
    params: &HubDisseminationUpdateParams,
) -> HashMap<u32, crate::state::DisseminationSourceState> {
    let mut routes = HashMap::new();
    for source in &params.sources {
        let mut branch_backups = HashMap::new();
        for backup in &source.branch_backups {
            branch_backups.insert(
                backup.primary_child_edge_id,
                backup.backup_next_hops.clone(),
            );
        }

        routes.insert(
            source.source_edge_id,
            crate::state::DisseminationSourceState {
                active_children: source.active_children.clone(),
                duplicate_children: source.duplicate_children.clone(),
                branch_backups,
            },
        );
    }
    routes
}

impl HubClient {
    async fn collect_channel_subtree(&self, root_channel_id: u32) -> Vec<u32> {
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([root_channel_id]);
        while let Some(channel_id) = queue.pop_front() {
            if !seen.insert(channel_id) {
                continue;
            }
            for child_id in self
                .edge_state
                .channel_manager
                .get_children(channel_id)
                .await
            {
                queue.push_back(child_id);
            }
        }
        seen.into_iter().collect()
    }

    async fn prefetch_whisper_permissions_for_channels(&self, channel_ids: &[u32]) {
        if channel_ids.is_empty() {
            return;
        }

        let target_channels: HashSet<u32> = channel_ids.iter().copied().collect();
        let sessions_to_prefetch: Vec<(u32, Vec<u32>)> = {
            let voice_targets = self.edge_state.voice_targets.read().await;
            voice_targets
                .iter()
                .filter_map(|(&session_id, targets)| {
                    let mut matched_channels = HashSet::new();
                    for vt in targets.values() {
                        for &channel_id in vt.resolved_channels.keys() {
                            if !target_channels.contains(&channel_id) {
                                continue;
                            }
                            if self
                                .edge_state
                                .permission_cache
                                .get(&(session_id, channel_id))
                                .is_some()
                            {
                                continue;
                            }
                            matched_channels.insert(channel_id);
                        }
                    }

                    if matched_channels.is_empty() {
                        None
                    } else {
                        Some((session_id, matched_channels.into_iter().collect()))
                    }
                })
                .collect()
        };

        stream::iter(sessions_to_prefetch)
            .for_each_concurrent(
                WHISPER_PERMISSION_PREFETCH_CONCURRENCY,
                |(session_id, matched_channels)| async move {
                    crate::server::connection::prefetch_whisper_permissions(
                        self,
                        &self.edge_state,
                        session_id,
                        &matched_channels,
                    )
                    .await;
                },
            )
            .await;
    }

    /// Handle a notification from the Hub.
    pub(super) async fn handle_notification(&self, notification: TypedRpcNotification) {
        let method = &notification.method;
        let eid = self.edge_id();
        info!(
            edge_id = eid,
            method = method.as_str(),
            "Hub -> Edge notification"
        );

        match method.as_str() {
            "hub.userJoined" => {
                if let Some(params) = &notification.user_joined {
                    let local_edge_id = self.edge_id();
                    let is_local = params.edge_id == local_edge_id;
                    // Only add REMOTE users (from other edges) to channel_manager.remote_users.
                    // Local users are tracked by their own connection handler via client_manager;
                    // adding them here would cause duplicate UserState messages during login.
                    if !is_local {
                        let user = RemoteUser {
                            session_id: params.session_id,
                            edge_id: params.edge_id,
                            user_id: params.user_id,
                            username: params.username.clone(),
                            channel_id: params.channel_id,
                            cert_hash: params.cert_hash.clone(),
                            groups: params.groups.clone(),
                            mute: params.mute.unwrap_or(false),
                            deaf: params.deaf.unwrap_or(false),
                            suppress: params.suppress.unwrap_or(false),
                            self_mute: params.self_mute.unwrap_or(false),
                            self_deaf: params.self_deaf.unwrap_or(false),
                            priority_speaker: params.priority_speaker.unwrap_or(false),
                            recording: params.recording.unwrap_or(false),
                            listening_channels: params.listening_channels.clone(),
                        };
                        info!(
                            "Remote user joined: {} (session {})",
                            user.username, user.session_id
                        );
                        let channel_id = user.channel_id;
                        self.edge_state
                            .channel_manager
                            .upsert_remote_user(user.clone())
                            .await;

                        // Check if this is a ninja channel
                        let is_ninja = self
                            .edge_state
                            .ninja_channels
                            .read()
                            .await
                            .contains(&channel_id);
                        self.edge_state.emit(EdgeEvent::RemoteUserJoined {
                            session_id: user.session_id,
                            username: user.username,
                            channel_id: user.channel_id,
                            is_ninja,
                        });
                        // Invalidate BroadcastCaches: remote user joined, relay targets may change.
                        self.edge_state
                            .topology_version
                            .fetch_add(1, std::sync::atomic::Ordering::Release);
                    } else {
                        info!(
                            "Local user joined (hub.userJoined echo): {} (session {})",
                            params.username, params.session_id
                        );
                    }
                }
            }
            "hub.userRemoveBroadcast" => {
                if let Some(params) = &notification.user_remove_broadcast {
                    let target_session = params.session;
                    info!("User removed: session {}", target_session);
                    // If the kicked user is a LOCAL client on this edge, send them UserRemove then close
                    if let Some(sender) = self
                        .edge_state
                        .client_manager
                        .get_sender(target_session)
                        .await
                    {
                        let msg = crate::handler::build_user_remove_msg(
                            target_session,
                            params.reason.as_deref(),
                        );
                        sender.send_message(MessageType::UserRemove, &msg).await;
                        // Remove the client from the manager and then fire the close signal
                        // so the per-client read loop breaks and the TCP connection closes.
                        self.edge_state
                            .client_manager
                            .remove_client(target_session)
                            .await;
                        // Free session ID back to local pool
                        self.edge_state.free_session_id(target_session).await;
                        // Clean up voice target cache for this session
                        clear_session_voice_targets(&self.edge_state, target_session).await;
                        self.edge_state
                            .client_manager
                            .send_close_signal(target_session)
                            .await;
                    }
                    // Clean up cached VoiceTarget state for remote sessions too.
                    clear_session_voice_targets(&self.edge_state, target_session).await;
                    // Remove from remote user tracking and broadcast removal to local clients.
                    // Capture channel_id BEFORE removal so the event listener can filter by it.
                    let departed_channel_id = self
                        .edge_state
                        .channel_manager
                        .get_remote_user(target_session)
                        .await
                        .map(|u| u.channel_id)
                        .unwrap_or(0);
                    self.edge_state
                        .channel_manager
                        .remove_remote_user(target_session)
                        .await;
                    self.edge_state.emit(EdgeEvent::RemoteUserLeft {
                        session_id: target_session,
                        channel_id: departed_channel_id,
                    });
                    // Invalidate BroadcastCaches: user removed, relay targets may change.
                    self.edge_state
                        .topology_version
                        .fetch_add(1, std::sync::atomic::Ordering::Release);
                }
            }
            "hub.userStateBroadcast" => {
                // User state changed on another edge (mute, deaf, etc.)
                if let Some(p) = &notification.user_state_broadcast {
                    let session_id = p.session_id;
                    if session_id > 0 {
                        let mut delta = crate::state::RemoteUserStateDelta::default();
                        if let Some(b) = p.self_mute {
                            delta.self_mute = Some(b);
                        }
                        if let Some(b) = p.self_deaf {
                            delta.self_deaf = Some(b);
                        }
                        if let Some(b) = p.mute {
                            delta.mute = Some(b);
                        }
                        if let Some(b) = p.deaf {
                            delta.deaf = Some(b);
                        }
                        if let Some(b) = p.suppress {
                            delta.suppress = Some(b);
                        }
                        if let Some(b) = p.priority_speaker {
                            delta.priority_speaker = Some(b);
                        }
                        if let Some(b) = p.recording {
                            delta.recording = Some(b);
                        }
                        delta.actor_session = p.actor_session;

                        if let Some(mut user) = self
                            .edge_state
                            .channel_manager
                            .get_remote_user(session_id)
                            .await
                        {
                            if let Some(b) = p.self_mute {
                                user.self_mute = b;
                            }
                            if let Some(b) = p.self_deaf {
                                user.self_deaf = b;
                            }
                            if let Some(b) = p.mute {
                                user.mute = b;
                            }
                            if let Some(b) = p.deaf {
                                user.deaf = b;
                            }
                            if let Some(b) = p.suppress {
                                user.suppress = b;
                            }
                            if let Some(b) = p.priority_speaker {
                                user.priority_speaker = b;
                            }
                            if let Some(b) = p.recording {
                                user.recording = b;
                            }
                            let listening_add: Vec<u32> = p
                                .listening_channel_add
                                .iter()
                                .copied()
                                .filter(|&ch_id| !user.listening_channels.contains(&ch_id))
                                .collect();
                            let listening_remove = p.listening_channel_remove.clone();
                            for &ch_id in &listening_add {
                                user.listening_channels.push(ch_id);
                            }
                            user.listening_channels
                                .retain(|ch| !listening_remove.contains(ch));
                            // Invalidate BroadcastCache: a remote user's deaf flag or
                            // listening_channels changed, which alters the local routing
                            // target set (deaf filter + listener inclusion) and the relay
                            // edge set for cross-edge listeners.
                            let listening_changed =
                                !listening_add.is_empty() || !listening_remove.is_empty();
                            let deaf_changed = delta.deaf.is_some() || delta.self_deaf.is_some();
                            self.edge_state
                                .channel_manager
                                .upsert_remote_user(user)
                                .await;
                            if listening_changed || deaf_changed {
                                self.edge_state
                                    .topology_version
                                    .fetch_add(1, std::sync::atomic::Ordering::Release);
                            }
                            self.edge_state.emit(EdgeEvent::RemoteUserStateChanged {
                                session_id,
                                delta,
                                listening_channel_add: listening_add,
                                listening_channel_remove: listening_remove,
                                actor_session: p.actor_session,
                            });
                        } else if let Some(mut client) =
                            self.edge_state.client_manager.get_client(session_id).await
                        {
                            // The source edge is authoritative for a connected local
                            // user's self mute/deaf choice. Hub echoes are used to
                            // fan out that state to other edges, but must not
                            // overwrite the local client's immediate choice.
                            delta.self_mute = None;
                            delta.self_deaf = None;
                            if let Some(b) = p.mute {
                                client.mute = b;
                            }
                            if let Some(b) = p.deaf {
                                client.deaf = b;
                            }
                            if let Some(b) = p.suppress {
                                client.suppress = b;
                            }
                            if let Some(b) = p.priority_speaker {
                                client.priority_speaker = b;
                            }
                            if let Some(b) = p.recording {
                                client.recording = b;
                            }

                            let listening_add: Vec<u32> = p
                                .listening_channel_add
                                .iter()
                                .copied()
                                .filter(|&ch_id| !client.listening_channels.contains(&ch_id))
                                .collect();
                            let listening_remove = p.listening_channel_remove.clone();
                            for &ch_id in &listening_add {
                                client.listening_channels.push(ch_id);
                            }
                            client
                                .listening_channels
                                .retain(|ch| !listening_remove.contains(ch));

                            let listening_changed =
                                !listening_add.is_empty() || !listening_remove.is_empty();
                            let deaf_changed = delta.deaf.is_some() || delta.self_deaf.is_some();
                            self.edge_state.client_manager.update_client(client).await;
                            if listening_changed || deaf_changed {
                                self.edge_state
                                    .topology_version
                                    .fetch_add(1, std::sync::atomic::Ordering::Release);
                            }
                            self.edge_state.emit(EdgeEvent::RemoteUserStateChanged {
                                session_id,
                                delta,
                                listening_channel_add: listening_add,
                                listening_channel_remove: listening_remove,
                                actor_session: p.actor_session,
                            });
                        }
                    }
                }
            }
            "hub.userMoved" => {
                if let Some(params) = &notification.user_moved {
                    debug!(
                        "Remote user moved: session {} -> channel {}",
                        params.session_id, params.channel_id
                    );
                    let remote_user_before = self
                        .edge_state
                        .channel_manager
                        .get_remote_user(params.session_id)
                        .await;
                    let local_client_before = self
                        .edge_state
                        .client_manager
                        .get_client(params.session_id)
                        .await;
                    let had_remote_user = remote_user_before.is_some();
                    let had_local_client = local_client_before.is_some();
                    // Capture the channel the user was in BEFORE the move, so the event
                    // listener can apply correct ninja from→to visibility logic.
                    let from_channel_id = if let Some(u) = remote_user_before.as_ref() {
                        u.channel_id
                    } else if let Some(c) = local_client_before.as_ref() {
                        c.channel_id
                    } else {
                        params.channel_id // fallback: treat as same channel (no-op visibility change)
                    };
                    // Update remote-user tracking if the mover is tracked as remote on this edge.
                    let mut remote_user_changed = false;
                    let mut moved_suppress = None;
                    if let Some(mut user) = remote_user_before {
                        let old_suppress = user.suppress;
                        if user.channel_id != params.channel_id {
                            remote_user_changed = true;
                        }
                        if let Some(suppress) = params.suppress {
                            user.suppress = suppress;
                            if suppress != old_suppress {
                                moved_suppress = Some(suppress);
                            }
                        }
                        if remote_user_changed || moved_suppress.is_some() {
                            user.channel_id = params.channel_id;
                            self.edge_state
                                .channel_manager
                                .upsert_remote_user(user)
                                .await;
                        }
                    }
                    // If the moved user is LOCAL on this edge (i.e. the admin move came from
                    // a different edge), update client_manager so that voice routing and
                    // subsequent ACL checks use the correct channel.
                    let mut local_client_changed = false;
                    if let Some(local_client) = local_client_before.as_ref() {
                        let old_suppress = local_client.suppress;
                        let old_channel_id = local_client.channel_id;
                        let new_suppress = params.suppress.unwrap_or(old_suppress);
                        local_client_changed = old_channel_id != params.channel_id;
                        if local_client_changed || old_suppress != new_suppress {
                            self.edge_state
                                .client_manager
                                .move_client_to_channel(
                                    params.session_id,
                                    params.channel_id,
                                    new_suppress,
                                )
                                .await;
                            debug!(
                                "Local client {} applied hub.userMoved to channel {} (suppress={})",
                                params.session_id, params.channel_id, new_suppress
                            );
                        }
                        if old_suppress != new_suppress {
                            moved_suppress = Some(new_suppress);
                        }
                    }
                    if remote_user_changed
                        || local_client_changed
                        || (!had_remote_user && !had_local_client)
                    {
                        // actor_session: 0 means server-initiated; fall back to session_id for user self-moves
                        let actor_session = params
                            .actor_session
                            .filter(|&a| a != 0)
                            .unwrap_or(params.session_id);
                        self.edge_state.emit(EdgeEvent::RemoteUserMoved {
                            session_id: params.session_id,
                            from_channel_id,
                            channel_id: params.channel_id,
                            actor_session,
                            suppress: moved_suppress,
                        });
                    }
                    // Invalidate BroadcastCaches: remote user moved channel, relay targets may change.
                    self.edge_state
                        .topology_version
                        .fetch_add(1, std::sync::atomic::Ordering::Release);
                }
            }
            "hub.channelCreated" => {
                if let Some(params) = &notification.channel_created {
                    let ch_proto = &params.channel;
                    let channel = ChannelData::from(ch_proto);
                    info!("Channel created: {} (id {})", channel.name, channel.id);
                    self.edge_state
                        .channel_manager
                        .upsert_channel(channel)
                        .await;
                    self.edge_state.recompute_all_vt_channels().await;
                    self.prefetch_whisper_permissions_for_channels(&[ch_proto.channel_id])
                        .await;
                    self.edge_state
                        .topology_version
                        .fetch_add(1, std::sync::atomic::Ordering::Release);
                    self.edge_state.emit(EdgeEvent::ChannelCreated {
                        channel_id: ch_proto.channel_id,
                    });
                }
            }
            "hub.channelRemoved" => {
                if let Some(params) = &notification.channel_removed {
                    info!("Channel removed: {}", params.channel_id);
                    self.edge_state
                        .channel_manager
                        .remove_channel(params.channel_id)
                        .await;
                    self.edge_state.recompute_all_vt_channels().await;
                    self.edge_state
                        .topology_version
                        .fetch_add(1, std::sync::atomic::Ordering::Release);
                    self.edge_state.emit(EdgeEvent::ChannelRemoved {
                        channel_id: params.channel_id,
                    });
                }
            }
            "hub.channelUpdated" => {
                if let Some(params) = &notification.channel_updated {
                    let ch_proto = &params.channel;
                    let channel = ChannelData::from(ch_proto);
                    let channel_id = ch_proto.channel_id;
                    // Compute link delta so the broadcast to local clients uses
                    // links_add / links_remove (Mumble protocol incremental update).
                    let old_channel = self
                        .edge_state
                        .channel_manager
                        .get_channel(channel_id)
                        .await;
                    let old_links = old_channel
                        .as_ref()
                        .map(|old_ch| old_ch.links.clone())
                        .unwrap_or_default();
                    let old_parent_id = old_channel.as_ref().and_then(|old_ch| old_ch.parent_id);
                    let new_links = channel.links.clone();
                    let links_add: Vec<u32> = new_links
                        .iter()
                        .filter(|l| !old_links.contains(l))
                        .copied()
                        .collect();
                    let links_remove: Vec<u32> = old_links
                        .iter()
                        .filter(|l| !new_links.contains(l))
                        .copied()
                        .collect();
                    debug!(
                        "Channel updated: {} (id {}), links_add={:?}, links_remove={:?}",
                        channel.name, channel_id, links_add, links_remove
                    );
                    let parent_changed = old_parent_id != channel.parent_id;
                    self.edge_state
                        .channel_manager
                        .upsert_channel(channel)
                        .await;
                    // A parent change mutates the channel tree used by `children=true` VoiceTargets,
                    // so it requires a full recompute. Link-only changes can stay on the narrow path.
                    if parent_changed {
                        self.edge_state.recompute_all_vt_channels().await;
                        let subtree_channels = self.collect_channel_subtree(channel_id).await;
                        self.prefetch_whisper_permissions_for_channels(&subtree_channels)
                            .await;
                        self.edge_state
                            .topology_version
                            .fetch_add(1, std::sync::atomic::Ordering::Release);
                    } else if !links_add.is_empty() || !links_remove.is_empty() {
                        // If links changed, VoiceTarget channel caches that include this channel may be stale,
                        // and the per-sender BroadcastCache (which expands `linked_channels`) is also stale.
                        self.edge_state
                            .recompute_vt_channels_for_link_change(
                                channel_id, &old_links, &new_links,
                            )
                            .await;
                        let linked_channels: Vec<u32> = self
                            .edge_state
                            .channel_manager
                            .get_all_linked_channels(channel_id)
                            .await
                            .into_iter()
                            .collect();
                        self.prefetch_whisper_permissions_for_channels(&linked_channels)
                            .await;
                        self.edge_state
                            .topology_version
                            .fetch_add(1, std::sync::atomic::Ordering::Release);
                    }
                    self.edge_state.emit(EdgeEvent::ChannelUpdated {
                        channel_id,
                        links_add,
                        links_remove,
                    });
                }
            }
            "edge.forceDisconnect" => {
                if let Some(params) = &notification.force_disconnect {
                    warn!("Hub forced disconnect: {}", params.reason);
                }
            }
            "hub.shutdownRequest" => {
                // Hub requests this Edge to gracefully shut down (cluster partition handling)
                let reason = "Network partition detected";
                warn!("Hub shutdown request received: {}", reason);
                // Emit shutdown event so server can gracefully disconnect all clients
                self.edge_state.emit(EdgeEvent::ShutdownRequested {
                    reason: reason.to_string(),
                });
            }
            "edge.peerJoined" => {
                if let Some(params) = &notification.peer_joined {
                    info!("Peer edge joined: {} (id {})", params.name, params.id);
                }
            }
            "hub.textMessageForward" => {
                // Text message forwarded from another edge via Hub
                if let Some(p) = &notification.text_message_forward {
                    self.edge_state.emit(EdgeEvent::TextMessageForward {
                        actor: p.actor,
                        message: p.message.clone(),
                        channel_id: p.channel_id.clone(),
                        tree_id: p.tree_id.clone(),
                        session: p.session.clone(),
                    });
                }
            }
            "hub.pluginDataBroadcast" => {
                // Plugin data forwarded from another edge
                if let Some(params) = &notification.plugin_data_broadcast {
                    self.edge_state.emit(EdgeEvent::PluginDataBroadcast {
                        sender_session: params.sender_session,
                        data_id: params.data_id.clone(),
                        data: params.data.clone(),
                        target_sessions: params.target_sessions.clone(),
                    });
                }
            }
            "hub.syncVoiceTarget" => {
                // Voice target synced from another edge via Hub
                if let Some(params) = &notification.sync_voice_target {
                    let client_session = params.client_session;
                    let target_id = params.target_id;
                    apply_voice_target_proto(
                        &self.edge_state,
                        client_session,
                        target_id,
                        params.config.clone(),
                    )
                    .await;
                    debug!(
                        "Synced voice target {} for session {}",
                        target_id, client_session
                    );
                }
            }
            "hub.peerJoined" => {
                // Another Edge joined the cluster (from handle_cluster_join broadcast)
                if let Some(p) = &notification.cluster_peer_joined {
                    let peer_edge_id = p.edge_id;
                    // Skip if this is our own edge ID (should not happen, but guard
                    // against Hub bugs or race conditions during reconnection).
                    if peer_edge_id == self.edge_state.get_edge_id() {
                        debug!("Ignoring peerJoined for own edge id {}", peer_edge_id);
                    } else {
                        let name = &p.name;
                        let host = &p.host;
                        let voice_port = p.voice_port as u16;
                        info!(
                            "Peer edge joined cluster: {} (id {}) at {}:{}",
                            name, peer_edge_id, host, voice_port
                        );
                        if !host.is_empty() && voice_port > 0 {
                            if let Some(udp_addr) =
                                super::resolve_peer_udp_addr(host, voice_port).await
                            {
                                // Detect address change for an already-managed peer.
                                // If the peer restarted at a new host/port while the Hub was down,
                                // the running slot loops still hold the stale address — we must
                                // close the old pool and spawn a fresh manager with the new address.
                                let already_managed = {
                                    self.edge_state
                                        .voice_tcp_peers
                                        .read()
                                        .await
                                        .contains(&peer_edge_id)
                                };
                                let addr_changed = already_managed && {
                                    let current = self.edge_state.peer_registry.load();
                                    current
                                        .get(peer_edge_id)
                                        .is_none_or(|info| info.udp_addr != udp_addr)
                                };
                                if addr_changed {
                                    warn!(
                                        "Peer edge {} address changed to {}, restarting voice TCP pool",
                                        peer_edge_id, udp_addr
                                    );
                                    // Close all existing pool slots (slot loops will exit via Ok(())).
                                    let pool_opt = {
                                        let current = self.edge_state.voice_tcp_conns.load();
                                        current.get(&peer_edge_id).cloned()
                                    };
                                    if let Some(pool) = pool_opt {
                                        pool.close_all();
                                    }
                                    // Remove from managed set so the spawn below will create a new manager.
                                    self.edge_state
                                        .voice_tcp_peers
                                        .write()
                                        .await
                                        .remove(&peer_edge_id);
                                }

                                // clone-modify-store: PeerRegistry 实现 Clone，写入串行化
                                {
                                    let current = self.edge_state.peer_registry.load_full();
                                    let mut new_reg = (*current).clone();
                                    new_reg.upsert(
                                        peer_edge_id,
                                        PeerEdgeInfo {
                                            udp_addr,
                                            host: host.clone(),
                                            relay_port: None,
                                        },
                                    );
                                    self.edge_state.peer_registry.store(Arc::new(new_reg));
                                }
                                info!(
                                    "Registered direct UDP route to peer edge {} at {}",
                                    peer_edge_id, udp_addr
                                );
                            } else {
                                warn!(
                                    peer_edge_id,
                                    host = %host,
                                    voice_port,
                                    "Skipping direct UDP registration for peerJoined: address resolution failed"
                                );
                            }
                            // Connect TCP voice pool to the new peer, but only if a pool
                            // manager task is not already running.  Use voice_tcp_peers as
                            // the canonical "is managed" flag: connect_peer_voice_tcp inserts
                            // into this set as its very first action, so its presence means
                            // a pool task is already in progress.
                            let already_managed = {
                                self.edge_state
                                    .voice_tcp_peers
                                    .read()
                                    .await
                                    .contains(&peer_edge_id)
                            };
                            if !already_managed {
                                let peer_host = host.clone();
                                let self_id = self.edge_state.get_edge_id();
                                let state_clone = self.edge_state.clone();
                                let secret = self.config.hmac_secret.clone();
                                tokio::spawn(async move {
                                    crate::relay_server::connect_peer_voice_tcp(
                                        peer_edge_id,
                                        peer_host,
                                        voice_port,
                                        self_id,
                                        state_clone,
                                        secret,
                                    )
                                    .await;
                                });
                            }
                        }
                    } // end else (not self)
                }
                if let Err(error) = self.report_connected_peers().await {
                    warn!(
                        "Failed to re-report connected peers after hub.peerJoined: {}",
                        error
                    );
                }
                // Invalidate BroadcastCaches: peer edge joined, relay targets changed.
                self.edge_state
                    .topology_version
                    .fetch_add(1, std::sync::atomic::Ordering::Release);
            }
            "hub.peerLeft" => {
                // An Edge left the cluster (disconnect arbitration)
                if let Some(p) = &notification.cluster_peer_left {
                    let peer_edge_id = p.edge_id;
                    warn!("Peer edge left cluster: id {}", peer_edge_id);
                    // Remove from peer registry (UDP routing).
                    {
                        let current = self.edge_state.peer_registry.load_full();
                        let mut new_reg = (*current).clone();
                        new_reg.remove(peer_edge_id);
                        self.edge_state.peer_registry.store(Arc::new(new_reg));
                    }
                    // Signal all pool slots to stop: close_all() drops every slot sender
                    // so each slot's rx.recv() returns None and the writer loop exits.
                    // Then remove the pool from voice_tcp_conns and peer from voice_tcp_peers.
                    let pool = {
                        let current = self.edge_state.voice_tcp_conns.load_full();
                        let mut new_conns = (*current).clone();
                        let pool = new_conns.remove(&peer_edge_id);
                        self.edge_state.voice_tcp_conns.store(Arc::new(new_conns));
                        pool
                    };
                    if let Some(p) = pool {
                        p.close_all();
                    }
                    self.edge_state
                        .voice_tcp_peers
                        .write()
                        .await
                        .remove(&peer_edge_id);
                    // Invalidate BroadcastCaches: peer edge left, relay targets changed.
                    self.edge_state
                        .topology_version
                        .fetch_add(1, std::sync::atomic::Ordering::Release);
                }
            }
            "hub.routeTableUpdate" => {
                if let Some(params) = &notification.route_table_update {
                    use crate::state::{HopTransport, RouteCandidate, RouteDecision};
                    use std::sync::atomic::Ordering;
                    let new_max_ttl = params.max_ttl.unwrap_or(4);
                    self.edge_state
                        .max_ttl
                        .store(new_max_ttl, Ordering::Relaxed);
                    // Build new route table from scratch, then publish atomically.
                    let mut new_table: std::collections::HashMap<u32, Vec<RouteCandidate>> =
                        std::collections::HashMap::new();
                    for entry in &params.routes {
                        let decision = match entry.route_type {
                            1 => {
                                let hops = entry.relay_chain.clone();
                                let transports = entry
                                    .relay_transports
                                    .iter()
                                    .map(|&t| {
                                        if t == 1 {
                                            HopTransport::Tcp
                                        } else {
                                            HopTransport::Udp
                                        }
                                    })
                                    .collect();
                                RouteDecision::RelayChain { hops, transports }
                            }
                            2 => RouteDecision::HubTcp,
                            3 => RouteDecision::DirectTcp,
                            _ => RouteDecision::DirectUdp,
                        };
                        let candidate = RouteCandidate {
                            decision,
                            cost: entry.cost,
                        };
                        new_table
                            .entry(entry.target_edge_id)
                            .or_default()
                            .push(candidate);
                    }
                    for candidates in new_table.values_mut() {
                        candidates.sort_unstable_by(|a, b| {
                            a.cost
                                .partial_cmp(&b.cost)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        });
                    }
                    let count = new_table.len();
                    self.edge_state.route_table.store(Arc::new(new_table));
                    debug!(
                        "Route table updated: {} entries, max_ttl={}",
                        count, new_max_ttl
                    );
                }
            }
            "hub.disseminationUpdate" => {
                if let Some(params) = &notification.dissemination_update {
                    use std::sync::atomic::Ordering;

                    let new_max_ttl = params.max_ttl.unwrap_or(4);
                    self.edge_state
                        .max_ttl
                        .store(new_max_ttl, Ordering::Relaxed);

                    let incoming_route_epoch = params.route_epoch.unwrap_or(0);
                    match decide_dissemination_epoch_update(&self.edge_state, incoming_route_epoch)
                    {
                        DisseminationEpochDecision::DropStale {
                            current_epoch,
                            incoming_epoch,
                        } => {
                            warn!(
                                current_epoch,
                                incoming_epoch, "Dropping stale dissemination update"
                            );
                            return;
                        }
                        DisseminationEpochDecision::Apply { clear_dedupe } => {
                            if clear_dedupe
                                && let Ok(mut windows) = self.edge_state.dissemination_dedupe.lock()
                            {
                                windows.clear();
                            }
                        }
                    }

                    let new_routes = build_dissemination_routes(params);

                    let count = new_routes.len();
                    self.edge_state
                        .dissemination_routes
                        .store(Arc::new(new_routes));
                    debug!(
                        "Dissemination updated: {} sources, route_epoch={}, max_ttl={}",
                        count, incoming_route_epoch, new_max_ttl
                    );
                }
            }
            "hub.contextActionModify" => {
                // Hub pushes a ContextActionModify to specific clients on this Edge.
                // Forward the ContextActionModify message to each targeted client.
                if let Some(params) = &notification.context_action_modify {
                    let Some(msg) = &params.action else {
                        return;
                    };
                    let target_sessions = &params.target_sessions;
                    if target_sessions.is_empty() {
                        // Broadcast to all local clients
                        self.edge_state
                            .client_manager
                            .broadcast(MessageType::ContextActionModify, msg, None)
                            .await;
                        debug!(
                            "ContextActionModify broadcast to all clients: action={:?}",
                            msg.action.as_str()
                        );
                    } else {
                        // Pre-encode once; use try_send_raw (non-blocking) so a slow
                        // client cannot stall the notification processor.
                        let mut buf = bytes::BytesMut::new();
                        munode_protocol::transport::encode_message(
                            MessageType::ContextActionModify,
                            msg,
                            &mut buf,
                        );
                        let data = buf.freeze();
                        for &sid in target_sessions {
                            if let Some(sender) =
                                self.edge_state.client_manager.get_sender(sid).await
                                && !sender.try_send_raw(data.clone())
                            {
                                warn!("Dropped ContextActionModify for slow session {}", sid);
                            }
                        }
                        debug!(
                            "ContextActionModify sent to {} client(s): action={:?}",
                            target_sessions.len(),
                            msg.action.as_str()
                        );
                    }
                }
            }
            _ => {
                // Check for hub.serverConfigUpdate — Hub hot-reload push
                if method == "hub.serverConfigUpdate" {
                    if let Some(limits) = notification.server_config_update {
                        info!("Received server config update from Hub hot-reload");
                        self.apply_server_limits(limits).await;
                    }
                // Check for hub.aclUpdated (uses unknown_params_json)
                } else if method == "hub.aclUpdated" {
                    if let Some(json_str) = &notification.unknown_params_json
                        && let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str)
                        && let Some(channel_id) = val.get("channel_id").and_then(|v| v.as_u64())
                    {
                        let is_enter_restricted = val
                            .get("is_enter_restricted")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        self.edge_state
                            .permission_cache
                            .retain(|&(_, ch), _| ch != channel_id as u32);
                        self.edge_state.clear_all_cached_whisper_routes();
                        debug!(
                            "ACL updated for channel {}, is_enter_restricted={}",
                            channel_id, is_enter_restricted
                        );
                        self.edge_state.emit(crate::state::EdgeEvent::AclUpdated {
                            channel_id: channel_id as u32,
                            is_enter_restricted,
                        });
                    }
                // Check for hub.ninjaConfig (uses unknown_params_json)
                } else if method == "hub.ninjaConfig" {
                    if let Some(json_str) = &notification.unknown_params_json
                        && let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str)
                        && val
                            .get("enabled")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                    {
                        let channels: Vec<u32> = val
                            .get("ninja_channels")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_u64().map(|n| n as u32))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let mut nc = self.edge_state.ninja_channels.write().await;
                        *nc = channels;
                        debug!("Ninja channels updated from Hub: {:?}", &*nc);
                    }
                } else {
                    debug!("Unhandled notification: {}", method);
                }
            }
        }
    }

    /// Apply a `ServerLimitsConfig` received from Hub (on registration or
    /// `hub.serverConfigUpdate` hot-reload push).
    pub(super) async fn apply_server_limits(&self, limits: ServerLimitsConfig) {
        debug!(
            max_bandwidth = limits.max_bandwidth.unwrap_or(0),
            max_users = limits.max_users.unwrap_or(0),
            max_users_per_channel = limits.max_users_per_channel.unwrap_or(0),
            text_message_length = limits.text_message_length.unwrap_or(0),
            image_message_length = limits.image_message_length.unwrap_or(0),
            plugin_message_length = limits.plugin_message_length.unwrap_or(0),
            message_rate = limits.message_rate.unwrap_or(0.0),
            message_burst = limits.message_burst.unwrap_or(0),
            listeners_per_channel = limits.listeners_per_channel.unwrap_or(0),
            listeners_per_user = limits.listeners_per_user.unwrap_or(0),
            allow_ping = limits.allow_ping.unwrap_or(false),
            hub_tcp_relay_enabled = limits.hub_tcp_relay_enabled.unwrap_or(true),
            suggest_version = limits.suggest_version.unwrap_or(0),
            suggest_positional = limits.suggest_positional.unwrap_or(false),
            suggest_push_to_talk = limits.suggest_push_to_talk.unwrap_or(false),
            welcome_text = limits.welcome_text.as_deref().unwrap_or(""),
            "Applying server limits from Hub"
        );
        if let Some(allow_ping) = limits.allow_ping {
            self.edge_state
                .allow_ping
                .store(allow_ping, std::sync::atomic::Ordering::Relaxed);
        }
        if let Some(enabled) = limits.hub_tcp_relay_enabled {
            self.edge_state.set_hub_tcp_relay_enabled(enabled);
        }
        self.edge_state.max_bandwidth_bps.store(
            limits.max_bandwidth.unwrap_or(0),
            std::sync::atomic::Ordering::Relaxed,
        );
        self.edge_state.max_users.store(
            limits.max_users.unwrap_or(0),
            std::sync::atomic::Ordering::Relaxed,
        );
        if let Some(v) = limits.listeners_per_user
            && v > 0
        {
            self.edge_state
                .listeners_per_user
                .store(v, std::sync::atomic::Ordering::Relaxed);
        }
        if let Some(v) = limits.listeners_per_channel
            && v > 0
        {
            self.edge_state
                .listeners_per_channel
                .store(v, std::sync::atomic::Ordering::Relaxed);
        }
        *self.edge_state.hub_limits.write().await = Some(limits);
    }
}

#[cfg(test)]
mod tests {
    use super::{DisseminationEpochDecision, decide_dissemination_epoch_update};
    use crate::channel_manager::ChannelManager;
    use crate::client::{ClientInfo, ClientManager, ClientSender, ClientState};
    use crate::hub_client::HubClient;
    use crate::server::hub_event_listener;
    use crate::state::EdgeState;
    use bytes::BytesMut;
    use munode_common::config::{
        EdgeConfig, EdgeVoiceRoutingConfig, EdgeWebApiConfig, HubServerConfig, NetworkConfig,
        ServerConfig, TlsConfig, WebtransportConfig,
    };
    use munode_protocol::hubedge::{
        HubUserMovedParams, HubUserStateBroadcastParams, ServerLimitsConfig, TypedRpcNotification,
    };
    use munode_protocol::message_type::MessageType;
    use munode_protocol::mumbleproto;
    use munode_protocol::transport::decode_frame;
    use prost::Message;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::Instant;
    use tokio::sync::{mpsc, watch};

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
            voice_routing: EdgeVoiceRoutingConfig::default(),
            web_api: EdgeWebApiConfig::default(),
            webtransport: WebtransportConfig::default(),
            log_level: "info".to_string(),
            log_format: "text".to_string(),
        }
    }

    fn make_test_client(session: u32, channel_id: u32) -> ClientInfo {
        ClientInfo {
            session,
            user_id: session,
            username: format!("user-{session}"),
            channel_id,
            state: ClientState::Ready,
            mute: false,
            deaf: false,
            suppress: false,
            self_mute: false,
            self_deaf: false,
            priority_speaker: false,
            recording: false,
            ip_address: "127.0.0.1".to_string(),
            connected_at: Instant::now(),
            last_active: Instant::now(),
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

    async fn run_event_listener_task(edge_state: Arc<EdgeState>) -> Arc<EdgeState> {
        let listener_state = edge_state.clone();
        tokio::spawn(async move {
            let mut rx = listener_state.subscribe_events();
            let (shutdown_tx, _shutdown_rx) = watch::channel(false);
            let hub_client = HubClient::new(&test_config(), listener_state.clone());
            hub_event_listener(listener_state, &mut rx, shutdown_tx, hub_client).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        edge_state
    }

    fn decode_user_state(data: &[u8]) -> mumbleproto::UserState {
        let mut buf = BytesMut::from(data);
        let frame = decode_frame(&mut buf)
            .expect("decode_frame ok")
            .expect("frame present");
        assert_eq!(frame.message_type, MessageType::UserState);
        mumbleproto::UserState::decode(&frame.payload[..]).expect("decode UserState")
    }

    #[test]
    fn dissemination_epoch_rejects_stale_updates() {
        let edge_state = EdgeState::new(ChannelManager::new(), ClientManager::new(), true);
        edge_state
            .dissemination_route_epoch
            .store(12, Ordering::Release);

        let decision = decide_dissemination_epoch_update(&edge_state, 11);

        assert_eq!(
            decision,
            DisseminationEpochDecision::DropStale {
                current_epoch: 12,
                incoming_epoch: 11,
            }
        );
        assert_eq!(
            edge_state.dissemination_route_epoch.load(Ordering::Acquire),
            12
        );
    }

    #[test]
    fn dissemination_epoch_accepts_newer_updates_and_marks_dedupe_reset() {
        let edge_state = EdgeState::new(ChannelManager::new(), ClientManager::new(), true);
        edge_state
            .dissemination_route_epoch
            .store(12, Ordering::Release);

        let decision = decide_dissemination_epoch_update(&edge_state, 13);

        assert_eq!(
            decision,
            DisseminationEpochDecision::Apply { clear_dedupe: true }
        );
        assert_eq!(
            edge_state.dissemination_route_epoch.load(Ordering::Acquire),
            13
        );
    }

    #[test]
    fn dissemination_epoch_accepts_same_epoch_without_dedupe_reset() {
        let edge_state = EdgeState::new(ChannelManager::new(), ClientManager::new(), true);
        edge_state
            .dissemination_route_epoch
            .store(12, Ordering::Release);

        let decision = decide_dissemination_epoch_update(&edge_state, 12);

        assert_eq!(
            decision,
            DisseminationEpochDecision::Apply {
                clear_dedupe: false,
            }
        );
        assert_eq!(
            edge_state.dissemination_route_epoch.load(Ordering::Acquire),
            12
        );
    }

    #[tokio::test]
    async fn apply_server_limits_updates_hub_tcp_relay_live_flag() {
        let edge_state = EdgeState::new(ChannelManager::new(), ClientManager::new(), true);
        let hub = HubClient::new(&test_config(), edge_state.clone());

        assert!(edge_state.hub_tcp_relay_allowed());

        hub.apply_server_limits(ServerLimitsConfig {
            hub_tcp_relay_enabled: Some(false),
            ..Default::default()
        })
        .await;

        assert!(!edge_state.hub_tcp_relay_allowed());
    }

    #[tokio::test]
    async fn local_client_self_mute_deaf_overrides_hub_echo() {
        let edge_state = EdgeState::new(ChannelManager::new(), ClientManager::new(), true);
        let hub = HubClient::new(&test_config(), edge_state.clone());
        let (tx, _rx) = mpsc::channel(16);

        let mut client = make_test_client(42, 0);
        client.self_mute = true;
        client.self_deaf = true;
        edge_state
            .client_manager
            .add_client(client, ClientSender::new(tx))
            .await;

        hub.handle_notification(TypedRpcNotification {
            method: "hub.userStateBroadcast".to_string(),
            user_state_broadcast: Some(HubUserStateBroadcastParams {
                session_id: 42,
                edge_id: 1,
                self_mute: Some(false),
                self_deaf: Some(false),
                mute: Some(true),
                deaf: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await;

        let updated = edge_state
            .client_manager
            .get_client(42)
            .await
            .expect("local client should remain present");
        assert!(updated.self_mute, "hub echo must not clear local self_mute");
        assert!(updated.self_deaf, "hub echo must not clear local self_deaf");
        assert!(updated.mute, "hub admin mute should still apply");
        assert!(updated.deaf, "hub admin deaf should still apply");
    }

    #[tokio::test]
    async fn hub_user_moved_for_local_client_broadcasts_to_all_local_clients() {
        let edge_state = EdgeState::new(ChannelManager::new(), ClientManager::new(), true);
        let hub = HubClient::new(&test_config(), edge_state.clone());

        let (tx_target, mut rx_target) = mpsc::channel(16);
        let (tx_observer, mut rx_observer) = mpsc::channel(16);

        edge_state
            .client_manager
            .add_client(make_test_client(42, 0), ClientSender::new(tx_target))
            .await;
        edge_state
            .client_manager
            .add_client(make_test_client(7, 0), ClientSender::new(tx_observer))
            .await;

        let edge_state = run_event_listener_task(edge_state).await;

        hub.handle_notification(TypedRpcNotification {
            method: "hub.userMoved".to_string(),
            user_moved: Some(HubUserMovedParams {
                session_id: 42,
                edge_id: 1,
                channel_id: 9,
                actor_session: Some(42),
                suppress: None,
            }),
            ..Default::default()
        })
        .await;

        let target_msg = decode_user_state(
            &rx_target
                .recv()
                .await
                .expect("moved local client should receive authoritative move"),
        );
        assert_eq!(target_msg.session, Some(42));
        assert_eq!(target_msg.channel_id, Some(9));
        assert_eq!(target_msg.actor, Some(42));

        let observer_msg = decode_user_state(
            &rx_observer
                .recv()
                .await
                .expect("other local clients should receive authoritative move"),
        );
        assert_eq!(observer_msg.session, Some(42));
        assert_eq!(observer_msg.channel_id, Some(9));
        assert_eq!(observer_msg.actor, Some(42));

        let updated = edge_state
            .client_manager
            .get_client(42)
            .await
            .expect("moved local client should remain present");
        assert_eq!(updated.channel_id, 9);
    }
}
