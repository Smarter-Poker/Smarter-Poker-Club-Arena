/**
 * HEADS-UP IS RAKED AT 5%, NOT 10%.
 *
 * Dan 2026-08-27, correcting a rake audit: "Rake is 10% with a max cap. Heads
 * up is 5% rake. MTTs are 10%. Spins have their own schedule. There is no rake
 * out of tournament pots, only rake on the original buy in amount and for
 * rebuys. Add-ons are never raked."
 *
 * WHAT WAS WRONG, and why nobody saw it. The engine already knew heads-up is
 * cheaper -- but only in the CAP. `getPlayerCountCaps()` halves the cap at two
 * players, and the existing tests in RakeSchedule.enforcement.test.ts pin that
 * behaviour using HUGE_POT, where the cap always binds. The PERCENT stayed at
 * the schedule's 10%, so every heads-up pot small enough that the cap never
 * bound was raked at double the intended rate, and no test looked there.
 *
 * Measured on 12 hours of live cash heads-up hands before the fix:
 *   635 raked hands, 398 of them at ~10%, average effective rate 7.77%,
 *   457.69 chips collected above what 5% would have taken.
 * The cap was doing its job on the big pots, which is exactly why the average
 * sat between the two rates and looked unremarkable.
 */
import { describe, it, expect } from 'vitest';
import { calculateRake, HEADS_UP_RAKE_PERCENT } from './PokerEngine.js';
import type { RakeConfig } from '../types.js';

/** A pot small enough that the cap can never bind, which is the broken case. */
const cfg = (percent: number, cap: number): RakeConfig =>
  ({ percent, cap, noFlopNoDrop: false }) as RakeConfig;

describe('heads-up pays 5%, not the schedule 10%', () => {
  it('rakes a sub-cap heads-up pot at 5%', () => {
    // 100 chips at 10% would be 10. Heads-up it is 5.
    expect(calculateRake(100, true, cfg(10, 1000), 2)).toBe(5);
  });

  it('still rakes three-handed and fuller tables at the schedule rate', () => {
    /* Dan specified heads-up only. Three-handed keeps the schedule percent and
       its existing 67% CAP reduction; inventing a rate he did not state would
       be worse than leaving it. */
    expect(calculateRake(100, true, cfg(10, 1000), 3)).toBe(10);
    expect(calculateRake(100, true, cfg(10, 1000), 6)).toBe(10);
    expect(calculateRake(100, true, cfg(10, 1000), 9)).toBe(10);
  });

  it('is a CEILING, never a floor - a cheaper table stays cheaper', () => {
    /* Math.min, not assignment. A club deliberately configured at 3% must not
       have its heads-up rake RAISED to 5% by a fix meant to lower it. */
    expect(calculateRake(100, true, cfg(3, 1000), 2)).toBe(3);
    expect(calculateRake(100, true, cfg(0, 1000), 2)).toBe(0);
  });

  it('the cap still binds on a big heads-up pot', () => {
    // 5% of 10,000 is 500, but the cap is 2.50, so the cap wins.
    expect(calculateRake(10_000, true, cfg(10, 2.5), 2)).toBe(2.5);
  });

  it('no flop, no drop still outranks everything', () => {
    const c = { percent: 10, cap: 1000, noFlopNoDrop: true } as RakeConfig;
    expect(calculateRake(100, false, c, 2)).toBe(0);
  });

  it('an unknown player count is NOT treated as heads-up', () => {
    /* playerCount is optional. Undefined must mean "do not apply the heads-up
       discount", not "assume two players" - guessing low here would quietly
       halve the rake on every path that forgets to pass it. */
    expect(calculateRake(100, true, cfg(10, 1000), undefined)).toBe(10);
  });

  it('a one-player count cannot happen but must not rake MORE than heads-up', () => {
    expect(calculateRake(100, true, cfg(10, 1000), 1)).toBe(5);
  });

  it('the constant is what Dan said it is', () => {
    expect(HEADS_UP_RAKE_PERCENT).toBe(5);
  });
});

describe('the exact production case that was overcharging', () => {
  it('a 200 pot heads-up at 1/2 stakes takes 10, not 20', () => {
    /* Live data 2026-08-27: pot 200, rake 20, effective 10%, on a table whose
       cap was 20 and therefore never bound. That is the hand shape that made
       up 398 of 635 heads-up hands in a 12-hour window. */
    const before = calculateRake(200, true, cfg(10, 20), 6); // full ring
    const after = calculateRake(200, true, cfg(10, 20), 2); // heads-up
    expect(before).toBe(20);
    expect(after).toBe(10);
  });
});
