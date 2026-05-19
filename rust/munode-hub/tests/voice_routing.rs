//! Integration tests for the voice routing redesign — Hub side.
//!
//! These tests exercise the full [`TopologyManager`] routing pipeline:
//! Dijkstra path selection, `compute_route_table` candidate generation,
//! partition detection, and disconnect arbitration.  They run against the
//! crate's public API only — no internal modules are accessed.
//!
//! Run with:
//!   cargo test -p munode-hub --test voice_routing

use std::collections::HashSet;
use std::time::Instant;

use munode_common::config::HubVoiceRoutingConfig;
use munode_hub::topology_manager::{ArbitrationResult, LinkQuality, TopologyEdge, TopologyManager};

// ── Helpers ──────────────────────────────────────────────────────────────────

fn make_edge(id: u32) -> TopologyEdge {
    TopologyEdge {
        edge_id: id,
        name: format!("edge-{id}"),
        host: format!("10.0.0.{id}"),
        port: 64000 + id,
        voice_port: 64001 + id,
        capacity: 100,
        joined_at: Instant::now(),
        connected_peers: HashSet::new(),
    }
}

fn make_quality(rtt_ms: f64, packet_loss: f64) -> LinkQuality {
    LinkQuality {
        rtt_ms,
        packet_loss,
        jitter_ms: 0.0,
        samples: 10,
        last_update: Instant::now(),
    }
}

// ── Edge lifecycle ────────────────────────────────────────────────────────────

/// `edge_count()` must reflect every `add_edge` / `remove_edge` call.
#[test]
fn edge_count_tracks_add_and_remove() {
    let mut topo = TopologyManager::new();
    assert_eq!(topo.edge_count(), 0);
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    assert_eq!(topo.edge_count(), 2);
    topo.remove_edge(1);
    assert_eq!(topo.edge_count(), 1, "count must drop after removal");
    topo.remove_edge(99); // non-existent: no-op
    assert_eq!(topo.edge_count(), 1);
}

/// `get_peers_of(id)` must return all edges except `id` itself.
#[test]
fn get_peers_of_excludes_self() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));

    let peers: Vec<u32> = topo
        .get_peers_of(1)
        .into_iter()
        .map(|e| e.edge_id)
        .collect();
    assert!(!peers.contains(&1), "get_peers_of must not include self");
    assert_eq!(peers.len(), 2, "must return the other 2 edges");
}

/// `remove_edge` must delete all link quality entries that involve the removed edge
/// so that stale quality data does not influence future routing.
#[test]
fn remove_edge_cleans_up_link_quality() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));
    topo.report_quality(1, 2, make_quality(10.0, 0.0));
    topo.report_quality(2, 1, make_quality(10.0, 0.0));
    topo.report_quality(1, 3, make_quality(5.0, 0.0));
    topo.report_quality(3, 1, make_quality(5.0, 0.0));

    topo.remove_edge(1);

    // All quality entries referencing edge 1 must be gone.
    let qualities = topo.get_link_qualities();
    let involves_1 = qualities.keys().any(|(a, b)| *a == 1 || *b == 1);
    assert!(
        !involves_1,
        "link quality entries for removed edge must be purged"
    );
    // Quality between 2↔3 (if any) must be unaffected.
    // There was none, so the map should be empty.
    assert!(qualities.is_empty());
}

/// After `remove_edge`, the arbitration state referencing that edge must also be cleaned up.
#[test]
fn remove_edge_cleans_up_disconnect_reports() {
    let mut topo = TopologyManager::new();
    // Edge 1 reports that edge 2 disconnected, then we remove edge 2.
    topo.arbitrate_disconnect(1, 2); // edge 1 reports edge 2 gone
    topo.remove_edge(2); // Hub removes edge 2

    // Now if edge 1 re-reports edge 2 as disconnected, it should be a fresh first report.
    match topo.arbitrate_disconnect(1, 2) {
        ArbitrationResult::AwaitConfirmation => {}
        other => panic!("expected AwaitConfirmation after cleanup, got {other:?}"),
    }
}

