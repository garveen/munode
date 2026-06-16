use super::*;

pub(super) struct HttpAuthCall<'a> {
    username: &'a str,
    password: &'a str,
    tokens: &'a [String],
    server_id: u32,
    session_id: u32,
    client_info: Option<&'a ClientInfo>,
    timeout_ms: u64,
}

struct AuthSuccessLog<'a> {
    auth_backend: &'static str,
    username: &'a str,
    session_id: u32,
    edge_server_id: u32,
    channel_id: u32,
    source_ip: Option<&'a str>,
    groups: &'a [String],
}

impl RpcHandler {
    fn auth_disconnect_response(&self, request_id: &str) -> EdgeHubPacket {
        self.make_response_packet(request_id, "edge.authenticateUser", |response| {
            response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                success: false,
                reason: Some("Client disconnected during authentication".into()),
                reject_type: Some(1),
                ..Default::default()
            });
        })
    }

    fn log_authentication_success(&self, log: AuthSuccessLog<'_>) {
        let AuthSuccessLog {
            auth_backend,
            username,
            session_id,
            edge_server_id,
            channel_id,
            source_ip,
            groups,
        } = log;
        let source_ip = source_ip.filter(|ip| !ip.is_empty()).unwrap_or("unknown");

        if self.state.geoip.is_available()
            && self.state.config.geoip.log_location
            && let Ok(ip) = source_ip.parse::<std::net::IpAddr>()
            && let Some(location) = self.state.geoip.lookup(&ip)
        {
            info!(
                auth_backend,
                username,
                session_id,
                edge_id = edge_server_id,
                channel_id,
                source_ip,
                groups = ?groups,
                country = location.country_code.as_deref().unwrap_or("??"),
                city = location.city_name.as_deref().unwrap_or("unknown"),
                "User authenticated"
            );
            return;
        }

        info!(
            auth_backend,
            username,
            session_id,
            edge_id = edge_server_id,
            channel_id,
            source_ip,
            groups = ?groups,
            "User authenticated"
        );
    }

    async fn reject_stale_auth_connection(
        &self,
        request_id: &str,
        edge_server_id: u32,
        connection_id: u64,
        session_id: u32,
    ) -> Option<EdgeHubPacket> {
        if self
            .is_connection_active(edge_server_id, connection_id)
            .await
        {
            return None;
        }

        warn!(
            edge_id = edge_server_id,
            connection_id,
            session_id,
            "Dropping authenticateUser result from stale edge connection after fresh takeover"
        );
        Some(self.auth_disconnect_response(request_id))
    }

    pub(super) async fn handle_register(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        connection_id: u64,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_register
            .as_ref()
            .context("Missing edge_register params")?;

        if let Some(hmac_secret) = &self.state.config.registry.hmac_secret {
            if params.challenge_response.is_none() {
                let challenge = generate_challenge()?;
                let packet = self.make_response_packet(request_id, "edge.register", |response| {
                    response.edge_register = Some(EdgeRegisterResult {
                        success: false,
                        hub_server_id: None,
                        edge_list: vec![],
                        challenge: Some(challenge),
                        challenge_timeout: Some(30000),
                        error: None,
                        server_limits: None,
                    });
                });
                return Ok(packet);
            }

            if let (Some(challenge), Some(response)) =
                (&params.challenge, &params.challenge_response)
            {
                let expected = compute_hmac(hmac_secret, challenge, params.server_id);
                if *response != expected {
                    return Ok(
                        self.make_response_packet(request_id, "edge.register", |packet| {
                            packet.edge_register = Some(EdgeRegisterResult {
                                success: false,
                                hub_server_id: None,
                                edge_list: vec![],
                                challenge: None,
                                challenge_timeout: None,
                                error: Some("HMAC verification failed".to_string()),
                                server_limits: None,
                            });
                        }),
                    );
                }
            }
        }

        let fresh_process = params.fresh_process.unwrap_or(false);

        if fresh_process {
            let disconnected = self
                .disconnect_edge_connections_for_fresh_register(params.server_id, connection_id)
                .await;

            if disconnected > 0 {
                debug!(
                    "Fresh edge process {} requested immediate shutdown for {} old connection(s)",
                    params.server_id, disconnected
                );
            }

            self.state
                .edge_connections
                .write()
                .await
                .remove(&params.server_id);
            self.state
                .edge_health
                .write()
                .await
                .remove(&params.server_id);

            let stale_sessions = self
                .state
                .session_manager
                .get_sessions_by_edge(params.server_id)
                .await;
            let had_registered_edge = self
                .state
                .edge_registry
                .read()
                .await
                .contains_key(&params.server_id);
            info!(
                server_id = params.server_id,
                connection_id,
                disconnected_old_connections = disconnected,
                stale_session_count = stale_sessions.len(),
                had_registered_edge,
                "Fresh edge register cleanup snapshot"
            );
            let needs_cleanup = !stale_sessions.is_empty() || had_registered_edge;

            if needs_cleanup {
                warn!(
                    "Fresh edge process {} taking over — resetting remaining old state before register success",
                    params.server_id
                );
                self.cleanup_edge(params.server_id).await;
            } else {
                info!(
                    server_id = params.server_id,
                    connection_id,
                    "Fresh edge process had no stale Hub state to clean before register success"
                );
            }
        }

        let registration = EdgeRegistration {
            server_id: params.server_id,
            name: params.name.clone(),
            host: params.host.clone(),
            port: params.port,
            capacity: params.capacity,
            region: params.region.clone(),
            relay_port: None,
        };

        info!(
            "Edge registered: {} (id={}, fresh_process={}, {}:{})",
            registration.name,
            registration.server_id,
            fresh_process,
            registration.host,
            registration.port
        );

        self.state
            .edge_registry
            .write()
            .await
            .insert(params.server_id, registration);

        let edge_list: Vec<EdgeInfo> = self
            .state
            .edge_registry
            .read()
            .await
            .values()
            .map(|edge| EdgeInfo {
                server_id: edge.server_id,
                name: edge.name.clone(),
                host: edge.host.clone(),
                port: edge.port,
                region: edge.region.clone(),
                current_load: 0,
                capacity: edge.capacity,
                certificate: String::new(),
                last_seen: current_millis() as i64,
            })
            .collect();

        let mut server_limits = self.build_server_limits().await;
        server_limits.welcome_text = self.load_welcome_text().await;
        let response = self.make_response_packet(request_id, "edge.register", |packet| {
            packet.edge_register = Some(EdgeRegisterResult {
                success: true,
                hub_server_id: Some(params.server_id),
                edge_list,
                challenge: None,
                challenge_timeout: None,
                error: None,
                server_limits: Some(server_limits),
            });
        });

        self.push_route_tables_to_all().await;

        Ok(response)
    }

    pub(super) async fn kick_excess_sessions_for_user(&self, user_id: u32, max_sessions: u32) {
        if user_id == 0 || max_sessions == 0 {
            return;
        }
        let mut existing = self
            .state
            .session_manager
            .get_sessions_by_user(user_id)
            .await;
        if existing.len() < max_sessions as usize {
            return;
        }
        existing.sort_by_key(|session| session.session_id);
        let to_kick = existing.len() - max_sessions as usize + 1;
        for session in existing.into_iter().take(to_kick) {
            let ghost_session = session.session_id;
            self.state
                .session_manager
                .remove_session(ghost_session)
                .await;
            self.broadcast_notification("hub.userRemoveBroadcast", |notification| {
                notification.user_remove_broadcast = Some(HubUserRemoveBroadcastParams {
                    session: ghost_session,
                    actor: None,
                    reason: Some("Replaced by new connection (session limit reached)".to_string()),
                    ban: None,
                    target_sessions: vec![],
                });
            })
            .await;
            info!(
                "Kicked oldest session {} for user_id={} due to max_sessions_per_user={}",
                ghost_session, user_id, max_sessions
            );
        }
    }

    pub(super) async fn handle_authenticate_user(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        edge_server_id: u32,
        connection_id: u64,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_authenticate_user
            .as_ref()
            .context("Missing edge_authenticate_user params")?;

        let config = &self.state.config;
        let username = &params.username;
        let password = &params.password;

        let cancel = Arc::new(AtomicBool::new(false));
        self.state.pending_auths.write().await.insert(
            params.session_id,
            crate::server::PendingEdgeAuth {
                cancel: cancel.clone(),
                edge_id: edge_server_id,
            },
        );

        if let Some(re) = &self.username_regex
            && !re.is_match(username)
        {
            warn!(
                "Rejecting username '{}': does not match configured username_regex",
                username
            );
            return Ok(self.make_response_packet(
                request_id,
                "edge.authenticateUser",
                |response| {
                    response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                        success: false,
                        user_id: None,
                        username: None,
                        display_name: None,
                        groups: vec![],
                        reason: Some(format!(
                            "Invalid username: '{}' does not meet naming requirements",
                            username
                        )),
                        reject_type: Some(mumbleproto::reject::RejectType::InvalidUsername as u32),
                        channel_id: None,
                        mute: None,
                        deaf: None,
                        suppress: None,
                        self_mute: None,
                        self_deaf: None,
                        priority_speaker: None,
                        recording: None,
                        cert_required: None,
                    });
                },
            ));
        }

        let client_ip = params
            .client_info
            .as_ref()
            .map(|client| client.ip_address.clone())
            .unwrap_or_default();
        if config.auto_ban.enabled && !client_ip.is_empty() {
            self.state
                .failed_auth_tracker
                .write()
                .await
                .purge_stale(config.auto_ban.time_window);

            if let Some(ip_bytes) = parse_ip_to_bytes(&client_ip)
                && let Some(ban) = self.state.ban_store.check_ip_banned(&ip_bytes)
            {
                warn!(
                    "Rejecting connection from banned IP {}: {}",
                    client_ip, ban.reason
                );
                return Ok(self.make_response_packet(
                    request_id,
                    "edge.authenticateUser",
                    |response| {
                        response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None,
                            username: None,
                            display_name: None,
                            groups: vec![],
                            reason: Some(format!("You are banned: {}", ban.reason)),
                            reject_type: Some(2),
                            channel_id: None,
                            mute: None,
                            deaf: None,
                            suppress: None,
                            self_mute: None,
                            self_deaf: None,
                            priority_speaker: None,
                            recording: None,
                            cert_required: None,
                        });
                    },
                ));
            }
        }

        {
            let new_cert = params
                .client_info
                .as_ref()
                .and_then(|client| client.certificate_hash.clone())
                .unwrap_or_default();

            if !new_cert.is_empty() {
                let all_sessions = self.state.session_manager.get_all_sessions().await;
                if let Some(existing) = all_sessions
                    .iter()
                    .find(|session| session.username.eq_ignore_ascii_case(username))
                {
                    let ghost_session = existing.session_id;
                    if existing.cert_hash.is_empty()
                        || existing.cert_hash.as_str() == new_cert.as_str()
                    {
                        self.state
                            .session_manager
                            .remove_session(ghost_session)
                            .await;
                        self.broadcast_notification("hub.userRemoveBroadcast", |notification| {
                            notification.user_remove_broadcast =
                                Some(HubUserRemoveBroadcastParams {
                                    session: ghost_session,
                                    actor: None,
                                    reason: Some("Ghost connection replaced".to_string()),
                                    ban: None,
                                    target_sessions: vec![],
                                });
                        })
                        .await;
                        info!(
                            "Ghost session {} for user '{}' replaced by new cert connection",
                            ghost_session, username
                        );
                    } else {
                        warn!(
                            "Rejecting cert user '{}': username already in use by session {} with different cert",
                            username, ghost_session
                        );
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.authenticateUser",
                            |response| {
                                response.edge_authenticate_user =
                                    Some(EdgeAuthenticateUserResult {
                                        success: false,
                                        user_id: None,
                                        username: None,
                                        display_name: None,
                                        groups: vec![],
                                        reason: Some(format!(
                                            "Username '{}' is already in use",
                                            username
                                        )),
                                        reject_type: Some(4),
                                        channel_id: None,
                                        mute: None,
                                        deaf: None,
                                        suppress: None,
                                        self_mute: None,
                                        self_deaf: None,
                                        priority_speaker: None,
                                        recording: None,
                                        cert_required: None,
                                    });
                            },
                        ));
                    }
                }
            }
        }

        {
            let max_users = self.state.config.limits.max_users;
            if max_users > 0 {
                let current = self.state.session_manager.count_sessions().await;
                if current >= max_users as usize {
                    warn!(
                        "Rejecting user '{}': server at capacity ({}/{})",
                        username, current, max_users
                    );
                    return Ok(self.make_response_packet(
                        request_id,
                        "edge.authenticateUser",
                        |response| {
                            response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: false,
                                user_id: None,
                                username: None,
                                display_name: None,
                                groups: vec![],
                                reason: Some(format!("Server is full ({}/{})", current, max_users)),
                                reject_type: Some(6),
                                channel_id: None,
                                mute: None,
                                deaf: None,
                                suppress: None,
                                self_mute: None,
                                self_deaf: None,
                                priority_speaker: None,
                                recording: None,
                                cert_required: None,
                            });
                        },
                    ));
                }
            }
        }

        if self.state.auth_service.is_connected().await {
            let client_info = params.client_info.as_ref();
            let ext_request = ExtAuthRequest {
                request_id: request_id.to_string(),
                username: username.clone(),
                password: password.clone(),
                tokens: params.tokens.clone(),
                session_id: params.session_id,
                server_id: params.server_id,
                ip_address: client_info
                    .map(|client| client.ip_address.clone())
                    .unwrap_or_default(),
                ip_version: client_info
                    .map(|client| client.ip_version.clone())
                    .unwrap_or_default(),
                release: client_info
                    .map(|client| client.release.clone())
                    .unwrap_or_default(),
                version: client_info.and_then(|client| client.version),
                os: client_info
                    .map(|client| client.os.clone())
                    .unwrap_or_default(),
                os_version: client_info
                    .map(|client| client.os_version.clone())
                    .unwrap_or_default(),
                certificate_hash: client_info.and_then(|client| client.certificate_hash.clone()),
            };

            match self.state.auth_service.authenticate(ext_request).await {
                Some(resp) => {
                    if !resp.success {
                        let reject_type = resp.reject_type.or(Some(3));
                        self.record_auth_failure(&client_ip).await;
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.authenticateUser",
                            |response| {
                                response.edge_authenticate_user =
                                    Some(EdgeAuthenticateUserResult {
                                        success: false,
                                        user_id: None,
                                        username: None,
                                        display_name: None,
                                        groups: vec![],
                                        reason: resp.reason.clone(),
                                        reject_type,
                                        channel_id: None,
                                        mute: None,
                                        deaf: None,
                                        suppress: None,
                                        self_mute: None,
                                        self_deaf: None,
                                        priority_speaker: None,
                                        recording: None,
                                        cert_required: resp.cert_required,
                                    });
                            },
                        ));
                    }

                    let user_id = resp.user_id.unwrap_or(0);
                    let auth_username = resp.username.clone().unwrap_or_else(|| username.clone());
                    if user_id > 0 {
                        let auth_username_owned = auth_username.clone();
                        if let Err(error) = self
                            .state
                            .user_store
                            .upsert_ext_user(user_id, &auth_username_owned)
                            .await
                        {
                            warn!("Failed to persist ext-auth user: {}", error);
                        }
                    }
                    let channel_id = if let Some(channel_id) = resp.channel_id {
                        channel_id
                    } else if user_id > 0 {
                        let last_channel = self.state.user_store.get_last_channel(user_id).await;
                        if last_channel > 0
                            && self
                                .state
                                .channel_store
                                .get_channel(last_channel)
                                .await
                                .is_some()
                        {
                            last_channel
                        } else {
                            config.auth.default_channel
                        }
                    } else {
                        config.auth.default_channel
                    };

                    let session_info = SessionInfo {
                        session_id: params.session_id,
                        edge_id: edge_server_id,
                        user_id,
                        username: auth_username.clone(),
                        channel_id,
                        groups: resp.groups.clone(),
                        cert_hash: params
                            .client_info
                            .as_ref()
                            .and_then(|client| client.certificate_hash.clone())
                            .unwrap_or_default(),
                        mute: params.mute.unwrap_or(false),
                        deaf: params.deaf.unwrap_or(false),
                        suppress: params.suppress.unwrap_or(false),
                        self_mute: params.self_mute.unwrap_or(false),
                        self_deaf: params.self_deaf.unwrap_or(false),
                        priority_speaker: params.priority_speaker.unwrap_or(false),
                        recording: params.recording.unwrap_or(false),
                        listening_channels: vec![],
                    };
                    self.kick_excess_sessions_for_user(
                        user_id,
                        config.limits.max_sessions_per_user,
                    )
                    .await;
                    if cancel.load(Ordering::Relaxed) {
                        warn!(
                            "authenticate_user aborted for session {} (client disconnected during ext-service auth)",
                            params.session_id
                        );
                        return Ok(self.auth_disconnect_response(request_id));
                    }
                    if let Some(packet) = self
                        .reject_stale_auth_connection(
                            request_id,
                            edge_server_id,
                            connection_id,
                            params.session_id,
                        )
                        .await
                    {
                        return Ok(packet);
                    }
                    self.state.session_manager.add_session(session_info).await;
                    if cancel.load(Ordering::Relaxed) {
                        self.state
                            .session_manager
                            .remove_session(params.session_id)
                            .await;
                        warn!(
                            "authenticate_user (ext-service): session {} added then immediately reverted (client disconnected)",
                            params.session_id
                        );
                        return Ok(self.auth_disconnect_response(request_id));
                    }

                    self.log_authentication_success(AuthSuccessLog {
                        auth_backend: "ext_service",
                        username: &auth_username,
                        session_id: params.session_id,
                        edge_server_id,
                        channel_id,
                        source_ip: params
                            .client_info
                            .as_ref()
                            .map(|client| client.ip_address.as_str()),
                        groups: &resp.groups,
                    });

                    let cert_hash = params
                        .client_info
                        .as_ref()
                        .and_then(|client| client.certificate_hash.clone());
                    self.broadcast_notification("hub.userJoined", |notification| {
                        notification.user_joined = Some(HubUserJoinedParams {
                            session_id: params.session_id,
                            edge_id: edge_server_id,
                            user_id,
                            username: auth_username.clone(),
                            channel_id,
                            groups: resp.groups.clone(),
                            cert_hash,
                            mute: params.mute,
                            deaf: params.deaf,
                            suppress: params.suppress,
                            self_mute: params.self_mute,
                            self_deaf: params.self_deaf,
                            priority_speaker: params.priority_speaker,
                            recording: params.recording,
                            listening_channels: vec![],
                        });
                    })
                    .await;

                    return Ok(self.make_response_packet(
                        request_id,
                        "edge.authenticateUser",
                        |response| {
                            response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: true,
                                user_id: Some(user_id),
                                username: Some(auth_username),
                                display_name: resp.display_name.clone(),
                                groups: resp.groups,
                                reason: None,
                                reject_type: None,
                                channel_id: Some(channel_id),
                                mute: params.mute,
                                deaf: params.deaf,
                                suppress: params.suppress,
                                self_mute: params.self_mute,
                                self_deaf: params.self_deaf,
                                priority_speaker: params.priority_speaker,
                                recording: params.recording,
                                cert_required: resp.cert_required,
                            });
                        },
                    ));
                }
                None => {
                    if config.auth.require_auth_service {
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.authenticateUser",
                            |response| {
                                response.edge_authenticate_user =
                                    Some(EdgeAuthenticateUserResult {
                                        success: false,
                                        user_id: None,
                                        username: None,
                                        display_name: None,
                                        groups: vec![],
                                        reason: Some(
                                            "Authentication service unavailable".to_string(),
                                        ),
                                        reject_type: Some(8),
                                        channel_id: None,
                                        mute: None,
                                        deaf: None,
                                        suppress: None,
                                        self_mute: None,
                                        self_deaf: None,
                                        priority_speaker: None,
                                        recording: None,
                                        cert_required: None,
                                    });
                            },
                        ));
                    }
                    warn!(
                        "Auth service request timed out for user '{}'; falling back to local auth",
                        username
                    );
                }
            }
        } else if config.auth.require_auth_service
            && config.auth.http_url.is_none()
            && self.state.lua_engine.read().await.is_none()
        {
            return Ok(self.make_response_packet(
                request_id,
                "edge.authenticateUser",
                |response| {
                    response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                        success: false,
                        user_id: None,
                        username: None,
                        display_name: None,
                        groups: vec![],
                        reason: Some("Authentication service not connected".to_string()),
                        reject_type: Some(8),
                        channel_id: None,
                        mute: None,
                        deaf: None,
                        suppress: None,
                        self_mute: None,
                        self_deaf: None,
                        priority_speaker: None,
                        recording: None,
                        cert_required: None,
                    });
                },
            ));
        }

        let lua_engine_guard = self.state.lua_engine.read().await;
        if let Some(lua_engine) = lua_engine_guard.as_ref() {
            let engine = lua_engine.clone();
            drop(lua_engine_guard);
            let client_info = params.client_info.as_ref();
            let lua_req = LuaAuthRequest {
                username: username.clone(),
                password: password.clone(),
                session_id: params.session_id,
                tokens: params.tokens.clone(),
                server_id: params.server_id,
                ip: client_info
                    .map(|client| client.ip_address.clone())
                    .unwrap_or_default(),
                ip_version: client_info
                    .map(|client| client.ip_version.clone())
                    .unwrap_or_default(),
                release: client_info
                    .map(|client| client.release.clone())
                    .unwrap_or_default(),
                version: client_info.and_then(|client| client.version),
                os: client_info
                    .map(|client| client.os.clone())
                    .unwrap_or_default(),
                osversion: client_info
                    .map(|client| client.os_version.clone())
                    .unwrap_or_default(),
                certificate_hash: client_info.and_then(|client| client.certificate_hash.clone()),
            };

            match engine.authenticate(lua_req).await {
                Ok(resp) => {
                    if !resp.success {
                        self.record_auth_failure(&client_ip).await;
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.authenticateUser",
                            |response| {
                                response.edge_authenticate_user =
                                    Some(EdgeAuthenticateUserResult {
                                        success: false,
                                        user_id: None,
                                        username: None,
                                        display_name: None,
                                        groups: vec![],
                                        reason: resp.reason.clone(),
                                        reject_type: resp.reject_type.or(Some(3)),
                                        channel_id: None,
                                        mute: None,
                                        deaf: None,
                                        suppress: None,
                                        self_mute: None,
                                        self_deaf: None,
                                        priority_speaker: None,
                                        recording: None,
                                        cert_required: None,
                                    });
                            },
                        ));
                    }

                    let user_id = resp.user_id.unwrap_or(0);
                    let auth_username = resp.username.clone().unwrap_or_else(|| username.clone());
                    let groups = resp.groups.clone().unwrap_or_default();
                    if user_id > 0 {
                        let auth_username_owned = auth_username.clone();
                        if let Err(error) = self
                            .state
                            .user_store
                            .upsert_ext_user(user_id, &auth_username_owned)
                            .await
                        {
                            warn!("Failed to persist Lua-auth user: {}", error);
                        }
                    }
                    let channel_id = if user_id > 0 {
                        let last_channel = self.state.user_store.get_last_channel(user_id).await;
                        if last_channel > 0
                            && self
                                .state
                                .channel_store
                                .get_channel(last_channel)
                                .await
                                .is_some()
                        {
                            last_channel
                        } else {
                            config.auth.default_channel
                        }
                    } else {
                        config.auth.default_channel
                    };

                    let session_info = SessionInfo {
                        session_id: params.session_id,
                        edge_id: edge_server_id,
                        user_id,
                        username: auth_username.clone(),
                        channel_id,
                        groups: groups.clone(),
                        cert_hash: params
                            .client_info
                            .as_ref()
                            .and_then(|client| client.certificate_hash.clone())
                            .unwrap_or_default(),
                        mute: params.mute.unwrap_or(false),
                        deaf: params.deaf.unwrap_or(false),
                        suppress: params.suppress.unwrap_or(false),
                        self_mute: params.self_mute.unwrap_or(false),
                        self_deaf: params.self_deaf.unwrap_or(false),
                        priority_speaker: params.priority_speaker.unwrap_or(false),
                        recording: params.recording.unwrap_or(false),
                        listening_channels: vec![],
                    };
                    self.kick_excess_sessions_for_user(
                        user_id,
                        config.limits.max_sessions_per_user,
                    )
                    .await;
                    if cancel.load(Ordering::Relaxed) {
                        warn!(
                            "authenticate_user aborted for session {} (client disconnected during Lua auth)",
                            params.session_id
                        );
                        return Ok(self.auth_disconnect_response(request_id));
                    }
                    if let Some(packet) = self
                        .reject_stale_auth_connection(
                            request_id,
                            edge_server_id,
                            connection_id,
                            params.session_id,
                        )
                        .await
                    {
                        return Ok(packet);
                    }
                    self.state.session_manager.add_session(session_info).await;
                    if cancel.load(Ordering::Relaxed) {
                        self.state
                            .session_manager
                            .remove_session(params.session_id)
                            .await;
                        warn!(
                            "authenticate_user (lua): session {} added then immediately reverted (client disconnected)",
                            params.session_id
                        );
                        return Ok(self.auth_disconnect_response(request_id));
                    }

                    self.log_authentication_success(AuthSuccessLog {
                        auth_backend: "lua",
                        username: &auth_username,
                        session_id: params.session_id,
                        edge_server_id,
                        channel_id,
                        source_ip: params
                            .client_info
                            .as_ref()
                            .map(|client| client.ip_address.as_str()),
                        groups: &groups,
                    });

                    let cert_hash = params
                        .client_info
                        .as_ref()
                        .and_then(|client| client.certificate_hash.clone());
                    self.broadcast_notification("hub.userJoined", |notification| {
                        notification.user_joined = Some(HubUserJoinedParams {
                            session_id: params.session_id,
                            edge_id: edge_server_id,
                            user_id,
                            username: auth_username.clone(),
                            channel_id,
                            groups: groups.clone(),
                            cert_hash,
                            mute: params.mute,
                            deaf: params.deaf,
                            suppress: params.suppress,
                            self_mute: params.self_mute,
                            self_deaf: params.self_deaf,
                            priority_speaker: params.priority_speaker,
                            recording: params.recording,
                            listening_channels: vec![],
                        });
                    })
                    .await;

                    return Ok(self.make_response_packet(
                        request_id,
                        "edge.authenticateUser",
                        |response| {
                            response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: true,
                                user_id: Some(user_id),
                                username: Some(auth_username),
                                display_name: resp.display_name.clone(),
                                groups,
                                reason: None,
                                reject_type: None,
                                channel_id: Some(channel_id),
                                mute: params.mute,
                                deaf: params.deaf,
                                suppress: params.suppress,
                                self_mute: params.self_mute,
                                self_deaf: params.self_deaf,
                                priority_speaker: params.priority_speaker,
                                recording: params.recording,
                                cert_required: None,
                            });
                        },
                    ));
                }
                Err(error) => {
                    warn!(
                        "Lua auth error for '{}': {:#}; falling back to next auth method",
                        username, error
                    );
                    if config.auth.require_auth_service {
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.authenticateUser",
                            |response| {
                                response.edge_authenticate_user =
                                    Some(EdgeAuthenticateUserResult {
                                        success: false,
                                        user_id: None,
                                        username: None,
                                        display_name: None,
                                        groups: vec![],
                                        reason: Some(format!(
                                            "Authentication script error: {error}"
                                        )),
                                        reject_type: Some(8),
                                        channel_id: None,
                                        mute: None,
                                        deaf: None,
                                        suppress: None,
                                        self_mute: None,
                                        self_deaf: None,
                                        priority_speaker: None,
                                        recording: None,
                                        cert_required: None,
                                    });
                            },
                        ));
                    }
                }
            }
        }

        if let Some(ref http_url) = config.auth.http_url.clone() {
            let http_result = self
                .authenticate_via_http(
                    http_url,
                    HttpAuthCall {
                        username,
                        password,
                        tokens: &params.tokens,
                        server_id: params.server_id,
                        session_id: params.session_id,
                        client_info: params.client_info.as_ref(),
                        timeout_ms: config.auth.http_timeout_ms,
                    },
                )
                .await;

            match http_result {
                Ok(Some(resp)) => {
                    if !resp.success {
                        self.record_auth_failure(&client_ip).await;
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.authenticateUser",
                            |response| {
                                response.edge_authenticate_user =
                                    Some(EdgeAuthenticateUserResult {
                                        success: false,
                                        user_id: None,
                                        username: None,
                                        display_name: None,
                                        groups: vec![],
                                        reason: resp.reason.clone(),
                                        reject_type: resp.reject_type,
                                        channel_id: None,
                                        mute: None,
                                        deaf: None,
                                        suppress: None,
                                        self_mute: None,
                                        self_deaf: None,
                                        priority_speaker: None,
                                        recording: None,
                                        cert_required: None,
                                    });
                            },
                        ));
                    }

                    let user_id = resp.user_id.unwrap_or(0);
                    let auth_username = resp.username.clone().unwrap_or_else(|| username.clone());
                    let groups = resp.groups.clone().unwrap_or_default();
                    if user_id > 0 {
                        let auth_username_owned = auth_username.clone();
                        if let Err(error) = self
                            .state
                            .user_store
                            .upsert_ext_user(user_id, &auth_username_owned)
                            .await
                        {
                            warn!("Failed to persist HTTP-auth user: {}", error);
                        }
                    }
                    let channel_id = if user_id > 0 {
                        let last_channel = self.state.user_store.get_last_channel(user_id).await;
                        if last_channel > 0
                            && self
                                .state
                                .channel_store
                                .get_channel(last_channel)
                                .await
                                .is_some()
                        {
                            last_channel
                        } else {
                            config.auth.default_channel
                        }
                    } else {
                        config.auth.default_channel
                    };

                    let session_info = SessionInfo {
                        session_id: params.session_id,
                        edge_id: edge_server_id,
                        user_id,
                        username: auth_username.clone(),
                        channel_id,
                        groups: groups.clone(),
                        cert_hash: params
                            .client_info
                            .as_ref()
                            .and_then(|client| client.certificate_hash.clone())
                            .unwrap_or_default(),
                        mute: params.mute.unwrap_or(false),
                        deaf: params.deaf.unwrap_or(false),
                        suppress: params.suppress.unwrap_or(false),
                        self_mute: params.self_mute.unwrap_or(false),
                        self_deaf: params.self_deaf.unwrap_or(false),
                        priority_speaker: params.priority_speaker.unwrap_or(false),
                        recording: params.recording.unwrap_or(false),
                        listening_channels: vec![],
                    };
                    self.kick_excess_sessions_for_user(
                        user_id,
                        config.limits.max_sessions_per_user,
                    )
                    .await;
                    if cancel.load(Ordering::Relaxed) {
                        warn!(
                            "authenticate_user aborted for session {} (client disconnected during HTTP auth)",
                            params.session_id
                        );
                        return Ok(self.auth_disconnect_response(request_id));
                    }
                    if let Some(packet) = self
                        .reject_stale_auth_connection(
                            request_id,
                            edge_server_id,
                            connection_id,
                            params.session_id,
                        )
                        .await
                    {
                        return Ok(packet);
                    }
                    self.state.session_manager.add_session(session_info).await;
                    if cancel.load(Ordering::Relaxed) {
                        self.state
                            .session_manager
                            .remove_session(params.session_id)
                            .await;
                        warn!(
                            "authenticate_user (http): session {} added then immediately reverted (client disconnected)",
                            params.session_id
                        );
                        return Ok(self.auth_disconnect_response(request_id));
                    }

                    self.log_authentication_success(AuthSuccessLog {
                        auth_backend: "http",
                        username: &auth_username,
                        session_id: params.session_id,
                        edge_server_id,
                        channel_id,
                        source_ip: params
                            .client_info
                            .as_ref()
                            .map(|client| client.ip_address.as_str()),
                        groups: &groups,
                    });

                    let cert_hash = params
                        .client_info
                        .as_ref()
                        .and_then(|client| client.certificate_hash.clone());
                    self.broadcast_notification("hub.userJoined", |notification| {
                        notification.user_joined = Some(HubUserJoinedParams {
                            session_id: params.session_id,
                            edge_id: edge_server_id,
                            user_id,
                            username: auth_username.clone(),
                            channel_id,
                            groups: groups.clone(),
                            cert_hash,
                            mute: params.mute,
                            deaf: params.deaf,
                            suppress: params.suppress,
                            self_mute: params.self_mute,
                            self_deaf: params.self_deaf,
                            priority_speaker: params.priority_speaker,
                            recording: params.recording,
                            listening_channels: vec![],
                        });
                    })
                    .await;

                    return Ok(self.make_response_packet(
                        request_id,
                        "edge.authenticateUser",
                        |response| {
                            response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: true,
                                user_id: Some(user_id),
                                username: Some(auth_username),
                                display_name: resp.display_name.clone(),
                                groups,
                                reason: None,
                                reject_type: None,
                                channel_id: Some(channel_id),
                                mute: params.mute,
                                deaf: params.deaf,
                                suppress: params.suppress,
                                self_mute: params.self_mute,
                                self_deaf: params.self_deaf,
                                priority_speaker: params.priority_speaker,
                                recording: params.recording,
                                cert_required: None,
                            });
                        },
                    ));
                }
                Ok(None) => {
                    if config.auth.require_auth_service {
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.authenticateUser",
                            |response| {
                                response.edge_authenticate_user =
                                    Some(EdgeAuthenticateUserResult {
                                        success: false,
                                        user_id: None,
                                        username: None,
                                        display_name: None,
                                        groups: vec![],
                                        reason: Some(
                                            "Authentication service unavailable".to_string(),
                                        ),
                                        reject_type: Some(8),
                                        channel_id: None,
                                        mute: None,
                                        deaf: None,
                                        suppress: None,
                                        self_mute: None,
                                        self_deaf: None,
                                        priority_speaker: None,
                                        recording: None,
                                        cert_required: None,
                                    });
                            },
                        ));
                    }
                    warn!(
                        "HTTP auth request failed for user '{}'; falling back to local auth",
                        username
                    );
                }
                Err(error) => {
                    warn!(
                        "HTTP auth error for user '{}': {}; falling back to local auth",
                        username, error
                    );
                    if config.auth.require_auth_service {
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.authenticateUser",
                            |response| {
                                response.edge_authenticate_user =
                                    Some(EdgeAuthenticateUserResult {
                                        success: false,
                                        user_id: None,
                                        username: None,
                                        display_name: None,
                                        groups: vec![],
                                        reason: Some(format!(
                                            "Authentication service error: {}",
                                            error
                                        )),
                                        reject_type: Some(8),
                                        channel_id: None,
                                        mute: None,
                                        deaf: None,
                                        suppress: None,
                                        self_mute: None,
                                        self_deaf: None,
                                        priority_speaker: None,
                                        recording: None,
                                        cert_required: None,
                                    });
                            },
                        ));
                    }
                }
            }
        }

        if let Some(server_password) = &config.auth.server_password
            && !server_password.is_empty()
            && password != server_password
        {
            self.record_auth_failure(&client_ip).await;
            return Ok(self.make_response_packet(
                request_id,
                "edge.authenticateUser",
                |response| {
                    response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                        success: false,
                        user_id: None,
                        username: None,
                        display_name: None,
                        groups: vec![],
                        reason: Some("Invalid server password".to_string()),
                        reject_type: Some(4),
                        channel_id: None,
                        mute: None,
                        deaf: None,
                        suppress: None,
                        self_mute: None,
                        self_deaf: None,
                        priority_speaker: None,
                        recording: None,
                        cert_required: None,
                    });
                },
            ));
        }

        if !config.auth.allow_guest {
            let db_user = self.state.user_store.find_by_name(username).await?;
            if db_user.is_none() {
                self.record_auth_failure(&client_ip).await;
                return Ok(self.make_response_packet(
                    request_id,
                    "edge.authenticateUser",
                    |response| {
                        response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                            success: false,
                            user_id: None,
                            username: None,
                            display_name: None,
                            groups: vec![],
                            reason: Some("User not found and guest access is disabled".to_string()),
                            reject_type: Some(
                                mumbleproto::reject::RejectType::InvalidUsername as u32,
                            ),
                            channel_id: None,
                            mute: None,
                            deaf: None,
                            suppress: None,
                            self_mute: None,
                            self_deaf: None,
                            priority_speaker: None,
                            recording: None,
                            cert_required: None,
                        });
                    },
                ));
            }
        }

        let db_user = self.state.user_store.find_by_name(username).await?;
        let password_ok = if let Some(user) = db_user.as_ref() {
            let database = self.state.database.clone();
            let user_id = user.id;
            let password_hash =
                tokio::task::spawn_blocking(move || database.get_user_password_hash(user_id))
                    .await
                    .context("spawn_blocking join error for fetch_password_hash")??;
            match password_hash {
                None => true,
                Some(ref hash) if hash.is_empty() => true,
                Some(hash) => {
                    let password_owned = password.to_string();
                    tokio::task::spawn_blocking(move || verify_password(&hash, &password_owned))
                        .await
                        .context("spawn_blocking join error for argon2 verify")?
                }
            }
        } else {
            true
        };

        let (user_id, restored_channel_id) = match db_user {
            Some(ref user) => {
                if !password_ok {
                    self.record_auth_failure(&client_ip).await;
                    return Ok(self.make_response_packet(
                        request_id,
                        "edge.authenticateUser",
                        |response| {
                            response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                                success: false,
                                user_id: None,
                                username: None,
                                display_name: None,
                                groups: vec![],
                                reason: Some("Wrong password".to_string()),
                                reject_type: Some(3),
                                channel_id: None,
                                mute: None,
                                deaf: None,
                                suppress: None,
                                self_mute: None,
                                self_deaf: None,
                                priority_speaker: None,
                                recording: None,
                                cert_required: None,
                            });
                        },
                    ));
                }
                (user.id, user.last_channel)
            }
            None => (0, config.auth.default_channel),
        };

        let channel_id = if restored_channel_id > 0
            && self
                .state
                .channel_store
                .get_channel(restored_channel_id)
                .await
                .is_none()
        {
            config.auth.default_channel
        } else {
            restored_channel_id
        };

        let session_info = SessionInfo {
            session_id: params.session_id,
            edge_id: edge_server_id,
            user_id,
            username: username.clone(),
            channel_id,
            groups: if user_id > 0 {
                vec!["auth".to_string()]
            } else {
                vec![]
            },
            cert_hash: params
                .client_info
                .as_ref()
                .and_then(|client| client.certificate_hash.clone())
                .unwrap_or_default(),
            mute: params.mute.unwrap_or(false),
            deaf: params.deaf.unwrap_or(false),
            suppress: params.suppress.unwrap_or(false),
            self_mute: params.self_mute.unwrap_or(false),
            self_deaf: params.self_deaf.unwrap_or(false),
            priority_speaker: params.priority_speaker.unwrap_or(false),
            recording: params.recording.unwrap_or(false),
            listening_channels: vec![],
        };

        self.kick_excess_sessions_for_user(user_id, config.limits.max_sessions_per_user)
            .await;
        if cancel.load(Ordering::Relaxed) {
            warn!(
                "authenticate_user aborted for session {} (client disconnected during local DB auth)",
                params.session_id
            );
            return Ok(self.auth_disconnect_response(request_id));
        }
        if let Some(packet) = self
            .reject_stale_auth_connection(
                request_id,
                edge_server_id,
                connection_id,
                params.session_id,
            )
            .await
        {
            return Ok(packet);
        }
        self.state.session_manager.add_session(session_info).await;
        if cancel.load(Ordering::Relaxed) {
            self.state
                .session_manager
                .remove_session(params.session_id)
                .await;
            warn!(
                "authenticate_user (local db): session {} added then immediately reverted (client disconnected)",
                params.session_id
            );
            return Ok(self.auth_disconnect_response(request_id));
        }

        let groups = Vec::new();
        self.log_authentication_success(AuthSuccessLog {
            auth_backend: "local_db",
            username,
            session_id: params.session_id,
            edge_server_id,
            channel_id,
            source_ip: params
                .client_info
                .as_ref()
                .map(|client| client.ip_address.as_str()),
            groups: &groups,
        });

        let cert_hash = params
            .client_info
            .as_ref()
            .and_then(|client| client.certificate_hash.clone());
        self.broadcast_notification("hub.userJoined", |notification| {
            notification.user_joined = Some(HubUserJoinedParams {
                session_id: params.session_id,
                edge_id: edge_server_id,
                user_id,
                username: username.clone(),
                channel_id,
                groups: groups.clone(),
                cert_hash,
                mute: params.mute,
                deaf: params.deaf,
                suppress: params.suppress,
                self_mute: params.self_mute,
                self_deaf: params.self_deaf,
                priority_speaker: params.priority_speaker,
                recording: params.recording,
                listening_channels: vec![],
            });
        })
        .await;

        Ok(
            self.make_response_packet(request_id, "edge.authenticateUser", |response| {
                response.edge_authenticate_user = Some(EdgeAuthenticateUserResult {
                    success: true,
                    user_id: Some(user_id),
                    username: Some(username.clone()),
                    display_name: None,
                    groups: groups.clone(),
                    reason: None,
                    reject_type: None,
                    channel_id: Some(channel_id),
                    mute: params.mute,
                    deaf: params.deaf,
                    suppress: params.suppress,
                    self_mute: params.self_mute,
                    self_deaf: params.self_deaf,
                    priority_speaker: params.priority_speaker,
                    recording: params.recording,
                    cert_required: None,
                });
            }),
        )
    }

    pub(super) async fn authenticate_via_http(
        &self,
        url: &str,
        request: HttpAuthCall<'_>,
    ) -> Result<Option<HttpAuthResponse>> {
        let body = HttpAuthRequest {
            username: request.username.to_string(),
            password: request.password.to_string(),
            tokens: request.tokens.to_vec(),
            server_id: request.server_id,
            session_id: request.session_id,
            ip: request
                .client_info
                .map(|client| client.ip_address.clone())
                .unwrap_or_default(),
            ip_version: request
                .client_info
                .map(|client| client.ip_version.clone())
                .unwrap_or_default(),
            release: request
                .client_info
                .map(|client| client.release.clone())
                .unwrap_or_default(),
            version: request.client_info.and_then(|client| client.version),
            os: request
                .client_info
                .map(|client| client.os.clone())
                .unwrap_or_default(),
            osversion: request
                .client_info
                .map(|client| client.os_version.clone())
                .unwrap_or_default(),
            certificate_hash: request
                .client_info
                .and_then(|client| client.certificate_hash.clone()),
        };

        let response = self
            .http_client
            .post(url)
            .timeout(std::time::Duration::from_millis(request.timeout_ms))
            .json(&body)
            .send()
            .await;

        match response {
            Ok(resp) => {
                let mut auth_resp: HttpAuthResponse = resp.json().await?;
                if !auth_resp.success && auth_resp.reject_type.is_none() {
                    auth_resp.reject_type = Some(3);
                }
                Ok(Some(auth_resp))
            }
            Err(error) if error.is_timeout() => {
                warn!("HTTP auth timeout for user '{}'", request.username);
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }
}
