import { describe, expect, it, vi } from 'vitest';
import {
  buildOriginalTournamentRiverDecision,
  proposeOriginalTournamentRiverCorrection,
} from './tournamentRiverKernel.js';
import { createHash } from 'node:crypto';
import type { Card } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { evidenceDigest } from './authority.js';
import type { TournamentRiverReferenceInput } from './tournamentRiverReference.js';

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
    entrants: 3,
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
          boardCount: 1,
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

function reseal(input: TournamentRiverReferenceInput) {
  const t = input.original.snapshot.gameState.tournament!;
  const { contextProvenance, ...capturedContext } = t;
  contextProvenance!.source!.contextDigest = createHash('sha256')
    .update(JSON.stringify(capturedContext))
    .digest('hex');
}
describe('separate unsigned WTA HU Spin finite-prior kernel', () => {
  it('builds exactly32 distinct public-only combos and preserves original input', () => {
    const original = fixture().original,
      before = structuredClone(original),
      a = buildOriginalTournamentRiverDecision(original),
      b = buildOriginalTournamentRiverDecision(original);
    expect(a.status).toBe('built');
    expect(b).toEqual(a);
    expect(original).toEqual(before);
    if (a.status !== 'built') throw Error(a.reason);
    expect(a.input.range).toHaveLength(32);
    const known = new Set(
      [...original.snapshot.player.cards, ...original.snapshot.gameState.communityCards].map(
        (c) => c.rank + ':' + c.suit
      )
    );
    const combos = a.input.range.map((r) =>
      r.cards
        .map((c) => c.rank + ':' + c.suit)
        .sort()
        .join('|')
    );
    expect(new Set(combos).size).toBe(32);
    expect(
      a.input.range.every(
        (r) =>
          r.weight === 1 &&
          r.cards.length === 2 &&
          r.cards.every((c) => !known.has(c.rank + ':' + c.suit))
      )
    ).toBe(true);
    expect(a).toMatchObject({
      qualified: false,
      activationAllowed: false,
      modelVersion: 'wta-hu-spin-public-finite-prior-v1',
      prices: { objective: 'wta_hu_icm_chip_share_v1', utilityUnit: 'prize_share' },
    });
  });
  it('does not seed the finite range from actor identifiers or request identifiers', () => {
    const a = fixture(),
      b = fixture(),
      g = b.original.snapshot.gameState,
      h = b.original.snapshot.player,
      t = g.tournament!;
    h.user_id = 'different-hero';
    g.players[0].user_id = h.user_id;
    g.players[1].user_id = 'different-opponent';
    t.stackByUser = { 'different-hero': 100, 'different-opponent': 40 };
    t.contextProvenance!.projection.actorId = h.user_id;
    b.original.snapshot.requestId = 999;
    reseal(b);
    const x = buildOriginalTournamentRiverDecision(a.original),
      y = buildOriginalTournamentRiverDecision(b.original);
    expect(x.status).toBe('built');
    expect(y.status).toBe('built');
    if (x.status === 'built' && y.status === 'built') {
      expect(x.samplingSeedDigest).toBe(y.samplingSeedDigest);
      expect(x.input.range).toEqual(y.input.range);
      expect(x.prices.inputDigest).not.toBe(y.prices.inputDigest);
    }
  });
  it('proposes a conditional fold-to-call gain in prize share without drawing RNG', () => {
    const input = fixture(),
      random = vi.spyOn(Math, 'random').mockImplementation(() => {
        throw Error('RNG forbidden');
      });
    try {
      const result = proposeOriginalTournamentRiverCorrection(input.original, {
        action: 'fold',
        thinkTime: 0,
      });
      expect(result).toMatchObject({
        status: 'proposed',
        objective: 'wta_hu_icm_chip_share_v1',
        utilityUnit: 'prize_share',
        conditionalProbability: 0.05,
        from: { action: 'fold', amount: 0 },
        to: { action: 'call', amount: 20 },
        qualified: false,
        activationAllowed: false,
      });
      if (result.status === 'proposed')
        expect(result.modelGainLowerPrizeShare).toBeGreaterThan(0.0001);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
  it('can correct a weak-priced baseline call to fold using the same original chip-to-prize objective', () => {
    const input = fixture(),
      s = input.original.snapshot,
      g = s.gameState,
      h = s.player;
    h.cards = cards('2s 3h');
    h.stack = 120;
    g.players[0].stack = 120;
    g.players[1].bet = 90;
    g.players[1].totalInvested = 100;
    g.currentBet = 90;
    g.toCall = 80;
    g.pot = 120;
    g.communityCards = cards('4c 7d 9h Js Qc');
    g.tournament!.stackByUser = { hero: 140, villain: 100 };
    g.tournament!.stacks = [140, 100];
    reseal(input);
    expect(
      proposeOriginalTournamentRiverCorrection(input.original, {
        action: 'call',
        amount: 80,
        thinkTime: 0,
      })
    ).toMatchObject({
      status: 'proposed',
      from: { action: 'call', amount: 80 },
      to: { action: 'fold', amount: 0 },
      utilityUnit: 'prize_share',
    });
  });
  it('retains protected folds, earlier applied owners and stack-sized aliases', () => {
    const input = fixture();
    expect(
      proposeOriginalTournamentRiverCorrection(input.original, {
        action: 'fold',
        thinkTime: 0,
        continuationGuard: 'dominated_commitment_floor',
      })
    ).toMatchObject({ status: 'retained', reason: 'protected_continuation' });
    expect(
      proposeOriginalTournamentRiverCorrection(input.original, {
        action: 'fold',
        thinkTime: 0,
        tournamentPostflop: { applied: true } as never,
      })
    ).toMatchObject({ status: 'retained', reason: 'earlier_phase_applied' });
    input.original.snapshot.player.stack = 20;
    expect(
      proposeOriginalTournamentRiverCorrection(input.original, { action: 'fold', thinkTime: 0 })
    ).toMatchObject({ status: 'retained', reason: 'call_requires_all_in_alias' });
  });
  it.each([
    'cash',
    'hidden-opponent',
    'unknown-ladder',
    'stale',
    'invalid-hero',
    'inconsistent-call',
  ] as const)('refuses %s rather than reusing cash BB utility', (fault) => {
    const input = fixture(),
      s = input.original.snapshot,
      g = s.gameState;
    if (fault === 'cash') {
      g.gameMode = 'cash';
      g.format = 'cash';
    }
    if (fault === 'hidden-opponent') g.players[1].cards = cards('Ks Kh');
    if (fault === 'unknown-ladder') delete g.tournament!.finalizedPrizeLadder;
    if (fault === 'stale') s.decisionTimeMs = 60101;
    if (fault === 'invalid-hero') s.player.cards = cards('2c 2c');
    if (fault === 'inconsistent-call') g.toCall = 21;
    expect(buildOriginalTournamentRiverDecision(input.original)).toMatchObject({
      status: 'unavailable',
      qualified: false,
      activationAllowed: false,
    });
  });
  it('refuses a baseline call amount different from the original canonical incremental call', () => {
    expect(
      proposeOriginalTournamentRiverCorrection(fixture().original, {
        action: 'call',
        amount: 19,
        thinkTime: 0,
      })
    ).toMatchObject({ status: 'unavailable', reason: 'tournament_baseline_price_mismatch' });
  });
});