// ── mark_join_complete ────────────────────────────────────────────────────────

/// `mark_join_complete` records the peer set.  `detect_partitions` uses `connected_peers`
/// (not just link-quality data) for union-find, so two edges with no link quality but
/// a confirmed join connection must appear in the same partition.
#[test]
fn mark_join_complete_enables_partition_detection_via_peer_connection() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(10));
    topo.add_edge(make_edge(20));
    // No link quality at all.  Without mark_join_complete these would be two
    // isolated nodes → two partitions.
    topo.mark_join_complete(10, vec![20]);

    let parts = topo.detect_partitions();
    assert_eq!(
        parts.len(),
        1,
        "connected_peers from mark_join_complete must merge the two nodes into one partition; got: {parts:?}"
    );
}

/// A node added with `add_edge` but never connected to anyone (no quality data,
/// no connected_peers) must appear as its own single-node partition.
#[test]
fn isolated_edge_is_its_own_partition() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    // 1 and 2 are connected
    topo.report_quality(1, 2, make_quality(10.0, 0.0));
    // 3 is completely isolated
    topo.add_edge(make_edge(3));

    let parts = topo.detect_partitions();
    assert_eq!(
        parts.len(),
        2,
        "isolated edge must form its own partition; got: {parts:?}"
    );
}

// ── Dijkstra path selection ───────────────────────────────────────────────────

/// Two edges with a direct link → path is always [from, to].
#[test]
fn direct_path_chosen_for_two_connected_edges() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.report_quality(1, 2, make_quality(20.0, 0.0));

    let path = topo.find_best_path(1, 2);
    assert_eq!(path, vec![1, 2], "direct path expected");
}

/// When the relay route 1→3→2 is cheaper than the degraded direct link 1→2,
/// `compute_route_table` must produce a `RelayChain` (type 1) candidate for
/// target 2 routing through edge 3.
#[test]
fn relay_path_preferred_when_direct_link_is_degraded() {
    // 1→2 direct: RTT=100ms, loss=10% → high cost.
    // 1→3→2 relay: each leg ~10ms, ~1% loss → low cost.
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));

    topo.report_quality(1, 2, make_quality(100.0, 0.10));
    topo.report_quality(1, 3, make_quality(10.0, 0.01));
    topo.report_quality(3, 2, make_quality(10.0, 0.01));
    // symmetric
    topo.report_quality(2, 1, make_quality(100.0, 0.10));
    topo.report_quality(3, 1, make_quality(10.0, 0.01));
    topo.report_quality(2, 3, make_quality(10.0, 0.01));

    let cfg = HubVoiceRoutingConfig::default();
    let routes = topo.compute_route_table(1, &cfg);

    // The primary (lowest cost) candidate for target 2 should be a relay via edge 3.
    // route_type 1 = RelayChain
    let relay_to_2 = routes
        .iter()
        .find(|(target, rtype, chain, _)| *target == 2 && *rtype == 1 && chain.contains(&3));
    assert!(
        relay_to_2.is_some(),
        "relay via edge 3 should be in route table; got: {routes:?}"
    );
}

/// A link above the `failed_packet_loss` threshold must be excluded from path
/// calculation, forcing `compute_route_table` to produce a relay chain through
/// the healthy alternative route.
#[test]
fn failed_link_is_excluded_from_dijkstra_path() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));

    let mut cfg = HubVoiceRoutingConfig::default();
    cfg.failed_packet_loss = 0.5;

    topo.report_quality(1, 2, make_quality(20.0, 0.60)); // FAILED: above 50%
    topo.report_quality(1, 3, make_quality(10.0, 0.01));
    topo.report_quality(3, 2, make_quality(10.0, 0.01));
    topo.report_quality(3, 1, make_quality(10.0, 0.01));
    topo.report_quality(2, 3, make_quality(10.0, 0.01));

    let routes = topo.compute_route_table(1, &cfg);

    // Direct 1→2 is failed; the route table should contain a relay chain via 3.
    // route_type 1 = RelayChain
    let relay_via_3 = routes
        .iter()
        .any(|(target, rtype, chain, _)| *target == 2 && *rtype == 1 && chain.contains(&3));
    assert!(
        relay_via_3,
        "relay via edge 3 must be present because direct link is failed; got: {routes:?}"
    );
}

