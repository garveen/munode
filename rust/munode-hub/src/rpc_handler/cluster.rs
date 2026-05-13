use super::*;

impl RpcHandler {
    /// After a disconnect is confirmed by arbitration, detect network partitions
    /// and send hub.shutdownRequest to the smallest partition to prevent split-brain.
    pub(super) async fn handle_partition_after_disconnect(&self) {
        let partitions = {
            let topo = self.state.topology.read().await;
            topo.detect_partitions()
        };

        if partitions.len() <= 1 {
            // No partition or single partition, nothing to do
            return;
        }

        // Build a per-edge user count map in O(M) first, then count per partition in O(N) total
        let all_sessions = self.state.session_manager.get_all_sessions().await;
        let mut users_per_edge: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
        for session in &all_sessions {
            *users_per_edge.entry(session.edge_id).or_insert(0) += 1;
        }

        let partition_user_counts = {
            let topo = self.state.topology.read().await;
            topo.partitions_by_user_count(&users_per_edge)
        };

        // The smallest partition gets the shutdown request
        if let Some((smallest_partition, count)) = partition_user_counts.first() {
            warn!(
                "Cluster partition detected: sending hub.shutdownRequest to smallest partition ({} edges, {} users)",
                smallest_partition.len(), count
            );
            let shutdown_notif = TypedRpcNotification {
                method: "hub.shutdownRequest".to_string(),
                timestamp: Some(current_millis() as i64),
                force_disconnect: Some(HubForceDisconnectParams {
                    reason: format!(
                        "Network partition detected: your cluster partition ({} users) is smaller. Please reconnect.",
                        count
                    ),
                }),
                ..Default::default()
            };
            let shutdown_packet = EdgeHubPacket {
                r#type: PacketType::RpcNotification as i32,
                rpc_notification: Some(shutdown_notif),
                ..Default::default()
            };
            let shutdown_data = shutdown_packet.encode_to_vec();
            // Snapshot pools under a brief read lock, then release before any
            // async sends.  Holding edge_connections.read() across send_async().await
            // would block edge registration and cleanup for the full send duration.
            let pools: Vec<(u32, EdgeSenderPool)> = {
                let edges = self.state.edge_connections.read().await;
                smallest_partition.iter()
                    .filter_map(|id| edges.get(id).map(|p| (*id, p.clone())))
                    .collect()
            };
            for (edge_id, pool) in pools {
                info!("Sending hub.shutdownRequest to edge {}", edge_id);
                let _ = pool.send_async(shutdown_data.clone()).await;
            }
        }
    }

