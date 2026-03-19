use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::collections::VecDeque;
use std::time::Duration;

use anyhow::Result;
use bytes::BytesMut;
use tokio::net::UdpSocket;
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, info, warn};

use munode_protocol::message_type::MessageType;
use munode_protocol::transport::EDGE_MAGIC;

use crate::hub_client::HubClient;
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
    addr_to_session: Arc<RwLock<HashMap<SocketAddr, u32>>>,
    /// Maps session ID → UDP source address.
    session_to_addr: Arc<RwLock<HashMap<u32, SocketAddr>>>,
    /// Per-edge quality tracking for UDP probes.
    peer_quality: Arc<Mutex<HashMap<u32, PeerQualityState>>>,
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

        Ok(Self {
            socket,
            edge_socket,
            edge_state,
            hub_client,
            addr_to_session: Arc::new(RwLock::new(HashMap::new())),
            session_to_addr: Arc::new(RwLock::new(HashMap::new())),
            peer_quality: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Register a client's UDP address.
    pub async fn register_client(&self, session_id: u32, addr: SocketAddr) {
        self.addr_to_session.write().await.insert(addr, session_id);
        self.session_to_addr.write().await.insert(session_id, addr);
        debug!("Registered UDP client: session {} at {}", session_id, addr);
    }

    /// Unregister a client's UDP address on TCP disconnect.
    pub async fn unregister_client(&self, session_id: u32) {
        if let Some(addr) = self.session_to_addr.write().await.remove(&session_id) {
            self.addr_to_session.write().await.remove(&addr);
        }
    }

    /// Main receive loop.  Polls both the client socket and the edge socket.
    pub async fn run(&self) -> Result<()> {
        let mut client_buf = [0u8; 2048];
        let mut edge_buf = [0u8; 2048];

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
                                let reg = probe_state.peer_registry.read().await;
                                reg.all_udp_peers()
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

        loop {
            if separate_edge_sock {
                tokio::select! {
                    res = self.socket.recv_from(&mut client_buf) => {
                        let (len, peer_addr) = res?;
                        if len >= 4 {
                            self.handle_client_datagram(&client_buf[..len], peer_addr).await;
                        }
                    }
                    res = self.edge_socket.recv_from(&mut edge_buf) => {
                        let (len, peer_addr) = res?;
                        if len < 1 {
                            continue;
                        }
                        match edge_buf[0] {
                            // Direct voice for this Edge: [0x01][session_BE(4)][voice...]
                            EDGE_PKT_VOICE if len >= 6 => {
                                self.handle_edge_packet(&edge_buf[1..len], peer_addr).await;
                            }
                            // Relay-forward: [0x02][target_BE(4)][session_BE(4)][voice...]
                            EDGE_PKT_RELAY if len >= 10 => {
                                self.handle_relay_packet(&edge_buf[1..len]).await;
                            }
                            // Quality probe: [0x03][subtype(1)][seq_BE(4)][ts_BE(8)]
                            EDGE_PKT_PROBE if len >= 14 => {
                                self.handle_probe_packet(&edge_buf[1..len], peer_addr).await;
                            }
                            // Encrypted direct voice: [0x11][sender_edge_id_BE(4)][counter_BE(4)][enc(session_BE(4)+voice)+tag(16)]
                            EDGE_PKT_ENC_VOICE if len >= 29 => {
                                self.handle_enc_voice_packet(&edge_buf[1..len], peer_addr).await;
                            }
                            // Encrypted relay: [0x12][sender_edge_id_BE(4)][counter_BE(4)][ttl(1)][target_BE(4)][enc(session_BE(4)+voice)+tag(16)]
                            EDGE_PKT_ENC_RELAY if len >= 34 => {
                                self.handle_enc_relay_packet(&edge_buf[1..len]).await;
                            }
                            _ => {
                                debug!("Unknown edge packet type 0x{:02X} from {} ({} bytes)",
                                    edge_buf[0], peer_addr, len);
                            }
                        }
                    }
                }
            } else {
                let (len, peer_addr) = self.socket.recv_from(&mut client_buf).await?;
                if len >= 4 {
                    self.handle_client_datagram(&client_buf[..len], peer_addr).await;
                }
            }
        }
    }

    /// Dispatch a datagram received on the client-facing socket.
    async fn handle_client_datagram(&self, data: &[u8], peer_addr: SocketAddr) {
        // Edge-to-Edge packet on client port (fallback when no dedicated edge port)
        if data.len() >= 2 && data[0] == EDGE_MAGIC[0] && data[1] == EDGE_MAGIC[1] {
            self.handle_edge_packet(&data[2..], peer_addr).await;
            return;
        }

        let known_session = self.addr_to_session.read().await.get(&peer_addr).copied();

        if let Some(session_id) = known_session {
            self.handle_known_client(data, session_id).await;
        } else {
            self.try_identify_and_handle(data, peer_addr).await;
        }
    }

    /// Handle a packet from an already-identified client.
    async fn handle_known_client(&self, data: &[u8], session_id: u32) {
        debug!("handle_known_client: session={} len={}", session_id, data.len());
        let plaintext = {
            let cs_arc = match self.edge_state.client_manager.get_crypt_state(session_id).await {
                Some(a) => a,
                None => {
                    debug!("No CryptState for session {} — UDP packet dropped", session_id);
                    return;
                }
            };
            let mut cs = match cs_arc.lock() {
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
            // Voice: route to channel members
            self.route_voice(session_id, &plaintext).await;
        }
    }

    /// Attempt to identify an unknown UDP source by trying decryption with
    /// all TCP-authenticated sessions that don't yet have a UDP address.
    async fn try_identify_and_handle(&self, data: &[u8], peer_addr: SocketAddr) {
        if data.len() < 4 {
            return;
        }

        let authenticated = self.edge_state.client_manager.get_authenticated_sessions().await;
        let already_mapped: Vec<u32> = self.session_to_addr.read().await.keys().copied().collect();

        for session_id in authenticated {
            if already_mapped.contains(&session_id) {
                continue;
            }
            let cs_arc = match self.edge_state.client_manager.get_crypt_state(session_id).await {
                Some(a) => a,
                None => continue,
            };

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
                self.register_client(session_id, peer_addr).await;
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
                    self.route_voice(session_id, &plain).await;
                }
                return;
            }
            // Failed decrypt leaves the state unchanged (decrypt() restores IV)
        }

        debug!("Unidentified UDP packet from {} ({} bytes)", peer_addr, data.len());
    }

    /// Route decrypted voice to channel members, encrypting per-recipient.
    /// Also relays to remote users (on other edges) via Hub TCP.
    async fn route_voice(&self, sender_session: u32, plaintext: &[u8]) {
        let sender_client = match self.edge_state.client_manager.get_client(sender_session).await {
            Some(c) => c,
            None => {
                debug!("route_voice: sender session {} not found in clients", sender_session);
                return;
            }
        };
        let sender_channel = sender_client.channel_id;
        debug!("route_voice: session={} channel={}", sender_session, sender_channel);

        // Record voice bandwidth for this sender session.
        // Use rolling_stats_window from EdgeState for the window size.
        // Clamp to MAX_WINDOW_SLOTS (3600) to prevent excessive memory allocation.
        // 0 is passed through as-is; BandwidthRecord::new(0) uses DEFAULT_WINDOW_SLOTS (360).
        let window_secs = (self.edge_state.rolling_stats_window.load(std::sync::atomic::Ordering::Relaxed) as usize)
            .min(crate::bandwidth::MAX_WINDOW_SLOTS);
        // max_bandwidth is in bps → convert to bytes-per-second.
        // 0 means unlimited; the record still tracks bytes even when uncapped.
        {
            let max_bps = self.edge_state.hub_limits.read().await
                .as_ref()
                .and_then(|l| l.max_bandwidth)
                .unwrap_or(0);
            let max_bytes = if max_bps > 0 { max_bps / 8 } else { 0 };
            let within_budget = self.edge_state.client_manager
                .record_voice_bytes(sender_session, plaintext.len() as u32, max_bytes, window_secs)
                .await;
            if !within_budget {
                // Drop the packet — sender exceeded their per-second bandwidth cap.
                return;
            }
        }

        // Block suppressed users from speaking
        let voice_target = if !plaintext.is_empty() { (plaintext[0] & 0x1F) as u32 } else { 0 };
        if sender_client.suppress && voice_target != 31 {
            return;
        }

        // Lock-free read of our own edge ID (AtomicU32).
        let my_edge_id = self.edge_state.get_edge_id();

        // Get all linked channels (sender's channel + any linked channels), as Vec for slicing
        let linked_channels: Vec<u32> = self.edge_state.channel_manager
            .get_all_linked_channels(sender_channel)
            .await
            .into_iter()
            .collect();

        // Inject sender session ID into voice packet for forwarding to local clients.
        // Client-to-server format: [header(1B)][sequence_varint][audio]
        // Server-to-client format: [header(1B)][sender_session_varint][sequence_varint][audio]
        let forwarded = inject_session_into_voice(plaintext, sender_session);

        // --- Local clients (same edge, all linked channels + listeners) ---
        // Batch lookup: one `clients.read` + one `crypt_states.read` for all targets.
        let targets = self.edge_state.client_manager
            .get_channel_voice_targets_with_listeners(&linked_channels, sender_session)
            .await;

        debug!("route_voice: {} targets in channels {:?}", targets.len(), &linked_channels);

        let session_addrs = self.session_to_addr.read().await;

        for (target, is_deaf, cs_opt) in &targets {
            if *is_deaf || *target == sender_session {
                continue;
            }
            if let Some(&addr) = session_addrs.get(target) {
                // Has UDP address: OCB2-encrypt and send
                if let Some(cs_arc) = cs_opt {
                    let mut encrypted = Vec::with_capacity(forwarded.len() + 16);
                    match cs_arc.lock() {
                        Ok(mut cs) => { cs.encrypt(&forwarded, &mut encrypted); }
                        Err(e) => {
                            warn!("CryptState mutex poisoned for session {} — packet dropped: {}", target, e);
                            continue;
                        }
                    }
                    if let Err(e) = self.socket.send_to(&encrypted, addr).await {
                        warn!("UDP send to session {} failed: {}", target, e);
                    }
                }
            } else {
                // No UDP address: deliver via TCP UDPTunnel (includes session ID)
                debug!("route_voice: fallback_to_tcp for session {}", target);
                self.fallback_to_tcp(*target, &forwarded).await;
            }
        }
        drop(session_addrs);

        // --- Remote users (on other edges) ---
        // Compute relay_payload once — it is the same for all remote edges.
        let relay_payload = forwarded; // forwarded == inject_session_into_voice(plaintext, session)

        let linked_channels_set: std::collections::HashSet<u32> = linked_channels.iter().copied().collect();
        let remote_users = self.edge_state.channel_manager
            .get_remote_users_in_channels(&linked_channels_set)
            .await;

        // Group by edge (send once per edge; the receiving edge delivers to its local clients)
        let mut by_edge: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
        for ru in &remote_users {
            if ru.deaf || ru.self_deaf { continue; }
            if my_edge_id != 0 && ru.edge_id == my_edge_id { continue; }
            by_edge.insert(ru.edge_id, true);
        }

        if by_edge.is_empty() {
            return;
        }

        // Pre-encrypt once if crypto is configured — same ciphertext goes to all peers
        // because all Edges share the same key.  The nonce encodes sender_edge_id + counter,
        // so it is unique even when multiple Edges encrypt simultaneously.
        // Plaintext for encryption: [session_id_BE(4)][voice_payload]  (matches edge packet body)
        let enc_payload: Option<(u32, Vec<u8>)> = if let Some(crypto) = &self.edge_state.edge_crypto {
            let mut plain = Vec::with_capacity(4 + plaintext.len());
            plain.extend_from_slice(&sender_session.to_be_bytes());
            plain.extend_from_slice(plaintext);
            Some(crypto.encrypt(&plain, my_edge_id))
        } else {
            None
        };

        // Snapshot route_table and peer_registry once — avoids N async lock
        // acquisitions (one per remote edge) in the loop below.
        let route_snapshot: std::collections::HashMap<u32, Vec<crate::state::RouteCandidate>> = {
            let table = self.edge_state.route_table.read().await;
            by_edge
                .keys()
                .filter_map(|eid| table.get(eid).map(|r| (*eid, r.clone())))
                .collect()
        };
        let peer_snapshot: std::collections::HashMap<u32, std::net::SocketAddr> = {
            let reg = self.edge_state.peer_registry.read().await;
            // Collect UDP addresses for all edges referenced by route decisions
            let mut map = std::collections::HashMap::new();
            for eid in by_edge.keys() {
                if let Some(info) = reg.get(*eid) {
                    map.insert(*eid, info.udp_addr);
                }
            }
            // Also collect relay intermediary addresses from relay chains
            for candidates in route_snapshot.values() {
                for candidate in candidates {
                    if let crate::state::RouteDecision::RelayChain { hops, .. } = &candidate.decision {
                        for &hop_id in hops {
                            if let Some(info) = reg.get(hop_id) {
                                map.insert(hop_id, info.udp_addr);
                            }
                        }
                    }
                }
            }
            map
        };

        let threshold = self.edge_state.consecutive_failure_threshold;
        let max_ttl = self.edge_state.max_ttl.load(std::sync::atomic::Ordering::Relaxed);

        for target_edge_id in by_edge.into_keys() {
            debug!("edge={} UDP voice: routing from session {} to edge {}",
                my_edge_id, sender_session, target_edge_id);

            use crate::state::RouteDecision;

            // Select best candidate not over failure threshold.
            let decision = if let Some(candidates) = route_snapshot.get(&target_edge_id) {
                let failures = self.edge_state.next_hop_failures.read().await;
                let mut chosen = None;
                for candidate in candidates {
                    let next_hop_id = match &candidate.decision {
                        RouteDecision::DirectUdp => Some(target_edge_id),
                        RouteDecision::RelayChain { hops, .. } => hops.first().copied(),
                        _ => None,
                    };
                    let fail_count = next_hop_id
                        .and_then(|id| failures.get(&id).copied())
                        .unwrap_or(0);
                    if threshold == 0 || fail_count < threshold {
                        chosen = Some(candidate.decision.clone());
                        break;
                    }
                }
                // Fall back to first candidate even if over threshold (better than silence)
                chosen.or_else(|| candidates.first().map(|c| c.decision.clone()))
            } else {
                None
            };

            match decision.as_ref() {
                Some(RouteDecision::DirectUdp) | None => {
                    if let Some(&peer_addr) = peer_snapshot.get(&target_edge_id) {
                        // Use encrypted packet if crypto is configured, plaintext otherwise.
                        let pkt: Vec<u8> = if let Some((counter, ref ciphertext)) = enc_payload {
                            // [0x11][my_edge_id_BE(4)][counter_BE(4)][ciphertext+tag]
                            let mut p = Vec::with_capacity(1 + 4 + 4 + ciphertext.len());
                            p.push(EDGE_PKT_ENC_VOICE);
                            p.extend_from_slice(&my_edge_id.to_be_bytes());
                            p.extend_from_slice(&counter.to_be_bytes());
                            p.extend_from_slice(ciphertext);
                            p
                        } else {
                            // [0x01][sender_session_BE(4)][voice...]
                            let mut p = Vec::with_capacity(1 + 4 + plaintext.len());
                            p.push(EDGE_PKT_VOICE);
                            p.extend_from_slice(&sender_session.to_be_bytes());
                            p.extend_from_slice(plaintext);
                            p
                        };
                        if let Err(e) = self.edge_socket.send_to(&pkt, peer_addr).await {
                            warn!("Direct UDP to edge {} failed: {}; trying Hub TCP", target_edge_id, e);
                            {
                                let mut failures = self.edge_state.next_hop_failures.write().await;
                                *failures.entry(target_edge_id).or_insert(0) += 1;
                            }
                            if self.edge_state.enable_hub_tcp_fallback {
                                self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                            }
                        } else {
                            if threshold > 0 {
                                let mut failures = self.edge_state.next_hop_failures.write().await;
                                failures.insert(target_edge_id, 0);
                            }
                        }
                    } else if self.edge_state.enable_hub_tcp_fallback {
                        self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                    }
                }
                Some(RouteDecision::RelayChain { hops, .. }) if !hops.is_empty() => {
                    let first_hop = hops[0];
                    if let Some(&relay_addr) = peer_snapshot.get(&first_hop) {
                        let ttl = (hops.len() as u32 + 1).min(max_ttl).min(255) as u8;
                        let pkt: Vec<u8> = if let Some((counter, ref ciphertext)) = enc_payload {
                            // [0x12][my_edge_id_BE(4)][counter_BE(4)][ttl(1)][target_BE(4)][ciphertext+tag]
                            let mut p = Vec::with_capacity(1 + 4 + 4 + 1 + 4 + ciphertext.len());
                            p.push(EDGE_PKT_ENC_RELAY);
                            p.extend_from_slice(&my_edge_id.to_be_bytes());
                            p.extend_from_slice(&counter.to_be_bytes());
                            p.push(ttl);
                            p.extend_from_slice(&target_edge_id.to_be_bytes());
                            p.extend_from_slice(ciphertext);
                            p
                        } else {
                            // [0x02][ttl(1)][target_edge_id_BE(4)][session_BE(4)][voice...]
                            let mut p = Vec::with_capacity(1 + 1 + 4 + 4 + plaintext.len());
                            p.push(EDGE_PKT_RELAY);
                            p.push(ttl);
                            p.extend_from_slice(&target_edge_id.to_be_bytes());
                            p.extend_from_slice(&sender_session.to_be_bytes());
                            p.extend_from_slice(plaintext);
                            p
                        };
                        if let Err(e) = self.edge_socket.send_to(&pkt, relay_addr).await {
                            warn!("Relay via edge {} to {} failed: {}; Hub TCP fallback",
                                first_hop, target_edge_id, e);
                            {
                                let mut failures = self.edge_state.next_hop_failures.write().await;
                                *failures.entry(first_hop).or_insert(0) += 1;
                            }
                            if self.edge_state.enable_hub_tcp_fallback {
                                self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                            }
                        } else {
                            if threshold > 0 {
                                let mut failures = self.edge_state.next_hop_failures.write().await;
                                failures.insert(first_hop, 0);
                            }
                            debug!("Voice relayed via edge {} → {}", first_hop, target_edge_id);
                        }
                    } else if self.edge_state.enable_hub_tcp_fallback {
                        self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                    }
                }
                Some(RouteDecision::RelayChain { .. }) => {
                    // Empty hops — treat as direct
                    if let Some(&peer_addr) = peer_snapshot.get(&target_edge_id) {
                        let pkt: Vec<u8> = if let Some((counter, ref ciphertext)) = enc_payload {
                            let mut p = Vec::with_capacity(1 + 4 + 4 + ciphertext.len());
                            p.push(EDGE_PKT_ENC_VOICE);
                            p.extend_from_slice(&my_edge_id.to_be_bytes());
                            p.extend_from_slice(&counter.to_be_bytes());
                            p.extend_from_slice(ciphertext);
                            p
                        } else {
                            let mut p = Vec::with_capacity(1 + 4 + plaintext.len());
                            p.push(EDGE_PKT_VOICE);
                            p.extend_from_slice(&sender_session.to_be_bytes());
                            p.extend_from_slice(plaintext);
                            p
                        };
                        let _ = self.edge_socket.send_to(&pkt, peer_addr).await;
                    } else if self.edge_state.enable_hub_tcp_fallback {
                        self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                    }
                }
                Some(RouteDecision::HubTcp) => {
                    if self.edge_state.enable_hub_tcp_fallback {
                        self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                    }
                }
                Some(RouteDecision::DirectTcp) => {
                    // Send via TCP voice channel if available, else fall back to Hub TCP.
                    let sent = {
                        let conns = self.edge_state.voice_tcp_conns.read().await;
                        if let Some(tx) = conns.get(&target_edge_id) {
                            // Frame: [0x01][session_BE(4)][plaintext...]
                            let mut frame = Vec::with_capacity(1 + 4 + plaintext.len());
                            frame.push(EDGE_PKT_VOICE);
                            frame.extend_from_slice(&sender_session.to_be_bytes());
                            frame.extend_from_slice(plaintext);
                            tx.try_send(frame).is_ok()
                        } else {
                            false
                        }
                    };
                    if !sent && self.edge_state.enable_hub_tcp_fallback {
                        self.hub_client
                            .relay_voice_via_hub(target_edge_id, relay_payload.clone())
                            .await;
                    }
                }
            }
        }
    }

    /// Send encrypted data to a specific session's UDP address.
    async fn send_encrypted(&self, session_id: u32, plaintext: &[u8]) {
        if let Some(addr) = self.session_to_addr.read().await.get(&session_id).copied() {
            if let Some(cs_arc) = self.edge_state.client_manager.get_crypt_state(session_id).await {
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
    }

    /// Deliver voice via TCP UDPTunnel (no encryption — TLS handles it).
    async fn fallback_to_tcp(&self, session_id: u32, plaintext: &[u8]) {
        let data = build_udp_tunnel_packet(plaintext);
        if let Some(sender) = self.edge_state.client_manager.get_sender(session_id).await {
            sender.send_raw(data).await;
        }
    }

    /// Handle an encrypted direct-voice packet (type `0x11`).
    ///
    /// Wire format after stripping the type byte:
    ///   `[sender_edge_id_BE(4)][nonce_counter_BE(4)][ChaCha20_enc(session_id_BE(4) + voice) + Poly1305_tag(16)]`
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
        // Minimum after type byte: sender_edge_id(4) + counter(4) + session(4) + tag(16) = 28
        if data.len() < 4 + 4 + 4 + AEAD_TAG_LEN {
            return;
        }
        let sender_edge_id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let counter = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        let ciphertext = &data[8..];
        match crypto.decrypt(sender_edge_id, counter, ciphertext) {
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
    ///   `[sender_edge_id_BE(4)][nonce_counter_BE(4)][ttl(1)][target_edge_id_BE(4)]`
    ///   `[ChaCha20_enc(session_id_BE(4) + voice) + Poly1305_tag(16)]`
    ///
    /// The routing headers (sender_edge_id, counter, ttl, target_edge_id) are in plaintext
    /// so relay intermediaries can forward without decrypting the payload.
    async fn handle_enc_relay_packet(&self, data: &[u8]) {
        // Minimum: sender_edge_id(4) + counter(4) + ttl(1) + target(4) + session(4) + tag(16) = 33
        if data.len() < 4 + 4 + 1 + 4 + 4 + AEAD_TAG_LEN {
            return;
        }
        let sender_edge_id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let counter = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        let ttl = data[8];
        let target_edge_id = u32::from_be_bytes([data[9], data[10], data[11], data[12]]);
        let ciphertext = &data[13..];

        let my_edge_id = self.edge_state.get_edge_id();

        if target_edge_id == my_edge_id || my_edge_id == 0 {
            // Destined for this Edge — decrypt and deliver locally.
            let crypto = match &self.edge_state.edge_crypto {
                Some(c) => c,
                None => {
                    debug!("Encrypted relay destined for us but no edge_crypto configured");
                    return;
                }
            };
            match crypto.decrypt(sender_edge_id, counter, ciphertext) {
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
        // [0x12][sender_edge_id(4)][counter(4)][ttl-1(1)][target(4)][ciphertext]
        let mut forward = Vec::with_capacity(1 + 4 + 4 + 1 + 4 + ciphertext.len());
        forward.push(EDGE_PKT_ENC_RELAY);
        forward.extend_from_slice(&sender_edge_id.to_be_bytes());
        forward.extend_from_slice(&counter.to_be_bytes());
        forward.push(ttl - 1);
        forward.extend_from_slice(&target_edge_id.to_be_bytes());
        forward.extend_from_slice(ciphertext);

        let target_addr = {
            let reg = self.edge_state.peer_registry.read().await;
            // Use route table if available; otherwise direct to target.
            let table = self.edge_state.route_table.try_read();
            let next_hop = if let Ok(table) = table {
                match table.get(&target_edge_id).and_then(|cs| cs.first()).map(|c| &c.decision) {
                    Some(crate::state::RouteDecision::RelayChain { hops, .. }) if !hops.is_empty() => {
                        reg.get(hops[0]).map(|p| p.udp_addr)
                    }
                    _ => reg.get(target_edge_id).map(|p| p.udp_addr),
                }
            } else {
                reg.get(target_edge_id).map(|p| p.udp_addr)
            };
            next_hop
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
        if target_edge_id == my_edge_id {
            // Deliver locally — this Edge is the final destination.
            self.deliver_voice_locally(sender_session, voice_data).await;
            return;
        }

        // Forward to next hop with TTL decremented
        let next_hop_addr = {
            use crate::state::RouteDecision;
            let table = self.edge_state.route_table.read().await;
            let candidates = table.get(&target_edge_id);
            let decision = candidates.and_then(|cs| cs.first()).map(|c| c.decision.clone());
            drop(table);

            match decision {
                Some(RouteDecision::DirectUdp) => {
                    let reg = self.edge_state.peer_registry.read().await;
                    reg.get(target_edge_id).map(|p| p.udp_addr)
                }
                Some(RouteDecision::RelayChain { hops, .. }) if !hops.is_empty() => {
                    let reg = self.edge_state.peer_registry.read().await;
                    reg.get(hops[0]).map(|p| p.udp_addr)
                }
                _ => {
                    let reg = self.edge_state.peer_registry.read().await;
                    reg.get(target_edge_id).map(|p| p.udp_addr)
                }
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

        debug!("Relayed voice from edge {} (sender_session={}, {} bytes)", peer_addr, sender_session, voice_data.len());

        // Find the channel this remote user is in
        let channel_id = if let Some(ru) = self.edge_state.channel_manager.get_remote_user(sender_session).await {
            ru.channel_id
        } else {
            // Remote user not known — fall back to all channels (shouldn't normally happen)
            debug!("Unknown remote session {} in edge packet", sender_session);
            return;
        };

        // Inject sender_session so clients know who sent the audio
        let forwarded = inject_session_into_voice(voice_data, sender_session);

        // Deliver to local clients in the same channel
        let local_targets = self.edge_state.client_manager.get_channel_sessions(channel_id).await;
        let session_addrs = self.session_to_addr.read().await;

        for target in local_targets {
            if let Some(&addr) = session_addrs.get(&target) {
                if let Some(cs_arc) = self.edge_state.client_manager.get_crypt_state(target).await {
                    let mut encrypted = Vec::new();
                    match cs_arc.lock() {
                        Ok(mut cs) => { cs.encrypt(&forwarded, &mut encrypted); }
                        Err(e) => {
                            warn!("CryptState mutex poisoned for session {} — packet dropped: {}", target, e);
                            continue;
                        }
                    }
                    if let Err(e) = self.socket.send_to(&encrypted, addr).await {
                        warn!("UDP relay to session {} failed: {}", target, e);
                    }
                }
            } else {
                self.fallback_to_tcp(target, &forwarded).await;
            }
        }
    }

    /// Deliver a relayed voice packet to local clients on this Edge.
    /// Extracted from handle_edge_packet to avoid needing a dummy peer address.
    async fn deliver_voice_locally(&self, sender_session: u32, voice_data: &[u8]) {
        debug!("deliver_voice_locally: session={}, {} bytes", sender_session, voice_data.len());

        let channel_id = if let Some(ru) = self.edge_state.channel_manager.get_remote_user(sender_session).await {
            ru.channel_id
        } else {
            debug!("Unknown remote session {} in relay delivery", sender_session);
            return;
        };

        let forwarded = inject_session_into_voice(voice_data, sender_session);
        let local_targets = self.edge_state.client_manager.get_channel_sessions(channel_id).await;
        let session_addrs = self.session_to_addr.read().await;

        for target in local_targets {
            if let Some(&addr) = session_addrs.get(&target) {
                if let Some(cs_arc) = self.edge_state.client_manager.get_crypt_state(target).await {
                    let mut encrypted = Vec::new();
                    match cs_arc.lock() {
                        Ok(mut cs) => { cs.encrypt(&forwarded, &mut encrypted); }
                        Err(e) => {
                            warn!("CryptState mutex poisoned for session {} — packet dropped: {}", target, e);
                            continue;
                        }
                    }
                    if let Err(e) = self.socket.send_to(&encrypted, addr).await {
                        warn!("UDP relay to session {} failed: {}", target, e);
                    }
                }
            } else {
                self.fallback_to_tcp(target, &forwarded).await;
            }
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
                let reg = self.edge_state.peer_registry.read().await;
                reg.all_udp_peers().into_iter().find(|(_, addr)| *addr == from_addr).map(|(id, _)| id)
            };
            if let Some(edge_id) = sender_edge_id {
                let mut pq = self.peer_quality.lock().await;
                let entry = pq.entry(edge_id).or_default();
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
                if self.edge_state.consecutive_failure_threshold > 0 {
                    let mut failures = self.edge_state.next_hop_failures.write().await;
                    failures.insert(edge_id, 0);
                }
            }
        }
    }
}

/// Build a TCP UdpTunnel frame from raw (plaintext) voice data.
fn build_udp_tunnel_packet(data: &[u8]) -> Vec<u8> {
    let mut buf = BytesMut::new();
    bytes::BufMut::put_u16(&mut buf, MessageType::UdpTunnel as u16);
    bytes::BufMut::put_u32(&mut buf, data.len() as u32);
    bytes::BufMut::put_slice(&mut buf, data);
    buf.to_vec()
}

/// Current time in milliseconds (for probe RTT measurement).
fn probe_current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Encode a u32 value as a Mumble variable-length integer.
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

/// Inject sender session ID into a voice packet payload before forwarding to clients.
/// Client-to-server format: [header(1B)][sequence_varint][audio_data]
/// Server-to-client format: [header(1B)][sender_session_varint][sequence_varint][audio_data]
fn inject_session_into_voice(payload: &[u8], sender_session: u32) -> Vec<u8> {
    if payload.is_empty() {
        return Vec::new();
    }
    let header = payload[0];
    let session_varint = encode_mumble_varint(sender_session);
    let mut result = Vec::with_capacity(1 + session_varint.len() + payload.len() - 1);
    result.push(header);
    result.extend_from_slice(&session_varint);
    result.extend_from_slice(&payload[1..]);
    result
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
            let mut failures = edge_state.next_hop_failures.write().await;
            *failures.entry(target_edge_id).or_insert(0) += 1;
            return false;
        }
    }

    let mut pkt = Vec::with_capacity(1 + 4 + payload.len());
    pkt.push(EDGE_PKT_VOICE);
    pkt.extend_from_slice(&session.to_be_bytes());
    pkt.extend_from_slice(payload);

    match edge_socket.send_to(&pkt, target_addr).await {
        Ok(_) => {
            if edge_state.consecutive_failure_threshold > 0 {
                let mut failures = edge_state.next_hop_failures.write().await;
                failures.insert(target_edge_id, 0);
            }
            true
        }
        Err(_) => {
            let mut failures = edge_state.next_hop_failures.write().await;
            *failures.entry(target_edge_id).or_insert(0) += 1;
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
