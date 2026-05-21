//! Hub event broadcast listener.
use super::connection::get_perm_cached;
use crate::handler;
use crate::hub_client::HubClient;
use crate::state::{EdgeEvent, EdgeState};
use munode_common::permission as perm;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use std::sync::Arc;
use tokio::sync::watch;
use tracing::{debug, info, warn};

/// Process a `HubRegistered` event: push fresh state to all authenticated local clients.
///
/// Called both from the normal event loop (`EdgeEvent::HubRegistered`) and directly from
/// the `Lagged` recovery path (where the event is drained from the channel inline to
/// break the lag→sync→lag feedback loop).
async fn handle_hub_registered(disappeared_session_ids: Vec<u32>, state: &Arc<EdgeState>) {
    // Hub reconnected — resume accepting new client connections.
    state
        .accepting_connections
        .store(true, std::sync::atomic::Ordering::Relaxed);

    let local_clients = state.client_manager.get_all_clients().await;
    let authenticated_clients: Vec<_> = local_clients
        .iter()
        .filter(|c| c.state == crate::client::ClientState::Ready)
        .collect();

    if authenticated_clients.is_empty() {
        info!("Hub registered — no authenticated clients to notify");
        return;
    }

    // 1. UserRemove for disappeared sessions.
    // Guard: never send UserRemove for session S to the client *with* session S.
    for &sid in &disappeared_session_ids {
        let remove_msg = handler::build_user_remove_msg(sid, None);
        for client in &authenticated_clients {
            if client.session == sid {
                continue;
            }
            state
                .client_manager
                .send_to(client.session, MessageType::UserRemove, &remove_msg)
                .await;
        }
    }
    if !disappeared_session_ids.is_empty() {
        info!(
            "Hub registered — sent UserRemove for {} disappeared session(s)",
            disappeared_session_ids.len()
        );
    }

    // 2. Re-announce all current remote users.
    let ninja_channels_snap: std::collections::HashSet<u32> =
        { state.ninja_channels.read().await.iter().copied().collect() };
    let ninja_visible = state.ninja_visible_to.read().await;
    let remote_users = state.channel_manager.get_all_remote_users().await;
    let local_session_set: std::collections::HashSet<u32> =
        authenticated_clients.iter().map(|c| c.session).collect();

    for user in &remote_users {
        if local_session_set.contains(&user.session_id) {
            continue;
        }
        let msg = mumbleproto::UserState {
            session: Some(user.session_id),
            user_id: if user.user_id > 0 {
                Some(user.user_id)
            } else {
                None
            },
            name: Some(user.username.clone()),
            channel_id: Some(user.channel_id),
            mute: if user.mute { Some(true) } else { None },
            deaf: if user.deaf { Some(true) } else { None },
            suppress: if user.suppress { Some(true) } else { None },
            self_mute: if user.self_mute { Some(true) } else { None },
            self_deaf: if user.self_deaf { Some(true) } else { None },
            priority_speaker: if user.priority_speaker {
                Some(true)
            } else {
                None
            },
            recording: if user.recording { Some(true) } else { None },
            hash: user.cert_hash.clone(),
            listening_channel_add: user.listening_channels.clone(),
            ..Default::default()
        };
        if ninja_channels_snap.contains(&user.channel_id) {
            for client in &authenticated_clients {
                let can_see = ninja_visible
                    .get(&client.session)
                    .map(|set| set.contains(&user.channel_id))
                    .unwrap_or(false);
                if can_see {
                    state
                        .client_manager
                        .send_to(client.session, MessageType::UserState, &msg)
                        .await;
                }
            }
        } else {
            for client in &authenticated_clients {
                state
                    .client_manager
                    .send_to(client.session, MessageType::UserState, &msg)
                    .await;
            }
        }
    }
    info!(
        "Hub registered — re-announced {} remote user(s) to {} local client(s)",
        remote_users.len(),
        authenticated_clients.len()
    );

    // 3. Re-broadcast channel states.
    let channels = state.channel_manager.get_channels_bfs().await;
    for ch in &channels {
        let ch_msg = handler::build_channel_state_msg(ch);
        for client in &authenticated_clients {
            state
                .client_manager
                .send_to(client.session, MessageType::ChannelState, &ch_msg)
                .await;
        }
    }
    debug!(
        "Hub registered — re-broadcast {} channel(s) to local clients",
        channels.len()
    );
}