/// A link whose RTT exceeds `failed_rtt_ms` must be excluded from the Dijkstra
/// graph (same as a high-loss link), so that a slower but healthier relay path
/// is preferred.
#[test]
fn high_rtt_link_excluded_by_failed_rtt_threshold() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));

    let mut cfg = HubVoiceRoutingConfig::default();
    cfg.failed_rtt_ms = 100.0; // anything above 100ms is considered failed

    // Direct 1→2: RTT=200ms (zero loss but RTT > failed_rtt_ms) → failed
    topo.report_quality(1, 2, make_quality(200.0, 0.0));
    // Good legs via 3
    topo.report_quality(1, 3, make_quality(20.0, 0.0));
    topo.report_quality(3, 2, make_quality(20.0, 0.0));
    topo.report_quality(3, 1, make_quality(20.0, 0.0));
    topo.report_quality(2, 3, make_quality(20.0, 0.0));

    let routes = topo.compute_route_table(1, &cfg);

    let relay_via_3 = routes
        .iter()
        .any(|(target, rtype, chain, _)| *target == 2 && *rtype == 1 && chain.contains(&3));
    assert!(
        relay_via_3,
        "relay via edge 3 must be chosen when direct link exceeds failed_rtt_ms; got: {routes:?}"
    );
}

/// `relay_hop_penalty_ms` is added to the cost of each link when using
/// `compute_route_table`.  A route with fewer hops should be preferred over a
/// longer one even when the shorter route has slightly higher RTT, because the
/// per-hop penalty adds up.
#[test]
fn relay_hop_penalty_discourages_longer_chains() {
    // Topology:
    //   1 —(25ms, 0)— 2      direct: 25 + 0 + penalty×1
    //   1 —(5ms)— 3 —(5ms)— 2   relay: (5+5) + 0 + penalty×2
    //
    // With a large penalty (e.g. 30ms/hop), the relay path (30+30+10=70ms total)
    // costs more than the direct path (25+30=55ms), so direct is preferred.
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));

    topo.report_quality(1, 2, make_quality(25.0, 0.0));
    topo.report_quality(2, 1, make_quality(25.0, 0.0));
    topo.report_quality(1, 3, make_quality(5.0, 0.0));
    topo.report_quality(3, 1, make_quality(5.0, 0.0));
    topo.report_quality(3, 2, make_quality(5.0, 0.0));
    topo.report_quality(2, 3, make_quality(5.0, 0.0));

    let mut cfg = HubVoiceRoutingConfig::default();
    cfg.relay_hop_penalty_ms = 30.0; // Large penalty per hop

    let path = topo.find_best_path(1, 2);
    // With default find_best_path (no per-hop penalty), relay might look cheaper.
    // With relay_hop_penalty, compute_route_table should prefer direct.
    let routes = topo.compute_route_table(1, &cfg);

    // DirectUdp candidate (type 0, empty chain) for target 2 must be present.
    let has_direct = routes
        .iter()
        .any(|(t, rtype, chain, _)| *t == 2 && *rtype == 0 && chain.is_empty());
    assert!(
        has_direct,
        "direct path must exist in route table; got: {routes:?}"
    );

    // The FIRST candidate (best cost) for target 2 should NOT be a relay chain
    // when hop penalty makes relay more expensive.
    let first_for_2 = routes.iter().find(|(t, _, _, _)| *t == 2);
    if let Some((_, rtype, _, _)) = first_for_2 {
        // Direct (0) should come before relay (1)
        assert_ne!(
            *rtype, 1,
            "first/cheapest candidate must not be a relay chain when hop penalty is large; got: {routes:?}"
        );
    }

    // find_best_path uses the no-config version which does no per-hop penalty.
    // Both 1→2 and 1→3→2 are reachable; we only verify the output is a valid path.
    assert!(
        path.first() == Some(&1) && path.last() == Some(&2),
        "path must start at 1 and end at 2; got: {path:?}"
    );
}

