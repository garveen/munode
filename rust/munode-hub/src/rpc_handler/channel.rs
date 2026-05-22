use super::*;

impl RpcHandler {
    pub(super) async fn handle_save_channel(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_save_channel
            .as_ref()
            .context("Missing edge_save_channel params")?;

        // Validate channel name against configured regex (for create and rename).
        if let Some(channel_name) = &params.name
            && let Some(re) = &self.channel_name_regex
            && !re.is_match(channel_name)
        {
            warn!(
                "Rejecting channel name '{}': does not match configured channel_name_regex",
                channel_name
            );
            return Ok(
                self.make_response_packet(request_id, "edge.saveChannel", |r| {
                    r.edge_save_channel = Some(EdgeSaveChannelResult {
                        success: false,
                        channel_id: None,
                        error: Some(format!(
                            "Invalid channel name: '{}' does not meet naming requirements",
                            channel_name
                        )),
                    });
                }),
            );
        }

        let is_new = params.id.is_none();
        let channel_id = if is_new {
            // Reject creating a permanent channel inside a temporary channel
            if let Some(parent_id) = params.parent_id
                && let Some(parent_ch) = self.state.channel_store.get_channel(parent_id).await
                && parent_ch.temporary
            {
                return Ok(
                    self.make_response_packet(request_id, "edge.saveChannel", |r| {
                        r.edge_save_channel = Some(EdgeSaveChannelResult {
                            success: false,
                            channel_id: None,
                            error: Some(
                                "Cannot create a permanent channel inside a temporary channel"
                                    .to_string(),
                            ),
                        });
                    }),
                );
            }

            // Check channel count limit
            let count_limit = self.state.config.limits.channel_count_limit;
            if count_limit > 0 {
                let current_count = self.state.channel_store.count().await as u32;
                if current_count >= count_limit {
                    return Ok(
                        self.make_response_packet(request_id, "edge.saveChannel", |r| {
                            r.edge_save_channel = Some(EdgeSaveChannelResult {
                                success: false,
                                channel_id: None,
                                error: Some(format!(
                                    "Channel count limit ({}) reached",
                                    count_limit
                                )),
                            });
                        }),
                    );
                }
            }

            // Check nesting depth limit
            let nesting_limit = self.state.config.limits.channel_nesting_limit;
            if nesting_limit > 0
                && let Some(parent_id) = params.parent_id
            {
                let depth = {
                    let mut d = 1u32;
                    let mut cur = parent_id;
                    let channels = self.state.channel_store.get_all_channels().await;
                    let parent_map: std::collections::HashMap<u32, Option<u32>> =
                        channels.iter().map(|c| (c.id, c.parent_id)).collect();
                    while let Some(&Some(pid)) = parent_map.get(&cur) {
                        d += 1;
                        cur = pid;
                        if d > nesting_limit {
                            break;
                        }
                    }
                    d
                };
                if depth > nesting_limit {
                    return Ok(
                        self.make_response_packet(request_id, "edge.saveChannel", |r| {
                            r.edge_save_channel = Some(EdgeSaveChannelResult {
                                success: false,
                                channel_id: None,
                                error: Some(format!(
                                    "Channel nesting limit ({}) exceeded",
                                    nesting_limit
                                )),
                            });
                        }),
                    );
                }
            }

            // Create new channel
            let channel_name = params
                .name
                .clone()
                .unwrap_or_else(|| "New Channel".to_string());

            // Check for duplicate sibling name (Murmur Messages.cpp:1344).
            {
                let all_channels = self.state.channel_store.get_all_channels().await;
                if all_channels
                    .iter()
                    .any(|c| c.parent_id == params.parent_id && c.name == channel_name)
                {
                    return Ok(
                        self.make_response_packet(request_id, "edge.saveChannel", |r| {
                            r.edge_save_channel = Some(EdgeSaveChannelResult {
                                success: false,
                                channel_id: None,
                                error: Some(format!(
                                    "A channel named '{}' already exists in this location",
                                    channel_name
                                )),
                            });
                        }),
                    );
                }
            }

            let is_temp = params.temporary.unwrap_or(false);

            let ch = ChannelRecord {
                id: 0, // Will be assigned by create_channel
                name: channel_name,
                parent_id: params.parent_id,
                description: params.description.clone().unwrap_or_default(),
                position: params.position.unwrap_or(0),
                max_users: params.max_users.unwrap_or(0),
                temporary: is_temp,
                inherit_acl: params.inherit_acl.unwrap_or(true),
                links: std::collections::HashSet::new(),
            };
            let id = self
                .state
                .channel_store
                .create_and_persist(ch.clone())
                .await
                .context("Failed to create and persist channel")?;

            // Broadcast channel created
            let proto = ChannelDataProto {
                channel_id: id,
                name: ch.name.clone(),
                parent_id: ch.parent_id,
                description: Some(ch.description.clone()),
                position: Some(ch.position),
                max_users: if ch.max_users > 0 {
                    Some(ch.max_users)
                } else {
                    None
                },
                temporary: Some(is_temp),
                inherit_acl: Some(ch.inherit_acl),
                links: vec![],
            };
            self.broadcast_notification("hub.channelCreated", |n| {
                n.channel_created = Some(HubChannelCreatedParams { channel: proto });
            })
            .await;

            // Temporary channel: immediately move the creator into it (Murmur Messages.cpp:1433).
            if is_temp
                && let Some(creator_session) = params.creator_session
                && creator_session != 0
                && self
                    .state
                    .session_manager
                    .get_session(creator_session)
                    .await
                    .is_some()
                && let Some((old_ch, moved_params)) = self
                    .apply_authoritative_user_move(creator_session, id, Some(creator_session))
                    .await
            {
                self.broadcast_notification("hub.userMoved", |n| {
                    n.user_moved = Some(moved_params);
                })
                .await;
                info!(
                    session_id = creator_session,
                    channel_id = id,
                    "Temporary channel created: moved creator into new channel"
                );
                // Clean up the old channel if it was also temporary and is now empty.
                self.maybe_cleanup_temp_channel(old_ch).await;
            }

            id
        } else {
            // Update existing channel
            let id = params.id.unwrap();
            if let Some(mut ch) = self.state.channel_store.get_channel(id).await {
                let old_parent_id = ch.parent_id;
                let old_inherit_acl = ch.inherit_acl;
                if let Some(name) = &params.name {
                    // Check for duplicate sibling name (excluding the current channel itself).
                    let new_name = name.clone();
                    let effective_parent = params.parent_id.map(Some).unwrap_or(ch.parent_id);
                    let all_channels = self.state.channel_store.get_all_channels().await;
                    if all_channels.iter().any(|c| {
                        c.parent_id == effective_parent && c.id != id && c.name == new_name
                    }) {
                        return Ok(self.make_response_packet(
                            request_id,
                            "edge.saveChannel",
                            |r| {
                                r.edge_save_channel = Some(EdgeSaveChannelResult {
                                    success: false,
                                    channel_id: Some(id),
                                    error: Some(format!(
                                        "A channel named '{}' already exists in this location",
                                        new_name
                                    )),
                                });
                            },
                        ));
                    }
                    ch.name = new_name;
                }
                if let Some(pos) = params.position {
                    ch.position = pos;
                }
                if let Some(max) = params.max_users {
                    ch.max_users = max;
                }
                if let Some(parent) = params.parent_id {
                    ch.parent_id = Some(parent);
                }
                if let Some(inherit) = params.inherit_acl {
                    ch.inherit_acl = inherit;
                }
                if let Some(desc) = &params.description {
                    ch.description = desc.clone();
                }

                self.state
                    .channel_store
                    .update_and_persist(ch.clone())
                    .await
                    .context("Failed to update and persist channel")?;

                if old_parent_id != ch.parent_id || old_inherit_acl != ch.inherit_acl {
                    self.state.acl_manager.invalidate_channel(id).await;
                }

                // Broadcast channel updated
                let proto = ChannelDataProto {
                    channel_id: ch.id,
                    name: ch.name,
                    parent_id: ch.parent_id,
                    description: Some(ch.description),
                    position: Some(ch.position),
                    max_users: if ch.max_users > 0 {
                        Some(ch.max_users)
                    } else {
                        None
                    },
                    temporary: Some(ch.temporary),
                    inherit_acl: Some(ch.inherit_acl),
                    links: ch.links.iter().copied().collect(),
                };
                self.broadcast_notification("hub.channelUpdated", |n| {
                    n.channel_updated = Some(HubChannelUpdatedParams { channel: proto });
                })
                .await;
            }
            id
        };

        let result = EdgeSaveChannelResult {
            success: true,
            channel_id: Some(channel_id),
            error: None,
        };

        Ok(
            self.make_response_packet(request_id, "edge.saveChannel", |r| {
                r.edge_save_channel = Some(result);
            }),
        )
    }

