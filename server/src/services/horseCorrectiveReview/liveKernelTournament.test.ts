import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import type { Card, HorseDecision } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { journalHash } from '../horseDecisionJournal/record.js';
import { evidenceDigest } from './authority.js';
import type { TournamentRiverReferenceInput } from './tournamentRiverReference.js';
import {
  TOURNAMENT_RIVER_CORRECTION_KERNEL as kernel,
  TOURNAMENT_RIVER_DECISION_MODEL as model,
  TOURNAMENT_KERNEL_OBJECTIVE as objective,
  TOURNAMENT_KERNEL_UTILITY_UNIT as utilityUnit,
} from './kernelTournamentDefinition.js';
import {
  tournamentKernelApprovalSigningBytes,
  verifyTournamentCorrectiveKernelApproval,
  type TournamentCorrectiveKernelApproval,
} from './kernelTournamentApproval.js';
import {
  TOURNAMENT_KERNEL_CATALOG_VERSION,
  tournamentKernelCatalogDigest,
  validateTournamentCorrectiveKernelCatalog,
  type TournamentCorrectiveKernelCatalog,
} from './kernelTournamentCatalog.js';
import {
  evaluateAdmittedRiverKernel,
  createCorrectiveKernelEvaluator,
  runCorrectiveKernelEvaluator,
} from './liveKernel.js';
import { correctiveKernelReceiptIsValid } from './kernelReceipt.js';
import * as cashProducer from './riverKernel.js';
import * as tournamentProducer from './tournamentRiverKernel.js';
import { catalog as cashCatalog, approved, running } from './kernelApproval.test-support.js';
import { validateCorrectiveKernelCatalog } from './kernelCatalog.js';
import { riverReferenceFixture, bind } from './riverReference.test-support.js';
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

