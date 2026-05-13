use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::time::Instant;

use tracing::{debug, info, warn};

use munode_common::config::HubVoiceRoutingConfig;

/// Weight applied to packet loss (0.0–1.0) when computing link cost.
/// A value of 500.0 means 100% packet loss is penalised as 500ms extra RTT.
const PACKET_LOSS_PENALTY_MS: f64 = 500.0;

/// Info about a connected Edge in the cluster topology.
#[derive(Debug, Clone)]
pub struct TopologyEdge {
    pub edge_id: u32,
    pub name: String,
    pub host: String,
    pub port: u32,
    pub voice_port: u32,
    pub capacity: u32,
    pub joined_at: Instant,
    /// Set of connected peer IDs (confirmed via joinComplete)
    pub connected_peers: HashSet<u32>,
}

/// Link quality metrics between two Edge servers.
#[derive(Debug, Clone)]
pub struct LinkQuality {
    pub rtt_ms: f64,
    pub packet_loss: f64,
    pub jitter_ms: f64,
    pub samples: u32,
    pub last_update: Instant,
}

impl Default for LinkQuality {
    fn default() -> Self {
        Self {
            rtt_ms: 0.0,
            packet_loss: 0.0,
            jitter_ms: 0.0,
            samples: 0,
            last_update: Instant::now(),
        }
    }
}

/// The result of disconnect arbitration.
#[derive(Debug, Clone)]
pub enum ArbitrationResult {
    /// Only one side reported — wait for confirmation.
    AwaitConfirmation,
    /// Both edges agree — `edge_id` should be treated as disconnected.
    BothReported { edge_id: u32 },
    /// Hub decides (timeout, etc.)
    HubDecides,
}

/// Manages cluster topology: tracks edges, link qualities, and routing.
pub struct TopologyManager {
    /// All known edges in the cluster.
    edges: HashMap<u32, TopologyEdge>,
    /// Directional link quality: (from, to) → quality.
    link_quality: HashMap<(u32, u32), LinkQuality>,
    /// Pending disconnect reports: reporter_id → set of reported-edge-ids.
    disconnect_reports: HashMap<u32, HashSet<u32>>,
}

impl TopologyManager {
    pub fn new() -> Self {
        Self {
            edges: HashMap::new(),
            link_quality: HashMap::new(),
            disconnect_reports: HashMap::new(),
        }
    }

    /// Register a new Edge joining the cluster.
    /// Returns the list of existing peers (for the joining edge to connect to).
    pub fn add_edge(&mut self, edge: TopologyEdge) -> Vec<&TopologyEdge> {
        let edge_id = edge.edge_id;
        self.edges.insert(edge_id, edge);
        info!(
            "Topology: added edge {} — {} edges total",
            edge_id,
            self.edges.len()
        );
        self.edges
            .values()
            .filter(|e| e.edge_id != edge_id)
            .collect()
    }

    /// Mark join as complete for an edge, recording which peers it connected to.
    pub fn mark_join_complete(&mut self, edge_id: u32, connected_peers: Vec<u32>) {
        if let Some(edge) = self.edges.get_mut(&edge_id) {
            edge.connected_peers = connected_peers.into_iter().collect();
            debug!(
                "Topology: edge {} join complete, peers={:?}",
                edge_id, edge.connected_peers
            );
        }
    }

    /// Remove an Edge from the topology (disconnect).
    pub fn remove_edge(&mut self, edge_id: u32) -> Option<TopologyEdge> {
        // Clean up link quality entries
        self.link_quality
            .retain(|(a, b), _| *a != edge_id && *b != edge_id);
        // Clean up disconnect reports
        self.disconnect_reports.remove(&edge_id);
        for reporters in self.disconnect_reports.values_mut() {
            reporters.remove(&edge_id);
        }
        // Remove peer references from remaining edges
        for edge in self.edges.values_mut() {
            edge.connected_peers.remove(&edge_id);
        }
        let removed = self.edges.remove(&edge_id);
        if removed.is_some() {
            info!(
                "Topology: removed edge {} — {} edges remain",
                edge_id,
                self.edges.len()
            );
        }
        removed
    }