    /// edge.join — Edge requests to join the cluster.
    pub(super) async fn handle_cluster_join(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
        edge_server_id: u32,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_join.as_ref().context("Missing edge_join params")?;
        let join_edge_id = if params.server_id != 0 { params.server_id } else { edge_server_id };

        let topo_edge = TopologyEdge {
            edge_id: join_edge_id,
            name: params.name.clone(),
            host: params.host.clone(),
            port: params.port,
            voice_port: params.voice_port,
            capacity: params.capacity,
            joined_at: std::time::Instant::now(),
            connected_peers: std::collections::HashSet::new(),
        };

        let peers_snapshot: Vec<PeerInfoProto> = {
            let mut topo = self.state.topology.write().await;
            topo.add_edge(topo_edge)
                .into_iter()
                .map(|p| PeerInfoProto {
                    id: p.edge_id,
                    name: p.name.clone(),
                    host: p.host.clone(),
                    port: p.port,
                    voice_port: p.voice_port,
                    cert_hash: None,
                })
                .collect()
        };

        // Notify existing edges about the new peer
        let notification = TypedRpcNotification {
            method: "hub.peerJoined".to_string(),
            timestamp: Some(current_millis() as i64),
            cluster_peer_joined: Some(HubClusterPeerJoinedParams {
                edge_id: join_edge_id,
                name: params.name.clone(),
                host: params.host.clone(),
                voice_port: params.voice_port,
            }),
            ..Default::default()
        };
        let notify_packet = EdgeHubPacket {
            r#type: PacketType::RpcNotification as i32,
            rpc_notification: Some(notification),
            ..Default::default()
        };
        let notify_data = notify_packet.encode_to_vec();

        // Snapshot pools before releasing the read-lock so no await is held
        // under the lock.  Cluster join is low-frequency but state-critical:
        // use the same join_all+timeout pattern as broadcast_critical so a
        // stalled Edge cannot block the notification to others.
        let peer_pools: Vec<(u32, EdgeSenderPool)> = {
            let edge_connections = self.state.edge_connections.read().await;
            edge_connections.iter()
                .filter(|&(&eid, _)| eid != join_edge_id)
                .map(|(&eid, pool)| (eid, pool.clone()))
                .collect()
        }; // read-lock released here

        {
            use futures_util::future::join_all;
            use tokio::time::{timeout, Duration};
            let futs = peer_pools.into_iter().map(|(eid, pool)| {
                let data = notify_data.clone();
                async move {
                    match timeout(Duration::from_secs(2), pool.send_async(data)).await {
                        Ok(true) => {}
                        Ok(false) => warn!("peerJoined notify: edge {} all senders closed", eid),
                        Err(_) => warn!("peerJoined notify: edge {} send timeout", eid),
                    }
                }
            });
            join_all(futs).await;
        }

        info!("Edge {} ({}) joined cluster — {} peers", join_edge_id, params.name, peers_snapshot.len());

        Ok(self.make_response_packet(request_id, "edge.join", |r| {
            r.edge_join = Some(EdgeJoinResult {
                success: true,
                token: Some(format!("join-{}", join_edge_id)),
                peers: peers_snapshot,
                timeout: Some(30),
                error: None,
            });
        }))
    }

    /// edge.joinComplete — Edge confirms it has connected to peers.
    pub(super) async fn handle_cluster_join_complete(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_join_complete.as_ref().context("Missing edge_join_complete params")?;
        {
            let mut topo = self.state.topology.write().await;
            topo.mark_join_complete(params.server_id, params.connected_peers.clone());
        }
        info!("Edge {} join complete, connected peers: {:?}", params.server_id, params.connected_peers);

        Ok(self.make_response_packet(request_id, "edge.joinComplete", |r| {
            r.edge_join_complete = Some(EdgeJoinCompleteResult { success: true, error: None });
        }))
    }

