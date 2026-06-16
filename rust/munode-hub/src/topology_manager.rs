use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::time::Instant;

use tracing::{debug, info, warn};

use munode_common::config::HubVoiceRoutingConfig;
use munode_protocol::hubedge::ClusterPeerEndpointProto;

/// Weight applied to packet loss (0.0–1.0) when computing link cost.
/// A value of 500.0 means 100% packet loss is penalised as 500ms extra RTT.
const PACKET_LOSS_PENALTY_MS: f64 = 500.0;

/// Fallback cost for a confirmed peer edge when no quality sample exists yet.
/// This keeps freshly-joined clusters routable before the probe loop populates
/// directional RTT/loss data.
const DEFAULT_CONNECTED_PEER_COST_MS: f64 = 100.0;
const DEFAULT_DIRECT_TCP_COST_MS: f32 = 200.0;

/// Info about a connected Edge in the cluster topology.
#[derive(Debug, Clone)]
pub struct TopologyEdge {
    pub edge_id: u32,
    pub name: String,
    pub host: String,
    pub port: u32,
    pub voice_port: u32,
    pub peer_endpoints: Vec<ClusterPeerEndpointProto>,
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

/// Hub-computed source-rooted dissemination view for one Edge.
#[derive(Debug, Clone, Default)]
pub struct SourceDisseminationPlan {
    pub source_edge_id: u32,
    pub active_children: Vec<u32>,
    pub duplicate_children: Vec<u32>,
    pub branch_backups: Vec<(u32, Vec<u32>)>,
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
    /// Directional link quality: (from, to, target_host, target_port) → quality.
    link_quality: HashMap<(u32, u32, String, u16), LinkQuality>,
    /// Pending disconnect reports: reporter_id → set of reported-edge-ids.
    disconnect_reports: HashMap<u32, HashSet<u32>>,
}

impl Default for TopologyManager {
    fn default() -> Self {
        Self::new()
    }
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
            .retain(|(a, b, _, _), _| *a != edge_id && *b != edge_id);
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
    pub fn report_quality(
        &mut self,
        from: u32,
        to: u32,
        target_host: String,
        target_port: u16,
        quality: LinkQuality,
    ) {
        debug!(
            "Topology: quality {}->{}: rtt={:.1}ms loss={:.1}%",
            from,
            to,
            quality.rtt_ms,
            quality.packet_loss * 100.0
        );
        self.link_quality
            .insert((from, to, target_host, target_port), quality);
    }

