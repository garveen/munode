use super::*;

impl RpcHandler {
    pub(super) async fn on_user_left(&self, notification: &TypedRpcNotification) {
        let params = notification.handle_user_left.as_ref();
        let session_id = params.map(|p| p.session_id).unwrap_or(0);
        let reason = params.and_then(|p| p.reason.clone());
        if session_id == 0 {
            return;
        }

        {
            let pending = self.state.pending_auths.read().await;
            if let Some((flag, _)) = pending.get(&session_id) {
                flag.store(true, Ordering::Relaxed);
                debug!("Auth cancel flag set for disconnecting session {}", session_id);
            }
        }

        self.save_user_last_channel(session_id).await;

        if let Some(removed) = self.state.session_manager.remove_session(session_id).await {
            info!("User left: {} (session={})", removed.username, session_id);

            self.state
                .voice_targets
                .write()
                .await
                .retain(|&(session, _), _| session != session_id);

            let remove_params = HubUserRemoveBroadcastParams {
                session: session_id,
                actor: None,
                reason,
                ban: None,
                target_sessions: vec![],
            };
            self.broadcast_notification("hub.userRemoveBroadcast", |notification| {
                notification.user_remove_broadcast = Some(remove_params);
            })
            .await;

            self.maybe_cleanup_temp_channel(removed.channel_id).await;
        }
    }

    pub(super) async fn on_user_remove(&self, notification: &TypedRpcNotification) {
        let params = match notification.handle_user_remove.as_ref() {
            Some(params) => params,
            None => return,
        };
        let target_session = params.target_session;
        if target_session == 0 {
            return;
        }

        let required_perm = if params.ban { permission::BAN } else { permission::KICK };
        let (target_channel, actor_groups) = {
            let target_info = self.state.session_manager.get_session(target_session).await;
            let actor_info = if params.actor_session != 0 {
                self.state.session_manager.get_session(params.actor_session).await
            } else {
                None
            };
            (
                target_info.map(|session| session.channel_id).unwrap_or(0),
                actor_info.map(|session| session.groups.clone()).unwrap_or_default(),
            )
        };
        let allowed = self.state.acl_manager
            .has_permission(params.actor_user_id as i32, target_channel, &actor_groups, required_perm)
            .await;
        if !allowed {
            debug!(
                "UserRemove denied: actor={} (session={}) → target={}: no {} permission on channel {}",
                params.actor_username,
                params.actor_session,
                target_session,
                if params.ban { "Ban" } else { "Kick" },
                target_channel
            );
            return;
        }

        if let Some(removed) = self.state.session_manager.remove_session(target_session).await {
            info!("User removed: {} (session={})", removed.username, target_session);

            self.state
                .voice_targets
                .write()
                .await
                .retain(|&(session, _), _| session != target_session);

            let remove_params = HubUserRemoveBroadcastParams {
                session: target_session,
                actor: if params.actor_session != 0 {
                    Some(params.actor_session)
                } else {
                    None
                },
                reason: if params.reason.is_empty() {
                    None
                } else {
                    Some(params.reason.clone())
                },
                ban: Some(params.ban),
                target_sessions: vec![],
            };
            self.broadcast_notification("hub.userRemoveBroadcast", |notification| {
                notification.user_remove_broadcast = Some(remove_params);
            })
            .await;
        }
    }

    pub(super) async fn on_user_moved(&self, notification: &TypedRpcNotification) {
        let params = match notification.handle_user_moved.as_ref() {
            Some(params) => params,
            None => return,
        };
        if params.session_id == 0 {
            return;
        }

        let old_channel_id = self
            .state
            .session_manager
            .get_session(params.session_id)
            .await
            .map(|session| session.channel_id);
        self.state
            .session_manager
            .move_user_to_channel(params.session_id, params.channel_id)
            .await;

        let moved_params = HubUserMovedParams {
            session_id: params.session_id,
            edge_id: params.edge_id,
            channel_id: params.channel_id,
            actor_session: params.actor_session,
        };
        self.broadcast_notification("hub.userMoved", |notification| {
            notification.user_moved = Some(moved_params);
        })
        .await;

        if let Some(old_channel_id) = old_channel_id {
            self.maybe_cleanup_temp_channel(old_channel_id).await;
        }
    }

