//! Integration tests for the voice routing redesign — Edge side.
//!
//! These tests cover:
//!
//! - **PeerRegistry** — upsert / remove / relay_peers / all_udp_peers.
//! - **RouteDecision / RouteCandidate** — route_table population and lookup.
//! - **DirectTcp** — voice frames tunnelled over the `/voice` WebSocket endpoint.
//! - **DirectUdp with degradation** — simulated packet-loss via `test_udp_drop_rate`.
//! - **EDGE_PKT_RELAY wire format** — relay packet byte layout verification.
//! - **consecutive_failure_threshold** — threshold=0 does not reset failures.
//!
//! All tests use real OS sockets (TCP or UDP) with OS-assigned ports
//! (`127.0.0.1:0`) so they work in any environment without port-conflict risks.
//!
//! **Requires the `test-utils` feature:**
//!   cargo test -p munode-edge --features test-utils --test voice_routing

#![cfg(feature = "test-utils")]

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use futures_util::SinkExt;
use tokio::net::{TcpListener, UdpSocket};

use munode_common::config::{
    EdgeConfig, EdgeVoiceRoutingConfig, EdgeWebApiConfig, HubServerConfig, NetworkConfig,
    ServerConfig, TlsConfig, WebtransportConfig,
};
use munode_edge::channel_manager::ChannelManager;
use munode_edge::client::ClientManager;
use munode_edge::cluster_voice::forward_source_voice_packet;
use munode_edge::hub_client::HubClient;
use munode_edge::peer_registry::{PeerEdgeInfo, PeerRegistry, PeerVoiceTcpPool};
use munode_edge::relay_server::{connect_peer_voice_tcp, run_edge_ws_server_with_listener};
use munode_edge::state::{
    DisseminationSourceState, EdgeState, EdgeStateConfig, HopTransport, RouteCandidate,
    RouteDecision,
};
use munode_edge::udp::{test_route_to_edge, test_send_relay_packet};

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Bind a random TCP port and return the listener and its local port.
async fn tcp_listener_on_random_port() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind TCP listener");
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

/// Bind a random UDP socket and return it together with its local address.
async fn udp_socket_on_random_port() -> (Arc<UdpSocket>, SocketAddr) {
    let sock = Arc::new(
        UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind UDP socket"),
    );
    let addr = sock.local_addr().unwrap();
    (sock, addr)
}

/// Build a fresh `EdgeState` (default config: hub_tcp_fallback=false, threshold=2).
fn fresh_edge_state() -> Arc<EdgeState> {
    EdgeState::new(ChannelManager::new(), ClientManager::new(), false)
}

/// Build a fresh `EdgeState` with `consecutive_failure_threshold = 0`.
fn edge_state_with_zero_failure_threshold() -> Arc<EdgeState> {
    EdgeState::new_with_full_config(
        ChannelManager::new(),
        ClientManager::new(),
        EdgeStateConfig {
            enable_hub_tcp_fallback: false,
            consecutive_failure_threshold: 0,
            listeners_per_user: 0,
            listeners_per_channel: 0,
            allow_ping: true,
            rolling_stats_window: 120,
            hmac_secret: None,
            peer_voice_tcp_pool_size: 1,
            peer_quality_sample_window_size: 32,
            peer_quality_probe_timeout_secs: 3,
        },
    )
}

fn test_config() -> EdgeConfig {
    EdgeConfig {
        server_id: 1,
        name: "test".to_string(),
        network: NetworkConfig {
            host: "127.0.0.1".to_string(),
            port: 64738,
            edge_port: None,
            external_host: "127.0.0.1".to_string(),
            external_port: None,
            region: None,
            proxy_protocol: false,
            trusted_proxy_ips: Vec::new(),
        },
        tls: TlsConfig {
            cert: "test.pem".to_string(),
            key: "test.key".to_string(),
            ca: None,
        },
        hub_server: HubServerConfig {
            host: "localhost".to_string(),
            control_port: 8080,
            reconnect_interval: 5000,
            heartbeat_interval: 10000,
            hmac_secret: None,
            pool_size: 1,
            static_peers: vec![],
            tls: false,
        },
        server: ServerConfig::default(),
        voice_routing: EdgeVoiceRoutingConfig::default(),
        web_api: EdgeWebApiConfig::default(),
        webtransport: WebtransportConfig::default(),
        log_level: "info".to_string(),
        log_format: "text".to_string(),
        cluster_peer_access: Vec::new(),
    }
}

