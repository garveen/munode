use bytes::{Bytes, BytesMut};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use async_channel;
use dashmap::DashMap;
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tracing::{debug, info, trace, warn};

use munode_common::config::EdgeVoiceQualityConfig;
use munode_protocol::transport::EDGE_MAGIC;

use crate::hot_slot::get_hot_slot;
use crate::hub_client::HubClient;
use crate::state::{EdgeState, PeerQualityState};

// ── Edge-to-Edge packet type bytes (1-byte prefix on the dedicated edge socket) ─────────────────
//
// Because the `edge_socket` is bound to a **dedicated** `edge_port` separate from the
// client-facing Mumble port, every datagram received on it is already known to be
// Edge-to-Edge traffic.  A single type byte is therefore sufficient to distinguish the
// packet families; no 2-byte magic prefix is needed on the dedicated edge socket.
//
// Wire formats on `edge_socket`:
//
//   Plain logical voice frame:
//     [0x01][logical_voice_frame...]
//
//   Plain extended logical voice frame:
//     [0x02][logical_voice_frame...]
//
//   Base logical voice frame:
//     [source_edge_id:u8][transport_packet_seq:be16][voice_packet...]
//
//   Extended logical voice frame:
//     [source_edge_id|0x80:u8][transport_packet_seq:be16][control:u8][voice_packet...]
//
//   The logical frame is shared across UDP, peer TCP `/voice`, and Hub relay. The
//   receiving Edge performs rolling dedupe on `(source_edge_id, transport_packet_seq)`,
//   delivers locally, then forwards according to the Hub-pushed per-source slice.
//
//   Quality probe (ping / pong):
//     [0x03][subtype(1B): 0=ping 1=pong][seq BE(4B)][sent_ms BE(8B)][padding...]
//     Minimum: 14 bytes
//
//   Encrypted base logical voice frame (ChaCha20-Poly1305, requires hmac_secret):
//     [0x11][counter:be64][ChaCha20enc(logical_voice_frame) + Poly1305tag(16B)]
//
//   Encrypted extended logical voice frame:
//     [0x12][counter:be64][ChaCha20enc(logical_voice_frame) + Poly1305tag(16B)]

//   Encrypted quality probe:
//     [0x13][counter:be64][ChaCha20enc(probe_payload) + Poly1305tag(16B)]
//
//   The sender edge ID is inferred from the ingress peer address and reused as the
//   AEAD nonce prefix (`sender_edge_id ++ counter`), so the physical UDP packet no
//   longer needs to carry target-edge or relay-chain metadata.
//
// Legacy / fallback (shared socket — no dedicated edge_port):
//   When `edge_socket` is the same fd as `socket` (the Mumble client port),
//   `EDGE_MAGIC=[0x00,0x00]` is still prefixed so Edge packets can be disambiguated
//   from encrypted OCB2 client datagrams on the shared socket.

/// Packet type: direct voice for this Edge.
const EDGE_PKT_VOICE: u8 = 0x01;
/// Packet type: relay-forward voice to another Edge (this node is intermediary).
const EDGE_PKT_RELAY: u8 = 0x02;
/// Packet type: quality probe (ping / pong).
const EDGE_PKT_PROBE: u8 = 0x03;
/// Packet type: encrypted direct voice (ChaCha20-Poly1305).
const EDGE_PKT_ENC_VOICE: u8 = 0x11;
/// Packet type: encrypted relay-forward voice (routing headers in plaintext).
const EDGE_PKT_ENC_RELAY: u8 = 0x12;
/// Packet type: encrypted quality probe (ChaCha20-Poly1305).
const EDGE_PKT_ENC_PROBE: u8 = 0x13;
/// Overhead of the Poly1305 authentication tag appended to every encrypted payload.
const AEAD_TAG_LEN: usize = 16;
/// Probe payload padding so link probes exercise a packet size closer to real voice traffic.
const MEDIA_LIKE_PROBE_PADDING_BYTES: usize = 160;

/// UDP server for Mumble voice data with OCB2-AES128 encryption.
///
/// Workflow:
/// 1. Client authenticates via TCP → CryptState registered in ClientManager.
/// 2. Client sends first OCB2-encrypted UDP packet (typically a ping).
/// 3. Server tries decrypting with each authenticated session's CryptState;
///    on success the UDP address is mapped to that session.
/// 4. Subsequent packets are decrypted, routed, and re-encrypted per-recipient.
///
/// Edge-to-Edge voice uses a separate `edge_socket` bound on `edge_port`.
/// All datagrams on that socket are Edge-to-Edge; a single type byte distinguishes:
///   [0x01][session_BE(4B)][voice]   — direct voice for this Edge (5-byte header)
///   [0x02][ttl(1B)][target_BE(4B)][session_BE(4B)][voice] — relay-forward (10-byte header)
///   [0x03][subtype(1B)][seq_BE(4B)][ts_BE(8B)]   — quality probe (14 bytes)
///
/// Fallback (no dedicated edge_port): packets arrive on the client socket and are
/// identified by the legacy `EDGE_MAGIC=[0x00,0x00]` prefix in `handle_client_datagram`.
pub struct UdpServer {
    /// Client-facing socket (Mumble port).
    socket: Arc<UdpSocket>,
    /// Edge-to-Edge dedicated socket (edge_port).  May be the same as `socket`
    /// when `edge_port` is not configured (fall-back guard).
    edge_socket: Arc<UdpSocket>,
    edge_state: Arc<EdgeState>,
    hub_client: Arc<HubClient>,
    /// Maps UDP source address → session ID.
    addr_to_session: Arc<DashMap<SocketAddr, u32>>,
    /// Maps session ID → UDP source address.
    ///
    /// Shared with `EdgeState::udp_session_to_addr` so that the TCP read loop
    /// can clear an entry when the client falls back to `UdpTunnel`, mirroring
    /// Murmur's `aiUdpFlag = 0` behaviour.
    session_to_addr: Arc<DashMap<u32, SocketAddr>>,
    /// Per-edge quality tracking for UDP probes.
    peer_quality: Arc<Mutex<HashMap<u32, PeerQualityState>>>,
    /// Channel for client voice packets: capacity 65536.
    client_tx: async_channel::Sender<(Bytes, SocketAddr)>,
    client_rx: async_channel::Receiver<(Bytes, SocketAddr)>,
    /// Channel for edge relay/direct packets: capacity 4096 (relay has priority).
    relay_tx: async_channel::Sender<(u8, Bytes, SocketAddr)>,
    relay_rx: async_channel::Receiver<(u8, Bytes, SocketAddr)>,
    quality_config: EdgeVoiceQualityConfig,
}