    fn best_quality(&self, from: u32, to: u32) -> Option<&LinkQuality> {
        self.link_quality
            .iter()
            .filter(|((source, target, _, _), _)| *source == from && *target == to)
            .map(|(_, quality)| quality)
            .min_by(|a, b| {
                let a_cost = a.rtt_ms + a.packet_loss * PACKET_LOSS_PENALTY_MS;
                let b_cost = b.rtt_ms + b.packet_loss * PACKET_LOSS_PENALTY_MS;
                a_cost.total_cmp(&b_cost)
            })
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

            self.for_each_outgoing_edge(u, None, None, |neighbor, link_weight| {
                let next_cost = cost + link_weight;

                if next_cost < *dist.get(&neighbor).unwrap_or(&f64::INFINITY) {
                    dist.insert(neighbor, next_cost);
                    prev.insert(neighbor, u);
                    heap.push(Reverse((next_cost.to_bits(), neighbor)));
                }
            });
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
        for &(a, b, _, _) in self.link_quality.keys() {
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
        self.link_quality
            .retain(|(from, to, _, _), _| !(*from == a && *to == b || *from == b && *to == a));
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
    pub fn get_link_qualities(&self) -> &HashMap<(u32, u32, String, u16), LinkQuality> {
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
            let direct_tcp_cost = self.direct_tcp_cost(for_edge_id, target_id, config);

            match path.len() {
                0 | 1 => {
                    // No path data — default direct with fallback cost
                    result.push((target_id, 0, vec![], 9999.0));
                }
                2 => {
                    // Direct route
                    let cost = self
                        .best_quality(for_edge_id, target_id)
                        .map(|q| (q.rtt_ms + q.packet_loss * PACKET_LOSS_PENALTY_MS) as f32)
                        .unwrap_or(100.0);
                    result.push((target_id, 0, vec![], cost));
                }
                _ => {
                    // Relay chain: intermediate nodes are path[1..len-1]
                    let relay_chain: Vec<u32> = path[1..path.len() - 1].to_vec();
                    let hop_count = relay_chain.len();
                    if hop_count > config.max_relay_hops {
                        // Too many hops — fall back to Hub TCP. Model Hub relay as a
                        // last-resort path that is always more expensive than DirectTcp.
                        result.push((
                            target_id,
                            2,
                            vec![],
                            self.hub_tcp_cost(direct_tcp_cost, config),
                        ));
                        hub_tcp_emitted = true;
                    } else {
                        let cost = self.path_cost(&path, config) as f32;
                        result.push((target_id, 1, relay_chain, cost));
                    }
                }
            }

            // DirectTcp candidate: always add so the Edge can choose TCP when UDP is degraded.
            result.push((target_id, 3, vec![], direct_tcp_cost));

            // HubTcp fallback: always present as last resort — but only if not already emitted
            // above (which happens when a relay chain exceeds max_relay_hops).
            if !hub_tcp_emitted {
                result.push((
                    target_id,
                    2,
                    vec![],
                    self.hub_tcp_cost(direct_tcp_cost, config),
                ));
            }
        }
        result
    }

    fn direct_tcp_cost(
        &self,
        for_edge_id: u32,
        target_id: u32,
        config: &HubVoiceRoutingConfig,
    ) -> f32 {
        self.best_quality(for_edge_id, target_id)
            .map(|q| {
                ((q.rtt_ms * 1.5 + config.edge_tcp_penalty_ms) as f32)
                    .max(DEFAULT_DIRECT_TCP_COST_MS)
            })
            .unwrap_or(DEFAULT_DIRECT_TCP_COST_MS)
    }

    fn hub_tcp_cost(&self, direct_tcp_cost: f32, config: &HubVoiceRoutingConfig) -> f32 {
        direct_tcp_cost + config.hub_tcp_penalty_ms as f32
    }

    /// Compute the source-rooted dissemination plan for one Edge.
    pub fn compute_dissemination_plan(
        &self,
        for_edge_id: u32,
        config: &HubVoiceRoutingConfig,
    ) -> Vec<SourceDisseminationPlan> {
        let mut source_ids: Vec<u32> = self.edges.keys().copied().collect();
        source_ids.sort_unstable();

        let mut node_ids: Vec<u32> = self.edges.keys().copied().collect();
        node_ids.sort_unstable();

        let mut plans = Vec::with_capacity(source_ids.len());

        for source_edge_id in source_ids {
            let (_, prev) = self.directed_dijkstra(source_edge_id, config, None);
            let mut active_children = Vec::new();

            for &node_id in &node_ids {
                if node_id == source_edge_id {
                    continue;
                }
                if prev.get(&node_id).copied() == Some(for_edge_id) {
                    active_children.push(node_id);
                }
            }

            let mut duplicate_children = Vec::new();
            let mut branch_backups = Vec::new();

            for &primary_child in &active_children {
                let backup_next_hops =
                    self.compute_branch_backups(for_edge_id, primary_child, config);
                if backup_next_hops.is_empty() {
                    continue;
                }

                let degraded = self
                    .best_quality(for_edge_id, primary_child)
                    .map(|quality| {
                        quality.packet_loss > config.degraded_packet_loss
                            || quality.rtt_ms > config.degraded_rtt_ms
                    })
                    .unwrap_or(false);
                if degraded {
                    duplicate_children.push(primary_child);
                }

                branch_backups.push((primary_child, backup_next_hops));
            }

            plans.push(SourceDisseminationPlan {
                source_edge_id,
                active_children,
                duplicate_children,
                branch_backups,
            });
        }

        plans
    }

    /// Find the best forwarding path with quality thresholds applied.
    fn find_best_path_with_config(
        &self,
        from: u32,
        to: u32,
        config: &HubVoiceRoutingConfig,
    ) -> Vec<u32> {
        let (_, prev) = self.directed_dijkstra(from, config, None);
        Self::reconstruct_path(&prev, from, to).unwrap_or_else(|| vec![from, to])
    }

    fn path_cost(&self, path: &[u32], config: &HubVoiceRoutingConfig) -> f64 {
        let mut total = 0.0f64;
        for i in 0..path.len().saturating_sub(1) {
            let a = path[i];
            let b = path[i + 1];
            let cost = self
                .best_quality(a, b)
                .map(|q| {
                    q.rtt_ms + q.packet_loss * PACKET_LOSS_PENALTY_MS + config.relay_hop_penalty_ms
                })
                .unwrap_or(100.0);
            total += cost;
        }
        total
    }

    fn directed_dijkstra(
        &self,
        from: u32,
        config: &HubVoiceRoutingConfig,
        excluded_edge: Option<(u32, u32)>,
    ) -> (HashMap<u32, f64>, HashMap<u32, u32>) {
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

            self.for_each_outgoing_edge(u, Some(config), excluded_edge, |b, link_weight| {
                let next_cost = cost + link_weight;

                if next_cost < *dist.get(&b).unwrap_or(&f64::INFINITY) {
                    dist.insert(b, next_cost);
                    prev.insert(b, u);
                    heap.push(Reverse((next_cost.to_bits(), b)));
                }
            });
        }

        (dist, prev)
    }

