use bytes::{Bytes, BytesMut};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::collections::VecDeque;
use std::time::Duration;
#[cfg(target_os = "linux")]
use std::os::unix::io::AsRawFd;

use anyhow::Result;

use dashmap::DashMap;
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tracing::{debug, info, warn, trace};
use async_channel;

use munode_protocol::transport::EDGE_MAGIC;

use crate::hub_client::HubClient;
use crate::hot_slot::get_hot_slot;
use crate::state::EdgeState;

// ── Edge-to-Edge packet type bytes (1-byte prefix on the dedicated edge socket) ─────────────────
//
// Because the `edge_socket` is bound to a **dedicated** `edge_port` separate from the
// client-facing Mumble port, every datagram received on it is already known to be
// Edge-to-Edge traffic.  A single type byte is therefore sufficient to distinguish the
// three packet sub-types; no 2-byte magic prefix is needed.
//
// Wire formats on `edge_socket`:
//
//   Voice (direct, for this Edge):
//     [0x01][sender_session BE(4B)][raw plaintext voice...]
//     Overhead: 5 bytes total header (1 type + 4 session)
//
//   Relay-forward (this Edge is the intermediary; forward to target Edge):
//     [0x02][ttl(1B)][target_edge_id BE(4B)][sender_session BE(4B)][raw plaintext voice...]
//     Overhead: 10 bytes total header (1 type + 1 ttl + 4 target + 4 session)
//     The relay node reads ttl, drops if 0, delivers locally if target==self, or
//     queries own route table and forwards with ttl-1 to next hop.
//
//   Quality probe (ping / pong):
//     [0x03][subtype(1B): 0=ping 1=pong][seq BE(4B)][sent_ms BE(8B)]
//     Total: 14 bytes
//
//   Encrypted direct voice (ChaCha20-Poly1305, requires hmac_secret):
//     [0x11][sender_edge_id BE(4B)][counter BE(8B)][ChaCha20enc(session_id BE(4B) + voice) + Poly1305tag(16B)]
//     Overhead: 13 bytes plain header + 20 bytes AEAD overhead (4 session + 16 tag)
//     Nonce = [sender_edge_id BE(4)][counter BE(8)].  Empty AAD.
//     Encrypt-once broadcast: same ciphertext sent to all direct UDP peers.
//
//   Encrypted relay-forward (routing headers plaintext, payload AEAD-protected):
//     [0x12][sender_edge_id BE(4B)][counter BE(8B)][ttl(1B)][target_edge_id BE(4B)]
//            [ChaCha20enc(session_id BE(4B) + voice) + Poly1305tag(16B)]
//     Overhead: 18 bytes plain header + 20 bytes AEAD overhead.
//     Empty AAD (same as 0x11). Edges are cluster-internal trusted nodes so routing
//     metadata authentication is unnecessary.  Same ciphertext can be reused across
//     relay packets to different targets — only the plain header fields differ.
//
// Legacy / fallback (shared socket — no dedicated edge_port):
//   When `edge_socket` is the same fd as `socket` (the Mumble client port), the old
//   `EDGE_MAGIC=[0x00,0x00]` two-byte prefix is still used in `handle_client_datagram`
//   so that edge packets can be disambiguated from encrypted OCB2 client datagrams.
//   In that mode only direct-voice forwarding is supported; relay and probe are not.

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
/// Overhead of the Poly1305 authentication tag appended to every encrypted payload.
const AEAD_TAG_LEN: usize = 16;

/// How often to send UDP ping probes to peer Edges (seconds).
/// 10 s gives a reasonable balance: fresh enough to catch a link quality change
/// within half a minute, but light enough that probes are <1% of voice traffic.
const PROBE_PING_INTERVAL_SECS: u64 = 10;

/// How often to report accumulated quality metrics to Hub (seconds).
/// 30 s keeps Hub-side route tables up-to-date within one minute while avoiding
/// a flood of RPC calls during the probe window.
const PROBE_REPORT_INTERVAL_SECS: u64 = 30;

/// Maximum number of RTT samples kept per peer for the rolling average.
const MAX_RTT_SAMPLES: usize = 10;

/// Per-edge quality tracking state.
#[derive(Default)]
struct PeerQualityState {
    /// Pending ping sequences: seq → sent_ms
    pending_pings: HashMap<u32, u64>,
    /// Recent RTT samples (milliseconds); capped at MAX_RTT_SAMPLES
    rtt_samples: VecDeque<f32>,
    /// Total probes sent in current window
    probes_sent: u32,
    /// Pongs received in current window
    pongs_received: u32,
    /// Next sequence number to use
    next_seq: u32,
}

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
}

impl UdpServer {
    pub async fn new(
        client_addr: SocketAddr,
        edge_addr: SocketAddr,
        edge_state: Arc<EdgeState>,
        hub_client: Arc<HubClient>,
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

        let (client_tx, client_rx) = async_channel::bounded(65536);
        let (relay_tx, relay_rx) = async_channel::bounded(4096);

        Ok(Self {
            socket,
            edge_socket,
            addr_to_session: Arc::new(DashMap::new()),
            session_to_addr: Arc::clone(&edge_state.udp_session_to_addr),
            edge_state,
            hub_client,
            peer_quality: Arc::new(Mutex::new(HashMap::new())),
            client_tx,
            client_rx,
            relay_tx,
            relay_rx,
        })
    }

