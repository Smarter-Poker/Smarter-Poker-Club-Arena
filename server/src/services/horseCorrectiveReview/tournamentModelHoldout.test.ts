import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Card } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { evidenceDigest } from './authority.js';
import type { TournamentRiverReferenceInput } from './tournamentRiverReference.js';
import {
  evaluateTournamentDecisionModelHoldout,
  tournamentModelHoldoutPlanIsValid,
  type TournamentModelHoldoutPlan,
  type TournamentModelHoldoutCase,
} from './tournamentModelHoldout.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  TOURNAMENT_RIVER_DECISION_MODEL,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
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

const plan = (): TournamentModelHoldoutPlan => ({
  objective: TOURNAMENT_KERNEL_OBJECTIVE,
  utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
  domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
  populationBasis: 'accepted-commit-and-immutable-played-v1',
  sourceRelease: '1'.repeat(40),
  producerDigest: '2'.repeat(64),
  qualificationId: 'synthetic-measurement-only',
  evidenceClass: 'synthetic_fixture',
  declaredAt: '2026-10-25T00:00:00.000Z',
  holdoutStartsAt: '2026-10-25T01:00:00.000Z',
  holdoutEndsAt: '2026-10-25T02:00:00.000Z',
  selectionHandKeys: ['a'.repeat(64)],
  minimumSamples: 2,
  maximumAbsoluteDelta: 0.05,
  familyWiseAlpha: 0.05,
  familySize: 45,
  modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
  policyVersion: TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
});
const row = (index: number): TournamentModelHoldoutCase => ({
  handKey: evidenceDigest(['hand', index]),
  playedAt: '2026-10-25T01:30:00.000Z',
  sourceRelease: plan().sourceRelease,
  producerDigest: plan().producerDigest,
  qualificationId: plan().qualificationId,
  evidenceClass: plan().evidenceClass,
  decisionDigest: evidenceDigest(['decision', index]),
  acceptedHandDigest: evidenceDigest(['accepted', index]),
  original: fixture().original,
  baselineDecision: { action: 'fold', thinkTime: 0 },
  oracle: { fold: 0.2, call: 0.8 },
});
describe('unsigned tournament fixed-model holdout adapter', () => {
  it('uses both absolute oracle shares and the full union-bound paired reducer without qualification', () => {
    const result = evaluateTournamentDecisionModelHoldout(plan(), [row(1), row(2)]);
    expect(result.status).toBe('measured');
    if (result.status !== 'measured') throw Error(result.reasons.join(','));
    expect(result.changed).toBe(2);
    expect(result.meanGain).toBeCloseTo(0.03, 14);
    expect(result.lowerGain).toBeCloseTo(0.03 - 0.05 * Math.sqrt(Math.log(900)), 14);
    expect(result).toMatchObject({
      qualified: false,
      activationAllowed: false,
      objective: TOURNAMENT_KERNEL_OBJECTIVE,
      utilityUnit: 'prize_share',
    });
    expect(result.measurementDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('counts protected/earlier-policy retention and zero-gain changes in the denominator', () => {
    const rows = [row(1), row(2), row(3)];
    rows[1].baselineDecision.continuationGuard = 'dominated_commitment_floor';
    rows[2].baselineDecision.tournamentPostflop = { applied: true } as never;
    const result = evaluateTournamentDecisionModelHoldout(plan(), rows);
    expect(result).toMatchObject({
      status: 'measured',
      samples: 3,
      changed: 1,
      meanGain: 0.010000000000000002,
    });
    const zeros = [row(1), row(2)];
    for (const x of zeros) x.oracle.call = x.oracle.fold;
    expect(evaluateTournamentDecisionModelHoldout(plan(), zeros)).toMatchObject({
      status: 'measured',
      changed: 2,
      meanGain: 0,
    });
  });
  it('validates exact objective-bound plans independently of rows and rejects cash fields or understated support', () => {
    expect(tournamentModelHoldoutPlanIsValid(plan())).toBe(true);
    for (const patch of [
      { objective: 'cash' },
      { utilityUnit: 'bb' },
      { maximumAbsoluteDelta: 0.04 },
      { maximumAbsoluteDeltaBb: 1 },
      { modelVersion: 'river-public-finite-prior-v1' },
      { familySize: 44 },
      { declaredAt: plan().holdoutStartsAt },
      { minimumSamples: 1 },
      { producerDigest: 'bad' },
      { qualificationId: 123 },
      { domain: { variant: 'nlh', format: 'cash', mode: 'cash' } },
    ]) {
      const p = { ...plan(), ...patch } as unknown as TournamentModelHoldoutPlan;
      expect(tournamentModelHoldoutPlanIsValid(p)).toBe(false);
      expect(evaluateTournamentDecisionModelHoldout(p, [row(1), row(2)]).status).toBe(
        'unavailable'
      );
    }
  });
  it('refuses source reuse, selection overlap, missing/extra metadata and sample truncation', () => {
    for (const key of ['handKey', 'decisionDigest', 'acceptedHandDigest'] as const) {
      const rows = [row(1), row(2)];
      rows[1][key] = rows[0][key];
      expect(evaluateTournamentDecisionModelHoldout(plan(), rows).status).toBe('unavailable');
    }
    const rows = [row(1), row(2)];
    rows[1].handKey = plan().selectionHandKeys[0];
    expect(evaluateTournamentDecisionModelHoldout(plan(), rows).status).toBe('unavailable');
    const extra = { ...row(2), qualified: true } as TournamentModelHoldoutCase;
    expect(evaluateTournamentDecisionModelHoldout(plan(), [row(1), extra]).status).toBe(
      'unavailable'
    );
    const missing = { ...row(2) };
    delete (missing as unknown as Record<string, unknown>).decisionDigest;
    expect(evaluateTournamentDecisionModelHoldout(plan(), [row(1), missing]).status).toBe(
      'unavailable'
    );
    expect(evaluateTournamentDecisionModelHoldout(plan(), [row(1)]).status).toBe('unavailable');
  });
  it('refuses source identity changes and inclusive-end or noncanonical clocks', () => {
    for (const patch of [
      { sourceRelease: '3'.repeat(40) },
      { producerDigest: '3'.repeat(64) },
      { qualificationId: 'other' },
      { evidenceClass: 'reviewed_reference' },
      { playedAt: plan().holdoutEndsAt },
      { playedAt: '2026-10-25T01:30:00Z' },
    ])
      expect(
        evaluateTournamentDecisionModelHoldout(plan(), [
          row(1),
          { ...row(2), ...patch } as TournamentModelHoldoutCase,
        ]).status
      ).toBe('unavailable');
  });
  it('refuses invalid absolute share oracles and unknown original-state payout metadata', () => {
    for (const oracle of [
      { fold: NaN, call: 0.8 },
      { fold: -0.1, call: 0.8 },
      { fold: 0.2, call: 1.01 },
      { fold: 0.2, call: Infinity },
    ])
      expect(
        evaluateTournamentDecisionModelHoldout(plan(), [row(1), { ...row(2), oracle }]).status
      ).toBe('unavailable');
    const bad = row(2);
    delete (bad.original.snapshot.gameState.tournament as unknown as Record<string, unknown>)
      .finalizedPrizeLadder;
    expect(evaluateTournamentDecisionModelHoldout(plan(), [row(1), bad]).status).toBe(
      'unavailable'
    );
  });
  it('streams deterministic commitments binding baseline, absolute outcomes and original state', () => {
    const rows = [row(1), row(2)],
      first = evaluateTournamentDecisionModelHoldout(plan(), rows),
      again = evaluateTournamentDecisionModelHoldout(plan(), rows);
    expect(again).toEqual(first);
    const changed = structuredClone(rows);
    changed[1].oracle.fold = 0.25;
    const other = evaluateTournamentDecisionModelHoldout(plan(), changed);
    expect(other.status).toBe('measured');
    if (first.status !== 'measured' || other.status !== 'measured')
      throw Error('measurement refused');
    expect(other.measurementDigest).not.toBe(first.measurementDigest);
  });
});

import {
  CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL,
  CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
it('locks the second-family holdout to exact registered objective/domain/code versions', () => {
  const p: TournamentModelHoldoutPlan = {
    ...plan(),
    objective: CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
    domain: { variant: 'nlh', format: 'mtt', mode: 'tournament' },
    modelVersion: CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL.version,
    policyVersion: CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
  };
  expect(tournamentModelHoldoutPlanIsValid(p)).toBe(true);
  for (const patch of [
    { objective: TOURNAMENT_KERNEL_OBJECTIVE },
    { domain: { variant: 'nlh', format: 'spin', mode: 'tournament' } },
    { modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version },
  ])
    expect(tournamentModelHoldoutPlanIsValid({ ...p, ...patch })).toBe(false);
  const rows = [row(1), row(2)];
  expect(evaluateTournamentDecisionModelHoldout(p, rows).status).toBe('unavailable');
});
