use super::*;

impl RpcHandler {
    pub(super) async fn handle_get_voice_targets(&self, request_id: &str) -> Result<EdgeHubPacket> {
        use munode_protocol::hubedge::{EdgeGetVoiceTargetsResult, VoiceTargetConfigEntry};

        let entries: Vec<VoiceTargetConfigEntry> = self
            .state
            .voice_targets
            .read()
            .await
            .values()
            .map(|entry| VoiceTargetConfigEntry {
                edge_id: entry.edge_id,
                client_session: entry.client_session,
                target_id: entry.target_id,
                config: entry.config.clone(),
                timestamp: entry.timestamp,
            })
            .collect();
        let result = EdgeGetVoiceTargetsResult {
            voice_targets: entries,
        };

        Ok(
            self.make_response_packet(request_id, "edge.getVoiceTargets", |response| {
                response.edge_get_voice_targets = Some(result);
            }),
        )
    }

    pub(super) async fn handle_sync_voice_target(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_sync_voice_target
            .as_ref()
            .context("Missing edge_sync_voice_target params")?;

        let timestamp = current_millis() as i64;
        let entry = VoiceTargetEntry {
            edge_id: params.edge_id,
            client_session: params.client_session,
            target_id: params.target_id,
            config: params.config.clone(),
            timestamp,
        };

        self.state
            .voice_targets
            .write()
            .await
            .insert((params.client_session, params.target_id), entry);

        self.broadcast_notification("hub.syncVoiceTarget", |notification| {
            notification.sync_voice_target = Some(HubSyncVoiceTargetParams {
                edge_id: params.edge_id,
                client_session: params.client_session,
                target_id: params.target_id,
                config: params.config.clone(),
                timestamp,
            });
        })
        .await;

        Ok(
            self.make_response_packet(request_id, "edge.syncVoiceTarget", |response| {
                response.edge_sync_voice_target = Some(EdgeSyncVoiceTargetResult {
                    success: true,
                    error: None,
                });
            }),
        )
    }
}
