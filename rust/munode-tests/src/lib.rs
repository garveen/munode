//! MuNode integration tests — entry point.
//!
//! This crate exercises a real Hub + Edge cluster using `munode-client`.
//!
//! Run with: `cargo test -p munode-tests -- --test-threads=1 --nocapture`
//!
//! Environment variables:
//!   MUNODE_TEST_LOG=debug   — enable tracing output
//!   MUNODE_HUB_BIN          — path to munode-hub binary (uses target/debug by default)
//!   MUNODE_EDGE_BIN         — path to munode-edge binary

pub mod auth;
pub mod harness;
pub mod users;

#[cfg(test)]
pub mod suites;
