use std::sync::Arc;

use tokio::sync::{broadcast, RwLock};

use crate::channel_manager::ChannelManager;
use crate::client::ClientManager;

/// Events broadcast within the Edge server.
#[derive(Debug, Clone)]
pub enum EdgeEvent {
    /// Hub registration completed, channels/users loaded.
    HubRegistered,
    /// Hub connection lost.
    HubDisconnected,
    /// A remote user joined (from another Edge, synced via Hub).
    RemoteUserJoined { session_id: u32, username: String, channel_id: u32 },
    /// A remote user left.
    RemoteUserLeft { session_id: u32 },
    /// A remote user moved channels.
    RemoteUserMoved { session_id: u32, channel_id: u32 },
    /// A channel was created.
    ChannelCreated { channel_id: u32 },
    /// A channel was removed.
    ChannelRemoved { channel_id: u32 },
    /// A channel was updated.
    ChannelUpdated { channel_id: u32 },
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
}

impl EdgeState {
    pub fn new(
        channel_manager: Arc<ChannelManager>,
        client_manager: Arc<ClientManager>,
    ) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            edge_id: RwLock::new(None),
            cert_required: RwLock::new(false),
            channel_manager,
            client_manager,
            event_tx,
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
