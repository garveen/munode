//! UserState update handlers: self-initiated and admin-initiated state changes.
use super::helpers::{get_perm_cached, hex_to_bytes};
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

    if let Some(mut client) = edge_state.client_manager.get_client(session_id).await {
        // 9.1 Channel move with permission check
        if let Some(target_channel_id) = user_state.channel_id {
            if client.channel_id != target_channel_id {
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
                    let _ = effective_limit;
                    suppress_changed = new_suppress != client.suppress;
                    client.channel_id = target_channel_id;
                    client.suppress = new_suppress;
                    needs_broadcast = true;
                    channel_moved = true;
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

                if !client.listening_channels.contains(&ch) {
                    client.listening_channels.push(ch);
                    actually_added_channels.push(ch);
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

        let has_local_only_updates = !user_state.listening_volume_adjustment.is_empty()
            || user_state.plugin_context.is_some()
            || user_state.texture.is_some()
            || user_state.comment.is_some();
        if needs_broadcast && !channel_moved && !has_local_only_updates {
            let mut state_update = mumbleproto::UserState {
                session: Some(session_id),
                actor: Some(session_id),
                ..Default::default()
            };

            if let Some(sd) = user_state.self_deaf {
                state_update.self_deaf = Some(sd);
                if sd {
                    state_update.self_mute = Some(true);
                }
            }
            if let Some(sm) = user_state.self_mute {
                state_update.self_mute = Some(sm);
                if !sm {
                    state_update.self_deaf = Some(false);
                }
            }
            if let Some(v) = user_state.recording {
                if state_update.recording.is_none() {
                    state_update.recording = Some(v);
                }
            }

            let listening_channel_add = actually_added_channels.clone();
            let listening_channel_remove = user_state.listening_channel_remove.clone();
            if state_update.self_mute.is_some()
                || state_update.self_deaf.is_some()
                || state_update.recording.is_some()
                || !listening_channel_add.is_empty()
                || !listening_channel_remove.is_empty()
            {
                if let Err(e) = hub_client
                    .rpc_user_state_changed(
                        session_id,
                        state_update.self_mute,
                        state_update.self_deaf,
                        None,
                        None,
                        None,
                        None,
                        state_update.recording,
                        listening_channel_add,
                        listening_channel_remove,
                        None,
                    )
                    .await
                {
                    warn!(
                        "rpc_user_state_changed failed for session {}: {:#}",
                        session_id, e
                    );
                }
            }
            return;
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
            if channel_moved {
                let mut move_committed = false;
                if let Err(e) = hub_client
                    .rpc_user_moved(session_id, client.channel_id, session_id)
                    .await
                {
                    let is_full = e.to_string().contains("Channel is full");
                    if is_full {
                        if let Some(sender) = edge_state.client_manager.get_sender(session_id).await
                        {
                            let pq = mumbleproto::PermissionDenied {
                                r#type: Some(
                                    mumbleproto::permission_denied::DenyType::ChannelFull as i32,
                                ),
                                channel_id: Some(client.channel_id),
                                reason: Some("Channel is full".to_string()),
                                ..Default::default()
                            };
                            sender
                                .send_message(MessageType::PermissionDenied, &pq)
                                .await;
                        }
                    }
                    warn!("rpc_user_moved failed for session {}: {:#}", session_id, e);
                } else {
                    move_committed = true;
                }

                if move_committed && suppress_changed {
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
                            None,
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
                edge_state
                    .client_manager
                    .update_client(client.clone())
                    .await;

                let mut broadcast_msg = mumbleproto::UserState {
                    session: Some(session_id),
                    actor: Some(session_id),
                    ..Default::default()
                };

                if let Some(sd) = user_state.self_deaf {
                    broadcast_msg.self_deaf = Some(sd);
                    if sd {
                        broadcast_msg.self_mute = Some(true);
                    }
                }
                if let Some(sm) = user_state.self_mute {
                    broadcast_msg.self_mute = Some(sm);
                    if !sm {
                        broadcast_msg.self_deaf = Some(false);
                    }
                }

                if let Some(v) = user_state.recording {
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

                edge_state
                    .topology_version
                    .fetch_add(1, std::sync::atomic::Ordering::Release);

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
                            None,
                            broadcast_msg.priority_speaker,
                            broadcast_msg.recording,
                            listening_channel_add,
                            listening_channel_remove,
                            None,
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

        // Admin speak-state changes (mute/deaf/suppress/priority speaker) require
        // MuteDeafen permission on the victim's current channel. Murmur also
        // rejects explicit suppress=true from a client; only suppress=false is allowed.
        if user_state.mute.is_some()
            || user_state.deaf.is_some()
            || user_state.suppress.is_some()
            || user_state.priority_speaker.is_some()
        {
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
            if let Some(suppress) = user_state.suppress {
                client.suppress = suppress;
                needs_broadcast = true;
            }
            if let Some(priority_speaker) = user_state.priority_speaker {
                client.priority_speaker = priority_speaker;
                needs_broadcast = true;
            }
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
                let victim_can_enter = if actor_can_move_in {
                    false
                } else {
                    get_perm_cached(
                        &hub_client,
                        &edge_state,
                        target_session,
                        target_channel_id,
                        false,
                    )
                    .await
                        & perm::ENTER
                        != 0
                };
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

                client.channel_id = target_channel_id;
                client.suppress = new_suppress;
                needs_broadcast = true;
                channel_moved = true;
            }
        }

        if needs_broadcast {
            if channel_moved {
                if let Err(e) = hub_client
                    .rpc_user_moved(target_session, client.channel_id, actor_session)
                    .await
                {
                    let is_full = e.to_string().contains("Channel is full");
                    if is_full {
                        if let Some(sender) =
                            edge_state.client_manager.get_sender(actor_session).await
                        {
                            let pq = mumbleproto::PermissionDenied {
                                r#type: Some(
                                    mumbleproto::permission_denied::DenyType::ChannelFull as i32,
                                ),
                                channel_id: Some(client.channel_id),
                                reason: Some("Channel is full".to_string()),
                                ..Default::default()
                            };
                            sender
                                .send_message(MessageType::PermissionDenied, &pq)
                                .await;
                        }
                    }
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
                        user_state.mute,
                        user_state.deaf,
                        user_state.suppress,
                        user_state.priority_speaker,
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
    } else if let Some(remote) = edge_state
        .channel_manager
        .get_remote_user(target_session)
        .await
    {
        if user_state.mute.is_some()
            || user_state.deaf.is_some()
            || user_state.suppress.is_some()
            || user_state.priority_speaker.is_some()
        {
            if user_state.suppress == Some(true) {
                if let Some(sender) = edge_state.client_manager.get_sender(actor_session).await {
                    let pq = mumbleproto::PermissionDenied {
                        r#type: Some(mumbleproto::permission_denied::DenyType::Permission as i32),
                        permission: Some(perm::MUTE_DEAFEN),
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

            let has_mute_deafen = get_perm_cached(
                &hub_client,
                &edge_state,
                actor_session,
                remote.channel_id,
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

            if let Err(e) = hub_client
                .rpc_user_state_changed(
                    target_session,
                    None,
                    None,
                    user_state.mute,
                    user_state.deaf,
                    user_state.suppress,
                    user_state.priority_speaker,
                    None,
                    vec![],
                    vec![],
                    Some(actor_session),
                )
                .await
            {
                warn!(
                    "rpc_user_state_changed failed (remote admin state, session {}): {:#}",
                    target_session, e
                );
            }
        }

        if let Some(target_channel_id) = user_state.channel_id {
            // Target user is not on this edge — forward the admin move to Hub so the
            // owner edge can apply it after the Hub broadcast.
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
            let victim_can_enter = if actor_can_move_in {
                false
            } else {
                get_perm_cached(
                    &hub_client,
                    &edge_state,
                    target_session,
                    target_channel_id,
                    false,
                )
                .await
                    & perm::ENTER
                    != 0
            };
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
    } else {
        warn!(
            actor_session,
            target_session,
            mute = ?user_state.mute,
            deaf = ?user_state.deaf,
            suppress = ?user_state.suppress,
            priority_speaker = ?user_state.priority_speaker,
            channel_id = ?user_state.channel_id,
            "Admin UserState target session not found on this edge"
        );
    }
}
