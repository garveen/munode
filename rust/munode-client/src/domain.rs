//! Higher-level domain types used by the handle-based API.
//!
//! These types wrap protobuf messages with idiomatic Rust shapes so callers
//! don't need to construct or destructure raw `mumbleproto` types directly.

use std::net::IpAddr;

use munode_protocol::mumbleproto;

/// A typed wrapper around `mumbleproto::permission_denied::DenyType`.
///
/// Mirrors the full set of `DenyType` variants from the Mumble protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    Text = 0,
    Permission = 1,
    SuperUser = 2,
    ChannelName = 3,
    TextTooLong = 4,
    H9K = 5,
    TemporaryChannel = 6,
    MissingCertificate = 7,
    UserName = 8,
    ChannelFull = 9,
    NestingLimit = 10,
    ChannelCountLimit = 11,
    ChannelListenerLimit = 12,
    UserListenerLimit = 13,
    Unknown = 0xFF,
}

impl DenyReason {
    pub fn from_proto(t: i32) -> Self {
        match t {
            0 => Self::Text,
            1 => Self::Permission,
            2 => Self::SuperUser,
            3 => Self::ChannelName,
            4 => Self::TextTooLong,
            5 => Self::H9K,
            6 => Self::TemporaryChannel,
            7 => Self::MissingCertificate,
            8 => Self::UserName,
            9 => Self::ChannelFull,
            10 => Self::NestingLimit,
            11 => Self::ChannelCountLimit,
            12 => Self::ChannelListenerLimit,
            13 => Self::UserListenerLimit,
            _ => Self::Unknown,
        }
    }
}

/// A typed wrapper around `mumbleproto::reject::RejectType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectType {
    None = 0,
    ServerVersion = 1,
    UsernameInUse = 2,
    WrongUserPw = 3,
    WrongServerPw = 4,
    InvalidUsername = 5,
    AuthenticatorFail = 6,
    NoNewConnections = 7,
    Unknown = 0xFF,
}

impl RejectType {
    pub fn from_proto(t: i32) -> Self {
        match t {
            0 => Self::None,
            1 => Self::ServerVersion,
            2 => Self::UsernameInUse,
            3 => Self::WrongUserPw,
            4 => Self::WrongServerPw,
            5 => Self::InvalidUsername,
            6 => Self::AuthenticatorFail,
            7 => Self::NoNewConnections,
            _ => Self::Unknown,
        }
    }
}

/// A registered ban entry — one row of the server-wide ban list.
#[derive(Debug, Clone)]
pub struct Ban {
    /// IP address of the banned client (IPv4 or IPv6).
    pub address: IpAddr,
    /// CIDR mask length.
    pub mask: u32,
    /// Display name attached to the ban (informational).
    pub name: Option<String>,
    /// Certificate hash of the banned user, if known.
    pub hash: Option<String>,
    /// Free-form reason text.
    pub reason: Option<String>,
    /// Ban start time as ISO-8601 string (server-supplied).
    pub start: Option<String>,
    /// Duration in seconds. `0` (or absent) means permanent.
    pub duration: u32,
}

impl Ban {
    /// Build a new permanent IPv4 /32 ban.
    pub fn ipv4(addr: std::net::Ipv4Addr, reason: impl Into<String>) -> Self {
        Self {
            address: IpAddr::V4(addr),
            mask: 32,
            name: None,
            hash: None,
            reason: Some(reason.into()),
            start: None,
            duration: 0,
        }
    }

    pub(crate) fn to_proto(&self) -> mumbleproto::ban_list::BanEntry {
        // Mumble stores addresses as 16-byte IPv6 (IPv4 is mapped).
        let address: Vec<u8> = match self.address {
            IpAddr::V4(v4) => v4.to_ipv6_mapped().octets().to_vec(),
            IpAddr::V6(v6) => v6.octets().to_vec(),
        };
        mumbleproto::ban_list::BanEntry {
            address,
            mask: self.mask,
            name: self.name.clone(),
            hash: self.hash.clone(),
            reason: self.reason.clone(),
            start: self.start.clone(),
            duration: Some(self.duration),
        }
    }

    pub(crate) fn from_proto(p: &mumbleproto::ban_list::BanEntry) -> Self {
        let address = if p.address.len() == 16 {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&p.address);
            let v6 = std::net::Ipv6Addr::from(octets);
            match v6.to_ipv4_mapped() {
                Some(v4) => IpAddr::V4(v4),
                None => IpAddr::V6(v6),
            }
        } else if p.address.len() == 4 {
            IpAddr::V4(std::net::Ipv4Addr::new(
                p.address[0], p.address[1], p.address[2], p.address[3],
            ))
        } else {
            IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
        };
        Self {
            address,
            mask: p.mask,
            name: p.name.clone(),
            hash: p.hash.clone(),
            reason: p.reason.clone(),
            start: p.start.clone(),
            duration: p.duration.unwrap_or(0),
        }
    }
}

/// A registered (persistent) user entry as returned by `UserList`.
#[derive(Debug, Clone)]
pub struct RegisteredUser {
    pub user_id: u32,
    pub name: Option<String>,
    pub last_seen: Option<String>,
    pub last_channel: Option<u32>,
}

impl RegisteredUser {
    pub(crate) fn from_proto(p: &mumbleproto::user_list::User) -> Self {
        Self {
            user_id: p.user_id,
            name: p.name.clone(),
            last_seen: p.last_seen.clone(),
            last_channel: p.last_channel,
        }
    }

    pub(crate) fn to_proto(&self) -> mumbleproto::user_list::User {
        mumbleproto::user_list::User {
            user_id: self.user_id,
            name: self.name.clone(),
            last_seen: self.last_seen.clone(),
            last_channel: self.last_channel,
        }
    }
}

/// Server information — composite of fields delivered via `Version` /
/// `ServerConfig` / `ServerSync` during the login handshake.
#[derive(Debug, Clone, Default)]
pub struct ServerInformation {
    /// Server `Version.version` (legacy 32-bit packed).
    pub version: u32,
    /// Server `Version.release` string.
    pub release: Option<String>,
    /// Server OS string.
    pub os: Option<String>,
    /// Server OS version string.
    pub os_version: Option<String>,
    /// Welcome text from `ServerConfig`.
    pub welcome_text: Option<String>,
    /// Maximum bandwidth from `ServerConfig`.
    pub max_bandwidth: u32,
    /// Whether the server allows HTML.
    pub allow_html: Option<bool>,
    /// Server message length limit.
    pub message_length: Option<u32>,
    /// Image (texture) length limit.
    pub image_message_length: Option<u32>,
}

/// Snapshot of a context action notification.
#[derive(Debug, Clone)]
pub struct ContextActionInfo {
    pub action: String,
    pub session: Option<u32>,
    pub channel_id: Option<u32>,
}
