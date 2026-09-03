/**
 * V25 — PLO TOURNAMENT RANGES (Dan 2026-08-28)
 *
 * THE STRUCTURAL FACT the brain did not model: POT LIMIT MEANS YOU CANNOT
 * SHOVE. A preflop pot-sized raise is ~3.5bb, so a preflop all-in is legal
 * only at roughly 3.5bb or less. Every M-zone jam gate is holdem thinking - a
 * 12bb PLO stack that "jams" actually raises 3.5bb and then sits with 8.5bb
 * behind, facing a 3-bet it never planned for, because legalize() silently
 * clamps the intent to what pot limit allows.
 *
 * So short-stack PLO is a COMMITMENT decision: raising pot at this depth
 * means the rest is going in, the bar is a stack-off bar, and having invited
 * the re-raise you do not then fold to it.
 *
 * These tests drive the real decidePreflopV7 and compare against the same
 * spot with the layer ablated, so every claim is a measured difference.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { seedFastRandom } from './HorseEval.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';

beforeEach(() => seedFastRandom(0x5eed25));

/** A PLO tournament spot. bb = 100 throughout, antes in play. */
function ploT(extra: Record<string, unknown> = {}) {
  return {
    strength: 0.7,
    position: 'late' as const,
    raiserPosition: null as string | null,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 6,
    toCall: 100,
    currentBet: 100,
    pot: 250,
    bigBlind: 100,
    stack: 1200, // 12bb - "push/fold" in holdem, one pot raise + change in PLO
    stackBB: 12,
    tightness: 1,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: true,
    isPotLimit: true,
    riskAdd: 0.04,
    mode: 'tournament' as const,
    anteInPlay: true,
    // 0.125/player x 8 seats = a 1.0bb ante per ORBIT (orbit total 2.5bb),
    // the same figure the old per-player field produced here.
    anteOrbitBB: 1.0,
    tableSize: 8,
    ploPriceDefense: true,
    ploTourney: true,
    v13: true,
    rand: () => 0.5,
    ...extra,
  };
}

describe('V25 the pot-limit commitment zone', () => {
  it('a 12bb PLO stack raises POT, never a fictional all-in', () => {
    const r = decidePreflopV7(ploT() as never);
    expect(r.a).toBe('raiseTo');
    // The pot-limit maximum, which at this depth IS the commitment.
    //
    // 2026-09-03: this used to assert 300 < to <= 400, pinning the layer's
    // old `bb * 3.5` shorthand. That shorthand is the pot only in a game with
    // no ante, no straddle, no dead blind and no limper, and THIS fixture has
    // an ante - the pot is 2.5bb, not 1.5bb. The real pot-limit ceiling here
    // is currentBet + pot + toCall = 100 + 250 + 100 = 450, and asking for
    // 350 left a fifth of the legal raise on the table every time an ante was
    // in play. The sizer now reads the live pot, so the number moved to the
    // one the game actually allows.
    expect(r.to).toBe(450);
  });

  it('WITHOUT the layer the same stack emits a jam pot limit cannot honour', () => {
    // The old gate: isOmaha && mzOn && (stackBB <= 8 || effM < 4). At 12bb
    // with antes the M is ~4.8, so it fired - and asked for an all-in the
    // engine then clamped to a 3.5bb raise, leaving 8.5bb behind with no
    // plan. That mismatch is the bug this layer removes.
    const r = decidePreflopV7(ploT({ ploTourney: false }) as never);
    expect(r.a).toBe('jam');
  });

  it('a deep PLO stack is NOT in the commitment zone', () => {
    // 60bb: one pot raise is under 6% of the stack, so nothing is committed
    // and normal opening logic owns the decision.
    const r = decidePreflopV7(ploT({ stack: 6000, stackBB: 60 }) as never);
    expect(r.a).toBe('raiseTo');
    expect(r.to).toBeLessThan(1000); // a normal open, not a pot commitment
  });

  it('weak hands still fold in the commitment zone', () => {
    expect(decidePreflopV7(ploT({ strength: 0.3 }) as never).a).toBe('fold');
  });

  it('the zone widens as the stack approaches one pot raise', () => {
    // 4bb: a pot raise IS the stack, so this is a genuine shove and the bar
    // drops. A hand that folds at 12bb commits at 4bb.
    const marginal = 0.45;
    expect(decidePreflopV7(ploT({ strength: marginal }) as never).a).toBe('fold');
    const shallow = decidePreflopV7(ploT({ strength: marginal, stack: 400, stackBB: 4 }) as never);
    expect(shallow.a).toBe('raiseTo');
  });
});

