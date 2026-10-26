import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Card } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { evidenceDigest } from './authority.js';
import type { TournamentRiverReferenceInput } from './tournamentRiverReference.js';
import * as producer from './tournamentRiverKernel.js';
import { reviewTournamentModelNumerics } from './tournamentIndependentReview.js';
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

afterEach(() => vi.restoreAllMocks());
describe('independent benchmark review of fixed tournament range prices', () => {
  it('reviews actual strong/weak finite models and binds original context without qualification', () => {
    for (const holding of ['As Ah', '2s 3h']) {
      const original = fixture().original;
      original.snapshot.player.cards = cards(holding);
      const model = producer.buildOriginalTournamentRiverDecision(original);
      expect(model.status).toBe('built');
      if (model.status !== 'built') throw Error(model.reason);
      expect(model.prices.call.outcomes.some((o) => o.result === 'loss')).toBe(true);
      const review = reviewTournamentModelNumerics(original);
      expect(review).toMatchObject({
        status: 'reviewed',
        combinations: 32,
        qualified: false,
        activationAllowed: false,
        sourceAuthenticated: false,
      });
      expect(reviewTournamentModelNumerics(original)).toEqual(review);
    }
  });
  it('refuses legacy missing finalized capture rather than treating repeated producer output as truth', () => {
    const original = fixture().original;
    delete (original.snapshot.gameState.tournament as unknown as Record<string, unknown>)
      .finalizedPrizeLadder;
    expect(reviewTournamentModelNumerics(original).status).toBe('unavailable');
  });
  it('detects a reproducible faulty producer absolute price through independent settlement', () => {
    const original = fixture().original,
      model = producer.buildOriginalTournamentRiverDecision(original);
    if (model.status !== 'built') throw Error(model.reason);
    const faulty = structuredClone(model);
    faulty.prices.fold.expectedPrizeShare += 0.01;
    vi.spyOn(producer, 'buildOriginalTournamentRiverDecision').mockReturnValue(faulty);
    expect(producer.buildOriginalTournamentRiverDecision(original)).toEqual(
      producer.buildOriginalTournamentRiverDecision(original)
    );
    expect(reviewTournamentModelNumerics(original)).toMatchObject({
      status: 'unavailable',
      reason: 'tournament_numeric_settlement_disagreement',
    });
  });
  it('refuses wrong per-combination scorer results, weighted means and identity commitments', () => {
    const original = fixture().original,
      model = producer.buildOriginalTournamentRiverDecision(original);
    if (model.status !== 'built') throw Error(model.reason);
    const faults = ['outcome', 'mean', 'context', 'contract', 'range'] as const;
    for (const fault of faults) {
      const wrong = structuredClone(model);
      if (fault === 'outcome') {
        wrong.prices.call.outcomes[0].expectedPrizeShare =
          wrong.prices.call.outcomes[0].expectedPrizeShare > 0.5 ? 0 : 1;
        let mean = 0;
        for (const o of wrong.prices.call.outcomes) mean += o.expectedPrizeShare / 32;
        wrong.prices.call.expectedPrizeShare = mean;
      }
      if (fault === 'mean') wrong.prices.call.expectedPrizeShare += 0.001;
      if (fault === 'context') wrong.prices.tournamentContextDigest = 'b'.repeat(64);
      if (fault === 'contract') wrong.samplingContractDigest = 'b'.repeat(64);
      if (fault === 'range') wrong.prices.rangeDigest = 'b'.repeat(64);
      const spy = vi.spyOn(producer, 'buildOriginalTournamentRiverDecision').mockReturnValue(wrong);
      expect(reviewTournamentModelNumerics(original).status).toBe('unavailable');
      spy.mockRestore();
    }
  });
});
