use std::net::SocketAddr;
use std::collections::HashMap;

use tokio::sync::mpsc;

/// Outbound TCP voice connection pool for a single peer Edge.
///
/// `pool_size` independent WebSocket connections are maintained.  Outbound
/// frames are distributed round-robin across live slots; failed/reconnecting
/// slots are skipped transparently.
pub struct PeerVoiceTcpPool {
    /// Per-slot senders.  `None` while the slot is reconnecting.
    pub senders: Vec<std::sync::Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    /// Round-robin counter.
    pub next_rr: std::sync::atomic::AtomicUsize,
}

impl PeerVoiceTcpPool {
    pub fn new(pool_size: usize) -> Self {
        let senders = (0..pool_size.max(1))
            .map(|_| std::sync::Mutex::new(None))
            .collect();
        Self {
            senders,
            next_rr: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Returns `true` if at least one slot currently holds a live sender.
    pub fn has_live_sender(&self) -> bool {
        self.senders.iter().any(|m| {
            m.lock().ok().map_or(false, |g| g.is_some())
        })
    }

    /// Try to send `frame` to one live slot (round-robin).
    ///
    /// Returns `true` if the frame was accepted by at least one slot.
    pub fn try_send(&self, frame: Vec<u8>) -> bool {
        let n = self.senders.len();
        let start = self.next_rr.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % n;
        for i in 0..n {
            let idx = (start + i) % n;
            let sent = self.senders[idx]
                .lock()
                .ok()
                .and_then(|slot| {
                    slot.as_ref().map(|tx| tx.try_send(frame.clone()).is_ok())
                })
                .unwrap_or(false);
            if sent {
                return true;
            }
        }
        false
    }

    /// Drop all slot senders, causing every active writer loop to see
    /// `rx.recv() → None` and exit cleanly.  Called on `hub.peerLeft`.
    pub fn close_all(&self) {
        for slot in &self.senders {
            if let Ok(mut g) = slot.lock() {
                *g = None;
            }
        }
    }
}

/// Information about a peer Edge node.
#[derive(Debug, Clone)]
pub struct PeerEdgeInfo {
    /// Edge-to-Edge UDP endpoint (dedicated `edge_port`).
    pub udp_addr: SocketAddr,
    /// Hostname of the peer Edge (same as used for UDP routing).
    pub host: String,
    /// Control-relay port of the peer Edge.
    /// Every Edge exposes a relay server on this port; it transparently
    /// forwards WebSocket traffic to Hub on behalf of Edges that cannot reach
    /// Hub directly.  `None` means the relay port was not yet advertised.
    pub relay_port: Option<u16>,
}

/// Registry of known peer Edges, populated from `hub.peerJoined` notifications.
#[derive(Debug, Default, Clone)]
pub struct PeerRegistry {
    peers: HashMap<u32, PeerEdgeInfo>,
    /// Reverse index: UDP address → edge_id, used for O(1) probe-pong lookup.
    addr_to_id: HashMap<SocketAddr, u32>,
}

impl PeerRegistry {
    pub fn upsert(&mut self, edge_id: u32, info: PeerEdgeInfo) {
        // Remove stale reverse-index entry if the peer's address changed.
        if let Some(old) = self.peers.get(&edge_id) {
            self.addr_to_id.remove(&old.udp_addr);
        }
        self.addr_to_id.insert(info.udp_addr, edge_id);
        self.peers.insert(edge_id, info);
    }

    pub fn remove(&mut self, edge_id: u32) {
        if let Some(old) = self.peers.remove(&edge_id) {
            self.addr_to_id.remove(&old.udp_addr);
        }
    }

    pub fn get(&self, edge_id: u32) -> Option<&PeerEdgeInfo> {
        self.peers.get(&edge_id)
    }

    /// O(1) lookup of the edge ID for a given UDP address.
    /// Used by the probe-pong handler to avoid a linear scan over all peers.
    pub fn find_by_addr(&self, addr: SocketAddr) -> Option<u32> {
        self.addr_to_id.get(&addr).copied()
    }

    /// Collect all peers that have a relay_port advertised.
    /// Returns a snapshot `Vec<(peer_id, host, relay_port)>` so the caller
    /// does not need to hold the lock while iterating.
    pub fn relay_peers(&self) -> Vec<(u32, String, u16)> {
        self.peers
            .iter()
            .filter_map(|(id, info)| {
                info.relay_port.map(|p| (*id, info.host.clone(), p))
            })
            .collect()
    }

    /// Returns all known peer edge IDs and their UDP addresses (for voice relay).
    pub fn all_udp_peers(&self) -> Vec<(u32, SocketAddr)> {
        self.peers
            .iter()
            .map(|(id, info)| (*id, info.udp_addr))
            .collect()
    }
}