impl UdpServer {
    pub async fn new(
        client_addr: SocketAddr,
        edge_addr: SocketAddr,
        edge_state: Arc<EdgeState>,
        hub_client: Arc<HubClient>,
        quality_config: EdgeVoiceQualityConfig,
    ) -> Result<Self> {
        let socket = Arc::new(UdpSocket::bind(client_addr).await?);
        info!("UDP (client) server listening on {}", client_addr);

        let edge_socket = if edge_addr != client_addr {
            let s = Arc::new(UdpSocket::bind(edge_addr).await?);
            info!("UDP (edge-to-edge) server listening on {}", edge_addr);
            s
        } else {
            Arc::clone(&socket)
        };

        edge_state.set_client_udp_socket(Arc::clone(&socket));
        edge_state.set_edge_udp_socket(Arc::clone(&edge_socket));

        let (client_tx, client_rx) = async_channel::bounded(65536);
        let (relay_tx, relay_rx) = async_channel::bounded(4096);
        let peer_quality = Arc::clone(&edge_state.peer_quality);

        Ok(Self {
            socket,
            edge_socket,
            addr_to_session: Arc::new(DashMap::new()),
            session_to_addr: Arc::clone(&edge_state.udp_session_to_addr),
            edge_state,
            hub_client,
            peer_quality,
            client_tx,
            client_rx,
            relay_tx,
            relay_rx,
            quality_config,
        })
    }

    /// Register a client's UDP address.
    pub fn register_client(&self, session_id: u32, addr: SocketAddr) {
        bind_session_addr(
            self.addr_to_session.as_ref(),
            self.session_to_addr.as_ref(),
            session_id,
            addr,
        );

        debug!("Registered UDP client: session {} at {}", session_id, addr);
    }

    /// Unregister a client's UDP address on TCP disconnect.
    pub fn unregister_client(&self, session_id: u32) {
        if let Some((_, addr)) = self.session_to_addr.remove(&session_id) {
            self.addr_to_session.remove(&addr);
        }
    }