    pub(super) async fn on_user_state_changed(&self, notification: &TypedRpcNotification) {
        let params = match notification.handle_user_state_changed.as_ref() {
            Some(params) => params,
            None => return,
        };
        if params.session_id == 0 {
            return;
        }
        let source_edge_id = params.edge_id;

        let sessions = &self.state.session_manager;
        if let Some(mut session) = sessions.get_session(params.session_id).await {
            if let Some(value) = params.self_mute {
                session.self_mute = value;
            }
            if let Some(value) = params.self_deaf {
                session.self_deaf = value;
            }
            if let Some(value) = params.mute {
                session.mute = value;
            }
            if let Some(value) = params.deaf {
                session.deaf = value;
            }
            if let Some(value) = params.suppress {
                session.suppress = value;
            }
            if let Some(value) = params.priority_speaker {
                session.priority_speaker = value;
            }
            if let Some(value) = params.recording {
                session.recording = value;
            }
            for &channel_id in &params.listening_channel_add {
                if !session.listening_channels.contains(&channel_id) {
                    session.listening_channels.push(channel_id);
                }
            }
            session
                .listening_channels
                .retain(|channel_id| !params.listening_channel_remove.contains(channel_id));
            sessions.add_session(session).await;
        }

        let broadcast = HubUserStateBroadcastParams {
            session_id: params.session_id,
            edge_id: source_edge_id,
            self_mute: params.self_mute,
            self_deaf: params.self_deaf,
            mute: params.mute,
            deaf: params.deaf,
            suppress: params.suppress,
            priority_speaker: params.priority_speaker,
            recording: params.recording,
            listening_channel_add: params.listening_channel_add.clone(),
            listening_channel_remove: params.listening_channel_remove.clone(),
            actor_session: params.actor_session,
        };
        let forward = TypedRpcNotification {
            method: "hub.userStateBroadcast".to_string(),
            timestamp: Some(current_millis() as i64),
            user_state_broadcast: Some(broadcast),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(forward),
            ..Default::default()
        };
        let data = packet.encode_to_vec();
        crate::server::broadcast_critical_excluding_sequenced(&self.state, data, source_edge_id)
            .await;
    }

    pub(super) async fn on_text_message(
        &self,
        notification: &TypedRpcNotification,
        source_edge_id: u32,
    ) {
        let params = match notification.handle_text_message.as_ref() {
            Some(params) => params,
            None => return,
        };
        if params.actor == 0 {
            debug!("Ignoring text message with invalid actor=0");
            return;
        }

        debug!(
            "Forwarding text message from actor {} (edge {}) to other edges",
            params.actor, source_edge_id
        );

        let forward_notification = TypedRpcNotification {
            method: "hub.textMessageForward".to_string(),
            timestamp: Some(current_millis() as i64),
            text_message_forward: Some(HubTextMessageForwardParams {
                actor: params.actor,
                message: params.message.clone(),
                channel_id: params.channel_id.clone(),
                tree_id: params.tree_id.clone(),
                session: params.session.clone(),
            }),
            ..Default::default()
        };

        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(forward_notification),
            ..Default::default()
        };
        let data = packet.encode_to_vec();

