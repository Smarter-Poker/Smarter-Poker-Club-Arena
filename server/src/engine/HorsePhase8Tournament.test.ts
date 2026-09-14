import { describe, expect, it, vi } from 'vitest';
import * as IcmModel from './IcmModel.js';
import * as FutureHand from './HorseTournamentFutureHand.js';
import { projectTournamentFutureGame } from './HorseTournamentFutureGame.js';
import {
  simulateTournamentContinuation,
  CONTINUATION_POLICY,
  continuationStrength,
} from './HorseTournamentContinuation.js';
import {
  evaluateTournamentPostflop,
  PHASE8_POLICY,
  deepOnePairCommitment,
  hasTournamentNutBlocker,
} from './HorseTournamentPostflop.js';
import { HorsePhase8Safety } from './HorsePhase8Safety.js';
import {
  evaluateTournamentUtility,
  evaluateTournamentUtilityDetailed,
  type TournamentUtilityInput,
} from './HorseTournamentUtility.js';
import { simulateEquity, variantInfo, seedFastRandom } from './HorseEval.js';
import { calculatePots } from './PokerEngine.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import type { Card, SeatPlayer } from '../types.js';

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
const seat = (id: string, n: number, stack: number, investment = 0): SeatPlayer => ({
  user_id: id,
  username: id,
  seat: n,
  stack,
  bet: investment,
  totalInvested: investment,
  cards: [],
  is_folded: false,
  is_all_in: stack === 0,
  is_sitting_out: false,
});
function scenario(depth = 600) {
  const hero = seat('hero', 1, depth * 10 - 100, 100);
  hero.cards = [card('A', 'clubs'), card('A', 'diamonds')];
  const villain = seat('villain', 2, depth * 10 - 2000, 2000);
  const short = seat('short', 3, 500);
  const players = [hero, villain, short];
  const board = [
    card('3', 'clubs'),
    card('5', 'spades'),
    card('J', 'diamonds'),
    card('T', 'spades'),
  ];
  const gs: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    heroSeat: 1,
    currentPlayerSeat: 1,
    players: players.map((p) => ({ ...p, cards: [] })),
    communityCards: board,
    pot: 2100,
    pots: calculatePots(players),
    currentBet: 2000,
    minRaise: 1900,
    lastRaise: 1900,
    stage: 'turn',
    gameVariant: 'nlh',
    bigBlind: 10,
    gameMode: 'tournament',
    format: 'mtt',
    dealerSeat: 3,
    toCall: 1900,
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    minRaiseTo: 3900,
    maxRaiseTo: depth * 10,
    bettingStructure: 'no_limit',
    actionHistory: [
      { seat: 2, userId: 'villain', stage: 'turn', action: 'raise', amount: 2000, timestamp: 1 },
    ],
    tournament: {
      schemaVersion: 1,
      contextStatus: 'complete',
      contextIssues: [],
      playersLeft: 3,
      spotsPaid: 2,
      payoutPct: [65, 35],
      stacks: [depth * 10, depth * 10, 500],
      stackByUser: { hero: depth * 10, villain: depth * 10, short: 500 },
      currentSmallBlind: 5,
      currentBigBlind: 10,
      currentAnte: 0,
      anteType: 'none',
      nextSmallBlind: 10,
      nextBigBlind: 20,
      nextAnte: 0,
      nextBlindInMin: 1,
      prizePoolCents: 10000,
      bountyPoolCents: 0,
    },
  };
  const samples = Array.from({ length: 32 }, (_, i) => ({
    boards: [
      {
        heroHigh: i < 24 ? 2 : 1,
        opponentHigh: [i < 24 ? 1 : 2, 0],
        opponentDecisionStrength: [0.4, 0.1],
        heroLow: null,
        opponentLow: [null, null],
        continuationStreets: [
          { street: 'turn' as const, heroStrength: 0.4, opponentStrength: [0.4, 0.1] },
          { street: 'river' as const, heroStrength: 0.4, opponentStrength: [0.7, 0.1] },
        ],
      },
    ],
  }));
  const input: TournamentUtilityInput = {
    street: 'turn',
    hero,
    players: gs.players,
    pots: gs.pots!,
    pot: 2100,
    currentBet: 2000,
    toCall: 1900,
    legalActions: gs.legalActions!,
    minRaiseTo: 3900,
    maxRaiseTo: depth * 10,
    bettingStructure: 'no_limit',
    baseline: { action: 'call', amount: 1900, thinkTime: 0 },
    heroEquity: 0.75,
    equitySampleSize: 2000,
    equityStandardError: 0.01,
    opponents: [
      { userId: 'villain', range: [0.1, 0.5], foldMul: 1, actsAfterHero: false },
      { userId: 'short', range: [0.1, 0.8], foldMul: 1, actsAfterHero: true },
    ],
    sampledOpponentIds: ['villain', 'short'],
    showdownSamples: samples,
    context: {
      format: 'mtt',
      playersLeft: 3,
      spotsPaid: 2,
      satellite: false,
      satelliteSeats: 0,
      payoutPct: [65, 35],
      fieldStacks: [depth * 10, depth * 10, 500],
      fieldStackByUser: { hero: depth * 10, villain: depth * 10, short: 500 },
      isPko: false,
      isBounty: false,
      isMysteryBounty: false,
      mysteryBountyStage: 'none',
      bountyFactor: 0,
      bountyByUser: {},
      mysteryMeanCents: 0,
      meanBountyCents: 0,
      prizePoolCents: 10000,
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
    },
  };
  return { gs, hero, input };
}
describe('Phase 8 bounded future-game facts', () => {
  it('prices an approaching blind at both known levels without inventing hand duration or table breaks', () => {
    const { gs, hero } = scenario();
    const projected = projectTournamentFutureGame(hero, gs, 1000);
    expect(projected.available).toBe(true);
    expect(projected.currentOrbitCost).toBe(15);
    expect(projected.nextOrbitCost).toBe(30);
    expect(projected.minimumRetainedStack).toBeLessThanOrEqual(projected.maximumRetainedStack!);
    expect(projected.tableBreak).toBe('unavailable');
    expect(projected.resolvesPostflopContinuation).toBe(false);
    expect(projected.transitions).toBe(4);
    const moved = projectTournamentFutureGame(hero, { ...gs, dealerSeat: 1 }, 1000);
    expect(moved.handsUntilBigBlind).not.toBe(projected.handsUntilBigBlind);
  });
  it.each(['incomplete', 'stale', 'warming'] as const)(
    'retains unavailable %s context',
    (contextStatus) => {
      const { gs, hero } = scenario();
      gs.tournament!.contextStatus = contextStatus;
      expect(projectTournamentFutureGame(hero, gs, 0).available).toBe(false);
    }
  );
  it('rejects private-position and numeric holes', () => {
    const { gs, hero } = scenario();
    expect(
      projectTournamentFutureGame(hero, { ...gs, dealerSeat: undefined }, 0).unavailableReason
    ).toBe('position_unavailable');
    expect(projectTournamentFutureGame(hero, gs, NaN).available).toBe(false);
    expect(projectTournamentFutureGame(hero, gs, hero.stack + 1).available).toBe(false);
  });
});
describe('Phase 8 continuation policy', () => {
  it('never prices a short-stack response using a side pot that player cannot win', () => {
    const players = [
      seat('hero', 1, 10, 10),
      seat('villain', 2, 100, 1000),
      seat('allin', 3, 0, 1000),
    ];
    const ok = simulateTournamentContinuation(
      players,
      {
        heroId: 'hero',
        dealerSeat: 3,
        bigBlind: 10,
        currentStreet: 'turn',
        heroChecked: false,
        opponentIds: ['villain', 'allin'],
        sampleIndex: 1,
        streets: [{ street: 'river', heroStrength: 0.01, opponentStrength: [0.9, 0.9] }],
      },
      (p, n) => {
        const amount = Math.min(p.stack, n);
        p.stack -= amount;
        p.bet += amount;
        p.totalInvested += amount;
        p.is_all_in = p.stack === 0;
      }
    );
    expect(ok).toBe(true);
    expect(players[0].is_folded).toBe(true);
    expect(players[0].stack).toBe(10);
  });
  it('models value from own contact, including strong pairs, two pair and sets', () => {
    expect(continuationStrength(1, 1)).toBeLessThan(CONTINUATION_POLICY.valueStrength);
    expect(continuationStrength(2, 1)).toBeGreaterThanOrEqual(CONTINUATION_POLICY.valueStrength);
    expect(continuationStrength(3, 0.1)).toBeGreaterThanOrEqual(CONTINUATION_POLICY.valueStrength);
    expect(continuationStrength(4, 0.1)).toBeGreaterThan(continuationStrength(3, 0.1));
    expect(Number.isNaN(continuationStrength(2, NaN))).toBe(true);
  });
  it.each([0.599, 0.6, 0.601])('respects its stated value-policy boundary at %s', (strength) => {
    const players = [seat('hero', 1, 100), seat('villain', 2, 100)];
    const chipsBefore = players.reduce((s, p) => s + p.stack + p.totalInvested, 0);
    const ok = simulateTournamentContinuation(
      players,
      {
        heroId: 'hero',
        dealerSeat: 2,
        bigBlind: 10,
        currentStreet: 'turn',
        heroChecked: false,
        opponentIds: ['villain'],
        sampleIndex: 0,
        streets: [{ street: 'river', heroStrength: strength, opponentStrength: [0.1] }],
      },
      (p, n) => {
        const amount = Math.min(p.stack, n);
        p.stack -= amount;
        p.bet += amount;
        p.totalInvested += amount;
        p.is_all_in = p.stack === 0;
      }
    );
    expect(ok).toBe(true);
    expect(players[0].totalInvested > 0).toBe(strength >= CONTINUATION_POLICY.valueStrength);
    expect(players.reduce((s, p) => s + p.stack + p.totalInvested, 0)).toBe(chipsBefore);
  });
  it('captured current-street strength never changes with a sampled future card', () => {
    const hero = [card('A', 'clubs'), card('A', 'diamonds')];
    const board = [card('3', 'clubs'), card('5', 'spades'), card('J', 'diamonds')];
    const samples: {
      maxSamples: number;
      captureContinuation: boolean;
      samples: import('./HorseEval.js').HorseEquityOutcomeSample[];
    } = { maxSamples: 32, captureContinuation: true, samples: [] };
    seedFastRandom(123);
    simulateEquity(
      hero,
      board,
      2,
      variantInfo('nlh'),
      64,
      undefined,
      false,
      undefined,
      undefined,
      samples
    );
    expect(samples.samples.length).toBeGreaterThan(0);
    expect(new Set(samples.samples.map((s) => s.continuationStreets?.[0].heroStrength)).size).toBe(
      1
    );
    expect(samples.samples.every((s) => s.continuationStreets?.length === 3)).toBe(true);
  });
});
describe('Phase 8 counterfactual selection', () => {
  it.each(['mtt', 'sng', 'spin', 'satellite', 'pko', 'mystery'] as const)(
    'reconciles %s continuation without double-counting chip or bounty utility',
    (format) => {
      const { gs, hero, input } = scenario();
      if (format === 'sng' || format === 'spin') input.context.format = format;
      if (format === 'satellite')
        Object.assign(input.context, { satellite: true, satelliteSeats: 2, payoutPct: [50, 50] });
      if (format === 'pko' || format === 'mystery')
        Object.assign(input.context, {
          isPko: format === 'pko',
          isBounty: format === 'pko',
          isMysteryBounty: format === 'mystery',
          mysteryBountyStage: format === 'mystery' ? 'active' : 'none',
          mysteryMeanCents: format === 'mystery' ? 1000 : 0,
          meanBountyCents: 1000,
          bountyFactor: 0.5,
          bountyByUser: { hero: 1000, villain: 1000, short: 1000 },
          prizePoolCents: 5000,
          bountyPoolCents: 5000,
        });
      const previous = evaluateTournamentUtilityDetailed(input);
      expect(previous.result).not.toBeNull();
      const baseline = { ...previous.result!.decision, tournamentUtility: previous.result!.ledger };
      const result = evaluateTournamentPostflop(
        hero,
        gs,
        baseline,
        input,
        'shadow',
        () => 0,
        previous.continuePostflop
      );
      expect(result.ledger.fired).toBe(true);
      for (const c of result.ledger.after) {
        expect(c.combinedUtility).toBeCloseTo(c.payoutEv + c.bountyEv + c.optionEv, 9);
        expect(c.stackConservationError).toBeLessThanOrEqual(0.005);
        if (format === 'satellite') expect(c.bountyEv).toBe(0);
      }
    }
  );
  it('refuses unknown active mystery values and mixed satellite objectives', () => {
    const { gs, hero, input } = scenario();
    const previous = evaluateTournamentUtility(input)!;
    const baseline = { ...previous.decision, tournamentUtility: previous.ledger };
    input.context.isMysteryBounty = true;
    input.context.mysteryBountyStage = 'active';
    input.context.mysteryMeanCents = 0;
    expect(
      evaluateTournamentPostflop(hero, gs, baseline, input, 'candidate', () => 0).ledger.reason
    ).toBe('mystery_value_unavailable');
    input.context.satellite = true;
    expect(
      evaluateTournamentPostflop(hero, gs, baseline, input, 'candidate', () => 0).ledger.reason
    ).toBe('objective_conflict');
  });
  it.each([199, 200, 201, 600])('tests the deep-stack boundary at %s big blinds', (depth) => {
    const { hero, gs } = scenario();
    hero.stack = depth * gs.bigBlind - hero.totalInvested;
    expect(deepOnePairCommitment(hero, gs, depth * gs.bigBlind * 0.25)).toBe(depth >= 200);
  });
  it.each([0.2499, 0.25, 0.2501])('tests the additional-investment boundary at %s', (fraction) => {
    const { hero, gs } = scenario();
    expect(deepOnePairCommitment(hero, gs, (hero.stack + hero.totalInvested) * fraction)).toBe(
      fraction >= 0.25
    );
  });
  it.each([1499, 1500, 1501])(
    'counts only matched additional risk at the deep-commitment boundary of %s chips',
    (risk) => {
      const { hero, gs } = scenario();
      const villain = gs.players.find((p) => p.user_id === 'villain')!;
      villain.stack = 0;
      villain.totalInvested = hero.totalInvested + risk;
      villain.bet = villain.totalInvested;
      villain.is_all_in = true;
      // A 590-BB nominal overjam cannot put the returned excess at risk.
      expect(deepOnePairCommitment(hero, gs, hero.stack)).toBe(risk >= 1500);
    }
  );
  it('does not cap a deep overjam when every live opponent can match only a short stack', () => {
    const { hero, gs } = scenario();
    const villain = gs.players.find((p) => p.user_id === 'villain')!;
    villain.stack = 0;
    villain.bet = villain.totalInvested = 500;
    villain.is_all_in = true;
    expect(deepOnePairCommitment(hero, gs, hero.stack)).toBe(false);
  });
  it('ignores pressure from opponents who have since folded or sat out', () => {
    const { hero, gs } = scenario();
    const villain = gs.players.find((p) => p.user_id === 'villain')!;
    const short = gs.players.find((p) => p.user_id === 'short')!;
    short.stack = hero.stack + hero.totalInvested;
    villain.is_folded = true;
    expect(deepOnePairCommitment(hero, gs, hero.stack)).toBe(false);
    villain.is_folded = false;
    villain.is_sitting_out = true;
    expect(deepOnePairCommitment(hero, gs, hero.stack)).toBe(false);
    villain.is_sitting_out = false;
    expect(deepOnePairCommitment(hero, gs, hero.stack)).toBe(true);
  });
  it.each(['A', 'K', 'Q', 'J'] as const)('does not cap a set of %s', (rank) => {
    const { hero, gs } = scenario();
    hero.cards = [card(rank, 'clubs'), card(rank, 'diamonds')];
    gs.communityCards = [
      card(rank, 'hearts'),
      card('3', 'spades'),
      card('7', 'clubs'),
      card('9', 'hearts'),
    ];
    expect(deepOnePairCommitment(hero, gs, hero.stack)).toBe(false);
  });
  it('requires a real nut-flush blocker on the public texture', () => {
    const { hero, gs } = scenario();
    gs.communityCards = [
      card('3', 'clubs'),
      card('7', 'clubs'),
      card('9', 'clubs'),
      card('J', 'hearts'),
    ];
    expect(hasTournamentNutBlocker(hero, gs)).toBe(true);
    hero.cards = [card('A', 'hearts'), card('A', 'diamonds')];
    expect(hasTournamentNutBlocker(hero, gs)).toBe(false);
  });
  it('retains shadow baseline and produces a deterministic legal candidate with conserved stacks', () => {
    const { gs, hero, input } = scenario();
    const previous = evaluateTournamentUtility(input);
    expect(previous).not.toBeNull();
    const baseline = { ...previous!.decision, tournamentUtility: previous!.ledger };
    const a = evaluateTournamentPostflop(hero, gs, baseline, input, 'shadow', () => 0);
    const b = evaluateTournamentPostflop(hero, gs, baseline, input, 'shadow', () => 0);
    expect(a).toEqual(b);
    expect(a.decision).toBe(baseline);
    expect(gs.legalActions).toContain(a.ledger.candidateAction);
    expect(a.ledger.applied).toBe(false);
    expect(a.ledger.fired).toBe(true);
    expect(a.ledger.after.length).toBeGreaterThan(1);
    expect(a.ledger.after.every((c) => c.stackConservationError <= 0.005)).toBe(true);
    expect(
      a.ledger.after.every(
        (c) =>
          c.continuation &&
          c.continuation.expectedRetainedStackBb >= 0 &&
          c.continuation.shortStackCollisionProbability >= 0 &&
          c.continuation.shortStackCollisionProbability <= 1
      )
    ).toBe(true);
  });
  it.each([3, 18, 200, 1000])(
    'reuses the ICM workspace without changing %i-player candidate utilities',
    (count) => {
      const { gs, hero, input } = scenario();
      const remote = Array.from({ length: count - 3 }, (_, i) => 5000 + i * 10);
      input.context.fieldStacks.push(...remote);
      input.context.playersLeft = count;
      gs.tournament!.stacks!.push(...remote);
      gs.tournament!.playersLeft = count;
      const previous = evaluateTournamentUtilityDetailed(input);
      const baseline = { ...previous.result!.decision, tournamentUtility: previous.result!.ledger };
      const fresh = evaluateTournamentPostflop(hero, gs, baseline, input, 'shadow', () => 0);
      const shared = evaluateTournamentPostflop(
        hero,
        gs,
        baseline,
        input,
        'shadow',
        () => 0,
        previous.continuePostflop
      );
      expect(fresh.ledger.fired).toBe(true);
      expect(shared).toEqual(fresh);
      expect(JSON.stringify(shared.ledger)).not.toContain('continuePostflop');
      expect(JSON.stringify(shared.ledger)).not.toContain('vectorKey');
    }
  );
  it.each([false, true])(
    'starts no ICM work after a future hand consumes the deadline (shared workspace: %s)',
    (reuse) => {
      const { gs, hero, input } = scenario();
      let deadlinePassed = false;
      let lateEstimates = 0;
      const originalEstimator = IcmModel.createIcmEquityEstimator;
      const originalFuture = FutureHand.simulateTournamentFutureHands;
      const estimator = vi
        .spyOn(IcmModel, 'createIcmEquityEstimator')
        .mockImplementation((...args) => {
          const value = originalEstimator(...args);
          return {
            ...value,
            estimate: (...estimateArgs) => {
              if (deadlinePassed) lateEstimates++;
              return value.estimate(...estimateArgs);
            },
          };
        });
      const future = vi
        .spyOn(FutureHand, 'simulateTournamentFutureHands')
        .mockImplementation((args) => {
          const result = originalFuture(args);
          if (result) deadlinePassed = true;
          return result;
        });
      try {
        const previous = evaluateTournamentUtilityDetailed(input);
        expect(previous.result).not.toBeNull();
        const baseline = {
          ...previous.result!.decision,
          tournamentUtility: previous.result!.ledger,
        };
        const result = evaluateTournamentPostflop(
          hero,
          gs,
          baseline,
          input,
          'shadow',
          () => (deadlinePassed ? PHASE8_POLICY.workBudgetMs + 0.1 : 0),
          reuse ? previous.continuePostflop : undefined
        );
        expect(deadlinePassed).toBe(true);
        expect(result.decision).toBe(baseline);
        expect(result.ledger.reason).toBe('continuation_operation_budget');
        expect(result.ledger.fired).toBe(false);
        expect(lateEstimates).toBe(0);
      } finally {
        future.mockRestore();
        estimator.mockRestore();
      }
    }
  );
  it.each([5, 200, 1000])(
    'refuses a conserved remote-field swap in a %i-player forecast',
    (count) => {
      const { gs, hero, input } = scenario();
      const remote = Array.from({ length: count - 3 }, (_, i) => 100 + i * 100);
      input.context.fieldStacks.push(...remote);
      input.context.playersLeft = count;
      gs.tournament!.stacks!.push(...remote);
      gs.tournament!.playersLeft = count;
      const previous = evaluateTournamentUtilityDetailed(input);
      expect(previous.result).not.toBeNull();
      const baseline = { ...previous.result!.decision, tournamentUtility: previous.result!.ledger };
      const original = FutureHand.simulateTournamentFutureHands;
      const future = vi
        .spyOn(FutureHand, 'simulateTournamentFutureHands')
        .mockImplementation((args) => {
          const result = original(args);
          if (result) {
            const local = new Set(args.localIndex.values());
            const remote = result.vector.map((_, i) => i).filter((i) => !local.has(i));
            result.vector[remote[0]] += 1;
            result.vector[remote[1]] -= 1;
          }
          return result;
        });
      try {
        const out = evaluateTournamentPostflop(
          hero,
          gs,
          baseline,
          input,
          'shadow',
          () => 0,
          previous.continuePostflop
        );
        expect(out.ledger.reason).toBe('continuation_numerical_error');
        expect(out.ledger.fired).toBe(false);
        expect(out.decision).toBe(baseline);
      } finally {
        future.mockRestore();
      }
    }
  );
  it('refuses a budget breach and a private-card boundary violation', () => {
    const { gs, hero, input } = scenario();
    const previous = evaluateTournamentUtility(input)!;
    const baseline = { ...previous.decision, tournamentUtility: previous.ledger };
    let clock = 0;
    const result = evaluateTournamentPostflop(
      hero,
      gs,
      baseline,
      input,
      'candidate',
      () => (clock += PHASE8_POLICY.budgetMs + 1)
    );
    expect(result.ledger.reason).toBe('budget_exhausted');
    expect(result.decision).toBe(baseline);
    gs.players[1].cards = [card('K', 'clubs'), card('K', 'diamonds')];
    expect(
      evaluateTournamentPostflop(hero, gs, baseline, input, 'candidate', () => 0).ledger.reason
    ).toBe('private_state_rejected');
  });
  it.each(['multiple_boards', 'context_incomplete'] as const)(
    'retains the baseline for %s',
    (reason) => {
      const { gs, hero, input } = scenario();
      const previous = evaluateTournamentUtility(input)!;
      const baseline = { ...previous.decision, tournamentUtility: previous.ledger };
      if (reason === 'multiple_boards') gs.boardCount = 2;
      else gs.tournament!.contextStatus = 'stale';
      const result = evaluateTournamentPostflop(hero, gs, baseline, input, 'candidate', () => 0);
      expect(result.ledger.reason).toBe(reason);
      expect(result.decision).toBe(baseline);
      expect(result.ledger.continuationRetained).toBe(true);
    }
  );
  it('automatically disables repeated overruns, silence and critical increases without activating after restart', () => {
    const { gs, hero, input } = scenario();
    const previous = evaluateTournamentUtility(input)!;
    const baseline = { ...previous.decision, tournamentUtility: previous.ledger };
    const ledger = evaluateTournamentPostflop(hero, gs, baseline, input, 'shadow', () => 0).ledger;
    const safety = new HorsePhase8Safety();
    safety.observe({ ...ledger, reason: 'budget_exhausted' });
    safety.observe({ ...ledger, reason: 'budget_exhausted' });
    expect(safety.disabledReason).toBeNull();
    safety.observe({ ...ledger, reason: 'continuation_operation_budget' });
    expect(safety.disabledReason).toBeNull();
    for (let n = 0; n < 3; n++) safety.observe({ ...ledger, reason: 'budget_exhausted' });
    expect(safety.disabledReason).toBe('repeated_budget_breach');
    const silent = new HorsePhase8Safety();
    for (let n = 0; n < 31; n++) silent.observe({ ...ledger, eligible: true, fired: false });
    expect(silent.disabledReason).toBeNull();
    silent.observe({ ...ledger, eligible: true, fired: false });
    expect(silent.disabledReason).toBe('eligible_but_silent');
    const critical = new HorsePhase8Safety();
    critical.observe({
      ...ledger,
      applied: true,
      changed: true,
      baselineCriticalCommitment: false,
      candidateCriticalCommitment: true,
    });
    expect(critical.disabledReason).toBe('critical_commitment_increase');
    expect(new HorsePhase8Safety().disabledReason).toBeNull();
    expect(PHASE8_POLICY.defaultMode).toBe('shadow');
  });
});

