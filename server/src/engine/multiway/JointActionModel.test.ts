import { describe, expect, it } from 'vitest';
import type { GameVariant } from '../../types.js';
import { sampleJointRanges } from './JointRangeSampler.js';
import { jointFixture } from './JointRangeFixture.test-support.js';
import {
  evaluateJointActions,
  jointPlayersBehind,
  jointCallProbability,
} from './JointActionModel.js';

function fixture(
  variant: GameVariant = 'nlh',
  stage: 'preflop' | 'flop' | 'turn' | 'river' = 'flop',
  boardCount = 2,
  mode: 'cash' | 'tournament' = 'cash'
) {
  const { hero, state } = jointFixture(variant, stage, boardCount, 4);
  Object.assign(state, {
    stateSchemaVersion: 1,
    legalActions: ['check', 'bet', 'all_in'],
    minRaiseTo: 2,
    maxRaiseTo: 100,
    toCall: 0,
    bettingStructure: ['flh', 'flo8'].includes(variant)
      ? 'fixed_limit'
      : variant.startsWith('plo')
        ? 'pot_limit'
        : 'no_limit',
    chipUnit: mode === 'cash' ? 0.01 : 1,
    asset: 'chips',
    gameMode: mode,
    rakeConfig: { percent: mode === 'cash' ? 10 : 0, cap: 2, noFlopNoDrop: true },
    bbjConfig: null,
  });
  if (state.bettingStructure === 'fixed_limit') {
    state.maxRaiseTo = 2;
    state.legalActions = ['check', 'bet'];
  }
  if (state.bettingStructure === 'pot_limit') {
    state.maxRaiseTo = 20;
    state.legalActions = ['check', 'bet'];
  }
  const evidence = sampleJointRanges(hero, state, {
    seed: 13100401,
    samples: 8,
    withinBudget: () => true,
  })!;
  return { hero, state, evidence, baseline: { action: 'check' as const, thinkTime: 0 } };
}
describe('joint action-specific rollout', () => {
  it('keeps an earlier seat owing a re-raise in the remaining clockwise response ring', () => {
    const { hero, state, evidence } = fixture('nlh', 'flop', 1);
    state.dealerSeat = 2;
    state.currentBet = 10;
    state.toCall = 10;
    state.players[1].bet = 10;
    state.players[1].totalInvested = 15;
    state.pot = 30;
    state.legalActions = ['fold', 'call'];
    state.minRaiseTo = null;
    state.maxRaiseTo = null;
    // Initial flop order is p2,p3,p0,p1; p2 already checked but still owes
    // p1's bet after p0 acts. Initial street position cannot erase that debt.
    expect(jointPlayersBehind(hero, state)).toContain('p2');
    Object.assign(
      evidence,
      sampleJointRanges(hero, state, { seed: 13100401, samples: 8, withinBudget: () => true })!
    );
    const r = evaluateJointActions(
      hero,
      state,
      { action: 'call', thinkTime: 0 },
      evidence,
      () => true
    )!;
    expect(r.candidates.find((c) => c.action === 'call')!.responseCounts.p2.responded).toBe(8);
  });
  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
    'flh',
    'pineapple',
    'short_deck',
  ] as GameVariant[])(
    '%s conserves every action branch across streets, board modes and fee units',
    (variant) => {
      for (const stage of ['preflop', 'flop', 'turn', 'river'] as const)
        for (const boards of [1, 2, 3])
          for (const mode of ['cash', 'tournament'] as const) {
            const { hero, state, evidence, baseline } = fixture(variant, stage, boards, mode);
            const before = structuredClone({ hero, state, evidence });
            const result = evaluateJointActions(hero, state, baseline, evidence, () => true)!;
            expect(result.candidates.length).toBeGreaterThanOrEqual(2);
            for (const row of result.candidates) {
              expect(row.samples).toBe(8);
              expect(row.maxConservationError).toBeLessThan(1e-6);
              expect(Number.isFinite(row.expectedNetChips)).toBe(true);
              expect(row.standardError).toBeGreaterThanOrEqual(0);
              expect(row.investment).toBeLessThanOrEqual(hero.stack);
              expect(row.covariance).toHaveLength(boards);
              if (mode === 'tournament') {
                expect(row.expectedRake).toBe(0);
                expect(row.amount === null || Number.isInteger(row.amount)).toBe(true);
              }
              if (state.bettingStructure === 'fixed_limit' && row.action === 'bet')
                expect(row.amount).toBe(2);
              if (state.bettingStructure === 'pot_limit' && row.amount !== null)
                expect(row.amount).toBeLessThanOrEqual(20);
            }
            expect(result.candidates.find((c) => c.action === 'check')!.investment).toBe(0);
            expect({ hero, state, evidence }).toEqual(before);
          }
    }
  );
  it('shows opponent-specific response and action-specific stack distributions', () => {
    const { hero, state, evidence, baseline } = fixture();
    evidence.samples.forEach((s) =>
      s.boards.forEach((b) => {
        b.opponentDecisionStrength = [0.05, 0.95];
      })
    );
    const result = evaluateJointActions(hero, state, baseline, evidence, () => true)!;
    const bet = result.candidates.find((c) => c.action === 'bet')!;
    expect(bet.responseCounts.p1.meanCallProbability!).toBeLessThan(
      bet.responseCounts.p2.meanCallProbability!
    );
    expect(bet.responseCounts.p1.called).toBeLessThan(bet.responseCounts.p2.called);
    expect(new Set(result.candidates.map((c) => c.expectedNetChips)).size).toBeGreaterThan(1);
    expect(result.candidates.some((c) => c.resultingStackVectors > 1)).toBe(true);
  });
  it('does not let future showdown ranks decide whether opponents call', () => {
    const { hero, state, evidence, baseline } = fixture();
    const modified = structuredClone(evidence);
    modified.samples.forEach((s) =>
      s.boards.forEach((b) => {
        b.heroHigh += 100000000;
        b.opponentHigh = b.opponentHigh.map(() => 0);
      })
    );
    const a = evaluateJointActions(hero, state, baseline, evidence, () => true)!;
    const b = evaluateJointActions(hero, state, baseline, modified, () => true)!;
    expect(a.candidates.map((c) => c.responseCounts)).toEqual(
      b.candidates.map((c) => c.responseCounts)
    );
    expect(a.candidates.map((c) => c.expectedNetChips)).not.toEqual(
      b.candidates.map((c) => c.expectedNetChips)
    );
  });
  it('changes the response calculation with price, cover and multiway pressure', () => {
    const { evidence } = fixture();
    const base = {
      strengths: [0.6, 0.4],
      range: evidence.ranges[0],
      price: 10,
      pot: 40,
      activeOpponents: 2,
      coversHero: false,
    };
    const p = jointCallProbability(base);
    expect(jointCallProbability({ ...base, price: 40 })).toBeLessThan(p);
    expect(jointCallProbability({ ...base, coversHero: true })).toBeGreaterThan(p);
    expect(jointCallProbability({ ...base, activeOpponents: 5 })).toBeLessThan(p);
  });
  it('uses street order, sparse seats, a dead button and the straddle', () => {
    const { hero, state } = fixture('nlh', 'preflop', 1);
    expect(jointPlayersBehind(hero, state)).toEqual(['p1']);
    state.stage = 'flop';
    expect(jointPlayersBehind(hero, state)).toEqual(['p1', 'p2']);
    state.dealerSeat = 2;
    expect(jointPlayersBehind(hero, state)).toEqual(['p1']);
    state.dealerSeat = 10;
    state.players[2].seat = 7;
    state.dealtSeatIds = [1, 2, 4, 7];
    expect(jointPlayersBehind(hero, state)).toEqual(['p1', 'p2']);
    state.stage = 'preflop';
    state.dealerSeat = 4;
    state.straddleActive = true;
    // Seat7 is SB, hero1 is BB, seat2 straddles; only seat2 remains after hero.
    expect(jointPlayersBehind(hero, state)).toEqual(['p1']);
  });
  it('settles multiple all-ins against their own main/side pots and keeps folded chips', () => {
    const { hero, state, evidence } = fixture();
    state.players[1].stack = 0;
    state.players[1].is_all_in = true;
    state.players[1].totalInvested = 20;
    state.players[1].bet = 20;
    state.players[2].stack = 0;
    state.players[2].is_all_in = true;
    state.players[2].totalInvested = 50;
    state.players[2].bet = 50;
    Object.assign(state, {
      currentBet: 50,
      pot: 80,
      toCall: 50,
      legalActions: ['fold', 'call'],
      minRaiseTo: null,
      maxRaiseTo: null,
    });
    Object.assign(
      evidence,
      sampleJointRanges(hero, state, { seed: 13100401, samples: 8, withinBudget: () => true })!
    );
    const result = evaluateJointActions(
      hero,
      state,
      { action: 'call', thinkTime: 0 },
      evidence,
      () => true
    )!;
    const call = result.candidates.find((c) => c.action === 'call')!;
    expect(call.sidePotCount).toBeGreaterThan(1);
    expect(call.responseCounts.p1.allIn).toBe(8);
    expect(call.responseCounts.p2.allIn).toBe(8);
    expect(call.responseCounts.p1.folded).toBe(0);
    expect(call.maxConservationError).toBeLessThan(1e-6);
  });
  it('includes remaining players behind when hero calls an existing wager', () => {
    const { hero, state, evidence } = fixture();
    state.currentBet = 10;
    state.toCall = 10;
    state.players[2].bet = 10;
    state.players[2].totalInvested = 15;
    state.pot = 30;
    state.legalActions = ['fold', 'call'];
    state.minRaiseTo = null;
    state.maxRaiseTo = null;
    Object.assign(
      evidence,
      sampleJointRanges(hero, state, { seed: 13100401, samples: 8, withinBudget: () => true })!
    );
    const result = evaluateJointActions(
      hero,
      state,
      { action: 'call', thinkTime: 0 },
      evidence,
      () => true
    )!;
    const call = result.candidates.find((c) => c.action === 'call')!;
    expect(call.responseCounts.p1.responded).toBe(8);
    expect(call.responseCounts.p2.responded).toBe(0);
  });
  it('returns no partial action ranking if the deadline interrupts a branch', () => {
    const { hero, state, evidence, baseline } = fixture();
    let count = 0;
    expect(evaluateJointActions(hero, state, baseline, evidence, () => ++count < 10)).toBeNull();
  });
  it('rejects a valid outcome pool belonging to an earlier public/private state', () => {
    const { hero, state, evidence, baseline } = fixture();
    state.players[1].stack--;
    expect(() => evaluateJointActions(hero, state, baseline, evidence, () => true)).toThrow(
      'stale_evidence'
    );
  });
  it.each([
    'missing_unit',
    'missing_fee',
    'private_contender',
    'missing_census',
    'no_legal_actions',
  ])('refuses incomplete %s', (fault) => {
    const { hero, state, evidence, baseline } = fixture();
    if (fault === 'missing_unit') delete state.chipUnit;
    if (fault === 'missing_fee') delete state.bbjConfig;
    if (fault === 'private_contender') evidence.opponentIds = [];
    if (fault === 'missing_census') delete state.dealtSeatIds;
    if (fault === 'no_legal_actions') state.legalActions = [];
    expect(() => evaluateJointActions(hero, state, baseline, evidence, () => true)).toThrow();
  });
});