/// Spawn the combined relay+voice WebSocket server on a random port.
/// Returns `(port, server_state)`.
async fn start_voice_ws_server() -> (u16, Arc<EdgeState>) {
    let state = fresh_edge_state();
    let (listener, port) = tcp_listener_on_random_port().await;
    let hub_client = HubClient::new(&test_config(), state.clone());

    let server_state = state.clone();
    tokio::spawn(async move {
        // Hub host/port are unused because tests only exercise the /voice path.
        run_edge_ws_server_with_listener(
            listener,
            "127.0.0.1".to_string(),
            0,
            None,
            server_state,
            hub_client,
        )
        .await;
    });

    // Give the accept loop a moment to start.
    tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
    (port, state)
}

// ── PeerRegistry ─────────────────────────────────────────────────────────────

/// `upsert` and `get` must round-trip correctly for both fields of `PeerEdgeInfo`.
#[test]
fn peer_registry_upsert_and_lookup_by_id() {
    let mut reg = PeerRegistry::default();
    let addr: SocketAddr = "10.0.0.2:64000".parse().unwrap();
    reg.upsert(
        7,
        PeerEdgeInfo {
            udp_addr: addr,
            host: "10.0.0.2".into(),
            relay_port: Some(64100),
            endpoints: Vec::new(),
        },
    );

    let info = reg.get(7).expect("entry must exist after upsert");
    assert_eq!(info.udp_addr, addr);
    assert_eq!(info.host, "10.0.0.2");
    assert_eq!(info.relay_port, Some(64100));
}

/// After `remove`, the entry must not be retrievable.
#[test]
fn peer_registry_remove_clears_entry() {
    let mut reg = PeerRegistry::default();
    let addr: SocketAddr = "10.0.0.3:64001".parse().unwrap();
    reg.upsert(
        8,
        PeerEdgeInfo {
            udp_addr: addr,
            host: "10.0.0.3".into(),
            relay_port: None,
            endpoints: Vec::new(),
        },
    );
    reg.remove(8);

    assert!(reg.get(8).is_none(), "entry must be absent after remove");
}

/// `relay_peers()` must only return entries that have a `relay_port` set.
#[test]
fn peer_registry_relay_peers_filters_by_relay_port() {
    let mut reg = PeerRegistry::default();
    let addr: SocketAddr = "10.0.0.4:64002".parse().unwrap();
    // Has relay_port
    reg.upsert(
        10,
        PeerEdgeInfo {
            udp_addr: addr,
            host: "10.0.0.4".into(),
            relay_port: Some(9000),
            endpoints: Vec::new(),
        },
    );
    // No relay_port
    reg.upsert(
        11,
        PeerEdgeInfo {
            udp_addr: addr,
            host: "10.0.0.5".into(),
            relay_port: None,
            endpoints: Vec::new(),
        },
    );

    let relay_peers = reg.relay_peers();
    assert_eq!(relay_peers.len(), 1, "only one peer has a relay_port");
    let (id, host, port) = &relay_peers[0];
    assert_eq!(*id, 10);
    assert_eq!(host, "10.0.0.4");
    assert_eq!(*port, 9000u16);
}