    fn for_each_outgoing_edge<F>(
        &self,
        from: u32,
        config: Option<&HubVoiceRoutingConfig>,
        excluded_edge: Option<(u32, u32)>,
        mut visit: F,
    ) where
        F: FnMut(u32, f64),
    {
        let mut seen = HashSet::new();
        let mut explicit_quality_peers = HashSet::new();

        for (&(a, b, _, _), quality) in &self.link_quality {
            if a != from || excluded_edge == Some((a, b)) {
                continue;
            }

            if let Some(config) = config
                && (quality.packet_loss > config.failed_packet_loss
                    || quality.rtt_ms > config.failed_rtt_ms)
            {
                // Quality is too poor to use as a direct path, but the
                // connected_peers fallback must not be blocked — the edge pair
                // has confirmed mutual reachability via joinComplete, and Hub
                // relay / peer TCP can still carry voice when direct UDP is
                // degraded.  Skipping the fallback (by adding b to
                // explicit_quality_peers before this `continue`) creates an
                // asymmetric partition: if one direction's quality is poor and
                // the other's is fine, the poor side becomes unreachable even
                // though the edges are mutually reachable at the control level.
                continue;
            }

            explicit_quality_peers.insert(b);

            let penalty = config.map(|cfg| cfg.relay_hop_penalty_ms).unwrap_or(0.0);
            let link_weight =
                quality.rtt_ms + quality.packet_loss * PACKET_LOSS_PENALTY_MS + penalty;
            seen.insert(b);
            visit(b, link_weight);
        }

        let Some(edge) = self.edges.get(&from) else {
            return;
        };

        let penalty = config.map(|cfg| cfg.relay_hop_penalty_ms).unwrap_or(0.0);
        for &peer_id in &edge.connected_peers {
            if excluded_edge == Some((from, peer_id))
                || seen.contains(&peer_id)
                || explicit_quality_peers.contains(&peer_id)
                || !self.edges.contains_key(&peer_id)
            {
                continue;
            }

            visit(peer_id, DEFAULT_CONNECTED_PEER_COST_MS + penalty);
        }
    }

    fn reconstruct_path(prev: &HashMap<u32, u32>, from: u32, to: u32) -> Option<Vec<u32>> {
        if from == to {
            return Some(vec![from]);
        }

        let mut path = vec![to];
        let mut cur = to;
        loop {
            let parent = prev.get(&cur).copied()?;
            path.push(parent);
            cur = parent;
            if cur == from {
                break;
            }
        }
        path.reverse();
        Some(path)
    }

    fn compute_branch_backups(
        &self,
        for_edge_id: u32,
        primary_child: u32,
        config: &HubVoiceRoutingConfig,
    ) -> Vec<u32> {
        let (_, prev) =
            self.directed_dijkstra(for_edge_id, config, Some((for_edge_id, primary_child)));
        let Some(path) = Self::reconstruct_path(&prev, for_edge_id, primary_child) else {
            return Vec::new();
        };
        if path.len() < 2 {
            return Vec::new();
        }

        let first_hop = path[1];
        if first_hop == primary_child || first_hop == for_edge_id {
            return Vec::new();
        }

        vec![first_hop]
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_DIRECT_TCP_COST_MS, LinkQuality, PACKET_LOSS_PENALTY_MS, TopologyEdge,
        TopologyManager,
    };
    use munode_common::config::HubVoiceRoutingConfig;
    use std::collections::HashSet;
    use std::time::Instant;

    fn edge(edge_id: u32) -> TopologyEdge {
        TopologyEdge {
            edge_id,
            name: format!("edge-{edge_id}"),
            host: "127.0.0.1".into(),
            port: 64_738 + edge_id,
            voice_port: 65_738 + edge_id,
            peer_endpoints: Vec::new(),
            capacity: 128,
            joined_at: Instant::now(),
            connected_peers: HashSet::new(),
        }
    }

    fn quality(rtt_ms: f64) -> LinkQuality {
        LinkQuality {
            rtt_ms,
            packet_loss: 0.0,
            jitter_ms: 0.0,
            samples: 10,
            last_update: Instant::now(),
        }
    }