    /// edge.reportPeerDisconnect — Edge reports loss of connection to a peer.
    pub(super) async fn handle_report_peer_disconnect(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.edge_report_peer_disconnect.as_ref()
            .context("Missing edge_report_peer_disconnect params")?;

        let action = {
            let mut topo = self.state.topology.write().await;
            topo.arbitrate_disconnect(params.local_edge_id, params.remote_edge_id)
        };

        let action_str = match action {
            ArbitrationResult::BothReported { edge_id } => {
                // Both edges confirmed their direct TCP voice link is broken.
                // The `reporter` is params.local_edge_id; `edge_id` is the remote peer.
                let reporter_id = params.local_edge_id;

                // Check whether Hub still holds an active WebSocket connection to the
                // remote edge.  If it does, the edge has NOT left the cluster — it is
                // merely isolated from its direct peer.  Voice can still flow via Hub
                // relay (HubTcp), so we must NOT broadcast hub.peerLeft (which would
                // cause both edges to tear down their relay infrastructure and stop
                // retrying direct TCP).  Instead:
                //   1. Remove the broken direct link from the topology so the route-table
                //      computation stops advertising it as a viable path.
                //   2. Push fresh route tables — both edges will see HubTcp as the best
                //      (and only) path and fall back to Hub relay automatically.
                //   3. Keep running handle_partition_after_disconnect() so that a true
                //      network partition (Hub itself unreachable on one side) is still
                //      detected and handled.
                let edge_still_connected = {
                    let connections = self.state.edge_connections.read().await;
                    connections.contains_key(&edge_id)
                };

                if edge_still_connected {
                    warn!(
                        "Cluster: edges {} and {} lost direct TCP but both still connected to Hub \
                         — breaking direct link, falling back to Hub relay (no hub.peerLeft)",
                        reporter_id, edge_id
                    );
                    {
                        let mut topo = self.state.topology.write().await;
                        topo.remove_direct_link(reporter_id, edge_id);
                    }
                    self.push_route_tables_to_all().await;
                    self.handle_partition_after_disconnect().await;
                } else {
                    // Edge truly gone from Hub — broadcast hub.peerLeft so remaining edges
                    // can clean up relay infrastructure for this peer.
                    warn!("Cluster: edge {} confirmed disconnected by arbitration", edge_id);
                    let notif = TypedRpcNotification {
                        method: "hub.peerLeft".to_string(),
                        timestamp: Some(current_millis() as i64),
                        cluster_peer_left: Some(HubClusterPeerLeftParams { edge_id }),
                        ..Default::default()
                    };
                    let packet = EdgeHubPacket {
                        r#type: PacketType::RpcNotification as i32,
                        rpc_notification: Some(notif),
                        ..Default::default()
                    };
                    let data = packet.encode_to_vec();
                    crate::server::broadcast_critical(&self.state, data).await;
                    self.handle_partition_after_disconnect().await;
                }

                "disconnect_confirmed".to_string()
            }
            ArbitrationResult::AwaitConfirmation => "await_confirmation".to_string(),
            ArbitrationResult::HubDecides => "hub_decides".to_string(),
        };

        Ok(self.make_response_packet(request_id, "edge.reportPeerDisconnect", |r| {
            r.edge_report_peer_disconnect = Some(EdgeReportPeerDisconnectResult { action: action_str });
        }))
    }

    /// edge.reportQuality — Edge reports link quality to a peer.
    pub(super) async fn handle_report_quality(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request
            .edge_report_quality
            .as_ref()
            .context("Missing edge_report_quality params")?;
        let quality_proto = params.quality;
        let quality = LinkQuality {
            rtt_ms: quality_proto.rtt as f64,
            packet_loss: quality_proto.packet_loss as f64,
            jitter_ms: quality_proto.jitter as f64,
            samples: quality_proto.samples,
            last_update: std::time::Instant::now(),
        };
        {
            let mut topo = self.state.topology.write().await;
            topo.report_quality(params.edge_id, params.target_edge_id, quality);
        }

        self.push_route_tables_to_all().await;

        Ok(self.make_response_packet(request_id, "edge.reportQuality", |response| {
            response.edge_report_quality = Some(EdgeReportQualityResult { success: true });
        }))
    }

    /// cluster.getStatus — Returns current cluster topology status.
    pub(super) async fn handle_cluster_get_status(
        &self,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let health_map = self.state.edge_health.read().await;
        let topo = self.state.topology.read().await;
        let now = std::time::Instant::now();

        let edges: Vec<ClusterEdgeStatusProto> = topo
            .get_all_edges()
            .into_iter()
            .map(|edge| {
                let health = health_map.get(&edge.edge_id);
                let last_seen_secs = health
                    .map(|entry| now.duration_since(entry.last_heartbeat).as_secs())
                    .unwrap_or(u64::MAX);
                let status = if last_seen_secs < 60 { "healthy" } else { "stale" };
                let client_count = health.map(|entry| entry.user_count).unwrap_or(0);

                ClusterEdgeStatusProto {
                    id: edge.edge_id,
                    name: edge.name.clone(),
                    host: edge.host.clone(),
                    port: edge.port,
                    client_count,
                    status: status.to_string(),
                    last_seen: health.map(|entry| {
                        let secs_ago = now.duration_since(entry.last_heartbeat).as_secs() as i64;
                        current_millis() as i64 - secs_ago * 1000
                    }),
                }
            })
            .collect();

        info!("cluster.getStatus: {} edges in topology", edges.len());
        Ok(self.make_response_packet(request_id, "cluster.getStatus", |response| {
            response.cluster_get_status = Some(ClusterGetStatusResult { edges });
        }))
    }
}