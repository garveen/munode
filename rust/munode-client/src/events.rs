//! Client event types and the broadcast channel used to distribute them.

use crate::state::{Channel, User};
use crate::voice::VoiceData;

/// Every notable event the client can emit.
#[derive(Debug, Clone)]
pub enum ClientEvent {
    /// TCP connection established (before authentication).
    Connected,
    /// Connection closed (gracefully or due to an error).
    Disconnected,
    /// Server sent `ServerSync` — authentication is complete.
    Authenticated { session: u32, max_bandwidth: u32 },
    /// Server rejected the authentication (`Reject` message).
    AuthenticationFailed { reason: String },
    /// A new user appeared on the server (initial sync or join).
    UserJoined(User),
    /// A user left the server.
    UserLeft { session: u32, reason: Option<String> },
    /// A user's state changed (channel, mute, etc.).
    UserStateChanged(User),
    /// A channel was created (initial sync or new channel).
    ChannelCreated(Channel),
    /// A channel was removed.
    ChannelRemoved { channel_id: u32 },
    /// A channel's properties were updated.
    ChannelUpdated(Channel),
    /// A text message was received.
    TextMessage {
        sender: u32,
        /// `None` for private/direct messages.
        channel_id: Option<u32>,
        message: String,
    },
    /// A voice packet was received (from TCP UDPTunnel or UDP).
    Voice(VoiceData),
    /// The UDP handshake completed successfully.
    UdpReady,
    /// The `CryptSetup` message was processed and crypto state is ready.
    CryptoReady,
    /// Permission was denied for an operation.
    PermissionDenied {
        channel_id: u32,
        permission: u32,
        reason: Option<String>,
    },
    /// A `PermissionQuery` response was received.
    PermissionQuery { channel_id: u32, permissions: u32 },
    /// A `UserStats` response was received.
    UserStats(Box<munode_protocol::mumbleproto::UserStats>),
    /// A `BanList` was received.
    BanList(Vec<munode_protocol::mumbleproto::BanList>),
    /// Server configuration received.
    ServerConfig(munode_protocol::mumbleproto::ServerConfig),
    /// The current user was kicked from the server.
    Kicked { session: u32, reason: Option<String> },
    /// A ping response was received.
    Ping { timestamp: u64 },
    /// Plugin data was received.
    PluginData {
        sender: u32,
        plugin_id: String,
        data: Vec<u8>,
    },
    /// A context action was triggered.
    ContextAction {
        action: String,
        session: Option<u32>,
        channel_id: Option<u32>,
    },
    /// ACL data was received.
    Acl(Box<munode_protocol::mumbleproto::Acl>),
    /// QueryUsers response received.
    QueryUsers(munode_protocol::mumbleproto::QueryUsers),
}
