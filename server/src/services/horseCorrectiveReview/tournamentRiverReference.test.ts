import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Card } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { evidenceDigest } from './authority.js';
import {
  priceClosedHeadsUpTournamentRiver,
  type TournamentRiverReferenceInput,
} from './tournamentRiverReference.js';

const cards = (text: string): Card[] =>
  text.split(' ').map(
    (x) =>
      ({
        rank: x[0],
        suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[x[1] as 's'],
      }) as Card
  );
function fixture(): TournamentRiverReferenceInput {
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
  const opponent = {
    ...hero,
    user_id: 'villain',
    seat: 2,
    stack: 0,
    bet: 30,
    totalInvested: 40,
    cards: [] as Card[],
    is_all_in: true,
  };
  const source = {
    version: 1,
    tournamentId: 'spin',
    cacheId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
    readStartedAtMs: 90,
    readCompletedAtMs: 100,
    contextDigest: 'a'.repeat(64),
    contextStatus: 'complete',
    contextIssues: [],
  };
  const tournament = {
    schemaVersion: 1,
    contextStatus: 'complete',
    contextIssues: [],
    sourceAgeMs: 0,
    tournamentId: 'spin',
    tournamentStatus: 'RUNNING',
    gameVariant: 'nlh',
    tournamentType: 'SPIN',
    playersLeft: 2,
    playersAtTable: 2,
    spotsPaid: 1,
    payoutPct: [100],
    registrationOpen: false,
    lateRegistrationOpen: false,
    reentryOpen: false,
    rebuyOpen: false,
    addOnPeriodOpen: false,
    reentryAllowed: false,
    rebuyAllowed: false,
    addOnAvailable: false,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    satellite: false,
    bountyPoolCents: 0,
    onBreak: false,
    prizePoolCents: 10001,
    currentSmallBlind: 1,
    currentBigBlind: 2,
    currentAnte: 0,
    stackByUser: { hero: 100, villain: 40 },
    stacks: [100, 40],
    ...captureHorseTournamentPayoutTerms(
      {
        id: 'spin',
        prize_pool_finalized: true,
        bubble_protection: false,
        payout_club: { asset: 'chips', is_platform: false, union_id: null },
        prize_pool: 100.01,
        buy_in_amount: 10,
        is_bounty: false,
        is_pko: false,
        is_mystery_bounty: false,
      },
      [{ place: 1, percentage: 100 }],
      3,
      false
    ),
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
  // Like the cache publication, bind the context including its captured payout
  // terms before adding decision provenance. This is a synthetic source
  // interval, never a signed qualification or an atomic database receipt.
  const { contextProvenance: _projection, ...capturedContext } = tournament;
  source.contextDigest = createHash('sha256').update(JSON.stringify(capturedContext)).digest('hex');
  return {
    version: 'horse-wta-spin-river-reference-v1',
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
          format: 'spin',
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
          players: [{ ...hero, cards: [] }, opponent],
          dealtSeatIds: [1, 2],
          pot: 60,
          currentBet: 30,
          toCall: 20,
          legalActions: ['fold', 'call'],
          communityCards: cards('2c 4d 7h 9s Jc'),
          tournament,
        },
      } as unknown as TournamentRiverReferenceInput['original']['snapshot'],
    },
    range: [{ cards: cards('Ks Kh'), weight: 1 }],
    rangeReadFrameDigest: evidenceDigest({ publicReads: [] }),
  };
}

