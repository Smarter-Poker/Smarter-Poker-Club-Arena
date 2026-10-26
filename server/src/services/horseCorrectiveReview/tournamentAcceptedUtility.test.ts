import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Card } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { evidenceDigest } from './authority.js';
import type { TournamentRiverReferenceInput } from './tournamentRiverReference.js';
import { independentlyPriceAcceptedTournamentRiver } from './tournamentAcceptedUtility.js';

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
    entrants: 3,
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
          boardCount: 1,
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

describe('independent conditional accepted WTA HU utility arithmetic', () => {
  it.each([
    ['win', 'Ks Kh', undefined, [140, 0], 1],
    ['loss', 'Js Jh', undefined, [60, 80], 3 / 7],
    ['tie', 'Ks Kh', 'Tc Jc Qc Kc Ac', [100, 40], 5 / 7],
  ] as const)(
    'settles %s independently and keeps fold utility nonzero',
    (_name, opponent, board, stacks, share) => {
      const input = fixture();
      if (board) input.original.snapshot.gameState.communityCards = cards(board);
      const before = structuredClone(input.original),
        result = independentlyPriceAcceptedTournamentRiver({
          original: input.original,
          opponentCards: cards(opponent),
        });
      expect(result.status).toBe('priced');
      if (result.status !== 'priced') throw Error(result.reason);
      expect(result).toMatchObject({
        objective: 'wta_hu_icm_chip_share_v1',
        utilityUnit: 'prize_share',
        qualified: false,
        activationAllowed: false,
        sourceAuthenticated: false,
        fold: { stacks: [80, 60] },
        call: { stacks },
      });
      expect(result.fold.expectedPrizeShare).toBeCloseTo(4 / 7, 12);
      expect(result.call.expectedPrizeShare).toBeCloseTo(share, 12);
      expect(result.call.stacks[0] + result.call.stacks[1]).toBe(140);
      expect(result.fold.stacks[0] + result.fold.stacks[1]).toBe(140);
      expect(result.tournamentContextDigest).toBe(
        evidenceDigest(input.original.snapshot.gameState.tournament)
      );
      expect(result).not.toHaveProperty('prizeAward');
      expect(JSON.stringify(result)).not.toContain('opponentCards');
      expect(input.original).toEqual(before);
    }
  );
  it.each([
    'stack-call-alias',
    'pot-mismatch',
    'funded-stack-mismatch',
    'cash',
    'mtt',
    'missing-ladder',
  ] as const)('refuses %s without fabricating source authentication', (fault) => {
    const input = fixture(),
      s = input.original.snapshot,
      g = s.gameState;
    if (fault === 'stack-call-alias') {
      const publicHero = g.players.find((player) => player.user_id === s.player.user_id);
      expect(publicHero).toBeDefined();
      if (!publicHero) throw new Error('synthetic original hero missing');
      s.player.stack = 20;
      publicHero.stack = 20;
    }
    if (fault === 'pot-mismatch') g.pot = 61;
    if (fault === 'funded-stack-mismatch') g.tournament!.stackByUser!.hero = 99;
    if (fault === 'cash') {
      g.gameMode = 'cash';
      g.format = 'cash';
    }
    if (fault === 'mtt') {
      g.format = 'mtt';
      // A format/type mismatch must remain unavailable.
    }
    if (fault === 'missing-ladder') delete g.tournament!.finalizedPrizeLadder;
    expect(
      independentlyPriceAcceptedTournamentRiver({
        original: input.original,
        opponentCards: cards('Ks Kh'),
      })
    ).toMatchObject({
      status: 'unavailable',
      qualified: false,
      activationAllowed: false,
      sourceAuthenticated: false,
    });
  });
  it('accepts an independently captured exactly-one-paid ladder with explicit zero tails', () => {
    const input = fixture(),
      t = input.original.snapshot.gameState.tournament!;
    Object.assign(
      t,
      captureHorseTournamentPayoutTerms(
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
        [
          { place: 1, percentage: 100 },
          { place: 2, percentage: 0 },
          { place: 3, percentage: 0 },
        ],
        3,
        false
      )
    );
    t.payoutPct = [100, 0, 0];
    const { contextProvenance, ...capturedContext } = t;
    contextProvenance!.source!.contextDigest = createHash('sha256')
      .update(JSON.stringify(capturedContext))
      .digest('hex');
    expect(
      independentlyPriceAcceptedTournamentRiver({
        original: input.original,
        opponentCards: cards('Ks Kh'),
      })
    ).toMatchObject({
      status: 'priced',
      fold: { expectedPrizeShare: expect.closeTo(4 / 7, 12) },
      call: { expectedPrizeShare: 1 },
    });
  });
});

