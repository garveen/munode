use super::*;

impl RpcHandler {
    pub(super) async fn handle_full_sync(
        &self,
        _request: &TypedRpcRequest,
        request_id: &str,
        edge_server_id: u32,
    ) -> Result<EdgeHubPacket> {
        let fence_seq = crate::server::current_notification_seq(&self.state, edge_server_id);

        let channels: Vec<ChannelDataProto> = self
            .state
            .channel_store
            .get_channels_bfs()
            .await
            .iter()
            .map(|channel| ChannelDataProto {
                channel_id: channel.id,
                name: channel.name.clone(),
                parent_id: channel.parent_id,
                description: (!channel.description.is_empty()).then_some(channel.description.clone()),
                position: Some(channel.position),
                max_users: (channel.max_users > 0).then_some(channel.max_users),
                temporary: Some(channel.temporary),
                inherit_acl: Some(channel.inherit_acl),
                links: channel.links.iter().copied().collect(),
            })
            .collect();

        let mut link_set = std::collections::HashSet::new();
        let all_channels = self.state.channel_store.get_all_channels().await;
        let mut channel_links = Vec::new();
        for channel in &all_channels {
            for &target in &channel.links {
                let key = if channel.id < target {
                    (channel.id, target)
                } else {
                    (target, channel.id)
                };
                if link_set.insert(key) {
                    channel_links.push(ChannelLinkProto {
                        channel_id: key.0,
                        target_id: key.1,
                    });
                }
            }
        }

        let sessions: Vec<GlobalSessionProto> = self
            .state
            .session_manager
            .get_all_sessions()
            .await
            .iter()
            .map(|session| GlobalSessionProto {
                session_id: session.session_id,
                edge_id: session.edge_id,
                user_id: session.user_id,
                username: session.username.clone(),
                channel_id: session.channel_id,
                ip_address: None,
                cert_hash: (!session.cert_hash.is_empty()).then_some(session.cert_hash.clone()),
                connected_at: None,
                groups: session.groups.clone(),
                mute: Some(session.mute),
                deaf: Some(session.deaf),
                suppress: Some(session.suppress),
                self_mute: Some(session.self_mute),
                self_deaf: Some(session.self_deaf),
                priority_speaker: Some(session.priority_speaker),
                recording: Some(session.recording),
                listening_channels: session.listening_channels.clone(),
            })
            .collect();

        let health_map = self.state.edge_health.read().await;
        let edges: Vec<EdgeInfoProto> = self
            .state
            .edge_registry
            .read()
            .await
            .values()
            .map(|edge| {
                let user_count = health_map
                    .get(&edge.server_id)
                    .map(|health| health.user_count)
                    .unwrap_or(0);
                let current_load = if edge.capacity > 0 {
                    ((user_count as u64 * 1000) / edge.capacity as u64).min(1000) as u32
                } else {
                    0
                };
                EdgeInfoProto {
                    server_id: edge.server_id,
                    name: edge.name.clone(),
                    host: edge.host.clone(),
                    port: edge.port,
                    region: edge.region.clone(),
                    current_load,
                    capacity: edge.capacity,
                }
            })
            .collect();
        drop(health_map);

        let result = EdgeFullSyncResult {
            channels,
            channel_links,
            acls: vec![],
            bans: vec![],
            hub_was_empty: Some(sessions.is_empty()),
            sessions,
            timestamp: current_millis() as i64,
            sequence: fence_seq,
            edges,
        };

        Ok(self.make_response_packet(request_id, "edge.fullSync", |response| {
            response.edge_full_sync = Some(result);
        }))
    }

