use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::sync::{broadcast, Mutex, RwLock};

use crate::channel_manager::ChannelManager;
use crate::client::ClientManager;

/// Information about a peer Edge node for direct UDP routing.
#[derive(Debug, Clone)]
pub struct PeerEdgeInfo {
    /// Edge-to-Edge UDP endpoint (dedicated `edge_port`).
    pub udp_addr: SocketAddr,
}

/// Registry of known peer Edges, populated from `hub.peerJoined` notifications.
#[derive(Debug, Default)]
pub struct PeerRegistry {
    peers: HashMap<u32, PeerEdgeInfo>,
}

impl PeerRegistry {
    pub fn upsert(&mut self, edge_id: u32, info: PeerEdgeInfo) {
        self.peers.insert(edge_id, info);
    }

    pub fn remove(&mut self, edge_id: u32) {
        self.peers.remove(&edge_id);
    }

    pub fn get(&self, edge_id: u32) -> Option<&PeerEdgeInfo> {
        self.peers.get(&edge_id)
    }
}

/// A single voice target configuration (whisper/shout destinations).
#[derive(Debug, Clone)]
pub struct VoiceTargetConfig {
    pub sessions: Vec<u32>,
    pub channels: Vec<VoiceTargetChannelConfig>,
}

#[derive(Debug, Clone)]
pub struct VoiceTargetChannelConfig {
    pub channel_id: u32,
    pub links: bool,
    pub children: bool,
    pub group: Option<String>,
}

/// Delta of boolean state fields for a remote user state change.
/// Only fields that actually changed carry `Some(value)`; unchanged fields are `None`.
#[derive(Debug, Clone, Default)]
pub struct RemoteUserStateDelta {
    pub self_mute: Option<bool>,
    pub self_deaf: Option<bool>,
    pub mute: Option<bool>,
    pub deaf: Option<bool>,
    pub suppress: Option<bool>,
    pub priority_speaker: Option<bool>,
    pub recording: Option<bool>,
}

/// Events broadcast within the Edge server.
#[derive(Debug, Clone)]
pub enum EdgeEvent {
    /// Hub registration completed, channels/users loaded.
    HubRegistered,
    /// Hub connection lost.
    HubDisconnected,
    /// A remote user joined (from another Edge, synced via Hub).
    RemoteUserJoined { session_id: u32, username: String, channel_id: u32, is_ninja: bool },
    /// A remote user left.
    RemoteUserLeft { session_id: u32 },
    /// A remote user's state changed (mute, deaf, etc.).
    RemoteUserStateChanged {
        session_id: u32,
        delta: RemoteUserStateDelta,
        listening_channel_add: Vec<u32>,
        listening_channel_remove: Vec<u32>,
    },
    /// A remote user moved channels.
    RemoteUserMoved { session_id: u32, channel_id: u32 },
    /// A channel was created.
    ChannelCreated { channel_id: u32 },
    /// A channel was removed.
    ChannelRemoved { channel_id: u32 },
    /// A channel was updated.
    ChannelUpdated { channel_id: u32 },
    /// A text message forwarded from another edge via Hub.
    TextMessageForward {
        actor: u32,
        message: String,
        channel_id: Vec<u32>,
        tree_id: Vec<u32>,
        session: Vec<u32>,
    },
    /// Plugin data forwarded from another edge via Hub.
    PluginDataBroadcast {
        sender_session: u32,
        data_id: String,
        data: Vec<u8>,
        target_sessions: Vec<u32>,
    },
    /// Voice packet relayed from another edge via Hub TCP.
    RelayedVoice {
        voice_packet: Vec<u8>,
    },
    /// Hub requested this Edge to shut down (cluster partition handling).
    ShutdownRequested {
        reason: String,
    },
}