// ── compute_route_table candidate types ──────────────────────────────────────

/// The route table must always contain a `HubTcp` candidate (type 2) for every
/// target, so the Edge can fall back to Hub relay as a last resort.
#[test]
fn route_table_always_includes_hub_tcp_fallback() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.report_quality(1, 2, make_quality(30.0, 0.0));

    let routes = topo.compute_route_table(1, &HubVoiceRoutingConfig::default());

    // route_type 2 = HubTcp
    let has_hub_tcp = routes
        .iter()
        .any(|(target, rtype, chain, _)| *target == 2 && *rtype == 2 && chain.is_empty());
    assert!(
        has_hub_tcp,
        "HubTcp candidate must always be emitted; got: {routes:?}"
    );
}

/// The route table must always include a `DirectTcp` candidate (type 3) for every
/// target, allowing Edges to prefer TCP when UDP is degraded.
#[test]
fn route_table_always_includes_direct_tcp_candidate() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.report_quality(1, 2, make_quality(30.0, 0.0));

    let routes = topo.compute_route_table(1, &HubVoiceRoutingConfig::default());

    // route_type 3 = DirectTcp
    let has_direct_tcp = routes
        .iter()
        .any(|(target, rtype, _, _)| *target == 2 && *rtype == 3);
    assert!(
        has_direct_tcp,
        "DirectTcp candidate must always be emitted; got: {routes:?}"
    );
}

/// HubTcp must remain more expensive than DirectTcp for the same target so the
/// Edge only prefers hub relay as a last resort after sorting by cost.
#[test]
fn hub_tcp_cost_sorts_after_direct_tcp() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.report_quality(1, 2, make_quality(100.0, 0.0));

    let routes = topo.compute_route_table(1, &HubVoiceRoutingConfig::default());
    let direct_tcp_cost = routes
        .iter()
        .find_map(|(target, route_type, _, cost)| {
            (*target == 2 && *route_type == 3).then_some(*cost)
        })
        .expect("missing DirectTcp candidate");
    let hub_tcp_cost = routes
        .iter()
        .find_map(|(target, route_type, _, cost)| {
            (*target == 2 && *route_type == 2).then_some(*cost)
        })
        .expect("missing HubTcp candidate");

    assert!(
        hub_tcp_cost > direct_tcp_cost,
        "HubTcp must stay behind DirectTcp in cost ordering; got direct_tcp={direct_tcp_cost}, hub_tcp={hub_tcp_cost}, routes={routes:?}"
    );
}

/// When a direct link is available with acceptable quality, the table must contain
/// a `DirectUdp` candidate (type 0) for that target.
#[test]
fn route_table_has_direct_udp_for_good_link() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.report_quality(1, 2, make_quality(15.0, 0.01));

    let routes = topo.compute_route_table(1, &HubVoiceRoutingConfig::default());

    // route_type 0 = DirectUdp
    let has_direct_udp = routes
        .iter()
        .any(|(target, rtype, chain, _)| *target == 2 && *rtype == 0 && chain.is_empty());
    assert!(
        has_direct_udp,
        "DirectUdp candidate must be present for a good link; got: {routes:?}"
    );
}

