//! OCB2-AES128 voice encryption for Mumble protocol.
//!
//! Implements the OCB2 mode of AES-128 as used by Mumble for UDP voice
//! packet encryption. The algorithm was designed by Phil Rogaway and
//! dedicated to the public domain.
//!
//! Reference: Mumble CryptStateOCB2.cpp
//! https://github.com/mumble-voip/mumble/blob/master/src/crypto/CryptStateOCB2.cpp

use aes::{
    Aes128,
    cipher::{BlockDecrypt, BlockEncrypt, KeyInit},
};
use std::time::{Duration, Instant};

/// OCB2-AES128 cryptographic state for a client connection.
///
/// - `encrypt_iv`: server→client nonce (incremented on each sent packet)
/// - `decrypt_iv`: client→server nonce (tracked from received packets)
/// - `decrypt_history`: replay protection — maps IV\[0\] → last-seen IV\[1\] for
///   each bucket.  This 256-entry table matches the official Mumble/Murmur OCB2
///   reference implementation.  See the inline comment in `decrypt()` for the
///   intentional design trade-off.
pub struct CryptState {
    key: [u8; 16],
    pub encrypt_iv: [u8; 16],
    pub decrypt_iv: [u8; 16],
    decrypt_history: [u8; 256],
    cipher: Aes128,
    /// Count of successfully decrypted in-order packets.
    pub good: u32,
    /// Count of late (out-of-order but accepted) packets.
    pub late: u32,
    /// Count of lost (never received) packets.
    pub lost: u32,
    /// Count of nonce resync operations.
    pub resync: u32,
    last_good: Instant,
    last_request: Instant,
}

impl Clone for CryptState {
    fn clone(&self) -> Self {
        // Reconstruct the cipher from the cloned key — Aes128 itself is not Clone.
        let cipher = Aes128::new_from_slice(&self.key).expect("AES-128 key must be 16 bytes");
        Self {
            key: self.key,
            encrypt_iv: self.encrypt_iv,
            decrypt_iv: self.decrypt_iv,
            decrypt_history: self.decrypt_history,
            cipher,
            good: self.good,
            late: self.late,
            lost: self.lost,
            resync: self.resync,
            last_good: self.last_good,
            last_request: self.last_request,
        }
    }
}

impl Default for CryptState {
    fn default() -> Self {
        Self::new()
    }
}

impl CryptState {
    /// Create a new CryptState with zero key/IVs.
    pub fn new() -> Self {
        let key = [0u8; 16];
        let now = Instant::now();
        // SAFETY: key is always exactly 16 bytes; AES-128 requires 16 bytes.
        let cipher = Aes128::new_from_slice(&key).expect("AES-128 key must be 16 bytes");
        Self {
            key,
            encrypt_iv: [0u8; 16],
            decrypt_iv: [0u8; 16],
            decrypt_history: [0u8; 256],
            cipher,
            good: 0,
            late: 0,
            lost: 0,
            resync: 0,
            last_good: now,
            last_request: now.checked_sub(Duration::from_secs(60)).unwrap_or(now),
        }
    }

    /// Generate a random key and IVs using ring's CSPRNG.
    ///
    /// Returns an error if the system RNG is unavailable (e.g., entropy pool exhausted).
    pub fn generate_key(&mut self) -> Result<(), ring::error::Unspecified> {
        use ring::rand::{SecureRandom, SystemRandom};
        let rng = SystemRandom::new();
        rng.fill(&mut self.key)?;
        rng.fill(&mut self.encrypt_iv)?;
        rng.fill(&mut self.decrypt_iv)?;
        // SAFETY: self.key is always 16 bytes; AES-128 requires 16 bytes.
        self.cipher = Aes128::new_from_slice(&self.key).expect("AES-128 key must be 16 bytes");
        let now = Instant::now();
        self.last_good = now;
        self.last_request = now.checked_sub(Duration::from_secs(60)).unwrap_or(now);
        Ok(())
    }