const now = Date.parse('2026-10-25T01:00:00.000Z');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trusted = journalHash(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
function catalogFixture() {
  const catalog: TournamentCorrectiveKernelCatalog = {
    version: TOURNAMENT_KERNEL_CATALOG_VERSION,
    kind: 'original_state_function',
    objective,
    utilityUnit,
    domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
    sourceRelease: '1'.repeat(40),
    kernelVersion: kernel.version,
    modelVersion: model.version,
    policyDigest: evidenceDigest('policy'),
    baselineSelectionsDigest: evidenceDigest('baseline'),
    holdoutDigest: evidenceDigest('holdout'),
    maximumConditionalProbability: 0.05,
    minimumModelGainPrizeShare: kernel.minimumModelGainPrizeShare,
  };
  const approval: TournamentCorrectiveKernelApproval = {
    version: 2,
    role: 'original_state_kernel_holdout',
    objective,
    utilityUnit,
    evidenceClass: 'synthetic_fixture',
    qualificationId: 'catalog-synthetic-only',
    domain: { ...catalog.domain },
    sourceRelease: catalog.sourceRelease,
    kernelVersion: kernel.version,
    modelVersion: model.version,
    policyDigest: catalog.policyDigest,
    baselineSelectionsDigest: catalog.baselineSelectionsDigest,
    catalogDigest: tournamentKernelCatalogDigest(catalog),
    holdoutDigest: catalog.holdoutDigest,
    selectionWindowDigest: evidenceDigest('selection'),
    holdoutWindowDigest: evidenceDigest('window'),
    sourceCustodyDigest: evidenceDigest('custody'),
    numericReviewDigest: evidenceDigest('numeric'),
    rollbackDigest: evidenceDigest('rollback'),
    approvalGeneration: 1,
    issuedAt: '2026-10-25T00:00:00.000Z',
    expiresAt: '2026-10-26T00:00:00.000Z',
    measurement: {
      samples: 10000,
      changed: 10000,
      meanGain: 0.02,
      lowerGain: 0.018,
      familyWiseConfidence: 0.95,
      familySize: 45,
      maximumAbsoluteDelta: 0.05,
    },
  };
  const verified = verifyTournamentCorrectiveKernelApproval(
    {
      approval,
      publicKeyPem,
      signature: sign(null, tournamentKernelApprovalSigningBytes(approval), privateKey).toString(
        'base64'
      ),
    },
    trusted,
    now,
    { allowSynthetic: true }
  );
  expect(verified).not.toBeNull();
  return {
    catalog,
    approval: verified!,
    running: {
      policyDigest: catalog.policyDigest,
      baselineSelectionsDigest: catalog.baselineSelectionsDigest,
      nowMs: now,
    },
  };
}

function admitted() {
  const f = catalogFixture(),
    r = validateTournamentCorrectiveKernelCatalog(f.catalog, f.approval, f.running);
  if (r.status !== 'validated') throw Error(r.reason);
  return r.catalog;
}
const baseline = (): HorseDecision => ({ action: 'fold', thinkTime: 500 });
function boundary(r: ReturnType<typeof evaluateAdmittedRiverKernel>): HorseDecision {
  const receipt = r.receipt!;
  return {
    ...r.decision,
    correctivePolicy: {
      ...receipt,
      authority: {
        version: 'horse-qualified-authority-receipt-v1',
        epoch: 'synthetic-worker',
        generation: 1,
        state: 'usable',
        reason: null,
        continuationVersion:
          (receipt.version.endsWith('v2')
            ? TOURNAMENT_KERNEL_CATALOG_VERSION
            : 'horse-corrective-kernel-catalog-v1') +
          '/' +
          receipt.domain,
        sourceSha: receipt.sourceSha,
      },
      baselineAuthorities: {},
    },
    policyGraph: {
      version: 'horse-policy-order-v3',
      transitions: [
        { node: 'corrective_policy', before: receipt.baseline, after: receipt.selected },
      ],
    },
  } as unknown as HorseDecision;
}
describe('synthetic signed tournament live kernel boundary, never qualification', () => {
  it('uses actual tournament model only and binds objective/source/read/context into a valid receipt', () => {
    const cash = vi.spyOn(cashProducer, 'proposeOriginalRiverCorrection'),
      tourney = vi.spyOn(tournamentProducer, 'proposeOriginalTournamentRiverCorrection');
    try {
      const c = admitted(),
        o = fixture().original,
        before = structuredClone(o),
        r = evaluateAdmittedRiverKernel(c, o, baseline(), () => 0),
        p = tournamentProducer.proposeOriginalTournamentRiverCorrection(o, baseline());
      expect(r.decision.action).toBe('call');
      expect(p.status).toBe('proposed');
      if (p.status !== 'proposed') throw Error(p.reason);
      expect(r.receipt).toMatchObject({
        version: 'horse-corrective-live-kernel-v2',
        objective,
        utilityUnit,
        sourceSha: c.sourceRelease,
        inputDigest: evidenceDigest(o.snapshot),
        readFrameDigest: evidenceDigest(o.readFrame),
        tournamentContextDigest: p.tournamentContextDigest,
        modelGainLowerPrizeShare: p.modelGainLowerPrizeShare,
        catalogDigest: tournamentKernelCatalogDigest(c),
        conditionalProbability: 0.05,
      });
      expect(r.receipt).not.toHaveProperty('modelGainLowerBb');
      expect(correctiveKernelReceiptIsValid(boundary(r))).toBe(true);
      expect(o).toEqual(before);
      expect(cash).not.toHaveBeenCalled();
      expect(tourney).toHaveBeenCalled();
    } finally {
      cash.mockRestore();
      tourney.mockRestore();
    }
  });
  it('retains exact baseline above sampling boundary with valid v2 receipt', () => {
    const b = baseline(),
      r = evaluateAdmittedRiverKernel(admitted(), fixture().original, b, () => 0.05);
    expect(r.decision).toBe(b);
    expect(r.receipt).toMatchObject({
      applied: false,
      reason: 'not_sampled',
      selected: { action: 'fold', amount: 0 },
    });
    expect(correctiveKernelReceiptIsValid(boundary(r))).toBe(true);
  });
  it('rejects cloned catalog before consuming RNG or creating evaluator', () => {
    const c = structuredClone(admitted()),
      b = baseline(),
      draw = vi.fn(() => 0),
      o = fixture().original;
    expect(evaluateAdmittedRiverKernel(c, o, b, draw)).toEqual({ decision: b, receipt: null });
    expect(
      createCorrectiveKernelEvaluator({
        catalog: c,
        original: () => o,
        stillUsable: () => true,
        draw,
      })
    ).toBeNull();
    expect(draw).not.toHaveBeenCalled();
  });
  it('preserves protected and earlier-applied baselines without RNG', () => {
    const c = admitted(),
      draw = vi.fn(() => 0);
    for (const b of [
      { ...baseline(), continuationGuard: 'multiway_commitment_floor' },
      { ...baseline(), tournamentPostflop: { applied: true } },
    ] as HorseDecision[]) {
      expect(evaluateAdmittedRiverKernel(c, fixture().original, b, draw)).toEqual({
        decision: b,
        receipt: null,
      });
    }
    expect(draw).not.toHaveBeenCalled();
  });
  it('withdraws before work or during sampling without leaking candidate', () => {
    const c = admitted(),
      b = baseline(),
      draw = vi.fn(() => 0);
    const a = createCorrectiveKernelEvaluator({
      catalog: c,
      original: () => fixture().original,
      stillUsable: () => false,
      draw,
    });
    expect(runCorrectiveKernelEvaluator(a, b)).toEqual({ decision: b, receipt: null });
    expect(draw).not.toHaveBeenCalled();
    let usable = true;
    const e = createCorrectiveKernelEvaluator({
      catalog: c,
      original: () => fixture().original,
      stillUsable: () => usable,
      draw: () => {
        usable = false;
        return 0;
      },
    });
    expect(runCorrectiveKernelEvaluator(e, b)).toEqual({ decision: b, receipt: null });
  });
  it('preserves cash v1 receipt shape and independent catalog brand', () => {
    const c = cashCatalog(),
      v = validateCorrectiveKernelCatalog(c, approved(c), running(c));
    if (v.status !== 'validated') throw Error(v.reason);
    const f = riverReferenceFixture();
    f.stack = 200;
    bind(f);
    const r = evaluateAdmittedRiverKernel(v.catalog, f.original, baseline(), () => 0);
    expect(r.receipt).toMatchObject({
      version: 'horse-corrective-live-kernel-v1',
      modelGainLowerBb: expect.any(Number),
      domain: 'nlh-cash',
    });
    for (const k of [
      'objective',
      'utilityUnit',
      'modelGainLowerPrizeShare',
      'tournamentContextDigest',
    ])
      expect(r.receipt).not.toHaveProperty(k);
    expect(correctiveKernelReceiptIsValid(boundary(r))).toBe(true);
  });
  it('refuses malformed receipts without throwing and rejects objective/unit/context/source tampering', () => {
    for (const bad of [null, 1, 'x', []])
      expect(
        correctiveKernelReceiptIsValid({
          action: 'fold',
          thinkTime: 0,
          correctivePolicy: bad,
        } as unknown as HorseDecision)
      ).toBe(false);
    const good = boundary(
      evaluateAdmittedRiverKernel(admitted(), fixture().original, baseline(), () => 0)
    );
    for (const [key, value] of [
      ['objective', 'cash_ev'],
      ['utilityUnit', 'bb'],
      ['tournamentContextDigest', 'invalid'],
      ['sourceSha', '2'.repeat(40)],
    ]) {
      const d = structuredClone(good) as any;
      d.correctivePolicy[key] = value;
      expect(correctiveKernelReceiptIsValid(d)).toBe(false);
    }
  });
});
