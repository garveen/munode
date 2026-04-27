//! Handle-based API surface for `MumbleClient`.
//!
//! The handles wrap `&MumbleClient` with operation-specific methods that
//! mirror Mumble GUI client concepts:
//!
//! | Handle      | Concept                                  |
//! |-------------|------------------------------------------|
//! | [`Me`]      | Operations on the locally connected user |
//! | [`UserRef`] | Operations on another user (by session)  |
//! | [`ChannelRef`] | Operations on a channel               |
//! | [`Server`]  | Server-wide admin (bans, registered users, info) |
//! | [`Voice`]   | Voice send / whisper target configuration |
//! | [`Acl`]     | ACL editor for a single channel          |

pub mod me;
pub mod user;
pub mod channel;
pub mod server;
pub mod voice;
pub mod acl;

pub use me::Me;
pub use user::UserRef;
pub use channel::ChannelRef;
pub use server::Server;
pub use voice::Voice;
pub use acl::Acl;