    /// Set key and IVs explicitly.
    ///
    /// - `key`: 16-byte AES-128 key
    /// - `encrypt_iv`: server→client direction IV (= server_nonce in CryptSetup)
    /// - `decrypt_iv`: client→server direction IV (= client_nonce in CryptSetup)
    pub fn set_key(&mut self, key: &[u8; 16], encrypt_iv: &[u8; 16], decrypt_iv: &[u8; 16]) {
        self.key = *key;
        self.encrypt_iv = *encrypt_iv;
        self.decrypt_iv = *decrypt_iv;
        // SAFETY: self.key is always 16 bytes; AES-128 requires 16 bytes.
        self.cipher = Aes128::new_from_slice(&self.key).expect("AES-128 key must be 16 bytes");
        let now = Instant::now();
        self.last_good = now;
        self.last_request = now.checked_sub(Duration::from_secs(60)).unwrap_or(now);
    }

    /// Get the raw AES key.
    pub fn get_key(&self) -> &[u8; 16] {
        &self.key
    }

    /// Update the decrypt IV from a client-sent CryptSetup resync.
    pub fn update_decrypt_iv(&mut self, client_nonce: &[u8; 16]) {
        self.decrypt_iv = *client_nonce;
        self.resync += 1;
    }

    pub fn should_request_resync(&mut self) -> bool {
        self.should_request_resync_at(Instant::now())
    }

    fn should_request_resync_at(&mut self, now: Instant) -> bool {
        if now.duration_since(self.last_good) <= Duration::from_secs(5)
            || now.duration_since(self.last_request) <= Duration::from_secs(5)
        {
            return false;
        }

        self.last_request = now;
        true
    }

    /// Encrypt a voice packet into `dst`.
    ///
    /// Input: raw voice data (type/target + sequence + audio)
    /// Output format appended to dst: `[nonce_lsb:1][tag:3][encrypted_payload]`
    ///
    /// Returns false if the plaintext triggered an XEX* attack pattern
    /// (rare for normal voice data).
    pub fn encrypt(&mut self, source: &[u8], dst: &mut Vec<u8>) -> bool {
        // Increment encrypt_iv (little-endian counter, carry on overflow)
        for byte in self.encrypt_iv.iter_mut() {
            *byte = byte.wrapping_add(1);
            if *byte != 0 {
                break;
            }
        }

        let nonce = self.encrypt_iv;
        let mut tag = [0u8; 16];

        let header_pos = dst.len();
        // Reserve 4-byte header + payload space
        dst.resize(header_pos + 4 + source.len(), 0);

        let success = ocb_encrypt(
            &self.cipher,
            &nonce,
            source,
            &mut dst[header_pos + 4..],
            &mut tag,
        );

        dst[header_pos] = nonce[0];
        dst[header_pos + 1] = tag[0];
        dst[header_pos + 2] = tag[1];
        dst[header_pos + 3] = tag[2];

        success
    }

