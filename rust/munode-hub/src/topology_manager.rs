use std::collections::{BinaryHeap, HashMap, HashSet};
use std::cmp::Reverse;
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
        info!("Topology: added edge {} — {} edges total", edge_id, self.edges.len());
        self.edges.values()
            .filter(|e| e.edge_id != edge_id)
            .collect()
    }

    /// Mark join as complete for an edge, recording which peers it connected to.
    pub fn mark_join_complete(&mut self, edge_id: u32, connected_peers: Vec<u32>) {
        if let Some(edge) = self.edges.get_mut(&edge_id) {
            edge.connected_peers = connected_peers.into_iter().collect();
            debug!("Topology: edge {} join complete, peers={:?}", edge_id, edge.connected_peers);
        }
    }

    /// Remove an Edge from the topology (disconnect).
    pub fn remove_edge(&mut self, edge_id: u32) -> Option<TopologyEdge> {
        // Clean up link quality entries
        self.link_quality.retain(|(a, b), _| *a != edge_id && *b != edge_id);
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
            info!("Topology: removed edge {} — {} edges remain", edge_id, self.edges.len());
        }
        removed
    }

    /// Get all edges except the given one (peers list).
    pub fn get_peers_of(&self, exclude_id: u32) -> Vec<&TopologyEdge> {
        self.edges.values()
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
        debug!("Topology: quality {}->{}: rtt={:.1}ms loss={:.1}%", from, to, quality.rtt_ms, quality.packet_loss * 100.0);
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
        let mut dist: HashMap<u32, f64> = self.edges.keys().map(|&id| (id, f64::INFINITY)).collect();
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
                if next == cur { break; } // Defensive: avoid infinite loop
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

    /// Process a peer-disconnect report and perform arbitration.
    pub fn arbitrate_disconnect(&mut self, reporter: u32, disconnected: u32) -> ArbitrationResult {
        let reporters = self.disconnect_reports.entry(reporter).or_default();
        reporters.insert(disconnected);

        // Check if the disconnected edge also reported losing the reporter
        let other_side_confirmed = self.disconnect_reports
            .get(&disconnected)
            .map(|s| s.contains(&reporter))
            .unwrap_or(false);

        if other_side_confirmed {
            info!("Topology: both edges {} and {} confirmed disconnect", reporter, disconnected);
            ArbitrationResult::BothReported { edge_id: disconnected }
        } else {
            debug!("Topology: awaiting confirmation from edge {} about disconnect from {}", disconnected, reporter);
            ArbitrationResult::AwaitConfirmation
        }
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
    ///   route_type: 0=direct, 1=relay_chain, 2=hub_tcp
    ///   relay_chain: full intermediate node list (path[1..len-1])
    pub fn compute_route_table(&self, for_edge_id: u32, config: &HubVoiceRoutingConfig) -> Vec<(u32, u32, Vec<u32>, f32)> {
        let mut result = Vec::new();
        let all_edge_ids: Vec<u32> = self.edges.keys().cloned().collect();

        for target_id in &all_edge_ids {
            let target_id = *target_id;
            if target_id == for_edge_id {
                continue;
            }

            let path = self.find_best_path_with_config(for_edge_id, target_id, config);

            match path.len() {
                0 | 1 => {
                    // No path data — default direct with fallback cost
                    result.push((target_id, 0, vec![], 9999.0));
                }
                2 => {
                    // Direct route
                    let cost = self.link_quality.get(&(for_edge_id, target_id))
                        .map(|q| (q.rtt_ms + q.packet_loss * PACKET_LOSS_PENALTY_MS) as f32)
                        .unwrap_or(100.0);
                    result.push((target_id, 0, vec![], cost));
                }
                _ => {
                    // Relay chain: intermediate nodes are path[1..len-1]
                    let relay_chain: Vec<u32> = path[1..path.len()-1].to_vec();
                    let hop_count = relay_chain.len();
                    if hop_count > config.max_relay_hops {
                        // Too many hops — fall back to Hub TCP.
                        // Use a fixed representative cost (Hub round-trip ≈ 150ms) rather than
                        // the relay path cost, which would be misleadingly high for long chains.
                        const HUB_TCP_REPRESENTATIVE_COST: f32 = 150.0;
                        result.push((target_id, 2, vec![], HUB_TCP_REPRESENTATIVE_COST));
                    } else {
                        let cost = self.path_cost(&path, config) as f32;
                        result.push((target_id, 1, relay_chain, cost));
                    }
                }
            }

            // DirectTcp candidate: always add so the Edge can choose TCP when UDP is degraded.
            let tcp_cost = self.link_quality.get(&(for_edge_id, target_id))
                .map(|q| (q.rtt_ms * 1.5 + config.edge_tcp_penalty_ms) as f32)
                .unwrap_or(200.0);
            result.push((target_id, 3, vec![], tcp_cost));

            // HubTcp fallback: always present as last resort.
            const HUB_TCP_COST: f32 = 150.0;
            result.push((target_id, 2, vec![], HUB_TCP_COST));
        }
        result
    }

    /// Find the best forwarding path with quality thresholds applied.
    fn find_best_path_with_config(&self, from: u32, to: u32, config: &HubVoiceRoutingConfig) -> Vec<u32> {
        if from == to {
            return vec![from];
        }

        let mut dist: HashMap<u32, f64> = self.edges.keys().map(|&id| (id, f64::INFINITY)).collect();
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
                if quality.packet_loss > config.failed_packet_loss || quality.rtt_ms > config.failed_rtt_ms {
                    continue;
                }

                let link_weight = quality.rtt_ms + quality.packet_loss * PACKET_LOSS_PENALTY_MS
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
            let cost = self.link_quality.get(&(a, b))
                .or_else(|| self.link_quality.get(&(b, a)))
                .map(|q| q.rtt_ms + q.packet_loss * PACKET_LOSS_PENALTY_MS + config.relay_hop_penalty_ms)
                .unwrap_or(100.0);
            total += cost;
        }
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use munode_common::config::HubVoiceRoutingConfig;

    fn make_edge(id: u32) -> TopologyEdge {
        TopologyEdge {
            edge_id: id,
            name: format!("edge-{}", id),
            host: format!("10.0.0.{}", id),
            port: 64000 + id,
            voice_port: 64001 + id,
            capacity: 100,
            joined_at: Instant::now(),
            connected_peers: HashSet::new(),
        }
    }

    fn make_quality(rtt_ms: f64, packet_loss: f64) -> LinkQuality {
        LinkQuality { rtt_ms, packet_loss, jitter_ms: 0.0, samples: 10, last_update: Instant::now() }
    }

    fn default_config() -> HubVoiceRoutingConfig {
        HubVoiceRoutingConfig::default()
    }

    // ── Dijkstra path selection ──────────────────────────────────────────────

    #[test]
    fn test_direct_path_when_only_two_edges() {
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1));
        topo.add_edge(make_edge(2));
        topo.report_quality(1, 2, make_quality(30.0, 0.0));
        topo.report_quality(2, 1, make_quality(30.0, 0.0));

        let path = topo.find_best_path(1, 2);
        assert_eq!(path, vec![1, 2]);
    }

    #[test]
    fn test_relay_path_cheaper_than_direct() {
        // A→B direct: RTT=100ms loss=10% → cost = 100 + 0.10*500 = 150
        // A→C→B:  A→C RTT=10ms loss=1% → 10+5=15
        //         C→B RTT=15ms loss=2% → 15+10=25
        //         total = 15+25 = 40  (+relay_hop_penalty=5 each) = 40+5+5=50
        // So relay wins.
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1)); // A
        topo.add_edge(make_edge(2)); // B
        topo.add_edge(make_edge(3)); // C
        topo.report_quality(1, 2, make_quality(100.0, 0.10));
        topo.report_quality(2, 1, make_quality(100.0, 0.10));
        topo.report_quality(1, 3, make_quality(10.0, 0.01));
        topo.report_quality(3, 1, make_quality(10.0, 0.01));
        topo.report_quality(3, 2, make_quality(15.0, 0.02));
        topo.report_quality(2, 3, make_quality(15.0, 0.02));

        let cfg = default_config();
        let path = topo.find_best_path_with_config(1, 2, &cfg);
        assert_eq!(path, vec![1, 3, 2], "expected relay via edge 3");
    }

    #[test]
    fn test_failed_link_excluded_from_udp_path() {
        // A→B link has 60% packet loss → marked as failed (default threshold 0.5)
        // A→C→B is the only valid path.
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1));
        topo.add_edge(make_edge(2));
        topo.add_edge(make_edge(3));
        let mut cfg = default_config();
        cfg.failed_packet_loss = 0.5; // 50% threshold

        topo.report_quality(1, 2, make_quality(20.0, 0.60)); // FAILED
        topo.report_quality(1, 3, make_quality(10.0, 0.01));
        topo.report_quality(3, 2, make_quality(10.0, 0.01));

        let path = topo.find_best_path_with_config(1, 2, &cfg);
        // Direct link is failed → relay via 3
        assert_eq!(path, vec![1, 3, 2]);
    }

    // ── compute_route_table candidates ──────────────────────────────────────

    #[test]
    fn test_route_table_always_has_hub_tcp_candidate() {
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1));
        topo.add_edge(make_edge(2));
        topo.report_quality(1, 2, make_quality(30.0, 0.0));

        let cfg = default_config();
        let routes = topo.compute_route_table(1, &cfg);

        // route_type 2 = HubTcp
        let hub_tcp: Vec<_> = routes.iter().filter(|(t, rtype, _, _)| *t == 2 && *rtype == 2).collect();
        assert!(!hub_tcp.is_empty(), "HubTcp candidate must always be present");
    }

    #[test]
    fn test_route_table_always_has_direct_tcp_candidate() {
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1));
        topo.add_edge(make_edge(2));
        topo.report_quality(1, 2, make_quality(30.0, 0.0));

        let cfg = default_config();
        let routes = topo.compute_route_table(1, &cfg);

        // route_type 3 = DirectTcp
        let tcp: Vec<_> = routes.iter().filter(|(t, rtype, _, _)| *t == 2 && *rtype == 3).collect();
        assert!(!tcp.is_empty(), "DirectTcp candidate must always be present");
    }

    #[test]
    fn test_route_table_direct_udp_when_good_link() {
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1));
        topo.add_edge(make_edge(2));
        topo.report_quality(1, 2, make_quality(20.0, 0.01));

        let cfg = default_config();
        let routes = topo.compute_route_table(1, &cfg);

        // route_type 0 = DirectUdp
        let direct: Vec<_> = routes.iter().filter(|(t, rtype, _, _)| *t == 2 && *rtype == 0).collect();
        assert!(!direct.is_empty(), "DirectUdp candidate must be present for a good link");
    }

    #[test]
    fn test_route_table_relay_chain_three_edges() {
        // B→C link only via relay A.  For edge C to reach B it must go through A.
        // (We ask for edge 3's route table here as the middle relay.)
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1)); // A
        topo.add_edge(make_edge(2)); // B
        topo.add_edge(make_edge(3)); // C (relay)
        // A and C can reach B
        topo.report_quality(1, 3, make_quality(10.0, 0.0));
        topo.report_quality(3, 1, make_quality(10.0, 0.0));
        topo.report_quality(1, 2, make_quality(100.0, 0.60)); // direct A→B fails
        topo.report_quality(3, 2, make_quality(15.0, 0.0));
        topo.report_quality(2, 3, make_quality(15.0, 0.0));

        let mut cfg = default_config();
        cfg.failed_packet_loss = 0.5;
        let routes = topo.compute_route_table(1, &cfg);

        // For target B (id=2) there should be a relay chain entry going through C (id=3)
        let relay: Vec<_> = routes.iter()
            .filter(|(t, rtype, chain, _)| *t == 2 && *rtype == 1 && chain.contains(&3))
            .collect();
        assert!(!relay.is_empty(), "relay chain via edge 3 should be present");
    }

    #[test]
    fn test_route_table_too_many_hops_falls_back_to_hub_tcp() {
        // Build a linear chain 1→2→3→4→5: to reach 5 from 1 requires 3 hops.
        // Set max_relay_hops=2 → chain should fall back to HubTcp.
        let mut topo = TopologyManager::new();
        for i in 1u32..=5 {
            topo.add_edge(make_edge(i));
        }
        topo.report_quality(1, 2, make_quality(1000.0, 0.90)); // direct 1→5 fails
        topo.report_quality(1, 2, make_quality(10.0, 0.0));
        topo.report_quality(2, 3, make_quality(10.0, 0.0));
        topo.report_quality(3, 4, make_quality(10.0, 0.0));
        topo.report_quality(4, 5, make_quality(10.0, 0.0));
        // symmetric
        for (a, b) in &[(2u32,1u32),(3,2),(4,3),(5,4)] {
            topo.report_quality(*a, *b, make_quality(10.0, 0.0));
        }

        let mut cfg = default_config();
        cfg.failed_packet_loss = 0.5;
        cfg.max_relay_hops = 2; // chains longer than 2 hops → HubTcp

        let routes = topo.compute_route_table(1, &cfg);
        // For target 5 (3 relay hops: 2,3,4), should emit HubTcp (type=2) not relay_chain
        let for_5: Vec<_> = routes.iter().filter(|(t, _, _, _)| *t == 5).collect();
        // There must be at least one HubTcp entry (route_type=2) for target 5
        let has_hub = for_5.iter().any(|(_, rtype, chain, _)| *rtype == 2 && chain.is_empty());
        assert!(has_hub, "long chains should produce a HubTcp entry for target 5; got: {:?}", for_5);
    }

    // ── Partition detection ──────────────────────────────────────────────────

    #[test]
    fn test_single_connected_component() {
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1));
        topo.add_edge(make_edge(2));
        topo.add_edge(make_edge(3));
        topo.report_quality(1, 2, make_quality(10.0, 0.0));
        topo.report_quality(2, 3, make_quality(10.0, 0.0));

        let parts = topo.detect_partitions();
        assert_eq!(parts.len(), 1, "should be one connected component");
    }

    #[test]
    fn test_partitioned_network() {
        let mut topo = TopologyManager::new();
        topo.add_edge(make_edge(1));
        topo.add_edge(make_edge(2));
        topo.add_edge(make_edge(3));
        topo.add_edge(make_edge(4));
        // {1,2} and {3,4} are isolated islands
        topo.report_quality(1, 2, make_quality(10.0, 0.0));
        topo.report_quality(3, 4, make_quality(10.0, 0.0));

        let parts = topo.detect_partitions();
        assert_eq!(parts.len(), 2, "should detect two network partitions");
    }

    // ── Disconnect arbitration ───────────────────────────────────────────────

    #[test]
    fn test_arbitration_awaits_single_report() {
        let mut topo = TopologyManager::new();
        match topo.arbitrate_disconnect(1, 2) {
            ArbitrationResult::AwaitConfirmation => {}
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn test_arbitration_confirms_on_both_reports() {
        let mut topo = TopologyManager::new();
        topo.arbitrate_disconnect(1, 2);
        match topo.arbitrate_disconnect(2, 1) {
            ArbitrationResult::BothReported { edge_id: 1 } => {}
            other => panic!("unexpected: {:?}", other),
        }
    }
}