    /// Get all edges except the given one (peers list).
    pub fn get_peers_of(&self, exclude_id: u32) -> Vec<&TopologyEdge> {
        self.edges
            .values()
            .filter(|e| e.edge_id != exclude_id)
            .collect()
    }

    /// Get all known edges.
    pub fn get_all_edges(&self) -> Vec<&TopologyEdge> {
        self.edges.values().collect()
    }

    /// Get a specific edge by ID.
    pub fn get_edge(&self, edge_id: u32) -> Option<&TopologyEdge> {
        self.edges.get(&edge_id)
    }

    /// Report link quality from one edge to another.
    pub fn report_quality(&mut self, from: u32, to: u32, quality: LinkQuality) {
        debug!(
            "Topology: quality {}->{}: rtt={:.1}ms loss={:.1}%",
            from,
            to,
            quality.rtt_ms,
            quality.packet_loss * 100.0
        );
        self.link_quality.insert((from, to), quality);
    }

    /// Find the best forwarding path from `from` to `to` using Dijkstra's algorithm.
    /// Returns a list of edge IDs (inclusive endpoints).
    /// If no path through quality data exists, returns direct hop.
    pub fn find_best_path(&self, from: u32, to: u32) -> Vec<u32> {
        if from == to {
            return vec![from];
        }

        // Use edge quality data to build graph weights
        // Weight = rtt_ms + packet_loss * PACKET_LOSS_PENALTY_MS (penalise lossy links)
        let mut dist: HashMap<u32, f64> =
            self.edges.keys().map(|&id| (id, f64::INFINITY)).collect();
        let mut prev: HashMap<u32, u32> = HashMap::new();
        // BinaryHeap<Reverse<(ordered_float_bits, edge_id)>>
        let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();

        dist.insert(from, 0.0);
        heap.push(Reverse((0u64, from)));

        while let Some(Reverse((cost_bits, u))) = heap.pop() {
            let cost = f64::from_bits(cost_bits);
            if cost > *dist.get(&u).unwrap_or(&f64::INFINITY) {
                continue;
            }

            for (&(a, b), quality) in &self.link_quality {
                let neighbor = if a == u {
                    b
                } else if b == u {
                    a
                } else {
                    continue;
                };

                let link_weight = quality.rtt_ms + quality.packet_loss * PACKET_LOSS_PENALTY_MS;
                let next_cost = cost + link_weight;

                if next_cost < *dist.get(&neighbor).unwrap_or(&f64::INFINITY) {
                    dist.insert(neighbor, next_cost);
                    prev.insert(neighbor, u);
                    heap.push(Reverse((next_cost.to_bits(), neighbor)));
                }
            }
        }

        // Reconstruct path
        let mut path = vec![to];
        let mut cur = to;
        loop {
            if let Some(&p) = prev.get(&cur) {
                path.push(p);
                cur = p;
                if cur == from {
                    break;
                }
            } else {
                // No complete path — return direct hop
                return vec![from, to];
            }
        }
        path.reverse();
        path
    }