    /// Decrypt an incoming voice packet into `dst`.
    ///
    /// Input format: `[nonce_lsb:1][tag:3][encrypted_payload]`
    /// On success, plaintext is appended to `dst` and returns true.
    /// On failure (bad tag, replay, etc.), `dst` is unchanged and returns false.
    pub fn decrypt(&mut self, source: &[u8], dst: &mut Vec<u8>) -> bool {
        if source.len() < 4 {
            return false;
        }

        let plain_len = source.len() - 4;
        let iv_byte = source[0];
        let expected_tag = [source[1], source[2], source[3]];

        // Save current decrypt_iv for restoration on failure
        let save_iv = self.decrypt_iv;
        let mut late = 0i32;
        let mut lost = 0i32;
        let mut restore = false;

        let next_iv_byte = self.decrypt_iv[0].wrapping_add(1);

        if next_iv_byte == iv_byte {
            // In-order packet: advance IV
            if iv_byte > self.decrypt_iv[0] {
                // Normal advance (no wraparound)
                self.decrypt_iv[0] = iv_byte;
            } else if iv_byte < self.decrypt_iv[0] {
                // Wraparound: iv_byte = 0x00, old = 0xFF
                self.decrypt_iv[0] = iv_byte;
                for b in self.decrypt_iv[1..].iter_mut() {
                    *b = b.wrapping_add(1);
                    if *b != 0 {
                        break;
                    }
                }
            } else {
                // Same byte value after +1 mod 256 — shouldn't happen
                return false;
            }
        } else {
            // Out-of-order or lost packets
            let diff = {
                let mut d = (iv_byte as i32) - (self.decrypt_iv[0] as i32);
                if d > 128 {
                    d -= 256;
                } else if d < -128 {
                    d += 256;
                }
                d
            };

            if iv_byte < self.decrypt_iv[0] && diff > -30 && diff < 0 {
                // Late packet (no wraparound)
                late = 1;
                lost = -1;
                self.decrypt_iv[0] = iv_byte;
                restore = true;
            } else if iv_byte > self.decrypt_iv[0] && diff > -30 && diff < 0 {
                // Late packet with wraparound (e.g., prev was 0x02, this is 0xFF)
                late = 1;
                lost = -1;
                self.decrypt_iv[0] = iv_byte;
                // Decrement the carry bytes (borrow from higher bytes)
                for b in self.decrypt_iv[1..].iter_mut() {
                    if *b == 0 {
                        // Was 0 → wraps to 255, continue borrowing
                        *b = 255;
                    } else {
                        *b -= 1;
                        break;
                    }
                }
                restore = true;
            } else if iv_byte > self.decrypt_iv[0] && diff > 0 {
                // Forward skip: some packets were lost
                lost = (iv_byte as i32) - (self.decrypt_iv[0] as i32) - 1;
                self.decrypt_iv[0] = iv_byte;
            } else if iv_byte < self.decrypt_iv[0] && diff > 0 {
                // Forward skip with wraparound
                lost = 256 - (self.decrypt_iv[0] as i32) + (iv_byte as i32) - 1;
                self.decrypt_iv[0] = iv_byte;
                for b in self.decrypt_iv[1..].iter_mut() {
                    *b = b.wrapping_add(1);
                    if *b != 0 {
                        break;
                    }
                }
            } else {
                return false;
            }

            // Replay check: compare IV[0..=1] against history.
            //
            // `decrypt_history` maps IV[0] → last-seen IV[1] for that bucket.  This
            // matches the original Mumble/Murmur OCB2 reference implementation and
            // is intentional: out-of-window packets that share the same IV[0] but
            // differ in IV[1..] would theoretically bypass this check.  In practice,
            // the 256-bucket window size means that two colliding packets would need
            // to arrive more than 256 sequence numbers apart — well beyond any
            // real-network jitter window.  Matching Mumble's behaviour here ensures
            // interoperability with all standard Mumble clients.
            if self.decrypt_history[self.decrypt_iv[0] as usize] == self.decrypt_iv[1] {
                self.decrypt_iv = save_iv;
                return false;
            }
        }

        // Attempt OCB2 decryption
        let dst_start = dst.len();
        dst.resize(dst_start + plain_len, 0);
        let mut tag = [0u8; 16];
        let ok = ocb_decrypt(
            &self.cipher,
            &self.decrypt_iv,
            &source[4..],
            &mut dst[dst_start..],
            &mut tag,
        );

        if !ok
            || tag[0] != expected_tag[0]
            || tag[1] != expected_tag[1]
            || tag[2] != expected_tag[2]
        {
            // Decryption failed: truncate dst and restore IV
            dst.truncate(dst_start);
            self.decrypt_iv = save_iv;
            return false;
        }

        // Success: record in history, optionally restore IV (for late packets)
        self.decrypt_history[self.decrypt_iv[0] as usize] = self.decrypt_iv[1];

        if restore {
            self.decrypt_iv = save_iv;
        }

        // Update stats
        self.last_good = Instant::now();
        self.good += 1;
        if late > 0 {
            self.late = self.late.saturating_add(late as u32);
        } else if late < 0 && self.late > 0 {
            self.late -= 1;
        }
        if lost > 0 {
            self.lost = self.lost.saturating_add(lost as u32);
        } else if lost < 0 && self.lost > 0 {
            self.lost -= 1;
        }

        true
    }
}

// ─── OCB2 Core ───────────────────────────────────────────────────────────────