    pub(super) async fn handle_acl(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_handle_acl
            .as_ref()
            .context("Missing edge_handle_acl params")?;

        if params.query {
            // ACL query: return ACL entries for the channel (including inherited from parents).
            // This mirrors Murmur's sendACL behaviour: walk the chain from root to the target
            // channel, collect parent-channel ACLs that have apply_subs=true (marked inherited),
            // then append the target channel's own ACLs (marked not-inherited).
            let channel_id = params.channel_id;
            let inherit_acl = self
                .state
                .channel_store
                .get_channel(channel_id)
                .await
                .map(|c| c.inherit_acl)
                .unwrap_or(true);

            // Build the chain [root, ..., parent] stopping at inheritance breaks.
            // inherit_acl on a channel means "this channel inherits ACLs from its parent".
            // When a channel has inherit_acl=false the chain stops there: ancestors above
            // that point do not contribute to this channel's (or its descendants') effective
            // ACLs, so they should not appear as "inherited" in the ACL dialog.
            let mut ancestor_chain: Vec<u32> = Vec::new();
            {
                let mut cur = channel_id;
                loop {
                    let ch = match self.state.channel_store.get_channel(cur).await {
                        Some(c) => c,
                        None => break,
                    };
                    if !ch.inherit_acl {
                        break; // cur does not inherit from its parent; stop here
                    }
                    match ch.parent_id {
                        Some(pid) => {
                            ancestor_chain.push(pid);
                            cur = pid;
                        }
                        None => break,
                    }
                }
                ancestor_chain.reverse(); // root first
            }

            // Collect ACL entries: inherited ones from ancestors first, then own.
            let mut acls_proto: Vec<munode_protocol::mumbleproto::acl::ChanAcl> = Vec::new();

            for &ancestor_id in &ancestor_chain {
                let ancestor_acls = self.state.acl_manager.get_channel_acls(ancestor_id).await;
                for a in &ancestor_acls {
                    if !a.apply_subs {
                        continue; // only include ACLs that propagate to sub-channels
                    }
                    acls_proto.push(munode_protocol::mumbleproto::acl::ChanAcl {
                        apply_here: Some(a.apply_here),
                        apply_subs: Some(a.apply_subs),
                        user_id: a.user_id.map(|id| id as u32),
                        group: a.group_name.clone(),
                        grant: Some(a.allow),
                        deny: Some(a.deny),
                        inherited: Some(true),
                    });
                }
            }

            // Own ACLs for the target channel (not inherited).
            let own_acls = self.state.acl_manager.get_channel_acls(channel_id).await;
            for a in &own_acls {
                acls_proto.push(munode_protocol::mumbleproto::acl::ChanAcl {
                    apply_here: Some(a.apply_here),
                    apply_subs: Some(a.apply_subs),
                    user_id: a.user_id.map(|id| id as u32),
                    group: a.group_name.clone(),
                    grant: Some(a.allow),
                    deny: Some(a.deny),
                    inherited: Some(false),
                });
            }

            // Load channel groups for this channel from the in-memory store.
            let groups_proto: Vec<munode_protocol::mumbleproto::acl::ChanGroup> = self
                .state
                .acl_manager
                .get_channel_groups(channel_id)
                .await
                .iter()
                .map(|g| munode_protocol::mumbleproto::acl::ChanGroup {
                    name: g.name.clone(),
                    inherited: Some(false),
                    inherit: Some(g.inherit),
                    inheritable: Some(g.inheritable),
                    add: g.add.clone(),
                    remove: g.remove.clone(),
                    inherited_members: vec![],
                })
                .collect();

            // Encode ACL data as raw bytes (Mumble ACL message format)
            // Do NOT set query=true in the response: the official Mumble client initialises its
            // ACLEditor with msg=server_response, then re-uses msg for the save (without
            // clearing the query field).  If the server encodes query=true in the response, the
            // protobuf field survives into the save message and the server incorrectly treats
            // the save as another query — re-sending the ACL and causing the dialog to reopen.
            // C++ Murmur avoids this with an explicit msg.clear_query() before sending.
            let acl_msg = munode_protocol::mumbleproto::Acl {
                channel_id,
                inherit_acls: Some(inherit_acl),
                groups: groups_proto,
                acls: acls_proto,
                query: None,
            };

            let raw = prost::Message::encode_to_vec(&acl_msg);

            let result = EdgeHandleAclResult {
                success: true,
                raw_data: Some(raw),
                error: None,
                channel_id: Some(params.channel_id),
                permission_denied: None,
            };
            Ok(
                self.make_response_packet(request_id, "edge.handleACL", |r| {
                    r.edge_handle_acl = Some(result);
                }),
            )
        } else {
            // ACL update: parse raw data and save
            let acl_msg: munode_protocol::mumbleproto::Acl =
                prost::Message::decode(params.raw_data.as_slice())
                    .context("Failed to decode ACL message")?;

            let entries: Vec<crate::acl_manager::AclEntry> = acl_msg
                .acls
                .iter()
                .map(|a| crate::acl_manager::AclEntry {
                    channel_id: params.channel_id,
                    user_id: a.user_id.map(|id| id as i32),
                    group_name: a.group.clone(),
                    apply_here: a.apply_here.unwrap_or(true),
                    apply_subs: a.apply_subs.unwrap_or(true),
                    allow: a.grant.unwrap_or(0),
                    deny: a.deny.unwrap_or(0),
                })
                .collect();

            self.state
                .acl_manager
                .save_acls(params.channel_id, &entries)
                .await?;

            // Save channel groups through the AclManager (write-through: DB + in-memory).
            let channel_groups: Vec<crate::acl_manager::ChannelGroup> = acl_msg
                .groups
                .iter()
                .map(|g| crate::acl_manager::ChannelGroup {
                    id: 0,
                    name: g.name.clone(),
                    inherit: g.inherit.unwrap_or(true),
                    inheritable: g.inheritable.unwrap_or(true),
                    add: g.add.clone(),
                    remove: g.remove.clone(),
                })
                .collect();
            if let Err(e) = self
                .state
                .acl_manager
                .save_channel_groups(params.channel_id, channel_groups)
                .await
            {
                warn!("Failed to save channel groups: {}", e);
            }

            // Update inherit_acl flag on channel if provided
            if let Some(inherit) = acl_msg.inherit_acls
                && let Some(mut ch) = self
                    .state
                    .channel_store
                    .get_channel(params.channel_id)
                    .await
            {
                ch.inherit_acl = inherit;
                self.state.channel_store.update_channel(ch).await;
            }

            // Self-protection: if the actor lost Write access after applying the new ACLs,
            // re-insert a Write|Traverse ACL for them so they cannot lock themselves out.
            // Mirrors Murmur's msgACL post-write check in Messages.cpp.
            // Super-users are always guaranteed Write regardless of ACL entries, so skip.
            let actor_user_id = params.actor_user_id as i32;
            if actor_user_id > 0 {
                let actor_groups: Vec<String> = match self
                    .state
                    .session_manager
                    .get_session(params.actor_session)
                    .await
                {
                    Some(s) => s.groups.clone(),
                    None => vec![],
                };
                let still_has_write = self
                    .state
                    .acl_manager
                    .has_permission(
                        actor_user_id,
                        params.channel_id,
                        &actor_groups,
                        permission::WRITE,
                    )
                    .await;
                if !still_has_write {
                    let mut entries = self
                        .state
                        .acl_manager
                        .get_channel_acls(params.channel_id)
                        .await;
                    entries.push(crate::acl_manager::AclEntry {
                        channel_id: params.channel_id,
                        user_id: Some(actor_user_id),
                        group_name: None,
                        apply_here: true,
                        apply_subs: false,
                        allow: permission::WRITE | permission::TRAVERSE,
                        deny: 0,
                    });
                    if let Err(e) = self
                        .state
                        .acl_manager
                        .save_acls(params.channel_id, &entries)
                        .await
                    {
                        warn!(
                            "Failed to save self-protection ACL for user {}: {}",
                            actor_user_id, e
                        );
                    }
                }
            }

            // Audit log the ACL change.
            let db = self.state.database.clone();
            let log_channel_id = params.channel_id;
            let log_actor = if params.actor_user_id > 0 {
                Some(params.actor_user_id as i32)
            } else {
                None
            };
            let log_entries = entries.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(e) = db.log_acl_change(log_channel_id, log_actor, &log_entries) {
                    warn!("Failed to write acl_audit_log: {}", e);
                }
            });

