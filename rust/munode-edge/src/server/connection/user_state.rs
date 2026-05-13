//! UserState update handlers: self-initiated and admin-initiated state changes.
use super::helpers::{get_perm_cached, hex_to_bytes};
use crate::handler;
use crate::hub_client::HubClient;
use crate::state::EdgeState;
use munode_common::permission as perm;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use std::sync::Arc;
use tracing::{debug, warn};

/// Handle a UserState update from a local client.
pub(super) async fn handle_user_state_update(
    edge_state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
    session_id: u32,
    user_state: &mumbleproto::UserState,
) {
    let mut needs_broadcast = false;
    let mut channel_moved = false;
    let mut suppress_changed = false;
    let mut old_channel_id: u32 = 0; // captured before move for ninja visibility logic

    if let Some(mut client) = edge_state.client_manager.get_client(session_id).await {
        // 9.1 Channel move with permission check
        if let Some(target_channel_id) = user_state.channel_id {
            if client.channel_id != target_channel_id {
                old_channel_id = client.channel_id; // capture BEFORE move
                // Check Enter permission on target channel via Hub
                let can_enter = get_perm_cached(
                    &hub_client,
                    &edge_state,
                    session_id,
                    target_channel_id,
                    true,
                )
                .await
                    & perm::ENTER
                    != 0;
                if can_enter {
                    // Compute the effective user limit for the target channel before
                    // any locks are held, so we only need to pass it to the atomic move.
                    let effective_limit = if let Some(ch) = edge_state
                        .channel_manager
                        .get_channel(target_channel_id)
                        .await
                    {
                        if ch.max_users > 0 {
                            ch.max_users
                        } else {
                            let hub_limits = edge_state.hub_limits.read().await;
                            hub_limits
                                .as_ref()
                                .and_then(|l| {
                                    if l.max_users_per_channel.unwrap_or(0) > 0 {
                                        l.max_users_per_channel
                                    } else {
                                        None
                                    }
                                })
                                .unwrap_or(0)
                        }
                    } else {
                        0
                    };

                    // Check Speak permission before the atomic move so we know the
                    // suppress flag to set without holding any internal locks.
                    let can_speak = get_perm_cached(
                        &hub_client,
                        &edge_state,
                        session_id,
                        target_channel_id,
                        true,
                    )
                    .await
                        & perm::SPEAK
                        != 0;
                    let new_suppress = !can_speak;

                    debug!(
                        "User {} moving to channel {}",
                        session_id, target_channel_id
                    );

                    // Atomically check capacity and update channel membership.
                    // This replaces the previous non-atomic count_in_channel + move_client_to_channel
                    // pattern, which was susceptible to a TOCTOU race where multiple concurrent tasks
                    // could all observe "channel not full" and all complete the move, exceeding the limit.
                    match edge_state
                        .client_manager
                        .move_client_to_channel_checked(
                            session_id,
                            target_channel_id,
                            new_suppress,
                            effective_limit,
                        )
                        .await
                    {
                        Ok(()) => {
                            suppress_changed = new_suppress != client.suppress;
                            client.channel_id = target_channel_id;
                            client.suppress = new_suppress;
                            needs_broadcast = true;
                            channel_moved = true;
                        }
                        Err(()) => {
                            // Atomic capacity check failed: channel is full.
                            debug!(
                                "Channel {} is full, denying move for session {}",
                                target_channel_id, session_id
                            );
                            if let Some(sender) =
                                edge_state.client_manager.get_sender(session_id).await
                            {
                                let pq = mumbleproto::PermissionDenied {
                                    r#type: Some(
                                        mumbleproto::permission_denied::DenyType::ChannelFull
                                            as i32,
                                    ),
                                    channel_id: Some(target_channel_id),
                                    reason: Some("Channel is full".to_string()),
                                    ..Default::default()
                                };
                                sender
                                    .send_message(MessageType::PermissionDenied, &pq)
                                    .await;
                            }
                            return;
                        }
                    }
                } else {
                    debug!(
                        "Channel move denied for session {} → channel {} (no Enter permission)",
                        session_id, target_channel_id
                    );
                    // Send permission denied back to client
                    if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(
                                mumbleproto::permission_denied::DenyType::Permission as i32,
                            ),
                            permission: Some(perm::ENTER),
                            channel_id: Some(target_channel_id),
                            session: Some(session_id),
                            ..Default::default()
                        };
                        sender
                            .send_message(MessageType::PermissionDenied, &pq)
                            .await;
                    }
                    return;
                }
            }
        }

        // Self-deaf update: self_deaf=true implies self_mute=true (Mumble protocol coupling).
        if let Some(self_deaf) = user_state.self_deaf {
            client.self_deaf = self_deaf;
            if self_deaf {
                client.self_mute = true; // deaf always implies mute
            }
            needs_broadcast = true;
        }
        // Self-mute update: self_mute=false implies self_deaf=false.
        if let Some(self_mute) = user_state.self_mute {
            client.self_mute = self_mute;
            if !self_mute {
                client.self_deaf = false; // un-muting also clears deaf
            }
            needs_broadcast = true;
        }

        // 9.2 mute/deaf/suppress/priority_speaker are SERVER-ADMIN-only fields.
        // Per Murmur (Messages.cpp msgUserState), modifying these requires the
        // MuteDeafen ACL permission.  A client targeting its own session that
        // sends these fields (e.g. as part of its initial resumption state on
        // connect) must have that permission; regular users do not, so we
        // silently ignore them here.  Legitimate admin operations arrive through
        // handle_admin_user_state_update which carries proper permission checks.
        // Accepting these fields here would let a Mumble client trigger
        // spurious "Server opened mic/speaker" notifications on every connect.

        // 9.2b Registration: client requesting self-registration by setting user_id.
        // Requires SelfRegister permission on root channel and a valid certificate.
        // Murmur: if target == actor → SelfRegisterPermission; else → RegisterPermission.
        if user_state.user_id.is_some() {
            // Check SelfRegister permission on root channel (channel 0)
            let has_self_register = get_perm_cached(&hub_client, &edge_state, session_id, 0, false)
                .await
                & perm::SELF_REGISTER
                != 0;
            if !has_self_register || client.user_id > 0 {
                // Already registered or no SelfRegister permission
                if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        permission: Some(perm::SELF_REGISTER),
                        channel_id: Some(0),
                        session: Some(session_id),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }
            // Certificate is required to register
            if client.cert_hash.is_none() {
                if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(
                            mumbleproto::permission_denied::DenyType::MissingCertificate as i32,
                        ),
                        session: Some(session_id),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }
            // Registration not yet implemented — deny with a text message.
            // TODO: implement Hub-side user registration RPC.
            if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                let pq = mumbleproto::PermissionDenied {
                    r#type: Some(mumbleproto::permission_denied::DenyType::Text as i32),
                    reason: Some(
                        "Self-registration is not yet supported on this server".to_string(),
                    ),
                    ..Default::default()
                };
                sender
                    .send_message(MessageType::PermissionDenied, &pq)
                    .await;
            }
            return;
        }

        // 9.3 Recording flag (anyone can mark themselves as recording).
        // Only broadcast when the value actually changed — Murmur only sets
        // bBroadcast if `pDstServerUser->bRecording != msg.recording()`, so
        // a client resending `recording=false` on connect should NOT generate
        // a "User stopped recording" notification on other clients.
        if let Some(rec) = user_state.recording {
            if rec != client.recording {
                client.recording = rec;
                needs_broadcast = true;
            }
        }

        // 9.4 Listening channel add/remove
        let mut actually_added_channels: Vec<u32> = Vec::new();
        if !user_state.listening_channel_add.is_empty()
            || !user_state.listening_channel_remove.is_empty()
        {
            for &ch in &user_state.listening_channel_add {
                // Check per-user listener limit using the local clone's length;
                // add_listener_checked keeps sessions in sync so the length is accurate
                // even for channels added earlier in this same loop.
                let per_user_limit = edge_state
                    .listeners_per_user
                    .load(std::sync::atomic::Ordering::Relaxed);
                if per_user_limit > 0 && client.listening_channels.len() as u32 >= per_user_limit {
                    debug!(
                        "Listener limit ({}) reached for session {}",
                        per_user_limit, session_id
                    );
                    if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(
                                mumbleproto::permission_denied::DenyType::ChannelFull as i32,
                            ),
                            channel_id: Some(ch),
                            reason: Some(format!(
                                "Listener limit reached: you may listen to at most {} channel(s) simultaneously",
                                per_user_limit
                            )),
                            ..Default::default()
                        };
                        sender
                            .send_message(MessageType::PermissionDenied, &pq)
                            .await;
                    }
                    continue;
                }

                // Check Listen permission (0x800) before the atomic add.
                let can_listen = get_perm_cached(&hub_client, &edge_state, session_id, ch, true)
                    .await
                    & perm::LISTEN
                    != 0;
                if !can_listen {
                    debug!("Listen denied for session {} on channel {}", session_id, ch);
                    if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(
                                mumbleproto::permission_denied::DenyType::Permission as i32,
                            ),
                            permission: Some(perm::LISTEN),
                            channel_id: Some(ch),
                            session: Some(session_id),
                            ..Default::default()
                        };
                        sender
                            .send_message(MessageType::PermissionDenied, &pq)
                            .await;
                    }
                    continue;
                }

                // Atomically check per-channel capacity and register the listener.
                // This replaces the previous non-atomic get_listening_count + deferred
                // update_client pattern, eliminating the TOCTOU race where multiple tasks
                // could both observe "channel has room" and both complete the add.
                let per_channel_limit = edge_state
                    .listeners_per_channel
                    .load(std::sync::atomic::Ordering::Relaxed);
                let added = edge_state
                    .client_manager
                    .add_listener_checked(session_id, ch, per_channel_limit)
                    .await;

                if added {
                    // Keep the local client clone in sync so the per-user limit check
                    // above remains accurate for subsequent channels in this loop.
                    if !client.listening_channels.contains(&ch) {
                        client.listening_channels.push(ch);
                    }
                    actually_added_channels.push(ch);
                } else {
                    debug!(
                        "Channel {} listener limit ({}) reached",
                        ch, per_channel_limit
                    );
                    if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(
                                mumbleproto::permission_denied::DenyType::ChannelFull as i32,
                            ),
                            channel_id: Some(ch),
                            reason: Some(format!(
                                "Channel listener limit reached: this channel allows at most {} listener(s)",
                                per_channel_limit
                            )),
                            ..Default::default()
                        };
                        sender
                            .send_message(MessageType::PermissionDenied, &pq)
                            .await;
                    }
                }
            }
            client
                .listening_channels
                .retain(|ch| !user_state.listening_channel_remove.contains(ch));
            // Remove volume adjustments for channels that were removed
            for &ch in &user_state.listening_channel_remove {
                client.listening_volume_adjustments.remove(&ch);
            }
            needs_broadcast = true;
        }

        // Volume adjustments for listened channels
        if !user_state.listening_volume_adjustment.is_empty() {
            for va in &user_state.listening_volume_adjustment {
                if let (Some(ch), Some(vol)) = (va.listening_channel, va.volume_adjustment) {
                    if vol == 1.0 {
                        client.listening_volume_adjustments.remove(&ch);
                    } else {
                        client.listening_volume_adjustments.insert(ch, vol);
                    }
                }
            }
            needs_broadcast = true;
        }

        // Positional audio plugin context update
        if let Some(ref ctx) = user_state.plugin_context {
            edge_state
                .client_manager
                .update_plugin_context(session_id, ctx.clone())
                .await;
        }

        // Texture / comment blob updates (upload to Hub and broadcast hash to peers)
        if let Some(texture_data) = &user_state.texture {
            // Enforce image_message_length limit on texture uploads
            let image_limit = edge_state
                .hub_limits
                .read()
                .await
                .as_ref()
                .and_then(|l| l.image_message_length)
                .unwrap_or(0);
            if image_limit > 0 && texture_data.len() as u32 > image_limit {
                warn!(
                    "Session {} texture too large ({} > {} bytes), rejecting",
                    session_id,
                    texture_data.len(),
                    image_limit
                );
                if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::TextTooLong as i32),
                        reason: Some(format!(
                            "Texture too large: {} > {} bytes",
                            texture_data.len(),
                            image_limit
                        )),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
            } else if !texture_data.is_empty() {
                let uid = client.user_id;
                let data = texture_data.clone();
                if let Some(hash_hex) = hub_client.blob_set_user_texture(uid, data).await {
                    // Convert hex hash to bytes for the Mumble texture_hash field
                    if let Some(hash_bytes) = hex_to_bytes(&hash_hex) {
                        // Broadcast the hash to all connected clients so they can
                        // request the texture via RequestBlob.
                        let hash_msg = mumbleproto::UserState {
                            session: Some(session_id),
                            actor: Some(session_id),
                            texture_hash: Some(hash_bytes.clone()),
                            ..Default::default()
                        };
                        client.texture_hash = Some(hash_bytes);
                        edge_state
                            .client_manager
                            .update_client(client.clone())
                            .await;
                        edge_state
                            .client_manager
                            .broadcast(MessageType::UserState, &hash_msg, None)
                            .await;
                    }
                }
            }
        }
        if let Some(comment) = &user_state.comment {
            // Enforce image_message_length limit on comment uploads (same limit as Murmur)
            let image_limit = edge_state
                .hub_limits
                .read()
                .await
                .as_ref()
                .and_then(|l| l.image_message_length)
                .unwrap_or(0);
            if image_limit > 0 && comment.len() as u32 > image_limit {
                warn!(
                    "Session {} comment too large ({} > {} bytes), rejecting",
                    session_id,
                    comment.len(),
                    image_limit
                );
                if let Some(sender) = edge_state.client_manager.get_sender(session_id).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::TextTooLong as i32),
                        reason: Some(format!(
                            "Comment too large: {} > {} bytes",
                            comment.len(),
                            image_limit
                        )),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
            } else {
                let uid = client.user_id;
                let data = comment.as_bytes().to_vec();
                let data_len = data.len();
                if data_len > 128 {
                    // Long comments: persist to blob store and broadcast the hash so
                    // peers can request the full text via RequestBlob.
                    if let Some(hash_hex) = hub_client.blob_set_user_comment(uid, data).await {
                        if let Some(hash_bytes) = hex_to_bytes(&hash_hex) {
                            let hash_msg = mumbleproto::UserState {
                                session: Some(session_id),
                                actor: Some(session_id),
                                comment_hash: Some(hash_bytes.clone()),
                                ..Default::default()
                            };
                            client.comment_hash = Some(hash_bytes);
                            edge_state
                                .client_manager
                                .update_client(client.clone())
                                .await;
                            edge_state
                                .client_manager
                                .broadcast(MessageType::UserState, &hash_msg, None)
                                .await;
                        }
                    }
                } else {
                    // Short comments: broadcast inline immediately.  Also persist to
                    // blob store for later retrieval, but don't gate the broadcast on it.
                    let inline_msg = mumbleproto::UserState {
                        session: Some(session_id),
                        actor: Some(session_id),
                        comment: Some(comment.clone()),
                        ..Default::default()
                    };
                    client.comment_hash = None;
                    edge_state
                        .client_manager
                        .update_client(client.clone())
                        .await;
                    edge_state
                        .client_manager
                        .broadcast(MessageType::UserState, &inline_msg, None)
                        .await;
                    hub_client.blob_set_user_comment(uid, data).await;
                }
            } // end of else (size limit check)
        }

        if needs_broadcast {
            edge_state
                .client_manager
                .update_client(client.clone())
                .await;

            // Build a targeted state-change message containing ONLY the changed fields
            // with their ACTUAL boolean values (including `false`).
            //
            // Using build_user_state_msg() here would be wrong: it omits false-valued
            // fields (returns None), so observers can never learn about state transitions
            // like self_mute going true→false (un-mute).
            let mut broadcast_msg = mumbleproto::UserState {
                session: Some(session_id),
                actor: Some(session_id),
                ..Default::default()
            };

            if channel_moved {
                broadcast_msg.channel_id = Some(client.channel_id);
                // Only include suppress when it actually changed to avoid spurious
                // "Server removed server mute" notifications when moving to a channel
                // where the user already had (or still has) speak permission.
                if suppress_changed {
                    broadcast_msg.suppress = Some(client.suppress);
                }
            }

            // Propagate self_deaf with coupling: self_deaf=true ⇒ self_mute=true.
            if let Some(sd) = user_state.self_deaf {
                broadcast_msg.self_deaf = Some(sd);
                if sd {
                    broadcast_msg.self_mute = Some(true);
                }
            }
            // self_mute may override the coupling value set above;
            // self_mute=false ⇒ self_deaf=false as well.
            if let Some(sm) = user_state.self_mute {
                broadcast_msg.self_mute = Some(sm);
                if !sm {
                    broadcast_msg.self_deaf = Some(false);
                }
            }

            // mute/deaf/priority_speaker are not processed here (admin-only).
            if let Some(v) = user_state.recording {
                // Only include recording in the broadcast when the value
                // actually changed (change detection already skips no-ops above).
                if broadcast_msg.recording.is_none() {
                    broadcast_msg.recording = Some(v);
                }
            }

            if !actually_added_channels.is_empty() {
                broadcast_msg.listening_channel_add = actually_added_channels.clone();
            }
            if !user_state.listening_channel_remove.is_empty() {
                broadcast_msg.listening_channel_remove =
                    user_state.listening_channel_remove.clone();
            }
            if !user_state.listening_volume_adjustment.is_empty() {
                broadcast_msg.listening_volume_adjustment =
                    user_state.listening_volume_adjustment.clone();
            }

            // Channel Ninja: for channel moves, apply three-way visibility logic.
            // For non-move state changes, filter if user is in a ninja channel.
            if channel_moved {
                let ninja_channels_snap = edge_state.ninja_channels.read().await.clone();
                let from_is_ninja = ninja_channels_snap.contains(&old_channel_id);
                let to_is_ninja = ninja_channels_snap.contains(&client.channel_id);
                if !from_is_ninja && !to_is_ninja {
                    // No ninja channels involved — broadcast normally.
                    edge_state
                        .client_manager
                        .broadcast(MessageType::UserState, &broadcast_msg, None)
                        .await;
                } else {
                    let all_clients = edge_state.client_manager.get_all_clients().await;
                    let visible_cache = edge_state.ninja_visible_to.read().await;
                    // Build full UserState for the "appears" case (observer gains visibility).
                    let full_appear_msg = mumbleproto::UserState {
                        session: Some(session_id),
                        user_id: if client.user_id > 0 {
                            Some(client.user_id)
                        } else {
                            None
                        },
                        name: Some(client.username.clone()),
                        channel_id: Some(client.channel_id),
                        actor: Some(session_id),
                        mute: if client.mute { Some(true) } else { None },
                        deaf: if client.deaf { Some(true) } else { None },
                        suppress: if client.suppress { Some(true) } else { None },
                        self_mute: if client.self_mute { Some(true) } else { None },
                        self_deaf: if client.self_deaf { Some(true) } else { None },
                        priority_speaker: if client.priority_speaker {
                            Some(true)
                        } else {
                            None
                        },
                        recording: if client.recording { Some(true) } else { None },
                        hash: client.cert_hash.clone(),
                        ..Default::default()
                    };
                    let remove_msg = handler::build_user_remove_msg(session_id, None);
                    for observer in &all_clients {
                        if observer.session == session_id {
                            continue;
                        }
                        let was_visible = if from_is_ninja {
                            visible_cache
                                .get(&observer.session)
                                .map(|s| s.contains(&old_channel_id))
                                .unwrap_or(false)
                        } else {
                            true
                        };
                        let now_visible = if to_is_ninja {
                            visible_cache
                                .get(&observer.session)
                                .map(|s| s.contains(&client.channel_id))
                                .unwrap_or(false)
                        } else {
                            true
                        };
                        match (was_visible, now_visible) {
                            (true, true) => {
                                edge_state
                                    .client_manager
                                    .send_to(
                                        observer.session,
                                        MessageType::UserState,
                                        &broadcast_msg,
                                    )
                                    .await;
                            }
                            (true, false) => {
                                edge_state
                                    .client_manager
                                    .send_to(observer.session, MessageType::UserRemove, &remove_msg)
                                    .await;
                            }
                            (false, true) => {
                                edge_state
                                    .client_manager
                                    .send_to(
                                        observer.session,
                                        MessageType::UserState,
                                        &full_appear_msg,
                                    )
                                    .await;
                            }
                            (false, false) => {}
                        }
                    }
                }
            } else {
                // Non-move state change: filter if user is currently in a ninja channel.
                let ninja_channels_snap = edge_state.ninja_channels.read().await.clone();
                if ninja_channels_snap.contains(&client.channel_id) {
                    let all_clients = edge_state.client_manager.get_all_clients().await;
                    let visible_cache = edge_state.ninja_visible_to.read().await;
                    for observer in &all_clients {
                        let can_see = visible_cache
                            .get(&observer.session)
                            .map(|set| set.contains(&client.channel_id))
                            .unwrap_or(false);
                        if can_see {
                            edge_state
                                .client_manager
                                .send_to(observer.session, MessageType::UserState, &broadcast_msg)
                                .await;
                        }
                    }
                } else {
                    edge_state
                        .client_manager
                        .broadcast(MessageType::UserState, &broadcast_msg, None)
                        .await;
                }
            }
            // Invalidate BroadcastCaches: channel/deaf/listener state changed.
            edge_state
                .topology_version
                .fetch_add(1, std::sync::atomic::Ordering::Release);

            // Notify Hub of the CHANGED fields only so that other edges stay in
            // sync.  Previously we sent the full current state on every update
            // which caused other edges to build a delta that included
            // Some(false) for every default-off field, triggering spurious
            // "Server opened mic/speaker" / "Server granted priority speaker"
            // notifications on their local clients.
            if channel_moved {
                if let Err(e) = hub_client
                    .rpc_user_moved(session_id, client.channel_id, session_id)
                    .await
                {
                    warn!("rpc_user_moved failed for session {}: {:#}", session_id, e);
                }
                // If suppress changed due to the channel move (ACL re-check), also notify
                // Hub so other edges update their remote_users suppress state.
                if suppress_changed {
                    if let Err(e) = hub_client
                        .rpc_user_state_changed(
                            session_id,
                            None,
                            None,
                            None,
                            None,
                            Some(client.suppress),
                            None,
                            None,
                            vec![],
                            vec![],
                            None, // suppress changes have no actor
                        )
                        .await
                    {
                        warn!(
                            "rpc_user_state_changed (suppress) failed for session {}: {:#}",
                            session_id, e
                        );
                    }
                }
            } else {
                let listening_channel_add = if !broadcast_msg.listening_channel_add.is_empty() {
                    broadcast_msg.listening_channel_add.clone()
                } else {
                    vec![]
                };
                let listening_channel_remove = if !broadcast_msg.listening_channel_remove.is_empty()
                {
                    broadcast_msg.listening_channel_remove.clone()
                } else {
                    vec![]
                };
                if broadcast_msg.self_mute.is_some()
                    || broadcast_msg.self_deaf.is_some()
                    || broadcast_msg.mute.is_some()
                    || broadcast_msg.deaf.is_some()
                    || broadcast_msg.priority_speaker.is_some()
                    || broadcast_msg.recording.is_some()
                    || !listening_channel_add.is_empty()
                    || !listening_channel_remove.is_empty()
                    || !broadcast_msg.listening_volume_adjustment.is_empty()
                {
                    if let Err(e) = hub_client
                        .rpc_user_state_changed(
                            session_id,
                            broadcast_msg.self_mute,
                            broadcast_msg.self_deaf,
                            broadcast_msg.mute,
                            broadcast_msg.deaf,
                            None, // suppress not changed here
                            broadcast_msg.priority_speaker,
                            broadcast_msg.recording,
                            listening_channel_add,
                            listening_channel_remove,
                            None, // self-initiated changes have no actor
                        )
                        .await
                    {
                        warn!(
                            "rpc_user_state_changed failed for session {}: {:#}",
                            session_id, e
                        );
                    }
                }
            }
        }
    }
}