    /// Main receive loop.  Polls both the client socket and the edge socket.
    ///
    /// Called with `Arc<Self>` so that per-packet voice routing can be offloaded
    /// to separate tokio tasks.  This decouples the receive loop from the fan-out
    /// work (`route_voice`, `deliver_voice_locally`), allowing the kernel socket
    /// buffer to drain at wire speed even when processing a large channel.
    pub async fn run(self: Arc<Self>) -> Result<()> {
        // If edge_socket is the same Arc as socket (no separate edge port),
        // we only select on the client socket to avoid double-polling the same fd.
        let separate_edge_sock = !Arc::ptr_eq(&self.socket, &self.edge_socket);

        // Spawn probe task for link quality measurement
        {
            let probe_udp = Arc::clone(&self.edge_socket);
            let probe_state = Arc::clone(&self.edge_state);
            let probe_hub = Arc::clone(&self.hub_client);
            let probe_quality = Arc::clone(&self.peer_quality);
            let quality_config = self.quality_config.clone();
            tokio::spawn(async move {
                let mut ping_interval = tokio::time::interval(Duration::from_secs(
                    quality_config.probe_interval_secs.max(1),
                ));
                let mut report_interval = tokio::time::interval(Duration::from_secs(
                    quality_config.report_interval_secs.max(1),
                ));
                loop {
                    tokio::select! {
                        _ = ping_interval.tick() => {
                            let now_ms = probe_current_millis();
                            let timeout_ms = probe_state.peer_quality_probe_timeout_ms();
                            let sample_window_size = probe_state.peer_quality_sample_window_size();
                            {
                                let mut pq = probe_quality.lock().await;
                                for (&peer_id, state) in pq.iter_mut() {
                                    let expired = state.expire_stale_pings(
                                        now_ms,
                                        timeout_ms,
                                        sample_window_size,
                                    );
                                    if expired > 0 {
                                        increment_hop_failure_by(
                                            &probe_state.next_hop_failures,
                                            peer_id,
                                            expired as u32,
                                        );
                                    }
                                }
                            }

                            let peers = {
                                probe_state.peer_registry.load().all_udp_peers()
                            };
                            let padding = [0u8; MEDIA_LIKE_PROBE_PADDING_BYTES];
                            for (peer_id, peer_addr) in peers {
                                let seq = {
                                    let mut pq = probe_quality.lock().await;
                                    let entry = pq.entry(peer_id).or_default();
                                    entry.next_seq = entry.next_seq.wrapping_add(1);
                                    let s = entry.next_seq;
                                    entry.pending_pings.insert(s, now_ms);
                                    entry.last_probe_sent_ms = Some(now_ms);
                                    s
                                };
                                if let Some(pkt) = build_probe_datagram(
                                    &probe_state,
                                    0,
                                    seq,
                                    now_ms,
                                    &padding,
                                    probe_state.edge_crypto.is_some(),
                                ) {
                                    let _ = probe_udp.send_to(&pkt, peer_addr).await;
                                }
                            }
                        }
                        _ = report_interval.tick() => {
                            let my_edge_id = probe_state.get_edge_id();
                            if my_edge_id == 0 { continue; }
                            let entries: Vec<(u32, f32, f32, f32, u32)> = {
                                let report_now_ms = probe_current_millis();
                                let timeout_ms = probe_state.peer_quality_probe_timeout_ms();
                                let sample_window_size = probe_state.peer_quality_sample_window_size();
                                let mut pq = probe_quality.lock().await;
                                let result = pq.iter_mut().filter_map(|(&eid, pqs)| {
                                    let expired = pqs.expire_stale_pings(
                                        report_now_ms,
                                        timeout_ms,
                                        sample_window_size,
                                    );
                                    if expired > 0 {
                                        increment_hop_failure_by(
                                            &probe_state.next_hop_failures,
                                            eid,
                                            expired as u32,
                                        );
                                    }

                                    let average_rtt_ms = pqs
                                        .average_rtt_ms()
                                        .or(pqs.last_report_average_rtt_ms);
                                    let packet_loss = pqs
                                        .packet_loss()
                                        .or(pqs.last_report_packet_loss);
                                    let jitter_ms = pqs
                                        .jitter_ms()
                                        .or(pqs.last_report_jitter_ms)
                                        .or(Some(0.0));

                                    let (average_rtt_ms, packet_loss) =
                                        match (average_rtt_ms, packet_loss) {
                                            (Some(rtt), Some(loss)) => (rtt, loss),
                                            _ => return None,
                                        };

                                    pqs.last_report_ms = Some(report_now_ms);
                                    pqs.last_report_average_rtt_ms = Some(average_rtt_ms);
                                    pqs.last_report_packet_loss = Some(packet_loss);
                                    pqs.last_report_jitter_ms = jitter_ms;

                                    Some((
                                        eid,
                                        average_rtt_ms,
                                        packet_loss,
                                        jitter_ms.unwrap_or(0.0),
                                        pqs.sample_count() as u32,
                                    ))
                                }).collect();
                                result
                            };
                            for (target_edge_id, rtt, loss, jitter, samples) in entries {
                                probe_hub.report_quality(target_edge_id, rtt, loss, jitter, samples).await;
                            }
                        }
                    }
                }
            });
        }

        // ── U5-D: Spawn biased worker task (relay priority over client) ──────────
        {
            let worker_server = Arc::clone(&self);
            let client_rx = self.client_rx.clone();
            let relay_rx = self.relay_rx.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased; // relay checked first — lower latency for inter-Edge packets
                        res = relay_rx.recv() => {
                            match res {
                                Ok((pkt_type, data, peer_addr)) => {
                                    match pkt_type {
                                        EDGE_PKT_VOICE => worker_server.handle_edge_packet(data.as_ref(), peer_addr).await,
                                        EDGE_PKT_RELAY => worker_server.handle_relay_packet(data.as_ref(), peer_addr).await,
                                        EDGE_PKT_ENC_VOICE => worker_server.handle_enc_voice_packet(data.as_ref(), peer_addr).await,
                                        EDGE_PKT_ENC_RELAY => worker_server.handle_enc_relay_packet(data.as_ref(), peer_addr).await,
                                        _ => {}
                                    }
                                }
                                Err(_) => break, // channel closed
                            }
                        }
                        res = client_rx.recv() => {
                            match res {
                                Ok((data, peer_addr)) => {
                                    worker_server.handle_client_datagram(data.as_ref(), peer_addr).await;
                                }
                                Err(_) => break, // channel closed
                            }
                        }
                    }
                }
            });
        }

        // ── U5-C: recv loop — classify and send to appropriate channel ─────────
        loop {
            if separate_edge_sock {
                let mut client_data = BytesMut::with_capacity(2048);
                let mut edge_data = BytesMut::with_capacity(2048);
                tokio::select! {
                    res = self.socket.recv_buf_from(&mut client_data) => {
                        let (len, peer_addr) = res?;
                        if len >= 4 {
                            let _ = self.client_tx.send((client_data.freeze(), peer_addr)).await;
                        }
                    }
                    res = self.edge_socket.recv_buf_from(&mut edge_data) => {
                        let (len, peer_addr) = res?;
                        if len < 1 {
                            continue;
                        }
                        let data = edge_data.freeze();
                        match data[0] {
                            EDGE_PKT_VOICE if len >= 5 => {
                                let _ = self.relay_tx.send((EDGE_PKT_VOICE, data.slice(1..), peer_addr)).await;
                            }
                            EDGE_PKT_RELAY if len >= 6 => {
                                let _ = self.relay_tx.send((EDGE_PKT_RELAY, data.slice(1..), peer_addr)).await;
                            }
                            // Quality probe: [0x03][subtype(1)][seq_BE(4)][ts_BE(8)][padding...]
                            // Probes are latency-sensitive; handle inline in recv loop.
                            EDGE_PKT_PROBE if len >= 14 => {
                                self.handle_probe_packet(&data[1..], peer_addr, false).await;
                            }
                            EDGE_PKT_ENC_VOICE if len >= 29 => {
                                let _ = self.relay_tx.send((EDGE_PKT_ENC_VOICE, data.slice(1..), peer_addr)).await;
                            }
                            EDGE_PKT_ENC_RELAY if len >= 30 => {
                                let _ = self.relay_tx.send((EDGE_PKT_ENC_RELAY, data.slice(1..), peer_addr)).await;
                            }
                            EDGE_PKT_ENC_PROBE if len >= 38 => {
                                self.handle_encrypted_probe_packet(&data[1..], peer_addr).await;
                            }
                            _ => {
                                debug!("Unknown edge packet type 0x{:02X} from {} ({} bytes)",
                                    data[0], peer_addr, len);
                            }
                        }
                    }
                }
            } else {
                let mut client_data = BytesMut::with_capacity(2048);
                let (len, peer_addr) = self.socket.recv_buf_from(&mut client_data).await?;
                if len >= 4 {
                    let _ = self.client_tx.send((client_data.freeze(), peer_addr)).await;
                }
            }
        }
    }

    /// Detect and respond to an unencrypted Mumble UDP ping packet.
    ///
    /// Two formats are recognized:
    ///
    /// **Legacy** (Mumble < 1.5): exactly 12 bytes, first 4 are `[0x00,0x00,0x00,0x00]`.
    /// Response: 24 bytes = `[4B version BE][8B timestamp echo][4B users BE][4B max_users BE][4B bandwidth BE]`.
    ///
    /// **Protobuf** (Mumble ≥ 1.5): first byte is `0x01` (`UDPMessageType::Ping`),
    /// followed by a protobuf-serialised `MumbleUDP.Ping` message.
    /// Response: same header + serialised Ping with server info filled in.
    ///
    /// When `allow_ping` is false the packet is recognised (returns `true`) but
    /// no reply is sent, so the caller still short-circuits cleanly.
    ///
    /// Returns `true` if the packet was a recognised ping format.
    async fn try_handle_udp_ping(&self, data: &[u8], peer_addr: SocketAddr) -> bool {
        // ── Legacy ping: 12 bytes, first 4 bytes are all zero ────────────────
        if data.len() == 12 && data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 0 {
            if self
                .edge_state
                .allow_ping
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                let (user_count, max_users, bandwidth) = self.ping_server_info().await;
                let mut resp = [0u8; 24];
                // Version in legacy format: major<<16 | minor<<8 | patch  (report 1.5.0)
                let version: u32 = (1u32 << 16) | (5u32 << 8);
                resp[0..4].copy_from_slice(&version.to_be_bytes());
                // Echo the 8-byte timestamp verbatim (byte order is opaque to us)
                resp[4..12].copy_from_slice(&data[4..12]);
                resp[12..16].copy_from_slice(&(user_count as u32).to_be_bytes());
                resp[16..20].copy_from_slice(&(max_users as u32).to_be_bytes());
                resp[20..24].copy_from_slice(&bandwidth.to_be_bytes());
                if let Err(e) = self.socket.send_to(&resp, peer_addr).await {
                    debug!(
                        "Failed to send legacy UDP ping response to {}: {}",
                        peer_addr, e
                    );
                } else {
                    debug!("Responded to legacy UDP ping from {}", peer_addr);
                }
            }
            return true;
        }

        // ── Protobuf ping: first byte == 0x01 (UDPMessageType::Ping) ─────────
        if data.len() >= 2 && data[0] == 0x01 {
            if self
                .edge_state
                .allow_ping
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                let payload = &data[1..];
                let (timestamp, request_extra) = parse_mumble_udp_ping(payload);
                let (user_count, max_users, bandwidth) = if request_extra {
                    self.ping_server_info().await
                } else {
                    (0, 0, 0)
                };
                // Version v2 format: major<<48 | minor<<32 | patch<<16
                let server_version_v2: u64 = (1u64 << 48) | (5u64 << 32);
                let mut resp = Vec::with_capacity(32);
                resp.push(0x01u8);
                encode_mumble_udp_ping_response(
                    &mut resp,
                    timestamp,
                    request_extra,
                    server_version_v2,
                    user_count as u32,
                    max_users as u32,
                    bandwidth,
                );
                if let Err(e) = self.socket.send_to(&resp, peer_addr).await {
                    debug!(
                        "Failed to send protobuf UDP ping response to {}: {}",
                        peer_addr, e
                    );
                } else {
                    debug!("Responded to protobuf UDP ping from {}", peer_addr);
                }
            }
            return true;
        }

        false
    }

    /// Returns (current_users, max_users, max_bandwidth_bps) for ping responses.
    async fn ping_server_info(&self) -> (usize, usize, u32) {
        let local = self.edge_state.client_manager.client_count().await;
        let remote = self
            .edge_state
            .channel_manager
            .get_all_remote_users()
            .await
            .len();
        // max_users and max_bandwidth are mirrored as AtomicU32 (lock-free reads).
        let max_users = self
            .edge_state
            .max_users
            .load(std::sync::atomic::Ordering::Relaxed) as usize;
        let bandwidth = self
            .edge_state
            .max_bandwidth_bps
            .load(std::sync::atomic::Ordering::Relaxed);
        (local + remote, max_users, bandwidth)
    }

    /// Dispatch a datagram received on the client-facing socket.
    async fn handle_client_datagram(&self, data: &[u8], peer_addr: SocketAddr) {
        // Check for unencrypted Mumble UDP ping BEFORE the EDGE_MAGIC check.
        // The legacy ping format starts with [0x00,0x00,0x00,0x00] which shares
        // the same two-byte prefix as EDGE_MAGIC — detect pings first to avoid
        // misrouting them as Edge-to-Edge packets.
        if self.try_handle_udp_ping(data, peer_addr).await {
            return;
        }

        // Edge-to-Edge packet on the client port (fallback when no dedicated edge port).
        if data.len() >= 3 && data[0] == EDGE_MAGIC[0] && data[1] == EDGE_MAGIC[1] {
            match data[2] {
                EDGE_PKT_VOICE if data.len() >= 7 => {
                    self.handle_edge_packet(&data[3..], peer_addr).await
                }
                EDGE_PKT_RELAY if data.len() >= 8 => {
                    self.handle_relay_packet(&data[3..], peer_addr).await
                }
                EDGE_PKT_PROBE if data.len() >= 16 => {
                    self.handle_probe_packet(&data[3..], peer_addr, false).await
                }
                EDGE_PKT_ENC_VOICE if data.len() >= 31 => {
                    self.handle_enc_voice_packet(&data[3..], peer_addr).await
                }
                EDGE_PKT_ENC_RELAY if data.len() >= 32 => {
                    self.handle_enc_relay_packet(&data[3..], peer_addr).await
                }
                EDGE_PKT_ENC_PROBE if data.len() >= 40 => {
                    self.handle_encrypted_probe_packet(&data[3..], peer_addr)
                        .await
                }
                _ => debug!(
                    "Unknown shared-socket edge packet type 0x{:02X} from {} ({} bytes)",
                    data[2],
                    peer_addr,
                    data.len()
                ),
            }
            return;
        }

        let known_session = self.addr_to_session.get(&peer_addr).map(|r| *r.value());

        if let Some(session_id) = known_session {
            self.handle_known_client(data, session_id).await;
        } else {
            self.try_identify_and_handle(data, peer_addr).await;
        }
    }

    /// Handle a packet from an already-identified client.
    ///
    /// All sender metadata (CryptState, channel_id, suppress, bandwidth) is read
    /// lock-free from the session's HotSlot — zero async awaits on the hot path.
    /// Rate-limit is checked **before decrypt** so overflowing packets skip AES entirely.
    async fn handle_known_client(&self, data: &[u8], session_id: u32) {
        let slot = crate::hot_slot::get_hot_slot(session_id);
        if !slot.is_active_for(session_id) {
            debug!("No active HotSlot for {} — UDP packet dropped", session_id);
            return;
        }
        let crypt_arc = match &**slot.crypt_state.load() {
            Some(cs) => Arc::clone(cs),
            None => {
                debug!(
                    "No CryptState in HotSlot for {} — UDP packet dropped",
                    session_id
                );
                return;
            }
        };
        let sender_channel = slot.channel_id.load(std::sync::atomic::Ordering::Relaxed);
        let suppress = slot.suppress.load(std::sync::atomic::Ordering::Relaxed);
        let muted = slot.mute.load(std::sync::atomic::Ordering::Relaxed)
            || slot.self_mute.load(std::sync::atomic::Ordering::Relaxed);
        let bw_arc = match &**slot.bandwidth.load() {
            Some(bw) => Arc::clone(bw),
            None => {
                debug!(
                    "No BandwidthRecord in HotSlot for {} — UDP packet dropped",
                    session_id
                );
                return;
            }
        };

        // ── Rate-limit check BEFORE decrypt ────────────────────────────────────
        // Encrypted size = plaintext size + 4 (OCB2 tag), so:
        //   data.len() + 28  ≡  plaintext.len() + 32  (IP 20 + UDP 8 overhead)
        // Performing the check here avoids AES work entirely when a client is
        // bursting (packet backlog) or being used as an amplification source.
        {
            let max_bps = self
                .edge_state
                .max_bandwidth_bps
                .load(std::sync::atomic::Ordering::Relaxed);
            if max_bps > 0 {
                let max_bytes = max_bps / 8;
                let window_secs = (self
                    .edge_state
                    .rolling_stats_window
                    .load(std::sync::atomic::Ordering::Relaxed)
                    as usize)
                    .min(crate::bandwidth::MAX_WINDOW_SLOTS);
                // 28 = IP(20) + UDP(8); OCB2 tag(4) is already in data.len()
                let packet_size = (data.len() as u32).saturating_add(28);
                let within_budget = match bw_arc.lock() {
                    Ok(mut record) => {
                        if record.window_secs() != crate::bandwidth::effective_window(window_secs) {
                            *record = crate::bandwidth::BandwidthRecord::new(window_secs);
                        }
                        record.add_frame(packet_size, max_bytes)
                    }
                    Err(_) => true, // poisoned — allow packet through
                };
                if !within_budget {
                    trace!(
                        "Rate limit exceeded for session {} — dropping {} B before decrypt",
                        session_id,
                        data.len()
                    );
                    return;
                }
            }
        }

        let plaintext = {
            let mut cs = match crypt_arc.lock() {
                Ok(cs) => cs,
                Err(e) => {
                    warn!(
                        "CryptState mutex poisoned for session {} — packet dropped: {}",
                        session_id, e
                    );
                    return;
                }
            };
            let mut plain = Vec::new();
            if !cs.decrypt(data, &mut plain) {
                debug!(
                    "OCB2 decrypt failed for session {} ({} bytes)",
                    session_id,
                    data.len()
                );
                return;
            }
            plain
        };

        if plaintext.is_empty() {
            return;
        }

        let pkt_type = plaintext[0] >> 5;
        if pkt_type == 1 {
            // Ping (type 0b001): echo back encrypted only when allow_ping is enabled
            if self
                .edge_state
                .allow_ping
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                self.send_encrypted(session_id, &plaintext).await;
            }
        } else {
            // Rate check already done above; pass None to skip it in route_voice.
            self.route_voice(
                session_id,
                &plaintext,
                sender_channel,
                suppress,
                muted,
                None,
            )
            .await;
        }
    }

    /// Attempt to identify an unknown UDP source by trying decryption with
    /// all TCP-authenticated sessions that don't yet have a UDP address.
    ///
    /// Snapshots (session_id, crypt_arc, channel_id, suppress) in a **single**
    /// `sessions.read()` instead of the prior `get_authenticated_sessions` +
    /// N×`get_crypt_state` pattern (N+1 lock acquisitions → 1).
    async fn try_identify_and_handle(&self, data: &[u8], peer_addr: SocketAddr) {
        if data.len() < 4 {
            return;
        }

        // Single lock: get all session candidates for identification.
        // Unknown-source packets must be able to re-bind a session whose cached
        // UDP address went stale after a NAT remap.
        let candidates = self
            .edge_state
            .client_manager
            .get_udp_identification_candidates()
            .await;

        for (session_id, cs_arc, sender_channel, suppress, mute, self_mute, bw_arc) in candidates {
            let mut plain = Vec::new();
            let identified = {
                let mut cs = match cs_arc.lock() {
                    Ok(cs) => cs,
                    Err(e) => {
                        warn!(
                            "CryptState mutex poisoned for session {} — packet dropped: {}",
                            session_id, e
                        );
                        continue;
                    }
                };
                cs.decrypt(data, &mut plain)
            };

            if identified {
                self.register_client(session_id, peer_addr);
                debug!("Identified UDP session {} at {}", session_id, peer_addr);

                if plain.is_empty() {
                    return;
                }
                let pkt_type = plain[0] >> 5;
                if pkt_type == 1 {
                    if self
                        .edge_state
                        .allow_ping
                        .load(std::sync::atomic::Ordering::Relaxed)
                    {
                        self.send_encrypted(session_id, &plain).await;
                    }
                } else {
                    self.route_voice(
                        session_id,
                        &plain,
                        sender_channel,
                        suppress,
                        mute || self_mute,
                        Some(bw_arc),
                    )
                    .await;
                }
                return;
            }
            // Failed decrypt leaves the state unchanged (decrypt() restores IV)
        }

        debug!(
            "Unidentified UDP packet from {} ({} bytes)",
            peer_addr,
            data.len()
        );
    }

    /// Route decrypted voice to channel members, encrypting per-recipient.
    /// Also relays to remote users (on other edges) via Hub TCP.
    ///
    /// `sender_channel`, `suppress`, `muted`, and `bw_arc` are pre-fetched by the caller.
    /// `muted` is `true` when the sender is server-muted or self-muted.
    /// Pass `Some(bw_arc)` to perform the rate-limit check here (identify path).
    /// Pass `None` when the caller has already checked before decrypt (hot path).
    async fn route_voice(
        &self,
        sender_session: u32,
        plaintext: &[u8],
        sender_channel: u32,
        suppress: bool,
        muted: bool,
        bw_arc: Option<Arc<std::sync::Mutex<crate::bandwidth::BandwidthRecord>>>,
    ) {
        trace!(
            "route_voice: session={} channel={}",
            sender_session, sender_channel
        );

        // Rate-limit check: only runs when bw_arc is Some (identify path).
        // For the hot path (handle_known_client) this was already checked before decrypt.
        if let Some(bw_arc) = bw_arc {
            let window_secs = (self
                .edge_state
                .rolling_stats_window
                .load(std::sync::atomic::Ordering::Relaxed)
                as usize)
                .min(crate::bandwidth::MAX_WINDOW_SLOTS);
            let max_bps = self
                .edge_state
                .max_bandwidth_bps
                .load(std::sync::atomic::Ordering::Relaxed);
            let max_bytes = if max_bps > 0 { max_bps / 8 } else { 0 };
            // 20 bytes IPv4 + 8 bytes UDP + 4 bytes OCB2 tag = 32 bytes wire overhead.
            const WIRE_OVERHEAD: u32 = 32;
            let packet_size = (plaintext.len() as u32).saturating_add(WIRE_OVERHEAD);
            let within_budget = match bw_arc.lock() {
                Ok(mut record) => {
                    if record.window_secs() != crate::bandwidth::effective_window(window_secs) {
                        *record = crate::bandwidth::BandwidthRecord::new(window_secs);
                    }
                    record.add_frame(packet_size, max_bytes)
                }
                Err(_) => true, // poisoned — allow packet through
            };
            if !within_budget {
                return;
            }
        }

        // Reject CELT and Speex voice packets — this server is Opus-only.
        // The top 3 bits of the first byte encode the codec type:
        //   0 = CELT Alpha, 2 = Speex, 3 = CELT Beta, 4 = Opus
        if !plaintext.is_empty() {
            let codec = plaintext[0] >> 5;
            if codec == 0 || codec == 2 || codec == 3 {
                trace!("Dropped non-Opus UDP voice packet (codec={})", codec);
                return;
            }
        }

        // Block suppressed or muted users from speaking
        let voice_target = if !plaintext.is_empty() {
            (plaintext[0] & 0x1F) as u32
        } else {
            0
        };
        if (suppress || muted) && voice_target != 31 {
            return;
        }

        // --- Shared routing: compute target sessions and relay edges ---
        // `compute_voice_targets` handles VoiceTarget lookup, channel expansion,
        // deaf/suppress filtering.  Returns None for loopback (31) → drop.
        let Some(targets) = crate::routing::compute_voice_targets(
            plaintext,
            sender_session,
            sender_channel,
            &self.edge_state,
            &self.hub_client,
        )
        .await
        else {
            return; // loopback or no VoiceTarget config
        };

        // --- Local delivery ------------------------------------------------
        if !targets.is_whisper {
            trace!(
                "route_voice: {} local targets",
                targets.local_sessions.len()
            );
        }

        for group in crate::voice::local_delivery_groups(&targets) {
            let forwarded =
                crate::voice::inject_session_into_voice(plaintext, sender_session, group.context);
            crate::voice::deliver_voice_locally_prefer_udp(
                group.sessions,
                &forwarded,
                Some(&self.socket),
                self.session_to_addr.as_ref(),
            );
        }

        crate::cluster_voice::forward_source_voice_packet(
            &self.edge_state,
            &self.hub_client,
            sender_session,
            plaintext,
            voice_target as u8,
            targets.relay_edge_ids.as_slice(),
        )
        .await;
    }

    /// Send encrypted data to a specific session's UDP address.
    async fn send_encrypted(&self, session_id: u32, plaintext: &[u8]) {
        let addr = match self.session_to_addr.get(&session_id).map(|r| *r.value()) {
            Some(a) => a,
            None => return,
        };
        let slot = get_hot_slot(session_id);
        if !slot.is_active_for(session_id) {
            return;
        }
        let cs_guard = slot.crypt_state.load();
        if let Some(cs_arc) = &**cs_guard {
            let mut encrypted = Vec::new();
            match cs_arc.lock() {
                Ok(mut cs) => {
                    cs.encrypt(plaintext, &mut encrypted);
                }
                Err(e) => {
                    warn!(
                        "CryptState mutex poisoned for session {} — packet dropped: {}",
                        session_id, e
                    );
                    return;
                }
            }
            let _ = self.socket.send_to(&encrypted, addr).await;
        }
    }

    async fn handle_enc_voice_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        self.handle_encrypted_logical_frame(data, peer_addr).await;
    }

    async fn handle_enc_relay_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        self.handle_encrypted_logical_frame(data, peer_addr).await;
    }

    async fn handle_encrypted_probe_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        let crypto = match &self.edge_state.edge_crypto {
            Some(crypto) => crypto,
            None => {
                debug!("Received encrypted cluster probe but no edge_crypto configured");
                return;
            }
        };
        if data.len() < 8 + 13 + AEAD_TAG_LEN {
            return;
        }

        let Some(sender_edge_id) = self.edge_state.peer_registry.load().find_by_addr(peer_addr)
        else {
            debug!("Encrypted cluster probe from unknown peer {}", peer_addr);
            return;
        };

        let counter = u64::from_be_bytes([
            data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
        ]);
        let ciphertext = &data[8..];
        match crypto.decrypt(sender_edge_id, counter, ciphertext, &[]) {
            Some(plain) => {
                self.handle_probe_packet(plain.as_ref(), peer_addr, true)
                    .await;
            }
            None => debug!(
                "Encrypted cluster probe: AEAD authentication failed from edge {}",
                sender_edge_id
            ),
        }
    }

    async fn handle_relay_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        self.handle_plain_logical_frame(data, peer_addr).await;
    }

    /// Handle an Edge-to-Edge internal routing packet.
    async fn handle_edge_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        self.handle_plain_logical_frame(data, peer_addr).await;
    }

    async fn handle_plain_logical_frame(&self, data: &[u8], peer_addr: SocketAddr) {
        if data.len() < 4 {
            debug!("Cluster voice packet too short from {}", peer_addr);
            return;
        }

        let ingress_peer = self.edge_state.peer_registry.load().find_by_addr(peer_addr);
        crate::cluster_voice::handle_incoming_logical_frame(
            Bytes::copy_from_slice(data),
            ingress_peer,
            &self.edge_state,
            &self.hub_client,
        )
        .await;
    }

    async fn handle_encrypted_logical_frame(&self, data: &[u8], peer_addr: SocketAddr) {
        let crypto = match &self.edge_state.edge_crypto {
            Some(crypto) => crypto,
            None => {
                debug!("Received encrypted cluster voice but no edge_crypto configured");
                return;
            }
        };
        if data.len() < 8 + 4 + AEAD_TAG_LEN {
            return;
        }

        let Some(sender_edge_id) = self.edge_state.peer_registry.load().find_by_addr(peer_addr)
        else {
            debug!("Encrypted cluster voice from unknown peer {}", peer_addr);
            return;
        };

        let counter = u64::from_be_bytes([
            data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
        ]);
        let ciphertext = &data[8..];
        match crypto.decrypt(sender_edge_id, counter, ciphertext, &[]) {
            Some(plain) => {
                crate::cluster_voice::handle_incoming_logical_frame(
                    Bytes::from(plain),
                    Some(sender_edge_id),
                    &self.edge_state,
                    &self.hub_client,
                )
                .await;
            }
            None => debug!(
                "Encrypted cluster voice: AEAD authentication failed from edge {}",
                sender_edge_id
            ),
        }
    }

    /// Handle a UDP quality probe packet (ping or pong).
    /// Probe format after stripping type byte:
    /// [subtype(1B): 0=ping 1=pong][seq_BE(4B)][sent_ms_BE(8B)][padding...]
    async fn handle_probe_packet(&self, data: &[u8], from_addr: SocketAddr, encrypted: bool) {
        if data.len() < 13 {
            return;
        }
        let ptype = data[0];
        let seq = u32::from_be_bytes([data[1], data[2], data[3], data[4]]);
        let sent_ms = u64::from_be_bytes([
            data[5], data[6], data[7], data[8], data[9], data[10], data[11], data[12],
        ]);

        if ptype == 0 {
            if let Some(pkt) =
                build_probe_datagram(&self.edge_state, 1, seq, sent_ms, &data[13..], encrypted)
            {
                let _ = self.edge_socket.send_to(&pkt, from_addr).await;
            }
        } else if ptype == 1 {
            // Pong — update quality measurement
            let now_ms = probe_current_millis();
            let sender_edge_id = { self.edge_state.peer_registry.load().find_by_addr(from_addr) };
            if let Some(edge_id) = sender_edge_id {
                let sample_window_size = self.edge_state.peer_quality_sample_window_size();
                let mut pq = self.peer_quality.lock().await;
                let entry = pq.entry(edge_id).or_default();
                let matched = entry.record_probe_success(seq, now_ms, sample_window_size);
                drop(pq);
                // Successful pong resets consecutive failure counter for this peer
                if matched {
                    reset_hop_failure(
                        &self.edge_state.next_hop_failures,
                        edge_id,
                        self.edge_state.consecutive_failure_threshold,
                    );
                }
            }
        }
    }
}

