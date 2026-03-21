//! OCB2-AES128 voice encryption — re-exported from `munode_protocol::crypto`.
//!
//! The implementation lives in `munode-protocol` so that `munode-test-client`
//! can also use it without pulling in the entire Edge crate.
pub use munode_protocol::crypto::CryptState;