    /// Detect network partitions using Union-Find.
    /// Returns groups of edge IDs that can reach each other.
    pub fn detect_partitions(&self) -> Vec<HashSet<u32>> {
        let edge_ids: Vec<u32> = self.edges.keys().cloned().collect();
        let mut parent: HashMap<u32, u32> = edge_ids.iter().map(|&e| (e, e)).collect();

        // Iterative find with path compression — avoids stack overflow on large clusters.
        fn find(parent: &mut HashMap<u32, u32>, x: u32) -> u32 {
            // Walk up to the root.
            // The parent map can only be set by `union()` which always points a
            // root to another root, so the chain is strictly decreasing in depth
            // and cannot cycle.  The bound `parent.len() + 1` is a safety guard
            // against any future bug that could introduce a cycle.
            let mut root = x;
            let max_depth = parent.len() + 1;
            let mut depth = 0;
            while parent.get(&root).copied().unwrap_or(root) != root {
                root = parent.get(&root).copied().unwrap_or(root);
                depth += 1;
                if depth > max_depth {
                    break; // Safety: should never happen in a correct Union-Find
                }
            }
            // Path compression: point every node on the path directly to root
            let mut cur = x;
            while cur != root {
                let next = parent.get(&cur).copied().unwrap_or(root);
                parent.insert(cur, root);
                if next == cur {
                    break;
                } // Defensive: avoid infinite loop
                cur = next;
            }
            root
        }

        fn union(parent: &mut HashMap<u32, u32>, x: u32, y: u32) {
            let px = find(parent, x);
            let py = find(parent, y);
            if px != py {
                parent.insert(px, py);
            }
        }

        // Edges are connected if they have link quality data between them
        for &(a, b) in self.link_quality.keys() {
            if self.edges.contains_key(&a) && self.edges.contains_key(&b) {
                union(&mut parent, a, b);
            }
        }

        // Also union edges that report each other as connected peers
        for edge in self.edges.values() {
            for &peer_id in &edge.connected_peers {
                if self.edges.contains_key(&peer_id) {
                    union(&mut parent, edge.edge_id, peer_id);
                }
            }
        }

        // Group by root representative
        let mut groups: HashMap<u32, HashSet<u32>> = HashMap::new();
        for &e in &edge_ids {
            let root = find(&mut parent, e);
            groups.entry(root).or_default().insert(e);
        }

        let partitions: Vec<HashSet<u32>> = groups.into_values().collect();
        if partitions.len() > 1 {
            warn!("Topology: detected {} network partitions", partitions.len());
        }
        partitions
    }

    /// Detect partitions and return them sorted by aggregated user count.
    ///
    /// The smallest partition is first. Ties are broken deterministically by
    /// edge count and then by sorted edge IDs.
    pub fn partitions_by_user_count(
        &self,
        users_per_edge: &HashMap<u32, usize>,
    ) -> Vec<(HashSet<u32>, usize)> {
        let mut partition_user_counts: Vec<(HashSet<u32>, usize)> = self
            .detect_partitions()
            .into_iter()
            .map(|partition| {
                let user_count: usize = partition
                    .iter()
                    .map(|edge_id| users_per_edge.get(edge_id).copied().unwrap_or(0))
                    .sum();
                (partition, user_count)
            })
            .collect();

        partition_user_counts.sort_by(|(partition_a, count_a), (partition_b, count_b)| {
            count_a
                .cmp(count_b)
                .then_with(|| partition_a.len().cmp(&partition_b.len()))
                .then_with(|| {
                    let mut a_ids: Vec<_> = partition_a.iter().copied().collect();
                    let mut b_ids: Vec<_> = partition_b.iter().copied().collect();
                    a_ids.sort_unstable();
                    b_ids.sort_unstable();
                    a_ids.cmp(&b_ids)
                })
        });

        partition_user_counts
    }

    /// Process a peer-disconnect report and perform arbitration.
    pub fn arbitrate_disconnect(&mut self, reporter: u32, disconnected: u32) -> ArbitrationResult {
        let reporters = self.disconnect_reports.entry(reporter).or_default();
        reporters.insert(disconnected);

        // Check if the disconnected edge also reported losing the reporter
        let other_side_confirmed = self
            .disconnect_reports
            .get(&disconnected)
            .map(|s| s.contains(&reporter))
            .unwrap_or(false);

        if other_side_confirmed {
            info!(
                "Topology: both edges {} and {} confirmed disconnect",
                reporter, disconnected
            );
            ArbitrationResult::BothReported {
                edge_id: disconnected,
            }
        } else {
            debug!(
                "Topology: awaiting confirmation from edge {} about disconnect from {}",
                disconnected, reporter
            );
            ArbitrationResult::AwaitConfirmation
        }
    }