    #[test]
    fn dissemination_plans_follow_directed_edges() {
        let mut topo = TopologyManager::new();
        topo.add_edge(edge(1));
        topo.add_edge(edge(2));
        topo.add_edge(edge(3));

        topo.report_quality(1, 2, "edge-2".into(), 64740, quality(10.0));
        topo.report_quality(2, 3, "edge-3".into(), 64741, quality(10.0));

        let config = HubVoiceRoutingConfig {
            relay_hop_penalty_ms: 0.0,
            ..HubVoiceRoutingConfig::default()
        };

        let edge1_source1 = topo
            .compute_dissemination_plan(1, &config)
            .into_iter()
            .find(|plan| plan.source_edge_id == 1)
            .expect("missing source=1 plan for edge 1");
        assert_eq!(edge1_source1.active_children, vec![2]);

        let edge2_source1 = topo
            .compute_dissemination_plan(2, &config)
            .into_iter()
            .find(|plan| plan.source_edge_id == 1)
            .expect("missing source=1 plan for edge 2");
        assert_eq!(edge2_source1.active_children, vec![3]);

        let edge3_source1 = topo
            .compute_dissemination_plan(3, &config)
            .into_iter()
            .find(|plan| plan.source_edge_id == 1)
            .expect("missing source=1 plan for edge 3");
        assert!(edge3_source1.active_children.is_empty());
    }

    #[test]
    fn full_loss_report_penalizes_udp_without_making_tcp_artificially_free() {
        let mut topo = TopologyManager::new();
        topo.add_edge(edge(1));
        topo.add_edge(edge(2));

        topo.report_quality(
            1,
            2,
            "edge-2".into(),
            64740,
            LinkQuality {
                rtt_ms: 0.0,
                packet_loss: 1.0,
                jitter_ms: 0.0,
                samples: 30,
                last_update: Instant::now(),
            },
        );

        let routes = topo.compute_route_table(1, &HubVoiceRoutingConfig::default());
        let mut direct_udp_cost = None;
        let mut direct_tcp_cost = None;
        let mut hub_tcp_cost = None;

        for (target_id, route_type, _, cost) in routes {
            if target_id != 2 {
                continue;
            }
            match route_type {
                0 => direct_udp_cost = Some(cost),
                2 => hub_tcp_cost = Some(cost),
                3 => direct_tcp_cost = Some(cost),
                _ => {}
            }
        }

        assert_eq!(direct_udp_cost, Some(PACKET_LOSS_PENALTY_MS as f32));
        assert_eq!(direct_tcp_cost, Some(DEFAULT_DIRECT_TCP_COST_MS));
        assert!(hub_tcp_cost.unwrap_or_default() > direct_tcp_cost.unwrap_or_default());
    }

    #[test]
    fn failed_quality_edge_is_not_reintroduced_via_connected_peer_fallback() {
        let mut topo = TopologyManager::new();
        topo.add_edge(edge(1));
        topo.add_edge(edge(2));
        topo.add_edge(edge(4));

        topo.mark_join_complete(1, vec![2, 4]);
        topo.mark_join_complete(2, vec![1, 4]);
        topo.mark_join_complete(4, vec![1, 2]);

        let config = HubVoiceRoutingConfig {
            relay_hop_penalty_ms: 0.0,
            failed_packet_loss: 0.4,
            ..HubVoiceRoutingConfig::default()
        };

        topo.report_quality(
            4,
            1,
            "edge-1".into(),
            64739,
            LinkQuality {
                rtt_ms: 10.0,
                packet_loss: 0.9,
                jitter_ms: 0.0,
                samples: 30,
                last_update: Instant::now(),
            },
        );
        topo.report_quality(4, 2, "edge-2".into(), 64740, quality(10.0));
        topo.report_quality(2, 1, "edge-1".into(), 64739, quality(10.0));

        let edge4_source4 = topo
            .compute_dissemination_plan(4, &config)
            .into_iter()
            .find(|plan| plan.source_edge_id == 4)
            .expect("missing source=4 plan for edge 4");
        assert_eq!(
            edge4_source4.active_children,
            vec![2],
            "failed direct edge 4->1 must not stay in the primary dissemination tree"
        );

        let edge2_source4 = topo
            .compute_dissemination_plan(2, &config)
            .into_iter()
            .find(|plan| plan.source_edge_id == 4)
            .expect("missing source=4 plan for edge 2");
        assert_eq!(
            edge2_source4.active_children,
            vec![1],
            "backup hop 2 must become the actual forwarding parent for edge 1"
        );
    }
}
