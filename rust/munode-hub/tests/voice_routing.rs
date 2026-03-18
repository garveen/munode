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
    let relay_to_2 = routes.iter().find(|(target, rtype, chain, _)| {
        *target == 2 && *rtype == 1 && chain.contains(&3)
    });
    assert!(relay_to_2.is_some(), "relay via edge 3 should be in route table; got: {routes:?}");
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
    let relay_via_3 = routes.iter().any(|(target, rtype, chain, _)| {
        *target == 2 && *rtype == 1 && chain.contains(&3)
    });
    assert!(relay_via_3, "relay via edge 3 must be present because direct link is failed; got: {routes:?}");
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
    let has_hub_tcp = routes.iter().any(|(target, rtype, chain, _)| {
        *target == 2 && *rtype == 2 && chain.is_empty()
    });
    assert!(has_hub_tcp, "HubTcp candidate must always be emitted; got: {routes:?}");
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
    let has_direct_tcp = routes.iter().any(|(target, rtype, _, _)| {
        *target == 2 && *rtype == 3
    });
    assert!(has_direct_tcp, "DirectTcp candidate must always be emitted; got: {routes:?}");
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
    let has_direct_udp = routes.iter().any(|(target, rtype, chain, _)| {
        *target == 2 && *rtype == 0 && chain.is_empty()
    });
    assert!(has_direct_udp, "DirectUdp candidate must be present for a good link; got: {routes:?}");
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
    let relay_via_3 = routes.iter().any(|(target, rtype, chain, _)| {
        *target == 2 && *rtype == 1 && chain.contains(&3)
    });
    assert!(relay_via_3, "RelayChain via edge 3 must be present; got: {routes:?}");
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
    let hub_tcp_for_5 = routes.iter().any(|(target, rtype, chain, _)| {
        *target == 5 && *rtype == 2 && chain.is_empty()
    });
    assert!(
        hub_tcp_for_5,
        "long relay chain should produce HubTcp for target 5; got: {routes:?}"
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
