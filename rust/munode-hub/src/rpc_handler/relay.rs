use super::*;

impl RpcHandler {
    pub(super) async fn handle_relay_voice_via_tcp(
        &self,
        request: TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_relay_voice_via_tcp
            .context("Missing edge_relay_voice_via_tcp params")?;

        if !self.state.config.voice_routing.enable_hub_tcp_relay {
            return Ok(self.make_response_packet(request_id, "edge.relayVoiceViaTcp", |response| {
                response.edge_relay_voice_via_tcp = Some(EdgeRelayVoiceViaTcpResult {
                    success: false,
                    error: Some("Hub voice relay is disabled by configuration".to_string()),
                });
            }));
        }

        let target_edge_id = params.target_edge_id;
        let from_edge_id = params.from_edge_id;
        let timestamp = params.timestamp;

        let notification = TypedRpcNotification {
            method: "hub.relayVoicePacket".to_string(),
            timestamp: Some(current_millis() as i64),
            relay_voice_packet: Some(HubRelayVoicePacketParams {
                from_edge_id,
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
        .map(|pool| pool.try_send(data))
        .unwrap_or(false);

        if !sent {
            debug!("Could not relay voice to edge {} (not connected)", target_edge_id);
        }

        Ok(self.make_response_packet(request_id, "edge.relayVoiceViaTcp", |response| {
            response.edge_relay_voice_via_tcp = Some(EdgeRelayVoiceViaTcpResult {
                success: sent,
                error: if sent {
                    None
                } else {
                    Some(format!("Edge {} not connected", target_edge_id))
                },
            });
        }))
    }
}