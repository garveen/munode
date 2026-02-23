use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use bytes::BytesMut;
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use tracing::{debug, info};

use munode_protocol::message_type::MessageType;
use munode_protocol::transport::EDGE_MAGIC;

use crate::state::EdgeState;

/// UDP server for voice data.
pub struct UdpServer {
    socket: Arc<UdpSocket>,
    edge_state: Arc<EdgeState>,
    /// Maps UDP source address to session ID.
    addr_to_session: Arc<RwLock<HashMap<SocketAddr, u32>>>,
    /// Maps session ID to UDP address.
    session_to_addr: Arc<RwLock<HashMap<u32, SocketAddr>>>,
}

impl UdpServer {
    pub async fn new(addr: SocketAddr, edge_state: Arc<EdgeState>) -> Result<Self> {
        let socket = UdpSocket::bind(addr).await?;
        info!("UDP server listening on {}", addr);
        Ok(Self {
            socket: Arc::new(socket),
            edge_state,
            addr_to_session: Arc::new(RwLock::new(HashMap::new())),
            session_to_addr: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Register a client's UDP address (called when we first see a valid UDP packet from them).
    pub async fn register_client(&self, session_id: u32, addr: SocketAddr) {
        self.addr_to_session.write().await.insert(addr, session_id);
        self.session_to_addr.write().await.insert(session_id, addr);
        debug!("Registered UDP client: session {} at {}", session_id, addr);
    }

    /// Unregister a client's UDP address.
    pub async fn unregister_client(&self, session_id: u32) {
        if let Some(addr) = self.session_to_addr.write().await.remove(&session_id) {
            self.addr_to_session.write().await.remove(&addr);
        }
    }

    /// Main receive loop for UDP packets.
    pub async fn run(&self) -> Result<()> {
        let mut buf = [0u8; 2048];

        loop {
            let (len, peer_addr) = self.socket.recv_from(&mut buf).await?;
            if len < 4 {
                continue;
            }

            // Check if this is an Edge-to-Edge packet (magic number 0x0000)
            if buf[0] == EDGE_MAGIC[0] && buf[1] == EDGE_MAGIC[1] {
                self.handle_edge_packet(&buf[2..len], peer_addr).await;
            } else {
                self.handle_client_voice_packet(&buf[..len], peer_addr).await;
            }
        }
    }

    /// Handle a voice packet from a Mumble client.
    async fn handle_client_voice_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        // Look up session by UDP address
        let session_id = match self.addr_to_session.read().await.get(&peer_addr).copied() {
            Some(sid) => sid,
            None => {
                // First packet from this client - attempt to identify
                // The Mumble protocol sends a 4-byte ping packet first (type + session_id encoded)
                // We need to handle the initial ping to register the client
                if data.len() == 12 {
                    // This is likely a UDP ping - first byte is header/type
                    // Try to extract a session hint from the packet
                    debug!("UDP ping from unknown client {}, {} bytes", peer_addr, data.len());
                }
                return;
            }
        };

        // Get the sender's channel
        let channel_id = match self.edge_state.client_manager.get_client(session_id).await {
            Some(client) => client.channel_id,
            None => return,
        };

        // Forward voice data to all other clients in the same channel via UDP
        let sessions = self.edge_state.client_manager.get_channel_sessions(channel_id).await;
        let session_addrs = self.session_to_addr.read().await;

        for target_session in sessions {
            if target_session == session_id {
                continue;
            }
            if let Some(&target_addr) = session_addrs.get(&target_session) {
                if let Err(e) = self.socket.send_to(data, target_addr).await {
                    debug!("Failed to send UDP voice to session {} at {}: {}", target_session, target_addr, e);
                }
            } else {
                // Client doesn't have UDP, fall back to TCP tunnel
                let mut tcp_buf = BytesMut::new();
                bytes::BufMut::put_u16(&mut tcp_buf, MessageType::UdpTunnel as u16);
                bytes::BufMut::put_u32(&mut tcp_buf, data.len() as u32);
                bytes::BufMut::put_slice(&mut tcp_buf, data);
                let tcp_data = tcp_buf.to_vec();

                if let Some(sender) = self.edge_state.client_manager.get_sender(target_session).await {
                    sender.send_raw(tcp_data).await;
                }
            }
        }
    }

    /// Handle an Edge-to-Edge packet.
    async fn handle_edge_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        debug!("Edge packet from {} ({} bytes)", peer_addr, data.len());
        // Edge-to-Edge voice relay would be handled here
        // For now, log and ignore
    }

    /// Send a UDP packet to a client (used for forwarding TCP voice to UDP clients).
    pub async fn send_to_client(&self, session_id: u32, data: &[u8]) -> bool {
        if let Some(&addr) = self.session_to_addr.read().await.get(&session_id) {
            self.socket.send_to(data, addr).await.is_ok()
        } else {
            false
        }
    }
}