describe('V25 price-driven all-in calls', () => {
  it('a great price widens the call-off - PLO equities compress', () => {
    // Facing an all-in, getting better than 3:1. In PLO the worst four cards
    // still hold ~30% against the best, so folding a decent hand at this
    // price is a bigger error than in holdem.
    const cheap = ploT({
      raises: 1,
      raiserPosition: 'late',
      toCall: 300,
      currentBet: 400,
      pot: 1100,
      strength: 0.5,
    });
    expect(decidePreflopV7(cheap as never).a).toBe('raiseTo');
  });

  it('a bad price is still a fold', () => {
    const pricey = ploT({
      raises: 1,
      raiserPosition: 'late',
      toCall: 1100,
      currentBet: 1200,
      pot: 1400,
      strength: 0.45,
    });
    expect(decidePreflopV7(pricey as never).a).toBe('fold');
  });
});

describe('V25 the Omaha reshove', () => {
  const reshove = (extra: Record<string, unknown> = {}) =>
    ploT({
      stack: 2000,
      stackBB: 20, // above the commitment zone, below a playing stack
      raises: 1,
      raiserPosition: 'late',
      toCall: 300,
      currentBet: 350,
      pot: 500,
      strength: 0.8,
      ...extra,
    });

  it('a 20bb PLO stack re-raises a late open instead of flatting', () => {
    const r = decidePreflopV7(reshove() as never);
    expect(r.a).toBe('raiseTo');
  });

  it('it re-raises to POT - and so does the generic 3-bet now', () => {
    // What this test used to prove, and why it changed (2026-09-03).
    //
    // The honest difference used to be SIZING: both paths raised, but the
    // generic 3-bet asked for currentBet * 2.2-2.6 and pot limit clamped
    // whatever it liked, while this layer asked for the pot. That gap was
    // half of the defect Dan raised - the generic path was a NO-LIMIT sizing
    // ladder running the pot-limit games, and in position it asked for LESS
    // than the pot and got it. Every preflop raise in a pot-limit game is now
    // sized off the pot-limit ceiling, so the two paths agree here by
    // construction, and agreeing is the fix rather than a regression.
    //
    // 350 + 500 + 300 = 1150, the largest legal raise-to in this spot.
    const withLayer = decidePreflopV7(reshove() as never);
    const without = decidePreflopV7(reshove({ ploTourney: false }) as never);
    expect(withLayer.a).toBe('raiseTo');
    expect(without.a).toBe('raiseTo');
    expect(withLayer.to).toBe(1150);
    expect(without.to).toBe(1150);
  });

  it('a MIDDLE-position open is included, where the generic bar is tighter', () => {
    // 0.78 here against THREEBET_VS.middle = 0.80.
    const mid = reshove({ raiserPosition: 'middle', strength: 0.79 });
    expect(decidePreflopV7(mid as never).a).toBe('raiseTo');
    expect(decidePreflopV7({ ...mid, ploTourney: false } as never).a).not.toBe('raiseTo');
  });

  it('it demands real equity - PLO 3-bets get called', () => {
    // Fold equity is thin in PLO, so the reshove needs a hand, not a hope.
    expect(decidePreflopV7(reshove({ strength: 0.6 }) as never).a).not.toBe('raiseTo');
  });
});

describe('V25 never raise-fold a committed stack', () => {
  const reRaised = (extra: Record<string, unknown> = {}) =>
    ploT({
      stack: 900, // what is left behind after hero's raise
      stackBB: 9,
      raises: 2, // hero raised, someone re-raised
      raiserPosition: 'middle',
      currentBet: 1200, // hero already has ~350 of this in
      toCall: 500,
      pot: 2200,
      strength: 0.5,
      ...extra,
    });

  it('a committed PLO stack does NOT surrender - it gets the rest in', () => {
    // The property that matters is "never raise-fold", not a particular
    // verb. The layer answers with the whole remaining stack rather than a
    // flat call, and that is the better line: calling 500 of 900 leaves a
    // 400 stub that can only check-fold a flop it is already priced into.
    const r = decidePreflopV7(reRaised() as never);
    expect(r.a).not.toBe('fold');
    if (r.a === 'raiseTo') expect(r.to).toBeGreaterThanOrEqual(900);
  });

  it('WITHOUT the layer the same spot can be folded - the raise-fold leak', () => {
    expect(decidePreflopV7(reRaised({ ploTourney: false }) as never).a).toBe('fold');
  });

  it('genuine garbage still folds - this is not a call button', () => {
    expect(decidePreflopV7(reRaised({ strength: 0.2 }) as never).a).toBe('fold');
  });
});

describe('V25 blast radius', () => {
  it('NLH tournaments are completely untouched', () => {
    const nlh = ploT({ isOmaha: false, isPotLimit: false });
    expect(decidePreflopV7(nlh as never).a).toBe(
      decidePreflopV7({ ...nlh, ploTourney: false } as never).a
    );
  });

  it('PLO CASH is untouched - this layer is tournament-only', () => {
    const cash = ploT({ mode: 'cash' as const, anteInPlay: false });
    expect(decidePreflopV7(cash as never).a).toBe(
      decidePreflopV7({ ...cash, ploTourney: false } as never).a
    );
  });
});

describe('V25 league registration', () => {
  it('full_vs_v2_legacy disables the V25 flag', () => {
    const legacy = LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v25PloTourney).toBe(false);
  });
});