    /// Remove the direct link between two edges without removing either edge node.
    ///
    /// Called when both edges confirm their direct TCP voice connection is broken
    /// but both are still connected to Hub.  After this call the route table will
    /// no longer include a direct path between `a` and `b`; they will fall back to
    /// Hub relay or relay-chain routes.
    pub fn remove_direct_link(&mut self, a: u32, b: u32) {
        // Drop link quality data in both directions.
        self.link_quality.remove(&(a, b));
        self.link_quality.remove(&(b, a));
        // Remove each node from the other's connected_peers set.
        if let Some(edge) = self.edges.get_mut(&a) {
            edge.connected_peers.remove(&b);
        }
        if let Some(edge) = self.edges.get_mut(&b) {
            edge.connected_peers.remove(&a);
        }
        // Clear the now-resolved disconnect reports for this pair so a fresh
        // TCP reconnection can be reported and re-evaluated correctly.
        if let Some(reporters) = self.disconnect_reports.get_mut(&a) {
            reporters.remove(&b);
        }
        if let Some(reporters) = self.disconnect_reports.get_mut(&b) {
            reporters.remove(&a);
        }
        debug!(
            "Topology: removed direct link between edges {} and {}",
            a, b
        );
    }

    /// Total number of edges in the topology.
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Get the raw edges map for read-only inspection (e.g., Web API).
    pub fn get_edges(&self) -> &HashMap<u32, TopologyEdge> {
        &self.edges
    }

    /// Get the raw link quality map for read-only inspection (e.g., Web API).
    pub fn get_link_qualities(&self) -> &HashMap<(u32, u32), LinkQuality> {
        &self.link_quality
    }

    /// Compute route table for an Edge.
    /// Returns: Vec<(target_edge_id, route_type, relay_chain, cost)>
    ///   route_type: 0=DirectUdp, 1=RelayChain, 2=HubTcp, 3=DirectTcp
    ///   relay_chain: full intermediate node list (path[1..len-1])
    ///
    /// Every target always gets at least a DirectTcp (type 3) and a HubTcp (type 2)
    /// candidate so Edges always have fallback options.
    pub fn compute_route_table(
        &self,
        for_edge_id: u32,
        config: &HubVoiceRoutingConfig,
    ) -> Vec<(u32, u32, Vec<u32>, f32)> {
        let mut result = Vec::new();
        let all_edge_ids: Vec<u32> = self.edges.keys().cloned().collect();

        for target_id in &all_edge_ids {
            let target_id = *target_id;
            if target_id == for_edge_id {
                continue;
            }

            let path = self.find_best_path_with_config(for_edge_id, target_id, config);

            // Whether a HubTcp entry has already been emitted for this target
            // (can happen when a relay chain is too long and falls back to HubTcp
            // inside the match arm below).
            let mut hub_tcp_emitted = false;

            match path.len() {
                0 | 1 => {
                    // No path data — default direct with fallback cost
                    result.push((target_id, 0, vec![], 9999.0));
                }
                2 => {
                    // Direct route
                    let cost = self
                        .link_quality
                        .get(&(for_edge_id, target_id))
                        .map(|q| (q.rtt_ms + q.packet_loss * PACKET_LOSS_PENALTY_MS) as f32)
                        .unwrap_or(100.0);
                    result.push((target_id, 0, vec![], cost));
                }
                _ => {
                    // Relay chain: intermediate nodes are path[1..len-1]
                    let relay_chain: Vec<u32> = path[1..path.len() - 1].to_vec();
                    let hop_count = relay_chain.len();
                    if hop_count > config.max_relay_hops {
                        // Too many hops — fall back to Hub TCP.
                        // Use a fixed representative cost (Hub round-trip ≈ 150ms) rather than
                        // the relay path cost, which would be misleadingly high for long chains.
                        const HUB_TCP_REPRESENTATIVE_COST: f32 = 150.0;
                        result.push((target_id, 2, vec![], HUB_TCP_REPRESENTATIVE_COST));
                        hub_tcp_emitted = true;
                    } else {
                        let cost = self.path_cost(&path, config) as f32;
                        result.push((target_id, 1, relay_chain, cost));
                    }
                }
            }

            // DirectTcp candidate: always add so the Edge can choose TCP when UDP is degraded.
            let tcp_cost = self
                .link_quality
                .get(&(for_edge_id, target_id))
                .map(|q| (q.rtt_ms * 1.5 + config.edge_tcp_penalty_ms) as f32)
                .unwrap_or(200.0);
            result.push((target_id, 3, vec![], tcp_cost));

            // HubTcp fallback: always present as last resort — but only if not already emitted
            // above (which happens when a relay chain exceeds max_relay_hops).
            if !hub_tcp_emitted {
                const HUB_TCP_COST: f32 = 150.0;
                result.push((target_id, 2, vec![], HUB_TCP_COST));
            }
        }
        result
    }

