use super::*;

impl RpcHandler {
    async fn relay_voice_via_hub_tcp(
        &self,
        params: EdgeRelayVoiceViaTcpParams,
        edge_server_id: u32,
    ) {
        if !self
            .state
            .hub_tcp_relay_enabled
            .load(std::sync::atomic::Ordering::Acquire)
        {
            debug!(
                edge_id = edge_server_id,
                target_edge_id = params.target_edge_id,
                "Dropping edge.relayVoiceViaTcp notification because Hub voice relay is disabled"
            );
            return;
        }

        if params.from_edge_id != edge_server_id {
            debug!(
                reported_from_edge_id = params.from_edge_id,
                edge_id = edge_server_id,
                target_edge_id = params.target_edge_id,
                "Ignoring reported from_edge_id in edge.relayVoiceViaTcp notification"
            );
        }

        let target_edge_id = params.target_edge_id;
        let timestamp = params.timestamp;

        let notification = TypedRpcNotification {
            method: "hub.relayVoicePacket".to_string(),
            timestamp: Some(current_millis() as i64),
            relay_voice_packet: Some(HubRelayVoicePacketParams {
                from_edge_id: edge_server_id,
                voice_packet: params.voice_packet,
                timestamp,
            }),
            ..Default::default()
        };
        let packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        let data = packet.encode_to_vec();

        let sent = {
            let edges = self.state.edge_connections.read().await;
            edges.get(&target_edge_id).cloned()
        }
        .map(|pool| pool.try_send_voice(data))
        .unwrap_or(false);

        if !sent {
            debug!(
                edge_id = edge_server_id,
                "Could not relay voice to edge {} (not connected)", target_edge_id
            );
        }
    }

    pub(super) async fn on_relay_voice_via_tcp(
        &self,
        notification: &TypedRpcNotification,
        edge_server_id: u32,
    ) {
        let Some(params) = notification.edge_relay_voice_via_tcp.clone() else {
            warn!(
                edge_id = edge_server_id,
                "Missing edge_relay_voice_via_tcp params in notification"
            );
            return;
        };

        self.relay_voice_via_hub_tcp(params, edge_server_id).await;
    }
}