/// `all_udp_peers()` must return every registered entry (regardless of relay_port).
#[test]
fn peer_registry_all_udp_peers_returns_all_entries() {
    let mut reg = PeerRegistry::default();
    let a1: SocketAddr = "10.0.0.1:1000".parse().unwrap();
    let a2: SocketAddr = "10.0.0.2:2000".parse().unwrap();
    let a3: SocketAddr = "10.0.0.3:3000".parse().unwrap();
    reg.upsert(
        1,
        PeerEdgeInfo {
            udp_addr: a1,
            host: "h1".into(),
            relay_port: Some(9001),
            endpoints: Vec::new(),
        },
    );
    reg.upsert(
        2,
        PeerEdgeInfo {
            udp_addr: a2,
            host: "h2".into(),
            relay_port: None,
            endpoints: Vec::new(),
        },
    );
    reg.upsert(
        3,
        PeerEdgeInfo {
            udp_addr: a3,
            host: "h3".into(),
            relay_port: None,
            endpoints: Vec::new(),
        },
    );

    let all = reg.all_udp_peers();
    let ids: HashSet<u32> = all.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, HashSet::from([1, 2, 3]));
}

// ── RouteDecision / RouteCandidate / route_table ──────────────────────────────

/// The `route_table` field on `EdgeState` must accept `RouteCandidate` entries and
/// allow them to be read back, including all `RouteDecision` variants.
#[tokio::test]
async fn route_table_accepts_all_route_decision_variants() {
    let state = fresh_edge_state();

    let candidates = vec![
        RouteCandidate {
            decision: RouteDecision::DirectUdp,
            cost: 10.0,
        },
        RouteCandidate {
            decision: RouteDecision::RelayChain {
                hops: vec![3, 4],
                transports: vec![HopTransport::Udp, HopTransport::Tcp],
            },
            cost: 50.0,
        },
        RouteCandidate {
            decision: RouteDecision::HubTcp,
            cost: 150.0,
        },
        RouteCandidate {
            decision: RouteDecision::DirectTcp,
            cost: 25.0,
        },
    ];

    {
        let mut table = state.route_table.load_full().as_ref().clone();
        table.insert(99, candidates);
        state.route_table.store(Arc::new(table));
    }

    let table = state.route_table.load();
    let entry = table.get(&99).expect("route table entry must exist");
    assert_eq!(entry.len(), 4);
    assert!(matches!(entry[0].decision, RouteDecision::DirectUdp));
    assert!(
        matches!(&entry[1].decision, RouteDecision::RelayChain { hops, .. } if hops == &[3, 4])
    );
    assert!(matches!(entry[2].decision, RouteDecision::HubTcp));
    assert!(matches!(entry[3].decision, RouteDecision::DirectTcp));
}

/// `HopTransport` variants must be comparable for equality (used in routing logic).
#[test]
fn hop_transport_variants_are_distinguishable() {
    assert_eq!(HopTransport::Udp, HopTransport::Udp);
    assert_eq!(HopTransport::Tcp, HopTransport::Tcp);
    assert_ne!(HopTransport::Udp, HopTransport::Tcp);
}

// ── TCP voice channel ─────────────────────────────────────────────────────────