/// Shared state accessible by all components of the Edge server.
pub struct EdgeState {
    /// Our assigned edge ID (from Hub registration).
    pub edge_id: RwLock<Option<u32>>,
    /// Whether the Hub requires client certificates.
    pub cert_required: RwLock<bool>,
    /// Channel manager (channels + remote users synced from Hub).
    pub channel_manager: Arc<ChannelManager>,
    /// Local client manager (clients connected to this Edge).
    pub client_manager: Arc<ClientManager>,
    /// Event bus for internal notifications.
    pub event_tx: broadcast::Sender<EdgeEvent>,
    /// Voice target cache: session_id -> target_id -> VoiceTargetConfig
    pub voice_targets: Mutex<HashMap<u32, HashMap<u32, VoiceTargetConfig>>>,
    /// Registry of peer Edges and their UDP endpoints for direct voice routing.
    pub peer_registry: Mutex<PeerRegistry>,
    /// When true, skip Hub relay and only use direct Edge-to-Edge UDP.
    /// Used in integration tests to verify the direct connection path.
    /// Deprecated in favour of `voice_routing.connection_strategy = "direct_only"`.
    pub disable_hub_relay: bool,
    /// Whether Hub-mediated TCP relay is allowed for cross-Edge voice.
    /// Derived from `voice_routing.connection_strategy`.
    pub allow_hub_relay: bool,
    /// Whether direct Edge-to-Edge UDP routing is attempted.
    /// Derived from `voice_routing.connection_strategy`.
    pub allow_direct_udp: bool,
    /// Maximum number of channels a single user may listen to simultaneously.
    /// 0 = unlimited.
    pub listeners_per_user: u32,
    /// Maximum number of listeners allowed in a single channel.
    /// 0 = unlimited.
    pub listeners_per_channel: u32,
    /// Channel Ninja: list of channel IDs that are hidden from unprivileged users.
    /// Users without both Enter (0x4) AND Listen (0x800) permission on the channel
    /// will not see its occupants.  Populated from Hub on registration.
    pub ninja_channels: tokio::sync::RwLock<Vec<u32>>,
    /// Per-session ninja channel permission cache.
    /// session_id -> set of channel IDs the user has Enter permission on.
    /// Used for fast ninja visibility checks without Hub round-trips.
    pub ninja_visible_to: tokio::sync::RwLock<HashMap<u32, std::collections::HashSet<u32>>>,
}

impl EdgeState {
    pub fn new(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        disable_hub_relay: bool,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            edge_id: RwLock::new(None),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: Mutex::new(HashMap::new()),
            peer_registry: Mutex::new(PeerRegistry::default()),
            disable_hub_relay,
            allow_hub_relay: !disable_hub_relay,
            allow_direct_udp: true,
            listeners_per_user: 0,
            listeners_per_channel: 0,
            ninja_channels: tokio::sync::RwLock::new(vec![]),
            ninja_visible_to: tokio::sync::RwLock::new(HashMap::new()),
        })
    }

    /// Create EdgeState with explicit voice routing strategy flags.
    pub fn new_with_strategy(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        allow_hub_relay: bool,
        allow_direct_udp: bool,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            edge_id: RwLock::new(None),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: Mutex::new(HashMap::new()),
            peer_registry: Mutex::new(PeerRegistry::default()),
            // disable_hub_relay kept for backwards compat; derived from allow_hub_relay
            disable_hub_relay: !allow_hub_relay,
            allow_hub_relay,
            allow_direct_udp,
            listeners_per_user: 0,
            listeners_per_channel: 0,
            ninja_channels: tokio::sync::RwLock::new(vec![]),
            ninja_visible_to: tokio::sync::RwLock::new(HashMap::new()),
        })
    }

    /// Create EdgeState with explicit voice routing strategy flags and listener limits.
    pub fn new_with_config(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
        allow_hub_relay: bool,
        allow_direct_udp: bool,
        listeners_per_user: u32,
        listeners_per_channel: u32,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            edge_id: RwLock::new(None),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
            voice_targets: Mutex::new(HashMap::new()),
            peer_registry: Mutex::new(PeerRegistry::default()),
            disable_hub_relay: !allow_hub_relay,
            allow_hub_relay,
            allow_direct_udp,
            listeners_per_user,
            listeners_per_channel,
            ninja_channels: tokio::sync::RwLock::new(vec![]),
            ninja_visible_to: tokio::sync::RwLock::new(HashMap::new()),
        })
    }

    /// Get a receiver for edge events.
    pub fn subscribe_events(&self) -> broadcast::Receiver<EdgeEvent> {
        self.event_tx.subscribe()
    }

    /// Broadcast an event.
    pub fn emit(&self, event: EdgeEvent) {
        let _ = self.event_tx.send(event);
    }
}
