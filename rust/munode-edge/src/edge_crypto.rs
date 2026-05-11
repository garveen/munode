use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Sliding-window replay guard for ChaCha20-Poly1305 Edge-to-Edge voice packets.
///
/// Window size is 64 positions (one `u64` bitmask).  `bit i` set ⟺ counter
/// `(max_seen − i)` has already been authenticated and delivered.
///
/// Voice traffic at 50 fps gives ~1.3 s of reordering tolerance; any packet
/// arriving more than 64 counter ticks behind the frontier is rejected as
/// either a replay or unrecoverably stale.
pub(crate) struct ReplayWindow {
    max_seen: u64,
    initialized: bool,
    /// `bit 0` = max_seen was seen; `bit 1` = max_seen-1 was seen; etc.
    seen_mask: u64,
}

impl ReplayWindow {
    pub(crate) fn new() -> Self {
        Self { max_seen: 0, initialized: false, seen_mask: 0 }
    }

    const WINDOW: u64 = 64;

    /// Fast pre-check (no AEAD cost): returns `false` if the counter is
    /// definitely outside the acceptance window, saving an AEAD operation.
    #[inline]
    pub(crate) fn pre_check(&self, counter: u64) -> bool {
        if !self.initialized { return true; }
        if counter > self.max_seen { return true; }
        (self.max_seen - counter) < Self::WINDOW
    }

    /// Attempt to mark `counter` as seen.  Must be called only after AEAD
    /// authentication succeeds.  Returns `false` if the counter was already
    /// marked (replay attack) or is outside the window.
    #[inline]
    pub(crate) fn mark_seen(&mut self, counter: u64) -> bool {
        if !self.initialized {
            self.max_seen = counter;
            self.seen_mask = 1;
            self.initialized = true;
            return true;
        }
        if counter > self.max_seen {
            let shift = counter - self.max_seen;
            if shift >= Self::WINDOW {
                // Entire old window expired — reset bitmask.
                self.seen_mask = 1;
            } else {
                self.seen_mask = (self.seen_mask << shift) | 1;
            }
            self.max_seen = counter;
            true
        } else {
            let behind = self.max_seen - counter;
            if behind >= Self::WINDOW {
                return false; // too old
            }
            let mask = 1u64 << behind;
            if self.seen_mask & mask != 0 {
                false // already seen — replay
            } else {
                self.seen_mask |= mask;
                true
            }
        }
    }
}

/// ChaCha20-Poly1305 shared-key encryption for Edge-to-Edge UDP voice traffic.
///
/// All Edges in a cluster derive the same key from `hmac_secret`, so ciphertext
/// produced by one Edge can be verified and decrypted by any other Edge.  A
/// monotonic counter combined with the sender's Edge ID forms the 12-byte nonce,
/// ensuring per-sender uniqueness across the cluster lifetime.
pub struct EdgeCrypto {
    key: ring::aead::LessSafeKey,
    counter: AtomicU64,
    /// Per-sender replay prevention windows.
    ///
    /// Layout is `RwLock<HashMap<sender_id, Arc<Mutex<ReplayWindow>>>>` so that:
    /// - The read lock is held only long enough to clone the `Arc` (hot path).
    /// - The write lock is needed only for the first packet from a new sender (rare).
    /// - The per-sender `Mutex` is then acquired independently without holding the map lock.
    replay_windows: std::sync::RwLock<std::collections::HashMap<u32, Arc<std::sync::Mutex<ReplayWindow>>>>,
}

