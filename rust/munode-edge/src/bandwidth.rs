/// Per-user voice bandwidth recorder with a rolling ring buffer.
///
/// Tracks voice frame sizes over a configurable time window, matching the
/// `BandwidthRecord` semantics from Murmur (360-slot ring buffer).
///
/// Each slot covers one second of bandwidth data. The ring index advances as
/// wall-clock time progresses. Old slots are zeroed when overwritten.
///
/// The `max_per_sec` enforcement drops frames that would exceed the configured
/// maximum bytes-per-second for the current slot.
use std::time::Instant;

/// Default number of ring-buffer slots (seconds) to track.
/// Matches Murmur's BandwidthRecord default of 360 slots.
pub const DEFAULT_WINDOW_SLOTS: usize = 360;

/// Maximum allowed window size in seconds to prevent excessive memory allocation.
/// A 1-hour window is more than sufficient for any practical use case.
pub const MAX_WINDOW_SLOTS: usize = 3600;

/// Normalize a requested window size to the effective number of slots that
/// `BandwidthRecord::new` would allocate.
///
/// * `0`  → `DEFAULT_WINDOW_SLOTS` (360)
/// * `> MAX_WINDOW_SLOTS` → `MAX_WINDOW_SLOTS` (3600)
/// * otherwise → `window_secs` unchanged
pub fn effective_window(window_secs: usize) -> usize {
    if window_secs == 0 {
        DEFAULT_WINDOW_SLOTS
    } else {
        window_secs.min(MAX_WINDOW_SLOTS)
    }
}

/// Per-user voice bandwidth ring-buffer recorder.
///
/// Call `add_frame(size, max_bytes_per_sec)` on each received voice packet.
/// Returns `true` if the packet is within the bandwidth budget and should be
/// forwarded, or `false` if it should be dropped.
pub struct BandwidthRecord {
    /// Byte totals per slot (one slot = one second).
    slots: Vec<u32>,
    /// When the recorder was created (epoch for slot-index calculation).
    epoch: Instant,
    /// Number of slots (window length in seconds).
    window_secs: usize,
    /// The absolute slot number of the last slot that was written.
    /// Used to detect whether we need to zero stale slots on the next call.
    last_slot_abs: Option<usize>,
}

impl BandwidthRecord {
    /// Create a new recorder with the given window length in seconds.
    ///
    /// * `window_secs = 0` uses the `DEFAULT_WINDOW_SLOTS` (360 seconds).
    /// * Values above `MAX_WINDOW_SLOTS` (3600) are clamped to the maximum.
    pub fn new(window_secs: usize) -> Self {
        let slots = effective_window(window_secs);
        Self {
            slots: vec![0u32; slots],
            epoch: Instant::now(),
            window_secs: slots,
            last_slot_abs: None,
        }
    }

    /// Record a voice frame of `bytes` bytes.
    ///
    /// * `max_bytes_per_sec` – per-second bandwidth cap.  Pass `0` to disable
    ///   the cap (frame is always accepted).
    ///
    /// Returns `true` if the frame is within budget and should be forwarded;
    /// `false` if it exceeds `max_bytes_per_sec` and should be dropped.
    pub fn add_frame(&mut self, bytes: u32, max_bytes_per_sec: u32) -> bool {
        let slot = self.advance_to_current_slot();
        if max_bytes_per_sec > 0 {
            let new_total = (self.slots[slot] as u64) + (bytes as u64);
            if new_total > max_bytes_per_sec as u64 {
                return false;
            }
        }
        self.slots[slot] = self.slots[slot].saturating_add(bytes);
        true
    }

    /// Return the window size (number of slots) this record was created with.
    pub fn window_secs(&self) -> usize {
        self.window_secs
    }

    /// Return the total bytes recorded across the entire window.
    pub fn total_bytes(&self) -> u64 {
        self.slots.iter().map(|&b| b as u64).sum()
    }

    /// Return the bytes recorded in the most-recent completed slot (i.e., the
    /// previous second), which gives an instantaneous bandwidth snapshot.
    ///
    /// Returns `0` if no frames have been recorded yet, or if no frames have
    /// arrived within the last two seconds (stale / idle session).
    pub fn bytes_last_second(&self) -> u32 {
        let now_abs = self.elapsed_slots();
        if now_abs == 0 {
            return 0;
        }
        // The previous-second slot is only valid when a frame was recorded
        // recently enough that it has not yet been overwritten by stale-slot
        // clearing.  If `last_slot_abs < now_abs - 1` the slot value belongs
        // to a past ring-buffer cycle and would be stale.
        match self.last_slot_abs {
            None => 0,
            Some(last_abs) if now_abs.saturating_sub(last_abs) >= 2 => 0,
            _ => {
                let prev_idx = (now_abs - 1) % self.window_secs;
                self.slots[prev_idx]
            }
        }
    }

    /// Return the average bytes-per-second across all filled slots.
    pub fn avg_bytes_per_sec(&self) -> f32 {
        let filled = self.elapsed_slots().min(self.window_secs);
        if filled == 0 {
            return 0.0;
        }
        self.total_bytes() as f32 / filled as f32
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    /// How many whole seconds have elapsed since the epoch.
    fn elapsed_slots(&self) -> usize {
        self.epoch.elapsed().as_secs() as usize
    }

    /// Return the ring-buffer index for the current second, zeroing any
    /// slots that have grown stale since the last `add_frame` call.
    fn advance_to_current_slot(&mut self) -> usize {
        let now_abs = self.elapsed_slots();
        let cur_idx = now_abs % self.window_secs;

        match self.last_slot_abs {
            None => {
                // First call: zero the current slot and start tracking.
                self.slots[cur_idx] = 0;
            }
            Some(prev_abs) if now_abs == prev_abs => {
                // Same second: no clearing needed, just return the current index.
            }
            Some(prev_abs) => {
                // Advance: zero the stale slots between prev and now.
                let gap = now_abs.saturating_sub(prev_abs);
                if gap >= self.window_secs {
                    // All slots are stale; clear the entire buffer.
                    self.slots.iter_mut().for_each(|s| *s = 0);
                } else {
                    // Zero each stale slot in turn (wrapping around the ring).
                    for offset in 1..=gap {
                        let idx = (prev_abs + offset) % self.window_secs;
                        self.slots[idx] = 0;
                    }
                }
            }
        }

        self.last_slot_abs = Some(now_abs);
        cur_idx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_frame_no_cap() {
        let mut bw = BandwidthRecord::new(60);
        assert!(bw.add_frame(1000, 0), "unlimited cap should always accept");
        assert!(bw.add_frame(1000, 0));
        assert!(bw.total_bytes() >= 2000);
    }

    #[test]
    fn test_add_frame_with_cap() {
        let mut bw = BandwidthRecord::new(60);
        // Fill up to the cap
        assert!(bw.add_frame(8000, 8000));
        // Next frame should be rejected
        assert!(!bw.add_frame(1, 8000));
    }

    #[test]
    fn test_add_frame_within_cap() {
        let mut bw = BandwidthRecord::new(60);
        assert!(bw.add_frame(4000, 8000));
        assert!(bw.add_frame(3000, 8000));
        // 7000 < 8000 cap, so this still fits
        assert!(bw.add_frame(999, 8000));
    }

    #[test]
    fn test_multiple_frames_same_slot() {
        let mut bw = BandwidthRecord::new(60);
        // All frames land in the same second — sum should accumulate.
        for _ in 0..5 {
            assert!(bw.add_frame(100, 0));
        }
        assert_eq!(bw.total_bytes(), 500);
    }
}
