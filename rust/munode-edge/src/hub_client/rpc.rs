//! Public RPC and notification methods for `HubClient`.
//!
//! This module extends `HubClient` with all outbound RPC calls and fire-and-forget
//! notifications that the Edge sends to the Hub on behalf of connected clients.

use anyhow::{Context, Result};
use tracing::{debug, info, warn};

use munode_protocol::hubedge::{
    self, BlobGetParams, BlobGetUserCommentParams, BlobGetUserTextureParams, BlobPutParams,
    BlobSetUserCommentParams, BlobSetUserTextureParams, EdgeAuthenticateUserParams,
    EdgeContextActionParams, EdgeHandleAclParams, EdgeHandleChannelRemoveParams,
    EdgeHandleChannelStateParams, EdgeHandleTextMessageParams, EdgeHandleUserLeftParams,
    EdgeHandleUserMovedParams, EdgeHandleUserRemoveParams, EdgeHandleUserStateChangedParams,
    EdgePluginDataTransmissionParams, TypedRpcNotification, TypedRpcRequest,
};

use super::{
    AuthenticateUserRequest, HubClient, PendingControlNotification, RuntimeFullSyncOutcome,
    SaveChannelRequest, UserStateChangeRequest,
};

pub struct PeerQualityReport {
    pub target_edge_id: u32,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub rtt_ms: f32,
    pub packet_loss: f32,
    pub jitter_ms: f32,
    pub samples: u32,
}

impl HubClient {
    async fn permission_query_actor_identity(&self, session_id: u32) -> (u32, String) {
        if let Some(client) = self.edge_state.client_manager.get_client(session_id).await {
            return (client.user_id, client.username);
        }

        if let Some(remote_user) = self
            .edge_state
            .channel_manager
            .get_remote_user(session_id)
            .await
        {
            return (remote_user.user_id, remote_user.username);
        }

        (0, String::new())
    }

    /// Trigger a refresh full-sync with Hub and return the refreshed snapshot fence.
    ///
    /// Used by recovery paths after startup. The actual work runs through the
    /// notification processor so it is serialized with ordered Hub notifications.
    pub(crate) async fn request_full_sync_with_reason(
        &self,
        reason: &str,
    ) -> Result<RuntimeFullSyncOutcome> {
        self.enqueue_runtime_full_sync_request(reason, false).await
    }

    pub async fn request_full_sync(&self) {
        match self
            .enqueue_runtime_full_sync_request("unspecified", true)
            .await
        {
            Ok(outcome) => {
                info!(hub_seq = outcome.hub_seq, "Requested full-sync completed");
            }
            Err(e) => {
                warn!("Requested full-sync failed: {:#}", e);
            }
        }
    }

    /// Authenticate a user via the Hub.
    pub(crate) async fn authenticate_user(
        &self,
        params: AuthenticateUserRequest<'_>,
    ) -> Result<hubedge::EdgeAuthenticateUserResult> {
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.authenticateUser".to_string(),
            timeout_ms: Some(30000),
            edge_authenticate_user: Some(EdgeAuthenticateUserParams {
                session_id: params.session_id,
                server_id: self.server_id,
                username: params.username.to_string(),
                password: params.password.to_string(),
                tokens: params.tokens,
                client_info: params.client_info,
                mute: None,
                deaf: None,
                suppress: None,
                self_mute: params.preconnect_self_mute,
                self_deaf: params.preconnect_self_deaf,
                priority_speaker: None,
                recording: None,
            }),
            ..Default::default()
        };

        let response = self
            .rpc_call(request)
            .await
            .context("edge.authenticateUser RPC failed")?;