/// OCB2 encrypt: `plain` → `cipher` (same length) + 16-byte `tag`.
///
/// Returns false if a potential XEX* attack pattern was detected and mitigated
/// (the plaintext was slightly modified to prevent the attack).
fn ocb_encrypt(
    aes: &Aes128,
    nonce: &[u8; 16],
    plain: &[u8],
    cipher: &mut [u8],
    tag: &mut [u8; 16],
) -> bool {
    debug_assert_eq!(cipher.len(), plain.len());

    let mut checksum = [0u8; 16];
    let mut delta = [0u8; 16];
    let mut tmp = [0u8; 16];

    // delta = AES_K(nonce)
    aes_encrypt(aes, nonce, &mut delta);

    let mut offset = 0usize;

    while plain.len() - offset > 16 {
        // XEX* attack mitigation: second-to-last full block check
        // If the first 15 bytes of this block are all zero, digital silence
        // could enable an attack — flip one bit to prevent it.
        let mut flip_bit = false;
        if plain.len() - offset - 16 <= 16 {
            let sum = plain[offset..offset + 15]
                .iter()
                .fold(0u8, |acc, &x| acc | x);
            if sum == 0 {
                flip_bit = true;
                // Note: success remains true (we mitigate rather than fail)
            }
        }

        s2(&mut delta);

        // tmp = delta XOR plain_block
        let mut plain_block: [u8; 16] = plain[offset..offset + 16].try_into().unwrap();
        xor16(&mut tmp, &plain_block, &delta);
        if flip_bit {
            tmp[0] ^= 1;
            plain_block[0] ^= 1; // pre-apply flip so checksum uses the modified value
        }

        // tmp = AES_K(tmp) in-place — no .clone() needed
        aes_encrypt_inplace(aes, &mut tmp);

        // tmp = delta XOR AES(tmp) — now tmp holds the ciphertext block
        xor16_inplace(&mut tmp, &delta);
        cipher[offset..offset + 16].copy_from_slice(&tmp);

        // checksum ^= (possibly flipped) plain_block
        xor16_inplace(&mut checksum, &plain_block);

        offset += 16;
    }

    // Handle last (possibly partial) block
    let remaining = plain.len() - offset;
    s2(&mut delta);

    // pad = AES_K(delta XOR [0..0 || (remaining*8)])
    // Avoid allocating a zero-block: copy delta, XOR the single length byte, encrypt in-place.
    let mut pad = delta;
    pad[15] ^= (remaining * 8) as u8;
    aes_encrypt_inplace(aes, &mut pad);

    // blk = plain[offset..] || pad[remaining..]  (16 bytes total)
    let mut blk = [0u8; 16];
    blk[..remaining].copy_from_slice(&plain[offset..]);
    blk[remaining..].copy_from_slice(&pad[remaining..]);

    xor16_inplace(&mut checksum, &blk);

    // encrypted = pad XOR blk  (only first `remaining` bytes output)
    xor16_inplace(&mut blk, &pad);
    cipher[offset..offset + remaining].copy_from_slice(&blk[..remaining]);

    // Tag = AES_K(S3(delta) XOR checksum)
    s3(&mut delta);
    xor16_inplace(&mut delta, &checksum);
    // delta and tag are distinct variables — no .clone() needed
    aes_encrypt(aes, &delta, tag);

    true
}

/// OCB2 decrypt: `cipher` → `plain` (same length) + 16-byte `tag`.
///
/// The caller compares `tag[0..3]` against the packet's expected tag.
/// Returns false if a XEX* attack pattern is detected in the decrypted output.
fn ocb_decrypt(
    aes: &Aes128,
    nonce: &[u8; 16],
    cipher: &[u8],
    plain: &mut [u8],
    tag: &mut [u8; 16],
) -> bool {
    debug_assert_eq!(cipher.len(), plain.len());

    let mut checksum = [0u8; 16];
    let mut delta = [0u8; 16];
    let mut tmp = [0u8; 16];
    let mut success = true;

    // delta = AES_K(nonce)  (AES encrypt, same as in ocb_encrypt)
    aes_encrypt(aes, nonce, &mut delta);

    let mut offset = 0usize;
    let len = cipher.len();

    while len - offset > 16 {
        s2(&mut delta);

        // tmp = delta XOR cipher_block
        let cipher_block: [u8; 16] = cipher[offset..offset + 16].try_into().unwrap();
        xor16(&mut tmp, &cipher_block, &delta);

        // tmp = AES_K_inv(tmp) in-place — no .clone() needed
        aes_decrypt_inplace(aes, &mut tmp);

        // tmp = delta XOR tmp — now tmp holds the plaintext block
        xor16_inplace(&mut tmp, &delta);
        plain[offset..offset + 16].copy_from_slice(&tmp);
        xor16_inplace(&mut checksum, &tmp);

        offset += 16;
    }

    // Handle last (possibly partial) block
    let remaining = len - offset;
    s2(&mut delta);

    // pad = AES_K(delta XOR [0..0 || (remaining*8)])
    let mut pad = delta;
    pad[15] ^= (remaining * 8) as u8;
    aes_encrypt_inplace(aes, &mut pad);

    // tmp = cipher[offset..] XOR pad  (partial block decryption)
    let mut tmp2 = [0u8; 16];
    tmp2[..remaining].copy_from_slice(&cipher[offset..]);
    xor16_inplace(&mut tmp2, &pad);
    xor16_inplace(&mut checksum, &tmp2);
    plain[offset..offset + remaining].copy_from_slice(&tmp2[..remaining]);

    // Counter-cryptanalysis check (section 9 of https://eprint.iacr.org/2019/311):
    // If the decrypted last block matches delta[0..15], the ciphertext is suspicious.
    if tmp2[..15] == delta[..15] {
        success = false;
    }

    // Tag = AES_K(S3(delta) XOR checksum)
    s3(&mut delta);
    xor16_inplace(&mut delta, &checksum);
    aes_encrypt(aes, &delta, tag);

    success
}