/// A `/voice` connection should register as an incoming DirectTcp connection on
/// the server after the peer-edge handshake succeeds.
#[tokio::test]
async fn direct_tcp_voice_handshake_registers_incoming_connection() {
    let (port, server_state) = start_voice_ws_server().await;

    // Connect our own raw WebSocket client to /voice so we control the exact frame.
    let url = format!("ws://127.0.0.1:{port}/voice");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("WS connect to /voice");

    // Handshake: send our edge ID as 4-byte big-endian.
    let self_id: u32 = 42;
    ws.send(tokio_tungstenite::tungstenite::Message::Binary(
        bytes::Bytes::from(self_id.to_be_bytes().to_vec()),
    ))
    .await
    .unwrap();

    // Voice frame: [EDGE_PKT_VOICE=0x01][session_BE(4)][Opus header][sequence][audio]
    let session: u32 = 99_001;
    let mut frame = vec![0x01u8];
    frame.extend_from_slice(&session.to_be_bytes());
    frame.push(0x80); // Opus voice type, target = broadcast
    frame.push(0x01); // sequence varint = 1
    frame.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]); // dummy Opus payload

    ws.send(tokio_tungstenite::tungstenite::Message::Binary(
        bytes::Bytes::from(frame),
    ))
    .await
    .unwrap();

    let registered = tokio::time::timeout(tokio::time::Duration::from_secs(1), async {
        loop {
            let connected = {
                let guard = server_state.incoming_voice_tcp_connections.read().unwrap();
                guard.get(&self_id).copied() == Some(1)
            };
            if connected {
                return true;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        registered,
        "server must register one incoming voice TCP connection"
    );
}

/// `connect_peer_voice_tcp` must register a sender in `EdgeState::voice_tcp_conns`
/// so the routing layer can use the DirectTcp path.
#[tokio::test]
async fn connect_peer_voice_tcp_registers_sender_in_state() {
    let (port, _server_state) = start_voice_ws_server().await;

    let client_state = fresh_edge_state();
    client_state.edge_id.store(7, Ordering::Relaxed);

    let peer_edge_id = 99u32;

    // connect_peer_voice_tcp runs its own internal loop; we let it run once in
    // the background and then check the side-effect.
    let cs = client_state.clone();
    tokio::spawn(async move {
        connect_peer_voice_tcp(peer_edge_id, "127.0.0.1".to_string(), port, 7, cs, None).await;
    });

    // Retry until the pool has at least one live sender (or timeout).
    let registered = tokio::time::timeout(tokio::time::Duration::from_secs(2), async {
        loop {
            {
                let conns = client_state.voice_tcp_conns.load();
                if let Some(pool) = conns.get(&peer_edge_id)
                    && pool.has_live_sender()
                {
                    return true;
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        registered,
        "voice_tcp_conns must contain a live pool entry for the connected peer edge"
    );
}

/// A frame sent through the `voice_tcp_conns` pool should keep the DirectTcp
/// connection healthy on both sides.
#[tokio::test]
async fn voice_tcp_conn_send_keeps_connection_alive() {
    let (port, server_state) = start_voice_ws_server().await;

    let client_state = fresh_edge_state();
    client_state.edge_id.store(55, Ordering::Relaxed);
    let peer_edge_id = 200u32;

    let cs = client_state.clone();
    tokio::spawn(async move {
        connect_peer_voice_tcp(peer_edge_id, "127.0.0.1".to_string(), port, 55, cs, None).await;
    });

    // Wait for the pool to have at least one live sender.
    let registered = tokio::time::timeout(tokio::time::Duration::from_secs(2), async {
        loop {
            let conns = client_state.voice_tcp_conns.load();
            if let Some(pool) = conns.get(&peer_edge_id)
                && pool.has_live_sender()
            {
                return true;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        registered,
        "voice_tcp_conns pool must have a live sender before sending"
    );

    // Build and send a DirectTcp frame: [0x01][session_BE(4)][voice...]
    let session: u32 = 77_777;
    let mut frame = vec![0x01u8];
    frame.extend_from_slice(&session.to_be_bytes());
    frame.push(0x80); // Opus voice header
    frame.push(0x02); // sequence = 2
    frame.extend_from_slice(&[0xAA, 0xBB, 0xCC]);

    {
        let conns = client_state.voice_tcp_conns.load();
        let pool = conns.get(&peer_edge_id).expect("pool must exist");
        assert!(pool.try_send(frame), "try_send must succeed on a live pool");
    }

    let server_side_alive = tokio::time::timeout(tokio::time::Duration::from_secs(1), async {
        loop {
            let alive = {
                let guard = server_state.incoming_voice_tcp_connections.read().unwrap();
                guard.get(&55).copied().unwrap_or_default() >= 1
            };
            if alive {
                return true;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        server_side_alive,
        "sending over the pool should keep the server-side DirectTcp connection alive"
    );
}

// ── UDP routing with network degradation ─────────────────────────────────────

/// When `test_udp_drop_rate` is 0, every call to `test_route_to_edge` must send
/// the packet, the receiver must see it, and `next_hop_failures` must remain 0.
#[tokio::test]
async fn udp_voice_packet_delivered_on_healthy_link() {
    let edge_state = fresh_edge_state();
    let (sender_sock, _) = udp_socket_on_random_port().await;
    let (recv_sock, recv_addr) = udp_socket_on_random_port().await;

    let target_edge_id = 5u32;
    let session = 1001u32;
    let payload = b"hello-voice";

    let sent = test_route_to_edge(
        edge_state.clone(),
        sender_sock,
        target_edge_id,
        recv_addr,
        session,
        payload,
    )
    .await;

    assert!(sent, "packet should be sent on a healthy link");

    // Receive with a short timeout.
    let mut buf = vec![0u8; 256];
    let n = tokio::time::timeout(
        tokio::time::Duration::from_millis(200),
        recv_sock.recv(&mut buf),
    )
    .await
    .expect("timed out")
    .expect("recv error");

    // Wire format: [0x01][session_BE(4)][payload...]
    assert_eq!(buf[0], 0x01, "first byte must be EDGE_PKT_VOICE");
    assert_eq!(
        u32::from_be_bytes(buf[1..5].try_into().unwrap()),
        session,
        "session ID must be encoded correctly"
    );
    assert_eq!(&buf[5..n], payload, "payload must arrive intact");

    let failures = edge_state.next_hop_failures.read().unwrap();
    assert_eq!(
        failures
            .get(&target_edge_id)
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(0),
        0,
        "no failures should be recorded on a healthy link"
    );
}

/// With `test_udp_drop_rate = 100` every packet is artificially dropped.
/// After 100 calls the failure counter must equal 100 and no bytes should
/// have been received by the peer socket.
#[tokio::test]
async fn degraded_link_increments_failure_counter_and_drops_packets() {
    let edge_state = fresh_edge_state();
    // 100% drop rate
    edge_state.test_udp_drop_rate.store(100, Ordering::Relaxed);

    let (sender_sock, _) = udp_socket_on_random_port().await;
    let (recv_sock, recv_addr) = udp_socket_on_random_port().await;

    let target_edge_id = 42u32;
    let session = 2002u32;
    let payload = b"should-be-dropped";

    let batch = 100usize;
    let mut dropped = 0usize;
    for _ in 0..batch {
        let sent = test_route_to_edge(
            edge_state.clone(),
            sender_sock.clone(),
            target_edge_id,
            recv_addr,
            session,
            payload,
        )
        .await;
        if !sent {
            dropped += 1;
        }
    }

    // All packets should have been dropped (drop_rate=100%).
    assert_eq!(
        dropped, batch,
        "all packets must be dropped at 100% drop rate"
    );

    // Failure counter must equal the number of dropped packets.
    let failures = edge_state.next_hop_failures.read().unwrap();
    assert_eq!(
        failures
            .get(&target_edge_id)
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(0),
        batch as u32,
        "each dropped packet must increment next_hop_failures"
    );

    // The receiver socket should have received nothing (try_recv is non-blocking).
    let mut buf = vec![0u8; 64];
    match recv_sock.try_recv(&mut buf) {
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("receiver got {n} unexpected bytes"),
        Err(e) => panic!("unexpected recv error: {e}"),
    }
}

/// When `test_udp_drop_rate` is 0 (restored after degradation) packets flow
/// again and `next_hop_failures` is reset to 0 on success.
#[tokio::test]
async fn recovery_after_degradation_clears_failure_counter() {
    let edge_state = fresh_edge_state();
    let (sender_sock, _) = udp_socket_on_random_port().await;
    let (recv_sock, recv_addr) = udp_socket_on_random_port().await;

    let target_edge_id = 77u32;

    // Phase 1: degrade the link — force a failure into the counter.
    edge_state.test_udp_drop_rate.store(100, Ordering::Relaxed);
    test_route_to_edge(
        edge_state.clone(),
        sender_sock.clone(),
        target_edge_id,
        recv_addr,
        1u32,
        b"drop-me",
    )
    .await;

    {
        let failures = edge_state.next_hop_failures.read().unwrap();
        assert!(
            failures
                .get(&target_edge_id)
                .map(|a| a.load(Ordering::Relaxed))
                .unwrap_or(0)
                > 0,
            "failure counter should be non-zero after degraded send"
        );
    }

    // Phase 2: restore the link.
    edge_state.test_udp_drop_rate.store(0, Ordering::Relaxed);

    let sent = test_route_to_edge(
        edge_state.clone(),
        sender_sock.clone(),
        target_edge_id,
        recv_addr,
        2u32,
        b"healthy",
    )
    .await;

    assert!(sent, "packet should be sent after link recovery");

    // Receive the packet.
    let mut buf = vec![0u8; 64];
    tokio::time::timeout(
        tokio::time::Duration::from_millis(200),
        recv_sock.recv(&mut buf),
    )
    .await
    .expect("timed out waiting for recovered packet")
    .expect("recv error");

    // Success resets the failure counter for this hop.
    let failures = edge_state.next_hop_failures.read().unwrap();
    assert_eq!(
        failures
            .get(&target_edge_id)
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(0),
        0,
        "failure counter must be reset to 0 after a successful send"
    );
}

/// A best-effort branch backup must not suppress direct fallback to the failed
/// primary child edge. Otherwise the primary child itself can be blackholed even
/// though a backup peer accepted the duplicate.
#[tokio::test]
async fn failed_primary_child_still_uses_direct_tcp_fallback_when_backup_udp_succeeds() {
    let state = fresh_edge_state();
    state.edge_id.store(4, Ordering::Relaxed);

    let (edge_sock, _) = udp_socket_on_random_port().await;
    state.edge_udp_socket.store(Arc::new(Some(edge_sock)));

    let (backup_recv_sock, backup_addr) = udp_socket_on_random_port().await;

    let mut registry = PeerRegistry::default();
    registry.upsert(
        2,
        PeerEdgeInfo {
            udp_addr: backup_addr,
            host: "127.0.0.1".into(),
            relay_port: None,
            endpoints: Vec::new(),
        },
    );
    state.peer_registry.store(Arc::new(registry));

    state.dissemination_routes.store(Arc::new(HashMap::from([(
        4,
        DisseminationSourceState {
            active_children: vec![1],
            duplicate_children: vec![1],
            branch_backups: HashMap::from([(1, vec![2])]),
        },
    )])));

    {
        let mut failures = state.next_hop_failures.write().unwrap();
        failures.insert(
            1,
            std::sync::atomic::AtomicU32::new(state.consecutive_failure_threshold),
        );
    }

    let pool = Arc::new(PeerVoiceTcpPool::new(1));
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    *pool.senders[0].lock().unwrap() = Some(tx);
    pool.mark_connected();
    state
        .voice_tcp_conns
        .store(Arc::new(HashMap::from([(1, pool)])));

    let hub_client = HubClient::new(&test_config(), state.clone());

    forward_source_voice_packet(
        &state,
        &hub_client,
        40_001,
        &[0x80, 0x01, 0xAA, 0xBB],
        0,
        &[],
    )
    .await;

    let tcp_frame = tokio::time::timeout(tokio::time::Duration::from_millis(250), rx.recv())
        .await
        .expect("primary fallback timeout")
        .expect("primary fallback frame");
    assert_eq!(
        tcp_frame[0], 0x01,
        "DirectTcp fallback must send EDGE_PKT_VOICE"
    );
    assert_eq!(
        tcp_frame[1], 4,
        "fallback frame must preserve source edge id"
    );

    let mut backup_buf = [0u8; 128];
    let backup_len = tokio::time::timeout(
        tokio::time::Duration::from_millis(250),
        backup_recv_sock.recv(&mut backup_buf),
    )
    .await
    .expect("backup UDP timeout")
    .expect("backup UDP recv");
    assert!(
        backup_len > 0,
        "best-effort backup UDP copy must still be sent"
    );
}

/// When `consecutive_failure_threshold = 0`, the failure counter must NOT be
/// reset after a successful send.  This mode means "never skip a hop regardless
/// of failures" — tracking and automatic reset are both disabled.
#[tokio::test]
async fn zero_failure_threshold_does_not_reset_failures_on_success() {
    let edge_state = edge_state_with_zero_failure_threshold();
    let (sender_sock, _) = udp_socket_on_random_port().await;
    let (recv_sock, recv_addr) = udp_socket_on_random_port().await;

    let target_edge_id = 55u32;

    // Manually seed the failure counter to a non-zero value.
    {
        let mut failures = edge_state.next_hop_failures.write().unwrap();
        failures.insert(target_edge_id, std::sync::atomic::AtomicU32::new(7));
    }

    // Send successfully (drop_rate = 0, socket reachable).
    let sent = test_route_to_edge(
        edge_state.clone(),
        sender_sock.clone(),
        target_edge_id,
        recv_addr,
        1u32,
        b"healthy",
    )
    .await;
    assert!(sent, "packet must be sent successfully");

    // Consume the received packet.
    let mut buf = vec![0u8; 64];
    tokio::time::timeout(
        tokio::time::Duration::from_millis(200),
        recv_sock.recv(&mut buf),
    )
    .await
    .expect("timed out waiting for packet on healthy link")
    .expect("recv must succeed");

    // With threshold=0, the counter must remain 7 (not reset to 0).
    let failures = edge_state.next_hop_failures.read().unwrap();
    assert_eq!(
        failures
            .get(&target_edge_id)
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(0),
        7,
        "failure counter must not be reset when consecutive_failure_threshold=0"
    );
}

// ── EDGE_PKT_RELAY wire format ────────────────────────────────────────────────

/// `test_send_relay_packet` must produce exactly the `EDGE_PKT_RELAY` wire format:
///   `[0x02][ttl(1)][target_edge_id_BE(4)][sender_session_BE(4)][payload...]`
///
/// The receiving Edge parser (EDGE_PKT_RELAY branch in `UdpServer::run()`) relies
/// on this exact layout.
#[tokio::test]
async fn relay_udp_packet_wire_format_is_correct() {
    let (sender_sock, _) = udp_socket_on_random_port().await;
    let (recv_sock, recv_addr) = udp_socket_on_random_port().await;

    let target_edge_id: u32 = 0xDEAD_BEEF;
    let sender_session: u32 = 0x1234_5678;
    let ttl: u8 = 3;
    let payload = b"opus-frame";

    let sent = test_send_relay_packet(
        sender_sock,
        target_edge_id,
        recv_addr,
        sender_session,
        ttl,
        payload,
    )
    .await;
    assert!(sent, "relay packet must be sent");

    let mut buf = vec![0u8; 256];
    let n = tokio::time::timeout(
        tokio::time::Duration::from_millis(200),
        recv_sock.recv(&mut buf),
    )
    .await
    .expect("timed out")
    .expect("recv error");

    // Verify EDGE_PKT_RELAY = 0x02
    assert_eq!(buf[0], 0x02, "first byte must be EDGE_PKT_RELAY (0x02)");
    // Verify TTL
    assert_eq!(buf[1], ttl, "second byte must be TTL");
    // Verify target_edge_id (bytes 2–5, big-endian)
    assert_eq!(
        u32::from_be_bytes(buf[2..6].try_into().unwrap()),
        target_edge_id,
        "bytes 2–5 must be target_edge_id in big-endian"
    );
    // Verify sender_session (bytes 6–9, big-endian)
    assert_eq!(
        u32::from_be_bytes(buf[6..10].try_into().unwrap()),
        sender_session,
        "bytes 6–9 must be sender_session in big-endian"
    );
    // Verify payload
    assert_eq!(
        &buf[10..n],
        payload,
        "remaining bytes must be the voice payload"
    );
}
