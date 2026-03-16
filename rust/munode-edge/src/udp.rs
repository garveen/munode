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
//     [0x02][target_edge_id BE(4B)][sender_session BE(4B)][raw plaintext voice...]
//     Overhead: 9 bytes total header (1 type + 4 target + 4 session)
//     The relay node strips the type byte, reads target+session, then builds a fresh
//     Voice packet ([0x01][session][voice]) and sends it to the target's edge socket.
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
///   [0x02][target_BE(4B)][session_BE(4B)][voice] — relay-forward (9-byte header)
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
            // Ping (type 0b001): echo back encrypted
            self.send_encrypted(session_id, &plaintext).await;
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
                    self.send_encrypted(session_id, &plain).await;
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

        // Snapshot route_table and peer_registry once — avoids N async lock
        // acquisitions (one per remote edge) in the loop below.
        let route_snapshot: std::collections::HashMap<u32, crate::state::RouteDecision> = {
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
            // Also collect relay intermediary addresses
            for decision in route_snapshot.values() {
                if let crate::state::RouteDecision::RelayVia { relay_edge_id } = decision {
                    if let Some(info) = reg.get(*relay_edge_id) {
                        map.insert(*relay_edge_id, info.udp_addr);
                    }
                }
            }
            map
        };

        for target_edge_id in by_edge.into_keys() {
            debug!("edge={} UDP voice: routing from session {} to edge {}",
                my_edge_id, sender_session, target_edge_id);

            use crate::state::RouteDecision;
            match route_snapshot.get(&target_edge_id) {
                Some(RouteDecision::Direct) | None => {
                    if let Some(&peer_addr) = peer_snapshot.get(&target_edge_id) {
                        if self.edge_state.allow_direct_udp {
                            // [0x01][session_BE(4)][voice...]
                            let mut pkt = Vec::with_capacity(1 + 4 + plaintext.len());
                            pkt.push(EDGE_PKT_VOICE);
                            pkt.extend_from_slice(&sender_session.to_be_bytes());
                            pkt.extend_from_slice(plaintext);
                            if let Err(e) = self.edge_socket.send_to(&pkt, peer_addr).await {
                                warn!("Direct UDP to edge {} failed: {}; trying Hub TCP", target_edge_id, e);
                                if self.edge_state.allow_hub_relay {
                                    self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                                }
                            }
                        } else if self.edge_state.allow_hub_relay {
                            self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                        }
                    } else if self.edge_state.allow_hub_relay {
                        self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                    }
                }
                Some(RouteDecision::RelayVia { relay_edge_id }) => {
                    if let Some(&relay_addr) = peer_snapshot.get(relay_edge_id) {
                        // [0x02][target_edge_id_BE(4)][session_BE(4)][voice...]
                        let mut pkt = Vec::with_capacity(1 + 4 + 4 + plaintext.len());
                        pkt.push(EDGE_PKT_RELAY);
                        pkt.extend_from_slice(&target_edge_id.to_be_bytes());
                        pkt.extend_from_slice(&sender_session.to_be_bytes());
                        pkt.extend_from_slice(plaintext);
                        if let Err(e) = self.edge_socket.send_to(&pkt, relay_addr).await {
                            warn!("Relay via edge {} to {} failed: {}; Hub TCP fallback",
                                relay_edge_id, target_edge_id, e);
                            if self.edge_state.allow_hub_relay {
                                self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                            }
                        } else {
                            debug!("Voice relayed via edge {} → {}", relay_edge_id, target_edge_id);
                        }
                    } else if self.edge_state.allow_hub_relay {
                        self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
                    }
                }
                Some(RouteDecision::HubTcp) => {
                    if self.edge_state.allow_hub_relay {
                        self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload.clone()).await;
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

    /// Handle a relay-forward packet received on the edge socket.
    ///
    /// Format after stripping the type byte: [target_edge_id BE(4B)][sender_session BE(4B)][voice...]
    ///
    /// Builds a fresh Voice packet ([0x01][session][voice]) and forwards it to the target
    /// Edge's edge socket.
    async fn handle_relay_packet(&self, data: &[u8]) {
        // Minimum: 4 (target_edge_id) + 4 (sender_session) + 1 (voice) = 9
        if data.len() < 9 {
            debug!("Relay packet too short ({} bytes)", data.len());
            return;
        }
        let target_edge_id = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let sender_session = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        let voice_data = &data[8..];

        let peer_addr = {
            let reg = self.edge_state.peer_registry.read().await;
            reg.get(target_edge_id).map(|p| p.udp_addr)
        };

        if let Some(addr) = peer_addr {
            // Build a Voice packet for the target Edge.
            let mut forward = Vec::with_capacity(1 + 4 + voice_data.len());
            forward.push(EDGE_PKT_VOICE);
            forward.extend_from_slice(&sender_session.to_be_bytes());
            forward.extend_from_slice(voice_data);
            if let Err(e) = self.edge_socket.send_to(&forward, addr).await {
                warn!("Forward relay packet to edge {} at {} failed: {}", target_edge_id, addr, e);
            } else {
                debug!("Forwarded relay packet to edge {} at {}", target_edge_id, addr);
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
fn encode_mumble_varint(value: u32) -> Vec<u8> {
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
