/**
 * DEEP STACKS PLAY POKER (Dan 2026-08-30).
 *
 * Dan, on the tournaments: "THERE ISN'T ANY 3 BETTING FOR SIZE, JUST 3 BET
 * ALL IN'S... ALSO SEEING OPEN RIPS FOR LARGE BB DEPTH WITH WEAK Ax hands".
 *
 * Both came from one gate. `pushFoldNlh` reads
 *
 *     stackBB <= 12 || (mzOn && effM < 6)
 *
 * and the second disjunct had NO depth cap, while the two later jam branches
 * both carry `stackBB <= 22` with comments naming this exact failure ("so a
 * big-ante deep stack does not jam 30 blinds"). The gate that decides whether
 * the WHOLE strategy is jam-or-fold was the one without the guard.
 *
 * An M low enough to trigger it needed a huge ante, and a huge ante is what
 * the table was serving — see AnteMath.test.ts. The two fixes are independent
 * on purpose: either one alone stops a 39bb stack shoving, so a future
 * mis-authored structure cannot resurrect this.
 *
 * Production, forty minutes before the fix:
 *     open jams  416, 182 deeper than 25bb (max 72bb)
 *     3-bets     254, 85.4% all-in (max 184bb)
 */
import { describe, it, expect } from 'vitest';
import { decidePreflopV7 } from './HorsePreflop.js';

/** The real table: BB 1,000, big blind ante authored as the total. */
function ctx(extra: Record<string, unknown> = {}) {
  return {
    position: 'late' as const,
    strength: 0.62,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 7,
    toCall: 1000,
    currentBet: 1000,
    pot: 2500,
    bigBlind: 1000,
    stack: 39000,
    stackBB: 39,
    tightness: 1,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0.04,
    mode: 'tournament' as const,
    anteInPlay: true,
    // FIXED: the big blind ante is one big blind per ORBIT. The bug shipped
    // 8.0 here (0.125 x 8 seats... of an ante that was itself a full BB).
    anteOrbitBB: 1.0,
    tableSize: 8,
    v13: true,
    rand: () => 0.5,
    ...extra,
  };
}

describe('a deep stack never open-jams, however burnt the M looks', () => {
  it('39bb with a big blind ante opens for a SIZE, not a shove', () => {
    const r = decidePreflopV7(ctx() as never);
    expect(r.a).not.toBe('jam');
    expect(r.a).toBe('raiseTo');
  });

  /**
   * THE DEFENCE IN DEPTH. Even handed the BROKEN orbit cost — the 8.0bb the
   * bug produced, giving effM 3.1 — the depth cap alone must refuse the shove.
   * If this ever goes red, one mis-authored blind structure is enough to put
   * every tournament back into jam-or-fold.
   */
  it('refuses to shove even when the orbit cost is the buggy 8bb', () => {
    const r = decidePreflopV7(ctx({ anteOrbitBB: 8.0 }) as never);
    expect(r.a).not.toBe('jam');
  });

  it('holds all the way across the depths production was shoving', () => {
    for (const stackBB of [25, 30, 39, 50, 72]) {
      const r = decidePreflopV7(ctx({ stackBB, stack: stackBB * 1000, anteOrbitBB: 8.0 }) as never);
      expect(r.a, `${stackBB}bb open`).not.toBe('jam');
    }
  });

  it('a genuinely short stack still jams - the fix did not disarm push/fold', () => {
    const r = decidePreflopV7(ctx({ stackBB: 9, stack: 9000, strength: 0.8 }) as never);
    expect(r.a).toBe('jam');
  });
});

describe('three-betting for a size comes back', () => {
  /** Facing a single late open, deep. This is the shape Dan screenshotted. */
  function facingOpen(extra: Record<string, unknown> = {}) {
    return ctx({
      raises: 1,
      raiserPosition: 'late' as const,
      toCall: 2500,
      currentBet: 2500,
      pot: 6000,
      strength: 0.86,
      ...extra,
    });
  }

  it('39bb raises to a size over a late open rather than shoving', () => {
    const r = decidePreflopV7(facingOpen() as never);
    expect(r.a).not.toBe('jam');
    expect(r.a).toBe('raiseTo');
  });

  it('still refuses to shove at the buggy orbit cost', () => {
    const r = decidePreflopV7(facingOpen({ anteOrbitBB: 8.0 }) as never);
    expect(r.a).not.toBe('jam');
  });

  it('a 3-bet size is a raise, not the whole stack', () => {
    const r = decidePreflopV7(facingOpen() as never) as { a: string; to?: number };
    expect(r.a).toBe('raiseTo');
    expect(r.to).toBeGreaterThan(2500);
    expect(r.to).toBeLessThan(39000);
  });

  it('but a 15bb stack still reshoves over a late open, as V7 intends', () => {
    const r = decidePreflopV7(facingOpen({ stackBB: 15, stack: 15000 }) as never);
    expect(r.a).toBe('jam');
  });
});

describe('the blind clock still reaches past the depth cap', () => {
  /**
   * V23 deliberately lets a level that is about to double the blinds push a
   * 30bb stack into jam-or-fold, and its own comment says "past the 22bb
   * orange-zone cap". So the cap is read in the SAME currency as the M it
   * guards: a 30bb stack two minutes from doubled blinds is a 15bb stack.
   * A flat cap would have silently repealed that feature.
   */
  it('30bb two minutes from a doubling level still jams', () => {
    const r = decidePreflopV7(
      ctx({ stackBB: 30, stack: 30000, nextBlindInMin: 2, nextBlindMult: 2 }) as never
    );
    expect(r.a).toBe('jam');
  });

  it('the same stack with the level far away does not', () => {
    const r = decidePreflopV7(ctx({ stackBB: 30, stack: 30000 }) as never);
    expect(r.a).not.toBe('jam');
  });

  it('and a doubling level cannot drag a 60bb stack into a shove', () => {
    const r = decidePreflopV7(
      ctx({ stackBB: 60, stack: 60000, nextBlindInMin: 2, nextBlindMult: 2 }) as never
    );
    expect(r.a).not.toBe('jam');
  });
});
