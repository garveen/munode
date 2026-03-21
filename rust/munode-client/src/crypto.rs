//! Client-side CryptState wrapper.
//!
//! When the server sends `CryptSetup { key, client_nonce, server_nonce }`:
//! - The *client* **encrypts** data it sends → the server **decrypts** it.
//!   The client's encrypt IV is the `client_nonce`.
//! - The *client* **decrypts** data it receives → the server **encrypted** it.
//!   The client's decrypt IV is the `server_nonce`.
//!
//! This is the opposite of how the server initialises its own `CryptState`.

pub use munode_protocol::crypto::CryptState;

/// Initialise a [`CryptState`] from fields received in a `CryptSetup` message.
///
/// `key` / `client_nonce` / `server_nonce` are the raw bytes from the protobuf
/// message.  Returns `None` if any field has the wrong length (should be 16 bytes).
pub fn from_crypt_setup(
    key: &[u8],
    client_nonce: &[u8],
    server_nonce: &[u8],
) -> Option<CryptState> {
    let key: &[u8; 16] = key.try_into().ok()?;
    let client_nonce: &[u8; 16] = client_nonce.try_into().ok()?;
    let server_nonce: &[u8; 16] = server_nonce.try_into().ok()?;

    let mut crypt = CryptState::new();
    // Client direction:
    //   encrypt_iv = client_nonce  (we send → server decrypts with client_nonce)
    //   decrypt_iv = server_nonce  (server sends → we decrypt with server_nonce)
    crypt.set_key(key, client_nonce, server_nonce);
    Some(crypt)
}
