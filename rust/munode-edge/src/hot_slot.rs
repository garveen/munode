//! HotSlot: cache-line-aligned per-session hot data for the voice routing hot path.
//!
//! Session IDs on a single Edge process follow the pattern
//! `edge_id × 10_000 + local_seq`, so every session on this Edge has a unique value
//! for `session_id % HOT_SLOT_COUNT`.  That means there are **no hash collisions** in
//! normal operation; the `session_id` field exists only as a defensive correctness
//! check.
//!
//! Layout strategy
//! ---------------
//! * `active` and `session_id` are always written/read with `Acquire`/`Release`
//!   ordering so that observers who see `active == true` are guaranteed to also see
//!   all other field writes from the registering thread.
//! * All other field updates (channel move, deaf toggle, crypt install) happen via
//!   `Relaxed` stores because the consuming voice-routing task always checks `active`
//!   first (Acquire), establishing the necessary happens-before edge.
//! * `active` is set **last** when registering (Release) and cleared **first** when
//!   clearing (Release), so readers see either a fully-populated slot or an empty one.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};
use arc_swap::ArcSwap;
use tokio::sync::mpsc;

use crate::crypto::CryptState;

/// Number of HotSlot entries in the global static array.
///
/// Must be ≥ the maximum number of concurrent sessions per Edge process.
/// With the current allocation scheme (`edge_id × 10_000`), each Edge owns
/// at most 10 000 session IDs, so `session_id % 10_000` is always unique within
/// a single Edge process.
pub const HOT_SLOT_COUNT: usize = 10_000;

/// Lean voice-target entry for the routing hot path.
///
/// Contains only the fields needed for per-packet routing decisions.  The full
/// `VoiceTargetConfig` (including the original `channels` spec) remains in
/// `EdgeState::voice_targets` for channel-tree recomputation; this struct is a
/// projection of it stored lock-free in each session's `HotSlot`.
#[derive(Clone)]
pub struct HotVoiceTarget {
    /// Direct target session IDs (VoiceTarget session entries).
    pub sessions: Vec<u32>,
    /// Pre-expanded channel set: `channel_id → optional group filter`.
    /// Built once when the VoiceTarget is registered or when the channel tree
    /// changes (via `recompute_all_vt_channels`).
    pub resolved_channels: HashMap<u32, Option<Vec<String>>>,
}

/// Per-session voice-target map stored in a `HotSlot`.
/// Maps `target_id` (1..=30) → `HotVoiceTarget`.
pub type HotVoiceTargetMap = HashMap<u32, HotVoiceTarget>;

/// Cache-line-aligned (64-byte) per-session hot data used by the voice routing
/// hot path.
///
/// The struct is stored in a global static array indexed by
/// `session_id % HOT_SLOT_COUNT`.  Every field is either an atomic primitive or
/// an `ArcSwap`, enabling reads with **zero lock acquisitions**.
#[repr(C, align(64))]
pub struct HotSlot {
    /// Whether this slot is currently occupied by an active session.
    /// Set **last** (Release) on `register`, cleared **first** (Release) on `clear`.
    pub active:     AtomicBool,
    /// Session ID occupying this slot.  Used to detect stale data caused by bugs.
    pub session_id: AtomicU32,
    /// Server-side deaf flag.
    pub deaf:       AtomicBool,
    /// Self-deaf flag (set by the client).
    pub self_deaf:  AtomicBool,
    /// Suppress flag: the server has suppressed this user in their current channel.
    pub suppress:   AtomicBool,
    /// Current channel ID.
    pub channel_id: AtomicU32,
    /// OCB2-AES128 crypto state for UDP voice delivery.  `None` until CryptSetup.
    pub crypt_state: ArcSwap<Option<Arc<Mutex<CryptState>>>>,
    /// TCP sender for delivering frames to this client (UDPTunnel and control).
    pub sender:     ArcSwap<Option<mpsc::Sender<Vec<u8>>>>,
    /// Per-session VoiceTarget map for lock-free whisper routing.
    /// `None` until the client registers any VoiceTarget.
    pub voice_targets: ArcSwap<Option<Arc<HotVoiceTargetMap>>>,
}

