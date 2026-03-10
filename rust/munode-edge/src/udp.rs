use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use bytes::BytesMut;
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use munode_protocol::message_type::MessageType;
use munode_protocol::transport::EDGE_MAGIC;

use crate::hub_client::HubClient;
use crate::state::EdgeState;

/// UDP server for Mumble voice data with OCB2-AES128 encryption.
///
/// Workflow:
/// 1. Client authenticates via TCP → CryptState registered in ClientManager.
/// 2. Client sends first OCB2-encrypted UDP packet (typically a ping).
/// 3. Server tries decrypting with each authenticated session's CryptState;
///    on success the UDP address is mapped to that session.
/// 4. Subsequent packets are decrypted, routed, and re-encrypted per-recipient.
///
/// Edge-to-Edge direct voice is handled on a separate `edge_socket` bound on
/// `edge_port`.  Outbound packets include a 6-byte header:
///   [EDGE_MAGIC(2B)] [sender_session_u32_BE(4B)] [plaintext_voice...]
/// Inbound packets from peers are identified by the same magic prefix.
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
                        if len >= 6 && edge_buf[0] == EDGE_MAGIC[0] && edge_buf[1] == EDGE_MAGIC[1] {
                            self.handle_edge_packet(&edge_buf[2..len], peer_addr).await;
                        } else {
                            debug!("Unexpected packet on edge socket from {} ({} bytes)", peer_addr, len);
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
        let plaintext = {
            let cs_arc = match self.edge_state.client_manager.get_crypt_state(session_id).await {
                Some(a) => a,
                None => return,
            };
            let mut cs = cs_arc.lock().unwrap();
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
                let mut cs = cs_arc.lock().unwrap();
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
            None => return,
        };
        let sender_channel = sender_client.channel_id;

        // Block suppressed users from speaking
        let voice_target = if !plaintext.is_empty() { (plaintext[0] & 0x1F) as u32 } else { 0 };
        if sender_client.suppress && voice_target != 31 {
            return;
        }

        let my_edge_id = *self.edge_state.edge_id.read().await;

        // Get all linked channels (sender's channel + any linked channels)
        let linked_channels = self.edge_state.channel_manager
            .get_all_linked_channels(sender_channel)
            .await;

        // Inject sender session ID into voice packet for forwarding to local clients.
        // Client-to-server format: [header(1B)][sequence_varint][audio]
        // Server-to-client format: [header(1B)][sender_session_varint][sequence_varint][audio]
        let forwarded = inject_session_into_voice(plaintext, sender_session);

        // --- Local clients (same edge, all linked channels) ---
        let session_addrs = self.session_to_addr.read().await;

        for ch_id in &linked_channels {
            let targets = self.edge_state.client_manager.get_channel_sessions(*ch_id).await;
            for target in targets {
                if target == sender_session {
                    continue;
                }
                if let Some(target_client) = self.edge_state.client_manager.get_client(target).await {
                    if target_client.deaf || target_client.self_deaf {
                        continue;
                    }
                }
                if let Some(&addr) = session_addrs.get(&target) {
                    // Has UDP address: encrypt with session-injected voice and send
                    if let Some(cs_arc) = self.edge_state.client_manager.get_crypt_state(target).await {
                        let mut encrypted = Vec::new();
                        cs_arc.lock().unwrap().encrypt(&forwarded, &mut encrypted);
                        if let Err(e) = self.socket.send_to(&encrypted, addr).await {
                            warn!("UDP send to session {} failed: {}", target, e);
                        }
                    }
                } else {
                    // No UDP address: deliver via TCP UDPTunnel (includes session ID)
                    self.fallback_to_tcp(target, &forwarded).await;
                }
            }

            // --- Listeners: clients on this edge that are listening to this channel ---
            let listeners = self.edge_state.client_manager.get_listening_sessions(*ch_id).await;
            for target in listeners {
                if target == sender_session {
                    continue;
                }
                if let Some(target_client) = self.edge_state.client_manager.get_client(target).await {
                    if target_client.deaf || target_client.self_deaf {
                        continue;
                    }
                }
                if let Some(&addr) = session_addrs.get(&target) {
                    if let Some(cs_arc) = self.edge_state.client_manager.get_crypt_state(target).await {
                        let mut encrypted = Vec::new();
                        cs_arc.lock().unwrap().encrypt(&forwarded, &mut encrypted);
                        if let Err(e) = self.socket.send_to(&encrypted, addr).await {
                            warn!("UDP send to listener session {} failed: {}", target, e);
                        }
                    }
                } else {
                    self.fallback_to_tcp(target, &forwarded).await;
                }
            }
        }
        drop(session_addrs);

        // --- Remote users (on other edges) via Hub TCP relay ---
        // Use get_remote_users_in_channels to cover all linked channels
        let remote_users = self.edge_state.channel_manager
            .get_remote_users_in_channels(&linked_channels)
            .await;

        // Group by edge (broadcast to each edge once; receiver edge handles local delivery)
        let mut by_edge: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
        for ru in &remote_users {
            if ru.deaf || ru.self_deaf { continue; }
            if let Some(lid) = my_edge_id { if ru.edge_id == lid { continue; } }
            by_edge.insert(ru.edge_id, true);
        }

        for target_edge_id in by_edge.into_keys() {
            debug!("edge={:?} UDP voice: relaying broadcast from session {} to edge {}", my_edge_id, sender_session, target_edge_id);
            // Relay format: [EDGE_MAGIC(2B)][sender_session_u32_BE(4B)][plaintext_voice]
            let relay_payload = inject_session_into_voice(plaintext, sender_session);

            // Try direct UDP to peer edge first; fall back to Hub relay if not known.
            let peer_udp_addr = {
                let reg = self.edge_state.peer_registry.lock().await;
                reg.get(target_edge_id).map(|p| p.udp_addr)
            };

            if let Some(peer_addr) = peer_udp_addr {
                // Packet format for peer Edge: [EDGE_MAGIC(2B)][sender_session_u32_BE(4B)][raw plaintext voice]
                // Receiver (handle_edge_packet) strips EDGE_MAGIC then reads 4B session + raw voice.
                let mut direct_packet = Vec::with_capacity(2 + 4 + plaintext.len());
                direct_packet.extend_from_slice(&EDGE_MAGIC);
                direct_packet.extend_from_slice(&sender_session.to_be_bytes());
                direct_packet.extend_from_slice(plaintext);
                if let Err(e) = self.edge_socket.send_to(&direct_packet, peer_addr).await {
                    warn!("Direct UDP to edge {} at {} failed: {}", target_edge_id, peer_addr, e);
                    if !self.edge_state.disable_hub_relay {
                        self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload).await;
                    }
                }
            } else if !self.edge_state.disable_hub_relay {
                self.hub_client.relay_voice_via_hub(target_edge_id, relay_payload).await;
            }
        }
    }

    /// Send encrypted data to a specific session's UDP address.
    async fn send_encrypted(&self, session_id: u32, plaintext: &[u8]) {
        if let Some(addr) = self.session_to_addr.read().await.get(&session_id).copied() {
            if let Some(cs_arc) = self.edge_state.client_manager.get_crypt_state(session_id).await {
                let mut encrypted = Vec::new();
                cs_arc.lock().unwrap().encrypt(plaintext, &mut encrypted);
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
                    cs_arc.lock().unwrap().encrypt(&forwarded, &mut encrypted);
                    if let Err(e) = self.socket.send_to(&encrypted, addr).await {
                        warn!("UDP relay to session {} failed: {}", target, e);
                    }
                }
            } else {
                self.fallback_to_tcp(target, &forwarded).await;
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
