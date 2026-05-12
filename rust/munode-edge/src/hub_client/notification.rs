//! Hub notification dispatch.
//!
//! This module extends `HubClient` with `handle_notification` and
//! `apply_server_limits`, which together translate Hub-pushed JSON notifications
//! into `EdgeEvent`s on the in-process broadcast channel.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use tracing::{debug, info, trace, warn};

use munode_protocol::message_type::MessageType;
use munode_protocol::hubedge::{TypedRpcNotification, ServerLimitsConfig};

use crate::channel_manager::{ChannelData, RemoteUser};
use crate::state::EdgeEvent;
use crate::peer_registry::PeerEdgeInfo;

use super::HubClient;

impl HubClient {
    async fn collect_channel_subtree(&self, root_channel_id: u32) -> Vec<u32> {
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([root_channel_id]);
        while let Some(channel_id) = queue.pop_front() {
            if !seen.insert(channel_id) {
                continue;
            }
            for child_id in self.edge_state.channel_manager.get_children(channel_id).await {
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
                    let mut matched_channels = Vec::new();
                    for &channel_id in &target_channels {
                        let referenced = targets
                            .values()
                            .any(|vt| vt.resolved_channels.contains_key(&channel_id));
                        if referenced
                            && self
                                .edge_state
                                .permission_cache
                                .get(&(session_id, channel_id))
                                .is_none()
                        {
                            matched_channels.push(channel_id);
                        }
                    }

                    if matched_channels.is_empty() {
                        None
                    } else {
                        Some((session_id, matched_channels))
                    }
                })
                .collect()
        };