    /// Find the best forwarding path with quality thresholds applied.
    fn find_best_path_with_config(
        &self,
        from: u32,
        to: u32,
        config: &HubVoiceRoutingConfig,
    ) -> Vec<u32> {
        if from == to {
            return vec![from];
        }

        let mut dist: HashMap<u32, f64> =
            self.edges.keys().map(|&id| (id, f64::INFINITY)).collect();
        let mut prev: HashMap<u32, u32> = HashMap::new();
        let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();

        dist.insert(from, 0.0);
        heap.push(Reverse((0u64, from)));

        while let Some(Reverse((cost_bits, u))) = heap.pop() {
            let cost = f64::from_bits(cost_bits);
            if cost > *dist.get(&u).unwrap_or(&f64::INFINITY) {
                continue;
            }

            for (&(a, b), quality) in &self.link_quality {
                let neighbor = if a == u {
                    b
                } else if b == u {
                    a
                } else {
                    continue;
                };

                // Skip failed links
                if quality.packet_loss > config.failed_packet_loss
                    || quality.rtt_ms > config.failed_rtt_ms
                {
                    continue;
                }

                let link_weight = quality.rtt_ms
                    + quality.packet_loss * PACKET_LOSS_PENALTY_MS
                    + config.relay_hop_penalty_ms;
                let next_cost = cost + link_weight;

                if next_cost < *dist.get(&neighbor).unwrap_or(&f64::INFINITY) {
                    dist.insert(neighbor, next_cost);
                    prev.insert(neighbor, u);
                    heap.push(Reverse((next_cost.to_bits(), neighbor)));
                }
            }
        }

        // Reconstruct path
        let mut path = vec![to];
        let mut cur = to;
        loop {
            if let Some(&p) = prev.get(&cur) {
                path.push(p);
                cur = p;
                if cur == from {
                    break;
                }
            } else {
                return vec![from, to];
            }
        }
        path.reverse();
        path
    }

    fn path_cost(&self, path: &[u32], config: &HubVoiceRoutingConfig) -> f64 {
        let mut total = 0.0f64;
        for i in 0..path.len().saturating_sub(1) {
            let a = path[i];
            let b = path[i + 1];
            let cost = self
                .link_quality
                .get(&(a, b))
                .or_else(|| self.link_quality.get(&(b, a)))
                .map(|q| {
                    q.rtt_ms + q.packet_loss * PACKET_LOSS_PENALTY_MS + config.relay_hop_penalty_ms
                })
                .unwrap_or(100.0);
            total += cost;
        }
        total
    }
}
