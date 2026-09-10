import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import {
  restoreFastRandom,
  saveFastRandom,
  seedFastRandom,
  simulateEquity,
  variantInfo,
  type HorseEquityOutcomeCollector,
} from './HorseEval.js';
import {
  buildTournamentActionCandidates,
  evaluateTournamentUtility,
  evaluateTournamentUtilityDetailed,
  type TournamentUtilityContext,
  type TournamentUtilityInput,
} from './HorseTournamentUtility.js';
import { exactIcmEquity, exactIcmVector, icmEquityEstimate } from './IcmModel.js';
import { calculatePots } from './PokerEngine.js';
import { buildTournamentMState, TOURNAMENT_CONTEXT_INCOMPLETE } from './HorseTournamentPreflop.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type HorseDecisionWorkerResponse,
} from './horseDecision/index.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from './horseDecision/workerRuntime.js';
import type { Card, HorseDecision, SeatPlayer } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });

function seat(
  id: string,
  seatNumber: number,
  stack: number,
  totalInvested = 0,
  overrides: Partial<SeatPlayer> = {}
): SeatPlayer {
  return {
    seat: seatNumber,
    user_id: id,
    username: id,
    stack,
    bet: totalInvested,
    totalInvested,
    cards: [],
    is_folded: false,
    is_all_in: stack <= 0,
    is_sitting_out: false,
    ...overrides,
  };
}

const context = (overrides: Partial<TournamentUtilityContext> = {}): TournamentUtilityContext => ({
  format: 'mtt',
  playersLeft: 3,
  spotsPaid: 2,
  satellite: false,
  satelliteSeats: 0,
  payoutPct: [65, 35],
  fieldStacks: [1_000, 1_000, 100],
  fieldStackByUser: {},
  isPko: false,
  isBounty: false,
  isMysteryBounty: false,
  mysteryBountyStage: 'none',
  bountyFactor: 0,
  bountyByUser: {},
  mysteryMeanCents: 0,
  meanBountyCents: 0,
  prizePoolCents: 10_000,
  bountyPoolCents: 0,
  reentryOpen: false,
  rebuyOpen: false,
  maxReentries: 0,
  maxRebuys: 0,
  addOnPeriodOpen: false,
  addOnCostCents: null,
  addOnChips: null,
  buyInCents: null,
  startingStackChips: null,
  rebuyCostCents: null,
  rebuyChips: null,
  rebuyPrizeContributionCents: null,
  rebuyBountyContributionCents: null,
  reloadsUsed: 0,
  addOnTaken: false,
  rebuyAffordable: false,
  addOnAffordable: false,
  ...overrides,
});

function showdownSamples(
  opponentIds: string[],
  heroWins = 48,
  total = 100
): TournamentUtilityInput['showdownSamples'] {
  return Array.from({ length: total }, (_, sample) => ({
    boards: [
      {
        heroHigh: sample < heroWins ? 2 : 1,
        opponentHigh: opponentIds.map(() => (sample < heroWins ? 1 : 2)),
        opponentDecisionStrength: opponentIds.map(() => 0.5),
        heroLow: null,
        opponentLow: opponentIds.map(() => null),
      },
    ],
  }));
}

function input(overrides: Partial<TournamentUtilityInput> = {}): TournamentUtilityInput {
  const hero = seat('hero', 1, 900, 100);
  const villain = seat('villain', 2, 800, 200);
  const short = seat('short', 3, 0, 100, { is_all_in: true });
  const players = [hero, villain, short];
  return {
    street: 'river',
    hero,
    players,
    pots: calculatePots(players),
    pot: 400,
    currentBet: 200,
    toCall: 100,
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    minRaiseTo: 300,
    maxRaiseTo: 1_000,
    bettingStructure: 'no_limit',
    baseline: { action: 'call', amount: 100, thinkTime: 0 },
    heroEquity: 0.48,
    equitySampleSize: 320,
    equityStandardError: 0.028,
    opponents: [
      { userId: 'villain', range: [0.12, 0.44], foldMul: 1, actsAfterHero: true },
      { userId: 'short', range: [0.05, 0.35], foldMul: 1, actsAfterHero: false },
    ],
    sampledOpponentIds: ['villain', 'short'],
    showdownSamples: showdownSamples(['villain', 'short']),
    context: context(),
    ...overrides,
  };
}

