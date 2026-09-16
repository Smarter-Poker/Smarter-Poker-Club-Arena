/**
 * V12 REAL ICM — tournament context derivation + the icmRisk v2 model +
 * spin-format preflop widening. Pure units only; Phase 6 wraps cache misses
 * and stale reads in an explicit TOURNAMENT_CONTEXT_INCOMPLETE status.
 */

import { describe, it, expect } from 'vitest';
import { deriveContext } from './TournamentBrainContext.js';
import { HorseLogic } from '../engine/HorseLogic.js';
import { decidePreflopV7 } from '../engine/HorsePreflop.js';

const icmRisk = (
  HorseLogic.__testables as unknown as {
    icmRisk: (gs: Record<string, unknown>, stackBB: number) => number;
  }
).icmRisk;

const row = (over: Record<string, unknown> = {}) => ({
  tournament_type: 'MTT',
  game_type: 'NLH',
  variant: 'freezeout',
  max_players: 100,
  table_size: 9,
  // V13: shaped like production. All 14,280 live rows are arrays carrying an
  // explicit `place`; the old fixture omitted it, which the canonical
  // validator (rightly) rejects as an unusable structure.
  payout_structure: [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ],
  prize_pool: 1000,
  bounty_pool: 0,
  is_pko: false,
  is_bounty: false,
  ...over,
});

describe('TournamentBrainContext V12 - derivation', () => {
  it('derives formats: spin, multi-seat sng, hu_sng, mtt', () => {
    expect(deriveContext(row({ tournament_type: 'SPIN' }) as never, 3, 3, 3000).format).toBe(
      'spin'
    );
    expect(deriveContext(row({ variant: 'spin' }) as never, 3, 3, 3000).format).toBe('mtt');
    expect(
      deriveContext(
        row({ tournament_type: 'SNG', variant: 'sng', table_size: 6, max_players: 6 }) as never,
        6,
        6,
        6000
      ).format
    ).toBe('sng');
    expect(
      deriveContext(
        row({ tournament_type: 'SNG', variant: 'sng', table_size: 2, max_players: 2 }) as never,
        2,
        2,
        3000
      ).format
    ).toBe('hu_sng');
    expect(deriveContext(row({ table_size: 2 }) as never, 2, 2, 3000).format).toBe('mtt');
    expect(deriveContext(row() as never, 40, 60, 100000).format).toBe('mtt');
  });

  it('rejects a payout structure that is valid JSON but unusable', () => {
    // The old local parser counted [null, null] as two paid places, and any
    // array length as the paid count. The canonical validator requires a
    // place 1 and sane percentages. NOTE: it accepts the ARRAY shape only —
    // all 14,280 live tournament rows are arrays carrying an explicit place,
    // so that is the only shape this path has to read.
    const junk = deriveContext(row({ payout_structure: [null, null] }) as never, 3, 20, 5000);
    expect(junk.spotsPaid).toBe(0);
    expect(junk.nearBubble).toBe(false);
    expect(junk.inMoney).toBe(false);

    const noPlaceOne = deriveContext(
      row({ payout_structure: [{ place: 2, percentage: 100 }] }) as never,
      3,
      20,
      5000
    );
    expect(noPlaceOne.spotsPaid).toBe(0);
  });

  it('rebuilds a Spin payout from the multiplier when the structure is missing', () => {
    // A multi-place Spin with no stored structure used to be assumed
    // winner-take-all, which zeroes the ICM premium outright.
    const spin = deriveContext(
      row({ tournament_type: 'SPIN', payout_structure: null, spin_multiplier: 3 }) as never,
      2,
      3,
      3000
    );
    expect(spin.format).toBe('spin');
    expect(spin.spotsPaid).toBeGreaterThanOrEqual(1);
  });

  it('computes bubble state from real players-left vs spots-paid', () => {
    // 3 paid: 4 left = stone bubble; 3 left = in the money; 8 left = neither
    expect(deriveContext(row() as never, 4, 60, 8000).nearBubble).toBe(true);
    expect(deriveContext(row() as never, 4, 60, 8000).inMoney).toBe(false);
    expect(deriveContext(row() as never, 3, 60, 8000).inMoney).toBe(true);
    expect(deriveContext(row() as never, 8, 60, 8000).nearBubble).toBe(false);
    expect(deriveContext(row() as never, 8, 60, 8000).avgStackChips).toBe(1000);
  });

  it('does not invent winner-take-all when a Spin payout is unresolved', () => {
    const c = deriveContext(
      row({ tournament_type: 'SPIN', payout_structure: [] }) as never,
      3,
      3,
      3000
    );
    expect(c.spotsPaid).toBe(0);
    expect(c.contextStatus).toBe('incomplete');
    expect(c.contextIssues).toContain('payout_or_ticket_structure_missing');
  });

  it('computes the PKO bounty factor', () => {
    const c = deriveContext(
      row({ is_pko: true, prize_pool: 600, bounty_pool: 400 }) as never,
      20,
      50,
      50000
    );
    expect(c.bountyFactor).toBeCloseTo(0.4, 5);
    expect(deriveContext(row() as never, 20, 50, 50000).bountyFactor).toBe(0);
  });
});