        response
            .edge_authenticate_user
            .ok_or_else(|| anyhow::anyhow!("No edge_authenticate_user in response"))
    }

    /// RPC: notify Hub that a local user disconnected.
    /// Hub removes session from session_manager, broadcasts UserRemove to other edges, responds.
    /// The requesting edge has already cleaned up locally (TCP already closed), so Hub
    /// excludes it from the broadcast.  Falls back to enqueuing a `PendingControlNotification`
    /// if Hub is unreachable so the disconnect is replayed on next reconnect.
    pub async fn rpc_user_left(&self, session_id: u32, reason: Option<&str>) {
        let edge_id = self.edge_id();
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.userLeft".to_string(),
            timeout_ms: Some(10000),
            edge_user_left: Some(EdgeHandleUserLeftParams {
                session_id,
                edge_id,
                reason: reason.map(String::from),
            }),
            ..Default::default()
        };
        if let Err(e) = self.rpc_call(request).await {
            warn!(
                "Failed to report user disconnect to Hub (session={}): {}",
                session_id, e
            );
            // Enqueue so it is replayed after the next successful Hub reconnect.
            self.enqueue_pending_notification(PendingControlNotification::UserLeft {
                session_id,
                reason: reason.map(String::from),
            })
            .await;
        }
    }

    /// RPC: kick/ban a user.
    /// Hub validates permissions, removes session, broadcasts UserRemove to all edges
    /// (including this edge, so local clients receive the kick message).
    /// Returns Ok(true) on success, Ok(false) if permission denied, Err on transport failure.
    pub async fn rpc_user_remove(
        &self,
        actor_session: u32,
        actor_user_id: u32,
        actor_username: &str,
        target_session: u32,
        reason: &str,
        ban: bool,
    ) -> Result<bool> {
        let edge_id = self.edge_id();
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.userRemove".to_string(),
            timeout_ms: Some(10000),
            edge_user_remove: Some(EdgeHandleUserRemoveParams {
                edge_id,
                actor_session,
                actor_user_id,
                actor_username: actor_username.to_string(),
                target_session,
                reason: reason.to_string(),
                ban,
            }),
            ..Default::default()
        };
        let response = self
            .rpc_call(request)
            .await
            .context("edge.userRemove RPC failed")?;
        let result = response
            .edge_user_remove
            .ok_or_else(|| anyhow::anyhow!("No edge_user_remove in response"))?;
        Ok(result.success)
    }

    /// RPC: move a user to a different channel.
    /// Hub updates session_manager, broadcasts hub.userMoved to ALL edges, responds.
    /// Every edge, including the requesting edge, applies the authoritative move
    /// when the hub.userMoved notification is processed locally.
    /// Returns `Err` if the Hub rejected the move (e.g. channel full).
    pub async fn rpc_user_moved(
        &self,
        session_id: u32,
        channel_id: u32,
        actor_session: u32,
    ) -> Result<()> {
        let edge_id = self.edge_id();
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.userMoved".to_string(),
            timeout_ms: Some(10000),
            edge_user_moved: Some(EdgeHandleUserMovedParams {
                session_id,
                edge_id,
                channel_id,
                actor_session: Some(actor_session),
            }),
            ..Default::default()
        };
        let response = self
            .rpc_call(request)
            .await
            .context("edge.userMoved RPC failed")?;
        let result = response
            .edge_user_moved
            .ok_or_else(|| anyhow::anyhow!("No edge_user_moved in response"))?;
        if !result.success {
            return Err(anyhow::anyhow!(
                "edge.userMoved rejected: {}",
                result.error.as_deref().unwrap_or("unknown")
            ));
        }
        Ok(())
    }

    /// Notification: request a Hub-authoritative move for a local user.
    ///
    /// The source edge does not pre-apply any local channel state. Successful
    /// processing is confirmed by the subsequent `hub.userMoved` broadcast.
    pub async fn notify_user_moved(
        &self,
        session_id: u32,
        channel_id: u32,
        actor_session: u32,
    ) -> Result<()> {
        let notification = TypedRpcNotification {
            method: "hub.handleUserMoved".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_user_moved: Some(EdgeHandleUserMovedParams {
                session_id,
                edge_id: self.edge_id(),
                channel_id,
                actor_session: Some(actor_session),
            }),
            ..Default::default()
        };

        self.send_notification(notification)
            .await
            .context("hub.handleUserMoved notification failed")
    }

    /// RPC: update a user's state (mute/deaf/suppress/priority-speaker etc).
    /// Hub updates session_manager, broadcasts hub.userStateBroadcast to ALL edges, responds.
    /// Every edge, including the requesting edge, waits for the Hub broadcast to
    /// update client-visible state.
    pub(crate) async fn rpc_user_state_changed(
        &self,
        params: UserStateChangeRequest,
    ) -> Result<()> {
        let edge_id = self.edge_id();
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.userStateChanged".to_string(),
            timeout_ms: Some(10000),
            edge_user_state_changed: Some(EdgeHandleUserStateChangedParams {
                session_id: params.session_id,
                edge_id,
                self_mute: params.self_mute,
                self_deaf: params.self_deaf,
                mute: params.mute,
                deaf: params.deaf,
                suppress: params.suppress,
                priority_speaker: params.priority_speaker,
                recording: params.recording,
                listening_channel_add: params.listening_channel_add,
                listening_channel_remove: params.listening_channel_remove,
                actor_session: params.actor_session,
            }),
            ..Default::default()
        };
        let response = self
            .rpc_call(request)
            .await
            .context("edge.userStateChanged RPC failed")?;
        let result = response
            .edge_user_state_changed
            .ok_or_else(|| anyhow::anyhow!("No edge_user_state_changed in response"))?;
        if !result.success {
            return Err(anyhow::anyhow!(
                "edge.userStateChanged rejected: {}",
                result.error.as_deref().unwrap_or("unknown")
            ));
        }
        Ok(())
    }

    /// Notification: request a Hub-authoritative state change for a local user.
    ///
    /// The source edge waits for the resulting `hub.userStateBroadcast` before
    /// applying any client-visible authoritative fields.
    pub(crate) async fn notify_user_state_changed(
        &self,
        params: UserStateChangeRequest,
    ) -> Result<()> {
        let notification = TypedRpcNotification {
            method: "hub.handleUserStateChanged".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_user_state_changed: Some(EdgeHandleUserStateChangedParams {
                session_id: params.session_id,
                edge_id: self.edge_id(),
                self_mute: params.self_mute,
                self_deaf: params.self_deaf,
                mute: params.mute,
                deaf: params.deaf,
                suppress: params.suppress,
                priority_speaker: params.priority_speaker,
                recording: params.recording,
                listening_channel_add: params.listening_channel_add,
                listening_channel_remove: params.listening_channel_remove,
                actor_session: params.actor_session,
            }),
            ..Default::default()
        };

        self.send_notification(notification)
            .await
            .context("hub.handleUserStateChanged notification failed")
    }

    /// Forward a PermissionQuery to the Hub.
    pub async fn handle_permission_query(
        &self,
        session_id: u32,
        channel_id: u32,
    ) -> Result<hubedge::EdgeHandlePermissionQueryResult> {
        let request_id = self.next_request_id();
        let edge_id = self.edge_id();

        let (user_id, username) = self.permission_query_actor_identity(session_id).await;

        let request = TypedRpcRequest {
            request_id,
            method: "edge.handlePermissionQuery".to_string(),
            timeout_ms: Some(10000),
            edge_handle_permission_query: Some(hubedge::EdgeHandlePermissionQueryParams {
                edge_id,
                actor_session: session_id,
                actor_user_id: user_id,
                actor_username: username,
                channel_id,
            }),
            ..Default::default()
        };
        let response = self
            .rpc_call(request)
            .await
            .context("edge.handlePermissionQuery RPC failed")?;
        response
            .edge_handle_permission_query
            .ok_or_else(|| anyhow::anyhow!("No edge_handle_permission_query in response"))
    }

    /// Batch permission query: returns effective permissions for a slice of channel IDs
    /// in a single Hub RPC round trip. Used during login-adjacent warmup paths to avoid
    /// N serial permission RPCs.
    pub async fn batch_permission_query(
        &self,
        session_id: u32,
        channel_ids: &[u32],
    ) -> Result<hubedge::EdgeBatchPermissionQueryResult> {
        let request_id = self.next_request_id();
        let edge_id = self.edge_id();

        let (user_id, username) = self.permission_query_actor_identity(session_id).await;

        let request = TypedRpcRequest {
            request_id,
            method: "edge.batchPermissionQuery".to_string(),
            timeout_ms: Some(30000),
            edge_batch_permission_query: Some(hubedge::EdgeBatchPermissionQueryParams {
                edge_id,
                actor_session: session_id,
                actor_user_id: user_id,
                actor_username: username,
                channel_ids: channel_ids.to_vec(),
            }),
            ..Default::default()
        };
        let response = self
            .rpc_call(request)
            .await
            .context("edge.batchPermissionQuery RPC failed")?;
        response
            .edge_batch_permission_query
            .ok_or_else(|| anyhow::anyhow!("No edge_batch_permission_query in response"))
    }

    pub async fn sync_voice_target(
        &self,
        client_session: u32,
        target_id: u32,
        config: Option<hubedge::VoiceTargetConfigProto>,
    ) -> Result<hubedge::EdgeSyncVoiceTargetResult> {
        let peer_fanout = crate::relay_server::fanout_voice_target_to_peers(
            &self.edge_state,
            client_session,
            target_id,
            config.clone(),
        );
        debug!(
            client_session,
            target_id,
            has_config = config.is_some(),
            peer_fanout,
            "Syncing voice target to Hub"
        );

        let request_id = self.next_request_id();
        let edge_id = self.edge_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.syncVoiceTarget".to_string(),
            timeout_ms: Some(10000),
            edge_sync_voice_target: Some(hubedge::EdgeSyncVoiceTargetParams {
                edge_id,
                client_session,
                target_id,
                config,
            }),
            ..Default::default()
        };
        let response = self
            .rpc_call(request)
            .await
            .context("edge.syncVoiceTarget RPC failed")?;
        response
            .edge_sync_voice_target
            .ok_or_else(|| anyhow::anyhow!("No edge_sync_voice_target in response"))
    }

    /// Forward a channel create/edit request to Hub via saveChannel RPC.
    pub(crate) async fn save_channel(
        &self,
        params: SaveChannelRequest<'_>,
    ) -> Result<hubedge::EdgeSaveChannelResult> {
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.saveChannel".to_string(),
            timeout_ms: Some(10000),
            edge_save_channel: Some(hubedge::EdgeSaveChannelParams {
                id: params.channel_id,
                parent_id: params.parent_id,
                name: params.name.map(String::from),
                description: params.description.map(String::from),
                description_blob: None,
                position: params.position,
                max_users: params.max_users,
                inherit_acl: None,
                temporary: params.temporary,
                creator_session: params.creator_session,
            }),
            ..Default::default()
        };

        let response = self
            .rpc_call(request)
            .await
            .context("edge.saveChannel RPC failed")?;

        response
            .edge_save_channel
            .ok_or_else(|| anyhow::anyhow!("No edge_save_channel in response"))
    }

    /// RPC: Save channel listeners for a user on disconnect.
    ///
    /// This is a best-effort fire-and-forget call; failures are logged but do
    /// not propagate to the caller.
    pub async fn save_channel_listeners(&self, user_id: u32, channel_ids: Vec<u32>) {
        if user_id == 0 {
            return; // Guests have no persistent listeners
        }
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "edge.saveChannelListeners".to_string(),
            timeout_ms: Some(5000),
            edge_save_channel_listeners: Some(hubedge::EdgeSaveChannelListenersParams {
                user_id,
                channel_ids,
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => {
                if let Some(result) = resp.edge_save_channel_listeners
                    && !result.success
                {
                    warn!(
                        "Hub rejected channel listeners save for user {}: {:?}",
                        user_id, result.error
                    );
                }
            }
            Err(e) => warn!(
                "Failed to save channel listeners for user {}: {}",
                user_id, e
            ),
        }
    }

    /// RPC: Load persisted channel listeners for a user on connect.
    ///
    /// Returns the list of channel IDs the user was listening to at their last
    /// disconnect, or an empty `Vec` on failure.
    pub async fn load_channel_listeners(&self, user_id: u32) -> Vec<u32> {
        if user_id == 0 {
            return vec![]; // Guests have no persistent listeners
        }
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "edge.loadChannelListeners".to_string(),
            timeout_ms: Some(5000),
            edge_load_channel_listeners: Some(hubedge::EdgeLoadChannelListenersParams { user_id }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp
                .edge_load_channel_listeners
                .map(|r| if r.success { r.channel_ids } else { vec![] })
                .unwrap_or_default(),
            Err(e) => {
                warn!(
                    "Failed to load channel listeners for user {}: {}",
                    user_id, e
                );
                vec![]
            }
        }
    }

    /// RPC: notify Hub of a channel link/state change.
    /// Hub updates channel store, broadcasts hub.channelUpdated to all edges, responds.
    /// Falls back to PendingControlNotification queue if Hub unreachable.
    pub async fn rpc_channel_state(
        &self,
        channel_id: u32,
        links_add: Vec<u32>,
        links_remove: Vec<u32>,
    ) {
        let edge_id = self.edge_id();
        let links_add_save = links_add.clone();
        let links_remove_save = links_remove.clone();
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.channelState".to_string(),
            timeout_ms: Some(10000),
            edge_channel_state: Some(EdgeHandleChannelStateParams {
                edge_id,
                channel_id,
                links_add,
                links_remove,
                name: None,
                description: None,
                position: None,
                parent_id: None,
            }),
            ..Default::default()
        };
        if let Err(e) = self.rpc_call(request).await {
            warn!(
                "Failed to notify Hub of channel state (session={}): {}",
                channel_id, e
            );
            self.enqueue_pending_notification(PendingControlNotification::ChannelLinksChanged {
                channel_id,
                links_add: links_add_save,
                links_remove: links_remove_save,
            })
            .await;
        }
    }

    /// RPC: notify Hub of a channel removal.
    /// Hub removes channel, broadcasts hub.channelRemoved to all edges, responds.
    /// Falls back to PendingControlNotification queue if Hub unreachable.
    pub async fn rpc_channel_remove(&self, channel_id: u32) {
        let edge_id = self.edge_id();
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.channelRemove".to_string(),
            timeout_ms: Some(10000),
            edge_channel_remove: Some(EdgeHandleChannelRemoveParams {
                edge_id,
                channel_id,
            }),
            ..Default::default()
        };
        if let Err(e) = self.rpc_call(request).await {
            warn!(
                "Failed to notify Hub of channel remove (channel={}): {}",
                channel_id, e
            );
            self.enqueue_pending_notification(PendingControlNotification::ChannelRemoved {
                channel_id,
            })
            .await;
        }
    }

    /// Forward a text message to Hub for cross-edge delivery.
    pub async fn notify_text_message(
        &self,
        sender_session: u32,
        text_msg: &munode_protocol::mumbleproto::TextMessage,
    ) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handleTextMessage".to_string(),
            timestamp: Some(current_millis() as i64),
            handle_text_message: Some(EdgeHandleTextMessageParams {
                actor: sender_session,
                edge_id,
                message: text_msg.message.clone(),
                channel_id: text_msg.channel_id.clone(),
                tree_id: text_msg.tree_id.clone(),
                session: text_msg.session.clone(),
            }),
            ..Default::default()
        };
        if let Err(e) = self.send_notification(notification).await {
            warn!("Failed to forward text message to Hub: {}", e);
        }
    }

    /// Notify the Hub that a client triggered a context action.
    ///
    /// This allows Hub-side callbacks (plugins, Lua scripts) to respond to
    /// context menu interactions registered via `hub.contextActionModify`.
    pub async fn notify_context_action(
        &self,
        session_id: u32,
        action: munode_protocol::mumbleproto::ContextAction,
    ) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.contextAction".to_string(),
            timestamp: Some(current_millis() as i64),
            context_action: Some(EdgeContextActionParams {
                edge_id,
                session_id,
                action: Some(action),
            }),
            ..Default::default()
        };
        if let Err(e) = self.send_notification(notification).await {
            warn!("Failed to forward ContextAction to Hub: {}", e);
        }
    }

    /// RPC: Get ban list from Hub.
    ///
    /// Returns `Ok(raw_bytes)` on success, `Err(true)` when Hub explicitly denied
    /// the request (actor lacks WRITE on root channel), or `Err(false)` on a
    /// transport / internal error.
    ///
    /// Hub is the authoritative permission enforcer; passing actor info here
    /// eliminates the separate `permission_query` RPC that was previously needed,
    /// reducing total round-trips from 2 to 1 for this operation.
    pub async fn rpc_get_ban_list(
        &self,
        actor_session: u32,
        actor_user_id: u32,
    ) -> Result<Vec<u8>, bool> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "edge.getBanList".to_string(),
            edge_handle_acl: Some(EdgeHandleAclParams {
                edge_id: self.edge_id(),
                actor_session,
                actor_user_id,
                actor_username: String::new(),
                channel_id: 0,
                query: true,
                raw_data: vec![],
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => {
                let r = resp.edge_handle_acl.unwrap_or_default();
                if !r.success {
                    Err(r.permission_denied.unwrap_or(false))
                } else {
                    Ok(r.raw_data.unwrap_or_default())
                }
            }
            Err(e) => {
                warn!("Failed to get ban list: {}", e);
                Err(false)
            }
        }
    }

    /// RPC: Update ban list on Hub using raw BanList protobuf bytes.
    ///
    /// Returns `Ok(())` on success, `Err(true)` when Hub denied the request
    /// (actor lacks BAN on root channel), or `Err(false)` on transport error.
    pub async fn rpc_update_ban_list(
        &self,
        raw_ban_list: &[u8],
        actor_session: u32,
        actor_user_id: u32,
    ) -> Result<(), bool> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "edge.updateBanList".to_string(),
            edge_handle_acl: Some(EdgeHandleAclParams {
                edge_id: self.edge_id(),
                actor_session,
                actor_user_id,
                actor_username: String::new(),
                channel_id: 0,
                query: false,
                raw_data: raw_ban_list.to_vec(),
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => {
                let r = resp.edge_handle_acl.unwrap_or_default();
                if !r.success {
                    Err(r.permission_denied.unwrap_or(false))
                } else {
                    debug!("Ban list updated on Hub");
                    Ok(())
                }
            }
            Err(e) => {
                warn!("Failed to update ban list: {}", e);
                Err(false)
            }
        }
    }

    /// RPC: Handle ACL query/update. Returns raw ACL protobuf bytes on query.
    pub async fn rpc_handle_acl(
        &self,
        actor_session: u32,
        actor_user_id: u32,
        actor_username: &str,
        channel_id: u32,
        query: bool,
        raw_data: &[u8],
    ) -> Option<Vec<u8>> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "edge.handleACL".to_string(),
            edge_handle_acl: Some(EdgeHandleAclParams {
                edge_id: self.edge_id(),
                actor_session,
                actor_user_id,
                actor_username: actor_username.to_string(),
                channel_id,
                query,
                raw_data: raw_data.to_vec(),
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.edge_handle_acl.and_then(|r| r.raw_data),
            Err(e) => {
                warn!("Failed to handle ACL: {}", e);
                None
            }
        }
    }

    /// RPC: Get the registered user list from Hub (returns raw protobuf UserList bytes).
    pub async fn rpc_get_user_list(&self) -> Option<Vec<u8>> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "edge.getUserList".to_string(),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.edge_handle_acl.and_then(|r| r.raw_data),
            Err(e) => {
                warn!("Failed to get user list: {}", e);
                None
            }
        }
    }

    /// RPC: Update (rename / de-register) users in Hub database.
    pub async fn rpc_update_user_list(&self, raw_user_list: &[u8]) -> bool {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "edge.updateUserList".to_string(),
            edge_handle_acl: Some(EdgeHandleAclParams {
                edge_id: self.edge_id(),
                actor_session: 0,
                actor_user_id: 0,
                actor_username: String::new(),
                channel_id: 0,
                query: false,
                raw_data: raw_user_list.to_vec(),
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.edge_handle_acl.map(|r| r.success).unwrap_or(false),
            Err(e) => {
                warn!("Failed to update user list: {}", e);
                false
            }
        }
    }

    /// Notify Hub of plugin data transmission for cross-edge forwarding.
    pub async fn notify_plugin_data(
        &self,
        sender_session: u32,
        sender_username: &str,
        data_id: &str,
        data: &[u8],
        receiver_sessions: &[u32],
    ) {
        let edge_id = self.edge_id();
        let notification = TypedRpcNotification {
            method: "hub.handlePluginDataTransmission".to_string(),
            timestamp: Some(current_millis() as i64),
            plugin_data_transmission: Some(EdgePluginDataTransmissionParams {
                edge_id,
                actor_session: sender_session,
                actor_username: sender_username.to_string(),
                sender_session,
                data_id: data_id.to_string(),
                data: data.to_vec(),
                receiver_sessions: receiver_sessions.to_vec(),
            }),
            ..Default::default()
        };
        if let Err(e) = self.send_notification(notification).await {
            warn!("Failed to forward plugin data to Hub: {}", e);
        }
    }

    // ==================== Blob RPC Methods ====================

    /// RPC: Upload blob data to Hub. Returns SHA-256 hash on success.
    pub async fn blob_put(&self, data: Vec<u8>) -> Option<String> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "blob.put".to_string(),
            blob_put: Some(BlobPutParams { data }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp
                .blob_put
                .and_then(|r| if r.success { r.hash } else { None }),
            Err(e) => {
                warn!("blob.put failed: {}", e);
                None
            }
        }
    }

    /// RPC: Download blob data by SHA-256 hash.
    pub async fn blob_get(&self, hash: &str) -> Option<Vec<u8>> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "blob.get".to_string(),
            blob_get: Some(BlobGetParams {
                hash: hash.to_string(),
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp
                .blob_get
                .and_then(|r| if r.success { r.data } else { None }),
            Err(e) => {
                warn!("blob.get failed: {}", e);
                None
            }
        }
    }

    /// RPC: Get user texture blob. Returns (hash, data) on success.
    pub async fn blob_get_user_texture(&self, user_id: u32) -> Option<(String, Vec<u8>)> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "blob.getUserTexture".to_string(),
            blob_get_user_texture: Some(BlobGetUserTextureParams { user_id }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.blob_get_user_texture.and_then(|r| {
                if r.success {
                    Some((r.hash.unwrap_or_default(), r.data.unwrap_or_default()))
                } else {
                    None
                }
            }),
            Err(e) => {
                warn!("blob.getUserTexture failed: {}", e);
                None
            }
        }
    }

    /// RPC: Get user comment blob. Returns (hash, data) on success.
    pub async fn blob_get_user_comment(&self, user_id: u32) -> Option<(String, Vec<u8>)> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "blob.getUserComment".to_string(),
            blob_get_user_comment: Some(BlobGetUserCommentParams { user_id }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp.blob_get_user_comment.and_then(|r| {
                if r.success {
                    Some((r.hash.unwrap_or_default(), r.data.unwrap_or_default()))
                } else {
                    None
                }
            }),
            Err(e) => {
                warn!("blob.getUserComment failed: {}", e);
                None
            }
        }
    }

    /// RPC: Set user texture blob. Returns hash on success.
    pub async fn blob_set_user_texture(&self, user_id: u32, data: Vec<u8>) -> Option<String> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "blob.setUserTexture".to_string(),
            blob_set_user_texture: Some(BlobSetUserTextureParams { user_id, data }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp
                .blob_set_user_texture
                .and_then(|r| if r.success { r.hash } else { None }),
            Err(e) => {
                warn!("blob.setUserTexture failed: {}", e);
                None
            }
        }
    }

    /// RPC: Set user comment blob. Returns hash on success.
    pub async fn blob_set_user_comment(&self, user_id: u32, data: Vec<u8>) -> Option<String> {
        let request = TypedRpcRequest {
            request_id: self.next_request_id(),
            method: "blob.setUserComment".to_string(),
            blob_set_user_comment: Some(BlobSetUserCommentParams { user_id, data }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => resp
                .blob_set_user_comment
                .and_then(|r| if r.success { r.hash } else { None }),
            Err(e) => {
                warn!("blob.setUserComment failed: {}", e);
                None
            }
        }
    }

    /// Relay a voice packet to a target Edge via Hub TCP tunnel.
    /// Called when a local sender needs to reach a remote user on another edge.
    ///
    /// Returns `true` if the packet was successfully enqueued to the Hub voice
    /// channel; returns `false` if the Hub is unreachable or the voice channel
    /// is full.  Callers use this signal to track per-peer forwarding failures
    /// and trigger partition detection when all paths (UDP, TCP, Hub relay) are
    /// consistently down.
    pub async fn relay_voice_via_hub(
        &self,
        target_edge_id: u32,
        voice_packet: bytes::Bytes,
    ) -> bool {
        let from_edge_id = self.edge_id();

        // Voice relay is fire-and-forget: UDP voice is inherently unreliable and should
        // not consume RPC pending entries, response handling, or control-plane sequencing.
        let notification = TypedRpcNotification {
            method: "edge.relayVoiceViaTcp".to_string(),
            timestamp: Some(current_millis() as i64),
            edge_relay_voice_via_tcp: Some(hubedge::EdgeRelayVoiceViaTcpParams {
                from_edge_id,
                target_edge_id,
                voice_packet,
                timestamp: current_millis() as i64,
            }),
            ..Default::default()
        };

        if let Err(e) = self.send_unsequenced_notification(notification).await {
            debug!(
                edge_id = from_edge_id,
                method = "edge.relayVoiceViaTcp",
                target_edge_id,
                "relay_voice_via_hub to edge {target_edge_id} failed (send): {e}"
            );
            false
        } else {
            true
        }
    }

    /// Report link quality to a peer Edge to Hub for route table computation.
    pub async fn report_quality(&self, report: PeerQualityReport) {
        let from_edge_id = self.edge_id();
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.reportQuality".to_string(),
            timeout_ms: Some(5000),
            edge_report_quality: Some(hubedge::EdgeReportQualityParams {
                edge_id: from_edge_id,
                target_edge_id: report.target_edge_id,
                target_host: report.target_host,
                target_port: report.target_port.map(u32::from),
                quality: hubedge::NetworkQualityProto {
                    rtt: report.rtt_ms,
                    packet_loss: report.packet_loss,
                    jitter: report.jitter_ms,
                    samples: report.samples,
                },
            }),
            ..Default::default()
        };
        if let Err(e) = self.rpc_call(request).await {
            debug!(
                "report_quality to edge {} failed: {}",
                report.target_edge_id, e
            );
        }
    }

    /// Notify the Hub that our TCP voice connection to `remote_edge_id` has been
    /// persistently down.  The Hub runs partition-arbitration: if the remote Edge
    /// also reports the same disconnection, Hub broadcasts `hub.peerLeft` and may
    /// issue `hub.shutdownRequest` to the smaller partition.
    pub async fn do_report_peer_disconnect(&self, remote_edge_id: u32) {
        let local_edge_id = self.edge_id();
        let local_client_count = self.edge_state.client_manager.client_count().await as u32;
        let request_id = self.next_request_id();
        let request = TypedRpcRequest {
            request_id,
            method: "edge.reportPeerDisconnect".to_string(),
            timeout_ms: Some(10_000),
            edge_report_peer_disconnect: Some(hubedge::EdgeReportPeerDisconnectParams {
                local_edge_id,
                remote_edge_id,
                local_client_count,
            }),
            ..Default::default()
        };
        match self.rpc_call(request).await {
            Ok(resp) => {
                let action = resp
                    .edge_report_peer_disconnect
                    .as_ref()
                    .map(|r| r.action.as_str())
                    .unwrap_or("unknown");
                info!(
                    "Reported peer {} disconnect to Hub (action={})",
                    remote_edge_id, action
                );
            }
            Err(e) => {
                warn!(
                    "Failed to report peer {} disconnect to Hub: {}",
                    remote_edge_id, e
                );
            }
        }
    }
}

/// Build a relay WebSocket URL.
///
/// Authentication is performed via challenge-response handshake at the WebSocket
/// message level after the upgrade — no query parameters are needed.
pub(super) fn build_relay_url(host: &str, port: u16, _hmac_secret: Option<&str>) -> String {
    format!("ws://{}:{}/relay", host, port)
}

/// Build a log-safe relay URL (no authentication query parameters).
///
/// Use this in log messages instead of the full URL returned by `build_relay_url`
/// to avoid leaking HMAC tokens that are valid within the replay-prevention window.
pub(super) fn safe_relay_url(host: &str, port: u16) -> String {
    format!("ws://{}:{}/relay", host, port)
}

/// Simple timestamp in millis (no external dependency needed).
pub(super) fn current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