describe('closed HU WTA Spin river tournament reference', () => {
  it('prices the real capture helper ladder and binds those observed terms in provenance', () => {
    const input = fixture();
    const t = input.original.snapshot.gameState.tournament!;
    expect(t.finalizedPrizeLadder).toMatchObject({
      finalized: true,
      source: 'tournaments+clubs/canonical-payout-v1',
      poolCents: 10001,
      unitCents: 1,
      prizesCents: [10001],
      bubbleReserveCents: 0,
    });
    const { contextProvenance, ...capturedContext } = t;
    expect(contextProvenance!.source!.contextDigest).toBe(
      createHash('sha256').update(JSON.stringify(capturedContext)).digest('hex')
    );
    expect(priceClosedHeadsUpTournamentRiver(input)).toMatchObject({
      status: 'priced',
      qualified: false,
      activationAllowed: false,
      objective: 'wta_hu_icm_chip_share_v1',
      utilityUnit: 'prize_share',
      prizePoolCents: 10001,
      call: { expectedPrizeShare: 1 },
    });
  });
  it('settles fold and a winning call before pricing the WTA prize', () => {
    const input = fixture(),
      before = structuredClone(input),
      result = priceClosedHeadsUpTournamentRiver(input);
    expect(result.status).toBe('priced');
    if (result.status !== 'priced') throw new Error(result.reason);
    // Independently: 140 total chips; folding retains 80/140 of the WTA prize.
    expect(result.fold.stacks).toEqual([80, 60]);
    expect(result.fold.expectedPrizeShare).toBeCloseTo(4 / 7, 10);
    expect(result.call.outcomes[0].stacks).toEqual([140, 0]);
    expect(result.call.expectedPrizeShare).toBe(1);
    expect(result.qualified).toBe(false);
    expect(result.activationAllowed).toBe(false);
    expect(input).toEqual(before);
  });
  it('prices a losing call and a declared weighted range using resulting field chips', () => {
    const i = fixture();
    i.range = [
      { cards: cards('Js Jh'), weight: 3 },
      { cards: cards('Ks Kh'), weight: 1 },
    ];
    const r = priceClosedHeadsUpTournamentRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.call.outcomes.map((o) => o.stacks)).toEqual([
      [60, 80],
      [140, 0],
    ]);
    expect(r.call.expectedPrizeShare).toBeCloseTo(((3 / 7) * 3 + 1) / 4, 10);
  });
  it('settles ties without inventing a tournament winner', () => {
    const i = fixture();
    i.original.snapshot.gameState.communityCards = cards('Tc Jc Qc Kc Ac');
    i.original.snapshot.player.cards = cards('As Ah');
    i.range = [{ cards: cards('Ks Kh'), weight: 1 }];
    const r = priceClosedHeadsUpTournamentRiver(i);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw new Error(r.reason);
    expect(r.call.outcomes[0]).toMatchObject({ result: 'tie', stacks: [100, 40] });
    expect(r.call.expectedPrizeShare).toBeCloseTo(5 / 7, 10);
  });
  it('binds the full original tournament state and read frame', () => {
    const i = fixture(),
      a = priceClosedHeadsUpTournamentRiver(i);
    i.original.snapshot.gameState.tournament!.currentLevel = 7;
    const b = priceClosedHeadsUpTournamentRiver(i);
    expect(a.status).toBe('priced');
    expect(b.status).toBe('priced');
    if (a.status !== 'priced' || b.status !== 'priced') throw new Error('fixture');
    expect(a.inputDigest).not.toBe(b.inputDigest);
    expect(a.tournamentContextDigest).not.toBe(b.tournamentContextDigest);
    i.original.readFrame = { publicReads: ['changed'] };
    expect(priceClosedHeadsUpTournamentRiver(i).status).toBe('unavailable');
  });
  it('refuses a stack-sized call until its distinct all-in witness is qualified', () => {
    const i = fixture(),
      h = i.original.snapshot.player,
      g = i.original.snapshot.gameState;
    h.stack = 20;
    g.players[0].stack = 20;
    g.tournament!.stackByUser = { hero: 40, villain: 40 };
    g.tournament!.stacks = [40, 40];
    i.range = [
      { cards: cards('Js Jh'), weight: 1 },
      { cards: cards('Ks Kh'), weight: 1 },
    ];
    const r = priceClosedHeadsUpTournamentRiver(i);
    expect(r).toEqual({ status: 'unavailable', reason: 'unsupported_call_or_side_pot' });
  });
  it.each([
    [
      'contradictory finalized state',
      (i: any) => (i.original.snapshot.gameState.tournament.prizePoolFinalized = false),
    ],
    [
      'altered ladder digest',
      (i: any) =>
        (i.original.snapshot.gameState.tournament.finalizedPrizeLadder.sourceDigest = 'c'.repeat(
          64
        )),
    ],
    [
      'legacy ladder',
      (i: any) => delete i.original.snapshot.gameState.tournament.finalizedPrizeLadder,
    ],
    [
      'open registration',
      (i: any) => (i.original.snapshot.gameState.tournament.registrationOpen = true),
    ],
    ['bounty', (i: any) => (i.original.snapshot.gameState.tournament.isBounty = true)],
    ['satellite', (i: any) => (i.original.snapshot.gameState.tournament.satellite = true)],
    ['recovery', (i: any) => (i.original.snapshot.gameState.tournament.rebuyOpen = true)],
    ['ante', (i: any) => (i.original.snapshot.gameState.ante = 1)],
    ['side pot', (i: any) => (i.original.snapshot.player.totalInvested = 21)],
    ['cached stacks', (i: any) => (i.original.snapshot.gameState.tournament.stackByUser.hero = 99)],
    ['stale', (i: any) => (i.original.snapshot.decisionTimeMs = 60101)],
    [
      'hidden opponent cards',
      (i: any) => (i.original.snapshot.gameState.players[1].cards = cards('Ks Kh')),
    ],
    ['overlapping range', (i: any) => (i.range[0].cards = cards('As Kh'))],
    ['duplicate range', (i: any) => i.range.push(structuredClone(i.range[0]))],
    ['zero weight', (i: any) => (i.range[0].weight = 0)],
    [
      'multiple prizes',
      (i: any) =>
        (i.original.snapshot.gameState.tournament.finalizedPrizeLadder.prizesCents = [8000, 2001]),
    ],
    [
      'unknown payout unit',
      (i: any) => delete i.original.snapshot.gameState.tournament.finalizedPrizeLadder.unitCents,
    ],
    [
      'bubble reserve',
      (i: any) =>
        (i.original.snapshot.gameState.tournament.finalizedPrizeLadder.bubbleReserveCents = 100),
    ],
  ])('refuses %s', (name, mutate) => {
    const i = fixture();
    mutate(i);
    expect(priceClosedHeadsUpTournamentRiver(i).status).toBe('unavailable');
  });
});
