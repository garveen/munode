use std::net::SocketAddr;

use anyhow::Result;
use tokio::net::UdpSocket;
use tracing::{debug, info};

use munode_protocol::transport::{EDGE_MAGIC, VOICE_UDP_HEADER_SIZE};

/// UDP server for voice data.
pub struct UdpServer {
    socket: UdpSocket,
}

impl UdpServer {
    pub async fn new(addr: SocketAddr) -> Result<Self> {
        let socket = UdpSocket::bind(addr).await?;
        info!("UDP server listening on {}", addr);
        Ok(Self { socket })
    }

    /// Main receive loop for UDP packets.
    pub async fn run(&self) -> Result<()> {
        let mut buf = [0u8; 2048];

        loop {
            let (len, peer_addr) = self.socket.recv_from(&mut buf).await?;
            if len < 2 {
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
        debug!("Client voice packet from {} ({} bytes)", peer_addr, data.len());
        // TODO: Look up client by UDP address, route through VoiceRouter
    }

    /// Handle an Edge-to-Edge packet.
    async fn handle_edge_packet(&self, data: &[u8], peer_addr: SocketAddr) {
        debug!("Edge packet from {} ({} bytes)", peer_addr, data.len());
        // TODO: Distinguish control packets (protobuf) from voice data (12-byte header)
        if data.len() >= VOICE_UDP_HEADER_SIZE {
            // Could be a voice data packet
            // TODO: Decode header and route
        }
    }
}
