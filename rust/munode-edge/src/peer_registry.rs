use std::collections::HashMap;
use std::net::SocketAddr;

use smallvec::SmallVec;
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
    /// Unix-millisecond timestamp when all slots went disconnected simultaneously.
    /// Value `0` means at least one slot is currently connected.
    /// Written once when the last live slot drops; cleared when any slot reconnects.
    /// Used by `run_voice_tcp_slot` to detect prolonged full-pool disconnection and
    /// trigger `edge.reportPeerDisconnect` after `PEER_DISCONNECT_REPORT_AFTER_MS`.
    pub all_disconnected_since_ms: std::sync::atomic::AtomicU64,
    /// Set to `true` once `edge.reportPeerDisconnect` has been sent for the current
    /// disconnection episode.  Reset to `false` when any slot successfully reconnects
    /// so that a future disconnection can be reported again.
    pub disconnect_reported: std::sync::atomic::AtomicBool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerVoiceTcpPoolSnapshot {
    pub configured_slots: usize,
    pub live_slots: usize,
    pub has_live_connection: bool,
    pub all_disconnected_since_ms: Option<u64>,
    pub disconnect_reported: bool,
    pub slot_states: Vec<bool>,
}

impl PeerVoiceTcpPool {
    pub fn new(pool_size: usize) -> Self {
        let senders = (0..pool_size.max(1))
            .map(|_| std::sync::Mutex::new(None))
            .collect();
        Self {
            senders,
            next_rr: std::sync::atomic::AtomicUsize::new(0),
            all_disconnected_since_ms: std::sync::atomic::AtomicU64::new(0),
            disconnect_reported: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Called by a slot immediately after it stores its sender into the pool,
    /// signalling that at least one connection is live.
    /// Clears the disconnection-since timestamp and resets the report flag so
    /// a future full-pool disconnection can trigger a fresh report.
    pub fn mark_connected(&self) {
        self.all_disconnected_since_ms
            .store(0, std::sync::atomic::Ordering::Release);
        self.disconnect_reported
            .store(false, std::sync::atomic::Ordering::Release);
    }

    /// Called by a slot after it clears its own sender.
    /// If no other slot is currently connected, records the current time as the
    /// start of the all-disconnected window (only the first caller wins via CAS).
    pub fn mark_slot_disconnected(&self, now_ms: u64) {
        if !self.has_live_sender() {
            // Only the first slot to observe the fully-down state records the timestamp.
            let _ = self.all_disconnected_since_ms.compare_exchange(
                0,
                now_ms,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
    }

    /// Returns `true` if at least one slot currently holds a live sender.
    pub fn has_live_sender(&self) -> bool {
        self.senders
            .iter()
            .any(|m| m.lock().ok().is_some_and(|g| g.is_some()))
    }

    /// Capture a read-only snapshot of the current pool state for diagnostics.
    pub fn snapshot(&self) -> PeerVoiceTcpPoolSnapshot {
        let slot_states: Vec<bool> = self
            .senders
            .iter()
            .map(|slot| slot.lock().ok().is_some_and(|guard| guard.is_some()))
            .collect();
        let live_slots = slot_states.iter().filter(|connected| **connected).count();
        let all_disconnected_since_ms = self
            .all_disconnected_since_ms
            .load(std::sync::atomic::Ordering::Acquire);

        PeerVoiceTcpPoolSnapshot {
            configured_slots: self.senders.len(),
            live_slots,
            has_live_connection: live_slots > 0,
            all_disconnected_since_ms: (all_disconnected_since_ms != 0)
                .then_some(all_disconnected_since_ms),
            disconnect_reported: self
                .disconnect_reported
                .load(std::sync::atomic::Ordering::Acquire),
            slot_states,
        }
    }

    /// Try to send `frame` to one live slot (round-robin).
    ///
    /// - Uses `TrySendError` to reclaim frame ownership on failure, eliminating
    ///   any clone in the common case where the first-tried slot is live.
    /// - `Closed` slots are pruned in-place (set to `None`) so subsequent sends
    ///   skip them immediately rather than waiting for the slot task to clean up.
    /// - `Full` slots are skipped and tried next (back-pressure avoidance on the
    ///   voice hot path).
    ///
    /// Returns `true` if the frame was accepted by at least one slot.
    pub fn try_send(&self, frame: Vec<u8>) -> bool {
        let n = self.senders.len();
        let start = self
            .next_rr
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            % n;
        let mut remaining = frame;
        for i in 0..n {
            let idx = (start + i) % n;
            if let Ok(mut slot) = self.senders[idx].lock()
                && let Some(tx) = slot.as_ref()
            {
                match tx.try_send(remaining) {
                    Ok(()) => return true,
                    Err(tokio::sync::mpsc::error::TrySendError::Closed(f)) => {
                        // Connection dead — prune immediately so future sends skip it
                        // rather than waiting for the slot reconnect task to clear it.
                        *slot = None;
                        remaining = f;
                    }
                    Err(tokio::sync::mpsc::error::TrySendError::Full(f)) => {
                        // Channel buffer full — skip to next slot.
                        remaining = f;
                    }
                }
            }
            // slot is None (reconnecting) — fall through to next slot
            // mutex poisoned — skip this slot
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

/// A single endpoint of a peer Edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerEndpoint {
    pub id: Option<String>,
    pub host: String,
    pub port: u16,
    pub udp_addr: SocketAddr,
}

/// Information about a peer Edge node.
#[derive(Debug, Clone)]
pub struct PeerEdgeInfo {
    /// Edge-to-Edge UDP endpoint (dedicated `edge_port`).
    pub udp_addr: SocketAddr,
    /// Hostname of the peer Edge.
    pub host: String,
    /// Control-relay port of the peer Edge.
    pub relay_port: Option<u16>,
    /// Additional endpoints exposed by this peer (from Hub discovery).
    pub endpoints: Vec<PeerEndpoint>,
}

/// Registry of known peer Edges, populated from `hub.peerJoined` notifications.
#[derive(Debug, Default, Clone)]
pub struct PeerRegistry {
    peers: HashMap<u32, PeerEdgeInfo>,
    /// Reverse index: UDP address → edge_id.
    addr_to_id: HashMap<SocketAddr, u32>,
    /// Reverse index: (edge_id, endpoint_id) → UDP address.
    endpoint_addr: HashMap<(u32, String), SocketAddr>,
}

impl PeerRegistry {
    pub fn upsert(&mut self, edge_id: u32, info: PeerEdgeInfo) {
        if let Some(old) = self.peers.get(&edge_id) {
            self.addr_to_id.remove(&old.udp_addr);
            for ep in &old.endpoints {
                self.addr_to_id.remove(&ep.udp_addr);
                if let Some(ref id) = ep.id {
                    self.endpoint_addr.remove(&(edge_id, id.clone()));
                }
            }
        }
        self.addr_to_id.insert(info.udp_addr, edge_id);
        for ep in &info.endpoints {
            self.addr_to_id.insert(ep.udp_addr, edge_id);
            if let Some(ref id) = ep.id {
                self.endpoint_addr
                    .insert((edge_id, id.clone()), ep.udp_addr);
            }
        }
        self.peers.insert(edge_id, info);
    }

    pub fn remove(&mut self, edge_id: u32) {
        if let Some(old) = self.peers.remove(&edge_id) {
            self.addr_to_id.remove(&old.udp_addr);
            for ep in &old.endpoints {
                self.addr_to_id.remove(&ep.udp_addr);
                if let Some(ref id) = ep.id {
                    self.endpoint_addr.remove(&(edge_id, id.clone()));
                }
            }
        }
    }

    pub fn get(&self, edge_id: u32) -> Option<&PeerEdgeInfo> {
        self.peers.get(&edge_id)
    }

    pub fn all_peers(&self) -> Vec<(u32, PeerEdgeInfo)> {
        self.peers
            .iter()
            .map(|(id, info)| (*id, info.clone()))
            .collect()
    }

    pub fn find_by_addr(&self, addr: SocketAddr) -> Option<u32> {
        self.addr_to_id.get(&addr).copied()
    }

    /// Look up both edge_id and endpoint_id for a given UDP address.
    pub fn find_endpoint_by_addr(&self, addr: SocketAddr) -> Option<(u32, Option<String>)> {
        let edge_id = self.addr_to_id.get(&addr)?;
        for ((eid, epid), ep_addr) in &self.endpoint_addr {
            if *eid == *edge_id && *ep_addr == addr {
                return Some((*edge_id, Some(epid.clone())));
            }
        }
        Some((*edge_id, None))
    }

    pub fn relay_peers(&self) -> Vec<(u32, String, u16)> {
        self.peers
            .iter()
            .map(|(id, info)| {
                let relay_port = info.relay_port.unwrap_or_else(|| info.udp_addr.port());
                (*id, info.host.clone(), relay_port)
            })
            .collect()
    }

    /// All peer endpoints for quality probing: (edge_id, endpoint_id, addr).
    pub fn all_peer_endpoints(&self) -> Vec<(u32, Option<String>, SocketAddr)> {
        let mut result = Vec::new();
        for (id, info) in &self.peers {
            result.push((*id, None, info.udp_addr));
            for ep in &info.endpoints {
                result.push((*id, ep.id.clone(), ep.udp_addr));
            }
        }
        result
    }

    /// All UDP peers (default + additional) for voice relay.
    pub fn all_udp_peers(&self) -> Vec<(u32, SocketAddr)> {
        self.peers
            .iter()
            .flat_map(|(id, info)| {
                let mut a = Vec::with_capacity(1 + info.endpoints.len());
                a.push((*id, info.udp_addr));
                a.extend(info.endpoints.iter().map(|ep| (*id, ep.udp_addr)));
                a
            })
            .collect()
    }

    /// Look up a named endpoint's address.
    pub fn endpoint_addr(&self, edge_id: u32, endpoint_id: &str) -> Option<SocketAddr> {
        self.endpoint_addr
            .get(&(edge_id, endpoint_id.to_string()))
            .copied()
    }

    pub fn udp_peer_ids_except(&self, excluded_edge_id: u32) -> SmallVec<[u32; 8]> {
        self.peers
            .keys()
            .filter_map(|&e| (e != excluded_edge_id).then_some(e))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{PeerEdgeInfo, PeerRegistry};

    #[test]
    fn relay_peers_falls_back_to_udp_port_when_metadata_missing() {
        let mut registry = PeerRegistry::default();
        registry.upsert(
            10,
            PeerEdgeInfo {
                udp_addr: "10.0.0.4:64002".parse().unwrap(),
                host: "10.0.0.4".into(),
                relay_port: Some(9000),
                endpoints: Vec::new(),
            },
        );
        registry.upsert(
            11,
            PeerEdgeInfo {
                udp_addr: "10.0.0.5:64003".parse().unwrap(),
                host: "10.0.0.5".into(),
                relay_port: None,
                endpoints: Vec::new(),
            },
        );

        let mut relay_peers = registry.relay_peers();
        relay_peers.sort_by_key(|(id, _, _)| *id);

        assert_eq!(relay_peers.len(), 2);
        assert_eq!(relay_peers[0], (10, "10.0.0.4".into(), 9000));
        assert_eq!(relay_peers[1], (11, "10.0.0.5".into(), 64003));
    }
}
