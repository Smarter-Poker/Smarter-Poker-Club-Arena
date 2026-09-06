/**
 * THE FRESHNESS GATE RUNS ON THE ENGINE'S CLOCK, NOT THE PHONE'S
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ build plan phase 1, 2026-09-05.
 *
 * `shouldAnnounceBbjHit` refuses a hit older than BBJ_FRESH_MS as a replay.
 * It compared the engine's `emittedAt` against `Date.now()` on the device, so
 * a phone running two minutes fast saw every LIVE jackpot as ninety-plus
 * seconds old and refused it - silently, forever, with nothing to report.
 * utils/serverClock learns the engine's clock from every EVENT and PING frame
 * and the gate asks it for "now" instead.
 *
 * REPOINTED AND SIGN-FLIPPED (Realtime Phase 5, 2026-09-06). This exercised
 * `lib/serverClock`, which was a SECOND `serverNow()` - same name, same
 * meaning, opposite arithmetic to the one the turn ring uses, born a day
 * earlier. The two are one now (see utils/serverClock), so these cases run
 * against the surviving estimator and `clockOffsetMs` reports DEVICE minus
 * ENGINE where `serverClockOffsetMs` reported engine minus device. Every
 * behaviour asserted below is unchanged; only the sign of the number and the
 * name of the function are.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  noteServerTime,
  serverNow,
  clockOffsetMs,
  __resetServerClock,
} from '../../src/utils/serverClock';
import { shouldAnnounceBbjHit, __resetBbjSeenForTests } from '../../src/lib/bbjHitOnce';

const ENGINE_NOW = 1_800_000_000_000;

beforeEach(() => {
  __resetServerClock();
  __resetBbjSeenForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('serverClock', () => {
  it('is the device clock until the engine has spoken', () => {
    vi.setSystemTime(ENGINE_NOW + 120_000);
    expect(serverNow()).toBe(ENGINE_NOW + 120_000);
    expect(clockOffsetMs()).toBe(0);
  });

  it('follows the engine once a frame carries its clock', () => {
    vi.setSystemTime(ENGINE_NOW + 120_000); // device two minutes fast
    noteServerTime(ENGINE_NOW);
    // Device minus engine: the phone is two minutes AHEAD.
    expect(clockOffsetMs()).toBe(120_000);
    expect(serverNow()).toBe(ENGINE_NOW);
    vi.setSystemTime(ENGINE_NOW + 125_000);
    expect(serverNow()).toBe(ENGINE_NOW + 5_000);
  });

  it('ignores a frame with no usable clock', () => {
    vi.setSystemTime(ENGINE_NOW);
    noteServerTime(undefined);
    noteServerTime('soon');
    noteServerTime(0);
    noteServerTime(NaN);
    expect(clockOffsetMs()).toBe(0);
  });
});

describe('the jackpot gate on a device whose clock is wrong', () => {
  it('BEFORE the engine speaks, a phone two minutes fast refuses a live hit (the bug)', () => {
    vi.setSystemTime(ENGINE_NOW + 120_000);
    expect(
      shouldAnnounceBbjHit({ tableId: 't', handNumber: 1, emittedAt: ENGINE_NOW - 1_000 })
    ).toBe(false);
  });

  it('AFTER the engine speaks, the same phone announces the same live hit (the fix)', () => {
    vi.setSystemTime(ENGINE_NOW + 120_000);
    noteServerTime(ENGINE_NOW); // the EVENT frame that carried the hit
    expect(
      shouldAnnounceBbjHit({ tableId: 't', handNumber: 1, emittedAt: ENGINE_NOW - 1_000 })
    ).toBe(true);
  });

  it('a genuinely stale replay is still refused on the engine clock', () => {
    vi.setSystemTime(ENGINE_NOW - 3_600_000); // device an hour slow
    noteServerTime(ENGINE_NOW);
    expect(
      shouldAnnounceBbjHit({ tableId: 't', handNumber: 2, emittedAt: ENGINE_NOW - 6 * 60_000 })
    ).toBe(false);
  });

  it('a device an hour SLOW no longer sees an hour-old replay as the future', () => {
    // Future-stamped events are allowed through (a device behind the engine
    // must not lose live hits), which meant a slow device could be replayed
    // anything. With the engine clock the age is real.
    vi.setSystemTime(ENGINE_NOW - 3_600_000);
    noteServerTime(ENGINE_NOW);
    expect(
      shouldAnnounceBbjHit({ tableId: 't', handNumber: 3, emittedAt: ENGINE_NOW - 30 * 60_000 })
    ).toBe(false);
  });
});