/// Handle an admin UserState update (one user modifying another user's state).
/// Currently handles: mute/deaf, channel move (kick to channel).
pub(super) async fn handle_admin_user_state_update(
    edge_state: &Arc<EdgeState>,
    hub_client: &Arc<HubClient>,
    actor_session: u32,
    target_session: u32,
    user_state: &mumbleproto::UserState,
) {
    if let Some(mut client) = edge_state.client_manager.get_client(target_session).await {
        let mut needs_broadcast = false;

        // Admin mute/deaf — requires MuteDeafen permission on the victim's channel
        if user_state.mute.is_some() || user_state.deaf.is_some() {
            let has_mute_deafen = get_perm_cached(
                &hub_client,
                &edge_state,
                actor_session,
                client.channel_id,
                false,
            )
            .await
                & perm::MUTE_DEAFEN
                != 0;
            if !has_mute_deafen {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        permission: Some(perm::MUTE_DEAFEN),
                        channel_id: Some(client.channel_id),
                        session: Some(actor_session),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }
            if let Some(mute) = user_state.mute {
                client.mute = mute;
                needs_broadcast = true;
            }
            if let Some(deaf) = user_state.deaf {
                client.deaf = deaf;
                needs_broadcast = true;
            }
        }

        // Suppress=true can only be set by the server (based on channel permissions), not by
        // a client directly.  Reject any attempt by an actor to force-suppress another user.
        // Murmur: "if (msg.has_suppress() && msg.suppress()) → PermissionDenied MuteDeafen"
        if user_state.suppress == Some(true) {
            if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                let pq = mumbleproto::PermissionDenied {
                    r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                    permission: Some(perm::MUTE_DEAFEN),
                    channel_id: Some(client.channel_id),
                    session: Some(actor_session),
                    ..Default::default()
                };
                sender
                    .send_message(MessageType::PermissionDenied, &pq)
                    .await;
            }
            return;
        }

        // Admin comment clear — an actor can clear another user's comment (setting it to "")
        // if they have Move permission on root channel.  Setting a non-empty comment for another
        // user is not allowed (Murmur: TextTooLong denial for any non-empty comment).
        if let Some(ref comment) = user_state.comment {
            // Check Move permission on root channel (channel 0)
            let has_move_root = get_perm_cached(&hub_client, &edge_state, actor_session, 0, false)
                .await
                & perm::MOVE
                != 0;
            if !has_move_root {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        permission: Some(perm::MOVE),
                        channel_id: Some(0),
                        session: Some(actor_session),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }
            // Only allow clearing (empty string) — setting a non-empty comment for someone else is denied
            if !comment.is_empty() {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::TextTooLong as i32),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }
            // Clear the target user's comment
            let target_uid = client.user_id;
            hub_client.blob_set_user_comment(target_uid, vec![]).await;
            let clear_msg = mumbleproto::UserState {
                session: Some(target_session),
                actor: Some(actor_session),
                comment: Some(String::new()),
                ..Default::default()
            };
            edge_state
                .client_manager
                .broadcast(MessageType::UserState, &clear_msg, None)
                .await;
            hub_client
                .rpc_user_state_changed(
                    target_session,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    vec![],
                    vec![],
                    Some(actor_session),
                )
                .await
                .ok();
            return;
        }

        // Admin registration: actor registering another user by setting user_id on their session.
        // Requires Register permission on root channel; target must have a certificate.
        if user_state.user_id.is_some() {
            let has_register = get_perm_cached(&hub_client, &edge_state, actor_session, 0, false)
                .await
                & perm::REGISTER
                != 0;
            // Deny if actor lacks Register perm or target is already registered
            if !has_register || client.user_id > 0 {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        permission: Some(perm::REGISTER),
                        channel_id: Some(0),
                        session: Some(actor_session),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }
            // Target must have a certificate to be registered
            if client.cert_hash.is_none() {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(
                            mumbleproto::permission_denied::DenyType::MissingCertificate as i32,
                        ),
                        session: Some(target_session),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }
            // Registration not yet implemented — deny with a text message.
            // TODO: implement Hub-side user registration RPC.
            if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                let pq = mumbleproto::PermissionDenied {
                    r#type: Some(mumbleproto::permission_denied::DenyType::Text as i32),
                    reason: Some(
                        "User registration is not yet supported on this server".to_string(),
                    ),
                    ..Default::default()
                };
                sender
                    .send_message(MessageType::PermissionDenied, &pq)
                    .await;
            }
            return;
        }

        // Admin channel move (drag user to another channel)
        let mut channel_moved = false;
        let mut suppress_changed = false;
        if let Some(target_channel_id) = user_state.channel_id {
            if client.channel_id != target_channel_id {
                // Check 1: actor needs Move permission in the victim's current channel
                // (mirrors Murmur: "!hasPermission(uSource, pDstServerUser->cChannel, ChanACL::Move)").
                let actor_can_move_out = get_perm_cached(
                    &hub_client,
                    &edge_state,
                    actor_session,
                    client.channel_id,
                    false,
                )
                .await
                    & perm::MOVE
                    != 0;
                if !actor_can_move_out {
                    if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await
                    {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(
                                mumbleproto::permission_denied::DenyType::Permission as i32,
                            ),
                            permission: Some(perm::MOVE),
                            channel_id: Some(client.channel_id),
                            session: Some(actor_session),
                            ..Default::default()
                        };
                        sender
                            .send_message(MessageType::PermissionDenied, &pq)
                            .await;
                    }
                    return;
                }

                // Check 2: actor has Move in the target channel OR victim has Enter there
                // (mirrors Murmur: "!hasPermission(uSource, c, Move) && !hasPermission(pDst, c, Enter)").
                let actor_can_move_in = get_perm_cached(
                    &hub_client,
                    &edge_state,
                    actor_session,
                    target_channel_id,
                    false,
                )
                .await
                    & perm::MOVE
                    != 0;
                let victim_can_enter = get_perm_cached(
                    &hub_client,
                    &edge_state,
                    target_session,
                    target_channel_id,
                    false,
                )
                .await
                    & perm::ENTER
                    != 0;
                if !actor_can_move_in && !victim_can_enter {
                    if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await
                    {
                        let pq = mumbleproto::PermissionDenied {
                            r#type: Some(
                                mumbleproto::permission_denied::DenyType::Permission as i32,
                            ),
                            permission: Some(perm::MOVE),
                            channel_id: Some(target_channel_id),
                            session: Some(actor_session),
                            ..Default::default()
                        };
                        sender
                            .send_message(MessageType::PermissionDenied, &pq)
                            .await;
                    }
                    return;
                }

                // Re-check suppress for the new channel
                let can_speak = get_perm_cached(
                    &hub_client,
                    &edge_state,
                    target_session,
                    target_channel_id,
                    true,
                )
                .await
                    & perm::SPEAK
                    != 0;
                let new_suppress = !can_speak;

                // Compute effective capacity limit for the target channel.
                let effective_limit = if let Some(ch) = edge_state
                    .channel_manager
                    .get_channel(target_channel_id)
                    .await
                {
                    if ch.max_users > 0 {
                        ch.max_users
                    } else {
                        let hub_limits = edge_state.hub_limits.read().await;
                        hub_limits
                            .as_ref()
                            .and_then(|l| {
                                if l.max_users_per_channel.unwrap_or(0) > 0 {
                                    l.max_users_per_channel
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(0)
                    }
                } else {
                    0
                };

                // Atomically check capacity and move in-place.
                match edge_state
                    .client_manager
                    .move_client_to_channel_checked(
                        target_session,
                        target_channel_id,
                        new_suppress,
                        effective_limit,
                    )
                    .await
                {
                    Ok(()) => {
                        suppress_changed = new_suppress != client.suppress;
                        client.channel_id = target_channel_id;
                        client.suppress = new_suppress;
                        needs_broadcast = true;
                        channel_moved = true;
                    }
                    Err(()) => {
                        // Channel full — send PermissionDenied to the actor.
                        if let Some(sender) =
                            edge_state.client_manager.get_sender(actor_session).await
                        {
                            let pq = mumbleproto::PermissionDenied {
                                r#type: Some(
                                    mumbleproto::permission_denied::DenyType::ChannelFull as i32,
                                ),
                                channel_id: Some(target_channel_id),
                                reason: Some("Channel is full".to_string()),
                                ..Default::default()
                            };
                            sender
                                .send_message(MessageType::PermissionDenied, &pq)
                                .await;
                        }
                        return;
                    }
                }
            }
        }

        if needs_broadcast {
            edge_state
                .client_manager
                .update_client(client.clone())
                .await;
            // Build targeted message; only include fields that were actually changed,
            // with their real boolean values (including false) so clients can observe
            // state transitions (e.g., admin un-muting a user).
            let mut broadcast_msg = mumbleproto::UserState {
                session: Some(target_session),
                actor: Some(actor_session),
                ..Default::default()
            };
            if channel_moved {
                broadcast_msg.channel_id = Some(client.channel_id);
                if suppress_changed {
                    broadcast_msg.suppress = Some(client.suppress);
                }
            }
            if let Some(v) = user_state.mute {
                broadcast_msg.mute = Some(v);
            }
            if let Some(v) = user_state.deaf {
                broadcast_msg.deaf = Some(v);
            }
            edge_state
                .client_manager
                .broadcast(MessageType::UserState, &broadcast_msg, None)
                .await;
            // Invalidate BroadcastCaches: admin changed channel/deaf state.
            edge_state
                .topology_version
                .fetch_add(1, std::sync::atomic::Ordering::Release);
            if channel_moved {
                if let Err(e) = hub_client
                    .rpc_user_moved(target_session, client.channel_id, actor_session)
                    .await
                {
                    warn!(
                        "rpc_user_moved failed (admin move, session {}): {:#}",
                        target_session, e
                    );
                }
            } else {
                if let Err(e) = hub_client
                    .rpc_user_state_changed(
                        target_session,
                        None,
                        None,
                        broadcast_msg.mute,
                        broadcast_msg.deaf,
                        None,
                        None,
                        None,
                        vec![],
                        vec![],
                        Some(actor_session), // carry actor so other edges can show who muted
                    )
                    .await
                {
                    warn!(
                        "rpc_user_state_changed failed (admin state, session {}): {:#}",
                        target_session, e
                    );
                }
            }
        }
    } else if let Some(target_channel_id) = user_state.channel_id {
        // Target user is not on this edge — check if it is a known remote user and
        // forward the admin move to Hub so the owner edge can apply it.
        let remote_user = edge_state
            .channel_manager
            .get_remote_user(target_session)
            .await;
        if let Some(remote) = remote_user {
            if remote.channel_id == target_channel_id {
                return; // already in target channel, nothing to do
            }

            // Permission check 1: actor must have Move in victim's current channel.
            let actor_can_move_out = get_perm_cached(
                &hub_client,
                &edge_state,
                actor_session,
                remote.channel_id,
                false,
            )
            .await
                & perm::MOVE
                != 0;
            if !actor_can_move_out {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        permission: Some(perm::MOVE),
                        channel_id: Some(remote.channel_id),
                        session: Some(actor_session),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }

            // Permission check 2: actor has Move in target OR victim has Enter there.
            let actor_can_move_in = get_perm_cached(
                &hub_client,
                &edge_state,
                actor_session,
                target_channel_id,
                false,
            )
            .await
                & perm::MOVE
                != 0;
            let victim_can_enter = get_perm_cached(
                &hub_client,
                &edge_state,
                target_session,
                target_channel_id,
                false,
            )
            .await
                & perm::ENTER
                != 0;
            if !actor_can_move_in && !victim_can_enter {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        permission: Some(perm::MOVE),
                        channel_id: Some(target_channel_id),
                        session: Some(actor_session),
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                return;
            }

            // Permissions OK: forward to Hub. Hub updates session state and broadcasts
            // hub.userMoved to all edges; the owner edge will apply the actual move.
            // Hub may reject if the target channel is full — notify actor accordingly.
            if let Err(e) = hub_client
                .rpc_user_moved(target_session, target_channel_id, actor_session)
                .await
            {
                let is_full = e.to_string().contains("Channel is full");
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(if is_full {
                            mumbleproto::permission_denied::DenyType::ChannelFull as i32
                        } else {
                            mumbleproto::permission_denied::DenyType::Permission as i32
                        }),
                        permission: if is_full { None } else { Some(perm::MOVE) },
                        channel_id: Some(target_channel_id),
                        session: if is_full { None } else { Some(actor_session) },
                        reason: if is_full {
                            Some("Channel is full".to_string())
                        } else {
                            None
                        },
                        ..Default::default()
                    };
                    sender
                        .send_message(MessageType::PermissionDenied, &pq)
                        .await;
                }
                warn!(
                    "rpc_user_moved failed (remote admin move, session {}): {:#}",
                    target_session, e
                );
            }
        }
    }
}