/** Independent list-recursion oracle; it does not import production internals. */
function referenceIcm(stacks: number[], payouts: number[], hero: number): number {
  const live = stacks
    .map((stack, index) => ({ stack: Math.max(0, stack), index }))
    .filter((entry) => entry.stack > 0);
  const heroIndex = live.findIndex((entry) => entry.index === hero);
  if (heroIndex < 0) return 0;
  const memo = new Map<string, number>();

  const recurse = (
    remaining: Array<{ stack: number; original: number }>,
    place: number
  ): number => {
    if (place >= payouts.length || remaining.length === 0) return 0;
    const key = `${place}|${remaining.map((entry) => entry.original).join(',')}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const total = remaining.reduce((sum, entry) => sum + entry.stack, 0);
    let equity = 0;
    for (let winner = 0; winner < remaining.length; winner++) {
      const probability = remaining[winner].stack / total;
      if (remaining[winner].original === hero) {
        equity += probability * (payouts[place] ?? 0);
      } else {
        equity +=
          probability *
          recurse(
            remaining.filter((_, index) => index !== winner),
            place + 1
          );
      }
    }
    memo.set(key, equity);
    return equity;
  };

  return recurse(
    live.map((entry) => ({ stack: entry.stack, original: entry.index })),
    0
  );
}

function headsUpAllIn(overrides: Partial<TournamentUtilityInput> = {}): TournamentUtilityInput {
  const hero = seat('hero', 1, 100);
  const villain = seat('villain', 2, 0, 100, { is_all_in: true });
  const players = [hero, villain];
  return input({
    hero,
    players,
    pots: calculatePots(players),
    pot: 100,
    currentBet: 100,
    toCall: 100,
    legalActions: ['fold', 'all_in'],
    minRaiseTo: null,
    maxRaiseTo: null,
    baseline: { action: 'fold', thinkTime: 0 },
    heroEquity: 0.6,
    opponents: [{ userId: villain.user_id, range: [0.1, 0.4], foldMul: 1, actsAfterHero: false }],
    sampledOpponentIds: [villain.user_id],
    showdownSamples: showdownSamples([villain.user_id], 60),
    context: context({
      playersLeft: 2,
      spotsPaid: 1,
      payoutPct: [100],
      fieldStacks: [100, 100],
    }),
    ...overrides,
  });
}

describe('Phase 7 differential ICM', () => {
  it.each([
    [[600, 400], [100, 60], 0],
    [[2_000, 1_000, 500], [55, 30, 15], 1],
    [[5_000, 4_000, 3_000, 2_000, 1_000], [50, 25, 15, 10], 3],
    [[2_500, 0, 2_000, 0, 1_500], [50, 30, 20], 2],
  ] as const)('matches an independent exact oracle for %j', (stacks, payouts, hero) => {
    expect(exactIcmEquity([...stacks], [...payouts], hero)).toBeCloseTo(
      referenceIcm([...stacks], [...payouts], hero),
      10
    );
  });

  it('compacts busted stacks before applying the exact-player limit', () => {
    const stacks = [4_000, 0, 3_000, 0, 2_000, 0, 1_000, 0, 500, 0, 250];
    const payouts = [50, 30, 20];
    const result = icmEquityEstimate(stacks, payouts, 6);
    expect(result.method).toBe('exact_mh');
    expect(result.errorBound).toBe(0);
    expect(result.equity).toBeCloseTo(referenceIcm(stacks, payouts, 6), 10);
  });

  it('keeps a legal ten-player final table exact', () => {
    const stacks = [9_000, 7_000, 5_500, 4_000, 3_200, 2_500, 1_900, 1_300, 800, 400];
    const payouts = [42, 27, 16, 9, 6];
    const result = icmEquityEstimate(stacks, payouts, 4);
    const exact = referenceIcm(stacks, payouts, 4);
    expect(result.method).toBe('exact_mh');
    expect(result.equity).toBeCloseTo(exact, 10);
    expect(result.errorBound).toBe(0);
  });

  it('matches golden all-player vectors and conserves the complete prize pool', () => {
    const three = exactIcmVector([50, 30, 20], [50, 30, 20]);
    expect(three[0]).toBeCloseTo(38.392857143, 8);
    expect(three[1]).toBeCloseTo(32.75, 8);
    expect(three[2]).toBeCloseTo(28.857142857, 8);
    expect(three.reduce((sum, equity) => sum + equity, 0)).toBeCloseTo(100, 10);

    const ten = exactIcmVector(
      [100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
      [30, 20, 15, 10, 8, 6, 5, 4, 2]
    );
    expect(ten).toEqual(
      expect.arrayContaining([expect.closeTo(14.609292963, 8), expect.closeTo(3.097029845, 8)])
    );
    expect(ten.reduce((sum, equity) => sum + equity, 0)).toBeCloseTo(100, 9);
  });

  it('contains a differential suite of larger ladders inside every declared error', () => {
    const payouts = [42, 27, 16, 9, 6];
    for (let scenario = 0; scenario < 8; scenario++) {
      const stacks = Array.from(
        { length: 10 + (scenario % 3) },
        (_, index) => 250 + (((index + 3) * (scenario + 5) * 997) % 8_000)
      );
      const hero = (scenario * 3 + 1) % stacks.length;
      const result = icmEquityEstimate(stacks, payouts, hero);
      const exact = referenceIcm(stacks, payouts, hero);
      expect(Math.abs(result.equity - exact), `scenario ${scenario}`).toBeLessThanOrEqual(
        result.errorBound + 1e-10
      );
    }
  });

  it('samples the exact satellite finishing-order model inside its declared error', () => {
    const stacks = [9_000, 7_000, 5_500, 4_000, 3_200, 2_500, 1_900, 1_300, 800, 400, 250];
    const payouts = [20, 20, 20, 20, 20];
    const result = icmEquityEstimate(stacks, payouts, 4);
    const exact = referenceIcm(stacks, payouts, 4);
    expect(result.method).toBe('plackett_luce_mc');
    expect(result.modeledPlayers).toBe(stacks.length);
    expect(Math.abs(result.equity - exact)).toBeLessThanOrEqual(result.errorBound + 1e-10);
  });

  it('never turns a 1,000-player, 200-seat satellite into certain survival', () => {
    const stacks = Array.from({ length: 1_000 }, (_, index) => 500 + index * 3);
    const payouts = Array.from({ length: 200 }, () => 0.5);
    const result = icmEquityEstimate(stacks, payouts, 500);
    expect(result.method).toBe('plackett_luce_mc');
    expect(result.modeledPlayers).toBe(1_000);
    expect(result.equity).toBeGreaterThan(0);
    expect(result.equity).toBeLessThan(0.5);
  });
});

describe('Phase 7 conditioned outcome capture', () => {
  it('captures bounded showdown scores and decision-point strengths in the canonical pass', () => {
    const rng = saveFastRandom();
    const collector: HorseEquityOutcomeCollector = { maxSamples: 7, samples: [] };
    try {
      seedFastRandom(0x7e71);
      const equity = simulateEquity(
        [card('A', 'spades'), card('K', 'diamonds')],
        [
          card('Q', 'hearts'),
          card('J', 'clubs'),
          card('9', 'spades'),
          card('4', 'diamonds'),
          card('2', 'clubs'),
        ],
        2,
        variantInfo('nlh'),
        24,
        undefined,
        false,
        undefined,
        undefined,
        collector
      );
      expect(equity).toBeGreaterThanOrEqual(0);
      expect(equity).toBeLessThanOrEqual(1);
      expect(collector.samples).toHaveLength(7);
      for (const sample of collector.samples) {
        expect(sample.opponentHigh).toHaveLength(2);
        expect(sample.opponentLow).toEqual([null, null]);
        expect(sample.opponentDecisionStrength).toHaveLength(2);
        expect(
          sample.opponentDecisionStrength.every((strength) => strength >= 0 && strength <= 1)
        ).toBe(true);
      }
    } finally {
      restoreFastRandom(rng);
    }
  });
});

describe('Phase 7 action-specific utility', () => {
  it('enumerates each canonical legal raise family plus a distinct jam', () => {
    const candidates = buildTournamentActionCandidates(input());
    expect(candidates.map((candidate) => candidate.action)).toContain('fold');
    expect(candidates.map((candidate) => candidate.action)).toContain('call');
    expect(candidates.filter((candidate) => candidate.action === 'raise').length).toBeGreaterThan(
      3
    );
    expect(candidates.some((candidate) => candidate.id === 'jam')).toBe(true);
    for (const candidate of candidates.filter((candidate) => candidate.action === 'raise')) {
      expect(candidate.amount).toBeGreaterThanOrEqual(300);
      expect(candidate.amount).toBeLessThan(950);
    }
  });

  it('uses nested common response draws across increasing wager sizes', () => {
    const hero = seat('hero', 1, 900, 100, { bet: 0 });
    const villain = seat('villain', 2, 900, 100, { bet: 0 });
    const players = [hero, villain];
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 200,
        currentBet: 0,
        toCall: 0,
        legalActions: ['check', 'bet', 'all_in'],
        minRaiseTo: 100,
        maxRaiseTo: 900,
        baseline: { action: 'check', thinkTime: 0 },
        heroEquity: 0.5,
        equitySampleSize: 160,
        equityStandardError: 0,
        opponents: [{ userId: villain.user_id, range: [0, 1], foldMul: 1, actsAfterHero: true }],
        sampledOpponentIds: [villain.user_id],
        showdownSamples: showdownSamples([villain.user_id], 80, 160),
        context: context({
          playersLeft: 2,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [1_000, 1_000],
        }),
      })
    )!;
    const wagers = result.ledger.candidates
      .filter((candidate) => candidate.action === 'bet')
      .sort((left, right) => (left.amount ?? 0) - (right.amount ?? 0));
    expect(wagers.length).toBeGreaterThan(2);
    for (let index = 1; index < wagers.length; index++) {
      expect(wagers[index].allFoldProbability).toBeGreaterThanOrEqual(
        wagers[index - 1].allFoldProbability
      );
    }
  });

  it('never labels a jam as the baseline call when applying the uncertainty gate', () => {
    const hero = seat('hero', 1, 100, 100, { bet: 0 });
    const villain = seat('villain', 2, 100, 100, { bet: 0 });
    const players = [hero, villain];
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 200,
        currentBet: 0,
        toCall: 0,
        legalActions: ['check', 'bet', 'all_in'],
        minRaiseTo: 20,
        maxRaiseTo: 100,
        baseline: { action: 'check', thinkTime: 0 },
        heroEquity: 1,
        equitySampleSize: 100,
        equityStandardError: 0,
        opponents: [{ userId: villain.user_id, range: [0, 1], foldMul: 0, actsAfterHero: true }],
        sampledOpponentIds: [villain.user_id],
        showdownSamples: showdownSamples([villain.user_id], 100, 100),
        context: context({
          playersLeft: 2,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [200, 200],
        }),
      })
    )!;
    expect(result.decision.action).toBe('all_in');
    expect(result.ledger.overrodeBaseline).toBe(true);
  });

  it('builds prospective unequal-all-in side pots and conserves every chip', () => {
    const result = evaluateTournamentUtility(input());
    expect(result).not.toBeNull();
    expect(result!.ledger.sidePotCount).toBeGreaterThan(1);
    expect(result!.ledger.conditionedOpponentRanges).toBe(2);
    expect(result!.ledger.playersBehind).toEqual(['villain']);
    expect(result!.ledger.coveringPlayers).toContain('villain');
    for (const candidate of result!.ledger.candidates) {
      expect(candidate.stackConservationError, candidate.id).toBeLessThan(0.01);
      expect(candidate.combinedUtility, candidate.id).toBeCloseTo(
        candidate.payoutEv + candidate.bountyEv + candidate.optionEv,
        10
      );
      expect(candidate.winProbability).toBeGreaterThanOrEqual(0);
      expect(candidate.winProbability).toBeLessThanOrEqual(1);
    }
    expect(result!.ledger.componentReconciliationError).toBeLessThan(1e-10);
    expect(result!.ledger.outcomeModel).toBe('conditioned_showdown_samples');
    expect(result!.ledger.utilityOutcomeSamples).toBe(100);
  });

  it('reconciles a conserved stale local stack transfer without going dark', () => {
    const stale = evaluateTournamentUtility(
      input({
        context: context({
          playersLeft: 4,
          fieldStacks: [1_100, 1_000, 900, 100],
          fieldStackByUser: { hero: 900, villain: 1_100, short: 100 },
        }),
      })
    );
    expect(stale).not.toBeNull();
    expect(stale!.ledger.fieldPlayersActual).toBe(4);
    expect(stale!.ledger.fieldPlayersModeled).toBe(4);
    expect(stale!.ledger.fieldReconciliationErrorChips).toBe(200);

    const aggregateDrift = evaluateTournamentUtility(
      input({
        context: context({ fieldStacks: [1_200, 900, 100] }),
      })
    );
    expect(aggregateDrift).toBeNull();
    expect(
      evaluateTournamentUtilityDetailed(
        input({ context: context({ fieldStacks: [1_200, 900, 100] }) })
      ).unavailableReason
    ).toBe('field_reconciliation');
  });

  it('prices a still-unacted player behind before settling an all-in call', () => {
    const hero = seat('hero', 1, 100);
    const bettor = seat('bettor', 2, 0, 100, { is_all_in: true });
    const behind = seat('behind', 3, 100);
    const players = [hero, bettor, behind];
    const samples: TournamentUtilityInput['showdownSamples'] = Array.from({ length: 100 }, () => ({
      boards: [
        {
          heroHigh: 2,
          opponentHigh: [1, 3],
          opponentDecisionStrength: [1, 0.5],
          heroLow: null,
          opponentLow: [null, null],
        },
      ],
    }));
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 100,
        currentBet: 100,
        toCall: 100,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'all_in', thinkTime: 0 },
        heroEquity: 0,
        equitySampleSize: 100,
        equityStandardError: 0,
        opponents: [
          { userId: bettor.user_id, range: [0, 1], foldMul: 1, actsAfterHero: false },
          { userId: behind.user_id, range: [0, 1], foldMul: 1, actsAfterHero: true },
        ],
        sampledOpponentIds: [bettor.user_id, behind.user_id],
        showdownSamples: samples,
        context: context({
          playersLeft: 3,
          spotsPaid: 2,
          payoutPct: [65, 35],
          fieldStacks: [100, 100, 100],
        }),
      })
    )!;
    const call = result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(call.resultingStackVectors).toBe(2);
    expect(call.bustProbability).toBeGreaterThan(0);
    expect(call.bustProbability).toBeLessThan(1);
  });

  it('settles a mixed main-pot loss and side-pot win from one sampled showdown', () => {
    const hero = seat('hero', 1, 80, 20);
    const short = seat('short', 2, 0, 40, { is_all_in: true });
    const deep = seat('deep', 3, 0, 100, { is_all_in: true });
    const players = [hero, short, deep];
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 160,
        currentBet: 100,
        toCall: 80,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'all_in', thinkTime: 0 },
        heroEquity: 0,
        equitySampleSize: 8,
        equityStandardError: 0,
        opponents: [
          { userId: short.user_id, range: [0.1, 0.2], foldMul: 1, actsAfterHero: false },
          { userId: deep.user_id, range: [0.1, 0.2], foldMul: 1, actsAfterHero: false },
        ],
        sampledOpponentIds: [short.user_id, deep.user_id],
        showdownSamples: Array.from({ length: 8 }, () => ({
          boards: [
            {
              heroHigh: 2,
              opponentHigh: [3, 1],
              opponentDecisionStrength: [0.8, 0.8],
              heroLow: null,
              opponentLow: [null, null],
            },
          ],
        })),
        context: context({
          playersLeft: 3,
          spotsPaid: 2,
          fieldStacks: [100, 40, 100],
        }),
      })
    )!;
    const call = result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(call.sidePotCount).toBe(2);
    expect(call.chipEv).toBe(40);
    expect(call.winProbability).toBe(1);
    expect(call.stackConservationError).toBe(0);
  });

  it('locks the correct paid-place value when hero busts in the money', () => {
    const hero = seat('hero', 1, 100);
    const villain = seat('villain', 2, 0, 100, { is_all_in: true });
    const third = seat('third', 3, 100);
    const players = [hero, villain, third];
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 100,
        currentBet: 100,
        toCall: 100,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'all_in', thinkTime: 0 },
        heroEquity: 0,
        equitySampleSize: 100,
        equityStandardError: 0,
        opponents: [
          { userId: villain.user_id, range: null, foldMul: 1, actsAfterHero: false },
          { userId: third.user_id, range: null, foldMul: 1, actsAfterHero: false },
        ],
        sampledOpponentIds: [villain.user_id, third.user_id],
        showdownSamples: showdownSamples([villain.user_id, third.user_id], 0),
        context: context({
          playersLeft: 3,
          spotsPaid: 3,
          payoutPct: [50, 30, 20],
          fieldStacks: [100, 100, 100],
        }),
      })
    )!;
    const call = result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(call.bustProbability).toBeCloseTo(1, 10);
    expect(call.payoutEv).toBeCloseTo(20, 10);
  });

  it('prices a final table after lower paid places have already been settled', () => {
    const hero = seat('hero', 1, 100);
    const villain = seat('villain', 2, 0, 100, { is_all_in: true });
    const leader = seat('leader', 3, 100);
    const players = [hero, villain, leader];
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 100,
        currentBet: 100,
        toCall: 100,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'all_in', thinkTime: 0 },
        heroEquity: 0,
        equitySampleSize: 100,
        equityStandardError: 0,
        opponents: [
          { userId: villain.user_id, range: null, foldMul: 1, actsAfterHero: false },
          { userId: leader.user_id, range: null, foldMul: 1, actsAfterHero: false },
        ],
        sampledOpponentIds: [villain.user_id, leader.user_id],
        showdownSamples: showdownSamples([villain.user_id, leader.user_id], 0),
        context: context({
          playersLeft: 3,
          spotsPaid: 10,
          // Places 4-10 are already locked to eliminated players and must not
          // be reintroduced into this three-player stack vector.
          payoutPct: [50, 30, 10],
          fieldStacks: [100, 100, 100],
        }),
      })
    )!;
    const call = result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(call.bustProbability).toBe(1);
    expect(call.payoutEv).toBeCloseTo(10, 10);
    expect(result.ledger.icmMethod).toBe('exact_mh');
  });

  it('splits occupied payouts when equal starting stacks bust together', () => {
    const hero = seat('hero', 1, 100);
    const villain = seat('villain', 2, 0, 100, { is_all_in: true });
    const winner = seat('winner', 3, 0, 100, { is_all_in: true });
    const players = [hero, villain, winner];
    const losingSample: TournamentUtilityInput['showdownSamples'][number] = {
      boards: [
        {
          heroHigh: 1,
          opponentHigh: [2, 3],
          opponentDecisionStrength: [0.8, 0.8],
          heroLow: null,
          opponentLow: [null, null],
        },
      ],
    };
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 200,
        currentBet: 100,
        toCall: 100,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'all_in', thinkTime: 0 },
        heroEquity: 0,
        equitySampleSize: 8,
        equityStandardError: 0,
        opponents: [
          { userId: villain.user_id, range: null, foldMul: 1, actsAfterHero: false },
          { userId: winner.user_id, range: null, foldMul: 1, actsAfterHero: false },
        ],
        sampledOpponentIds: [villain.user_id, winner.user_id],
        showdownSamples: Array.from({ length: 8 }, () => losingSample),
        context: context({
          playersLeft: 3,
          spotsPaid: 3,
          payoutPct: [50, 30, 20],
          fieldStacks: [100, 100, 100],
        }),
      })
    )!;
    const call = result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(call.bustProbability).toBe(1);
    expect(call.payoutEv).toBeCloseTo(25, 10);
  });

  it('settles a hi-lo board as one conserved high/low split', () => {
    const hero = seat('hero', 1, 100);
    const villain = seat('villain', 2, 0, 100, { is_all_in: true });
    const players = [hero, villain];
    const splitSample: TournamentUtilityInput['showdownSamples'][number] = {
      boards: [
        {
          heroHigh: 2,
          opponentHigh: [1],
          opponentDecisionStrength: [0.8],
          heroLow: 5,
          opponentLow: [4],
        },
      ],
    };
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 100,
        currentBet: 100,
        toCall: 100,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'all_in', thinkTime: 0 },
        heroEquity: 0.5,
        equitySampleSize: 8,
        equityStandardError: 0,
        opponents: [{ userId: villain.user_id, range: null, foldMul: 1, actsAfterHero: false }],
        sampledOpponentIds: [villain.user_id],
        showdownSamples: Array.from({ length: 8 }, () => splitSample),
        context: context({
          playersLeft: 2,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [100, 100],
        }),
      })
    )!;
    const call = result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(call.chipEv).toBe(0);
    expect(call.payoutEv).toBeCloseTo(50, 10);
    expect(call.stackConservationError).toBe(0);
  });

  it('conserves randomized fold/call/raise/jam branches with folded dead money', () => {
    let seed = 0x7a11ce;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let scenario = 0; scenario < 80; scenario++) {
      const count = 2 + Math.floor(random() * 5);
      const players = Array.from({ length: count }, (_, index) => {
        const invested = 10 + Math.floor(random() * 500);
        const stack = Math.floor(random() * 1_500);
        return seat(`random-${scenario}-${index}`, index + 1, stack, invested, {
          is_all_in: stack === 0,
          is_folded: index > 1 && random() < 0.25,
        });
      });
      const hero = players[0];
      hero.is_folded = false;
      hero.is_sitting_out = false;
      hero.stack = Math.max(1, hero.stack);
      hero.is_all_in = false;
      players[1].is_folded = false;
      const currentBet = Math.max(
        ...players.filter((player) => !player.is_folded).map((p) => p.bet)
      );
      const toCall = Math.min(hero.stack, Math.max(0, currentBet - hero.bet));
      const maxRaiseTo = hero.bet + hero.stack;
      const minRaiseTo = currentBet + Math.max(10, currentBet - hero.bet);
      const canRaise = maxRaiseTo > minRaiseTo;
      const activeOpponentIds = players
        .slice(1)
        .filter((player) => !player.is_folded && !player.is_sitting_out)
        .map((player) => player.user_id);
      const legalActions = (
        toCall > 0
          ? [
              'fold',
              toCall >= hero.stack ? 'all_in' : 'call',
              ...(canRaise ? ['raise', 'all_in'] : []),
            ]
          : ['check', ...(canRaise ? ['bet', 'all_in'] : [])]
      ) as TournamentUtilityInput['legalActions'];
      const result = evaluateTournamentUtility(
        input({
          hero,
          players,
          pots: calculatePots(players),
          pot: players.reduce((sum, player) => sum + player.totalInvested, 0),
          currentBet,
          toCall,
          legalActions,
          minRaiseTo: canRaise ? minRaiseTo : null,
          maxRaiseTo: canRaise ? maxRaiseTo : null,
          baseline: { action: toCall > 0 ? 'fold' : 'check', thinkTime: 0 },
          heroEquity: 0.2 + random() * 0.6,
          opponents: players
            .slice(1)
            .filter((player) => !player.is_folded)
            .map((player) => ({
              userId: player.user_id,
              range: [0.1, 0.7],
              foldMul: 1,
              actsAfterHero: player.seat > hero.seat,
            })),
          sampledOpponentIds: activeOpponentIds,
          showdownSamples: showdownSamples(activeOpponentIds, 45, 64),
          context: context({
            playersLeft: count,
            spotsPaid: count === 2 ? 1 : Math.min(3, count),
            payoutPct: count === 2 ? [100] : [50, 30, 20].slice(0, count),
            fieldStacks: players.map((player) => player.stack + player.totalInvested),
          }),
        })
      );
      expect(result, `scenario ${scenario}`).not.toBeNull();
      for (const candidate of result!.ledger.candidates) {
        expect(Number.isFinite(candidate.combinedUtility), `${scenario}:${candidate.id}`).toBe(
          true
        );
        expect(candidate.stackConservationError, `${scenario}:${candidate.id}`).toBeLessThan(0.01);
      }
    }
  });

  it('folds a chip-EV-positive call on a two-seat satellite bubble', () => {
    const hero = seat('hero', 1, 4_000);
    const villain = seat('villain', 2, 0, 4_000, { is_all_in: true });
    const short = seat('short', 3, 100);
    const players = [hero, villain, short];
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 4_000,
        currentBet: 4_000,
        toCall: 4_000,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'all_in', thinkTime: 0 },
        heroEquity: 0.55,
        opponents: [
          { userId: villain.user_id, range: [0.08, 0.3], foldMul: 1, actsAfterHero: false },
          { userId: short.user_id, range: [0.2, 0.8], foldMul: 1, actsAfterHero: false },
        ],
        showdownSamples: showdownSamples(['villain', 'short'], 55),
        context: context({
          playersLeft: 3,
          spotsPaid: 2,
          satellite: true,
          satelliteSeats: 2,
          payoutPct: [50, 50],
          fieldStacks: [4_000, 4_000, 100],
        }),
      })
    );
    const call = result!.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(call.chipEv).toBeGreaterThan(0);
    expect(result!.ledger.objective).toBe('satellite_seat_equity');
    expect(result!.decision.action).toBe('fold');
  });

  it('takes the same positive-chip-EV call in a winner-take-all Spin', () => {
    const hero = seat('hero', 1, 4_000);
    const villain = seat('villain', 2, 0, 4_000, { is_all_in: true });
    const short = seat('short', 3, 100);
    const players = [hero, villain, short];
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 4_000,
        currentBet: 4_000,
        toCall: 4_000,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'fold', thinkTime: 0 },
        heroEquity: 0.7,
        equityStandardError: 0.02,
        opponents: [
          { userId: villain.user_id, range: [0.08, 0.3], foldMul: 1, actsAfterHero: false },
          { userId: short.user_id, range: [0.2, 0.8], foldMul: 1, actsAfterHero: false },
        ],
        showdownSamples: showdownSamples(['villain', 'short'], 70),
        context: context({
          format: 'spin',
          playersLeft: 3,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [4_000, 4_000, 100],
        }),
      })
    );
    expect(result!.ledger.objective).toBe('spin_chip_ev');
    expect(result!.decision.action).toBe('all_in');
  });

  it('reconciles PKO cash bounties once and mystery chests at their full mean', () => {
    const pko = evaluateTournamentUtility(
      headsUpAllIn({
        context: context({
          playersLeft: 2,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [100, 100],
          isPko: true,
          isBounty: true,
          bountyFactor: 0.5,
          bountyByUser: { hero: 10_000, villain: 10_000 },
          meanBountyCents: 10_000,
          prizePoolCents: 10_000,
          bountyPoolCents: 10_000,
        }),
      })
    )!;
    const pkoCall = pko.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(pko.ledger.objective).toBe('pko');
    expect(pkoCall.bountyEv).toBeCloseTo(5, 8);
    expect(pkoCall.combinedUtility).toBeCloseTo(
      pkoCall.payoutEv + pkoCall.bountyEv + pkoCall.optionEv,
      10
    );

    const mystery = evaluateTournamentUtility(
      headsUpAllIn({
        context: context({
          playersLeft: 2,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [100, 100],
          isBounty: true,
          isMysteryBounty: true,
          mysteryBountyStage: 'active',
          bountyFactor: 0.5,
          mysteryMeanCents: 10_000,
          prizePoolCents: 10_000,
          bountyPoolCents: 10_000,
        }),
      })
    )!;
    const mysteryCall = mystery.ledger.candidates.find(
      (candidate) => candidate.id === 'call:all-in'
    )!;
    expect(mystery.ledger.objective).toBe('mystery_bounty');
    expect(mysteryCall.bountyEv).toBeCloseTo(10, 8);
    expect(mysteryCall.bountyEv).toBeCloseTo(pkoCall.bountyEv * 2, 8);
  });

  it('uses the production equal-claimant rule when one player wins both hi-lo shares', () => {
    const hero = seat('hero', 1, 100);
    const busted = seat('busted', 2, 0, 100, { is_all_in: true });
    const lowChopper = seat('low-chopper', 3, 0, 100, { is_all_in: true });
    const players = [hero, busted, lowChopper];
    const result = evaluateTournamentUtility(
      input({
        hero,
        players,
        pots: calculatePots(players),
        pot: 200,
        currentBet: 100,
        toCall: 100,
        legalActions: ['fold', 'all_in'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'all_in', thinkTime: 0 },
        heroEquity: 0.75,
        equitySampleSize: 8,
        equityStandardError: 0,
        opponents: [
          { userId: busted.user_id, range: [0, 1], foldMul: 1, actsAfterHero: false },
          { userId: lowChopper.user_id, range: [0, 1], foldMul: 1, actsAfterHero: false },
        ],
        sampledOpponentIds: [busted.user_id, lowChopper.user_id],
        showdownSamples: Array.from({ length: 8 }, () => ({
          boards: [
            {
              heroHigh: 3,
              opponentHigh: [1, 2],
              opponentDecisionStrength: [0.5, 0.5],
              heroLow: 5,
              opponentLow: [null, 5],
            },
          ],
        })),
        context: context({
          playersLeft: 3,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [100, 100, 100],
          isBounty: true,
          bountyFactor: 0.5,
          bountyByUser: { busted: 10_000 },
          meanBountyCents: 10_000,
          prizePoolCents: 10_000,
          bountyPoolCents: 10_000,
        }),
      })
    )!;
    const call = result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;

    // Hero won 3/4 of the chips, but knockoutAttribution sees two distinct
    // claimants (hero and low-chopper), so the head is split 1/2 rather than
    // proportionally to chips won.
    expect(call.bountyEv).toBeCloseTo(25, 8);
  });

  it('uses the persisted mystery stage instead of applying active-chest EV everywhere', () => {
    const bountyFor = (stage: 'pending' | 'active' | 'complete') => {
      const result = evaluateTournamentUtility(
        headsUpAllIn({
          context: context({
            playersLeft: 2,
            spotsPaid: 1,
            payoutPct: [100],
            fieldStacks: [100, 100],
            isBounty: true,
            isMysteryBounty: true,
            mysteryBountyStage: stage,
            bountyByUser: { villain: 4_000 },
            meanBountyCents: 3_000,
            mysteryMeanCents: 10_000,
            bountyFactor: 0.5,
            prizePoolCents: 10_000,
            bountyPoolCents: 10_000,
          }),
        })
      )!;
      return result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!.bountyEv;
    };

    const active = bountyFor('active');
    // Pending-stage knockouts pay the configured flat bounty.  With 60%
    // equity, a 4,000c target head and 3,000c hero head in a 20,000c funded
    // pool produce 0.6*20 - 0.4*15 = 6 pool-percentage points.  Active mystery
    // chests use 10,000c for both heads: 0.6*50 - 0.4*50 = 10.
    expect(bountyFor('pending')).toBeCloseTo(6, 8);
    expect(active).toBeCloseTo(10, 8);
    expect(bountyFor('complete')).toBe(0);
  });

  it('keeps multi-seat SNG utility distinct from both MTT and Spin objectives', () => {
    expect(
      evaluateTournamentUtility(input({ context: context({ format: 'sng' }) }))?.ledger.objective
    ).toBe('sng');
  });

  it('uses personal reload/add-on eligibility and never assumes unknown eligibility', () => {
    const recovery = context({
      playersLeft: 2,
      spotsPaid: 1,
      payoutPct: [100],
      fieldStacks: [100, 100],
      reentryOpen: true,
      maxReentries: 1,
      startingStackChips: 100,
      buyInCents: 100,
      rebuyCostCents: 100,
      rebuyChips: 100,
      rebuyPrizeContributionCents: 90,
      rebuyBountyContributionCents: 0,
      rebuyAffordable: true,
      prizePoolCents: 10_000,
    });
    const eligible = evaluateTournamentUtility(
      headsUpAllIn({ context: { ...recovery, reloadsUsed: 0 } })
    )!;
    const exhausted = evaluateTournamentUtility(
      headsUpAllIn({ context: { ...recovery, reloadsUsed: 1 } })
    )!;
    const unknown = evaluateTournamentUtility(
      headsUpAllIn({ context: { ...recovery, rebuyAffordable: null } })
    );
    const reloadUnknown = evaluateTournamentUtility(
      headsUpAllIn({ context: { ...recovery, reloadsUsed: null } })
    );
    const unfunded = evaluateTournamentUtility(
      headsUpAllIn({ context: { ...recovery, rebuyAffordable: false } })
    )!;
    const callOf = (result: NonNullable<ReturnType<typeof evaluateTournamentUtility>>) =>
      result.ledger.candidates.find((candidate) => candidate.id === 'call:all-in')!;
    expect(callOf(eligible).optionEv).toBeGreaterThan(0);
    expect(callOf(exhausted).optionEv).toBe(0);
    expect(unknown).toBeNull();
    expect(reloadUnknown).toBeNull();
    expect(callOf(unfunded).optionEv).toBe(0);

    const bountyRecovery = evaluateTournamentUtility(
      headsUpAllIn({
        context: {
          ...recovery,
          isBounty: true,
          bountyFactor: 0.25,
          bountyPoolCents: 2_500,
          rebuyPrizeContributionCents: 75,
          rebuyBountyContributionCents: 25,
        },
      })
    );
    // A bounty reload creates a new hero head and changes both funded pools.
    // Round 1 retains the established baseline until that entire transaction
    // can be reconciled without counting the head twice.
    expect(bountyRecovery).toBeNull();

    const overlapping = evaluateTournamentUtility(
      headsUpAllIn({
        context: {
          ...recovery,
          addOnPeriodOpen: true,
          addOnCostCents: 100,
          addOnChips: 100,
          addOnTaken: false,
          addOnAffordable: true,
        },
      })
    );
    expect(overlapping).toBeNull();

    const paidBust = evaluateTournamentUtility(
      headsUpAllIn({
        context: {
          ...recovery,
          playersLeft: 2,
          spotsPaid: 2,
          payoutPct: [65, 35],
          fieldStacks: [100, 100],
        },
      })
    )!;
    expect(callOf(paidBust).optionEv).toBe(0);

    const noFundedPool = headsUpAllIn({
      context: { ...recovery, prizePoolCents: 0, bountyPoolCents: 0 },
    });
    expect(evaluateTournamentUtility(noFundedPool)).toBeNull();

    const checkInput = (taken: boolean | null) => {
      const hero = seat('hero', 1, 100);
      const villain = seat('villain', 2, 100);
      const players = [hero, villain];
      return input({
        hero,
        players,
        pots: [],
        pot: 0,
        currentBet: 0,
        toCall: 0,
        legalActions: ['check'],
        minRaiseTo: null,
        maxRaiseTo: null,
        baseline: { action: 'check', thinkTime: 0 },
        heroEquity: 0.5,
        opponents: [{ userId: villain.user_id, range: null, foldMul: 1, actsAfterHero: false }],
        sampledOpponentIds: [villain.user_id],
        showdownSamples: showdownSamples([villain.user_id], 50),
        context: context({
          playersLeft: 2,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [100, 100],
          addOnPeriodOpen: true,
          addOnCostCents: 100,
          addOnChips: 100,
          addOnTaken: taken,
          addOnAffordable: true,
          prizePoolCents: 10_000,
        }),
      });
    };
    expect(
      evaluateTournamentUtility(checkInput(false))!.ledger.candidates[0].optionEv
    ).toBeGreaterThan(0);
    expect(evaluateTournamentUtility(checkInput(true))!.ledger.candidates[0].optionEv).toBe(0);
    expect(evaluateTournamentUtility(checkInput(null))).toBeNull();

    const bountyAddOn = checkInput(false);
    bountyAddOn.context.isPko = true;
    bountyAddOn.context.isBounty = true;
    bountyAddOn.context.bountyFactor = 0.25;
    bountyAddOn.context.bountyPoolCents = 2_500;
    expect(evaluateTournamentUtility(bountyAddOn)).toBeNull();

    const forcedExpensive = checkInput(false);
    forcedExpensive.context.addOnCostCents = 9_000;
    expect(evaluateTournamentUtility(forcedExpensive)!.ledger.candidates[0].optionEv).toBeLessThan(
      0
    );
  });

  it('retains the baseline when the best point estimate omits future hero decisions', () => {
    const hero = seat('hero', 1, 100, 50, { bet: 0 });
    const villain = seat('villain', 2, 100, 50, { bet: 0 });
    const players = [hero, villain];
    const won = showdownSamples([villain.user_id], 100);
    const result = evaluateTournamentUtility(
      input({
        street: 'flop',
        hero,
        players,
        pots: calculatePots(players),
        pot: 100,
        currentBet: 0,
        toCall: 0,
        legalActions: ['check', 'bet'],
        minRaiseTo: 20,
        maxRaiseTo: 50,
        baseline: { action: 'check', thinkTime: 0 },
        heroEquity: 1,
        equitySampleSize: 100,
        equityStandardError: 0,
        opponents: [
          { userId: villain.user_id, range: [0.1, 0.9], foldMul: 1, actsAfterHero: true },
        ],
        sampledOpponentIds: [villain.user_id],
        showdownSamples: won,
        context: context({
          playersLeft: 2,
          spotsPaid: 1,
          payoutPct: [100],
          fieldStacks: [150, 150],
        }),
      })
    )!;
    expect(result.decision.action).toBe('check');
    expect(result.ledger.baselineRetainedForContinuation).toBe(true);
    expect(
      result.ledger.candidates.find((candidate) => candidate.action === 'bet')?.terminalForHero
    ).toBe(false);
  });

  it('conditions a wager response on the sampled decision-point holding', () => {
    const hero = seat('hero', 1, 100, 50, { bet: 0 });
    const villain = seat('villain', 2, 100, 50, { bet: 0 });
    const players = [hero, villain];
    const spot = (strength: number) =>
      evaluateTournamentUtility(
        input({
          hero,
          players,
          pots: calculatePots(players),
          pot: 100,
          currentBet: 0,
          toCall: 0,
          legalActions: ['check', 'bet'],
          minRaiseTo: 50,
          maxRaiseTo: 50,
          baseline: { action: 'check', thinkTime: 0 },
          heroEquity: 0.5,
          equitySampleSize: 100,
          equityStandardError: 0,
          opponents: [{ userId: villain.user_id, range: [0, 1], foldMul: 1, actsAfterHero: true }],
          sampledOpponentIds: [villain.user_id],
          showdownSamples: showdownSamples([villain.user_id], 50).map((sample) => ({
            boards: sample.boards.map((board) => ({
              ...board,
              opponentDecisionStrength: [strength],
            })),
          })),
          context: context({
            playersLeft: 2,
            spotsPaid: 1,
            payoutPct: [100],
            fieldStacks: [150, 150],
          }),
        })
      )!;
    const weak = spot(0).ledger.candidates.find((candidate) => candidate.action === 'bet')!;
    const strong = spot(1).ledger.candidates.find((candidate) => candidate.action === 'bet')!;
    expect(strong.allFoldProbability).toBeLessThan(weak.allFoldProbability);
  });

  it('stays within a bounded synchronous decision budget', () => {
    const samples: number[] = [];
    for (let iteration = 0; iteration < 12; iteration++) {
      const started = performance.now();
      expect(evaluateTournamentUtility(input())).not.toBeNull();
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(150);
  });

  it('prices a 1,000-player, 200-paid action deterministically inside the worker budget', () => {
    const largeField = [1_000, 1_000, 100];
    for (let index = 0; index < 997; index++) largeField.push(2_000 + index * 3);
    const large = input({
      equitySampleSize: 32,
      showdownSamples: showdownSamples(['villain', 'short'], 16, 32),
      context: context({
        playersLeft: 1_000,
        spotsPaid: 200,
        payoutPct: Array.from({ length: 200 }, () => 0.5),
        fieldStacks: largeField,
      }),
    });

    const started = performance.now();
    const first = evaluateTournamentUtility(large);
    const elapsed = performance.now() - started;
    const second = evaluateTournamentUtility(large);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.ledger.fieldPlayersActual).toBe(1_000);
    expect(first!.ledger.fieldPlayersModeled).toBe(1_000);
    expect(first!.ledger.icmMethod).toBe('plackett_luce_mc');
    expect(second!.ledger.candidates).toEqual(first!.ledger.candidates);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('Phase 7 live action-clock wiring', () => {
  function decisionState(contextStatus: 'complete' | 'incomplete'): {
    hero: SeatPlayer;
    state: HorseGameStateV2;
  } {
    const hero = seat('live-hero', 1, 1_900, 100, {
      cards: [card('A', 'spades'), card('K', 'spades')],
    });
    const publicHero = { ...hero, cards: [] };
    const villain = seat('live-villain', 2, 1_800, 200);
    const players = [publicHero, villain];
    const m = buildTournamentMState({
      stackChips: hero.stack,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      anteType: 'none',
      playersAtTable: 2,
      nextSmallBlind: 75,
      nextBigBlind: 150,
      nextAnte: 0,
      minutesToNextLevel: 5,
      opponentStacks: [{ userId: villain.user_id, stackChips: villain.stack }],
    });
    return {
      hero,
      state: {
        stateSchemaVersion: 1,
        heroSeat: 1,
        currentPlayerSeat: 1,
        legalActions: ['fold', 'call', 'raise', 'all_in'],
        toCall: 100,
        minRaiseTo: 400,
        maxRaiseTo: 2_000,
        bettingStructure: 'no_limit',
        fixedBetSize: null,
        wagersCapped: false,
        commitmentCapRemaining: null,
        players,
        communityCards: [],
        communityCards2: [],
        communityCards3: [],
        pot: 300,
        contestablePot: 300,
        currentBet: 200,
        minRaise: 200,
        stage: 'preflop',
        gameVariant: 'nlh',
        gameMode: 'tournament',
        format: 'mtt',
        bigBlind: 100,
        ante: 0,
        dealerSeat: 1,
        actionHistory: [
          {
            seat: 2,
            userId: villain.user_id,
            action: 'raise',
            amount: 200,
            stage: 'preflop',
            timestamp: 1,
          },
        ],
        pots: calculatePots(players),
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        variantRules: {
          holeCardsDealt: 2,
          holeCardsUse: 'any',
          boardCardsUse: 'any',
          deckSize: 52,
          splitLow8OrBetter: false,
        },
        tournament: {
          schemaVersion: 1,
          contextStatus,
          contextIssues:
            contextStatus === 'complete' ? [] : [TOURNAMENT_CONTEXT_INCOMPLETE, 'payouts_missing'],
          sourceAgeMs: 0,
          tournamentId: 'phase7-test-tournament',
          tournamentType: 'MTT',
          tournamentStatus: 'RUNNING',
          gameVariant: 'nlh',
          entrants: 3,
          nearBubble: true,
          inMoney: false,
          playersAtTable: 2,
          playersLeft: 3,
          spotsPaid: 2,
          avgStackChips: 1_500,
          medianStackChips: 1_900,
          seatsPerTable: 2,
          currentLevel: 0,
          currentSmallBlind: 50,
          currentBigBlind: 100,
          currentAnte: 0,
          anteType: 'none',
          nextSmallBlind: 75,
          nextBigBlind: 150,
          nextAnte: 0,
          levelDurationMin: 10,
          levelElapsedMin: 5,
          registrationOpen: false,
          lateRegistrationOpen: false,
          registrationRequiresAuthorization: true,
          isPko: false,
          isBounty: false,
          isMysteryBounty: false,
          mysteryBountyStage: 'none',
          reentryAllowed: false,
          reentryOpen: false,
          maxReentries: 0,
          rebuyAllowed: false,
          rebuyOpen: false,
          maxRebuys: 0,
          addOnAvailable: false,
          addOnPeriodOpen: false,
          addOnCost: null,
          addOnChips: null,
          addOnLevels: null,
          onBreak: false,
          handForHand: false,
          handForHandExpected: false,
          m,
          bountyFactor: 0,
          stacks: [2_000, 2_000, 500],
          payoutPct: [65, 35],
          mysteryChestsLeft: 0,
          mysteryMeanCents: 0,
          mysteryTopCents: 0,
          mysteryTopLive: false,
          meanBountyCents: 0,
          prizePoolCents: 10_000,
          bountyPoolCents: 0,
          buyInCents: null,
          startingStackChips: null,
          rebuyCostCents: null,
          rebuyChips: null,
          rebuyPrizeContributionCents: null,
          rebuyBountyContributionCents: null,
          reloadsUsed: 0,
          addOnTaken: false,
          rebuyAffordable: false,
          addOnAffordable: false,
          finalTable: true,
          nextBlindInMin: 5,
          nextBlindMult: 1.5,
          satellite: false,
          satelliteSeats: 0,
          bountyByUser: {},
        },
      },
    };
  }

  it('attaches the accepted ledger and emits receipts only for complete context', () => {
    enableBrainTelemetry();
    drainFires();
    const complete = decisionState('complete');
    const decision = HorseLogic.decide(
      complete.hero,
      complete.state,
      'balanced',
      {},
      { telemetry: true, mind: false, v27GtoCharts: false }
    );
    expect(decision.tournamentUtility?.schemaVersion).toBe(1);
    expect(decision.tournamentUtility?.selectedAction).toBe(decision.action);
    const features = new Set(drainFires().map((receipt) => receipt.feature));
    expect(features.has('phase7_tournament_utility')).toBe(true);

    const incomplete = decisionState('incomplete');
    const fallback = HorseLogic.decide(
      incomplete.hero,
      incomplete.state,
      'balanced',
      {},
      { telemetry: true, mind: false, v27GtoCharts: false }
    );
    expect(fallback.tournamentUtility).toBeUndefined();
    expect(new Set(drainFires().map((receipt) => receipt.feature))).toContain(
      'phase7_utility_skip_incomplete'
    );
  });

  it('fails Phase 7 closed on multi-board play instead of zipping independent deals', () => {
    enableBrainTelemetry();
    drainFires();
    const spot = decisionState('complete');
    spot.state.communityCards2 = [card('A', 'diamonds'), card('8', 'clubs'), card('3', 'spades')];

    const decision = HorseLogic.decide(
      spot.hero,
      spot.state,
      'balanced',
      {},
      {
        telemetry: true,
        mind: false,
        v27GtoCharts: false,
      }
    );
    expect(decision.tournamentUtility).toBeUndefined();
    const features = new Set(drainFires().map((receipt) => receipt.feature));
    expect(features).toContain('phase7_utility_unavailable');
    expect(features).toContain('phase7_unavailable_multi_board');
  });

  it('preserves the nested utility receipt across the live worker boundary', async () => {
    const messages: HorseDecisionWorkerResponse[] = [];
    const readiness = {
      solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
      solverPolicyArtifact: { totalPolicies: 0 } as never,
      governor: {
        enabled: true,
        scale: 1,
        p50Ms: 0,
        p99Ms: 0,
        sampledAt: 1,
        throttledForS: 0,
        stale: false,
        timerLateMs: 0,
      },
    };
    const deps: HorseDecisionWorkerDependencies = {
      startServices: async () => readiness,
      stopServices: async () => undefined,
      decide: HorseLogic.decide.bind(HorseLogic),
      decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
      captureDecisionEffects: (fn) => ({ value: fn(), effects: [] }),
      applyDecisionEffects: () => undefined,
      saveRng: saveFastRandom,
      restoreRng: restoreFastRandom,
      governorScale: () => 1,
      workerReadiness: () => readiness,
      observeCompletedHand: () => undefined,
      noteDecision: () => undefined,
      noteFeature: () => undefined,
      now: () => 1,
    };
    const snapshot = decisionState('complete');
    const request: FastHorseDecisionRequest = {
      type: 'DECIDE_FAST',
      requestId: 7,
      generation: 3,
      fence: 'phase7:worker:preflop:hero',
      decisionTimeMs: 3_600_000,
      decisionKey: '',
      player: snapshot.hero,
      gameState: snapshot.state,
      style: 'balanced',
      mods: {},
      opts: { mind: false, v27GtoCharts: false },
    };
    request.decisionKey = buildHorseDecisionKey(request);
    const runtime = new HorseDecisionWorkerRuntime((message) => messages.push(message), deps);
    runtime.receive(structuredClone(request));
    await runtime.drain();

    const result = messages.find((message) => message.type === 'FAST_RESULT');
    if (result?.type !== 'FAST_RESULT') {
      throw new Error(`worker did not return FAST_RESULT: ${JSON.stringify(messages)}`);
    }
    const cloned = structuredClone(result);
    expect(cloned.decision.tournamentUtility?.schemaVersion).toBe(1);
    expect(cloned.decision.tournamentUtility?.selectedAction).toBe(cloned.decision.action);
    expect(cloned.decision.tournamentUtility?.candidates.length).toBeGreaterThan(1);
  });

  it('runs after every legacy/global strategy layer and before think time', () => {
    const utility = readFileSync(join(here, 'HorseTournamentUtility.ts'), 'utf8');
    const logic = readFileSync(join(here, 'HorseLogic.ts'), 'utf8');
    const turns = readFileSync(join(here, 'ServerTableEngineTurns.ts'), 'utf8');
    const arbiter = logic.indexOf('const evaluation = evaluateTournamentUtilityDetailed({');
    const finalThink = logic.indexOf('decision.thinkTime = this.computeThinkTime(', arbiter);
    expect(arbiter).toBeGreaterThan(0);
    expect(finalThink).toBeGreaterThan(arbiter);
    expect(logic.slice(arbiter, finalThink)).not.toMatch(/decision\s*=\s*this\.decide/);
    expect(utility).not.toMatch(/\btightness\s*:|\bbluffFreq\s*:|\bmoodOf\(|\bHorseStyle\b.*from/);
    expect(turns).toContain('...deepResult.decision');
    expect(turns.indexOf('...deepResult.decision')).toBeLessThan(
      turns.indexOf('action: verdict.action', turns.indexOf('...deepResult.decision'))
    );
  });
});