impl EdgeCrypto {
    /// Derive an `EdgeCrypto` from the shared HMAC secret string.
    ///
    /// Returns `None` only if the underlying key construction fails (which
    /// should never occur for a valid 32-byte key from HMAC-SHA256).
    pub fn from_secret(secret: &str) -> Option<Self> {
        let key_material = ring::hmac::sign(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes()),
            b"munode-edge-udp-voice-key-v1",
        );
        // HMAC-SHA256 produces 32 bytes — exactly the ChaCha20-Poly1305 key size.
        let key_bytes = &key_material.as_ref()[..32];
        let unbound = ring::aead::UnboundKey::new(&ring::aead::CHACHA20_POLY1305, key_bytes).ok()?;
        Some(Self {
            key: ring::aead::LessSafeKey::new(unbound),
            counter: AtomicU64::new(0),
            replay_windows: std::sync::RwLock::new(std::collections::HashMap::new()),
        })
    }

    fn build_nonce(sender_edge_id: u32, counter: u64) -> ring::aead::Nonce {
        // 12-byte nonce: [sender_edge_id_BE(4)][counter_BE(8)]
        // Using all 12 bytes prevents nonce reuse even with a very high-frequency sender.
        let mut b = [0u8; 12];
        b[0..4].copy_from_slice(&sender_edge_id.to_be_bytes());
        b[4..12].copy_from_slice(&counter.to_be_bytes());
        ring::aead::Nonce::assume_unique_for_key(b)
    }

    /// Encrypt `plaintext` for the given sender Edge.
    ///
    /// Returns `(counter, ciphertext_with_poly1305_tag)`.  The caller embeds
    /// `counter` and `sender_edge_id` in the packet header so receivers can
    /// reconstruct the nonce.  Because all Edges share the same key, a
    /// ciphertext produced with empty `aad` can be sent to multiple peers
    /// without re-encryption (encrypt-once broadcast).
    ///
    /// Pass non-empty `aad` to bind the ciphertext to specific routing metadata
    /// (e.g. for relay packets, use `sender_edge_id ++ target_edge_id` as AAD to
    /// prevent an on-path attacker from redirecting the packet to a wrong destination).
    pub fn encrypt(&self, plaintext: &[u8], sender_edge_id: u32, aad: &[u8]) -> (u64, Vec<u8>) {
        self.encrypt_owned(plaintext.to_vec(), sender_edge_id, aad)
    }

    /// Same as `encrypt`, but consumes an owned buffer so callers that already
    /// built a `Vec<u8>` can avoid an extra pre-encryption copy.
    pub fn encrypt_owned(&self, mut plaintext: Vec<u8>, sender_edge_id: u32, aad: &[u8]) -> (u64, Vec<u8>) {
        let counter = self.counter.fetch_add(1, Ordering::Relaxed);
        let nonce = Self::build_nonce(sender_edge_id, counter);
        // Appends the 16-byte Poly1305 tag in-place.  Sealing can only fail on an
        // out-of-memory condition or a programming error — treat as unrecoverable.
        self.key
            .seal_in_place_append_tag(nonce, ring::aead::Aad::from(aad), &mut plaintext)
            .expect("EdgeCrypto::encrypt: AEAD sealing failed");
        (counter, plaintext)
    }

    /// Verify the Poly1305 tag, decrypt `ciphertext_with_tag`, and enforce
    /// replay prevention via a per-sender sliding counter window.
    ///
    /// `aad` must match what was passed to `encrypt` exactly (empty slice for
    /// direct-voice packets; `sender_edge_id ++ target_edge_id` for relay packets).
    ///
    /// Returns plaintext on success, or `None` if:
    /// - The AEAD tag is invalid (wrong key, tampered packet, AAD mismatch), OR
    /// - The counter has already been seen from this sender (replay), OR
    /// - The counter is outside the 64-position acceptance window (too old).
    ///
    /// Performance notes:
    /// - `pre_check` rejects obviously stale counters before the AEAD operation.
    /// - The read lock on `replay_windows` is held only for an Arc clone (~ns).
    /// - Per-sender Mutex is rarely contended because voice senders are sequential.
    pub fn decrypt(&self, sender_edge_id: u32, counter: u64, ciphertext: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        const TAG_LEN: usize = 16;
        if ciphertext.len() <= TAG_LEN {
            return None;
        }

        // ── Step 1: get (or create) the per-sender replay window ─────────────
        let window_arc: Arc<std::sync::Mutex<ReplayWindow>> = {
            // Fast path: sender already known — just clone the Arc under read lock.
            if let Ok(map) = self.replay_windows.read() {
                map.get(&sender_edge_id).cloned()
            } else {
                None
            }
        }
        .unwrap_or_else(|| {
            // Slow path (first packet from this sender): insert under write lock.
            let w = Arc::new(std::sync::Mutex::new(ReplayWindow::new()));
            if let Ok(mut map) = self.replay_windows.write() {
                map.entry(sender_edge_id).or_insert_with(|| w.clone()).clone()
            } else {
                // Poisoned map — skip replay check for this packet
                w
            }
        });

        // ── Step 2: cheap pre-check (no AEAD) ────────────────────────────────
        let pre_ok = window_arc.lock()
            .map(|w| w.pre_check(counter))
            .unwrap_or(true); // poisoned window → allow AEAD to decide
        if !pre_ok {
            return None; // obviously too old, skip expensive AEAD
        }

        // ── Step 3: AEAD authentication + decryption ─────────────────────────
        let nonce = Self::build_nonce(sender_edge_id, counter);
        let mut buf = ciphertext.to_vec();
        let plaintext_len = self.key
            .open_in_place(nonce, ring::aead::Aad::from(aad), &mut buf)
            .ok()?
            .len();
        buf.truncate(plaintext_len);

        // ── Step 4: confirm in replay window (mark as seen or detect duplicate) ─
        let accepted = window_arc.lock()
            .map(|mut w| w.mark_seen(counter))
            .unwrap_or(true); // poisoned window → accept (AEAD already succeeded)
        if !accepted {
            return None; // replay: counter was already used by this sender
        }

        Some(buf)
    }
}