            // Broadcast ACL update notification to all edges, including whether this
            // channel is now enter-restricted (computed once here to avoid an extra RPC
            // round-trip per Edge per AclUpdated event).
            let is_enter_restricted = {
                let channel_snapshot = self
                    .state
                    .channel_store
                    .get_parent_and_inherit_snapshot()
                    .await;
                let chain = build_ancestor_chain(&channel_snapshot, params.channel_id);
                let inherit_flags: Vec<bool> = chain
                    .iter()
                    .map(|&cid| {
                        channel_snapshot
                            .get(&cid)
                            .map(|(_, inh)| *inh)
                            .unwrap_or(true)
                    })
                    .collect();
                let acl_snapshot = self.state.acl_manager.acl_entries_snapshot().await;
                AclManager::is_enter_restricted_with_chain(
                    params.channel_id,
                    &chain,
                    &inherit_flags,
                    &acl_snapshot,
                )
            };
            self.broadcast_notification("hub.aclUpdated", |n| {
                n.unknown_params_json = Some(
                    serde_json::json!({
                        "channel_id": params.channel_id,
                        "is_enter_restricted": is_enter_restricted,
                    })
                    .to_string(),
                );
            })
            .await;

            let result = EdgeHandleAclResult {
                success: true,
                raw_data: None,
                error: None,
                channel_id: Some(params.channel_id),
                permission_denied: None,
            };
            Ok(
                self.make_response_packet(request_id, "edge.handleACL", |r| {
                    r.edge_handle_acl = Some(result);
                }),
            )
        }
    }

    /// Handle edge.saveChannelListeners — persist a user's listening channels.
    pub(super) async fn handle_save_channel_listeners(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = match &request.edge_save_channel_listeners {
            Some(p) => p,
            None => {
                return Ok(self.make_error_packet(
                    request_id,
                    -1,
                    "Missing edge_save_channel_listeners params",
                ));
            }
        };
        // Only save for registered users (user_id > 0); guests (user_id == 0) are skipped.
        if params.user_id > 0 {
            if let Err(e) = self
                .state
                .user_store
                .save_listeners(params.user_id, &params.channel_ids)
                .await
            {
                warn!(
                    "Failed to save channel listeners for user {}: {}",
                    params.user_id, e
                );
                return Ok(self.make_response_packet(
                    request_id,
                    "edge.saveChannelListeners",
                    |r| {
                        r.edge_save_channel_listeners = Some(EdgeSaveChannelListenersResult {
                            success: false,
                            error: Some(e.to_string()),
                        });
                    },
                ));
            }
            debug!(
                "Saved {} channel listeners for user {}",
                params.channel_ids.len(),
                params.user_id
            );
        }
        Ok(
            self.make_response_packet(request_id, "edge.saveChannelListeners", |r| {
                r.edge_save_channel_listeners = Some(EdgeSaveChannelListenersResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }

    /// Handle edge.loadChannelListeners — retrieve a user's persisted listening channels.
    pub(super) async fn handle_load_channel_listeners(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = match &request.edge_load_channel_listeners {
            Some(p) => p,
            None => {
                return Ok(self.make_error_packet(
                    request_id,
                    -1,
                    "Missing edge_load_channel_listeners params",
                ));
            }
        };
        if params.user_id == 0 {
            // Guests have no persistent listeners.
            return Ok(
                self.make_response_packet(request_id, "edge.loadChannelListeners", |r| {
                    r.edge_load_channel_listeners = Some(EdgeLoadChannelListenersResult {
                        success: true,
                        channel_ids: vec![],
                        error: None,
                    });
                }),
            );
        }
        let channel_ids = match self
            .state
            .user_store
            .consume_listeners(params.user_id, crate::user_store::LISTENER_TTL_SECS)
            .await
        {
            Ok(ids) => ids,
            Err(e) => {
                warn!(
                    "Failed to consume channel listeners for user {}: {}",
                    params.user_id, e
                );
                Vec::new()
            }
        };
        debug!(
            "Consumed {} channel listeners for user {}",
            channel_ids.len(),
            params.user_id
        );
        Ok(
            self.make_response_packet(request_id, "edge.loadChannelListeners", |r| {
                r.edge_load_channel_listeners = Some(EdgeLoadChannelListenersResult {
                    success: true,
                    channel_ids,
                    error: None,
                });
            }),
        )
    }

    /// Check if a channel is temporary and empty, and if so delete it and broadcast.
    ///
    /// After deleting the channel, this method also checks the parent channel — if
    /// the parent is also temporary and is now empty (because all children were deleted),
    /// it is cleaned up too, walking up the tree until a non-empty or non-temporary
    /// ancestor is reached.
    pub(super) async fn maybe_cleanup_temp_channel(&self, channel_id: u32) {
        // Walk up the ancestor chain, cleaning up empty temporary channels.
        let mut current_id = channel_id;
        loop {
            if current_id == 0 {
                return; // Never delete root channel
            }
            let ch = match self.state.channel_store.get_channel(current_id).await {
                Some(c) => c,
                None => return,
            };
            if !ch.temporary {
                return; // Reached a permanent channel — stop
            }
            // Keep channel if any session is in it
            let sessions = self.state.session_manager.get_all_sessions().await;
            if sessions.iter().any(|s| s.channel_id == current_id) {
                return;
            }
            // Keep channel if it still has sub-channels
            let has_children = self
                .state
                .channel_store
                .get_all_channels()
                .await
                .iter()
                .any(|c| c.parent_id == Some(current_id));
            if has_children {
                return;
            }
            let parent_id = ch.parent_id;
            // Delete this empty temporary channel via the coordinated helper
            // (persists to DB, clears ACL/group memory, broadcasts to edges).
            info!(
                "Deleting empty temporary channel {} ('{}')",
                current_id, ch.name
            );
            self.remove_channel_coordinated(current_id).await;
            // Continue to check the parent channel
            match parent_id {
                Some(pid) => current_id = pid,
                None => return,
            }
        }
    }

    /// Remove a channel (and its entire sub-tree) from all in-memory stores, persist the
    /// deletions to the database, and broadcast the necessary state-change notifications to
    /// all connected Edges.  Mirrors Murmur's `Server::removeChannel` semantics:
    ///
    /// 1. Collect the full sub-tree (depth-first, leaves first).
    /// 2. Move every session that lives inside any channel of the sub-tree to `dest`
    ///    (the parent of the top-level deleted channel, or root if it has no parent),
    ///    broadcasting `hub.userMoved` for each.
    /// 3. Remove channel-listener state for every session that was listening to any
    ///    channel in the sub-tree, broadcasting `hub.userStateBroadcast` with
    ///    `listening_channel_remove` for each affected session.
    /// 4. For each channel in the sub-tree (children before parents): remove from
    ///    channel_store + ACL manager, persist to DB, broadcast `hub.channelRemoved`.
    ///
    /// This is the single authoritative call site for channel removal — both
    /// the explicit admin delete path and the automatic temporary-channel
    /// cleanup loop must go through here, so that all stores stay consistent
    /// without the caller having to know about every downstream store.
    pub(super) async fn remove_channel_coordinated(&self, channel_id: u32) {
        if channel_id == 0 {
            return; // Never delete root channel
        }

        // --- 1. Collect the full sub-tree, leaves first ---
        // Build a reverse-BFS list (breadth-first from root, then reverse = leaves first).
        let all_channels = self.state.channel_store.get_all_channels().await;
        let mut subtree: Vec<u32> = Vec::new();
        let mut queue: std::collections::VecDeque<u32> = std::collections::VecDeque::new();
        queue.push_back(channel_id);
        while let Some(current) = queue.pop_front() {
            subtree.push(current);
            for ch in all_channels.iter().filter(|c| c.parent_id == Some(current)) {
                queue.push_back(ch.id);
            }
        }
        // Reverse so children come before parents (matches Murmur's recursive call order).
        subtree.reverse();

        let subtree_set: std::collections::HashSet<u32> = subtree.iter().copied().collect();

        // Determine the destination channel for displaced users.
        let dest = all_channels
            .iter()
            .find(|c| c.id == channel_id)
            .and_then(|c| c.parent_id)
            .unwrap_or(0);

        // --- 2. Move all sessions in the sub-tree ---
        // For each displaced user, walk the ancestor chain (starting from `dest`)
        // to find the closest channel the user is allowed to enter.  This mirrors
        // Murmur's `Server::removeChannel` logic:
        //   while (target->cParent && (!hasPermission(…, Enter) || isFull(…)))
        //       target = target->cParent;
        // Root (id=0) has no parent, so it is always the unconditional fallback.

        // Pre-build an ancestor chain from `dest` to root (inclusive) once,
        // so we don't re-traverse the channel store per user.
        let ancestor_chain: Vec<u32> = {
            let channels_snap = self.state.channel_store.get_all_channels().await;
            let parent_map: std::collections::HashMap<u32, Option<u32>> =
                channels_snap.iter().map(|c| (c.id, c.parent_id)).collect();
            let mut chain = Vec::new();
            let mut cur = dest;
            loop {
                chain.push(cur);
                if cur == 0 {
                    break;
                }
                match parent_map.get(&cur).copied().flatten() {
                    Some(p) => cur = p,
                    None => {
                        chain.push(0);
                        break;
                    }
                }
            }
            chain
        };

        let all_sessions = self.state.session_manager.get_all_sessions().await;

        // Build per-channel max_users map (only channels that have a limit).
        let channel_max_users: std::collections::HashMap<u32, u32> = all_channels
            .iter()
            .filter(|c| c.max_users > 0)
            .map(|c| (c.id, c.max_users))
            .collect();

        // Track current occupancy per channel so that as we displace multiple users
        // we account for users we have already decided to move there in this batch.
        let mut channel_counts: std::collections::HashMap<u32, usize> =
            std::collections::HashMap::new();
        for s in &all_sessions {
            *channel_counts.entry(s.channel_id).or_insert(0) += 1;
        }

        for session in all_sessions
            .iter()
            .filter(|s| subtree_set.contains(&s.channel_id))
        {
            // Walk ancestor_chain to find the first channel the user can enter that
            // is not full.  Root (id=0) is always the unconditional fallback.
            // Mirrors Murmur: while (target->cParent &&
            //   (!hasPermission(p, target, Enter) || isChannelFull(target, p)))
            //       target = target->cParent;
            let mut target_channel = 0u32;
            for (i, &ch_id) in ancestor_chain.iter().enumerate() {
                let is_root = ch_id == 0 || i == ancestor_chain.len() - 1;
                if is_root {
                    target_channel = ch_id;
                    break;
                }
                // Skip channels that are already at capacity.
                if let Some(&max) = channel_max_users.get(&ch_id) {
                    let current = channel_counts.get(&ch_id).copied().unwrap_or(0);
                    if current >= max as usize {
                        continue; // full — walk up
                    }
                }
                if self
                    .state
                    .acl_manager
                    .has_permission(
                        session.user_id as i32,
                        ch_id,
                        &session.groups,
                        munode_common::permission::ENTER,
                    )
                    .await
                {
                    target_channel = ch_id;
                    break;
                }
            }

            // Update the in-batch occupancy counters so subsequent displacees account
            // for earlier moves in this same removal batch.
            if let Some(cnt) = channel_counts.get_mut(&session.channel_id)
                && *cnt > 0
            {
                *cnt -= 1;
            }
            *channel_counts.entry(target_channel).or_insert(0) += 1;

            if let Some((_old_channel_id, moved_params)) = self
                .apply_authoritative_user_move(session.session_id, target_channel, None)
                .await
            {
                self.broadcast_notification("hub.userMoved", |n| {
                    n.user_moved = Some(moved_params);
                })
                .await;
                info!(
                    session_id = session.session_id,
                    from = session.channel_id,
                    to = target_channel,
                    "Channel removal: moved session to target channel"
                );
            }
        }

        // --- 3. Remove channel-listener state for the sub-tree ---
        for session in self.state.session_manager.get_all_sessions().await.iter() {
            let removed: Vec<u32> = session
                .listening_channels
                .iter()
                .copied()
                .filter(|ch| subtree_set.contains(ch))
                .collect();
            if removed.is_empty() {
                continue;
            }
            // Update the session in-memory.
            if let Some(mut s) = self
                .state
                .session_manager
                .get_session(session.session_id)
                .await
            {
                s.listening_channels.retain(|ch| !subtree_set.contains(ch));
                self.state.session_manager.add_session(s).await;
            }
            // Notify all edges so clients show the listener as removed.
            let broadcast = HubUserStateBroadcastParams {
                session_id: session.session_id,
                edge_id: session.edge_id,
                listening_channel_remove: removed,
                actor_session: None,
                ..Default::default()
            };
            self.broadcast_notification("hub.userStateBroadcast", |n| {
                n.user_state_broadcast = Some(broadcast.clone());
            })
            .await;
        }

        // --- 4. Remove each channel (children first) ---
        for &ch_id in &subtree {
            match self.state.channel_store.remove_and_persist(ch_id).await {
                Ok(Some(removed)) => {
                    info!("Channel removed: {} (id={})", removed.name, ch_id);
                }
                Ok(None) => {
                    // Already gone — still clean up memory and notify edges.
                }
                Err(e) => {
                    warn!("Failed to remove channel {} from DB: {}", ch_id, e);
                    // Proceed anyway: keep memory and edges consistent even if DB write failed.
                }
            }
            self.state.acl_manager.remove_channel(ch_id).await;
            self.broadcast_notification("hub.channelRemoved", |n| {
                n.channel_removed = Some(HubChannelRemovedParams { channel_id: ch_id });
            })
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth_service::AuthServiceHandle;
    use crate::ban_store::BanStore;
    use crate::blob_store::BlobStore;
    use crate::rpc_handler::StableRpcLedger;
    use crate::server::{FailedAuthTracker, HubState};
    use crate::session_manager::SessionManager;
    use crate::topology_manager::TopologyManager;
    use crate::user_store::UserStore;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use std::sync::atomic::AtomicU64;
    use tempfile::tempdir;
    use tokio::sync::RwLock;

    fn channel(id: u32, parent_id: Option<u32>, name: &str) -> ChannelRecord {
        ChannelRecord {
            id,
            name: name.to_string(),
            parent_id,
            description: String::new(),
            position: 0,
            max_users: 0,
            temporary: false,
            inherit_acl: true,
            links: HashSet::new(),
        }
    }

    async fn setup_handler() -> (tempfile::TempDir, Arc<HubState>, RpcHandler) {
        let tempdir = tempdir().unwrap();
        let mut config: munode_common::config::HubConfig =
            serde_json::from_value(json!({})).unwrap();
        config.database.path = tempdir.path().join("hub.sqlite").display().to_string();
        config.blob_store.path = tempdir.path().join("blobs").display().to_string();
        config.geoip.database_path.clear();

        let database = Arc::new(crate::database::Database::open(&config.database.path).unwrap());
        database.apply_migrations().unwrap();

        let channel_store = Arc::new(crate::channel_store::ChannelStore::new(database.clone()));
        let state = Arc::new(HubState {
            config: config.clone(),
            session_manager: SessionManager::new(),
            channel_store: channel_store.clone(),
            database: database.clone(),
            acl_manager: crate::acl_manager::AclManager::new(database.clone(), channel_store),
            user_store: UserStore::new(database.clone()),
            ban_store: BanStore::new(database.clone()),
            blob_store: Arc::new(BlobStore::open(&config.blob_store.path).unwrap()),
            edge_connections: RwLock::new(HashMap::new()),
            edge_connection_controls: RwLock::new(HashMap::new()),
            next_edge_connection_id: AtomicU64::new(1),
            edge_health: RwLock::new(HashMap::new()),
            topology: RwLock::new(TopologyManager::new()),
            edge_registry: RwLock::new(HashMap::new()),
            auth_service: AuthServiceHandle::new(),
            lua_engine: RwLock::new(None),
            failed_auth_tracker: RwLock::new(FailedAuthTracker::default()),
            geoip: Arc::new(crate::geoip::GeoIpService::new(&config.geoip.database_path)),
            started_at: std::time::Instant::now(),
            voice_targets: RwLock::new(HashMap::new()),
            live_limits: RwLock::new(crate::rpc_handler::server_limits_from_config(&config)),
            notification_seqs: std::sync::Mutex::new(HashMap::new()),
            edge_notif_senders: RwLock::new(HashMap::new()),
            pending_auths: RwLock::new(HashMap::new()),
            stable_rpc_requests: Arc::new(std::sync::Mutex::new(StableRpcLedger::default())),
        });

        for ch in [
            channel(0, None, "Root"),
            channel(1, Some(0), "OldParent"),
            channel(2, Some(1), "Moved"),
            channel(3, Some(0), "NewParent"),
        ] {
            state.channel_store.update_and_persist(ch).await.unwrap();
        }

        (tempdir, state.clone(), RpcHandler::new(state))
    }

    #[tokio::test]
    async fn test_handle_save_channel_invalidates_acl_cache_on_parent_change() {
        let (_tempdir, state, handler) = setup_handler().await;

        state
            .acl_manager
            .save_acls(
                1,
                &[crate::acl_manager::AclEntry {
                    channel_id: 1,
                    user_id: None,
                    group_name: Some("@all".to_string()),
                    apply_here: true,
                    apply_subs: true,
                    allow: 0,
                    deny: munode_common::permission::SPEAK,
                }],
            )
            .await
            .unwrap();

        let before = state.acl_manager.calculate_permissions(-1, 2, &[]).await;
        assert_eq!(before & munode_common::permission::SPEAK, 0);

        let request = TypedRpcRequest {
            method: "edge.saveChannel".to_string(),
            request_id: "req-1".to_string(),
            edge_save_channel: Some(EdgeSaveChannelParams {
                id: Some(2),
                parent_id: Some(3),
                ..Default::default()
            }),
            ..Default::default()
        };

        handler
            .handle_save_channel(&request, "req-1")
            .await
            .unwrap();

        let after = state.acl_manager.calculate_permissions(-1, 2, &[]).await;
        assert_ne!(after & munode_common::permission::SPEAK, 0);
    }
}
