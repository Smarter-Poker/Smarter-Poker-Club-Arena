/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RE-ANCHOR IS AN EXCEPTION AGAIN — pinned as arithmetic, not as wording
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SpinStartsInOneSecondAndPlaysInFull.test.ts` asserts that the anchor exists
 * and that an on-time start keeps it. It does that by reading the SOURCE for
 * the lines that implement it — which is the house style and catches a
 * deletion, but cannot catch the thing that actually happened on 2026-08-31:
 * every line it looks for was still present, unchanged, and the invariant was
 * gone anyway.
 *
 * The re-anchor threshold had been written in terms of the HOLD:
 *
 *     if (this.spinHoldUntil - now < spinRevealToDealMs())
 *
 * With `spinHoldUntil = spinRevealAt + toDeal` = `anchor + LEAD_IN + toDeal`
 * that expands to `anchor + LEAD_IN < now` — "the reveal instant has passed",
 * which is correct. The same morning the double-counted lead-in was removed
 * and the hold became `anchor + toDeal`, a fix that was right on its own
 * terms. The threshold moved with it and became `anchor < now`: true for every
 * spin that has ever run, because the anchor is the third payment and `now` is
 * after the draw.
 *
 * So the anchor was discarded 100% of the time and `spin_reveal_window_overrun`
 * fired on roughly 1,500 spins a day. Nothing failed, no test went red, and
 * the promise the anchor exists to keep — the wheel opens one second after the
 * third payment — quietly stopped being kept.
 *
 * These tests execute the decision instead of reading it, so a derived
 * quantity cannot move it again.
 */

import { describe, it, expect } from 'vitest';
import { spinRevealWouldSkipABeat, spinRevealLag } from './spinRevealWindow.js';
import { SPIN_REVEAL, spinRevealToDealMs } from '../config/spinSpec.js';

/** The engine's own stamping, reproduced exactly: anchor = the third payment. */
const revealAtFor = (anchor: number) => anchor + SPIN_REVEAL.LEAD_IN_MS;
const holdFor = (anchor: number) => anchor + spinRevealToDealMs();

describe('an on-time start keeps the third-payment anchor', () => {
  it('a draw that lands inside the lead-in does NOT re-anchor', () => {
    const anchor = 1_000_000;
    // 400ms after the third payment: the wheel is not due for another 600ms.
    const now = anchor + 400;
    expect(spinRevealWouldSkipABeat({ now, revealAt: revealAtFor(anchor) })).toBe(false);
  });

  it('a draw that lands exactly ON the reveal instant does NOT re-anchor', () => {
    // The boundary is the interesting one: elapsed is 0, so nothing is skipped
    // and the wheel plays in full from its own first frame.
    const anchor = 1_000_000;
    const now = revealAtFor(anchor);
    expect(spinRevealWouldSkipABeat({ now, revealAt: revealAtFor(anchor) })).toBe(false);
  });

  it('one millisecond past it DOES re-anchor', () => {
    const anchor = 1_000_000;
    const now = revealAtFor(anchor) + 1;
    expect(spinRevealWouldSkipABeat({ now, revealAt: revealAtFor(anchor) })).toBe(true);
  });

  it('a genuinely late start re-anchors', () => {
    const anchor = 1_000_000;
    const now = anchor + 13_700; // the measured p50 on 2026-08-31 13:00 UTC
    expect(spinRevealWouldSkipABeat({ now, revealAt: revealAtFor(anchor) })).toBe(true);
  });
});

describe('the regression itself - the old hold-based form is not equivalent', () => {
  /* This is the whole point of the file. Both forms are evaluated on the same
     inputs, and the one that shipped says "re-anchor" where the correct one
     says "keep the anchor". */
  const oldFormWouldReanchor = (now: number, anchor: number) =>
    holdFor(anchor) - now < spinRevealToDealMs();

  it('the old form re-anchors an on-time start that the correct one keeps', () => {
    const anchor = 1_000_000;
    const now = anchor + 400; // well inside the lead-in — nothing is skipped
    expect(oldFormWouldReanchor(now, anchor)).toBe(true); // the bug
    expect(spinRevealWouldSkipABeat({ now, revealAt: revealAtFor(anchor) })).toBe(false);
  });

  it('the old form fires for ANY elapsed time at all, which is every spin', () => {
    const anchor = 1_000_000;
    for (const elapsed of [1, 10, 100, 400, 999]) {
      expect(
        oldFormWouldReanchor(anchor + elapsed, anchor),
        `the shipped form re-anchored a start only ${elapsed}ms after the third payment`
      ).toBe(true);
    }
  });

  it('the two agree once the start is genuinely late', () => {
    const anchor = 1_000_000;
    for (const elapsed of [1001, 5_000, 13_700, 60_000]) {
      const now = anchor + elapsed;
      expect(oldFormWouldReanchor(now, anchor)).toBe(true);
      expect(spinRevealWouldSkipABeat({ now, revealAt: revealAtFor(anchor) })).toBe(true);
    }
  });
});

describe('the deal is never brought forward by keeping the anchor', () => {
  /* Safety check on the branch that no longer re-anchors. When the anchor is
     kept, the hold stays `anchor + toDeal` rather than `now + toDeal`, which
     is EARLIER in wall-clock terms. It must still leave room for every beat
     the client has not yet played, or the deal lands on the wheel — the exact
     two-second overlap spinRevealTotalMs's own comment records. */
  it('the hold still covers the whole remaining sequence', () => {
    const anchor = 1_000_000;
    for (const elapsed of [0, 1, 400, 999, 1000]) {
      const now = anchor + elapsed;
      const revealAt = revealAtFor(anchor);
      expect(spinRevealWouldSkipABeat({ now, revealAt })).toBe(false);

      const holdRemaining = holdFor(anchor) - now;
      // What the player still has to see, measured from now: the wait until
      // the wheel opens, then the whole sequence from its first frame.
      const stillOwed = revealAt - now + (spinRevealToDealMs() - SPIN_REVEAL.LEAD_IN_MS);
      expect(holdRemaining).toBeGreaterThanOrEqual(stillOwed);
    }
  });
});

describe('the lag is a lateness measure', () => {
  it('is zero when the engine beats its own deadline', () => {
    expect(spinRevealLag({ now: 1_000_400, revealAt: 1_001_000 })).toBe(0);
  });

  it('is the overshoot when it does not', () => {
    expect(spinRevealLag({ now: 1_014_700, revealAt: 1_001_000 })).toBe(13_700);
  });

  it('never returns a negative, so a percentile over it cannot be flattered', () => {
    expect(spinRevealLag({ now: 0, revealAt: 9_999 })).toBe(0);
  });

  it('a nonsense clock is treated as late rather than silently on time', () => {
    expect(spinRevealWouldSkipABeat({ now: NaN, revealAt: 1 })).toBe(true);
    expect(spinRevealLag({ now: NaN, revealAt: 1 })).toBe(0);
  });
});
