use num_enum::{IntoPrimitive, TryFromPrimitive};

/// Mumble protocol message type IDs.
///
/// These correspond to the message type numbers used in the Mumble protocol
/// wire format: `[type:u16][length:u32][protobuf payload]`.
///
/// `TryFromPrimitive` (from `num_enum`) generates `TryFrom<u16>` automatically,
/// keeping the variant list and the integer conversion in sync — no manual match
/// needed.  The `from_u16` convenience wrapper is kept for call-site readability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, TryFromPrimitive, IntoPrimitive)]
#[repr(u16)]
pub enum MessageType {
    Version = 0,
    UdpTunnel = 1,
    Authenticate = 2,
    Ping = 3,
    Reject = 4,
    ServerSync = 5,
    ChannelRemove = 6,
    ChannelState = 7,
    UserRemove = 8,
    UserState = 9,
    BanList = 10,
    TextMessage = 11,
    PermissionDenied = 12,
    Acl = 13,
    QueryUsers = 14,
    CryptSetup = 15,
    ContextActionModify = 16,
    ContextAction = 17,
    UserList = 18,
    VoiceTarget = 19,
    PermissionQuery = 20,
    CodecVersion = 21,
    UserStats = 22,
    RequestBlob = 23,
    ServerConfig = 24,
    SuggestConfig = 25,
    PluginDataTransmission = 26,
}

impl MessageType {
    /// Try to create a `MessageType` from a u16 wire value.
    ///
    /// Returns `None` for unknown type IDs.  The conversion is backed by the
    /// `num_enum::TryFromPrimitive` derive, so adding a new variant to the enum
    /// is all that is needed — no manual match arm required.
    #[inline]
    pub fn from_u16(value: u16) -> Option<Self> {
        Self::try_from(value).ok()
    }
}

/// UDP voice codec type IDs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, TryFromPrimitive, IntoPrimitive)]
#[repr(u8)]
pub enum UdpVoiceType {
    CeltAlpha = 0,
    Ping = 1,
    Speex = 2,
    CeltBeta = 3,
    Opus = 4,
}
