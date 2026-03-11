use std::collections::{BinaryHeap, HashMap, HashSet};
use std::cmp::Reverse;
use std::time::Instant;

use tracing::{debug, info, warn};

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
        // Weight = rtt_ms + packet_loss * 500.0 (penalise lossy links)
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

                let link_weight = quality.rtt_ms + quality.packet_loss * 500.0;
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

        fn find(parent: &mut HashMap<u32, u32>, x: u32) -> u32 {
            let p = *parent.get(&x).unwrap_or(&x);
            if p != x {
                let root = find(parent, p);
                parent.insert(x, root);
                root
            } else {
                x
            }
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
}