fn edge_packets_need_magic_prefix(state: &Arc<EdgeState>) -> bool {
    let edge_socket = state.edge_udp_socket.load();
    let client_socket = state.client_udp_socket.load();
    match (&**edge_socket, &**client_socket) {
        (Some(edge), Some(client)) => edge.local_addr().ok() == client.local_addr().ok(),
        _ => false,
    }
}

fn build_probe_datagram(
    state: &Arc<EdgeState>,
    subtype: u8,
    seq: u32,
    sent_ms: u64,
    padding: &[u8],
    encrypted: bool,
) -> Option<Vec<u8>> {
    let needs_magic_prefix = edge_packets_need_magic_prefix(state);
    let mut payload = Vec::with_capacity(1 + 4 + 8 + padding.len());
    payload.push(subtype);
    payload.extend_from_slice(&seq.to_be_bytes());
    payload.extend_from_slice(&sent_ms.to_be_bytes());
    payload.extend_from_slice(padding);

    if encrypted {
        let crypto = state.edge_crypto.as_ref()?;
        let (counter, ciphertext) = crypto.encrypt_owned(payload, state.get_edge_id(), &[]);
        let mut packet = Vec::with_capacity(
            EDGE_MAGIC.len() * usize::from(needs_magic_prefix) + 1 + 8 + ciphertext.len(),
        );
        if needs_magic_prefix {
            packet.extend_from_slice(&EDGE_MAGIC);
        }
        packet.push(EDGE_PKT_ENC_PROBE);
        packet.extend_from_slice(&counter.to_be_bytes());
        packet.extend_from_slice(&ciphertext);
        Some(packet)
    } else {
        let mut packet = Vec::with_capacity(
            EDGE_MAGIC.len() * usize::from(needs_magic_prefix) + 1 + payload.len(),
        );
        if needs_magic_prefix {
            packet.extend_from_slice(&EDGE_MAGIC);
        }
        packet.push(EDGE_PKT_PROBE);
        packet.extend_from_slice(&payload);
        Some(packet)
    }
}

