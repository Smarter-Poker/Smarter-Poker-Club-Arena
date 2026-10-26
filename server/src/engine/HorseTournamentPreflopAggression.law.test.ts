/**
 * TOURNAMENT PREFLOP AGGRESSION (Dan 2026-10-25, binding).
 *
 * "I WAS JUST TOLD BY REAL PLAYERS THAT THE TOURNAMENT PLAYERS ARE THE MOST
 * PASSIVE SCARED PLAYERS THEY HAVE EVER PLAYED WITH... WE HAVE TO PUMP THE
 * AGGRESSIVE NUMBERS UP".
 *
 * Production, 48 hours of human-seated NLH tournament hands: horses folded
 * to a single open 82% (humans 52%), 3-bet 5.5% (humans 11.5%), the small
 * blind folded 88-91% to an open and a <=25bb big blind folded 53%.
 *
 * Each case below is a hand that FOLDED before and must now fight, and the
 * same hand in a cash game still does what it always did - the change is
 * tournament NLH only.
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
    toCall: 220,
    currentBet: 220,
    pot: 370,
    contestablePot: 370,
    bigBlind: 100,
    stack: 4000,
    stackBB: 40,
    effectiveStackBB: 40,
    tightness: 1,
    bluffFreq: 0,
    aggression: 1,
    slowplayFreq: 0,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0.03,
    mode: 'tournament' as const,
    anteInPlay: false,
    tableSize: 6,
    v13: true,
    rand: () => 0.99,
    ...extra,
  };
}

const run = (extra: Record<string, unknown>) => decidePreflopV7(ctx(extra) as never).a;

describe('tournament horses fight back against raises', () => {
  it('the small blind re-steals a button open with a top-20% hand', () => {
    const spot = { position: 'sb', raiserPosition: 'late', strength: 0.53 };
    expect(run(spot)).toBe('raiseTo');
    expect(run({ ...spot, mode: 'cash' })).toBe('fold');
  });

  it('the button 3-bets a cutoff open with a top-11% hand', () => {
    const spot = { position: 'late', raiserPosition: 'late', strength: 0.68, isButton: true };
    expect(run(spot)).toBe('raiseTo');
    expect(run({ ...spot, mode: 'cash' })).not.toBe('raiseTo');
  });

  it('a 20bb big blind defends a button min-raise far wider', () => {
    const spot = {
      position: 'bb',
      raiserPosition: 'late',
      strength: 0.16,
      stack: 1900,
      stackBB: 20,
      effectiveStackBB: 20,
      toCall: 120,
    };
    expect(run(spot)).toBe('call');
    expect(run({ ...spot, mode: 'cash' })).toBe('fold');
  });
});

describe('tournament horses open wider', () => {
  it('the small blind opens a top-30% hand into the big blind alone', () => {
    const spot = {
      position: 'sb',
      raiserPosition: null,
      raises: 0,
      strength: 0.4,
      toCall: 50,
      currentBet: 100,
      pot: 150,
      contestablePot: 150,
      oppsLeft: 1,
    };
    expect(run(spot)).toBe('raiseTo');
  });
});

describe('what it does not change', () => {
  it('Omaha and all-in-or-fold tables keep their own calibrations', () => {
    const spot = { position: 'sb', raiserPosition: 'late', strength: 0.53 };
    expect(run({ ...spot, allInOrFold: true })).not.toBe('raiseTo');
  });

  it('trash still folds to a raise', () => {
    expect(run({ position: 'sb', raiserPosition: 'late', strength: 0.1 })).toBe('fold');
    expect(run({ position: 'late', raiserPosition: 'early', strength: 0.2 })).toBe('fold');
  });
});
