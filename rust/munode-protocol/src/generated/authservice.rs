// This file is manually maintained to match AuthService.proto
// Package: authservice

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, ::prost::Enumeration)]
#[repr(i32)]
pub enum AuthServicePacketType {
    Unknown = 0,
    AuthRequest = 1,
    AuthResponse = 2,
    Ping = 3,
    Pong = 4,
    Hello = 5,
}

impl AuthServicePacketType {
    /// String value of the enum field names used in the ProtoBuf definition.
    pub fn as_str_name(&self) -> &'static str {
        match self {
            AuthServicePacketType::Unknown => "UNKNOWN",
            AuthServicePacketType::AuthRequest => "AUTH_REQUEST",
            AuthServicePacketType::AuthResponse => "AUTH_RESPONSE",
            AuthServicePacketType::Ping => "PING",
            AuthServicePacketType::Pong => "PONG",
            AuthServicePacketType::Hello => "HELLO",
        }
    }
    /// Creates an enum from field names used in the ProtoBuf definition.
    pub fn from_str_name(value: &str) -> ::core::option::Option<Self> {
        match value {
            "UNKNOWN" => Some(Self::Unknown),
            "AUTH_REQUEST" => Some(Self::AuthRequest),
            "AUTH_RESPONSE" => Some(Self::AuthResponse),
            "PING" => Some(Self::Ping),
            "PONG" => Some(Self::Pong),
            "HELLO" => Some(Self::Hello),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// AuthServicePacket - main wrapper
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct AuthServicePacket {
    #[prost(enumeration = "AuthServicePacketType", required, tag = "1")]
    pub r#type: i32,
    #[prost(message, optional, tag = "2")]
    pub auth_request: ::core::option::Option<AuthRequest>,
    #[prost(message, optional, tag = "3")]
    pub auth_response: ::core::option::Option<AuthResponse>,
    #[prost(message, optional, tag = "5")]
    pub hello: ::core::option::Option<HelloParams>,
}

// ---------------------------------------------------------------------------
// HelloParams
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct HelloParams {
    #[prost(string, required, tag = "1")]
    pub service_name: ::prost::alloc::string::String,
    #[prost(string, optional, tag = "2")]
    pub version: ::core::option::Option<::prost::alloc::string::String>,
}

// ---------------------------------------------------------------------------
// AuthRequest - Hub -> auth service
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct AuthRequest {
    /// Unique request ID for matching response
    #[prost(string, required, tag = "1")]
    pub request_id: ::prost::alloc::string::String,
    #[prost(string, required, tag = "2")]
    pub username: ::prost::alloc::string::String,
    #[prost(string, required, tag = "3")]
    pub password: ::prost::alloc::string::String,
    #[prost(string, repeated, tag = "4")]
    pub tokens: ::prost::alloc::vec::Vec<::prost::alloc::string::String>,
    #[prost(uint32, required, tag = "5")]
    pub session_id: u32,
    #[prost(uint32, required, tag = "6")]
    pub server_id: u32,
    #[prost(string, required, tag = "7")]
    pub ip_address: ::prost::alloc::string::String,
    #[prost(string, required, tag = "8")]
    pub ip_version: ::prost::alloc::string::String,
    #[prost(string, required, tag = "9")]
    pub release: ::prost::alloc::string::String,
    #[prost(uint32, optional, tag = "10")]
    pub version: ::core::option::Option<u32>,
    #[prost(string, required, tag = "11")]
    pub os: ::prost::alloc::string::String,
    #[prost(string, required, tag = "12")]
    pub os_version: ::prost::alloc::string::String,
    #[prost(string, optional, tag = "13")]
    pub certificate_hash: ::core::option::Option<::prost::alloc::string::String>,
}

// ---------------------------------------------------------------------------
// AuthResponse - auth service -> Hub
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct AuthResponse {
    /// Must match the request_id from the corresponding AuthRequest
    #[prost(string, required, tag = "1")]
    pub request_id: ::prost::alloc::string::String,
    #[prost(bool, required, tag = "2")]
    pub success: bool,
    #[prost(uint32, optional, tag = "3")]
    pub user_id: ::core::option::Option<u32>,
    #[prost(string, optional, tag = "4")]
    pub username: ::core::option::Option<::prost::alloc::string::String>,
    #[prost(string, optional, tag = "5")]
    pub display_name: ::core::option::Option<::prost::alloc::string::String>,
    #[prost(string, repeated, tag = "6")]
    pub groups: ::prost::alloc::vec::Vec<::prost::alloc::string::String>,
    #[prost(string, optional, tag = "7")]
    pub reason: ::core::option::Option<::prost::alloc::string::String>,
    #[prost(uint32, optional, tag = "8")]
    pub reject_type: ::core::option::Option<u32>,
    #[prost(uint32, optional, tag = "9")]
    pub channel_id: ::core::option::Option<u32>,
    #[prost(bool, optional, tag = "10")]
    pub cert_required: ::core::option::Option<bool>,
}