// Audit F6: blind pressure must reach action utility, not only a descriptive projection.
describe('Phase 8 funded next-hand utility', () => {
  it('changes candidate utility for funded blind-level transitions and records timing uncertainty', () => {
    const { gs, hero, input } = scenario();
    const previous = evaluateTournamentUtilityDetailed(input);
    const baseline = { ...previous.result!.decision, tournamentUtility: previous.result!.ledger };
    const evaluate = () =>
      evaluateTournamentPostflop(
        hero,
        gs,
        baseline,
        input,
        'shadow',
        () => 0,
        previous.continuePostflop
      ).ledger;
    const normal = evaluate();
    gs.tournament!.nextSmallBlind = 100;
    gs.tournament!.nextBigBlind = 200;
    const pressure = evaluate();
    expect(normal.fired).toBe(true);
    expect(pressure.fired).toBe(true);
    expect(
      pressure.after.some((c, i) => c.combinedUtility !== normal.after[i].combinedUtility)
    ).toBe(true);
    expect(pressure.after.some((c) => (c.continuation?.futureLevelUtilityEnvelope ?? 0) > 0)).toBe(
      true
    );
    expect(pressure.after.some((c) => (c.continuation?.futureHands ?? 0) > 0)).toBe(true);
    gs.tournament!.nextBlindInMin = 0;
    expect(evaluate().after.every((c) => c.continuation?.futureLevelUtilityEnvelope === 0)).toBe(
      true
    );
  });
});
