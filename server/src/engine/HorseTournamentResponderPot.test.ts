import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SeatPlayer } from '../types.js';
import * as evEngine from './HorseEvEngine.js';
import { calculatePots } from './PokerEngine.js';
import {
  evaluateTournamentUtilityDetailed,
  type TournamentUtilityInput,
} from './HorseTournamentUtility.js';

afterEach(() => vi.restoreAllMocks());

function fixture(deepContribution: number): TournamentUtilityInput {
  const seat = (id: string, n: number, stack: number, invested: number): SeatPlayer => ({
    user_id: id,
    username: id,
    seat: n,
    stack,
    totalInvested: invested,
    bet: 0,
    cards: [],
    is_folded: false,
    is_sitting_out: false,
    is_all_in: stack === 0,
  });
  const hero = seat('hero', 1, 100, deepContribution);
  const short = seat('short', 2, 10, 10);
  const allIn = { ...seat('all-in', 3, 0, deepContribution), bet: 10 };
  const folded = { ...seat('folded', 4, 100, deepContribution), is_folded: true };
  const players = [hero, short, allIn, folded];
  const fieldStacks = players.map((p) => p.stack + p.totalInvested);
  return {
    street: 'river',
    hero,
    players,
    pots: calculatePots(players),
    pot: deepContribution * 3 + 10,
    currentBet: 10,
    toCall: 10,
    legalActions: ['fold', 'call'],
    minRaiseTo: null,
    maxRaiseTo: null,
    bettingStructure: 'no_limit',
    baseline: { action: 'call', amount: 10, thinkTime: 0 },
    heroEquity: 1,
    equitySampleSize: 100,
    equityStandardError: 0,
    opponents: [
      { userId: short.user_id, range: null, foldMul: 1, actsAfterHero: true },
      { userId: allIn.user_id, range: null, foldMul: 1, actsAfterHero: false },
    ],
    sampledOpponentIds: [short.user_id, allIn.user_id],
    showdownSamples: Array.from({ length: 100 }, () => ({
      boards: [
        {
          heroHigh: 3,
          opponentHigh: [1, 2],
          opponentDecisionStrength: [0.5, 0.5],
          heroLow: null,
          opponentLow: [null, null],
        },
      ],
    })),
    context: {
      format: 'mtt',
      playersLeft: players.length,
      spotsPaid: 2,
      satellite: false,
      satelliteSeats: 0,
      payoutPct: [65, 35],
      fieldStacks,
      fieldStackByUser: Object.fromEntries(players.map((p, i) => [p.user_id, fieldStacks[i]])),
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
}

describe('Phase 7 short-responder pot eligibility', () => {
  it('prices the response against independently constructed reachable contributions', () => {
    const spy = vi.spyOn(evEngine, 'mdfFold');
    for (const deepContribution of [20, 100, 1000]) {
      spy.mockClear();
      const value = fixture(deepContribution);
      const result = evaluateTournamentUtilityDetailed(value);
      expect(result.unavailableReason).toBeNull();
      expect(result.result).not.toBeNull();
      // Short has 10 committed and can pay only 10 more. Each of the other
      // three seats contributes 20 to that contest, including the folded seat.
      // The 80-chip called pot includes short's unpaid 10, leaving 70 now.
      const independentContestable = 3 * 20 + 10;
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      for (const [potFacing, price] of spy.mock.calls) {
        expect(price).toBe(10);
        expect(potFacing).toBe(independentContestable);
      }
      expect(result.result!.ledger.candidates.every((c) => c.stackConservationError < 1e-8)).toBe(
        true
      );
    }
  });

  it('does not change the short response when only unreachable side pots grow', () => {
    const outcomes = [20, 1000].map((deepContribution) => {
      const result = evaluateTournamentUtilityDetailed(fixture(deepContribution));
      expect(result.unavailableReason).toBeNull();
      const call = result.result!.ledger.candidates.find((c) => c.action === 'call')!;
      // Hero wins every scored showdown. Remove the fixed pre-existing
      // deep-seat money to isolate the same short opponent's response EV.
      return call.chipEv - 3 * deepContribution;
    });
    expect(outcomes[0]).toBeCloseTo(outcomes[1], 8);
  });

  it('prices successive responders clockwise after hero, independent of the input array order', () => {
    const value = fixture(100);
    value.legalActions = ['raise'];
    value.minRaiseTo = value.maxRaiseTo = 20;
    value.baseline = { action: 'raise', amount: 20, thinkTime: 0 };
    const deep = value.players.find((p) => p.user_id === 'all-in')!;
    deep.stack = 100;
    deep.is_all_in = false;
    value.opponents[1].foldMul = 0.8;
    value.context.fieldStacks = value.players.map((p) => p.stack + p.totalInvested);
    value.context.fieldStackByUser = Object.fromEntries(
      value.players.map((p) => [p.user_id, p.stack + p.totalInvested])
    );
    const spy = vi.spyOn(evEngine, 'mdfFold');
    const run = () => {
      spy.mockClear();
      const result = evaluateTournamentUtilityDetailed(value);
      expect(result.unavailableReason).toBeNull();
      // Hero is seat 1: short seat 2 must respond before deep seat 3.
      // Distinct fold multipliers identify the unchanged actual read owner.
      expect(spy.mock.calls.slice(0, 2).map((args) => args[2])).toEqual([1, 0.8]);
      return result.result!.ledger.candidates[0].chipEv;
    };
    const expected = run();
    value.players = [value.players[2], value.players[0], value.players[3], value.players[1]];
    expect(run()).toBeCloseTo(expected, 8);
  });
});