// ─── Block cipher primitives ─────────────────────────────────────────────────

/// AES-128 encrypt: `input` → `output`.  Uses direct slice copy into output
/// to avoid a separate GenericArray stack allocation.
#[inline]
fn aes_encrypt(aes: &Aes128, input: &[u8; 16], output: &mut [u8; 16]) {
    *output = *input;
    aes_encrypt_inplace(aes, output);
}

/// AES-128 encrypt in-place.  Saves one 16-byte copy at every call site where
/// the input and output are the same buffer.
#[inline]
fn aes_encrypt_inplace(aes: &Aes128, block: &mut [u8; 16]) {
    use aes::cipher::generic_array::GenericArray;
    let ga = GenericArray::from_mut_slice(block);
    aes.encrypt_block(ga);
}

/// AES-128 decrypt in-place.
#[inline]
fn aes_decrypt_inplace(aes: &Aes128, block: &mut [u8; 16]) {
    use aes::cipher::generic_array::GenericArray;
    let ga = GenericArray::from_mut_slice(block);
    aes.decrypt_block(ga);
}

// ─── GF(2^128) field operations ──────────────────────────────────────────────

/// S2: multiply by x in GF(2^128) with reduction polynomial x^128+x^7+x^2+x+1.
///
/// Treats the block as a 128-bit big-endian integer: left-shift by 1, then
/// conditionally XOR 0x87 based on the original MSB.
/// Uses a single u128 operation instead of a 16-byte loop.
#[inline]
fn s2(block: &mut [u8; 16]) {
    let v = u128::from_be_bytes(*block);
    let carry = (v >> 127) as u8;
    *block = (v << 1).to_be_bytes();
    block[15] ^= carry * 0x87;
}

/// S3 = S2(x) XOR x in GF(2^128).  Computed entirely in u128 domain.
#[inline]
fn s3(block: &mut [u8; 16]) {
    let v = u128::from_be_bytes(*block);
    let carry = v >> 127; // 0 or 1
    let shifted = (v << 1) ^ (carry * 0x87);
    *block = (shifted ^ v).to_be_bytes();
}

// ─── 16-byte XOR helpers ─────────────────────────────────────────────────────

/// XOR two 16-byte blocks: `dst = a XOR b`.
/// Uses a single u128 XOR instead of a 16-byte loop.
#[inline]
fn xor16(dst: &mut [u8; 16], a: &[u8; 16], b: &[u8; 16]) {
    let av = u128::from_ne_bytes(*a);
    let bv = u128::from_ne_bytes(*b);
    *dst = (av ^ bv).to_ne_bytes();
}