        crate::server::broadcast_critical_excluding_sequenced(&self.state, data, source_edge_id)
            .await;
    }

    pub(super) async fn on_channel_state(&self, notification: &TypedRpcNotification) {
        let params = match notification.handle_channel_state.as_ref() {
            Some(params) => params,
            None => return,
        };

        let channel_id = Some(params.channel_id);
        if let Some(channel_id) = channel_id {
            let links_add: Vec<u32> = params.links_add.clone();
            let links_remove: Vec<u32> = params.links_remove.clone();

            for target_id in &links_add {
                if let Err(error) = self.state.channel_store.add_link(channel_id, *target_id).await {
                    warn!("Failed to add channel link {} <-> {}: {}", channel_id, target_id, error);
                }
            }
            for target_id in &links_remove {
                if let Err(error) = self.state.channel_store.remove_link(channel_id, *target_id).await {
                    warn!("Failed to remove channel link {} <-> {}: {}", channel_id, target_id, error);
                }
            }

            if let Some(mut channel) = self.state.channel_store.get_channel(channel_id).await {
                if let Some(ref name) = params.name {
                    channel.name = name.clone();
                }
                if let Some(parent_id) = params.parent_id {
                    channel.parent_id = Some(parent_id);
                }
                if let Some(position) = params.position {
                    channel.position = position;
                }
                if let Some(ref description) = params.description {
                    channel.description = description.clone();
                }
                self.state.channel_store.update_channel(channel).await;
            }

            if let Some(channel) = self.state.channel_store.get_channel(channel_id).await {
                let proto = ChannelDataProto {
                    channel_id: channel.id,
                    name: channel.name,
                    parent_id: channel.parent_id,
                    description: Some(channel.description),
                    position: Some(channel.position),
                    max_users: if channel.max_users > 0 {
                        Some(channel.max_users)
                    } else {
                        None
                    },
                    temporary: Some(channel.temporary),
                    inherit_acl: Some(channel.inherit_acl),
                    links: channel.links.iter().copied().collect(),
                };
                self.broadcast_notification("hub.channelUpdated", |notification| {
                    notification.channel_updated = Some(HubChannelUpdatedParams { channel: proto });
                })
                .await;
            }

            let all_peers: std::collections::HashSet<u32> = links_add
                .iter()
                .chain(links_remove.iter())
                .copied()
                .collect();
            for peer_id in all_peers {
                if let Some(peer) = self.state.channel_store.get_channel(peer_id).await {
                    let proto = ChannelDataProto {
                        channel_id: peer.id,
                        name: peer.name,
                        parent_id: peer.parent_id,
                        description: Some(peer.description),
                        position: Some(peer.position),
                        max_users: if peer.max_users > 0 {
                            Some(peer.max_users)
                        } else {
                            None
                        },
                        temporary: Some(peer.temporary),
                        inherit_acl: Some(peer.inherit_acl),
                        links: peer.links.iter().copied().collect(),
                    };
                    self.broadcast_notification("hub.channelUpdated", |notification| {
                        notification.channel_updated = Some(HubChannelUpdatedParams { channel: proto });
                    })
                    .await;
                }
            }
        }
    }

    pub(super) async fn on_channel_remove(&self, notification: &TypedRpcNotification) {
        let channel_id = match notification.handle_channel_remove.as_ref() {
            Some(params) => params.channel_id,
            None => return,
        };
        if channel_id == 0 {
            return;
        }

        self.remove_channel_coordinated(channel_id).await;
    }

    pub(super) async fn on_plugin_data(
        &self,
        notification: &TypedRpcNotification,
        source_edge_id: u32,
    ) {
        if let Some(params) = &notification.plugin_data_transmission {
            debug!(
                "Plugin data from session {}: dataId={}, {} receivers",
                params.sender_session,
                params.data_id,
                params.receiver_sessions.len()
            );

            let target_sessions = if params.receiver_sessions.is_empty() {
                self.state
                    .session_manager
                    .get_all_sessions()
                    .await
                    .iter()
                    .map(|session| session.session_id)
                    .collect::<Vec<_>>()
            } else {
                params.receiver_sessions.clone()
            };

            let mut edge_targets: HashMap<u32, Vec<u32>> = HashMap::new();
            for session_id in &target_sessions {
                if let Some(session) = self.state.session_manager.get_session(*session_id).await {
                    edge_targets
                        .entry(session.edge_id)
                        .or_default()
                        .push(*session_id);
                }
            }

            for (edge_id, sessions) in edge_targets {
                if edge_id == source_edge_id {
                    continue;
                }
                let broadcast_params = HubPluginDataBroadcastParams {
                    sender_session: params.sender_session,
                    data_id: params.data_id.clone(),
                    data: params.data.clone(),
                    target_sessions: sessions,
                };

                let notify = TypedRpcNotification {
                    method: "hub.pluginDataBroadcast".to_string(),
                    timestamp: Some(current_millis() as i64),
                    plugin_data_broadcast: Some(broadcast_params),
                    ..Default::default()
                };

                let packet = EdgeHubPacket {
                    r#type: PacketType::RpcNotification as i32,
                    rpc_notification: Some(notify),
                    ..Default::default()
                };

                let data = packet.encode_to_vec();
                crate::server::notify_sequenced(&self.state, edge_id, data).await;
            }
        }
    }
}