/// Listen for events from the Hub and broadcast them to local clients.
pub(crate) async fn hub_event_listener(
    state: Arc<EdgeState>,
    event_rx: &mut tokio::sync::broadcast::Receiver<EdgeEvent>,
    shutdown_tx: watch::Sender<bool>,
    hub_client: Arc<HubClient>,
) {
    use tokio::sync::broadcast::error::RecvError;

    loop {
        match event_rx.recv().await {
            Ok(event) => {
                match event {
                    EdgeEvent::RemoteUserJoined {
                        session_id,
                        username,
                        channel_id,
                        is_ninja,
                    } => {
                        // Only broadcast for REMOTE users (not local clients - handled by main task)
                        if state.client_manager.get_client(session_id).await.is_none() {
                            if let Some(user) =
                                state.channel_manager.get_remote_user(session_id).await
                            {
                                // When announcing a newly-joined user we must NOT include Some(false)
                                // for boolean fields – the Mumble client interprets every present bool
                                // field as "this just changed to that value", triggering spurious
                                // notifications ("user unmuted", "user stopped recording", etc.).
                                // Only include a field when it is true (non-default).
                                // Also: only include user_id for registered users (user_id > 0);
                                // sending user_id=0 wrongly marks the guest as SuperUser.
                                let msg = mumbleproto::UserState {
                                    session: Some(user.session_id),
                                    user_id: if user.user_id > 0 {
                                        Some(user.user_id)
                                    } else {
                                        None
                                    },
                                    name: Some(user.username.clone()),
                                    channel_id: Some(user.channel_id),
                                    mute: if user.mute { Some(true) } else { None },
                                    deaf: if user.deaf { Some(true) } else { None },
                                    suppress: if user.suppress { Some(true) } else { None },
                                    self_mute: if user.self_mute { Some(true) } else { None },
                                    self_deaf: if user.self_deaf { Some(true) } else { None },
                                    priority_speaker: if user.priority_speaker {
                                        Some(true)
                                    } else {
                                        None
                                    },
                                    recording: if user.recording { Some(true) } else { None },
                                    hash: user.cert_hash.clone(),
                                    ..Default::default()
                                };
                                if is_ninja {
                                    // Channel Ninja: only send to clients who have Enter permission
                                    // Clients lacking both Enter+Listen permission won't see the user
                                    let local_clients =
                                        state.client_manager.get_all_clients().await;
                                    let visible_cache = state.ninja_visible_to.read().await;
                                    for client in local_clients {
                                        let can_see = visible_cache
                                            .get(&client.session)
                                            .map(|set| set.contains(&channel_id))
                                            .unwrap_or(false);
                                        if can_see {
                                            state
                                                .client_manager
                                                .send_to(
                                                    client.session,
                                                    MessageType::UserState,
                                                    &msg,
                                                )
                                                .await;
                                        }
                                    }
                                } else {
                                    state
                                        .client_manager
                                        .broadcast(MessageType::UserState, &msg, None)
                                        .await;
                                }
                            }
                        }
                        debug!(
                            "Broadcast remote user joined: {} (session {}, channel {}, ninja={})",
                            username, session_id, channel_id, is_ninja
                        );
                    }
                    EdgeEvent::RemoteUserLeft {
                        session_id,
                        channel_id,
                    } => {
                        let msg = handler::build_user_remove_msg(session_id, None);
                        // Channel Ninja: only send UserRemove to clients who could see the user.
                        let ninja_channels_snap: std::collections::HashSet<u32> =
                            state.ninja_channels.read().await.iter().copied().collect();
                        if ninja_channels_snap.contains(&channel_id) {
                            let all_clients = state.client_manager.get_all_clients().await;
                            let visible_cache = state.ninja_visible_to.read().await;
                            for client in &all_clients {
                                let can_see = visible_cache
                                    .get(&client.session)
                                    .map(|set| set.contains(&channel_id))
                                    .unwrap_or(false);
                                if can_see {
                                    state
                                        .client_manager
                                        .send_to(client.session, MessageType::UserRemove, &msg)
                                        .await;
                                }
                            }
                        } else {
                            state
                                .client_manager
                                .broadcast(MessageType::UserRemove, &msg, None)
                                .await;
                        }
                        debug!(
                            "Broadcast remote user left: session {} (channel {})",
                            session_id, channel_id
                        );
                    }
                    EdgeEvent::RemoteUserStateChanged {
                        session_id,
                        delta,
                        listening_channel_add,
                        listening_channel_remove,
                        actor_session,
                    } => {
                        // Only forward fields that ACTUALLY changed (carried by delta).
                        // Broadcasting the full current state would include Some(false) for
                        // unchanged default-off fields, triggering spurious client notifications.
                        let mut msg = mumbleproto::UserState {
                            session: Some(session_id),
                            actor: delta.actor_session.or(actor_session),
                            self_mute: delta.self_mute,
                            self_deaf: delta.self_deaf,
                            mute: delta.mute,
                            deaf: delta.deaf,
                            suppress: delta.suppress,
                            priority_speaker: delta.priority_speaker,
                            recording: delta.recording,
                            ..Default::default()
                        };
                        if !listening_channel_add.is_empty() {
                            msg.listening_channel_add = listening_channel_add;
                        }
                        if !listening_channel_remove.is_empty() {
                            msg.listening_channel_remove = listening_channel_remove;
                        }
                        // Channel Ninja: filter state-change notifications for users in ninja channels
                        let user_channel = if let Some(user) =
                            state.channel_manager.get_remote_user(session_id).await
                        {
                            Some(user.channel_id)
                        } else {
                            state
                                .client_manager
                                .get_client(session_id)
                                .await
                                .map(|user| user.channel_id)
                        };
                        let ninja_channels_snap: std::collections::HashSet<u32> =
                            state.ninja_channels.read().await.iter().copied().collect();
                        if let Some(ch) = user_channel {
                            if ninja_channels_snap.contains(&ch) {
                                let all_clients = state.client_manager.get_all_clients().await;
                                let visible_cache = state.ninja_visible_to.read().await;
                                for client in &all_clients {
                                    let can_see = visible_cache
                                        .get(&client.session)
                                        .map(|set| set.contains(&ch))
                                        .unwrap_or(false);
                                    if can_see {
                                        state
                                            .client_manager
                                            .send_to(client.session, MessageType::UserState, &msg)
                                            .await;
                                    }
                                }
                                debug!(
                                    "Broadcast remote user state changed (ninja): session {}",
                                    session_id
                                );
                            } else {
                                state
                                    .client_manager
                                    .broadcast(MessageType::UserState, &msg, None)
                                    .await;
                                debug!(
                                    "Broadcast remote user state changed: session {}",
                                    session_id
                                );
                            }
                        } else {
                            state
                                .client_manager
                                .broadcast(MessageType::UserState, &msg, None)
                                .await;
                            debug!(
                                "Broadcast remote user state changed: session {}",
                                session_id
                            );
                        }
                    }
                    EdgeEvent::RemoteUserMoved {
                        session_id,
                        from_channel_id,
                        channel_id,
                        actor_session,
                    } => {
                        // Channel Ninja: apply three-way visibility logic per observer.
                        // was_visible = observer could see user in from_channel
                        // now_visible = observer can see user in channel
                        // was && now  → send UserState{channel_id}   (normal move)
                        // was && !now → send UserRemove               (user "disappears")
                        // !was && now → send full UserState            (user "appears")
                        // !was && !was→ nothing
                        let ninja_channels_snap: std::collections::HashSet<u32> =
                            state.ninja_channels.read().await.iter().copied().collect();
                        let from_is_ninja = ninja_channels_snap.contains(&from_channel_id);
                        let to_is_ninja = ninja_channels_snap.contains(&channel_id);
                        if !from_is_ninja && !to_is_ninja {
                            // Simple case: no ninja channels involved, broadcast normally.
                            let msg = mumbleproto::UserState {
                                session: Some(session_id),
                                channel_id: Some(channel_id),
                                actor: Some(actor_session),
                                ..Default::default()
                            };
                            state
                                .client_manager
                                .broadcast(MessageType::UserState, &msg, None)
                                .await;
                        } else {
                            // At least one side is a ninja channel — apply per-observer logic.
                            let all_clients = state.client_manager.get_all_clients().await;
                            let visible_cache = state.ninja_visible_to.read().await;
                            // Build the full UserState for the "appears" case.
                            let full_msg_opt =
                                state.channel_manager.get_remote_user(session_id).await.map(
                                    |user| mumbleproto::UserState {
                                        session: Some(user.session_id),
                                        user_id: if user.user_id > 0 {
                                            Some(user.user_id)
                                        } else {
                                            None
                                        },
                                        name: Some(user.username.clone()),
                                        channel_id: Some(user.channel_id),
                                        mute: if user.mute { Some(true) } else { None },
                                        deaf: if user.deaf { Some(true) } else { None },
                                        suppress: if user.suppress { Some(true) } else { None },
                                        self_mute: if user.self_mute { Some(true) } else { None },
                                        self_deaf: if user.self_deaf { Some(true) } else { None },
                                        priority_speaker: if user.priority_speaker {
                                            Some(true)
                                        } else {
                                            None
                                        },
                                        recording: if user.recording { Some(true) } else { None },
                                        hash: user.cert_hash.clone(),
                                        ..Default::default()
                                    },
                                );
                            let move_msg = mumbleproto::UserState {
                                session: Some(session_id),
                                channel_id: Some(channel_id),
                                actor: Some(actor_session),
                                ..Default::default()
                            };
                            let remove_msg = handler::build_user_remove_msg(session_id, None);
                            for client in &all_clients {
                                let was_visible = if from_is_ninja {
                                    visible_cache
                                        .get(&client.session)
                                        .map(|s| s.contains(&from_channel_id))
                                        .unwrap_or(false)
                                } else {
                                    true
                                };
                                let now_visible = if to_is_ninja {
                                    visible_cache
                                        .get(&client.session)
                                        .map(|s| s.contains(&channel_id))
                                        .unwrap_or(false)
                                } else {
                                    true
                                };
                                match (was_visible, now_visible) {
                                    (true, true) => {
                                        state
                                            .client_manager
                                            .send_to(
                                                client.session,
                                                MessageType::UserState,
                                                &move_msg,
                                            )
                                            .await;
                                    }
                                    (true, false) => {
                                        state
                                            .client_manager
                                            .send_to(
                                                client.session,
                                                MessageType::UserRemove,
                                                &remove_msg,
                                            )
                                            .await;
                                    }
                                    (false, true) => {
                                        if let Some(ref full_msg) = full_msg_opt {
                                            state
                                                .client_manager
                                                .send_to(
                                                    client.session,
                                                    MessageType::UserState,
                                                    full_msg,
                                                )
                                                .await;
                                        }
                                    }
                                    (false, false) => {}
                                }
                            }
                        }
                        debug!(
                            "Broadcast remote user moved: session {} {} -> channel {}",
                            session_id, from_channel_id, channel_id
                        );
                    }
                    EdgeEvent::ChannelCreated { channel_id } => {
                        if let Some(ch) = state.channel_manager.get_channel(channel_id).await {
                            let msg = handler::build_channel_state_msg(&ch);
                            state
                                .client_manager
                                .broadcast(MessageType::ChannelState, &msg, None)
                                .await;
                        }
                        debug!("Broadcast channel created: {}", channel_id);
                    }
                    EdgeEvent::ChannelRemoved { channel_id } => {
                        let msg = mumbleproto::ChannelRemove { channel_id };
                        state
                            .client_manager
                            .broadcast(MessageType::ChannelRemove, &msg, None)
                            .await;
                        // Clean up the enter_restricted_cache for the deleted channel.
                        state.enter_restricted_cache.remove(&channel_id);
                        debug!("Broadcast channel removed: {}", channel_id);
                    }
                    EdgeEvent::ChannelUpdated {
                        channel_id,
                        links_add,
                        links_remove,
                    } => {
                        if let Some(ch) = state.channel_manager.get_channel(channel_id).await {
                            let mut msg = handler::build_channel_state_msg(&ch);
                            msg.links_add = links_add;
                            msg.links_remove = links_remove;
                            state
                                .client_manager
                                .broadcast(MessageType::ChannelState, &msg, None)
                                .await;
                        }
                        debug!("Broadcast channel updated: {}", channel_id);
                    }
                    EdgeEvent::HubRegistered {
                        disappeared_session_ids,
                    } => {
                        handle_hub_registered(disappeared_session_ids, &state).await;
                    }
                    EdgeEvent::HubDisconnected => {
                        warn!(
                            "All Hub control channels are currently down — continuing direct reconnect attempts and peer-relay fallback; local clients stay connected until Hub remains unreachable for 30s"
                        );
                    }
                    EdgeEvent::HubReconcileDisappeared { session_ids } => {
                        // Grace period elapsed after Hub cold restart.
                        // session_ids are remote sessions that never came back — evict them.
                        if !session_ids.is_empty() {
                            let local_clients = state.client_manager.get_all_clients().await;
                            let authenticated_clients: Vec<_> = local_clients
                                .iter()
                                .filter(|c| c.state == crate::client::ClientState::Ready)
                                .collect();
                            for &sid in &session_ids {
                                let remove_msg = handler::build_user_remove_msg(sid, None);
                                for client in &authenticated_clients {
                                    if client.session == sid {
                                        continue;
                                    }
                                    state
                                        .client_manager
                                        .send_to(
                                            client.session,
                                            MessageType::UserRemove,
                                            &remove_msg,
                                        )
                                        .await;
                                }
                            }
                            info!(
                                "Hub restart reconciliation: sent UserRemove for {} session(s) \
                                 that did not recover",
                                session_ids.len()
                            );
                        }
                    }
                    EdgeEvent::HubUnreachable => {
                        warn!(
                            "Hub is unreachable (>30s without connection) — disconnecting all clients and refusing new connections"
                        );
                        state
                            .accepting_connections
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                        state
                            .client_manager
                            .close_all_connections(
                                "Server temporarily unavailable, please reconnect later",
                            )
                            .await;
                    }
                    EdgeEvent::TextMessageForward {
                        actor,
                        message,
                        channel_id,
                        tree_id,
                        session,
                    } => {
                        let msg = mumbleproto::TextMessage {
                            actor: Some(actor),
                            message,
                            channel_id,
                            tree_id,
                            session,
                        };
                        // Send to targeted sessions on this edge, or broadcast to channels
                        if !msg.session.is_empty() {
                            for &target_session in &msg.session {
                                state
                                    .client_manager
                                    .send_to(target_session, MessageType::TextMessage, &msg)
                                    .await;
                            }
                        } else if !msg.channel_id.is_empty() {
                            for &ch_id in &msg.channel_id {
                                state
                                    .client_manager
                                    .broadcast_to_channel(
                                        ch_id,
                                        MessageType::TextMessage,
                                        &msg,
                                        None,
                                    )
                                    .await;
                            }
                        } else if !msg.tree_id.is_empty() {
                            // Collect all channels in the tree recursively
                            let mut all_channel_ids: std::collections::HashSet<u32> =
                                std::collections::HashSet::new();
                            let mut to_visit: std::collections::VecDeque<u32> =
                                msg.tree_id.iter().copied().collect();
                            while let Some(ch_id) = to_visit.pop_front() {
                                if all_channel_ids.insert(ch_id) {
                                    let children = state.channel_manager.get_children(ch_id).await;
                                    for child in children {
                                        to_visit.push_back(child);
                                    }
                                }
                            }
                            for ch_id in all_channel_ids {
                                state
                                    .client_manager
                                    .broadcast_to_channel(
                                        ch_id,
                                        MessageType::TextMessage,
                                        &msg,
                                        None,
                                    )
                                    .await;
                            }
                        }
                        debug!("Forwarded text message from remote actor {}", actor);
                    }
                    EdgeEvent::PluginDataBroadcast {
                        sender_session,
                        data_id,
                        data,
                        target_sessions,
                    } => {
                        let msg = mumbleproto::PluginDataTransmission {
                            sender_session: Some(sender_session),
                            data_id: Some(data_id.clone()),
                            data: Some(data),
                            receiver_sessions: vec![],
                        };
                        for &target_session in &target_sessions {
                            state
                                .client_manager
                                .send_to(target_session, MessageType::PluginDataTransmission, &msg)
                                .await;
                        }
                        debug!(
                            "Forwarded plugin data from session {}: {}",
                            sender_session, data_id
                        );
                    }
                    EdgeEvent::ShutdownRequested { reason } => {
                        // Hub requests graceful shutdown due to cluster partition.
                        // Send ServerReject to all connected clients so they reconnect elsewhere.
                        warn!("Shutdown requested: {}", reason);
                        let reject_msg = mumbleproto::Reject {
                            r#type: Some(mumbleproto::reject::RejectType::None as i32),
                            reason: Some(format!("Server shutting down: {}", reason)),
                        };
                        let authenticated_sessions =
                            state.client_manager.get_authenticated_sessions().await;
                        for session in authenticated_sessions {
                            state
                                .client_manager
                                .send_to(session, MessageType::Reject, &reject_msg)
                                .await;
                        }
                        // Give clients a moment to receive the reject, then exit gracefully
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                        warn!("Exiting due to hub shutdown request (cluster partition)");
                        // Signal the main accept loop to shut down gracefully.
                        let _ = shutdown_tx.send(true);
                        return;
                    }
                    EdgeEvent::PeerVoiceTcpFailed { peer_edge_id } => {
                        // All TCP voice connections to this peer have been down for an
                        // extended period.  Before reporting to Hub for partition arbitration,
                        // verify that NO viable path to this peer exists through any means.
                        //
                        // Partition arbitration (hub.peerLeft + potential hub.shutdownRequest)
                        // is a drastic, irreversible action that disconnects clients.  We must
                        // only trigger it when the peer is truly unreachable through every path:
                        //   1. DirectTcp: already confirmed down (this event was emitted)
                        //   2. HubTcp relay: must also be unavailable (Hub unreachable)
                        //   3. RelayChain: must have no working intermediate-hop routes

                        // Check 1: Hub TCP relay.
                        // If Hub is still reachable and hub_tcp_fallback is enabled, voice CAN
                        // still flow via Hub relay → the cluster is degraded but not partitioned.
                        // In this case the DirectTcp pool will continue retrying silently.
                        let hub_reachable = state
                            .accepting_connections
                            .load(std::sync::atomic::Ordering::Relaxed);
                        if hub_reachable && state.enable_hub_tcp_fallback {
                            debug!(
                                "Peer edge {} DirectTcp down but Hub TCP relay is available — \
                                 skipping partition report (voice flows via Hub relay)",
                                peer_edge_id
                            );
                            continue;
                        }

                        // Check 2: RelayChain and DirectUdp routes.
                        // Inspect the route table for any candidate whose next-hop has not
                        // exceeded the consecutive_failure_threshold.  If any such candidate
                        // exists (and it isn't HubTcp — already checked above — or DirectTcp
                        // — already known down), voice can still flow via that path.
                        let has_viable_non_tcp_route = {
                            use crate::state::RouteDecision;
                            use std::sync::atomic::Ordering;
                            let route_guard = state.route_table.load();
                            let threshold = state.consecutive_failure_threshold;
                            if let Some(candidates) = route_guard.get(&peer_edge_id) {
                                let failures_guard = state.next_hop_failures.read();
                                candidates.iter().any(|candidate| {
                                    match &candidate.decision {
                                        RouteDecision::DirectUdp => {
                                            // Check if direct UDP hop is healthy.
                                            if let Ok(ref failures) = failures_guard {
                                                let fail_count = failures
                                                    .get(&peer_edge_id)
                                                    .map(|a| a.load(Ordering::Relaxed))
                                                    .unwrap_or(0);
                                                threshold == 0 || fail_count < threshold
                                            } else {
                                                true // poisoned — assume viable
                                            }
                                        }
                                        RouteDecision::RelayChain { hops, .. } => {
                                            // Check if the first relay hop is healthy.
                                            if let Some(&first_hop) = hops.first() {
                                                if let Ok(ref failures) = failures_guard {
                                                    let fail_count = failures
                                                        .get(&first_hop)
                                                        .map(|a| a.load(Ordering::Relaxed))
                                                        .unwrap_or(0);
                                                    threshold == 0 || fail_count < threshold
                                                } else {
                                                    true // poisoned — assume viable
                                                }
                                            } else {
                                                false
                                            }
                                        }
                                        // DirectTcp: known down (this event was emitted because it failed).
                                        // HubTcp: Hub unreachable (already checked above); if we reach
                                        //         here hub_reachable is false OR fallback is disabled.
                                        RouteDecision::DirectTcp | RouteDecision::HubTcp => false,
                                    }
                                })
                            } else {
                                false // no routes at all for this peer
                            }
                        };

                        if has_viable_non_tcp_route {
                            debug!(
                                "Peer edge {} DirectTcp down but a relay/UDP route is still viable — \
                                 skipping partition report",
                                peer_edge_id
                            );
                            continue;
                        }

                        // All paths are confirmed down — report to Hub for partition arbitration.
                        // Hub waits for both sides to report before acting (arbitrate_disconnect),
                        // then broadcasts hub.peerLeft and may issue hub.shutdownRequest to the
                        // smaller partition.
                        warn!(
                            "Peer edge {}: all voice paths exhausted (DirectTcp down, Hub unreachable/disabled, \
                             no viable relay) — reporting partition to Hub",
                            peer_edge_id,
                        );
                        hub_client.do_report_peer_disconnect(peer_edge_id).await;
                    }
                    EdgeEvent::AclUpdated {
                        channel_id,
                        is_enter_restricted,
                    } => {
                        // An ACL was updated on the Hub; re-evaluate can_enter + is_enter_restricted
                        // for every local client and push a ChannelState update so the client's lock
                        // icon reflects the new permissions immediately.
                        //
                        // Mirrors Murmur's msgACL handler which, after saving the new ACL, loops over
                        // all connected users and sends:
                        //   mpcs.set_is_enter_restricted(isChannelEnterRestricted(c));  // channel-level
                        //   mpcs.set_can_enter(hasPermission(user, c, ChanACL::Enter)); // per-user
                        //
                        // `is_enter_restricted` is pre-computed by the Hub at ACL-save time and
                        // embedded in the notification — no extra RPC needed here.
                        debug!(
                            "ACL updated for channel {}, is_enter_restricted={}, refreshing enter state for all local sessions",
                            channel_id, is_enter_restricted
                        );
                        // Update the channel-level cache entry with the authoritative Hub value.
                        state
                            .enter_restricted_cache
                            .insert(channel_id, is_enter_restricted);
                        // Invalidate per-(session,channel) permission cache so all permission
                        // queries below fetch fresh values from Hub rather than stale data.
                        state
                            .permission_cache
                            .retain(|&(_, ch), _| ch != channel_id);
                        let all_clients = state.client_manager.get_all_clients().await;
                        for client in &all_clients {
                            let can_enter = get_perm_cached(
                                &hub_client,
                                &state,
                                client.session,
                                channel_id,
                                true,
                            )
                            .await
                                & perm::ENTER
                                != 0;
                            let ch_state = mumbleproto::ChannelState {
                                channel_id: Some(channel_id),
                                is_enter_restricted: Some(is_enter_restricted),
                                can_enter: Some(can_enter),
                                ..Default::default()
                            };
                            state
                                .client_manager
                                .send_to(client.session, MessageType::ChannelState, &ch_state)
                                .await;
                        }
                    }
                }
            }
            Err(RecvError::Lagged(count)) => {
                warn!(
                    count,
                    "Event listener lagged — triggering full re-sync to recover missed events"
                );
                let mut pending_hub_registered = match hub_client
                    .request_full_sync_with_reason("event listener lagged")
                    .await
                {
                    Ok(outcome) => Some(outcome.disappeared_session_ids),
                    Err(e) => {
                        warn!("Event listener lagged — runtime full-sync failed: {:#}", e);
                        None
                    }
                };
                if pending_hub_registered.is_none() {
                    continue;
                }
                // After the sync, the broadcast channel may have accumulated many stale events
                // (primarily high-frequency RelayedVoice packets) while the runtime full-sync was
                // queued or executing. Drain them now and keep only the latest HubRegistered, which
                // may supersede the sync result we just received if a newer ordered resync finished
                // before we caught up.
                loop {
                    match event_rx.try_recv() {
                        Ok(EdgeEvent::HubRegistered {
                            disappeared_session_ids,
                        }) => {
                            pending_hub_registered = Some(disappeared_session_ids);
                        }
                        Ok(_) => {}      // discard stale events (RelayedVoice, etc.)
                        Err(_) => break, // channel drained (Empty or Lagged — both mean stop here)
                    }
                }
                if let Some(disappeared) = pending_hub_registered {
                    handle_hub_registered(disappeared, &state).await;
                }
            }
            Err(RecvError::Closed) => {
                info!("Event channel closed");
                break;
            }
        }
    }
}
