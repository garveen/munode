/// Mumble protocol message type IDs.
///
/// These correspond to the message type numbers used in the Mumble protocol
/// wire format: [type:u16][length:u32][protobuf payload].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
    /// Try to create a MessageType from a u16 wire value.
    pub fn from_u16(value: u16) -> Option<Self> {
        match value {
            0 => Some(Self::Version),
            1 => Some(Self::UdpTunnel),
            2 => Some(Self::Authenticate),
            3 => Some(Self::Ping),
            4 => Some(Self::Reject),
            5 => Some(Self::ServerSync),
            6 => Some(Self::ChannelRemove),
            7 => Some(Self::ChannelState),
            8 => Some(Self::UserRemove),
            9 => Some(Self::UserState),
            10 => Some(Self::BanList),
            11 => Some(Self::TextMessage),
            12 => Some(Self::PermissionDenied),
            13 => Some(Self::Acl),
            14 => Some(Self::QueryUsers),
            15 => Some(Self::CryptSetup),
            16 => Some(Self::ContextActionModify),
            17 => Some(Self::ContextAction),
            18 => Some(Self::UserList),
            19 => Some(Self::VoiceTarget),
            20 => Some(Self::PermissionQuery),
            21 => Some(Self::CodecVersion),
            22 => Some(Self::UserStats),
            23 => Some(Self::RequestBlob),
            24 => Some(Self::ServerConfig),
            25 => Some(Self::SuggestConfig),
            26 => Some(Self::PluginDataTransmission),
            _ => None,
        }
    }
}

/// UDP voice codec type IDs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum UdpVoiceType {
    CeltAlpha = 0,
    Ping = 1,
    Speex = 2,
    CeltBeta = 3,
    Opus = 4,
}
