use super::*;

impl RpcHandler {
    /// Re-register an already-authenticated session after Hub restart / Edge reconnect.
    ///
    /// Unlike `edge.authenticateUser`, this path skips credential validation entirely
    /// and simply inserts the session into the session manager, then broadcasts
    /// `hub.userJoined` so all other Edges learn about the user.
    pub(super) async fn handle_report_session(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        edge_server_id: u32,
        connection_id: u64,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_report_session
            .as_ref()
            .context("Missing edge_report_session params")?;
        let session = params
            .session
            .as_ref()
            .context("Missing session in edge_report_session")?;

        let session_info = SessionInfo {
            session_id: session.session_id,
            edge_id: edge_server_id,
            user_id: session.user_id,
            username: session.username.clone(),
            channel_id: session.channel_id,
            groups: session.groups.clone(),
            cert_hash: session.cert_hash.clone().unwrap_or_default(),
            mute: session.mute.unwrap_or(false),
            deaf: session.deaf.unwrap_or(false),
            suppress: session.suppress.unwrap_or(false),
            self_mute: session.self_mute.unwrap_or(false),
            self_deaf: session.self_deaf.unwrap_or(false),
            priority_speaker: session.priority_speaker.unwrap_or(false),
            recording: session.recording.unwrap_or(false),
            listening_channels: session.listening_channels.clone(),
        };

        if !self
            .is_connection_active(edge_server_id, connection_id)
            .await
        {
            warn!(
                edge_id = edge_server_id,
                connection_id,
                session_id = session.session_id,
                "Ignoring edge.reportSession from stale edge connection after fresh takeover"
            );
            return Ok(
                self.make_response_packet(request_id, "edge.reportSession", |response| {
                    response.edge_report_session = Some(EdgeReportSessionResult {
                        success: false,
                        error: Some("stale edge connection".into()),
                    });
                }),
            );
        }

        let already_known = self
            .state
            .session_manager
            .get_session(session.session_id)
            .await
            .map(|existing| existing.edge_id == edge_server_id)
            .unwrap_or(false);

        self.state.session_manager.add_session(session_info).await;

        if already_known {
            info!(
                "Refreshed existing session (no userJoined broadcast): {} (session={}, edge={}, channel={})",
                session.username, session.session_id, edge_server_id, session.channel_id
            );
        } else {
            info!(
                "Reported new session: {} (session={}, edge={}, channel={})",
                session.username, session.session_id, edge_server_id, session.channel_id
            );
            self.broadcast_notification("hub.userJoined", |notification| {
                notification.user_joined = Some(HubUserJoinedParams {
                    session_id: session.session_id,
                    edge_id: edge_server_id,
                    user_id: session.user_id,
                    username: session.username.clone(),
                    channel_id: session.channel_id,
                    groups: session.groups.clone(),
                    cert_hash: session.cert_hash.clone(),
                    mute: session.mute,
                    deaf: session.deaf,
                    suppress: session.suppress,
                    self_mute: session.self_mute,
                    self_deaf: session.self_deaf,
                    priority_speaker: session.priority_speaker,
                    recording: session.recording,
                    listening_channels: session.listening_channels.clone(),
                });
            })
            .await;
        }

        Ok(
            self.make_response_packet(request_id, "edge.reportSession", |response| {
                response.edge_report_session = Some(EdgeReportSessionResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }

    pub(super) async fn handle_user_left_rpc(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        edge_server_id: u32,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_user_left
            .as_ref()
            .context("Missing edge_user_left params")?;
        let session_id = params.session_id;
        let reason = params.reason.clone();

        {
            let pending = self.state.pending_auths.read().await;
            if let Some(entry) = pending.get(&session_id) {
                entry.cancel.store(true, Ordering::Relaxed);
                debug!(
                    "Auth cancel flag set for disconnecting session {}",
                    session_id
                );
            }
        }

        self.save_user_last_channel(session_id).await;

        if let Some(removed) = self.state.session_manager.remove_session(session_id).await {
            info!(
                "User left (RPC): {} (session={})",
                removed.username, session_id
            );

            self.state
                .voice_targets
                .write()
                .await
                .retain(|&(session, _), _| session != session_id);

            self.broadcast_notification_excluding(
                "hub.userRemoveBroadcast",
                edge_server_id,
                |notification| {
                    notification.user_remove_broadcast = Some(HubUserRemoveBroadcastParams {
                        session: session_id,
                        actor: None,
                        reason,
                        ban: None,
                        target_sessions: vec![],
                    });
                },
            )
            .await;

            self.maybe_cleanup_temp_channel(removed.channel_id).await;
        }

        Ok(
            self.make_response_packet(request_id, "edge.userLeft", |response| {
                response.edge_user_left = Some(EdgeUserLeftResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }

    pub(super) async fn handle_user_moved_rpc(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        _edge_server_id: u32,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_user_moved
            .as_ref()
            .context("Missing edge_user_moved params")?;
        if let Err(error) = self.apply_user_move_and_broadcast(params).await {
            return Ok(
                self.make_response_packet(request_id, "edge.userMoved", |response| {
                    response.edge_user_moved = Some(EdgeUserMovedResult {
                        success: false,
                        error: Some(error),
                    });
                }),
            );
        }

        Ok(
            self.make_response_packet(request_id, "edge.userMoved", |response| {
                response.edge_user_moved = Some(EdgeUserMovedResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }

    pub(super) async fn handle_user_state_changed_rpc(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        _edge_server_id: u32,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_user_state_changed
            .as_ref()
            .context("Missing edge_user_state_changed params")?;
        if let Err(error) = self.apply_user_state_changed_and_broadcast(params).await {
            return Ok(self.make_response_packet(
                request_id,
                "edge.userStateChanged",
                |response| {
                    response.edge_user_state_changed = Some(EdgeUserStateChangedResult {
                        success: false,
                        error: Some(error),
                    });
                },
            ));
        }

        Ok(
            self.make_response_packet(request_id, "edge.userStateChanged", |response| {
                response.edge_user_state_changed = Some(EdgeUserStateChangedResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }

    pub(super) async fn handle_channel_state_rpc(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_channel_state
            .as_ref()
            .context("Missing edge_channel_state params")?;
        let notification = TypedRpcNotification {
            handle_channel_state: Some(params.clone()),
            ..Default::default()
        };
        self.on_channel_state(&notification).await;
        Ok(
            self.make_response_packet(request_id, "edge.channelState", |response| {
                response.edge_channel_state = Some(EdgeChannelStateResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }

    pub(super) async fn handle_channel_remove_rpc(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_channel_remove
            .as_ref()
            .context("Missing edge_channel_remove params")?;
        let notification = TypedRpcNotification {
            handle_channel_remove: Some(*params),
            ..Default::default()
        };
        self.on_channel_remove(&notification).await;
        Ok(
            self.make_response_packet(request_id, "edge.channelRemove", |response| {
                response.edge_channel_remove = Some(EdgeChannelRemoveResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }

    pub(super) async fn handle_user_remove_rpc(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_user_remove
            .as_ref()
            .context("Missing edge_user_remove params")?;
        let target_session = params.target_session;
        if target_session == 0 {
            return Ok(
                self.make_response_packet(request_id, "edge.userRemove", |response| {
                    response.edge_user_remove = Some(EdgeUserRemoveResult {
                        success: false,
                        error: Some("invalid target_session".into()),
                    });
                }),
            );
        }

        let required_permission = if params.ban {
            permission::BAN
        } else {
            permission::KICK
        };
        let (target_channel, actor_groups) = {
            let target_info = self.state.session_manager.get_session(target_session).await;
            let actor_info = if params.actor_session != 0 {
                self.state
                    .session_manager
                    .get_session(params.actor_session)
                    .await
            } else {
                None
            };
            (
                target_info.map(|session| session.channel_id).unwrap_or(0),
                actor_info
                    .map(|session| session.groups.clone())
                    .unwrap_or_default(),
            )
        };
        let allowed = self
            .state
            .acl_manager
            .has_permission(
                params.actor_user_id as i32,
                target_channel,
                &actor_groups,
                required_permission,
            )
            .await;
        if !allowed {
            return Ok(
                self.make_response_packet(request_id, "edge.userRemove", |response| {
                    response.edge_user_remove = Some(EdgeUserRemoveResult {
                        success: false,
                        error: Some("permission denied".into()),
                    });
                }),
            );
        }

        if let Some(removed) = self
            .state
            .session_manager
            .remove_session(target_session)
            .await
        {
            info!(
                "User removed (RPC): {} (session={})",
                removed.username, target_session
            );

            self.state
                .voice_targets
                .write()
                .await
                .retain(|&(session, _), _| session != target_session);

            self.broadcast_notification("hub.userRemoveBroadcast", |notification| {
                notification.user_remove_broadcast = Some(HubUserRemoveBroadcastParams {
                    session: target_session,
                    actor: (params.actor_session != 0).then_some(params.actor_session),
                    reason: (!params.reason.is_empty()).then_some(params.reason.clone()),
                    ban: Some(params.ban),
                    target_sessions: vec![],
                });
            })
            .await;
        }

        Ok(
            self.make_response_packet(request_id, "edge.userRemove", |response| {
                response.edge_user_remove = Some(EdgeUserRemoveResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }
}
