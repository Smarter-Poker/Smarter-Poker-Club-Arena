/**
 * NLH CASH PREFLOP PRESSURE (V60, Dan 2026-10-24, binding).
 *
 * "HORSES NEED TO 3BET AGGRESSIVE HUMANS MORE IN POSITION", "YOU'VE GOT TO
 * MAKE THESE HORSES KILLERS ... cash and tournament play alike".
 *
 * Production, four days of human-seated NLH cash hands (2026-10-26..29):
 * facing a single open the horses folded 78.6%, called 17.0% and 3-bet 4.4%
 * (humans 32.7 / 57.7 / 9.7); after opening they folded 61.8% to a 3-bet
 * (humans 32.0%). The 2026-10-25 tournament layer never touched cash.
 *
 * Each case is a cash hand that FOLDED (or flatted) before and now fights;
 * the explicit off arm keeps the old answer, and Omaha / pot-limit /
 * all-in-or-fold / heads-up tables are untouched.
 */
import { describe, it, expect } from 'vitest';
import { decidePreflopV7 } from './HorsePreflop.js';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    position: 'late' as const,
    raiserPosition: 'late' as const,
    strength: 0.5,
    raises: 1,
    limpers: 0,
    callers: 0,
    oppsLeft: 2,
    toCall: 3,
    currentBet: 3,
    pot: 4.5,
    contestablePot: 4.5,
    bigBlind: 1,
    stack: 100,
    stackBB: 100,
    effectiveStackBB: 100,
    tightness: 1,
    bluffFreq: 0,
    aggression: 1,
    slowplayFreq: 0,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0,
    mode: 'cash' as const,
    anteInPlay: false,
    tableSize: 6,
    v13: true,
    rand: () => 0.99,
    ...extra,
  };
}

const run = (extra: Record<string, unknown>) => decidePreflopV7(ctx(extra) as never).a;

describe('cash horses 3-bet the opener from their measured hand shares', () => {
  it('the small blind re-steals a button open with a top-15% hand', () => {
    const spot = { position: 'sb', raiserPosition: 'late', strength: 0.58 };
    expect(run(spot)).toBe('raiseTo');
    expect(run({ ...spot, cashAggression: false })).not.toBe('raiseTo');
  });

  it('the big blind 3-bets a button open with a top-11% hand', () => {
    const spot = { position: 'bb', raiserPosition: 'late', strength: 0.66, toCall: 2 };
    expect(run(spot)).toBe('raiseTo');
    expect(run({ ...spot, cashAggression: false })).not.toBe('raiseTo');
  });

  it('the button 3-bets a cutoff open with a top-11% hand', () => {
    const spot = { position: 'late', raiserPosition: 'late', strength: 0.66, isButton: true };
    expect(run(spot)).toBe('raiseTo');
    expect(run({ ...spot, cashAggression: false })).not.toBe('raiseTo');
  });

  it('the button 3-bets a middle open with a top-9% hand and an early open only from the top 6%', () => {
    expect(run({ position: 'late', raiserPosition: 'middle', strength: 0.72 })).toBe('raiseTo');
    expect(run({ position: 'late', raiserPosition: 'early', strength: 0.72 })).not.toBe('raiseTo');
    expect(run({ position: 'late', raiserPosition: 'early', strength: 0.78 })).toBe('raiseTo');
  });
});

describe('cash openers defend their open against a 3-bet', () => {
  const faced = {
    raises: 2,
    heroOpened: true,
    toCall: 10.5,
    currentBet: 13.5,
    pot: 18,
    contestablePot: 18,
  };

  it('in position the opener continues with a top-13% hand against a 4.5x 3-bet up to 100bb', () => {
    const spot = { ...faced, position: 'late', strength: 0.6 };
    expect(run(spot)).toBe('call');
    expect(run({ ...spot, cashAggression: false })).toBe('fold');
  });

  it('out of position the opener continues with a top-11% hand against a 4.5x 3-bet', () => {
    const spot = { ...faced, position: 'middle', strength: 0.63 };
    expect(run(spot)).toBe('call');
    expect(run({ ...spot, cashAggression: false })).toBe('fold');
  });

  it('deeper than 100bb the deep discipline still rules', () => {
    const spot = {
      ...faced,
      position: 'late',
      strength: 0.6,
      stack: 250,
      stackBB: 250,
      effectiveStackBB: 250,
    };
    expect(run(spot)).toBe('fold');
  });
});

describe('what it does not change', () => {
  it('Omaha, pot-limit and all-in-or-fold tables keep their own calibrations', () => {
    const spot = { position: 'sb', raiserPosition: 'late', strength: 0.58 };
    expect(run({ ...spot, isOmaha: true, isPotLimit: true })).not.toBe('raiseTo');
    expect(run({ ...spot, allInOrFold: true })).not.toBe('raiseTo');
  });

  it('trash still folds to a raise', () => {
    expect(run({ position: 'sb', raiserPosition: 'late', strength: 0.1 })).toBe('fold');
    expect(run({ position: 'late', raiserPosition: 'early', strength: 0.2 })).toBe('fold');
  });
});