fn bind_session_addr(
    addr_to_session: &DashMap<SocketAddr, u32>,
    session_to_addr: &DashMap<u32, SocketAddr>,
    session_id: u32,
    addr: SocketAddr,
) {
    if let Some(previous_addr) = session_to_addr.insert(session_id, addr) {
        if previous_addr != addr {
            addr_to_session.remove(&previous_addr);
        }
    }

    if let Some(previous_session) = addr_to_session.insert(addr, session_id) {
        if previous_session != session_id {
            session_to_addr.remove(&previous_session);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::bind_session_addr;
    use dashmap::DashMap;
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

    fn localhost(port: u16) -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
    }

    #[test]
    fn udp_rebind_updates_both_indexes() {
        let addr_to_session = DashMap::new();
        let session_to_addr = DashMap::new();
        let old_addr = localhost(40_001);
        let new_addr = localhost(40_002);

        bind_session_addr(&addr_to_session, &session_to_addr, 10_001, old_addr);
        bind_session_addr(&addr_to_session, &session_to_addr, 10_001, new_addr);

        assert!(addr_to_session.get(&old_addr).is_none());
        assert_eq!(
            addr_to_session.get(&new_addr).map(|entry| *entry.value()),
            Some(10_001)
        );
        assert_eq!(
            session_to_addr.get(&10_001).map(|entry| *entry.value()),
            Some(new_addr)
        );
    }
}

/// Parse a Mumble UDP protobuf `Ping` payload (the bytes after the `0x01` header).
/// Returns `(timestamp, request_extended_information)`.
fn parse_mumble_udp_ping(payload: &[u8]) -> (u64, bool) {
    let mut timestamp: u64 = 0;
    let mut request_extra = false;
    let mut pos = 0;
    while pos < payload.len() {
        let (tag, n) = match read_pb_varint(payload, pos) {
            Some(v) => v,
            None => break,
        };
        pos += n;
        let field = tag >> 3;
        let wire_type = tag & 0x7;
        match (field, wire_type) {
            (1, 0) => {
                if let Some((v, n)) = read_pb_varint(payload, pos) {
                    timestamp = v;
                    pos += n;
                } else {
                    break;
                }
            }
            (2, 0) => {
                if let Some((v, n)) = read_pb_varint(payload, pos) {
                    request_extra = v != 0;
                    pos += n;
                } else {
                    break;
                }
            }
            (_, 0) => {
                // skip unknown varint field
                if let Some((_, n)) = read_pb_varint(payload, pos) {
                    pos += n;
                } else {
                    break;
                }
            }
            _ => break, // unsupported wire type
        }
    }
    (timestamp, request_extra)
}

/// Encode a Mumble UDP protobuf `Ping` response into `out`.
/// Always writes `timestamp`; writes server info fields only when `include_server_info` is true.
fn encode_mumble_udp_ping_response(
    out: &mut Vec<u8>,
    timestamp: u64,
    include_server_info: bool,
    server_version_v2: u64,
    user_count: u32,
    max_user_count: u32,
    max_bandwidth_per_user: u32,
) {
    // field 1: timestamp
    write_pb_varint(out, 0x08);
    write_pb_varint(out, timestamp);
    if include_server_info {
        // field 3: server_version_v2
        write_pb_varint(out, 0x18);
        write_pb_varint(out, server_version_v2);
        // field 4: user_count
        write_pb_varint(out, 0x20);
        write_pb_varint(out, user_count as u64);
        // field 5: max_user_count
        write_pb_varint(out, 0x28);
        write_pb_varint(out, max_user_count as u64);
        // field 6: max_bandwidth_per_user
        write_pb_varint(out, 0x30);
        write_pb_varint(out, max_bandwidth_per_user as u64);
    }
}

/// Decode a standard protobuf varint from `buf` starting at `pos`.
/// Returns `Some((value, bytes_consumed))` or `None` on underflow / overflow.
fn read_pb_varint(buf: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let start = pos;
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        if pos >= buf.len() {
            return None;
        }
        let b = buf[pos];
        pos += 1;
        result |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((result, pos - start));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

/// Encode a standard protobuf varint and append it to `out`.
fn write_pb_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let b = (value & 0x7F) as u8;
        value >>= 7;
        if value == 0 {
            out.push(b);
            break;
        } else {
            out.push(b | 0x80);
        }
    }
}

