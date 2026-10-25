/** Isolated issuer protocol tests use explicit test-double source owners and an
 * in-memory test key. They are never source/holdout/rollback qualification. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { evidenceDigest } from './authority.js';
import { journalHash } from '../horseDecisionJournal/record.js';
import type { CorrectivePredeclaration } from './kernelPredeclaration.js';
import type { RiverSourcePopulation } from './riverSourcePopulation.js';
import type { CorrectiveKernelEvidenceReview } from './kernelQualificationReview.js';
import type { CorrectiveKernelRollbackEvidence } from './kernelRollbackQualification.js';
import type { RiverAcceptedOracleRequest } from './riverAcceptedOracle.js';
import { RIVER_CORRECTION_KERNEL, RIVER_DECISION_MODEL } from './kernelDefinition.js';
const control = vi.hoisted(() => ({
  source: '1'.repeat(40),
  policy: 'a'.repeat(64),
  baseline: 'b'.repeat(64),
  pin: null as string | null,
  predeclaration: null as CorrectivePredeclaration | null,
  population: null as RiverSourcePopulation | null,
  review: null as CorrectiveKernelEvidenceReview | null,
  rollback: null as CorrectiveKernelRollbackEvidence | null,
  predeclared: new WeakSet<object>(),
  populations: new WeakSet<object>(),
  rollbacks: new WeakSet<object>(),
  gitHeads: 0,
  changeSource: false,
  populationCalls: 0,
  reviewCalls: 0,
  rollbackCalls: 0,
  generationCalls: 0,
  advanceGeneration: false,
  controlChanged: false,
  controlCalls: 0,
  finalControlChanged: false,
}));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_file: string, args: string[]) => {
    if (args.includes('rev-parse')) {
      control.gitHeads++;
      return control.changeSource && control.gitHeads > 1 ? '2'.repeat(40) : control.source;
    }
    return '';
  }),
}));
vi.mock('./kernelGenerationProvider.js', () => ({
  readCurrentCorrectiveGeneration: (domain: string) => {
    control.generationCalls++;
    return {
      status: 'current_generation',
      receipt: {
        version: 'horse-phase14-current-generation-v1',
        mainSha: 'f'.repeat(40),
        ledgerSha256:
          control.advanceGeneration && control.generationCalls > 1
            ? 'e'.repeat(64)
            : 'd'.repeat(64),
        domain,
        highestPublishedGeneration: 7,
        retiredGenerations: [1, 4, 7],
        nextGeneration: 8,
      },
    };
  },
}));
vi.mock('./kernelIssuerControl.js', () => ({
  checkCurrentCorrectiveIssuerControl: (mainSha: string) => {
    control.controlCalls++;
    return control.controlChanged || (control.finalControlChanged && control.controlCalls > 1)
      ? null
      : { mainSha, fingerprint: 'c'.repeat(64) };
  },
}));
vi.mock('./kernelIssuerTrust.js', () => ({
  get PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256() {
    return control.pin;
  },
  PHASE14_ISSUER_SECRET_NAME: 'HORSE_PHASE14_QUALIFICATION_SIGNING_KEY',
}));
vi.mock('./kernelPredeclaration.js', () => ({
  readCorrectivePredeclaration: () =>
    control.predeclaration
      ? { status: 'authenticated_predeclaration', predeclaration: control.predeclaration }
      : { status: 'unavailable', reason: 'test-unavailable' },
  isAuthenticatedCorrectivePredeclaration: (value: object) => control.predeclared.has(value),
}));
vi.mock('./riverSourcePopulation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./riverSourcePopulation.js')>();
  return {
    ...actual,
    createRiverSourcePopulationReviewer: () => async () => {
      control.populationCalls++;
      return control.population ?? { status: 'unavailable' };
    },
    isVerifiedRiverSourcePopulation: (value: object) => control.populations.has(value),
  };
});
vi.mock('./kernelQualificationReview.js', () => ({
  createCorrectiveKernelEvidenceReviewer: () => async () => {
    control.reviewCalls++;
    return control.review;
  },
}));
vi.mock('./kernelRollbackQualification.js', () => ({
  executeCorrectiveKernelRollback: () => {
    control.rollbackCalls++;
    return control.rollback
      ? { status: 'verified_rollback_mechanism', evidence: control.rollback }
      : { status: 'unavailable' };
  },
  isExecutedCorrectiveKernelRollback: (
    value: CorrectiveKernelRollbackEvidence,
    expected: unknown
  ) =>
    control.rollbacks.has(value) &&
    evidenceDigest({
      sourceRelease: value.sourceRelease,
      policyDigest: value.policyDigest,
      baselineSelectionsDigest: value.baselineSelectionsDigest,
    }) === evidenceDigest(expected),
}));
vi.mock('./kernelPolicyDigest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kernelPolicyDigest.js')>();
  return {
    ...actual,
    correctiveKernelPolicyDigestOf: () => control.policy,
    correctiveKernelBaselineSelectionsDigest: () => control.baseline,
  };
});
import {
  createCorrectiveKernelIssuer,
  correctiveKernelProducerDigest,
  correctiveKernelRequestsDigest,
} from './kernelIssuer.js';
import { verifyCorrectiveKernelApproval } from './kernelApproval.js';
import { validateCorrectiveKernelCatalog } from './kernelCatalog.js';
let privateKeyPem: string;
function keyEnvironment() {
  let reads = 0;
  const environment = Object.defineProperty({}, 'HORSE_PHASE14_QUALIFICATION_SIGNING_KEY', {
    get() {
      reads++;
      return privateKeyPem;
    },
  });
  return { environment, reads: () => reads };
}
const request = () => ({
  predeclaration: {
    commitSha: '2'.repeat(40),
    path: 'docs/evidence/phase14/plans/test.json',
    contentSha256: 'c'.repeat(64),
  },
  scratchRoot: '/explicit-private-scratch',
  producerRequestsDigest: control.population!.requestsDigest,
});
beforeEach(() => {
  control.pin = null;
  control.predeclaration = null;
  control.population = null;
  control.review = null;
  control.rollback = null;
  control.predeclared = new WeakSet();
  control.populations = new WeakSet();
  control.rollbacks = new WeakSet();
  control.gitHeads = 0;
  control.changeSource = false;
  control.populationCalls = 0;
  control.reviewCalls = 0;
  control.rollbackCalls = 0;
  control.generationCalls = 0;
  control.advanceGeneration = false;
  control.controlChanged = false;
  control.controlCalls = 0;
  control.finalControlChanged = false;
  const pair = generateKeyPairSync('ed25519');
  privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  control.pin = journalHash(
    pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  );
  const plan = {
    populationBasis: 'accepted-commit-and-immutable-played-v1' as const,
    domain: { variant: 'nlh' as const, format: 'cash' as const, mode: 'cash' as const },
    sourceRelease: control.source,
    producerDigest: correctiveKernelProducerDigest(control.source, control.policy)!,
    qualificationId: 'unit-test-not-production-evidence',
    evidenceClass: 'reviewed_reference' as const,
    modelVersion: RIVER_DECISION_MODEL.version,
    policyVersion: RIVER_CORRECTION_KERNEL.version,
    declaredAt: '2026-09-01T00:00:00.000Z',
    holdoutStartsAt: '2026-09-02T00:00:00.000Z',
    holdoutEndsAt: '2026-09-03T00:00:00.000Z',
    selectionHandKeys: ['d'.repeat(64)],
    minimumSamples: 128,
    maximumAbsoluteDeltaBb: 3,
    familyWiseAlpha: 0.05,
    familySize: 45,
  };
  control.predeclaration = {
    version: 'horse-corrective-provider-predeclaration-v1',
    repository: 'Smarter-Poker/Smarter-Poker-Club-Arena',
    commitSha: '2'.repeat(40),
    path: 'docs/evidence/phase14/plans/test.json',
    contentSha256: 'c'.repeat(64),
    pullRequest: 1,
    mergedAt: '2026-09-01T01:00:00.000Z',
    plan,
    custodyDigest: 'e'.repeat(64),
  };
  control.predeclared.add(control.predeclaration);
  const requests = Array.from(
    { length: 128 },
    (_, i) =>
      ({
        handKey: evidenceDigest(['unit', i]),
        records: [],
        input: { domain: plan.domain, original: { snapshot: { unit: i }, readFrame: { unit: i } } },
      }) as unknown as RiverAcceptedOracleRequest
  );
  control.population = {
    version: 'horse-river-source-population-v1',
    status: 'source_population_verified',
    predeclarationDigest: control.predeclaration.custodyDigest,
    planDigest: evidenceDigest(plan),
    censusDigest: '1'.repeat(64),
    windowDigest: '2'.repeat(64),
    requestsDigest: correctiveKernelRequestsDigest(requests),
    sourceRelease: control.source,
    acceptedHands: 128,
    eligibleCases: 128,
    exclusions: {},
    requests,
    sourcePopulationVerified: true,
    qualified: false,
    completePopulation: false,
    activationAllowed: false,
  };
  control.populations.add(control.population);
  const lower = 1.5 - 3 * Math.sqrt((2 * Math.log(45 / 0.05)) / 128);
  control.review = {
    version: 'horse-corrective-kernel-evidence-review-v1',
    status: 'reviewed_unsigned',
    reason: 'independent_issuance_gates_unavailable',
    checkedCases: 128,
    reviewDigest: '3'.repeat(64),
    sourceCustodyDigest: '4'.repeat(64),
    numericReviewDigest: '5'.repeat(64),
    predeclarationDigest: control.predeclaration.custodyDigest,
    measurement: {
      modelVersion: RIVER_DECISION_MODEL.version,
      policyVersion: RIVER_CORRECTION_KERNEL.version,
      status: 'measured',
      reasons: [],
      samples: 128,
      changed: 128,
      meanGainBb: 1.5,
      lowerGainBb: lower,
      measurementDigest: '6'.repeat(64),
      qualified: false,
      activationAllowed: false,
    },
    requiredBeforeIssuance: [
      'complete_source_window_census',
      'qualified_rollback',
      'independently_held_signer',
    ],
    qualified: false,
    completePopulation: false,
    activationAllowed: false,
  };
  control.rollback = {
    version: 'horse-phase14-executed-rollback-v1',
    sourceRelease: control.source,
    policyDigest: control.policy,
    baselineSelectionsDigest: control.baseline,
    testSourceDigest: '7'.repeat(64),
    reportDigest: '8'.repeat(64),
    rollbackDigest: '9'.repeat(64),
    mechanismOnly: true,
    effectsScope: 'fold-call-reference-plans-retired',
    replayScope: 'exact-worker-answer-and-withdrawn-controller-join',
    strategyQualified: false,
    populationQualified: false,
    activationAllowed: false,
  };
  control.rollbacks.add(control.rollback);
});
describe('purpose-only independently verified qualification issuer', () => {
  it('loads its purpose key only after every real owner boundary, signs, and passes the unchanged production consumer', async () => {
    const key = keyEnvironment(),
      result = await createCorrectiveKernelIssuer(key.environment)(request());
    expect(result.status).toBe('issued_qualification');
    expect(key.reads()).toBe(1);
    expect(control.populationCalls).toBe(1);
    expect(control.reviewCalls).toBe(1);
    expect(control.rollbackCalls).toBe(1);
    if (result.status !== 'issued_qualification') throw Error('isolated issuer protocol fixture');
    const verified = verifyCorrectiveKernelApproval(
      result.qualification.approval,
      control.pin!,
      Date.now()
    );
    expect(verified).not.toBeNull();
    expect(
      validateCorrectiveKernelCatalog(result.qualification.catalog, verified, {
        policyDigest: control.policy,
        baselineSelectionsDigest: control.baseline,
        nowMs: Date.now(),
      }).status
    ).toBe('validated');
    expect(result.qualification.catalog.domain).toEqual(control.predeclaration!.plan.domain);
    expect(result.qualification.approval.approval.approvalGeneration).toBe(8);
    expect(result.activationAllowed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('BEGIN PRIVATE KEY');
  });
  it.each([
    'unconfigured-pin',
    'predeclaration-json',
    'population-json',
    'requests-substituted',
    'losing-holdout',
    'rollback-json',
    'source-changed',
    'extra-gate',
    'producer-substituted',
    'current-generation-advanced',
    'current-control-changed',
    'current-control-changed-during-review',
  ])('refuses %s before reading any signing credential', async (fault) => {
    const key = keyEnvironment(),
      input = request();
    if (fault === 'current-generation-advanced') control.advanceGeneration = true;
    if (fault === 'current-control-changed-during-review') control.finalControlChanged = true;
    if (fault === 'current-control-changed') control.controlChanged = true;
    if (fault === 'unconfigured-pin') control.pin = null;
    if (fault === 'predeclaration-json')
      control.predeclaration = JSON.parse(JSON.stringify(control.predeclaration));
    if (fault === 'population-json')
      control.population = JSON.parse(JSON.stringify(control.population));
    if (fault === 'requests-substituted') input.producerRequestsDigest = 'f'.repeat(64);
    if (fault === 'losing-holdout') {
      const measurement = control.review!.measurement;
      if (!measurement || !('lowerGainBb' in measurement))
        throw Error('expected genuine cash measurement fixture');
      measurement.lowerGainBb = -0.1;
    }
    if (fault === 'rollback-json') control.rollback = JSON.parse(JSON.stringify(control.rollback));
    if (fault === 'source-changed') control.changeSource = true;
    if (fault === 'extra-gate')
      control.review!.requiredBeforeIssuance = [
        ...control.review!.requiredBeforeIssuance,
        'new-prerequisite',
      ];
    if (fault === 'producer-substituted')
      (control.predeclaration!.plan as unknown as { producerDigest: string }).producerDigest =
        'f'.repeat(64);
    expect(await createCorrectiveKernelIssuer(key.environment)(input)).toMatchObject({
      status: 'unavailable',
      qualified: false,
      activationAllowed: false,
    });
    expect(key.reads()).toBe(0);
  });
  it('refuses a different service key even after actual proof boundaries succeed', async () => {
    const key = keyEnvironment();
    control.pin = '0'.repeat(64);
    expect(await createCorrectiveKernelIssuer(key.environment)(request())).toMatchObject({
      status: 'unavailable',
      reason: 'issuer_public_pin_mismatch',
    });
    expect(key.reads()).toBe(1);
  });
  it('rejects caller catalogs/results/qualification flags instead of signing uploaded JSON', async () => {
    const key = keyEnvironment();
    for (const extra of [{ qualified: true }, { catalog: {} }, { rollbackDigest: 'f'.repeat(64) }])
      expect(
        await createCorrectiveKernelIssuer(key.environment)({ ...request(), ...extra })
      ).toMatchObject({ status: 'unavailable', reason: 'issuer_request_invalid' });
    expect(key.reads()).toBe(0);
  });
});

import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
  TOURNAMENT_RIVER_DECISION_MODEL,
} from './kernelTournamentDefinition.js';
import {
  verifyFunctionalKernelApproval,
  validateFunctionalKernelCatalog,
} from './kernelObjective.js';
function tournamentFixture() {
  const { maximumAbsoluteDeltaBb: _cashBound, ...cash } = control.predeclaration!
    .plan as unknown as { maximumAbsoluteDeltaBb: number } & Record<string, unknown>;
  const plan = {
    ...cash,
    objective: TOURNAMENT_KERNEL_OBJECTIVE,
    utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
    domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
    producerDigest: correctiveKernelProducerDigest(
      control.source,
      control.policy,
      TOURNAMENT_KERNEL_OBJECTIVE
    ),
    maximumAbsoluteDelta: 0.05,
    modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
    policyVersion: TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
  };
  control.predeclaration!.plan = plan as never;
  control.population!.planDigest = evidenceDigest(plan);
  for (const request of control.population!.requests)
    (request.input as unknown as Record<string, unknown>).domain = plan.domain;
  control.population!.requestsDigest = correctiveKernelRequestsDigest(control.population!.requests);
  control.review!.measurement = {
    objective: TOURNAMENT_KERNEL_OBJECTIVE,
    utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
    modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
    policyVersion: TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
    status: 'measured',
    reasons: [],
    samples: 128,
    changed: 128,
    meanGain: 0.03,
    lowerGain: 0.03 - 0.05 * Math.sqrt((2 * Math.log(45 / 0.05)) / 128),
    measurementDigest: '6'.repeat(64),
    qualified: false,
    activationAllowed: false,
  } as never;
}
describe('single issuer strict tournament branch', () => {
  it('preserves every owner gate then signs v2 neutral prize-share measurement and roundtrips its production consumer', async () => {
    tournamentFixture();
    const key = keyEnvironment(),
      result = await createCorrectiveKernelIssuer(key.environment)(request());
    expect(result.status).toBe('issued_qualification');
    expect(key.reads()).toBe(1);
    expect(control.rollbackCalls).toBe(1);
    expect(control.controlCalls).toBe(2);
    expect(control.generationCalls).toBe(2);
    if (result.status !== 'issued_qualification') throw Error(result.reason);
    expect(result.qualification.schema).toBe('horse-phase14-kernel-qualification-v2');
    expect(result.qualification.approval.approval).toMatchObject({
      version: 2,
      objective: TOURNAMENT_KERNEL_OBJECTIVE,
      utilityUnit: 'prize_share',
      baselineSelectionsDigest: control.baseline,
      approvalGeneration: 8,
      measurement: { maximumAbsoluteDelta: 0.05 },
    });
    expect(result.qualification.approval.approval.measurement).not.toHaveProperty('meanGainBb');
    const verified = verifyFunctionalKernelApproval(
      result.qualification.approval,
      control.pin!,
      Date.now()
    );
    expect(verified).not.toBeNull();
    expect(
      validateFunctionalKernelCatalog(result.qualification.catalog, verified, {
        policyDigest: control.policy,
        baselineSelectionsDigest: control.baseline,
        nowMs: Date.now(),
      }).status
    ).toBe('validated');
    expect(result.activationAllowed).toBe(false);
  });
  it.each(['mixed-measurement', 'cash-producer', 'negative-holdout', 'wrong-model'] as const)(
    'refuses tournament %s before purpose key access',
    async (fault) => {
      tournamentFixture();
      const key = keyEnvironment();
      if (fault === 'mixed-measurement')
        (control.review!.measurement as unknown as Record<string, unknown>).meanGainBb = 1;
      if (fault === 'cash-producer')
        (control.predeclaration!.plan as unknown as Record<string, unknown>).producerDigest =
          correctiveKernelProducerDigest(control.source, control.policy);
      if (fault === 'negative-holdout')
        (control.review!.measurement as unknown as Record<string, unknown>).lowerGain = -0.01;
      if (fault === 'wrong-model')
        (control.review!.measurement as unknown as Record<string, unknown>).modelVersion =
          RIVER_DECISION_MODEL.version;
      expect(await createCorrectiveKernelIssuer(key.environment)(request())).toMatchObject({
        status: 'unavailable',
        qualified: false,
        activationAllowed: false,
      });
      expect(key.reads()).toBe(0);
    }
  );
});

import {
  CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL,
  CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
function closedLadderFixture() {
  tournamentFixture();
  const plan = control.predeclaration!.plan;
  Object.assign(plan, {
    objective: CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
    domain: { variant: 'nlh', format: 'mtt', mode: 'tournament' },
    modelVersion: CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL.version,
    policyVersion: CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
    producerDigest: correctiveKernelProducerDigest(
      control.source,
      control.policy,
      CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE
    ),
  });
  control.population!.planDigest = evidenceDigest(plan);
  for (const request of control.population!.requests)
    (request.input as unknown as Record<string, unknown>).domain = plan.domain;
  control.population!.requestsDigest = correctiveKernelRequestsDigest(control.population!.requests);
  Object.assign(control.review!.measurement!, {
    objective: CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
    modelVersion: CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL.version,
    policyVersion: CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
  });
}
it('issues the registered closed-HU ladder protocol through the same independently gated issuer', async () => {
  closedLadderFixture();
  const key = keyEnvironment(),
    result = await createCorrectiveKernelIssuer(key.environment)(request());
  expect(result.status).toBe('issued_qualification');
  expect(key.reads()).toBe(1);
  if (result.status !== 'issued_qualification') throw Error(result.reason);
  expect(result.qualification.approval.approval).toMatchObject({
    objective: CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
    domain: { variant: 'nlh', format: 'mtt', mode: 'tournament' },
    modelVersion: CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL.version,
    kernelVersion: CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
  });
  const checked = verifyFunctionalKernelApproval(
    result.qualification.approval,
    control.pin!,
    Date.now()
  );
  expect(checked).not.toBeNull();
  expect(
    validateFunctionalKernelCatalog(result.qualification.catalog, checked, {
      policyDigest: control.policy,
      baselineSelectionsDigest: control.baseline,
      nowMs: Date.now(),
    }).status
  ).toBe('validated');
  expect(control.rollbackCalls).toBe(1);
  expect(control.controlCalls).toBe(2);
  expect(control.generationCalls).toBe(2);
  expect(
    correctiveKernelProducerDigest(
      control.source,
      control.policy,
      CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE
    )
  ).not.toBe(
    correctiveKernelProducerDigest(control.source, control.policy, TOURNAMENT_KERNEL_OBJECTIVE)
  );
});
it('refuses a closed-family plan paired with a WTA model measurement before key access', async () => {
  closedLadderFixture();
  Object.assign(control.review!.measurement!, {
    modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
  });
  const key = keyEnvironment();
  expect(await createCorrectiveKernelIssuer(key.environment)(request())).toMatchObject({
    status: 'unavailable',
    qualified: false,
  });
  expect(key.reads()).toBe(0);
});