    /// Register a client's UDP address.
    pub fn register_client(&self, session_id: u32, addr: SocketAddr) {
        self.addr_to_session.insert(addr, session_id);
        self.session_to_addr.insert(session_id, addr);
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
            tokio::spawn(async move {
                let mut ping_interval = tokio::time::interval(Duration::from_secs(PROBE_PING_INTERVAL_SECS));
                let mut report_interval = tokio::time::interval(Duration::from_secs(PROBE_REPORT_INTERVAL_SECS));
                loop {
                    tokio::select! {
                        _ = ping_interval.tick() => {
                            let peers = {
                                probe_state.peer_registry.load().all_udp_peers()
                            };
                            let now_ms = probe_current_millis();
                            for (peer_id, peer_addr) in peers {
                                let seq = {
                                    let mut pq = probe_quality.lock().await;
                                    let entry = pq.entry(peer_id).or_default();
                                    entry.probes_sent += 1;
                                    entry.next_seq = entry.next_seq.wrapping_add(1);
                                    let s = entry.next_seq;
                                    entry.pending_pings.insert(s, now_ms);
                                    s
                                };
                                let mut pkt = Vec::with_capacity(1 + 1 + 4 + 8);
                                pkt.push(EDGE_PKT_PROBE);
                                pkt.push(0); // subtype=ping
                                pkt.extend_from_slice(&seq.to_be_bytes());
                                pkt.extend_from_slice(&now_ms.to_be_bytes());
                                let _ = probe_udp.send_to(&pkt, peer_addr).await;
                            }
                        }
                        _ = report_interval.tick() => {
                            let my_edge_id = probe_state.get_edge_id();
                            if my_edge_id == 0 { continue; }
                            let entries: Vec<(u32, f32, f32)> = {
                                let mut pq = probe_quality.lock().await;
                                let result = pq.iter().map(|(&eid, pqs)| {
                                    let rtt = if pqs.rtt_samples.is_empty() { 0.0 } else {
                                        pqs.rtt_samples.iter().sum::<f32>() / pqs.rtt_samples.len() as f32
                                    };
                                    let loss = if pqs.probes_sent == 0 { 0.0 } else {
                                        1.0 - (pqs.pongs_received as f32 / pqs.probes_sent as f32)
                                    };
                                    (eid, rtt, loss.clamp(0.0, 1.0))
                                }).collect();
                                for pqs in pq.values_mut() {
                                    pqs.probes_sent = 0;
                                    pqs.pongs_received = 0;
                                    pqs.pending_pings.clear();
                                }
                                result
                            };
                            for (target_edge_id, rtt, loss) in entries {
                                probe_hub.report_quality(target_edge_id, rtt, loss, 0.0, 10).await;
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
                                        EDGE_PKT_RELAY => worker_server.handle_relay_packet(data.as_ref()).await,
                                        EDGE_PKT_ENC_VOICE => worker_server.handle_enc_voice_packet(data.as_ref(), peer_addr).await,
                                        EDGE_PKT_ENC_RELAY => worker_server.handle_enc_relay_packet(data.as_ref()).await,
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
                            // Direct voice for this Edge: [0x01][session_BE(4)][voice...]
                            EDGE_PKT_VOICE if len >= 6 => {
                                let _ = self.relay_tx.send((EDGE_PKT_VOICE, data.slice(1..), peer_addr)).await;
                            }
                            // Relay-forward: [0x02][target_BE(4)][session_BE(4)][voice...]
                            EDGE_PKT_RELAY if len >= 10 => {
                                let _ = self.relay_tx.send((EDGE_PKT_RELAY, data.slice(1..), peer_addr)).await;
                            }
                            // Quality probe: [0x03][subtype(1)][seq_BE(4)][ts_BE(8)]
                            // Probes are tiny and latency-sensitive; handle inline in recv loop.
                            EDGE_PKT_PROBE if len >= 14 => {
                                self.handle_probe_packet(&data[1..], peer_addr).await;
                            }
                            // Encrypted direct voice: [0x11][sender_edge_id_BE(4)][counter_BE(8)][enc(session_BE(4)+voice)+tag(16)]
                            EDGE_PKT_ENC_VOICE if len >= 33 => {
                                let _ = self.relay_tx.send((EDGE_PKT_ENC_VOICE, data.slice(1..), peer_addr)).await;
                            }
                            // Encrypted relay: [0x12][sender_edge_id_BE(4)][counter_BE(8)][ttl(1)][target_BE(4)][enc(session_BE(4)+voice)+tag(16)]
                            EDGE_PKT_ENC_RELAY if len >= 38 => {
                                let _ = self.relay_tx.send((EDGE_PKT_ENC_RELAY, data.slice(1..), peer_addr)).await;
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

    #[inline]
    fn encrypt_for_addr(&self, target: u32, addr: SocketAddr, plaintext: &[u8]) -> Option<(Vec<u8>, SocketAddr)> {
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
        if data.len() == 12
            && data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 0
        {
            if self.edge_state.allow_ping.load(std::sync::atomic::Ordering::Relaxed) {
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
                    debug!("Failed to send legacy UDP ping response to {}: {}", peer_addr, e);
                } else {
                    debug!("Responded to legacy UDP ping from {}", peer_addr);
                }
            }
            return true;
        }

        // ── Protobuf ping: first byte == 0x01 (UDPMessageType::Ping) ─────────
        if data.len() >= 2 && data[0] == 0x01 {
            if self.edge_state.allow_ping.load(std::sync::atomic::Ordering::Relaxed) {
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
                    debug!("Failed to send protobuf UDP ping response to {}: {}", peer_addr, e);
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
        let remote = self.edge_state.channel_manager.get_all_remote_users().await.len();
        // max_users and max_bandwidth are mirrored as AtomicU32 (lock-free reads).
        let max_users = self.edge_state.max_users.load(std::sync::atomic::Ordering::Relaxed) as usize;
        let bandwidth = self.edge_state.max_bandwidth_bps.load(std::sync::atomic::Ordering::Relaxed);
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

        // Edge-to-Edge packet on client port (fallback when no dedicated edge port)
        if data.len() >= 2 && data[0] == EDGE_MAGIC[0] && data[1] == EDGE_MAGIC[1] {
            self.handle_edge_packet(&data[2..], peer_addr).await;
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
                debug!("No CryptState in HotSlot for {} — UDP packet dropped", session_id);
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
                debug!("No BandwidthRecord in HotSlot for {} — UDP packet dropped", session_id);
                return;
            }
        };

        // ── Rate-limit check BEFORE decrypt ────────────────────────────────────
        // Encrypted size = plaintext size + 4 (OCB2 tag), so:
        //   data.len() + 28  ≡  plaintext.len() + 32  (IP 20 + UDP 8 overhead)
        // Performing the check here avoids AES work entirely when a client is
        // bursting (packet backlog) or being used as an amplification source.
        {
            let max_bps = self.edge_state.max_bandwidth_bps.load(std::sync::atomic::Ordering::Relaxed);
            if max_bps > 0 {
                let max_bytes = max_bps / 8;
                let window_secs = (self.edge_state.rolling_stats_window
                    .load(std::sync::atomic::Ordering::Relaxed) as usize)
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
                    trace!("Rate limit exceeded for session {} — dropping {} B before decrypt", session_id, data.len());
                    return;
                }
            }
        }

        let plaintext = {
            let mut cs = match crypt_arc.lock() {
                Ok(cs) => cs,
                Err(e) => {
                    warn!("CryptState mutex poisoned for session {} — packet dropped: {}", session_id, e);
                    return;
                }
            };
            let mut plain = Vec::new();
            if !cs.decrypt(data, &mut plain) {
                debug!("OCB2 decrypt failed for session {} ({} bytes)", session_id, data.len());
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
            if self.edge_state.allow_ping.load(std::sync::atomic::Ordering::Relaxed) {
                self.send_encrypted(session_id, &plaintext).await;
            }
        } else {
            // Rate check already done above; pass None to skip it in route_voice.
            self.route_voice(session_id, &plaintext, sender_channel, suppress, muted, None).await;
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

        // Build the set of already-mapped sessions for quick exclusion.
        let already_mapped: std::collections::HashSet<u32> = {
            self.session_to_addr.iter().map(|r| *r.key()).collect()
        };

        // Single lock: get all session candidates for identification.
        let candidates = self.edge_state.client_manager
            .get_udp_identification_candidates(&already_mapped)
            .await;

        for (session_id, cs_arc, sender_channel, suppress, mute, self_mute, bw_arc) in candidates {
            let mut plain = Vec::new();
            let identified = {
                let mut cs = match cs_arc.lock() {
                    Ok(cs) => cs,
                    Err(e) => {
                        warn!("CryptState mutex poisoned for session {} — packet dropped: {}", session_id, e);
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
                    if self.edge_state.allow_ping.load(std::sync::atomic::Ordering::Relaxed) {
                        self.send_encrypted(session_id, &plain).await;
                    }
                } else {
                    self.route_voice(session_id, &plain, sender_channel, suppress, mute || self_mute, Some(bw_arc)).await;
                }
                return;
            }
            // Failed decrypt leaves the state unchanged (decrypt() restores IV)
        }

        debug!("Unidentified UDP packet from {} ({} bytes)", peer_addr, data.len());
    }

    /// Route decrypted voice to channel members, encrypting per-recipient.
    /// Also relays to remote users (on other edges) via Hub TCP.
    ///
    /// `sender_channel`, `suppress`, `muted`, and `bw_arc` are pre-fetched by the caller.
    /// `muted` is `true` when the sender is server-muted or self-muted.
    /// Pass `Some(bw_arc)` to perform the rate-limit check here (identify path).
    /// Pass `None` when the caller has already checked before decrypt (hot path).
    async fn route_voice(&self, sender_session: u32, plaintext: &[u8], sender_channel: u32, suppress: bool, muted: bool, bw_arc: Option<Arc<std::sync::Mutex<crate::bandwidth::BandwidthRecord>>>) {
        trace!("route_voice: session={} channel={}", sender_session, sender_channel);

        // Rate-limit check: only runs when bw_arc is Some (identify path).
        // For the hot path (handle_known_client) this was already checked before decrypt.
        if let Some(bw_arc) = bw_arc {
            let window_secs = (self.edge_state.rolling_stats_window.load(std::sync::atomic::Ordering::Relaxed) as usize)
                .min(crate::bandwidth::MAX_WINDOW_SLOTS);
            let max_bps = self.edge_state.max_bandwidth_bps.load(std::sync::atomic::Ordering::Relaxed);
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
        let voice_target = if !plaintext.is_empty() { (plaintext[0] & 0x1F) as u32 } else { 0 };
        if (suppress || muted) && voice_target != 31 {
            return;
        }

        // Lock-free read of our own edge ID (AtomicU32).
        let my_edge_id = self.edge_state.get_edge_id();

        // --- Shared routing: compute target sessions and relay edges ---
        // `compute_voice_targets` handles VoiceTarget lookup, channel expansion,
        // deaf/suppress filtering.  Returns None for loopback (31) → drop.
        let Some(targets) = crate::routing::compute_voice_targets(
            plaintext, sender_session, sender_channel, &self.edge_state, &self.hub_client,
        ).await else {
            return; // loopback or no VoiceTarget config
        };

        // --- Local delivery ------------------------------------------------
        if targets.is_whisper {
            // Build separate payloads for each Mumble AudioContext, mirroring murmur's
            // processMsg() which sets audioData.targetOrContext per receiver:
            //   WHISPER (2) for direct session targets
            //   SHOUT   (1) for channel-expanded targets
            let forwarded_whisper = crate::voice::inject_session_into_voice(plaintext, sender_session, 2);
            let forwarded_shout   = crate::voice::inject_session_into_voice(plaintext, sender_session, 1);

            // Phase A-direct: encrypt WHISPER targets (direct_sessions).
            // Each Mumble session has a unique AES-128 key negotiated during TCP auth,
            // so OCB2 ciphertext differs per recipient — one encrypt call per target
            // is unavoidable. We reuse ENC_BUF to avoid per-target Vec allocation.
            let mut direct_batch: Vec<(Vec<u8>, SocketAddr)> =
                Vec::with_capacity(targets.direct_sessions.len());
            let mut direct_no_udp: Vec<u32> = Vec::new();

            for &target in &targets.direct_sessions {
                let addr_opt = self.session_to_addr.get(&target).map(|r| *r.value());
                if let Some(addr) = addr_opt {
                    if let Some(packet) = self.encrypt_for_addr(target, addr, &forwarded_whisper) {
                        direct_batch.push(packet);
                    }
                } else {
                    direct_no_udp.push(target);
                }
            }

            // Phase A-shout: encrypt SHOUT targets (channel_sessions).
            let mut shout_batch: Vec<(Vec<u8>, SocketAddr)> =
                Vec::with_capacity(targets.channel_sessions.len());
            let mut shout_no_udp: Vec<u32> = Vec::new();

            for &target in &targets.channel_sessions {
                let addr_opt = self.session_to_addr.get(&target).map(|r| *r.value());
                if let Some(addr) = addr_opt {
                    if let Some(packet) = self.encrypt_for_addr(target, addr, &forwarded_shout) {
                        shout_batch.push(packet);
                    }
                } else {
                    shout_no_udp.push(target);
                }
            }

            // Phase B: batch send — WHISPER targets → 1 sendmmsg syscall.
            if !direct_batch.is_empty() {
                #[cfg(target_os = "linux")]
                { batch_sendmmsg(self.socket.as_raw_fd(), &direct_batch); }
                #[cfg(not(target_os = "linux"))]
                { batch_sendmmsg_fallback_seq(&self.socket, &direct_batch); }
            }

            // Phase B: batch send — SHOUT targets → 1 sendmmsg syscall.
            if !shout_batch.is_empty() {
                #[cfg(target_os = "linux")]
                { batch_sendmmsg(self.socket.as_raw_fd(), &shout_batch); }
                #[cfg(not(target_os = "linux"))]
                { batch_sendmmsg_fallback_seq(&self.socket, &shout_batch); }
            }

            // Phase C: TCP fallbacks.
            for target in direct_no_udp {
                self.fallback_to_tcp(target, &forwarded_whisper).await;
            }
            for target in shout_no_udp {
                self.fallback_to_tcp(target, &forwarded_shout).await;
            }
        } else {
            // Normal broadcast: local_sessions already deaf-filtered by compute_voice_targets.
            trace!("route_voice: {} local targets", targets.local_sessions.len());
            // Phase A: encrypt all targets into a batch (synchronous, no await).
            // context=0 → NORMAL speech (PTT), matching murmur's AudioContext::NORMAL.
            let forwarded = crate::voice::inject_session_into_voice(plaintext, sender_session, 0);
            let mut client_batch: Vec<(Vec<u8>, SocketAddr)> =
                Vec::with_capacity(targets.local_sessions.len());
            let mut no_udp_targets: Vec<u32> = Vec::new();

            for &target in &targets.local_sessions {
                let addr_opt = self.session_to_addr.get(&target).map(|r| *r.value());
                if let Some(addr) = addr_opt {
                    if let Some(packet) = self.encrypt_for_addr(target, addr, &forwarded) {
                        client_batch.push(packet);
                    }
                } else {
                    no_udp_targets.push(target);
                }
            }

            // Phase B: batch send — M local users → 1 sendmmsg syscall.
            #[cfg(target_os = "linux")]
            {
                let sent = batch_sendmmsg(self.socket.as_raw_fd(), &client_batch);
                if sent < client_batch.len() {
                    debug!(
                        "sendmmsg partial: sent {}/{} UDP packets to local sessions",
                        sent, client_batch.len()
                    );
                    // Partial failure: packets [sent..] were not delivered.
                    // Voice is best-effort UDP; they'll be retried on the next frame.
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                let sent = batch_sendmmsg_fallback_seq(&self.socket, &client_batch);
                if sent < client_batch.len() {
                    debug!("seq-send partial: sent {}/{}", sent, client_batch.len());
                }
            }

            // Phase C: TCP fallbacks for sessions with no registered UDP address (rare).
            for target in no_udp_targets {
                self.fallback_to_tcp(target, &forwarded).await;
            }
        }

        // relay_payload preserves the original voice_target_id in low 5 bits so remote edges
        // can look up their own VoiceTarget config and apply correct AudioContext per recipient.
        let relay_payload = crate::voice::inject_session_into_voice(plaintext, sender_session, voice_target as u8);
        if targets.relay_edge_ids.is_empty() {
            return;
        }

        // Pre-encrypt once if crypto is configured — same ciphertext goes to ALL peers
        // (both direct and relay) because all Edges share the same key and are mutually
        // trusted cluster-internal nodes.  The nonce encodes sender_edge_id + counter,
        // so it is unique even when multiple Edges encrypt simultaneously.
        // Plaintext: [session_id_BE(4)][voice_payload] — matches edge packet body.
        let enc_direct: Option<(u64, Vec<u8>)> = if let Some(crypto) = &self.edge_state.edge_crypto {
            let mut plain = Vec::with_capacity(4 + plaintext.len());
            plain.extend_from_slice(&sender_session.to_be_bytes());
            plain.extend_from_slice(plaintext);
            // Empty AAD: ciphertext is peer-independent (encrypt-once broadcast).
            Some(crypto.encrypt_owned(plain, my_edge_id, &[]))
        } else {
            None
        };

        let threshold = self.edge_state.consecutive_failure_threshold;
        let max_ttl = self.edge_state.max_ttl.load(std::sync::atomic::Ordering::Relaxed);

        use crate::state::RouteDecision;

        // Phase A: decide routing for each target edge (sync, no await).
        // UDP packets are collected for a single batch sendmmsg; TCP paths are
        // collected separately and handled after the batch.
        //
        // Packet bytes and success-tracking metadata are stored in parallel Vecs so
        // the sendmmsg call can borrow the original packet buffers directly.
        let (edge_send_pkts, edge_meta, hub_tcp_targets) = {
            let route_guard = self.edge_state.route_table.load();
            let peer_guard = self.edge_state.peer_registry.load();
            let voice_tcp_conns = self.edge_state.voice_tcp_conns.load();
            let failures_guard = self.edge_state.next_hop_failures.read().ok();

            let mut edge_send_pkts: Vec<(Vec<u8>, SocketAddr)> = Vec::new();
            let mut edge_meta: Vec<(u32, u32)> = Vec::new();
            let mut hub_tcp_targets: Vec<u32> = Vec::new();

            for &target_edge_id in &targets.relay_edge_ids {
                debug!("edge={} UDP voice: routing from session {} to edge {}",
                    my_edge_id, sender_session, target_edge_id);

                let decision = route_guard.get(&target_edge_id).and_then(|candidates| {
                    candidates
                        .iter()
                        .find(|candidate| {
                            let next_hop_id = match &candidate.decision {
                                RouteDecision::DirectUdp => Some(target_edge_id),
                                RouteDecision::RelayChain { hops, .. } => hops.first().copied(),
                                _ => None,
                            };
                            let fail_count = next_hop_id
                                .and_then(|id| {
                                    failures_guard.as_ref().and_then(|failures| {
                                        failures.get(&id).map(|a| a.load(std::sync::atomic::Ordering::Relaxed))
                                    })
                                })
                                .unwrap_or(0);
                            threshold == 0 || fail_count < threshold
                        })
                        .or_else(|| candidates.first())
                        .map(|candidate| &candidate.decision)
                });

                match decision {
                    Some(RouteDecision::DirectUdp) | Some(RouteDecision::RelayChain { .. }) | None => {
                        let (next_hop, send_addr) = match decision {
                            Some(RouteDecision::RelayChain { hops, .. }) if !hops.is_empty() => {
                                (hops[0], peer_guard.get(hops[0]).map(|p| p.udp_addr))
                            }
                            _ => (target_edge_id, peer_guard.get(target_edge_id).map(|p| p.udp_addr)),
                        };
                        let ttl_for_relay: Option<u8> = match decision {
                            Some(RouteDecision::RelayChain { hops, .. }) if !hops.is_empty() => {
                                Some(((hops.len() as u32 + 1).min(max_ttl).min(255)) as u8)
                            }
                            _ => None,
                        };

                        if let Some(addr) = send_addr {
                            let pkt: Vec<u8> = if let Some((counter, ciphertext)) = enc_direct.as_ref() {
                                if ttl_for_relay.is_some() {
                                    let ttl = ttl_for_relay.unwrap();
                                    let mut p = Vec::with_capacity(1 + 4 + 8 + 1 + 4 + ciphertext.len());
                                    p.push(EDGE_PKT_ENC_RELAY);
                                    p.extend_from_slice(&my_edge_id.to_be_bytes());
                                    p.extend_from_slice(&counter.to_be_bytes());
                                    p.push(ttl);
                                    p.extend_from_slice(&target_edge_id.to_be_bytes());
                                    p.extend_from_slice(ciphertext);
                                    p
                                } else {
                                    let mut p = Vec::with_capacity(1 + 4 + 8 + ciphertext.len());
                                    p.push(EDGE_PKT_ENC_VOICE);
                                    p.extend_from_slice(&my_edge_id.to_be_bytes());
                                    p.extend_from_slice(&counter.to_be_bytes());
                                    p.extend_from_slice(ciphertext);
                                    p
                                }
                            } else if ttl_for_relay.is_some() {
                                let ttl = ttl_for_relay.unwrap();
                                let mut p = Vec::with_capacity(1 + 1 + 4 + 4 + plaintext.len());
                                p.push(EDGE_PKT_RELAY);
                                p.push(ttl);
                                p.extend_from_slice(&target_edge_id.to_be_bytes());
                                p.extend_from_slice(&sender_session.to_be_bytes());
                                p.extend_from_slice(plaintext);
                                p
                            } else {
                                let mut p = Vec::with_capacity(1 + 4 + plaintext.len());
                                p.push(EDGE_PKT_VOICE);
                                p.extend_from_slice(&sender_session.to_be_bytes());
                                p.extend_from_slice(plaintext);
                                p
                            };
                            edge_send_pkts.push((pkt, addr));
                            edge_meta.push((target_edge_id, next_hop));
                        } else if self.edge_state.enable_hub_tcp_fallback {
                            hub_tcp_targets.push(target_edge_id);
                        }
                    }
                    Some(RouteDecision::HubTcp) => {
                        if self.edge_state.enable_hub_tcp_fallback {
                            hub_tcp_targets.push(target_edge_id);
                        }
                    }
                    Some(RouteDecision::DirectTcp) => {
                        let sent = if let Some(pool) = voice_tcp_conns.get(&target_edge_id) {
                            let mut frame = Vec::with_capacity(1 + 4 + plaintext.len());
                            frame.push(EDGE_PKT_VOICE);
                            frame.extend_from_slice(&sender_session.to_be_bytes());
                            frame.extend_from_slice(plaintext);
                            pool.try_send(frame)
                        } else {
                            false
                        };
                        if !sent && self.edge_state.enable_hub_tcp_fallback {
                            hub_tcp_targets.push(target_edge_id);
                        }
                    }
                }
            }

            (edge_send_pkts, edge_meta, hub_tcp_targets)
        };

        // Phase B: batch send all edge UDP packets — N edges → 1 sendmmsg syscall.
        if !edge_send_pkts.is_empty() {
            let sent_count;
            #[cfg(target_os = "linux")]
            { sent_count = batch_sendmmsg(self.edge_socket.as_raw_fd(), &edge_send_pkts); }
            #[cfg(not(target_os = "linux"))]
            { sent_count = batch_sendmmsg_fallback_seq(&self.edge_socket, &edge_send_pkts); }

            // Update hop-success counters for sent packets.
            for (target_id, next_hop) in &edge_meta[..sent_count] {
                reset_hop_failure(&self.edge_state.next_hop_failures, *next_hop, threshold);
                debug!("Voice dispatched to edge {} (via next-hop {})", target_id, next_hop);
            }
            // Partial failure: fall back unsent packets to Hub TCP.
            if sent_count < edge_meta.len() && self.edge_state.enable_hub_tcp_fallback {
                warn!(
                    "edge sendmmsg partial: sent {}/{}, falling back {} to Hub TCP",
                    sent_count, edge_meta.len(), edge_meta.len() - sent_count
                );
                for (target_id, next_hop) in &edge_meta[sent_count..] {
                    increment_hop_failure(&self.edge_state.next_hop_failures, *next_hop);
                    self.hub_client.relay_voice_via_hub(*target_id, relay_payload.clone()).await;
                }
            }
        }

        // Phase C: Hub TCP relay targets (async).
        for target_id in hub_tcp_targets {
            self.hub_client.relay_voice_via_hub(target_id, relay_payload.clone()).await;
        }
    }

    /// Send encrypted data to a specific session's UDP address.
    async fn send_encrypted(&self, session_id: u32, plaintext: &[u8]) {
        let addr = match self.session_to_addr.get(&session_id).map(|r| *r.value()) {
            Some(a) => a,
            None => return,
        };
        let slot = get_hot_slot(session_id);
        if !slot.is_active_for(session_id) { return; }
        let cs_guard = slot.crypt_state.load();
        if let Some(cs_arc) = &**cs_guard {
            let mut encrypted = Vec::new();
            match cs_arc.lock() {
                Ok(mut cs) => { cs.encrypt(plaintext, &mut encrypted); }
                Err(e) => {
                    warn!("CryptState mutex poisoned for session {} — packet dropped: {}", session_id, e);
                    return;
                }
            }
            let _ = self.socket.send_to(&encrypted, addr).await;
        }
    }

    /// Deliver voice via TCP UDPTunnel (no encryption — TLS handles it).
    async fn fallback_to_tcp(&self, session_id: u32, plaintext: &[u8]) {
        let data = crate::voice::wrap_udptunnel(plaintext);
        let slot = get_hot_slot(session_id);
        if !slot.is_active_for(session_id) { return; }
        let sender_guard = slot.sender.load();
        if let Some(sender) = &**sender_guard {
            sender.try_send(data).ok();
        }
    }

    /// Handle an encrypted direct-voice packet (type `0x11`).
    ///
    /// Wire format after stripping the type byte:
    ///   `[sender_edge_id_BE(4)][nonce_counter_BE(8)][ChaCha20_enc(session_id_BE(4) + voice) + Poly1305_tag(16)]`
    ///
    /// On AEAD success the decrypted `[session_id_BE(4)][voice]` payload is fed into
    /// `handle_edge_packet`, which delivers to local clients via OCB2-UDP or TCP tunnel.
    async fn handle_enc_voice_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        let crypto = match &self.edge_state.edge_crypto {
            Some(c) => c,
            None => {
                debug!("Received encrypted edge voice but no edge_crypto configured");
                return;
            }
        };
        // Minimum after type byte: sender_edge_id(4) + counter(8) + session(4) + tag(16) = 32
        if data.len() < 4 + 8 + 4 + AEAD_TAG_LEN {
            return;
        }
        let sender_edge_id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let counter = u64::from_be_bytes([data[4], data[5], data[6], data[7], data[8], data[9], data[10], data[11]]);
        let ciphertext = &data[12..];
        match crypto.decrypt(sender_edge_id, counter, ciphertext, &[]) {
            Some(plain) if plain.len() >= 4 => {
                // plain = [session_id_BE(4)][voice_payload] — identical to unencrypted format
                self.handle_edge_packet(&plain, peer_addr).await;
            }
            Some(_) => debug!("Encrypted edge voice: decrypted payload too short from edge {}", sender_edge_id),
            None => debug!("Encrypted edge voice: AEAD authentication failed from edge {}", sender_edge_id),
        }
    }

    /// Handle an encrypted relay-forward packet (type `0x12`).
    ///
    /// Wire format after stripping the type byte:
    ///   `[sender_edge_id_BE(4)][nonce_counter_BE(8)][ttl(1)][target_edge_id_BE(4)]`
    ///   `[ChaCha20_enc(session_id_BE(4) + voice) + Poly1305_tag(16)]`
    ///
    /// Empty AAD — Edges are cluster-internal trusted nodes; routing header integrity
    /// is not verified by AEAD (same trust model as direct voice 0x11).
    async fn handle_enc_relay_packet(&self, data: &[u8]) {
        // Minimum: sender_edge_id(4) + counter(8) + ttl(1) + target(4) + session(4) + tag(16) = 37
        if data.len() < 4 + 8 + 1 + 4 + 4 + AEAD_TAG_LEN {
            return;
        }
        let sender_edge_id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let counter = u64::from_be_bytes([data[4], data[5], data[6], data[7], data[8], data[9], data[10], data[11]]);
        let ttl = data[12];
        let target_edge_id = u32::from_be_bytes([data[13], data[14], data[15], data[16]]);
        let ciphertext = &data[17..];

        let my_edge_id = self.edge_state.get_edge_id();

        // Drop the packet if our edge_id is not yet known — we cannot verify it was meant for us.
        if my_edge_id == 0 {
            debug!("Encrypted relay dropped: local edge_id not yet initialized");
            return;
        }

        if target_edge_id == my_edge_id {
            // Destined for this Edge — decrypt and deliver locally.
            let crypto = match &self.edge_state.edge_crypto {
                Some(c) => c,
                None => {
                    debug!("Encrypted relay destined for us but no edge_crypto configured");
                    return;
                }
            };
            match crypto.decrypt(sender_edge_id, counter, ciphertext, &[]) {
                Some(plain) if plain.len() >= 4 => {
                    // plain = [session_id_BE(4)][voice_payload]
                    let dummy_addr = std::net::SocketAddr::from(([0, 0, 0, 0], 0));
                    self.handle_edge_packet(&plain, dummy_addr).await;
                }
                Some(_) => debug!("Encrypted relay: decrypted payload too short from edge {}", sender_edge_id),
                None => debug!("Encrypted relay: AEAD authentication failed from edge {}", sender_edge_id),
            }
            return;
        }

        // Forward to next hop — relay intermediary path.
        if ttl == 0 {
            debug!("Encrypted relay dropped: TTL=0, target={}", target_edge_id);
            return;
        }
        // Rebuild the packet with TTL decremented; ciphertext is forwarded unchanged.
        // [0x12][sender_edge_id(4)][counter(8)][ttl-1(1)][target(4)][ciphertext]
        let mut forward = Vec::with_capacity(1 + 4 + 8 + 1 + 4 + ciphertext.len());
        forward.push(EDGE_PKT_ENC_RELAY);
        forward.extend_from_slice(&sender_edge_id.to_be_bytes());
        forward.extend_from_slice(&counter.to_be_bytes());
        forward.push(ttl - 1);
        forward.extend_from_slice(&target_edge_id.to_be_bytes());
        forward.extend_from_slice(ciphertext);

        let target_addr = {
            // ArcSwap load: lock-free, no need for try_read.
            let table = self.edge_state.route_table.load();
            let reg = self.edge_state.peer_registry.load();
            match table.get(&target_edge_id).and_then(|cs| cs.first()).map(|c| &c.decision) {
                Some(crate::state::RouteDecision::RelayChain { hops, .. }) if !hops.is_empty() => {
                    reg.get(hops[0]).map(|p| p.udp_addr)
                }
                _ => reg.get(target_edge_id).map(|p| p.udp_addr),
            }
        };

        if let Some(addr) = target_addr {
            if let Err(e) = self.edge_socket.send_to(&forward, addr).await {
                warn!("Forward encrypted relay to edge {} failed: {}", target_edge_id, e);
            } else {
                debug!("Forwarded encrypted relay to edge {} (ttl={})", target_edge_id, ttl - 1);
            }
        } else {
            debug!("Encrypted relay target edge {} not in peer registry — dropping", target_edge_id);
        }
    }

    /// Handle a relay-forward packet received on the edge socket.
    ///
    /// Format after stripping the type byte:
    ///   [ttl(1B)][target_edge_id BE(4B)][sender_session BE(4B)][voice...]
    ///
    /// If TTL == 0: drop. If target == my_edge_id: deliver locally.
    /// Otherwise: query own route table, decrement TTL, forward to next hop.
    async fn handle_relay_packet(&self, data: &[u8]) {
        // Minimum: 1 (ttl) + 4 (target_edge_id) + 4 (sender_session) + 1 (voice) = 10
        if data.len() < 10 {
            debug!("Relay packet too short ({} bytes)", data.len());
            return;
        }
        let ttl = data[0];
        if ttl == 0 {
            debug!("Relay packet TTL expired — dropping");
            return;
        }
        let target_edge_id = u32::from_be_bytes([data[1], data[2], data[3], data[4]]);
        let sender_session = u32::from_be_bytes([data[5], data[6], data[7], data[8]]);
        let voice_data = &data[9..];

        let my_edge_id = self.edge_state.get_edge_id();
        // Drop relay packets until we have a registered edge_id.  Without this guard,
        // a spoofed packet with target_edge_id=0 would be misdelivered locally because
        // 0 == 0 before registration completes.
        if my_edge_id == 0 {
            debug!("Relay packet dropped: local edge_id not yet initialized");
            return;
        }
        if target_edge_id == my_edge_id {
            // Deliver locally — this Edge is the final destination.
            self.deliver_voice_locally(sender_session, voice_data).await;
            return;
        }

        // Forward to next hop with TTL decremented
        let next_hop_addr = {
            use crate::state::RouteDecision;
            let table = self.edge_state.route_table.load();
            let decision = table.get(&target_edge_id)
                .and_then(|cs| cs.first())
                .map(|c| c.decision.clone());
            let reg = self.edge_state.peer_registry.load();
            match decision {
                Some(RouteDecision::RelayChain { hops, .. }) if !hops.is_empty() => {
                    reg.get(hops[0]).map(|p| p.udp_addr)
                }
                _ => reg.get(target_edge_id).map(|p| p.udp_addr),
            }
        };

        if let Some(addr) = next_hop_addr {
            let mut forward = Vec::with_capacity(1 + 1 + 4 + 4 + voice_data.len());
            forward.push(EDGE_PKT_RELAY);
            forward.push(ttl - 1);
            forward.extend_from_slice(&target_edge_id.to_be_bytes());
            forward.extend_from_slice(&sender_session.to_be_bytes());
            forward.extend_from_slice(voice_data);
            if let Err(e) = self.edge_socket.send_to(&forward, addr).await {
                warn!("Forward relay packet to edge {} at {} failed: {}", target_edge_id, addr, e);
            } else {
                debug!("Forwarded relay packet to edge {} at {} (ttl={})", target_edge_id, addr, ttl - 1);
            }
        } else {
            debug!("Relay target edge {} not in peer registry — dropping relay packet", target_edge_id);
        }
    }

    /// Handle an Edge-to-Edge internal routing packet.
    async fn handle_edge_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        // Format: sender_session (4 bytes BE) + plaintext voice data
        if data.len() < 5 {
            debug!("Edge packet too short from {}", peer_addr);
            return;
        }
        let sender_session = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let voice_data = &data[4..];
        trace!("Relayed voice from edge {} (sender_session={}, {} bytes)", peer_addr, sender_session, voice_data.len());
        // Delegate to deliver_voice_locally, which emits RelayedVoice for unified routing.
        self.deliver_voice_locally(sender_session, voice_data).await;
    }

    /// Deliver a relayed voice packet to local clients on this Edge.
    async fn deliver_voice_locally(&self, sender_session: u32, voice_data: &[u8]) {
        trace!("deliver_voice_locally: session={}, {} bytes", sender_session, voice_data.len());
        // Build server-to-client format: [header][session_varint][seq][audio]
        // Preserve the original voice_target_id in low-5 bits so routing can
        // set the correct AudioContext per recipient.
        let voice_packet = crate::voice::inject_session_into_voice(voice_data, sender_session, voice_data.first().copied().unwrap_or(0) & 0x1f);
        if !voice_packet.is_empty() {
            crate::voice::deliver_relayed_voice(voice_packet, &self.edge_state, &self.hub_client).await;
        }
    }

    /// Handle a UDP quality probe packet (ping or pong).
    /// Probe format after stripping type byte: [subtype(1B): 0=ping 1=pong][seq_BE(4B)][sent_ms_BE(8B)]
    async fn handle_probe_packet(&self, data: &[u8], from_addr: SocketAddr) {
        if data.len() < 13 { return; }
        let ptype = data[0];
        let seq = u32::from_be_bytes([data[1], data[2], data[3], data[4]]);
        let sent_ms = u64::from_be_bytes([data[5], data[6], data[7], data[8], data[9], data[10], data[11], data[12]]);

        if ptype == 0 {
            // Ping — echo back as pong using the new format
            let mut pkt = Vec::with_capacity(1 + 1 + 4 + 8);
            pkt.push(EDGE_PKT_PROBE);
            pkt.push(1); // subtype=pong
            pkt.extend_from_slice(&seq.to_be_bytes());
            pkt.extend_from_slice(&sent_ms.to_be_bytes());
            let _ = self.edge_socket.send_to(&pkt, from_addr).await;
        } else if ptype == 1 {
            // Pong — update quality measurement
            let now_ms = probe_current_millis();
            let sender_edge_id = {
                self.edge_state.peer_registry.load().find_by_addr(from_addr)
            };
            if let Some(edge_id) = sender_edge_id {
                let mut pq = self.peer_quality.lock().await;                let entry = pq.entry(edge_id).or_default();
                if let Some(sent) = entry.pending_pings.remove(&seq) {
                    let rtt = (now_ms.saturating_sub(sent)) as f32;
                    entry.rtt_samples.push_back(rtt);
                    if entry.rtt_samples.len() > MAX_RTT_SAMPLES {
                        entry.rtt_samples.pop_front();
                    }
                    entry.pongs_received += 1;
                }
                drop(pq);
                // Successful pong resets consecutive failure counter for this peer
                reset_hop_failure(
                    &self.edge_state.next_hop_failures,
                    edge_id,
                    self.edge_state.consecutive_failure_threshold,
                );
            }
        }
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
fn increment_hop_failure(
    failures: &std::sync::RwLock<std::collections::HashMap<u32, std::sync::atomic::AtomicU32>>,
    edge_id: u32,
) {
    use std::sync::atomic::Ordering;
    // Fast path: key exists — just increment.
    {
        if let Ok(map) = failures.read() {
            if let Some(counter) = map.get(&edge_id) {
                counter.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
    }
    // Slow path: first time we try to reach this edge.  Insert atomically.
    if let Ok(mut map) = failures.write() {
        map.entry(edge_id)
            .or_insert_with(|| std::sync::atomic::AtomicU32::new(0))
            .fetch_add(1, Ordering::Relaxed);
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
    if threshold == 0 { return; }
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
fn batch_sendmmsg(fd: std::os::unix::io::RawFd, pkts: &[(Vec<u8>, SocketAddr)]) -> usize {
    use nix::sys::socket::{sendmmsg, ControlMessage, MsgFlags, MultiHeaders, SockaddrStorage};
    use std::io::IoSlice;

    if pkts.is_empty() {
        return 0;
    }

    // Build one [IoSlice; 1] per packet; each borrows from the corresponding Vec<u8>.
    let iovs: Vec<[IoSlice<'_>; 1]> = pkts.iter()
        .map(|(data, _)| [IoSlice::new(data.as_slice())])
        .collect();

    // Convert std::net::SocketAddr → nix SockaddrStorage.
    // SockaddrStorage implements From<SocketAddr> for both V4 and V6.
    let addrs: Vec<Option<SockaddrStorage>> = pkts.iter()
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
fn batch_sendmmsg_fallback_seq(sock: &tokio::net::UdpSocket, pkts: &[(Vec<u8>, SocketAddr)]) -> usize {
    let mut sent = 0;
    for (data, addr) in pkts {
        match sock.try_send_to(data, *addr) {
            Ok(_) => { sent += 1; }
            Err(_) => break, // stop on first error (buffer full)
        }
    }
    sent
}

/// Current time in milliseconds (for probe RTT measurement).
fn probe_current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Encode a u32 value as a Mumble variable-length integer.
#[allow(dead_code)] // used by tests
pub(crate) fn encode_mumble_varint(value: u32) -> Vec<u8> {
    if value < 0x80 {
        vec![value as u8]
    } else if value < 0x4000 {
        vec![((value >> 8) | 0x80) as u8, (value & 0xFF) as u8]
    } else if value < 0x200000 {
        vec![((value >> 16) | 0xC0) as u8, ((value >> 8) & 0xFF) as u8, (value & 0xFF) as u8]
    } else {
        vec![0xF0, ((value >> 24) & 0xFF) as u8, ((value >> 16) & 0xFF) as u8, ((value >> 8) & 0xFF) as u8, (value & 0xFF) as u8]
    }
}

/// Write a Mumble varint directly into `dst`, avoiding an intermediate Vec allocation.
#[inline]
pub(crate) fn write_mumble_varint(value: u32, dst: &mut Vec<u8>) {
    if value < 0x80 {
        dst.push(value as u8);
    } else if value < 0x4000 {
        dst.push(((value >> 8) | 0x80) as u8);
        dst.push((value & 0xFF) as u8);
    } else if value < 0x200000 {
        dst.push(((value >> 16) | 0xC0) as u8);
        dst.push(((value >> 8) & 0xFF) as u8);
        dst.push((value & 0xFF) as u8);
    } else {
        dst.push(0xF0);
        dst.push(((value >> 24) & 0xFF) as u8);
        dst.push(((value >> 16) & 0xFF) as u8);
        dst.push(((value >> 8) & 0xFF) as u8);
        dst.push((value & 0xFF) as u8);
    }
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