/// Atomically increment the consecutive failure counter for `edge_id`.
///
/// Uses a read lock for the common case (key already present) and falls back to
/// a write lock only if the edge ID has never been seen before.  Both operations
/// are synchronous (std::sync::RwLock, no await), so they can be called from the
/// voice hot path without blocking the tokio scheduler.
#[cfg_attr(not(feature = "test-utils"), allow(dead_code))]
fn increment_hop_failure(
    failures: &std::sync::RwLock<std::collections::HashMap<u32, std::sync::atomic::AtomicU32>>,
    edge_id: u32,
) {
    increment_hop_failure_by(failures, edge_id, 1);
}

fn increment_hop_failure_by(
    failures: &std::sync::RwLock<std::collections::HashMap<u32, std::sync::atomic::AtomicU32>>,
    edge_id: u32,
    amount: u32,
) {
    use std::sync::atomic::Ordering;
    if amount == 0 {
        return;
    }
    // Fast path: key exists — just increment.
    {
        if let Ok(map) = failures.read() {
            if let Some(counter) = map.get(&edge_id) {
                counter.fetch_add(amount, Ordering::Relaxed);
                return;
            }
        }
    }
    // Slow path: first time we try to reach this edge.  Insert atomically.
    if let Ok(mut map) = failures.write() {
        map.entry(edge_id)
            .or_insert_with(|| std::sync::atomic::AtomicU32::new(0))
            .fetch_add(amount, Ordering::Relaxed);
    }
}