/// The DirectUdp cost must equal `rtt_ms + loss * 500` for the direct link.
#[test]
fn route_table_direct_udp_cost_equals_rtt_plus_loss_penalty() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    // rtt=40ms, loss=10% → cost = 40 + 0.10×500 = 90ms
    topo.report_quality(1, 2, make_quality(40.0, 0.10));

    let routes = topo.compute_route_table(1, &HubVoiceRoutingConfig::default());

    let direct_cost = routes
        .iter()
        .find(|(t, rtype, chain, _)| *t == 2 && *rtype == 0 && chain.is_empty())
        .map(|(_, _, _, cost)| *cost);

    assert!(
        direct_cost.is_some(),
        "DirectUdp entry missing; got: {routes:?}"
    );
    let cost = direct_cost.unwrap();
    let expected = 40.0_f32 + 0.10_f32 * 500.0_f32; // 90.0
    assert!(
        (cost - expected).abs() < 0.01,
        "DirectUdp cost should be ~{expected:.1} but got {cost:.1}"
    );
}

/// When the cheapest path uses a relay node, the table must contain a `RelayChain`
/// candidate (type 1) naming the intermediate Edge.
#[test]
fn route_table_has_relay_chain_for_three_edge_topology() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1)); // A
    topo.add_edge(make_edge(2)); // B — target
    topo.add_edge(make_edge(3)); // C — relay

    let mut cfg = HubVoiceRoutingConfig::default();
    cfg.failed_packet_loss = 0.5;

    // A→B direct link is failed
    topo.report_quality(1, 2, make_quality(20.0, 0.60));
    // Good legs via C
    topo.report_quality(1, 3, make_quality(10.0, 0.0));
    topo.report_quality(3, 1, make_quality(10.0, 0.0));
    topo.report_quality(3, 2, make_quality(10.0, 0.0));
    topo.report_quality(2, 3, make_quality(10.0, 0.0));

    let routes = topo.compute_route_table(1, &cfg);

    // route_type 1 = RelayChain with intermediate = [3]
    let relay_via_3 = routes
        .iter()
        .any(|(target, rtype, chain, _)| *target == 2 && *rtype == 1 && chain.contains(&3));
    assert!(
        relay_via_3,
        "RelayChain via edge 3 must be present; got: {routes:?}"
    );
}

/// Relay chains longer than `max_relay_hops` must be replaced with `HubTcp` (type 2).
#[test]
fn relay_chain_exceeding_hop_limit_falls_back_to_hub_tcp() {
    // Build a linear chain 1→2→3→4→5.
    // With max_relay_hops=2 the path 1→2→3→4→5 has 3 relay hops → too long → HubTcp.
    let mut topo = TopologyManager::new();
    for i in 1u32..=5 {
        topo.add_edge(make_edge(i));
    }

    let mut cfg = HubVoiceRoutingConfig::default();
    cfg.failed_packet_loss = 0.5;
    cfg.max_relay_hops = 2;

    // Direct 1→5 is failed; only path is via the chain.
    topo.report_quality(1, 5, make_quality(500.0, 0.90));
    for (a, b) in [(1u32, 2u32), (2, 3), (3, 4), (4, 5)] {
        topo.report_quality(a, b, make_quality(5.0, 0.0));
        topo.report_quality(b, a, make_quality(5.0, 0.0));
    }

    let routes = topo.compute_route_table(1, &cfg);

    // For target 5, there should be a HubTcp (type 2) entry with an empty chain.
    let hub_tcp_for_5 = routes
        .iter()
        .any(|(target, rtype, chain, _)| *target == 5 && *rtype == 2 && chain.is_empty());
    assert!(
        hub_tcp_for_5,
        "long relay chain should produce HubTcp for target 5; got: {routes:?}"
    );
}

