//! Mumble protocol permission bit flags.
//!
//! These constants are shared between the Hub (ACL evaluation) and the Edge
//! (permission checks on the hot path). Keeping them in one place ensures
//! both crates always agree on the bit layout.
//!
//! The values mirror the Mumble protocol's `PermissionDenied.Permission` enum
//! and must not be changed without updating the protobuf definition too.

/// No permissions.
pub const NONE: u32 = 0x0;
/// Write / admin — implies all permissions except Speak and Whisper.
pub const WRITE: u32 = 0x1;
/// Traverse — allows a user to traverse a channel without being shown in it.
pub const TRAVERSE: u32 = 0x2;
/// Enter a channel.
pub const ENTER: u32 = 0x4;
/// Speak (transmit voice) in a channel.
pub const SPEAK: u32 = 0x8;
/// Mute/deafen other users.
pub const MUTE_DEAFEN: u32 = 0x10;
/// Move users to/from a channel.
pub const MOVE: u32 = 0x20;
/// Create sub-channels.
pub const MAKE_CHANNEL: u32 = 0x40;
/// Link channels.
pub const LINK_CHANNEL: u32 = 0x80;
/// Send whisper-only voice.
pub const WHISPER: u32 = 0x100;
/// Send text messages.
pub const TEXT_MESSAGE: u32 = 0x200;
/// Create temporary channels.
pub const TEMP_CHANNEL: u32 = 0x400;
/// Listen to a channel without entering it.
pub const LISTEN: u32 = 0x800;
/// Kick users.
pub const KICK: u32 = 0x10000;
/// Ban users.
pub const BAN: u32 = 0x20000;
/// Register other users.
pub const REGISTER: u32 = 0x40000;
/// Self-register.
pub const SELF_REGISTER: u32 = 0x80000;

/// All permissions combined.
pub const ALL: u32 = 0xF0FFF;
/// Default permissions granted to unauthenticated users.
pub const DEFAULT: u32 = TRAVERSE | ENTER | SPEAK | WHISPER | TEXT_MESSAGE | LISTEN;
