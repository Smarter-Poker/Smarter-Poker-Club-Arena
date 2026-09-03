/**
 * ALL-IN-OR-FOLD: THE BRAIN HAS TO KNOW (2026-08-30).
 *
 * Found while sweeping for bugs shaped like the big blind ante one — a rule
 * the brain does not know, silently rewritten downstream. ServerTableEngine's
 * horse path said so in its own comment:
 *
 *     "The horse brain does not know about AoF, so its decision is coerced
 *      here: any non-fold intent becomes the all-in."
 *
 * So at an AoF table every hand it would have opened for 2.5bb, and every
 * hand it would have called a raise with, became a shove of the whole stack.
 * The OPENING range was the SHOVING range. A coercion guarantees legality; it
 * cannot fix a range.
 *
 * Latent rather than live when found: 8 AoF tables and 3 AoF tournaments are
 * configured, none running. It would have surfaced the first time Dan ran the
 * format, at full stack depth.
 */
import { describe, it, expect } from 'vitest';
import { decidePreflopV7 } from './HorsePreflop.js';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    position: 'late' as const,
    strength: 0.55,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 7,
    toCall: 100,
    currentBet: 100,
    pot: 250,
    bigBlind: 100,
    stack: 10000,
    stackBB: 100,
    tightness: 1,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0.04,
    mode: 'cash' as const,
    v13: true,
    rand: () => 0.5,
    allInOrFold: true,
    ...extra,
  };
}

describe('an AoF table only ever produces fold, check or jam', () => {
  it('never returns a sized raise or a call, at any depth or strength', () => {
    const seen = new Set<string>();
    for (const stackBB of [8, 15, 40, 100, 200]) {
      for (let s = 0.05; s <= 0.99; s += 0.02) {
        for (const raises of [0, 1, 2]) {
          const r = decidePreflopV7(
            ctx({
              stackBB,
              stack: stackBB * 100,
              strength: s,
              raises,
              toCall: raises > 0 ? 400 : 100,
              currentBet: raises > 0 ? 400 : 100,
            }) as never
          );
          seen.add(r.a);
        }
      }
    }
    expect([...seen].sort()).toEqual(['fold', 'jam']);
  });

  it('the big blind with nothing owed checks rather than shoving', () => {
    const r = decidePreflopV7(ctx({ toCall: 0, strength: 0.2 }) as never);
    expect(r.a).toBe('check');
  });
});

/** Count how much of a strength range shoves — a proxy for range width. */
function shoveWidth(extra: Record<string, unknown> = {}) {
  let jams = 0;
  let n = 0;
  for (let s = 0.02; s <= 0.995; s += 0.01) {
    n++;
    if (decidePreflopV7(ctx({ ...extra, strength: s }) as never).a === 'jam') jams++;
  }
  return jams / n;
}

describe('the shoving range tightens with depth - the whole point', () => {
  it('100bb shoves a far narrower range than 12bb', () => {
    const short = shoveWidth({ stackBB: 12, stack: 1200 });
    const deep = shoveWidth({ stackBB: 100, stack: 10000 });
    expect(short).toBeGreaterThan(deep + 0.15);
  });

  it('is monotone: deeper never shoves wider', () => {
    let prev = 1;
    for (const stackBB of [12, 20, 30, 50, 80, 120]) {
      const w = shoveWidth({ stackBB, stack: stackBB * 100 });
      expect(w, `${stackBB}bb`).toBeLessThanOrEqual(prev + 1e-9);
      prev = w;
    }
  });

  /**
   * THE ANCHOR. At and below 12bb the AoF bar must equal the push/fold bar
   * that is already tuned and tested, so this layer does not quietly become a
   * second set of numbers for the same decision.
   */
  it('at 12bb it matches the ordinary push/fold shoving range', () => {
    const aof = shoveWidth({ stackBB: 12, stack: 1200 });
    let pf = 0;
    let n = 0;
    for (let s = 0.02; s <= 0.995; s += 0.01) {
      n++;
      const r = decidePreflopV7(
        ctx({ stackBB: 12, stack: 1200, strength: s, allInOrFold: false }) as never
      );
      if (r.a === 'jam') pf++;
    }
    expect(aof).toBeCloseTo(pf / n, 2);
  });

  it('still shoves SOMETHING deep - it is not just a fold button', () => {
    expect(shoveWidth({ stackBB: 100, stack: 10000 })).toBeGreaterThan(0.02);
  });
});

describe('facing a shove needs the hand outright', () => {
  it('calls a shove with a narrower range than it opens one', () => {
    const opening = shoveWidth({ stackBB: 25, stack: 2500 });
    const calling = shoveWidth({
      stackBB: 25,
      stack: 2500,
      raises: 1,
      toCall: 2500,
      currentBet: 2500,
    });
    expect(calling).toBeLessThan(opening);
  });

  it('a four-bet shove is called tighter than a three-bet shove', () => {
    const three = shoveWidth({ raises: 1, toCall: 2500, currentBet: 2500 });
    const four = shoveWidth({ raises: 2, toCall: 2500, currentBet: 2500 });
    expect(four).toBeLessThanOrEqual(three);
  });
});

describe('a normal table is completely unaffected', () => {
  it('still opens for a size when AoF is off', () => {
    const r = decidePreflopV7(ctx({ allInOrFold: false, strength: 0.8 }) as never);
    expect(r.a).toBe('raiseTo');
  });

  it('an undefined flag behaves exactly like false', () => {
    const off = decidePreflopV7(ctx({ allInOrFold: false, strength: 0.8 }) as never);
    const undef = decidePreflopV7(ctx({ allInOrFold: undefined, strength: 0.8 }) as never);
    expect(undef).toEqual(off);
  });
});
