/// Generated protobuf types for Mumble protocol.
pub mod mumbleproto {
    include!("generated/mumbleproto.rs");
}

/// Generated protobuf types for Hub-Edge communication.
pub mod hubedge {
    include!("generated/hubedge.rs");
}

/// Generated protobuf types for Voice UDP protocol.
pub mod voiceudp {
    include!("generated/voiceudp.rs");
}

/// Protobuf types for the external auth service protocol.
pub mod authservice {
    include!("generated/authservice.rs");
    /// Re-export for ergonomic use: `AuthServicePacketType::AuthRequest`, etc.
    pub use auth_service_packet::Type as AuthServicePacketType;
}

/// Generated protobuf types for Edge-to-Edge session sync protocol.
pub mod edgepeersync {
    include!("generated/edgepeersync.rs");

    // Packet type constants — not expressible in proto2 syntax, maintained here.
    pub const PACKET_TYPE_SYNC_REQUEST: u32 = 1;
    pub const PACKET_TYPE_SYNC_RESPONSE: u32 = 2;
    pub const PACKET_TYPE_DELTA: u32 = 3;
}

pub mod message_type;
pub mod transport;
pub mod crypto;
pub mod varint;
