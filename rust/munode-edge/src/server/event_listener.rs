//! Hub event broadcast listener.
use std::sync::Arc;
use tokio::sync::watch;
use tracing::{debug, info, trace, warn};
use munode_common::permission as perm;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use crate::handler;
use crate::hub_client::HubClient;
use crate::state::{EdgeEvent, EdgeState};
use crate::voice::{deliver_voice_tcp, wrap_udptunnel};
use super::connection::{decode_mumble_varint, get_perm_cached};

/// Listen for events from the Hub and broadcast them to local clients.
pub(crate) async fn hub_event_listener(    state: Arc<EdgeState>,
    event_rx: &mut tokio::sync::broadcast::Receiver<EdgeEvent>,
    shutdown_tx: watch::Sender<bool>,
    hub_client: Arc<HubClient>,
) {
    use tokio::sync::broadcast::error::RecvError;

    loop {
        match event_rx.recv().await {
            Ok(event) => {
                match event {
                    EdgeEvent::RemoteUserJoined { session_id, username, channel_id, is_ninja } => {
                        // Only broadcast for REMOTE users (not local clients - handled by main task)
                        if state.client_manager.get_client(session_id).await.is_none() {
                            if let Some(user) = state.channel_manager.get_remote_user(session_id).await {
                                // When announcing a newly-joined user we must NOT include Some(false)
                                // for boolean fields – the Mumble client interprets every present bool
                                // field as "this just changed to that value", triggering spurious
                                // notifications ("user unmuted", "user stopped recording", etc.).
                                // Only include a field when it is true (non-default).
                                // Also: only include user_id for registered users (user_id > 0);
                                // sending user_id=0 wrongly marks the guest as SuperUser.
                                let msg = mumbleproto::UserState {
                                    session: Some(user.session_id),
                                    user_id: if user.user_id > 0 { Some(user.user_id) } else { None },
                                    name: Some(user.username.clone()),
                                    channel_id: Some(user.channel_id),
                                    mute:             if user.mute             { Some(true) } else { None },
                                    deaf:             if user.deaf             { Some(true) } else { None },
                                    suppress:         if user.suppress         { Some(true) } else { None },
                                    self_mute:        if user.self_mute        { Some(true) } else { None },
                                    self_deaf:        if user.self_deaf        { Some(true) } else { None },
                                    priority_speaker: if user.priority_speaker { Some(true) } else { None },
                                    recording:        if user.recording        { Some(true) } else { None },
                                    hash: user.cert_hash.clone(),
                                    ..Default::default()
                                };
                                if is_ninja {
                                    // Channel Ninja: only send to clients who have Enter permission
                                    // Clients lacking both Enter+Listen permission won't see the user
                                    let local_clients = state.client_manager.get_all_clients().await;
                                    let visible_cache = state.ninja_visible_to.read().await;
                                    for client in local_clients {
                                        let can_see = visible_cache
                                            .get(&client.session)
                                            .map(|set| set.contains(&channel_id))
                                            .unwrap_or(false);
                                        if can_see {
                                            state.client_manager.send_to(client.session, MessageType::UserState, &msg).await;
                                        }
                                    }
                                } else {
                                    state.client_manager.broadcast(MessageType::UserState, &msg, None).await;
                                }
                            }
                        }
                        debug!("Broadcast remote user joined: {} (session {}, channel {}, ninja={})", username, session_id, channel_id, is_ninja);
                    }
                    EdgeEvent::RemoteUserLeft { session_id } => {
                        let msg = handler::build_user_remove_msg(session_id, None);
                        state.client_manager.broadcast(MessageType::UserRemove, &msg, None).await;
                        debug!("Broadcast remote user left: session {}", session_id);
                    }
                    EdgeEvent::RemoteUserStateChanged { session_id, delta, listening_channel_add, listening_channel_remove } => {
                        // Only forward fields that ACTUALLY changed (carried by delta).
                        // Broadcasting the full current state would include Some(false) for
                        // unchanged default-off fields, triggering spurious client notifications.
                        let mut msg = mumbleproto::UserState {
                            session: Some(session_id),
                            self_mute:        delta.self_mute,
                            self_deaf:        delta.self_deaf,
                            mute:             delta.mute,
                            deaf:             delta.deaf,
                            suppress:         delta.suppress,
                            priority_speaker: delta.priority_speaker,
                            recording:        delta.recording,
                            ..Default::default()
                        };
                        if !listening_channel_add.is_empty() {
                            msg.listening_channel_add = listening_channel_add;
                        }
                        if !listening_channel_remove.is_empty() {
                            msg.listening_channel_remove = listening_channel_remove;
                        }
                        state.client_manager.broadcast(MessageType::UserState, &msg, None).await;
                        debug!("Broadcast remote user state changed: session {}", session_id);
                    }
                    EdgeEvent::RemoteUserMoved { session_id, channel_id, actor_session } => {
                        let msg = mumbleproto::UserState {
                            session: Some(session_id),
                            channel_id: Some(channel_id),
                            actor: Some(actor_session),
                            ..Default::default()
                        };
                        state.client_manager.broadcast(MessageType::UserState, &msg, None).await;
                        debug!("Broadcast remote user moved: session {} -> channel {}", session_id, channel_id);
                    }
                    EdgeEvent::ChannelCreated { channel_id } => {
                        if let Some(ch) = state.channel_manager.get_channel(channel_id).await {
                            let msg = handler::build_channel_state_msg(&ch);
                            state.client_manager.broadcast(MessageType::ChannelState, &msg, None).await;
                        }
                        debug!("Broadcast channel created: {}", channel_id);
                    }
                    EdgeEvent::ChannelRemoved { channel_id } => {
                        let msg = mumbleproto::ChannelRemove { channel_id };
                        state.client_manager.broadcast(MessageType::ChannelRemove, &msg, None).await;
                        debug!("Broadcast channel removed: {}", channel_id);
                    }
                    EdgeEvent::ChannelUpdated { channel_id, links_add, links_remove } => {
                        if let Some(ch) = state.channel_manager.get_channel(channel_id).await {
                            let mut msg = handler::build_channel_state_msg(&ch);
                            msg.links_add = links_add;
                            msg.links_remove = links_remove;
                            state.client_manager.broadcast(MessageType::ChannelState, &msg, None).await;
                        }
                        debug!("Broadcast channel updated: {}", channel_id);
                    }
                    EdgeEvent::HubRegistered { disappeared_session_ids } => {
                        // Hub reconnected — resume accepting new client connections.
                        state.accepting_connections.store(true, std::sync::atomic::Ordering::Relaxed);
                        // After Hub reconnect / full-sync, resync the local clients' view of the
                        // world:
                        //  1. Send UserRemove for sessions that disappeared from Hub's snapshot
                        //     (protects against zombie users left over from before the reconnect).
                        //  2. Re-announce every remote user currently in the cache so clients that
                        //     were already connected during the reconnect see new/updated users.
                        //  3. Re-broadcast channel states so clients see any channel changes.
                        let local_clients = state.client_manager.get_all_clients().await;
                        let authenticated_clients: Vec<_> = local_clients
                            .iter()
                            .filter(|c| c.state == crate::client::ClientState::Ready)
                            .collect();

                        if authenticated_clients.is_empty() {
                            info!("Hub registered — no authenticated clients to notify");
                        } else {
                            // 1. UserRemove for disappeared sessions.
                            // Guard: never send UserRemove for session S to the client *with* session S.
                            // A client receiving UserRemove for its own session would interpret it as
                            // being kicked, showing a "left the channel" state even though the TCP
                            // connection is still alive.
                            for &sid in &disappeared_session_ids {
                                let remove_msg = handler::build_user_remove_msg(sid, None);
                                for client in &authenticated_clients {
                                    if client.session == sid { continue; }
                                    state.client_manager.send_to(client.session, MessageType::UserRemove, &remove_msg).await;
                                }
                            }
                            if !disappeared_session_ids.is_empty() {
                                info!("Hub registered — sent UserRemove for {} disappeared session(s)", disappeared_session_ids.len());
                            }

                            // 2. Re-announce all current remote users (only true-booleans to avoid spurious notifications)
                            let ninja_channels_snap: std::collections::HashSet<u32> = {
                                state.ninja_channels.read().await.iter().copied().collect()
                            };
                            let ninja_visible = state.ninja_visible_to.read().await;
                            let remote_users = state.channel_manager.get_all_remote_users().await;
                            let local_session_set: std::collections::HashSet<u32> =
                                authenticated_clients.iter().map(|c| c.session).collect();

                            for user in &remote_users {
                                // Skip our own edge's users (tracked via client_manager)
                                if local_session_set.contains(&user.session_id) { continue; }
                                // Ninja channel visibility check
                                if ninja_channels_snap.contains(&user.channel_id) {
                                    // Only send to clients who can see this channel
                                    let msg = mumbleproto::UserState {
                                        session: Some(user.session_id),
                                        user_id: if user.user_id > 0 { Some(user.user_id) } else { None },
                                        name: Some(user.username.clone()),
                                        channel_id: Some(user.channel_id),
                                        mute:             if user.mute             { Some(true) } else { None },
                                        deaf:             if user.deaf             { Some(true) } else { None },
                                        suppress:         if user.suppress         { Some(true) } else { None },
                                        self_mute:        if user.self_mute        { Some(true) } else { None },
                                        self_deaf:        if user.self_deaf        { Some(true) } else { None },
                                        priority_speaker: if user.priority_speaker { Some(true) } else { None },
                                        recording:        if user.recording        { Some(true) } else { None },
                                        hash: user.cert_hash.clone(),
                                        ..Default::default()
                                    };
                                    for client in &authenticated_clients {
                                        let can_see = ninja_visible
                                            .get(&client.session)
                                            .map(|set| set.contains(&user.channel_id))
                                            .unwrap_or(false);
                                        if can_see {
                                            state.client_manager.send_to(client.session, MessageType::UserState, &msg).await;
                                        }
                                    }
                                } else {
                                    let msg = mumbleproto::UserState {
                                        session: Some(user.session_id),
                                        user_id: if user.user_id > 0 { Some(user.user_id) } else { None },
                                        name: Some(user.username.clone()),
                                        channel_id: Some(user.channel_id),
                                        mute:             if user.mute             { Some(true) } else { None },
                                        deaf:             if user.deaf             { Some(true) } else { None },
                                        suppress:         if user.suppress         { Some(true) } else { None },
                                        self_mute:        if user.self_mute        { Some(true) } else { None },
                                        self_deaf:        if user.self_deaf        { Some(true) } else { None },
                                        priority_speaker: if user.priority_speaker { Some(true) } else { None },
                                        recording:        if user.recording        { Some(true) } else { None },
                                        hash: user.cert_hash.clone(),
                                        ..Default::default()
                                    };
                                    for client in &authenticated_clients {
                                        state.client_manager.send_to(client.session, MessageType::UserState, &msg).await;
                                    }
                                }
                            }
                            info!("Hub registered — re-announced {} remote user(s) to {} local client(s)",
                                remote_users.len(), authenticated_clients.len());

                            // 3. Re-broadcast channel states so clients see any channel changes
                            let channels = state.channel_manager.get_channels_bfs().await;
                            for ch in &channels {
                                let ch_msg = handler::build_channel_state_msg(ch);
                                for client in &authenticated_clients {
                                    state.client_manager.send_to(client.session, MessageType::ChannelState, &ch_msg).await;
                                }
                            }
                            debug!("Hub registered — re-broadcast {} channel(s) to local clients", channels.len());
                        }
                    }
                    EdgeEvent::HubDisconnected => {
                        warn!("Hub disconnected - local clients will continue but some features unavailable");
                    }
                    EdgeEvent::HubUnreachable => {
                        warn!("Hub is unreachable (>30s without connection) — disconnecting all clients and refusing new connections");
                        state.accepting_connections.store(false, std::sync::atomic::Ordering::Relaxed);
                        state.client_manager.close_all_connections(
                            "Server temporarily unavailable, please reconnect later",
                        ).await;
                    }
                    EdgeEvent::TextMessageForward { actor, message, channel_id, tree_id, session } => {
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
                                state.client_manager.send_to(target_session, MessageType::TextMessage, &msg).await;
                            }
                        } else if !msg.channel_id.is_empty() {
                            for &ch_id in &msg.channel_id {
                                state.client_manager.broadcast_to_channel(ch_id, MessageType::TextMessage, &msg, None).await;
                            }
                        } else if !msg.tree_id.is_empty() {
                            // Collect all channels in the tree recursively
                            let mut all_channel_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
                            let mut to_visit: std::collections::VecDeque<u32> = msg.tree_id.iter().copied().collect();
                            while let Some(ch_id) = to_visit.pop_front() {
                                if all_channel_ids.insert(ch_id) {
                                    let children = state.channel_manager.get_children(ch_id).await;
                                    for child in children {
                                        to_visit.push_back(child);
                                    }
                                }
                            }
                            for ch_id in all_channel_ids {
                                state.client_manager.broadcast_to_channel(ch_id, MessageType::TextMessage, &msg, None).await;
                            }
                        }
                        debug!("Forwarded text message from remote actor {}", actor);
                    }
                    EdgeEvent::PluginDataBroadcast { sender_session, data_id, data, target_sessions } => {
                        let msg = mumbleproto::PluginDataTransmission {
                            sender_session: Some(sender_session),
                            data_id: Some(data_id.clone()),
                            data: Some(data),
                            receiver_sessions: vec![],
                        };
                        for &target_session in &target_sessions {
                            state.client_manager.send_to(
                                target_session, MessageType::PluginDataTransmission, &msg
                            ).await;
                        }
                        debug!("Forwarded plugin data from session {}: {}", sender_session, data_id);
                    }
                    EdgeEvent::RelayedVoice { voice_packet } => {
                        // Voice relayed from another edge via Hub TCP.
                        // Standard Mumble server-to-client format:
                        //   [header(1B)][sender_session_varint][sequence_varint][voice_data]
                        if voice_packet.len() < 2 {
                            continue;
                        }
                        let raw_target = voice_packet[0] & 0x1F;
                        if raw_target == 31 {
                            // Loopback — ignore cross-edge loopback
                            continue;
                        }
                        let sender_session = match decode_mumble_varint(&voice_packet[1..]) {
                            Some((s, _)) => s,
                            None => {
                                debug!("RelayedVoice: failed to parse sender session");
                                continue;
                            }
                        };

                        let my_edge_id = state.get_edge_id();
                        {
                            let hex: String = voice_packet.iter().take(16)
                                .map(|b| format!("{:02X}", b))
                                .collect::<Vec<_>>()
                                .join(" ");
                            trace!("edge={} RelayedVoice recv: len={} header=0x{:02X} target={} session={} bytes=[{}]",
                                my_edge_id, voice_packet.len(), voice_packet[0], raw_target, sender_session, hex);
                        }

                        // For PTT (target=0), the sender's channel is required by compute_voice_targets.
                        let sender_channel = if raw_target == 0 {
                            match state.channel_manager.get_remote_user(sender_session).await {
                                Some(ru) => ru.channel_id,
                                None => {
                                    debug!("edge={} RelayedVoice PTT: unknown remote session {}", my_edge_id, sender_session);
                                    continue;
                                }
                            }
                        } else {
                            0 // unused for whisper (target 1..=30)
                        };

                        // compute_voice_targets handles VoiceTarget lookup, channel + listener
                        // expansion, and deaf filtering — identical logic to the local TCP path.
                        // relay_edge_ids is intentionally ignored: the sending edge already
                        // handled inter-edge relay for this packet.
                        let Some(targets) = crate::routing::compute_voice_targets(
                            &voice_packet, sender_session, sender_channel, &state,
                        ).await else {
                            debug!("edge={} RelayedVoice: no targets for session {} target {}",
                                my_edge_id, sender_session, raw_target);
                            continue;
                        };

                        if targets.is_whisper {
                            // voice_packet[0] carries raw voice_target_id in low 5 bits;
                            // overwrite with AudioContext per Mumble protocol.
                            let mut pkt = voice_packet.clone();
                            pkt[0] = (voice_packet[0] & 0xe0) | 2;
                            let frame_whisper = wrap_udptunnel(&pkt);
                            pkt[0] = (voice_packet[0] & 0xe0) | 1;
                            let frame_shout = wrap_udptunnel(&pkt);
                            let d = deliver_voice_tcp(&targets.direct_sessions, &frame_whisper)
                                + deliver_voice_tcp(&targets.channel_sessions, &frame_shout);
                            trace!("edge={} Delivered relayed whisper from session {} to {} targets",
                                my_edge_id, sender_session, d);
                        } else {
                            // voice_packet[0] already has context=0 (set by the sending edge for PTT).
                            let frame = wrap_udptunnel(&voice_packet);
                            let d = deliver_voice_tcp(&targets.local_sessions, &frame);
                            trace!("edge={} Delivered relayed broadcast from session {} to {} local clients",
                                my_edge_id, sender_session, d);
                        }
                    }
                    EdgeEvent::ShutdownRequested { reason } => {
                        // Hub requests graceful shutdown due to cluster partition.
                        // Send ServerReject to all connected clients so they reconnect elsewhere.
                        warn!("Shutdown requested: {}", reason);
                        let reject_msg = mumbleproto::Reject {
                            r#type: Some(mumbleproto::reject::RejectType::None as i32),
                            reason: Some(format!("Server shutting down: {}", reason)),
                        };
                        let authenticated_sessions = state.client_manager.get_authenticated_sessions().await;
                        for session in authenticated_sessions {
                            state.client_manager.send_to(
                                session,
                                MessageType::Reject,
                                &reject_msg,
                            ).await;
                        }
                        // Give clients a moment to receive the reject, then exit gracefully
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                        warn!("Exiting due to hub shutdown request (cluster partition)");
                        // Signal the main accept loop to shut down gracefully.
                        let _ = shutdown_tx.send(true);
                        return;
                    }
                    EdgeEvent::AclUpdated { channel_id } => {
                        // An ACL was updated on the Hub; re-evaluate can_enter for every local
                        // client on the affected channel and push a ChannelState update so the
                        // client's lock icon reflects the new permissions immediately.
                        debug!("ACL updated for channel {}, refreshing can_enter for all local sessions", channel_id);
                        // Invalidate cached permissions for this channel so all queries below
                        // fetch fresh values from Hub rather than returning stale data.
                        state.permission_cache.retain(|&(_, ch), _| ch != channel_id);
                        let all_clients = state.client_manager.get_all_clients().await;
                        for client in all_clients {
                            let can_enter = get_perm_cached(&hub_client, &state, client.session, channel_id, true).await
                                & perm::ENTER != 0;
                            let ch_state = mumbleproto::ChannelState {
                                channel_id: Some(channel_id),
                                is_enter_restricted: Some(!can_enter),
                                can_enter: Some(can_enter),
                                ..Default::default()
                            };
                            state.client_manager.send_to(client.session, MessageType::ChannelState, &ch_state).await;
                        }
                    }
                }
            }
            Err(RecvError::Lagged(count)) => {
                warn!(
                    count,
                    "Event listener lagged — triggering full re-sync to recover missed events"
                );
                hub_client.request_full_sync().await;
            }
            Err(RecvError::Closed) => {
                info!("Event channel closed");
                break;
            }
        }
    }
}