/// XOR in-place: `dst ^= src`.
#[inline]
fn xor16_inplace(dst: &mut [u8; 16], src: &[u8; 16]) {
    let dv = u128::from_ne_bytes(*dst);
    let sv = u128::from_ne_bytes(*src);
    *dst = (dv ^ sv).to_ne_bytes();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Test vectors derived from known-good OCB2-AES128 implementation.
    #[test]
    fn test_s2_zero() {
        let mut block = [0u8; 16];
        s2(&mut block);
        assert_eq!(block, [0u8; 16]);
    }

    #[test]
    fn test_s2_one_in_msb() {
        // Block = 0x80 00 00 ... 00
        // After S2: carry=1, shift left → 0x00 00 ... 00, then XOR 0x87 in last byte
        let mut block = [0u8; 16];
        block[0] = 0x80;
        s2(&mut block);
        let mut expected = [0u8; 16];
        expected[15] = 0x87;
        assert_eq!(block, expected);
    }

    #[test]
    fn test_s3_is_s2_xor_original() {
        let original = [0x12u8; 16];
        let mut a = original;
        s2(&mut a);
        xor16_inplace(&mut a, &original);

        let mut b = original;
        s3(&mut b);

        assert_eq!(a, b);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        // Simulate sender (server) and receiver (client) states.
        // The sender encrypts with encrypt_iv; the receiver must be initialized
        // with decrypt_iv = sender's encrypt_iv (before increment), so that when
        // the receiver sees the first nonce byte it correctly advances its IV.
        let mut sender = CryptState::new();
        sender.generate_key().unwrap();

        let key = *sender.get_key();
        let enc_iv_before = sender.encrypt_iv; // Sender's encrypt_iv BEFORE first encrypt
        let dec_iv = sender.decrypt_iv;

        let plaintext = b"Hello, Mumble voice packet! 1234";
        let mut encrypted = Vec::new();
        let ok = sender.encrypt(plaintext, &mut encrypted);
        assert!(ok);
        assert_eq!(encrypted.len(), plaintext.len() + 4);

        // Receiver: decrypt_iv = enc_iv_before (sender's pre-encrypt nonce)
        // encrypt_iv = dec_iv (not used for decryption in this test)
        let mut receiver = CryptState::new();
        receiver.set_key(&key, &dec_iv, &enc_iv_before);

        let mut decrypted = Vec::new();
        let ok = receiver.decrypt(&encrypted, &mut decrypted);
        assert!(ok, "Decryption should succeed");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_rejects_tampered_packet() {
        let mut state = CryptState::new();
        state.generate_key().unwrap();

        let plaintext = b"Test voice data";
        let mut encrypted = Vec::new();
        state.encrypt(plaintext, &mut encrypted);

        // Tamper with the ciphertext
        encrypted[5] ^= 0xFF;

        // Reset IV so decrypt can attempt
        let enc_iv = state.encrypt_iv;
        state.decrypt_iv = [0u8; 16];
        state.encrypt_iv = [0u8; 16];

        let mut state2 = CryptState::new();
        state2.set_key(state.get_key(), &state.encrypt_iv, &enc_iv);

        let mut decrypted = Vec::new();
        let ok = state2.decrypt(&encrypted, &mut decrypted);
        assert!(!ok, "Should reject tampered ciphertext");
        assert!(decrypted.is_empty(), "Output should be empty on failure");
    }

    #[test]
    fn test_good_stat_incremented() {
        let mut state = CryptState::new();
        state.generate_key().unwrap();

        // Clone key/IVs for a receiver
        let key = *state.get_key();
        let enc_iv = state.encrypt_iv;
        let dec_iv = state.decrypt_iv;

        let plaintext = b"stats test";
        let mut encrypted = Vec::new();
        state.encrypt(plaintext, &mut encrypted);

        // Create matching decrypt state
        let mut recv = CryptState::new();
        recv.set_key(&key, &dec_iv, &enc_iv);

        let mut out = Vec::new();
        assert!(recv.decrypt(&encrypted, &mut out));
        assert_eq!(recv.good, 1);
    }

    #[test]
    fn test_partial_block_roundtrip() {
        let mut state = CryptState::new();
        state.generate_key().unwrap();

        let key = *state.get_key();
        let enc_iv = state.encrypt_iv;
        let dec_iv = state.decrypt_iv;

        // 5-byte plaintext (partial block)
        let plaintext = b"Hello";
        let mut encrypted = Vec::new();
        state.encrypt(plaintext, &mut encrypted);
        assert_eq!(encrypted.len(), 5 + 4);

        let mut recv = CryptState::new();
        recv.set_key(&key, &dec_iv, &enc_iv);

        let mut decrypted = Vec::new();
        assert!(recv.decrypt(&encrypted, &mut decrypted));
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_replay_rejection() {
        let mut state = CryptState::new();
        state.generate_key().unwrap();

        let key = *state.get_key();
        let enc_iv = state.encrypt_iv;
        let dec_iv = state.decrypt_iv;

        let plaintext = b"replay test";
        let mut encrypted = Vec::new();
        state.encrypt(plaintext, &mut encrypted);

        let mut recv = CryptState::new();
        recv.set_key(&key, &dec_iv, &enc_iv);

        let mut out1 = Vec::new();
        assert!(recv.decrypt(&encrypted, &mut out1));

        // Replay the exact same ciphertext — should be rejected because the IV[0]
        // value is already in decrypt_history.
        let mut out2 = Vec::new();
        assert!(
            !recv.decrypt(&encrypted, &mut out2),
            "Replayed packet should be rejected"
        );
        assert!(
            out2.is_empty(),
            "Output should be empty on replay rejection"
        );
    }

    /// Verify that the IV counter wraps from 0xFF back to 0x00 correctly and
    /// that packets across the 0xFF→0x00 boundary can be decrypted.
    #[test]
    fn test_encrypt_decrypt_at_iv_wraparound() {
        let mut sender = CryptState::new();
        // Set encrypt_iv so that IV[0] will wrap after one more increment.
        let mut key = [0u8; 16];
        let mut enc_iv = [0u8; 16];
        let dec_iv = [0u8; 16];
        // Fill key with non-zero bytes for a meaningful cipher
        for (i, b) in key.iter_mut().enumerate() {
            *b = (i as u8).wrapping_add(1);
        }
        enc_iv[0] = 0xFF; // IV[0] is about to wrap
        sender.set_key(&key, &enc_iv, &dec_iv);

        // Encrypt at IV[0] = 0xFF
        let plaintext = b"wraparound test payload";
        let mut encrypted_ff = Vec::new();
        assert!(sender.encrypt(plaintext, &mut encrypted_ff));
        // After encrypt, IV[0] should be 0x00 (wrapped around)
        assert_eq!(
            sender.encrypt_iv[0], 0x00,
            "IV[0] should wrap to 0x00 after 0xFF"
        );

        // Encrypt again at IV[0] = 0x00
        let mut encrypted_00 = Vec::new();
        assert!(sender.encrypt(plaintext, &mut encrypted_00));
        assert_eq!(sender.encrypt_iv[0], 0x01, "IV[0] should advance to 0x01");

        // Receiver starts with decrypt_iv = sender's initial enc_iv (IV[0]=0xFF)
        let mut receiver = CryptState::new();
        receiver.set_key(&key, &dec_iv, &enc_iv); // decrypt_iv = enc_iv (0xFF start)

        // Decrypt first packet (sender sent at 0xFF)
        let mut out1 = Vec::new();
        assert!(
            receiver.decrypt(&encrypted_ff, &mut out1),
            "Should decrypt packet with IV[0]=0xFF"
        );
        assert_eq!(out1, plaintext);

        // Decrypt second packet (sender sent at 0x00, i.e. post-wraparound)
        let mut out2 = Vec::new();
        assert!(
            receiver.decrypt(&encrypted_00, &mut out2),
            "Should decrypt packet with IV[0]=0x00 (post-wrap)"
        );
        assert_eq!(out2, plaintext);
    }

    #[test]
    fn test_resync_requests_are_throttled() {
        let mut crypt = CryptState::new();
        let base = Instant::now();

        crypt.last_good = base.checked_sub(Duration::from_secs(6)).unwrap_or(base);
        crypt.last_request = base.checked_sub(Duration::from_secs(6)).unwrap_or(base);
        assert!(crypt.should_request_resync_at(base));

        assert!(!crypt.should_request_resync_at(base + Duration::from_secs(1)));

        crypt.last_good = base + Duration::from_secs(8);
        crypt.last_request = base.checked_sub(Duration::from_secs(6)).unwrap_or(base);
        assert!(!crypt.should_request_resync_at(base + Duration::from_secs(12)));

        crypt.last_good = base.checked_sub(Duration::from_secs(6)).unwrap_or(base);
        crypt.last_request = base.checked_sub(Duration::from_secs(6)).unwrap_or(base);
        assert!(crypt.should_request_resync_at(base + Duration::from_secs(12)));
    }
}
