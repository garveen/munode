//! Integration tests for the voice routing redesign — Edge side.
//!
//! These tests cover the two routing transports available to Edge nodes:
//!
//! - **DirectTcp** — voice frames tunnelled over the `/voice` WebSocket endpoint.
//! - **DirectUdp with degradation** — simulated packet-loss via the
//!   `test_udp_drop_rate` field, which drives `next_hop_failures` accumulation.
//!
//! All tests use real OS sockets (TCP or UDP) with OS-assigned ports
//! (`127.0.0.1:0`) so they work in any environment without port-conflict risks.
//!
//! **Requires the `test-utils` feature:**
//!   cargo test -p munode-edge --features test-utils --test voice_routing

#![cfg(feature = "test-utils")]

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use futures_util::SinkExt;
use tokio::net::{TcpListener, UdpSocket};

use munode_edge::channel_manager::ChannelManager;
use munode_edge::client::ClientManager;
use munode_edge::relay_server::{connect_peer_voice_tcp, run_edge_ws_server_with_listener};
use munode_edge::state::{EdgeEvent, EdgeState};
use munode_edge::udp::test_route_to_edge;

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
    let sock = Arc::new(UdpSocket::bind("127.0.0.1:0").await.expect("bind UDP socket"));
    let addr = sock.local_addr().unwrap();
    (sock, addr)
}

/// Build a fresh `EdgeState` backed by empty Channel/Client managers.
fn fresh_edge_state() -> Arc<EdgeState> {
    EdgeState::new(ChannelManager::new(), ClientManager::new(), false)
}

/// Spawn the combined relay+voice WebSocket server on a random port.
/// Returns `(port, server_state)`.
async fn start_voice_ws_server() -> (u16, Arc<EdgeState>) {
    let state = fresh_edge_state();
    let (listener, port) = tcp_listener_on_random_port().await;

    let server_state = state.clone();
    tokio::spawn(async move {
        // Hub host/port are unused because tests only exercise the /voice path.
        run_edge_ws_server_with_listener(listener, "127.0.0.1".to_string(), 0, server_state).await;
    });

    // Give the accept loop a moment to start.
    tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
    (port, state)
}

// ── TCP voice channel ─────────────────────────────────────────────────────────

/// A voice frame sent via `connect_peer_voice_tcp` must be delivered to the
/// server as a `RelayedVoice` event on `EdgeState`.
///
/// This tests the full DirectTcp transport path:
///   client `connect_peer_voice_tcp` → WS /voice handshake → binary frame →
///   server parses [0x01][session][voice] → emits `EdgeEvent::RelayedVoice`.
#[tokio::test]
async fn direct_tcp_voice_frame_delivered_as_relayed_event() {
    let (port, server_state) = start_voice_ws_server().await;

    // Subscribe before connecting to avoid missing the event.
    let mut event_rx = server_state.subscribe_events();

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

    // Wait for the server to emit RelayedVoice (up to 1 second).
    let voice_pkt = tokio::time::timeout(
        tokio::time::Duration::from_secs(1),
        async {
            loop {
                match event_rx.recv().await {
                    Ok(EdgeEvent::RelayedVoice { voice_packet }) => return voice_packet,
                    Ok(_) => continue,
                    Err(_) => panic!("event channel closed"),
                }
            }
        },
    )
    .await
    .expect("timed out waiting for RelayedVoice");

    assert_eq!(
        voice_pkt[0], 0x80,
        "first byte of voice_packet must be the Opus header byte"
    );
    assert!(
        voice_pkt.ends_with(&[0xDE, 0xAD, 0xBE, 0xEF]),
        "audio payload must be intact at the end of voice_packet"
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
        connect_peer_voice_tcp(peer_edge_id, "127.0.0.1".to_string(), port, 7, cs).await;
    });

    // Retry until the sender is registered (or timeout).
    let registered = tokio::time::timeout(tokio::time::Duration::from_secs(2), async {
        loop {
            {
                let conns = client_state.voice_tcp_conns.read().await;
                if conns.contains_key(&peer_edge_id) {
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
        "voice_tcp_conns must contain an entry for the connected peer edge"
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

    let failures = edge_state.next_hop_failures.read().await;
    assert_eq!(
        failures.get(&target_edge_id).copied().unwrap_or(0),
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
    assert_eq!(dropped, batch, "all packets must be dropped at 100% drop rate");

    // Failure counter must equal the number of dropped packets.
    let failures = edge_state.next_hop_failures.read().await;
    assert_eq!(
        failures.get(&target_edge_id).copied().unwrap_or(0),
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
        let failures = edge_state.next_hop_failures.read().await;
        assert!(
            failures.get(&target_edge_id).copied().unwrap_or(0) > 0,
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
    let failures = edge_state.next_hop_failures.read().await;
    assert_eq!(
        failures.get(&target_edge_id).copied().unwrap_or(0),
        0,
        "failure counter must be reset to 0 after a successful send"
    );
}
