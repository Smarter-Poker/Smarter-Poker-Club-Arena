import { describe, expect, it } from 'vitest';
import {
  evaluateTournamentUtilityDetailed,
  type TournamentUtilityInput,
} from './HorseTournamentUtility.js';
import { simulateTournamentFutureHands } from './HorseTournamentFutureHand.js';
import { calculatePots } from './PokerEngine.js';
const player = (id: string, seat: number, stack: number, bet: number) => ({
  user_id: id,
  username: id,
  seat,
  stack,
  bet,
  totalInvested: bet,
  cards: [],
  is_folded: false,
  is_all_in: stack === 0,
  is_sitting_out: false,
});
const players = [
  player('hero', 1, 400, 100),
  player('villain', 2, 1800, 200),
  player('short', 3, 0, 100),
];
const level = { smallBlind: 500, bigBlind: 1000, ante: 0, anteType: 'none' as const };
const input: TournamentUtilityInput = {
  street: 'river',
  hero: players[0],
  players,
  pots: calculatePots(players),
  pot: 400,
  currentBet: 200,
  toCall: 100,
  legalActions: ['fold', 'call'],
  minRaiseTo: null,
  maxRaiseTo: null,
  bettingStructure: 'no_limit',
  baseline: { action: 'call', amount: 100, thinkTime: 0 },
  heroEquity: 1,
  equitySampleSize: 1000,
  equityStandardError: 0,
  opponents: [
    { userId: 'villain', range: [0.12, 0.44], foldMul: 1, actsAfterHero: false },
    { userId: 'short', range: [0.05, 0.35], foldMul: 1, actsAfterHero: false },
  ],
  sampledOpponentIds: ['villain', 'short'],
  showdownSamples: Array.from({ length: 32 }, () => ({
    boards: [
      {
        heroHigh: 3,
        opponentHigh: [2, 1],
        opponentDecisionStrength: [0.5, 0.5],
        heroLow: null,
        opponentLow: [null, null],
        continuationStreets: [],
      },
    ],
  })),
  context: {
    format: 'mtt',
    playersLeft: 3,
    spotsPaid: 2,
    satellite: false,
    satelliteSeats: 0,
    payoutPct: [65, 35],
    fieldStacks: [500, 2000, 100],
    fieldStackByUser: { hero: 500, villain: 2000, short: 100 },
    isPko: true,
    isBounty: true,
    isMysteryBounty: false,
    mysteryBountyStage: 'none',
    bountyFactor: 0.5,
    bountyByUser: { hero: 10000, villain: 6000, short: 4000 },
    meanBountyCents: 6000,
    mysteryMeanCents: 0,
    prizePoolCents: 10000,
    bountyPoolCents: 20000,
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
  continuation: {
    dealerSeat: 3,
    bigBlind: 10,
    futureHands: { levels: [level], nextLevelDue: false },
  },
};

describe('Phase 8 PKO head growth across the current and next hand', () => {
  it.each([
    [400, 1800],
    [4000, 800],
  ])('carries heads after hero or opponent knockouts (%s/%s stacks)', (heroStack, villainStack) => {
    const request = structuredClone(input);
    request.hero = request.players[0];
    request.hero.stack = heroStack;
    request.players[1].stack = villainStack;
    request.context.fieldStacks = [heroStack + 100, villainStack + 200, 100];
    request.context.fieldStackByUser = {
      hero: heroStack + 100,
      villain: villainStack + 200,
      short: 100,
    };
    const evaluated = evaluateTournamentUtilityDetailed(request);
    expect(evaluated.unavailableReason).toBeNull();
    let growthAffectedCases = 0;
    for (const action of ['call', 'fold'] as const) {
      // Hero wins the current hand after calling; villain wins after a fold.
      // The short player's 4000 head pays 2000 now and adds 2000 to the
      // winner's head. Retained growth is not an immediate prize.
      const heroAfter = heroStack + (action === 'call' ? 400 : 0);
      const villainAfter = villainStack + (action === 'fold' ? 400 : 0);
      let cents = 0;
      for (let sampleIndex = 0; sampleIndex < 32; sampleIndex++) {
        const future = simulateTournamentFutureHands({
          players: request.players,
          vector: [heroAfter, villainAfter, 0],
          localIndex: new Map([
            ['hero', 0],
            ['villain', 1],
            ['short', 2],
          ]),
          heroId: 'hero',
          dealerSeat: 3,
          level,
          sampleIndex,
        })!;
        expect(future).not.toBeNull();
        const heroBust = future.eliminations.some((e) => e.userId === 'hero');
        const villainBust = future.eliminations.some(
          (e) => e.userId === 'villain' && e.claimants.includes('hero')
        );
        if ((action === 'call' && heroBust) || (action === 'fold' && villainBust))
          growthAffectedCases++;
        cents +=
          (action === 'call' ? 2000 : 0) +
          Number(villainBust) * (action === 'fold' ? 4000 : 3000) -
          Number(heroBust) * (action === 'call' ? 6000 : 5000);
      }
      const ledger = evaluated.result!.ledger.candidates.find((c) => c.id === action)!;
      expect(ledger.continuation?.futureHands).toBeCloseTo(1, 10);
      expect(ledger.bountyEv).toBeCloseTo((cents / 32 / 30000) * 100, 10);
    }
    expect(growthAffectedCases).toBeGreaterThan(0);
    const phase7 = evaluateTournamentUtilityDetailed({ ...request, continuation: undefined });
    expect(phase7.result!.ledger.candidates.find((c) => c.id === 'call')!.bountyEv).toBeCloseTo(
      (2000 / 30000) * 100,
      10
    );
  });
});