        for (session_id, matched_channels) in sessions_to_prefetch {
            crate::server::connection::prefetch_whisper_permissions(
                self,
                &self.edge_state,
                session_id,
                &matched_channels,
            )
            .await;
        }
    }

    /// Handle a notification from the Hub.
    pub(super) async fn handle_notification(&self, notification: TypedRpcNotification) {
        let method = &notification.method;
        let eid = self.edge_id();
        // High-frequency voice relay notifications are trace-level to avoid log flooding.
        if method == "hub.relayVoicePacket" {
            trace!("Hub notification: {} (edge={})", method, eid);
        } else {
            debug!("Hub notification: {} (edge={})", method, eid);
        }

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
                        info!("Remote user joined: {} (session {})", user.username, user.session_id);
                        let channel_id = user.channel_id;
                        self.edge_state.channel_manager.upsert_remote_user(user.clone()).await;

                        // Check if this is a ninja channel
                        let is_ninja = self.edge_state.ninja_channels.read().await.contains(&channel_id);
                        self.edge_state.emit(EdgeEvent::RemoteUserJoined {
                            session_id: user.session_id,
                            username: user.username,
                            channel_id: user.channel_id,
                            is_ninja,
                        });
                        // Invalidate BroadcastCaches: remote user joined, relay targets may change.
                        self.edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
                    } else {
                        info!("Local user joined (hub.userJoined echo): {} (session {})", params.username, params.session_id);
                    }
                }
            }
            "hub.userRemoveBroadcast" => {
                if let Some(params) = &notification.user_remove_broadcast {
                    let target_session = params.session;
                    info!("User removed: session {}", target_session);
                    // If the kicked user is a LOCAL client on this edge, send them UserRemove then close
                    if let Some(sender) = self.edge_state.client_manager.get_sender(target_session).await {
                        let msg = crate::handler::build_user_remove_msg(
                            target_session,
                            params.reason.as_deref(),
                        );
                        sender.send_message(MessageType::UserRemove, &msg).await;
                        // Remove the client from the manager and then fire the close signal
                        // so the per-client read loop breaks and the TCP connection closes.
                        self.edge_state.client_manager.remove_client(target_session).await;
                        // Free session ID back to local pool
                        self.edge_state.free_session_id(target_session).await;
                        // Clean up voice target cache for this session
                        self.edge_state.voice_targets.write().await.remove(&target_session);
                        self.edge_state.clear_cached_whisper_session(target_session);
                        self.edge_state.client_manager.send_close_signal(target_session).await;
                    }
                    // Clean up cached VoiceTarget state for remote sessions too.
                    self.edge_state.voice_targets.write().await.remove(&target_session);
                    self.edge_state.clear_cached_whisper_session(target_session);
                    // Remove from remote user tracking and broadcast removal to local clients.
                    // Capture channel_id BEFORE removal so the event listener can filter by it.
                    let departed_channel_id = self.edge_state.channel_manager.get_remote_user(target_session).await
                        .map(|u| u.channel_id)
                        .unwrap_or(0);
                    self.edge_state.channel_manager.remove_remote_user(target_session).await;
                    self.edge_state.emit(EdgeEvent::RemoteUserLeft {
                        session_id: target_session,
                        channel_id: departed_channel_id,
                    });
                    // Invalidate BroadcastCaches: user removed, relay targets may change.
                    self.edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
                }
            }
            "hub.userStateBroadcast" => {
                // User state changed on another edge (mute, deaf, etc.)
                if let Some(p) = &notification.user_state_broadcast {
                    let session_id = p.session_id;
                    if session_id > 0 {
                        if let Some(mut user) = self.edge_state.channel_manager.get_remote_user(session_id).await {
                            let mut delta = crate::state::RemoteUserStateDelta::default();
                            if let Some(b) = p.self_mute     { user.self_mute = b;         delta.self_mute = Some(b); }
                            if let Some(b) = p.self_deaf     { user.self_deaf = b;         delta.self_deaf = Some(b); }
                            if let Some(b) = p.mute          { user.mute = b;              delta.mute = Some(b); }
                            if let Some(b) = p.deaf          { user.deaf = b;              delta.deaf = Some(b); }
                            if let Some(b) = p.suppress      { user.suppress = b;          delta.suppress = Some(b); }
                            if let Some(b) = p.priority_speaker { user.priority_speaker = b; delta.priority_speaker = Some(b); }
                            if let Some(b) = p.recording     { user.recording = b;         delta.recording = Some(b); }
                            delta.actor_session = p.actor_session;
                            let listening_add: Vec<u32> = p.listening_channel_add.iter()
                                .copied()
                                .filter(|&ch_id| !user.listening_channels.contains(&ch_id))
                                .collect();
                            let listening_remove = p.listening_channel_remove.clone();
                            for &ch_id in &listening_add {
                                user.listening_channels.push(ch_id);
                            }
                            user.listening_channels.retain(|ch| !listening_remove.contains(ch));
                            // Invalidate BroadcastCache: a remote user's deaf flag or
                            // listening_channels changed, which alters the local routing
                            // target set (deaf filter + listener inclusion) and the relay
                            // edge set for cross-edge listeners.
                            let listening_changed =
                                !listening_add.is_empty() || !listening_remove.is_empty();
                            let deaf_changed =
                                delta.deaf.is_some() || delta.self_deaf.is_some();
                            self.edge_state.channel_manager.upsert_remote_user(user).await;
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
                    debug!("Remote user moved: session {} -> channel {}", params.session_id, params.channel_id);
                    // Capture the channel the user was in BEFORE the move, so the event
                    // listener can apply correct ninja from→to visibility logic.
                    let from_channel_id = if let Some(u) = self.edge_state.channel_manager.get_remote_user(params.session_id).await {
                        u.channel_id
                    } else if let Some(c) = self.edge_state.client_manager.get_client(params.session_id).await {
                        c.channel_id
                    } else {
                        params.channel_id // fallback: treat as same channel (no-op visibility change)
                    };
                    // Update remote-user tracking if the mover is tracked as remote on this edge.
                    if let Some(mut user) = self.edge_state.channel_manager.get_remote_user(params.session_id).await {
                        user.channel_id = params.channel_id;
                        self.edge_state.channel_manager.upsert_remote_user(user).await;
                    }
                    // If the moved user is LOCAL on this edge (i.e. the admin move came from
                    // a different edge), update client_manager so that voice routing and
                    // subsequent ACL checks use the correct channel.
                    if self.edge_state.client_manager.get_client(params.session_id).await.is_some() {
                        // Determine new suppress state: check speak permission in the new channel.
                        let new_suppress = match self.handle_permission_query(params.session_id, params.channel_id).await {
                            Ok(r) => r.permissions.map(|p| p & munode_common::permission::SPEAK != 0).map(|can| !can).unwrap_or(false),
                            Err(_) => false,
                        };
                        self.edge_state.client_manager.move_client_to_channel(
                            params.session_id,
                            params.channel_id,
                            new_suppress,
                        ).await;
                        debug!("Local client {} moved to channel {} by remote admin (suppress={})",
                            params.session_id, params.channel_id, new_suppress);
                    }
                    // actor_session: 0 means server-initiated; fall back to session_id for user self-moves
                    let actor_session = params.actor_session
                        .filter(|&a| a != 0)
                        .unwrap_or(params.session_id);
                    self.edge_state.emit(EdgeEvent::RemoteUserMoved {
                        session_id: params.session_id,
                        from_channel_id,
                        channel_id: params.channel_id,
                        actor_session,
                    });
                    // Invalidate BroadcastCaches: remote user moved channel, relay targets may change.
                    self.edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
                }
            }
            "hub.channelCreated" => {
                if let Some(params) = &notification.channel_created {
                    let ch_proto = &params.channel;
                    let channel = ChannelData::from(ch_proto);
                    info!("Channel created: {} (id {})", channel.name, channel.id);
                    self.edge_state.channel_manager.upsert_channel(channel).await;
                    self.edge_state.recompute_all_vt_channels().await;
                    self.prefetch_whisper_permissions_for_channels(&[ch_proto.channel_id]).await;
                    self.edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
                    self.edge_state.emit(EdgeEvent::ChannelCreated { channel_id: ch_proto.channel_id });
                }
            }
            "hub.channelRemoved" => {
                if let Some(params) = &notification.channel_removed {
                    info!("Channel removed: {}", params.channel_id);
                    self.edge_state.channel_manager.remove_channel(params.channel_id).await;
                    self.edge_state.recompute_all_vt_channels().await;
                    self.edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
                    self.edge_state.emit(EdgeEvent::ChannelRemoved { channel_id: params.channel_id });
                }
            }
            "hub.channelUpdated" => {
                if let Some(params) = &notification.channel_updated {
                    let ch_proto = &params.channel;
                    let channel = ChannelData::from(ch_proto);
                    let channel_id = ch_proto.channel_id;
                    // Compute link delta so the broadcast to local clients uses
                    // links_add / links_remove (Mumble protocol incremental update).
                    let old_channel = self.edge_state.channel_manager.get_channel(channel_id).await;
                    let old_links = old_channel
                        .as_ref()
                        .map(|old_ch| old_ch.links.clone())
                        .unwrap_or_default();
                    let old_parent_id = old_channel.as_ref().and_then(|old_ch| old_ch.parent_id);
                    let new_links = channel.links.clone();
                    let links_add: Vec<u32> = new_links.iter().filter(|l| !old_links.contains(l)).copied().collect();
                    let links_remove: Vec<u32> = old_links.iter().filter(|l| !new_links.contains(l)).copied().collect();
                    debug!("Channel updated: {} (id {}), links_add={:?}, links_remove={:?}", channel.name, channel_id, links_add, links_remove);
                    let parent_changed = old_parent_id != channel.parent_id;
                    self.edge_state.channel_manager.upsert_channel(channel).await;
                    // A parent change mutates the channel tree used by `children=true` VoiceTargets,
                    // so it requires a full recompute. Link-only changes can stay on the narrow path.
                    if parent_changed {
                        self.edge_state.recompute_all_vt_channels().await;
                        let subtree_channels = self.collect_channel_subtree(channel_id).await;
                        self.prefetch_whisper_permissions_for_channels(&subtree_channels).await;
                        self.edge_state
                            .topology_version
                            .fetch_add(1, std::sync::atomic::Ordering::Release);
                    } else if !links_add.is_empty() || !links_remove.is_empty() {
                        // If links changed, VoiceTarget channel caches that include this channel may be stale,
                        // and the per-sender BroadcastCache (which expands `linked_channels`) is also stale.
                        self.edge_state
                            .recompute_vt_channels_for_link_change(channel_id, &old_links, &new_links)
                            .await;
                        let linked_channels: Vec<u32> = self
                            .edge_state
                            .channel_manager
                            .get_all_linked_channels(channel_id)
                            .await
                            .into_iter()
                            .collect();
                        self.prefetch_whisper_permissions_for_channels(&linked_channels).await;
                        self.edge_state
                            .topology_version
                            .fetch_add(1, std::sync::atomic::Ordering::Release);
                    }
                    self.edge_state.emit(EdgeEvent::ChannelUpdated { channel_id, links_add, links_remove });
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
                    let hot_map_opt = if let Some(cfg) = &params.config {
                        use crate::state::{VoiceTargetConfig, VoiceTargetChannelConfig, build_hot_vt_map, resolve_voice_target_channels};
                        let sessions: Vec<u32> = cfg.sessions.iter().map(|s| s.session).collect();
                        let channels: Vec<VoiceTargetChannelConfig> = cfg.channels.iter().map(|c| {
                            VoiceTargetChannelConfig {
                                channel_id: c.channel_id,
                                links: c.links.unwrap_or(false),
                                children: c.children.unwrap_or(false),
                                group: c.group.clone(),
                            }
                        }).collect();
                        if sessions.is_empty() && channels.is_empty() {
                            let mut vt_cache = self.edge_state.voice_targets.write().await;
                            let remove_session = if let Some(session_vts) = vt_cache.get_mut(&client_session) {
                                session_vts.remove(&target_id);
                                session_vts.is_empty()
                            } else {
                                false
                            };
                            if remove_session {
                                vt_cache.remove(&client_session);
                                None
                            } else {
                                vt_cache.get(&client_session).map(build_hot_vt_map)
                            }
                        } else {
                            // Pre-compute expanded channel set before acquiring the write lock.
                            let resolved = resolve_voice_target_channels(&channels, &self.edge_state.channel_manager).await;
                            let mut vt_cache = self.edge_state.voice_targets.write().await;
                            let session_vts = vt_cache.entry(client_session).or_default();
                            session_vts.insert(target_id, VoiceTargetConfig { sessions, channels, resolved_channels: resolved });
                            Some(build_hot_vt_map(session_vts))
                        }
                    } else {
                        // No config means clear the target
                        let mut vt_cache = self.edge_state.voice_targets.write().await;
                        let remove_session = if let Some(session_vts) = vt_cache.get_mut(&client_session) {
                            session_vts.remove(&target_id);
                            session_vts.is_empty()
                        } else {
                            false
                        };
                        if remove_session {
                            vt_cache.remove(&client_session);
                            None
                        } else {
                            vt_cache.get(&client_session).map(crate::state::build_hot_vt_map)
                        }
                    };
                    let slot = crate::hot_slot::get_hot_slot(client_session);
                    if slot.is_active_for(client_session) {
                        slot.voice_targets.store(std::sync::Arc::new(hot_map_opt.map(std::sync::Arc::new)));
                    }
                    self.edge_state.clear_cached_whisper_target(client_session, target_id);
                    debug!("Synced voice target {} for session {}", target_id, client_session);
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
                    info!("Peer edge joined cluster: {} (id {}) at {}:{}", name, peer_edge_id, host, voice_port);
                    if !host.is_empty() && voice_port > 0 {
                        if let Ok(udp_addr) = format!("{}:{}", host, voice_port).parse() {
                            // Detect address change for an already-managed peer.
                            // If the peer restarted at a new host/port while the Hub was down,
                            // the running slot loops still hold the stale address — we must
                            // close the old pool and spawn a fresh manager with the new address.
                            let already_managed = {
                                self.edge_state.voice_tcp_peers.read().await.contains(&peer_edge_id)
                            };
                            let addr_changed = already_managed && {
                                let current = self.edge_state.peer_registry.load();
                                current.get(peer_edge_id).map_or(true, |info| info.udp_addr != udp_addr)
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
                                self.edge_state.voice_tcp_peers.write().await.remove(&peer_edge_id);
                            }

                            // clone-modify-store: PeerRegistry 实现 Clone，写入串行化
                            {
                                let current = self.edge_state.peer_registry.load_full();
                                let mut new_reg = (*current).clone();
                                new_reg.upsert(peer_edge_id, PeerEdgeInfo {
                                    udp_addr,
                                    host: host.clone(),
                                    relay_port: None,
                                });
                                self.edge_state.peer_registry.store(Arc::new(new_reg));
                            }
                            info!("Registered direct UDP route to peer edge {} at {}", peer_edge_id, udp_addr);
                        }
                        // Connect TCP voice pool to the new peer, but only if a pool
                        // manager task is not already running.  Use voice_tcp_peers as
                        // the canonical "is managed" flag: connect_peer_voice_tcp inserts
                        // into this set as its very first action, so its presence means
                        // a pool task is already in progress.
                        let already_managed = {
                            self.edge_state.voice_tcp_peers.read().await.contains(&peer_edge_id)
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
                // Invalidate BroadcastCaches: peer edge joined, relay targets changed.
                self.edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
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
                    self.edge_state.voice_tcp_peers.write().await.remove(&peer_edge_id);
                    // Invalidate BroadcastCaches: peer edge left, relay targets changed.
                    self.edge_state.topology_version.fetch_add(1, std::sync::atomic::Ordering::Release);
                }
            }
            "hub.routeTableUpdate" => {
                if let Some(params) = &notification.route_table_update {
                    use crate::state::{RouteCandidate, RouteDecision, HopTransport};
                    use std::sync::atomic::Ordering;
                    let new_max_ttl = params.max_ttl.unwrap_or(4);
                    self.edge_state.max_ttl.store(new_max_ttl, Ordering::Relaxed);
                    // Build new route table from scratch, then publish atomically.
                    let mut new_table: std::collections::HashMap<u32, Vec<RouteCandidate>> =
                        std::collections::HashMap::new();
                    for entry in &params.routes {
                        let decision = match entry.route_type {
                            1 => {
                                let hops = entry.relay_chain.clone();
                                let transports = entry.relay_transports.iter().map(|&t| {
                                    if t == 1 { HopTransport::Tcp } else { HopTransport::Udp }
                                }).collect();
                                RouteDecision::RelayChain { hops, transports }
                            }
                            2 => RouteDecision::HubTcp,
                            3 => RouteDecision::DirectTcp,
                            _ => RouteDecision::DirectUdp,
                        };
                        let candidate = RouteCandidate { decision, cost: entry.cost };
                        new_table.entry(entry.target_edge_id).or_insert_with(Vec::new).push(candidate);
                    }
                    for candidates in new_table.values_mut() {
                        candidates.sort_unstable_by(|a, b| a.cost.partial_cmp(&b.cost).unwrap_or(std::cmp::Ordering::Equal));
                    }
                    let count = new_table.len();
                    self.edge_state.route_table.store(Arc::new(new_table));
                    debug!("Route table updated: {} entries, max_ttl={}", count, new_max_ttl);
                }
            }
            "hub.contextActionModify" => {
                // Hub pushes a ContextActionModify to specific clients on this Edge.
                // Forward the ContextActionModify message to each targeted client.
                if let Some(params) = &notification.context_action_modify {
                    let Some(msg) = &params.action else { return; };
                    let target_sessions = &params.target_sessions;
                    if target_sessions.is_empty() {
                        // Broadcast to all local clients
                        self.edge_state.client_manager
                            .broadcast(MessageType::ContextActionModify, msg, None)
                            .await;
                        debug!("ContextActionModify broadcast to all clients: action={:?}", msg.action.as_str());
                    } else {
                        // Pre-encode once; use try_send_raw (non-blocking) so a slow
                        // client cannot stall the notification processor.
                        let mut buf = bytes::BytesMut::new();
                        munode_protocol::transport::encode_message(MessageType::ContextActionModify, msg, &mut buf);
                        let data = buf.freeze();
                        for &sid in target_sessions {
                            if let Some(sender) = self.edge_state.client_manager.get_sender(sid).await {
                                if !sender.try_send_raw(data.clone()) {
                                    warn!("Dropped ContextActionModify for slow session {}", sid);
                                }
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
                    if let Some(json_str) = &notification.unknown_params_json {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                            if let Some(channel_id) = val.get("channel_id").and_then(|v| v.as_u64()) {
                                let is_enter_restricted = val
                                    .get("is_enter_restricted")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                self.edge_state
                                    .permission_cache
                                    .retain(|&(_, ch), _| ch != channel_id as u32);
                                self.edge_state.clear_all_cached_whisper_routes();
                                debug!("ACL updated for channel {}, is_enter_restricted={}", channel_id, is_enter_restricted);
                                self.edge_state.emit(crate::state::EdgeEvent::AclUpdated {
                                    channel_id: channel_id as u32,
                                    is_enter_restricted,
                                });
                            }
                        }
                    }
                // Check for hub.ninjaConfig (uses unknown_params_json)
                } else if method == "hub.ninjaConfig" {
                    if let Some(json_str) = &notification.unknown_params_json {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                            if val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
                                let channels: Vec<u32> = val
                                    .get("ninja_channels")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| arr.iter()
                                        .filter_map(|v| v.as_u64().map(|n| n as u32))
                                        .collect())
                                    .unwrap_or_default();
                                let mut nc = self.edge_state.ninja_channels.write().await;
                                *nc = channels;
                                debug!("Ninja channels updated from Hub: {:?}", &*nc);
                            }
                        }
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
            suggest_version = limits.suggest_version.unwrap_or(0),
            suggest_positional = limits.suggest_positional.unwrap_or(false),
            suggest_push_to_talk = limits.suggest_push_to_talk.unwrap_or(false),
            welcome_text = limits.welcome_text.as_deref().unwrap_or(""),
            "Applying server limits from Hub"
        );
        if let Some(allow_ping) = limits.allow_ping {
            self.edge_state.allow_ping.store(allow_ping, std::sync::atomic::Ordering::Relaxed);
        }
        self.edge_state.max_bandwidth_bps.store(
            limits.max_bandwidth.unwrap_or(0),
            std::sync::atomic::Ordering::Relaxed,
        );
        self.edge_state.max_users.store(
            limits.max_users.unwrap_or(0),
            std::sync::atomic::Ordering::Relaxed,
        );
        if let Some(v) = limits.listeners_per_user {
            if v > 0 {
                self.edge_state.listeners_per_user.store(v, std::sync::atomic::Ordering::Relaxed);
            }
        }
        if let Some(v) = limits.listeners_per_channel {
            if v > 0 {
                self.edge_state.listeners_per_channel.store(v, std::sync::atomic::Ordering::Relaxed);
            }
        }
        *self.edge_state.hub_limits.write().await = Some(limits);
    }

}
