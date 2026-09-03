/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE COUNTDOWN MAY NEVER SHOW TIME THAT DOES NOT EXIST (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `serverClock` estimates the offset between this device's clock and the
 * engine's from a one-way sample:
 *
 *     sample = Date.now() - server_time_ms  =  trueOffset + oneWayLatency
 *
 * Every sample therefore OVERSTATES the offset by its own latency, and
 * `serverNow() = Date.now() - offset` runs that far BEHIND the engine — so
 * `deadline - serverNow()` hands the player MORE time than the engine will
 * honour. A player acting on the last instant the ring showed them could be
 * folded by a deadline that had already passed.
 *
 * The file's header used to claim the opposite ("the ring never claims time
 * the player does not have"). Smoothing cannot fix it: averaging one-way
 * samples bakes in the AVERAGE latency, and jitter makes that worse than the
 * best sample. The estimator takes the MINIMUM sample in a rolling window
 * instead — the smallest latency observed is the closest a one-way sample can
 * get to the true offset.
 *
 * These tests pin the DIRECTION and the CONVERGENCE, not the arithmetic of any
 * one packet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordServerTime,
  serverNow,
  clockOffsetMs,
  __resetServerClock,
} from '../../src/utils/serverClock';

/** A device whose clock is exactly right, on a jittery network. */
const TRUE_OFFSET = 0;

describe('the offset estimate converges toward the lowest-latency sample', () => {
  beforeEach(() => {
    __resetServerClock();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetServerClock();
  });

  it('a jittery stream does not leave the average latency baked into the offset', () => {
    // Latencies in ms: one fast packet among slow ones. The fast one is the
    // most informative, and the estimator must gravitate to it.
    const latencies = [400, 380, 420, 30, 390, 410, 370, 30, 400];
    for (const l of latencies) {
      const now = Date.now();
      recordServerTime(now - TRUE_OFFSET - l);
      vi.advanceTimersByTime(1000);
    }
    const offset = clockOffsetMs();
    // The naive smoothed-average estimator settled near ~300ms+ here. Anything
    // close to the average means the countdown is still inflated by it.
    expect(offset).toBeLessThan(200);
  });

  it('serverNow() never trails the engine by the full jitter of the stream', () => {
    const latencies = [500, 480, 40, 470, 40, 460, 40];
    for (const l of latencies) {
      const now = Date.now();
      recordServerTime(now - TRUE_OFFSET - l);
      vi.advanceTimersByTime(1000);
    }
    // trueServerNow == Date.now() for a correct device clock. serverNow()
    // trailing it is exactly the "time you do not have" being displayed.
    const trailMs = Date.now() - serverNow();
    expect(trailMs).toBeLessThan(200);
  });

  it('a genuinely wrong device clock is still corrected', () => {
    // The safety work must not cost the feature its reason for existing: a
    // phone three seconds fast still has to be pulled back onto engine time.
    const deviceAheadMs = 3000;
    for (let i = 0; i < 12; i++) {
      const now = Date.now();
      recordServerTime(now - deviceAheadMs - 25);
      vi.advanceTimersByTime(1000);
    }
    expect(clockOffsetMs()).toBeGreaterThan(2500);
    expect(clockOffsetMs()).toBeLessThan(3200);
  });

  it('tracks real drift instead of pinning itself to an old minimum', () => {
    for (let i = 0; i < 6; i++) {
      recordServerTime(Date.now() - 20);
      vi.advanceTimersByTime(1000);
    }
    // The device clock jumps forward (NTP correction, wake from sleep).
    vi.advanceTimersByTime(120_000); // past the window
    for (let i = 0; i < 12; i++) {
      recordServerTime(Date.now() - 5000 - 20);
      vi.advanceTimersByTime(1000);
    }
    expect(clockOffsetMs()).toBeGreaterThan(4000);
  });

  it('before any sample, serverNow() is just the device clock', () => {
    expect(serverNow()).toBe(Date.now());
    expect(clockOffsetMs()).toBe(0);
  });
});
