import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Card } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { evidenceDigest } from './authority.js';
import {
  priceClosedHeadsUpTournamentLadderRiver,
  type ClosedHeadsUpTournamentRiverInput,
} from './closedHeadsUpTournamentRiverReference.js';

const cards = (text: string): Card[] =>
  text.split(' ').map(
    (c) =>
      ({
        rank: c[0],
        suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[c[1] as 's'],
      }) as Card
  );

/** Synthetic original observation interval, using the real canonical prize
 * capture helper. No signing authority or live-source certification claimed. */
function fixture(
  format: 'mtt' | 'sng' | 'hu_sng' = 'mtt',
  payouts = [50, 30, 20],
  poolCents = 10000
): ClosedHeadsUpTournamentRiverInput {
  const hero = {
    user_id: 'hero',
    username: 'Hero',
    seat: 1,
    stack: 80,
    bet: 10,
    totalInvested: 20,
    cards: cards('As Ah'),
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const villain = {
    ...hero,
    user_id: 'villain',
    seat: 2,
    stack: 0,
    bet: 30,
    totalInvested: 40,
    cards: [] as Card[],
    is_all_in: true,
  };
  const entrants = format === 'hu_sng' ? 2 : Math.max(3, payouts.length);
  const t = {
    schemaVersion: 1,
    contextStatus: 'complete',
    contextIssues: [],
    sourceAgeMs: 0,
    tournamentId: 'event',
    tournamentType: format === 'mtt' ? 'MTT' : 'SNG',
    tournamentStatus: 'RUNNING',
    gameVariant: 'nlh',
    entrants,
    playersLeft: 2,
    playersAtTable: 2,
    spotsPaid: payouts.filter((p) => p > 0).length,
    payoutPct: payouts,
    registrationOpen: false,
    lateRegistrationOpen: false,
    reentryAllowed: false,
    reentryOpen: false,
    rebuyAllowed: false,
    rebuyOpen: false,
    addOnAvailable: false,
    addOnPeriodOpen: false,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    satellite: false,
    bountyPoolCents: 0,
    onBreak: false,
    currentSmallBlind: 1,
    currentBigBlind: 2,
    currentAnte: 0,
    prizePoolCents: poolCents,
    stackByUser: { hero: 100, villain: 40 },
    stacks: [100, 40],
    ...captureHorseTournamentPayoutTerms(
      {
        id: 'event',
        prize_pool_finalized: true,
        bubble_protection: false,
        payout_club: { asset: 'chips', is_platform: false, union_id: null },
        prize_pool: poolCents / 100,
        buy_in_amount: 10,
        is_bounty: false,
        is_pko: false,
        is_mystery_bounty: false,
      },
      payouts.map((percentage, i) => ({ place: i + 1, percentage })),
      entrants,
      false
    ),
  };
  const source = {
    version: 1,
    tournamentId: 'event',
    cacheId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
    readStartedAtMs: 90,
    readCompletedAtMs: 100,
    contextDigest: createHash('sha256').update(JSON.stringify(t)).digest('hex'),
    contextStatus: 'complete',
    contextIssues: [],
  };
  const tournament = {
    ...t,
    contextProvenance: {
      version: 1,
      readAtMs: 100,
      status: 'complete',
      issues: [],
      ageMs: 0,
      source,
      projection: {
        tableId: 'table',
        handNumber: 1,
        actorId: 'hero',
        actorSeat: 1,
        dealerSeat: 2,
        dealtSeatIds: [1, 2],
        smallBlind: 1,
        bigBlind: 2,
        ante: 0,
        gameVariant: 'nlh',
      },
    },
  };
  return {
    version: 'horse-closed-hu-ladder-river-reference-v1',
    original: {
      readFrame: { publicReads: [] },
      snapshot: {
        type: 'DECIDE_FAST',
        requestId: 1,
        generation: 1,
        fence: 'table:1:1:river',
        decisionTimeMs: 100,
        decisionKey: 'test',
        player: hero,
        gameState: {
          stateSchemaVersion: 1,
          gameVariant: 'nlh',
          format,
          gameMode: 'tournament',
          stage: 'river',
          bettingStructure: 'no_limit',
          asset: 'chips',
          chipUnit: 1,
          ante: 0,
          bigBlind: 2,
          dealerSeat: 2,
          heroSeat: 1,
          currentPlayerSeat: 1,
          players: [{ ...hero, cards: [] }, villain],
          dealtSeatIds: [1, 2],
          pot: 60,
          currentBet: 30,
          toCall: 20,
          legalActions: ['fold', 'call'],
          communityCards: cards('2c 4d 7h 9s Jc'),
          tournament,
        },
      } as unknown as ClosedHeadsUpTournamentRiverInput['original']['snapshot'],
    },
    range: [{ cards: cards('Ks Kh'), weight: 1 }],
    rangeReadFrameDigest: evidenceDigest({ publicReads: [] }),
  };
}

describe('closed HU tournament ladder ICM reference', () => {
  it('uses exact canonical 50/50 odd-cent awards without re-rounding', () => {
    const i = fixture('hu_sng', [50, 50], 10001);
    expect(i.original.snapshot.gameState.tournament!.finalizedPrizeLadder!.prizesCents).toEqual([
      5001, 5000,
    ]);
    const r = priceClosedHeadsUpTournamentLadderRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.fold.expectedPrizeShare).toBeCloseTo((4 * 5001 + 3 * 5000) / (7 * 10001), 12);
    expect(r.call.expectedPrizeShare).toBe(5001 / 10001);
  });
  it('accepts the real equal-quarter last-place residual even when that tail increases', () => {
    const i = fixture('mtt', [25, 25, 25, 25], 10001);
    expect(i.original.snapshot.gameState.tournament!.finalizedPrizeLadder!.prizesCents).toEqual([
      2500, 2500, 2500, 2501,
    ]);
    const r = priceClosedHeadsUpTournamentLadderRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.prizesCents).toEqual([2500, 2500, 2500, 2501]);
    expect(r.fold.expectedPrizeShare).toBe(2500 / 10001);
    expect(r.call.expectedPrizeShare).toBe(2500 / 10001);
  });
  it('prices an actual canonical ladder with second prize larger than first', () => {
    const i = fixture('hu_sng', [49.99, 50.01], 10001);
    expect(i.original.snapshot.gameState.tournament!.finalizedPrizeLadder!.prizesCents).toEqual([
      4999, 5002,
    ]);
    const r = priceClosedHeadsUpTournamentLadderRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.fold.expectedPrizeShare).toBeCloseTo((4 * 4999 + 3 * 5002) / (7 * 10001), 12);
    expect(r.call.expectedPrizeShare).toBe(4999 / 10001);
  });
  it.each(['mtt', 'sng'] as const)(
    'prices actual %s original capture with retained paid-third-place mass',
    (format) => {
      const input = fixture(format),
        before = structuredClone(input),
        r = priceClosedHeadsUpTournamentLadderRiver(input);
      expect(r.status).toBe('priced');
      if (r.status !== 'priced') throw new Error(r.reason);
      expect(r).toMatchObject({
        objective: 'closed_hu_ladder_icm_prize_share_v1',
        utilityUnit: 'prize_share',
        qualified: false,
        activationAllowed: false,
        prizePoolCents: 10000,
        prizesCents: [5000, 3000, 2000],
      });
      // Independent finishing-order oracle: folding leaves hero80/villain60.
      // Hero finishes first with probability4/7, second3/7. Prize shares .5/.3
      // are fractions of the ORIGINAL10000 pool, including the paid2000 tail.
      expect(r.fold.stacks).toEqual([80, 60]);
      expect(r.fold.expectedPrizeShare).toBeCloseTo((4 * 0.5 + 3 * 0.3) / 7, 12);
      expect(r.call.outcomes[0]).toMatchObject({
        result: 'win',
        stacks: [140, 0],
        expectedPrizeShare: 0.5,
      });
      expect(r.call.expectedPrizeShare).toBe(0.5);
      expect(r.call.expectedPrizeShare).not.toBe(0.625); // no P1/(P1+P2) renormalization
      expect(input).toEqual(before);
    }
  );
  it('prices a closed HU SNG using its original two-place ladder', () => {
    const r = priceClosedHeadsUpTournamentLadderRiver(fixture('hu_sng', [60, 40]));
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.fold.expectedPrizeShare).toBeCloseTo((4 * 0.6 + 3 * 0.4) / 7, 12);
    expect(r.call.expectedPrizeShare).toBe(0.6);
  });
  it('prices a losing call using positive second-place ICM utility, not zero or raw chips', () => {
    const i = fixture();
    i.range = [{ cards: cards('Js Jh'), weight: 1 }];
    const r = priceClosedHeadsUpTournamentLadderRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.call.outcomes[0]).toMatchObject({
      result: 'loss',
      stacks: [60, 80],
    });
    // Herofirst3/7 and second4/7, so .3 survival floor remains material.
    expect(r.call.expectedPrizeShare).toBeCloseTo((3 * 0.5 + 4 * 0.3) / 7, 12);
    expect(r.call.expectedPrizeShare).not.toBeCloseTo(3 / 7, 6);
  });
  it('settles a tie and all candidate vectors conserve exactly140 tournament chips', () => {
    const i = fixture();
    i.original.snapshot.gameState.communityCards = cards('Tc Jc Qc Kc Ac');
    const r = priceClosedHeadsUpTournamentLadderRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.call.outcomes[0]).toMatchObject({
      result: 'tie',
      stacks: [100, 40],
    });
    expect(r.call.expectedPrizeShare).toBeCloseTo((5 * 0.5 + 2 * 0.3) / 7, 12);
    expect(r.fold.stacks.reduce((a, b) => a + b, 0)).toBe(140);
    expect(r.call.outcomes.every((o) => o.stacks.reduce((a, b) => a + b, 0) === 140)).toBe(true);
  });
  it('weights independent declared finishing-order outcomes without observing actual opponent cards', () => {
    const i = fixture();
    i.range = [
      { cards: cards('Js Jh'), weight: 3 },
      { cards: cards('Ks Kh'), weight: 1 },
    ];
    const r = priceClosedHeadsUpTournamentLadderRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.call.expectedPrizeShare).toBeCloseTo((3 * ((3 * 0.5 + 4 * 0.3) / 7) + 0.5) / 4, 12);
    expect(r.call.outcomes.map((o) => o.stacks)).toEqual([
      [60, 80],
      [140, 0],
    ]);
  });
  it('retains original exact zero tails and original source terms in output/digests', () => {
    const i = fixture('mtt', [50, 30, 20, 0]),
      r = priceClosedHeadsUpTournamentLadderRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.prizesCents).toEqual([5000, 3000, 2000, 0]);
    expect(r.inputDigest).toBe(evidenceDigest(i.original.snapshot));
    expect(r.tournamentContextDigest).toBe(
      evidenceDigest(i.original.snapshot.gameState.tournament)
    );
    const t = i.original.snapshot.gameState.tournament!;
    const { contextProvenance, ...capturedContext } = t;
    expect(contextProvenance!.source!.contextDigest).toBe(
      createHash('sha256').update(JSON.stringify(capturedContext)).digest('hex')
    );
  });
  it('accepts an explicit WTA MTT ladder within the distinct declared objective', () => {
    const r = priceClosedHeadsUpTournamentLadderRiver(fixture('mtt', [100]));
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.objective).toBe('closed_hu_ladder_icm_prize_share_v1');
    expect(r.fold.expectedPrizeShare).toBeCloseTo(4 / 7, 12);
  });
  it.each([
    ['Spin domain', (i: any) => (i.original.snapshot.gameState.format = 'spin')],
    ['cash domain', (i: any) => (i.original.snapshot.gameState.gameMode = 'cash')],
    ['nonNLH', (i: any) => (i.original.snapshot.gameState.gameVariant = 'plo4')],
    [
      'missing legacy ladder',
      (i: any) => delete i.original.snapshot.gameState.tournament.finalizedPrizeLadder,
    ],
    [
      'unfinalized pool',
      (i: any) => (i.original.snapshot.gameState.tournament.prizePoolFinalized = false),
    ],
    [
      'bubble protection',
      (i: any) => (i.original.snapshot.gameState.tournament.bubbleProtection = true),
    ],
    ['satellite', (i: any) => (i.original.snapshot.gameState.tournament.satellite = true)],
    ['bounty', (i: any) => (i.original.snapshot.gameState.tournament.isPko = true)],
    ['recovery open', (i: any) => (i.original.snapshot.gameState.tournament.rebuyOpen = true)],
    ['entry open', (i: any) => (i.original.snapshot.gameState.tournament.registrationOpen = true)],
    ['add-on open', (i: any) => (i.original.snapshot.gameState.tournament.addOnPeriodOpen = true)],
    [
      'third remaining player',
      (i: any) => (i.original.snapshot.gameState.tournament.playersLeft = 3),
    ],
    ['ante', (i: any) => (i.original.snapshot.gameState.ante = 1)],
    ['dead money', (i: any) => (i.original.snapshot.gameState.players[1].deadInvested = 1)],
    [
      'extra board',
      (i: any) => (i.original.snapshot.gameState.communityCards2 = cards('2h 3h 4h 5h 6h')),
    ],
    ['side pot', (i: any) => (i.original.snapshot.gameState.players[1].totalInvested = 41)],
    [
      'stack-sized call',
      (i: any) => {
        i.original.snapshot.player.stack = 20;
        i.original.snapshot.gameState.players[0].stack = 20;
      },
    ],
    [
      'cached field identity',
      (i: any) => (i.original.snapshot.gameState.tournament.stackByUser.hero = 99),
    ],
    [
      'missing paid tail',
      (i: any) =>
        (i.original.snapshot.gameState.tournament.finalizedPrizeLadder.prizesCents = [5000, 3000]),
    ],
    [
      'forged ladder digest',
      (i: any) =>
        (i.original.snapshot.gameState.tournament.finalizedPrizeLadder.sourceDigest = 'a'.repeat(
          64
        )),
    ],
    [
      'NaN original payout',
      (i: any) => (i.original.snapshot.gameState.tournament.payoutPct = [50, 30, NaN]),
    ],
    [
      'missing original payout tail',
      (i: any) => (i.original.snapshot.gameState.tournament.payoutPct = [50, 30]),
    ],
    [
      'sparse original payout',
      (i: any) => (i.original.snapshot.gameState.tournament.payoutPct = [50, , 20]),
    ],
    [
      'unobserved prize unit',
      (i: any) => (i.original.snapshot.gameState.tournament.prizeUnitCents = null),
    ],
    ['stale source', (i: any) => (i.original.snapshot.decisionTimeMs = 60101)],
    [
      'hidden opponent cards',
      (i: any) => (i.original.snapshot.gameState.players[1].cards = cards('Ks Kh')),
    ],
    ['overlapping range', (i: any) => (i.range[0].cards = cards('As Kh'))],
    ['duplicate range', (i: any) => i.range.push(structuredClone(i.range[0]))],
    ['zero range weight', (i: any) => (i.range[0].weight = 0)],
    ['changed read frame', (i: any) => (i.original.readFrame = { publicReads: ['new'] })],
  ])('refuses %s', (_name, mutate) => {
    const i = fixture();
    mutate(i);
    expect(priceClosedHeadsUpTournamentLadderRiver(i).status).toBe('unavailable');
  });
});