function setCurve(
  s: any,
  format: string,
  pct: number[],
  pool = 10001,
  entrants = Math.max(3, pct.length)
) {
  const g = s.gameState,
    t = g.tournament;
  g.format = format;
  t.tournamentType = format === 'spin' ? 'SPIN' : format === 'mtt' ? 'MTT' : 'SNG';
  t.entrants = entrants;
  t.spotsPaid = pct.filter((p) => p > 0).length;
  t.payoutPct = [...pct];
  t.prizePoolCents = pool;
  Object.assign(
    t,
    captureHorseTournamentPayoutTerms(
      {
        id: t.tournamentId,
        prize_pool_finalized: true,
        bubble_protection: false,
        payout_club: { asset: 'chips', is_platform: false, union_id: null },
        prize_pool: pool / 100,
        buy_in_amount: 10,
        is_bounty: false,
        is_pko: false,
        is_mystery_bounty: false,
      },
      pct.map((percentage, i) => ({ place: i + 1, percentage })),
      entrants,
      false
    )
  );
  const { contextProvenance, ...captured } = t;
  contextProvenance.source.contextDigest = createHash('sha256')
    .update(JSON.stringify(captured))
    .digest('hex');
}

describe('independent closed HU full original prize utility', () => {
  it.each(['mtt', 'sng', 'hu_sng'])('prices %s without dropping already-paid tail', (format) => {
    const i = fixture();
    setCurve(i.original.snapshot, format, [60, 30, 10], 10000);
    const r = independentlyPriceAcceptedTournamentRiver({
      original: i.original,
      opponentCards: cards('Ks Kh'),
    });
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw Error(r.reason);
    expect(r.objective).toBe('closed_hu_ladder_icm_prize_share_v1');
    expect(r.fold.expectedPrizeShare).toBeCloseTo(33 / 70, 12);
    expect(r.call.expectedPrizeShare).toBeCloseTo(0.6, 12);
    expect(r).toMatchObject({
      qualified: false,
      activationAllowed: false,
      sourceAuthenticated: false,
      prizePoolCents: 10000,
    });
  });
  it('preserves canonical second prize larger than first and signed chip slope', () => {
    const i = fixture();
    setCurve(i.original.snapshot, 'hu_sng', [49.99, 50.01]);
    expect(i.original.snapshot.gameState.tournament!.finalizedPrizeLadder!.prizesCents).toEqual([
      4999, 5002,
    ]);
    const r = independentlyPriceAcceptedTournamentRiver({
      original: i.original,
      opponentCards: cards('Ks Kh'),
    });
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw Error(r.reason);
    expect(r.fold.expectedPrizeShare).toBeCloseTo((5002 - (3 * 4) / 7) / 10001, 12);
    expect(r.call.expectedPrizeShare).toBe(4999 / 10001);
    expect(r.call.expectedPrizeShare).toBeLessThan(r.fold.expectedPrizeShare);
  });
  it('accepts Spin zero tails bounded by original entrants beyond ten places', () => {
    const i = fixture();
    setCurve(i.original.snapshot, 'spin', [100, ...Array(11).fill(0)]);
    const r = independentlyPriceAcceptedTournamentRiver({
      original: i.original,
      opponentCards: cards('Ks Kh'),
    });
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') throw Error(r.reason);
    expect(r.fold.expectedPrizeShare).toBeCloseTo(4 / 7, 12);
    expect(r.call.expectedPrizeShare).toBe(1);
  });
  it.each(['entrants', 'sparse', 'provenance', 'spin-paid-tail'])(
    'refuses %s without substituting family',
    (fault) => {
      const i = fixture();
      setCurve(i.original.snapshot, 'mtt', [60, 30, 10]);
      const t = i.original.snapshot.gameState.tournament!;
      if (fault === 'entrants') delete t.entrants;
      if (fault === 'sparse') delete t.payoutPct![1];
      if (fault === 'provenance') t.contextProvenance!.projection.actorId = 'other';
      if (fault === 'spin-paid-tail') {
        i.original.snapshot.gameState.format = 'spin';
        t.tournamentType = 'SPIN';
      }
      expect(
        independentlyPriceAcceptedTournamentRiver({
          original: i.original,
          opponentCards: cards('Ks Kh'),
        })
      ).toMatchObject({ status: 'unavailable', qualified: false });
    }
  );
});

it('independently prices the actual canonical floating-percent capture without normalization', () => {
  const i = fixture();
  setCurve(i.original.snapshot, 'sng', [0.1, 64.1, 35.8], 10000);
  const t = i.original.snapshot.gameState.tournament!;
  expect(t.payoutPct!.reduce((a, b) => a + b, 0)).not.toBe(100);
  expect(t.finalizedPrizeLadder!.prizesCents).toEqual([10, 6410, 3580]);
  const r = independentlyPriceAcceptedTournamentRiver({
    original: i.original,
    opponentCards: cards('Ks Kh'),
  });
  expect(r.status).toBe('priced');
  if (r.status !== 'priced') throw Error(r.reason);
  expect(r.fold.expectedPrizeShare).toBeCloseTo((6410 + ((10 - 6410) * 4) / 7) / 10000, 12);
  expect(r.call.expectedPrizeShare).toBe(0.001);
});