/// Atomically reset the consecutive failure counter for `edge_id` to 0.
///
/// Silently no-ops when `threshold == 0` (failure tracking disabled) or when the
/// edge ID is not in the map — neither case warrants inserting a zero entry.
fn reset_hop_failure(
    failures: &std::sync::RwLock<std::collections::HashMap<u32, std::sync::atomic::AtomicU32>>,
    edge_id: u32,
    threshold: u32,
) {
    if threshold == 0 {
        return;
    }
    if let Ok(map) = failures.read() {
        if let Some(counter) = map.get(&edge_id) {
            counter.store(0, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// Batch-send multiple UDP datagrams via a single `sendmmsg(2)` syscall (Linux only).
///
/// Returns the number of packets successfully dispatched by the kernel.
///
/// Non-blocking (`MSG_DONTWAIT`): if the socket send buffer is momentarily full,
/// already-queued packets are transmitted and the remainder are reported as unsent
/// (the caller may fall back to Hub TCP relay for those entries).
///
/// On non-Linux platforms this falls back to sequential `send_to` so that the same
/// code compiles on macOS developer machines.
///
/// # Why not `spawn_blocking`
/// Non-blocking UDP `sendmmsg` completes in < 1 μs; the `spawn_blocking` context-
/// switch overhead (~50–100 μs) would be far higher than the operation itself.
#[cfg(target_os = "linux")]
pub(crate) fn batch_sendmmsg(
    fd: std::os::unix::io::RawFd,
    pkts: &[(Vec<u8>, SocketAddr)],
) -> usize {
    use nix::sys::socket::{ControlMessage, MsgFlags, MultiHeaders, SockaddrStorage, sendmmsg};
    use std::io::IoSlice;

    if pkts.is_empty() {
        return 0;
    }

    // Build one [IoSlice; 1] per packet; each borrows from the corresponding Vec<u8>.
    let iovs: Vec<[IoSlice<'_>; 1]> = pkts
        .iter()
        .map(|(data, _)| [IoSlice::new(data.as_slice())])
        .collect();

    // Convert std::net::SocketAddr → nix SockaddrStorage.
    // SockaddrStorage implements From<SocketAddr> for both V4 and V6.
    let addrs: Vec<Option<SockaddrStorage>> = pkts
        .iter()
        .map(|(_, addr)| Some(SockaddrStorage::from(*addr)))
        .collect();

    // Pre-allocate MultiHeaders storage (required by nix 0.29 sendmmsg API).
    let mut headers = MultiHeaders::<SockaddrStorage>::preallocate(pkts.len(), None);
    let no_cmsgs: &[ControlMessage<'_>] = &[];

    match sendmmsg(
        fd,
        &mut headers,
        iovs.iter(),
        addrs.as_slice(),
        no_cmsgs,
        MsgFlags::MSG_DONTWAIT,
    ) {
        Ok(results) => results.count(),
        Err(_) => 0,
    }
}

/// Non-Linux fallback: sequential non-blocking sends using tokio's try_send_to.
/// Called only on macOS/other platforms; production servers always run Linux.
#[cfg(not(target_os = "linux"))]
pub(crate) fn batch_sendmmsg_fallback_seq(
    sock: &tokio::net::UdpSocket,
    pkts: &[(Vec<u8>, SocketAddr)],
) -> usize {
    let mut sent = 0;
    for (data, addr) in pkts {
        match sock.try_send_to(data, *addr) {
            Ok(_) => {
                sent += 1;
            }
            Err(_) => break, // stop on first error (buffer full)
        }
    }
    sent
}

pub(crate) fn encrypt_voice_for_addr(
    target: u32,
    addr: SocketAddr,
    plaintext: &[u8],
) -> Option<(Vec<u8>, SocketAddr)> {
    let slot = get_hot_slot(target);
    let cs_guard = slot.crypt_state.load();
    let cs_arc = match &**cs_guard {
        Some(cs) => Arc::clone(cs),
        None => return None,
    };
    let mut encrypted = Vec::with_capacity(plaintext.len() + 4);
    match cs_arc.lock() {
        Ok(mut cs) => {
            cs.encrypt(plaintext, &mut encrypted);
        }
        Err(e) => {
            warn!("CryptState poisoned session {} — dropped: {}", target, e);
            return None;
        }
    };
    if encrypted.is_empty() {
        None
    } else {
        Some((encrypted, addr))
    }
}

/// Current time in milliseconds (for probe RTT measurement).
fn probe_current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Test-only: attempt to route a single voice packet directly via UDP to the given target Edge,
/// applying the `test_udp_drop_rate` network-degradation hook.
///
/// Returns `true` if the packet reached the socket send call and succeeded,
/// `false` if it was dropped by the degradation hook or by a real send error.
/// In both failure cases `next_hop_failures[target_edge_id]` is incremented, exactly as the
/// production `route_voice()` path does.
///
/// Used by integration tests in `tests/voice_routing.rs`.
#[cfg(feature = "test-utils")]
pub async fn test_route_to_edge(
    edge_state: Arc<EdgeState>,
    edge_socket: Arc<tokio::net::UdpSocket>,
    target_edge_id: u32,
    target_addr: std::net::SocketAddr,
    session: u32,
    payload: &[u8],
) -> bool {
    use std::sync::atomic::Ordering;

    // Degradation hook: simulate packet loss.
    let drop_rate = edge_state.test_udp_drop_rate.load(Ordering::Relaxed);
    if drop_rate > 0 {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let c = COUNTER.fetch_add(1, Ordering::Relaxed);
        if c % 100 < drop_rate {
            increment_hop_failure(&edge_state.next_hop_failures, target_edge_id);
            return false;
        }
    }

    let mut pkt = Vec::with_capacity(1 + 4 + payload.len());
    pkt.push(EDGE_PKT_VOICE);
    pkt.extend_from_slice(&session.to_be_bytes());
    pkt.extend_from_slice(payload);

    match edge_socket.send_to(&pkt, target_addr).await {
        Ok(_) => {
            reset_hop_failure(
                &edge_state.next_hop_failures,
                target_edge_id,
                edge_state.consecutive_failure_threshold,
            );
            true
        }
        Err(_) => {
            increment_hop_failure(&edge_state.next_hop_failures, target_edge_id);
            false
        }
    }
}

/// Test-only: send a single relay voice packet via UDP in the `EDGE_PKT_RELAY` wire format.
///
/// Wire format: `[0x02][ttl(1)][target_edge_id_BE(4)][sender_session_BE(4)][payload...]`
///
/// This mirrors exactly what `route_voice()` sends for `RouteDecision::RelayChain`.
/// The receiver parses it as an incoming relay hop (EDGE_PKT_RELAY branch in `run()`).
///
/// Returns `true` if the socket send succeeded.
///
/// Used by integration tests in `tests/voice_routing.rs` to verify the relay
/// packet wire format without requiring a full `UdpServer` stack.
#[cfg(feature = "test-utils")]
pub async fn test_send_relay_packet(
    edge_socket: Arc<tokio::net::UdpSocket>,
    target_edge_id: u32,
    target_addr: std::net::SocketAddr,
    sender_session: u32,
    ttl: u8,
    payload: &[u8],
) -> bool {
    let mut pkt = Vec::with_capacity(1 + 1 + 4 + 4 + payload.len());
    pkt.push(EDGE_PKT_RELAY); // 0x02
    pkt.push(ttl);
    pkt.extend_from_slice(&target_edge_id.to_be_bytes());
    pkt.extend_from_slice(&sender_session.to_be_bytes());
    pkt.extend_from_slice(payload);
    edge_socket.send_to(&pkt, target_addr).await.is_ok()
}