    pub(super) async fn handle_permission_query(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_handle_permission_query.as_ref()
            .context("Missing edge_handle_permission_query params")?;

        let mut effective_groups = self
            .state
            .session_manager
            .get_session(params.actor_session)
            .await
            .map(|session| session.groups.clone())
            .unwrap_or_default();
        let user_id = params.actor_user_id;

        let channel_snapshot = self.state.channel_store.get_parent_and_inherit_snapshot().await;
        let chain = build_ancestor_chain(&channel_snapshot, params.channel_id);
        for &ancestor_id in &chain {
            for group in &self.state.acl_manager.get_channel_groups(ancestor_id).await {
                if !group.inherit && ancestor_id != params.channel_id {
                    continue;
                }
                let is_added = group.add.contains(&user_id);
                let is_removed = group.remove.contains(&user_id);
                if is_added && !is_removed && !effective_groups.contains(&group.name) {
                    effective_groups.push(group.name.clone());
                }
            }
        }

        let inherit_flags: Vec<bool> = chain
            .iter()
            .map(|&channel_id| {
                channel_snapshot
                    .get(&channel_id)
                    .map(|(_, inherit_acl)| *inherit_acl)
                    .unwrap_or(true)
            })
            .collect();
        let permissions = self
            .state
            .acl_manager
            .calculate_permissions_with_chain(
                params.actor_user_id as i32,
                params.channel_id,
                &effective_groups,
                &chain,
                &inherit_flags,
            )
            .await;

        Ok(self.make_response_packet(request_id, "edge.handlePermissionQuery", |response| {
            response.edge_handle_permission_query = Some(EdgeHandlePermissionQueryResult {
                success: true,
                permissions: Some(permissions),
                error: None,
            });
        }))
    }

    pub(super) async fn handle_batch_permission_query(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_batch_permission_query.as_ref()
            .context("Missing edge_batch_permission_query params")?;

        let user_id = params.actor_user_id;
        let channel_snapshot = self.state.channel_store.get_parent_and_inherit_snapshot().await;
        let base_groups: Vec<String> = self
            .state
            .session_manager
            .get_session(params.actor_session)
            .await
            .map(|session| session.groups.clone())
            .unwrap_or_default();
        let chains: Vec<Vec<u32>> = params
            .channel_ids
            .iter()
            .map(|&channel_id| build_ancestor_chain(&channel_snapshot, channel_id))
            .collect();
        let groups_snapshot = self.state.acl_manager.channel_groups_snapshot().await;
        let acl_snapshot = self.state.acl_manager.acl_entries_snapshot().await;

        let mut entries = Vec::with_capacity(params.channel_ids.len());
        for (index, &channel_id) in params.channel_ids.iter().enumerate() {
            let chain = &chains[index];
            let inherit_flags: Vec<bool> = chain
                .iter()
                .map(|&candidate_channel_id| {
                    channel_snapshot
                        .get(&candidate_channel_id)
                        .map(|(_, inherit)| *inherit)
                        .unwrap_or(true)
                })
                .collect();

            let mut effective_groups = base_groups.clone();
            for &ancestor_id in chain {
                if let Some(ancestor_groups) = groups_snapshot.get(&ancestor_id) {
                    for group in ancestor_groups {
                        if !group.inherit && ancestor_id != channel_id {
                            continue;
                        }
                        let is_added = group.add.contains(&user_id);
                        let is_removed = group.remove.contains(&user_id);
                        if is_added && !is_removed && !effective_groups.contains(&group.name) {
                            effective_groups.push(group.name.clone());
                        }
                    }
                }
            }

            let permissions = self
                .state
                .acl_manager
                .calculate_permissions_with_chain(
                    user_id as i32,
                    channel_id,
                    &effective_groups,
                    chain,
                    &inherit_flags,
                )
                .await;
            let is_enter_restricted = AclManager::is_enter_restricted_with_chain(
                channel_id,
                chain,
                &inherit_flags,
                &acl_snapshot,
            );

            entries.push(ChannelPermissionEntry {
                channel_id,
                permissions,
                is_enter_restricted: Some(is_enter_restricted),
            });
        }

        Ok(self.make_response_packet(request_id, "edge.batchPermissionQuery", |response| {
            response.edge_batch_permission_query = Some(EdgeBatchPermissionQueryResult {
                success: true,
                entries,
                error: None,
            });
        }))
    }
}