use super::*;

impl RpcHandler {
    pub(super) async fn handle_get_ban_list(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        if let Some(params) = request.edge_handle_acl.as_ref() {
            if params.actor_user_id > 0 {
                let actor_groups = self
                    .state
                    .session_manager
                    .get_session(params.actor_session)
                    .await
                    .map(|session| session.groups.clone())
                    .unwrap_or_default();
                let allowed = self
                    .state
                    .acl_manager
                    .has_permission(
                        params.actor_user_id as i32,
                        0,
                        &actor_groups,
                        permission::WRITE,
                    )
                    .await;
                if !allowed {
                    debug!(
                        "getBanList denied: actor_session={} actor_user_id={}: no WRITE on root channel",
                        params.actor_session, params.actor_user_id
                    );
                    return Ok(self.make_response_packet(request_id, "edge.getBanList", |response| {
                        response.edge_handle_acl = Some(EdgeHandleAclResult {
                            success: false,
                            permission_denied: Some(true),
                            error: Some("permission denied".to_string()),
                            ..Default::default()
                        });
                    }));
                }
            }
        }

        let bans = self.state.ban_store.get_all();
        let ban_entries: Vec<munode_protocol::mumbleproto::ban_list::BanEntry> = bans
            .iter()
            .map(|ban| munode_protocol::mumbleproto::ban_list::BanEntry {
                address: ban.address.to_vec(),
                mask: ban.mask,
                name: Some(ban.name.clone()),
                hash: Some(ban.cert_hash.clone()),
                reason: Some(ban.reason.clone()),
                start: Some(ban.start_time.to_string()),
                duration: Some(ban.duration),
            })
            .collect();

        let raw = prost::Message::encode_to_vec(&munode_protocol::mumbleproto::BanList {
            bans: ban_entries,
            query: Some(false),
        });

        Ok(self.make_response_packet(request_id, "edge.getBanList", |response| {
            response.edge_handle_acl = Some(EdgeHandleAclResult {
                success: true,
                raw_data: Some(raw),
                error: None,
                channel_id: None,
                permission_denied: None,
            });
        }))
    }

    pub(super) async fn handle_update_ban_list(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_handle_acl.as_ref()
            .context("Missing ban list data (via edge_handle_acl.raw_data)")?;

        if params.actor_user_id > 0 {
            let actor_groups = self
                .state
                .session_manager
                .get_session(params.actor_session)
                .await
                .map(|session| session.groups.clone())
                .unwrap_or_default();
            let allowed = self
                .state
                .acl_manager
                .has_permission(
                    params.actor_user_id as i32,
                    0,
                    &actor_groups,
                    permission::BAN,
                )
                .await;
            if !allowed {
                debug!(
                    "updateBanList denied: actor_session={} actor_user_id={}: no BAN on root channel",
                    params.actor_session, params.actor_user_id
                );
                return Ok(self.make_response_packet(request_id, "edge.updateBanList", |response| {
                    response.edge_handle_acl = Some(EdgeHandleAclResult {
                        success: false,
                        permission_denied: Some(true),
                        error: Some("permission denied".to_string()),
                        ..Default::default()
                    });
                }));
            }
        }

        let ban_list: munode_protocol::mumbleproto::BanList =
            prost::Message::decode(params.raw_data.as_slice())
                .context("Failed to decode BanList message")?;

        let bans_data: Vec<crate::database::BanRecord> = ban_list
            .bans
            .iter()
            .map(|ban| {
                let mut address = [0u8; 16];
                let copy_len = ban.address.len().min(16);
                address[..copy_len].copy_from_slice(&ban.address[..copy_len]);

                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;

                crate::database::BanRecord {
                    id: 0,
                    address,
                    mask: ban.mask,
                    name: ban.name.clone().unwrap_or_default(),
                    cert_hash: ban.hash.clone().unwrap_or_default(),
                    reason: ban.reason.clone().unwrap_or_default(),
                    start_time: ban
                        .start
                        .as_ref()
                        .and_then(|value| value.parse::<i64>().ok())
                        .unwrap_or(now),
                    duration: ban.duration.unwrap_or(0),
                }
            })
            .collect();

        self.state.ban_store.replace_bans(&bans_data).await?;
        info!("Updated ban list: {} entries", bans_data.len());

        Ok(self.make_response_packet(request_id, "edge.updateBanList", |response| {
            response.edge_handle_acl = Some(EdgeHandleAclResult {
                success: true,
                raw_data: None,
                error: None,
                channel_id: None,
                permission_denied: None,
            });
        }))
    }

    pub(super) async fn handle_get_user_list(&self, request_id: &str) -> Result<EdgeHubPacket> {
        let users = self.state.user_store.list().await?;
        let raw = prost::Message::encode_to_vec(&munode_protocol::mumbleproto::UserList {
            users: users
                .iter()
                .map(|user| munode_protocol::mumbleproto::user_list::User {
                    user_id: user.id,
                    name: Some(user.username.clone()),
                    last_seen: None,
                    last_channel: (user.last_channel > 0).then_some(user.last_channel),
                })
                .collect(),
        });

        Ok(self.make_response_packet(request_id, "edge.getUserList", |response| {
            response.edge_handle_acl = Some(EdgeHandleAclResult {
                success: true,
                raw_data: Some(raw),
                error: None,
                channel_id: None,
                permission_denied: None,
            });
        }))
    }

    pub(super) async fn handle_update_user_list(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_handle_acl.as_ref()
            .context("Missing user list data (via edge_handle_acl.raw_data)")?;

        if params.actor_user_id == 0 {
            return Ok(self.make_response_packet(request_id, "edge.updateUserList", |response| {
                response.edge_handle_acl = Some(EdgeHandleAclResult {
                    success: false,
                    raw_data: None,
                    error: Some("Permission denied".to_string()),
                    channel_id: None,
                    permission_denied: Some(true),
                });
            }));
        }

        let actor_groups: Vec<String> = self
            .state
            .session_manager
            .get_session(params.actor_session)
            .await
            .map(|session| session.groups.clone())
            .unwrap_or_default();
        let has_perm = self
            .state
            .acl_manager
            .has_permission(
                params.actor_user_id as i32,
                0,
                &actor_groups,
                permission::WRITE,
            )
            .await;
        if !has_perm {
            return Ok(self.make_response_packet(request_id, "edge.updateUserList", |response| {
                response.edge_handle_acl = Some(EdgeHandleAclResult {
                    success: false,
                    raw_data: None,
                    error: Some("Permission denied".to_string()),
                    channel_id: None,
                    permission_denied: Some(true),
                });
            }));
        }

        let user_list: munode_protocol::mumbleproto::UserList =
            prost::Message::decode(params.raw_data.as_slice())
                .context("Failed to decode UserList message")?;

        let mut error_msg = None;
        for user in &user_list.users {
            if let Some(new_name) = &user.name {
                if new_name.is_empty() {
                    self.state.user_store.delete(user.user_id).await?;
                } else {
                    match self.state.user_store.rename(user.user_id, new_name).await {
                        Ok(false) => error_msg = Some(format!("User {} not found", user.user_id)),
                        Err(error) => {
                            error_msg = Some(error.to_string());
                            break;
                        }
                        Ok(true) => {}
                    }
                }
            }
        }

        Ok(self.make_response_packet(request_id, "edge.updateUserList", |response| {
            response.edge_handle_acl = Some(EdgeHandleAclResult {
                success: error_msg.is_none(),
                raw_data: None,
                error: error_msg,
                channel_id: None,
                permission_denied: None,
            });
        }))
    }
}