/// When there is no link quality data at all for a target, the route table must
/// still include all three candidate types (DirectUdp, DirectTcp, HubTcp) with
/// default costs, so the Edge always has fallback options.
#[test]
fn no_quality_data_produces_full_candidate_set_with_defaults() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    // Intentionally no report_quality calls.

    let routes = topo.compute_route_table(1, &HubVoiceRoutingConfig::default());

    // DirectUdp (type 0) must be present
    assert!(
        routes.iter().any(|(t, rt, _, _)| *t == 2 && *rt == 0),
        "DirectUdp must be present even without quality data; got: {routes:?}"
    );
    // DirectTcp (type 3) must be present
    assert!(
        routes.iter().any(|(t, rt, _, _)| *t == 2 && *rt == 3),
        "DirectTcp must be present even without quality data; got: {routes:?}"
    );
    // HubTcp (type 2) must be present
    assert!(
        routes.iter().any(|(t, rt, _, _)| *t == 2 && *rt == 2),
        "HubTcp must be present even without quality data; got: {routes:?}"
    );
}

// ── Partition detection ───────────────────────────────────────────────────────

/// A fully connected topology is a single partition.
#[test]
fn fully_connected_cluster_is_one_partition() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));
    topo.report_quality(1, 2, make_quality(10.0, 0.0));
    topo.report_quality(2, 3, make_quality(10.0, 0.0));

    let parts = topo.detect_partitions();
    assert_eq!(parts.len(), 1, "one partition expected; got: {parts:?}");
}

/// Two disconnected edge groups must be reported as two separate partitions.
#[test]
fn isolated_edge_groups_detected_as_two_partitions() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));
    topo.add_edge(make_edge(4));
    // {1,2} and {3,4} are isolated islands
    topo.report_quality(1, 2, make_quality(10.0, 0.0));
    topo.report_quality(3, 4, make_quality(10.0, 0.0));

    let parts = topo.detect_partitions();
    assert_eq!(parts.len(), 2, "two partitions expected; got: {parts:?}");
}

/// Partition shutdown arbitration must pick the partition with fewer users,
/// not simply the one with fewer edges.
#[test]
fn partitions_are_sorted_by_aggregated_user_count() {
    let mut topo = TopologyManager::new();
    topo.add_edge(make_edge(1));
    topo.add_edge(make_edge(2));
    topo.add_edge(make_edge(3));

    // Partition A = {1,2} with 1 total user.
    topo.report_quality(1, 2, make_quality(10.0, 0.0));
    // Partition B = {3} with 5 total users.

    let users_per_edge = std::collections::HashMap::from([(1, 1usize), (2, 0usize), (3, 5usize)]);

    let sorted = topo.partitions_by_user_count(&users_per_edge);
    assert_eq!(
        sorted.len(),
        2,
        "two sorted partitions expected; got: {sorted:?}"
    );

    let (smallest_partition, smallest_users) = &sorted[0];
    assert_eq!(*smallest_users, 1, "smallest partition should have 1 user");
    assert_eq!(
        smallest_partition.len(),
        2,
        "the chosen partition may still have more edges"
    );
    assert!(smallest_partition.contains(&1) && smallest_partition.contains(&2));

    let (largest_partition, largest_users) = &sorted[1];
    assert_eq!(*largest_users, 5);
    assert_eq!(largest_partition.len(), 1);
    assert!(largest_partition.contains(&3));
}

// ── Disconnect arbitration ────────────────────────────────────────────────────

/// When only one side reports a disconnect, the manager awaits confirmation.
#[test]
fn single_disconnect_report_awaits_confirmation() {
    let mut topo = TopologyManager::new();
    match topo.arbitrate_disconnect(1, 2) {
        ArbitrationResult::AwaitConfirmation => {}
        other => panic!("expected AwaitConfirmation, got {other:?}"),
    }
}

/// When both sides report the same disconnect, the manager confirms it.
#[test]
fn both_sides_reporting_disconnect_confirms_it() {
    let mut topo = TopologyManager::new();
    topo.arbitrate_disconnect(1, 2);
    match topo.arbitrate_disconnect(2, 1) {
        ArbitrationResult::BothReported { edge_id: 1 } => {}
        other => panic!("expected BothReported{{edge_id: 1}}, got {other:?}"),
    }
}