describe('HorseLogic V12 - icmRisk v2', () => {
  const gs = (
    tournament: Record<string, unknown> | undefined,
    over: Record<string, unknown> = {}
  ) => ({
    bigBlind: 100,
    gameMode: 'tournament',
    tournament,
    ...over,
  });

  it('cash is always zero; spins are pure chip EV', () => {
    expect(icmRisk({ bigBlind: 2, gameMode: 'cash' }, 100)).toBe(0);
    expect(icmRisk(gs({ playersLeft: 3, spotsPaid: 1 }, { format: 'spin' }), 20)).toBe(0);
  });

  it('pressure scales with real distance to the money', () => {
    const far = icmRisk(gs({ playersLeft: 60, spotsPaid: 10 }), 30);
    const near = icmRisk(gs({ playersLeft: 13, spotsPaid: 10 }), 30);
    const stone = icmRisk(gs({ playersLeft: 11, spotsPaid: 10 }), 30);
    expect(near).toBeGreaterThan(far);
    expect(stone).toBeGreaterThan(near);
  });

  it('a covering big stack on the bubble gets HALF the premium (abuse mode)', () => {
    const t = { playersLeft: 11, spotsPaid: 10, avgStackChips: 2000 }; // avg 20bb
    const medium = icmRisk(gs(t), 25);
    const big = icmRisk(gs(t), 60); // 3x average
    expect(big).toBeLessThan(medium);
  });

  it('in the money: short stacks ladder, big stacks play chips', () => {
    const t = { playersLeft: 8, spotsPaid: 10 };
    expect(icmRisk(gs(t), 10)).toBeGreaterThan(icmRisk(gs(t), 50));
  });

  it('PKO bounty share trims the premium', () => {
    const base = { playersLeft: 30, spotsPaid: 10 };
    expect(icmRisk(gs({ ...base, bountyFactor: 0.4 }), 30)).toBeLessThan(icmRisk(gs(base), 30));
  });

  it('legacy V7 flags keep their exact behavior', () => {
    expect(icmRisk(gs({ nearBubble: true }), 30)).toBeCloseTo(0.08, 5);
    expect(icmRisk(gs({ inMoney: true }), 70)).toBeCloseTo(0.01, 5);
  });

  it('does not let an explicitly incomplete Phase 6 payout snapshot steer ICM', () => {
    const baseline = icmRisk(gs(undefined), 30);
    const incomplete = icmRisk(
      gs({
        schemaVersion: 1,
        contextStatus: 'incomplete',
        playersLeft: 11,
        spotsPaid: 10,
        avgStackChips: 2000,
        stacks: [3000, 2000, 1000],
        payoutPct: [50, 30, 20],
      }),
      30
    );
    expect(incomplete).toBe(baseline);
    expect(incomplete).toBeLessThan(icmRisk(gs({ playersLeft: 11, spotsPaid: 10 }), 30));
  });
});

describe('HorsePreflop V12 - spin format widening', () => {
  it('a spin opens hands an MTT folds at the same stack depth', () => {
    const ctx = (format: 'mtt' | 'spin'): Parameters<typeof decidePreflopV7>[0] =>
      ({
        strength: 0.4,
        position: 'late',
        raiserPosition: null,
        raises: 0,
        limpers: 0,
        callers: 0,
        oppsLeft: 2,
        toCall: 2,
        currentBet: 2,
        pot: 3,
        bigBlind: 2,
        stack: 40,
        stackBB: 20,
        tightness: 1,
        bluffFreq: 0.15,
        aggression: 1,
        slowplayFreq: 0.1,
        sizingMultiplier: 1,
        isOmaha: false,
        isPotLimit: false,
        riskAdd: 0,
        mode: 'tournament',
        anteInPlay: false,
        format,
        rand: () => 0.99,
      }) as never;
    expect(decidePreflopV7(ctx('spin')).a).toBe('raiseTo');
    expect(decidePreflopV7(ctx('mtt')).a).not.toBe('raiseTo');
  });
});