impl HotSlot {
    fn new() -> Self {
        HotSlot {
            active:        AtomicBool::new(false),
            session_id:    AtomicU32::new(0),
            deaf:          AtomicBool::new(false),
            self_deaf:     AtomicBool::new(false),
            suppress:      AtomicBool::new(false),
            channel_id:    AtomicU32::new(0),
            crypt_state:   ArcSwap::new(Arc::new(None)),
            sender:        ArcSwap::new(Arc::new(None)),
            voice_targets: ArcSwap::new(Arc::new(None)),
        }
    }

    /// Populate this slot for a newly-registered session.
    ///
    /// All fields except `active` are written with `Relaxed` ordering; `active`
    /// is written **last** with `Release` so that any reader that observes
    /// `active == true` (via `Acquire`) is guaranteed to see all other fields.
    pub fn register(
        &self,
        session_id: u32,
        channel_id: u32,
        deaf: bool,
        self_deaf: bool,
        suppress: bool,
        sender: mpsc::Sender<Vec<u8>>,
    ) {
        self.session_id.store(session_id, Ordering::Relaxed);
        self.channel_id.store(channel_id, Ordering::Relaxed);
        self.deaf.store(deaf, Ordering::Relaxed);
        self.self_deaf.store(self_deaf, Ordering::Relaxed);
        self.suppress.store(suppress, Ordering::Relaxed);
        self.crypt_state.store(Arc::new(None));
        self.sender.store(Arc::new(Some(sender)));
        self.voice_targets.store(Arc::new(None));
        // LAST: set active so readers never observe partial state.
        self.active.store(true, Ordering::Release);
    }

    /// Clear this slot on client disconnect.
    ///
    /// `active` is cleared **first** (Release) so concurrent readers immediately
    /// skip this slot without observing stale field values.
    pub fn clear(&self) {
        self.active.store(false, Ordering::Release);
        self.crypt_state.store(Arc::new(None));
        self.sender.store(Arc::new(None));
        self.voice_targets.store(Arc::new(None));
    }

    /// Returns `true` if this slot is active and belongs to `expected_session`.
    ///
    /// Uses `Acquire` on `active` to establish happens-before with the `register`
    /// call, then `Relaxed` on `session_id` (safe after the Acquire fence).
    #[inline]
    pub fn is_active_for(&self, expected_session: u32) -> bool {
        self.active.load(Ordering::Acquire)
            && self.session_id.load(Ordering::Relaxed) == expected_session
    }
}

// SAFETY: HotSlot only contains `Send + Sync` types:
//   - AtomicBool / AtomicU32: Send + Sync.
//   - ArcSwap<T> where T: Send + Sync: Send + Sync.
//   - Arc<Mutex<CryptState>>: Send + Sync (CryptState: Send).
//   - mpsc::Sender<Vec<u8>>: Send + Sync.
//   - HotVoiceTargetMap = HashMap<u32, HotVoiceTarget>: Send + Sync.
unsafe impl Send for HotSlot {}
unsafe impl Sync for HotSlot {}

// ArcSwap is not const-constructible, so we use OnceLock to lazily initialize
// the static array on first access.
static _HOT_SLOTS: std::sync::OnceLock<Box<[HotSlot]>> = std::sync::OnceLock::new();

/// Return a reference to the global HotSlot array, initializing it on first call.
pub fn hot_slots() -> &'static [HotSlot] {
    _HOT_SLOTS.get_or_init(|| {
        (0..HOT_SLOT_COUNT)
            .map(|_| HotSlot::new())
            .collect::<Vec<_>>()
            .into_boxed_slice()
    })
}

/// Return the HotSlot for a given session ID.
///
/// Index is `session_id % HOT_SLOT_COUNT`.  No collision possible within a
/// single Edge process by the session-ID allocation scheme.
#[inline]
pub fn get_hot_slot(session_id: u32) -> &'static HotSlot {
    let idx = (session_id as usize) % HOT_SLOT_COUNT;
    &hot_slots()[idx]
}

