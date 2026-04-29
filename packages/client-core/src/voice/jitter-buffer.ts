/**
 * Per-speaker jitter buffer for inbound voice frames.
 *
 * Each `JitterBuffer` instance corresponds to a single talker (sessionId).
 * Frames are pushed in arrival order with their original Mumble sequence
 * number. The host is expected to call `pop()` on a steady tick (typically
 * every 10ms aligned with the codec frame size) to retrieve the next frame
 * to play.
 *
 * Behavior (modeled after C++ Mumble's Speex JitterBuffer):
 * - A short head margin (`marginFrames`) is held back so out-of-order frames
 *   can still slot into the playback timeline.
 * - Frames whose sequence is older than the next-expected sequence are
 *   dropped and counted as `late`.
 * - When the buffer is empty at pop-time, a `lost` event is recorded and
 *   `null` is returned so the host can choose to invoke Opus PLC.
 * - On a long gap (`maxGap` frames), the buffer resyncs and counts +1
 *   `resync`.
 *
 * Pure-data, no timers — host drives playback cadence.
 */

import type { VoiceFrame } from '../types.js';

export interface JitterStats {
  good: number;
  late: number;
  lost: number;
  resync: number;
}

export interface JitterBufferOptions {
  /** Minimum number of frames to hold before popping. Default: 4 (~80ms at 20ms frames). */
  marginFrames?: number;
  /** Drop the buffer and resync when the head jumps by more than this. Default: 50. */
  maxGap?: number;
  /** Hard cap on stored frames (memory safety). Default: 50. */
  maxStored?: number;
}

export class JitterBuffer {
  readonly sessionId: number;
  private readonly marginFrames: number;
  private readonly maxGap: number;
  private readonly maxStored: number;

  private store: Map<number, VoiceFrame> = new Map();
  private nextSeq: number = -1;
  private terminated: boolean = false;
  private warmingUp: boolean = true;

  readonly stats: JitterStats = { good: 0, late: 0, lost: 0, resync: 0 };

  constructor(sessionId: number, opts: JitterBufferOptions = {}) {
    this.sessionId = sessionId;
    this.marginFrames = opts.marginFrames ?? 4;
    this.maxGap = opts.maxGap ?? 50;
    this.maxStored = opts.maxStored ?? 50;
  }

  /**
   * Insert a frame. Returns `true` if the frame was accepted, `false` if it
   * was dropped (late or buffer full).
   */
  push(frame: VoiceFrame): boolean {
    if (this.terminated) {
      // Treat any new frame after a terminator as a fresh talk burst.
      this.terminated = false;
      this.warmingUp = true;
      this.nextSeq = -1;
      this.store.clear();
    }

    if (this.nextSeq >= 0 && frame.sequence < this.nextSeq) {
      this.stats.late++;
      return false;
    }

    if (this.nextSeq >= 0 && frame.sequence - this.nextSeq > this.maxGap) {
      // Resync — speaker likely had a long silence
      this.store.clear();
      this.nextSeq = frame.sequence;
      this.stats.resync++;
    }

    if (this.store.size >= this.maxStored) {
      // Drop oldest to make room
      const oldest = Math.min(...this.store.keys());
      this.store.delete(oldest);
      this.stats.lost++;
    }

    this.store.set(frame.sequence, frame);
    if (this.nextSeq < 0) this.nextSeq = frame.sequence;
    return true;
  }

  /**
   * Pop the next frame. Returns `null` when no frame is ready (host should
   * either play silence or invoke Opus PLC).
   */
  pop(): VoiceFrame | null {
    if (this.warmingUp) {
      if (this.store.size < this.marginFrames) return null;
      this.warmingUp = false;
    }

    if (this.nextSeq < 0) return null;

    const frame = this.store.get(this.nextSeq);
    if (frame) {
      this.store.delete(this.nextSeq);
      this.nextSeq++;
      this.stats.good++;
      if (frame.terminator) {
        this.terminated = true;
      }
      return frame;
    }

    // Hole in the stream
    this.nextSeq++;
    this.stats.lost++;
    return null;
  }

  /** True if no frames remain and the talker has marked end-of-talk. */
  isExhausted(): boolean {
    return this.store.size === 0 && this.terminated;
  }

  size(): number {
    return this.store.size;
  }

  /** Reset all counters (call after publishing them in a `Ping` message). */
  consumeStats(): JitterStats {
    const out: JitterStats = { ...this.stats };
    this.stats.good = 0;
    this.stats.late = 0;
    this.stats.lost = 0;
    this.stats.resync = 0;
    return out;
  }
}

/**
 * Multiplexer of per-talker jitter buffers.
 */
export class JitterBufferPool {
  private buffers: Map<number, JitterBuffer> = new Map();
  private readonly opts: JitterBufferOptions;

  constructor(opts: JitterBufferOptions = {}) {
    this.opts = opts;
  }

  push(frame: VoiceFrame): void {
    let buf = this.buffers.get(frame.session);
    if (!buf) {
      buf = new JitterBuffer(frame.session, this.opts);
      this.buffers.set(frame.session, buf);
    }
    buf.push(frame);
  }

  pop(sessionId: number): VoiceFrame | null {
    const buf = this.buffers.get(sessionId);
    if (!buf) return null;
    const f = buf.pop();
    if (buf.isExhausted()) this.buffers.delete(sessionId);
    return f;
  }

  remove(sessionId: number): void {
    this.buffers.delete(sessionId);
  }

  reset(): void {
    this.buffers.clear();
  }

  /** Consume and aggregate stats from all per-talker buffers. */
  consumeStats(): JitterStats {
    const total: JitterStats = { good: 0, late: 0, lost: 0, resync: 0 };
    for (const buf of this.buffers.values()) {
      const s = buf.consumeStats();
      total.good += s.good;
      total.late += s.late;
      total.lost += s.lost;
      total.resync += s.resync;
    }
    return total;
  }

  activeSessions(): number[] {
    return Array.from(this.buffers.keys());
  }
}
