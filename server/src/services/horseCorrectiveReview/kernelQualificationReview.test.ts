import { createHash } from 'node:crypto';
import { readCorrectivePredeclaration } from './kernelPredeclaration.js';
import { describe, expect, it, vi } from 'vitest';
import {
  createCorrectiveKernelEvidenceReviewer,
  CORRECTIVE_KERNEL_UNRESOLVED_GATES,
} from './kernelQualificationReview.js';
import { riverReferenceFixture, bind } from './riverReference.test-support.js';
import { evidenceDigest } from './authority.js';
import { makeHorseJournalRecord } from '../horseDecisionJournal/record.js';
import { correctiveReferenceBinding } from './review.js';
import { RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { RIVER_CORRECTION_KERNEL } from './kernelDefinition.js';
import type { RiverModelHoldoutPlan } from './riverModelHoldout.js';
import { createRiverAcceptedOracleReader } from './riverAcceptedOracle.js';
import type {
  RiverAcceptedOracleRequest,
  RiverAcceptedOracleResult,
} from './riverAcceptedOracle.js';
import type { exactReplayHorseDecisionRecord } from '../../engine/horseDecision/replay/exactReplay.js';
const SOURCE = '1'.repeat(40);
function plan(): RiverModelHoldoutPlan {
  return {
    sourceRelease: SOURCE,
    producerDigest: 'a'.repeat(64),
    qualificationId: 'qualification-required',
    evidenceClass: 'synthetic_fixture',
    modelVersion: RIVER_DECISION_MODEL.version,
    policyVersion: RIVER_CORRECTION_KERNEL.version,
    declaredAt: '2026-10-24T00:00:00.000Z',
    holdoutStartsAt: '2026-10-25T00:00:00.000Z',
    holdoutEndsAt: '2026-10-26T00:00:00.000Z',
    selectionHandKeys: [evidenceDigest('selection')],
    minimumSamples: 2,
    maximumAbsoluteDeltaBb: 5,
    familyWiseAlpha: 0.05,
    familySize: 45,
  };
}
/** Unit seams supply synthetic acquisition/replay outcomes only. Existing
 * oracle and exact-runtime suites separately test those actual owners. */
function request(n: number): RiverAcceptedOracleRequest {
  const input = riverReferenceFixture();
  input.stack = 200;
  bind(input);
  input.original.snapshot.requestId += n;
  const handKey = evidenceDigest(['synthetic-hand', n]);
  const make = (
    kind: 'decision' | 'execution' | 'accepted_hand',
    sequence: number,
    payload: unknown
  ) =>
    makeHorseJournalRecord(
      {
        producerId: '40000000-0000-4000-8000-000000000001',
        sequence,
        atMs: 2000,
        sourceRelease: SOURCE,
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : evidenceDigest(['turn', n]),
      },
      payload
    );
  const decision = make('decision', n * 3 + 1, {
    snapshot: input.original.snapshot,
    readFrame: input.original.readFrame,
    decision: { action: 'fold', thinkTime: 0 },
  });
  const execution = make('execution', n * 3 + 2, {}),
    accepted = make('accepted_hand', n * 3 + 3, {});
  input.binding = correctiveReferenceBinding(decision, execution, accepted);
  input.rangeReadFrameDigest = input.binding.readFrameDigest;
  return { handKey, input, records: [decision, execution, accepted] };
}
const requests = () => [request(0), request(1)];
function dependencies() {
  const readOracle = vi.fn(
    async (_request: RiverAcceptedOracleRequest): Promise<RiverAcceptedOracleResult> => ({
      version: 1,
      status: 'accepted_source_oracle',
      playedAt: '2026-10-25T01:00:00.000Z',
      committedAt: '2026-10-25T01:00:01.000Z',
      oracle: { foldBb: 0, callBb: 48 },
      custodyDigest: 'c'.repeat(64),
      oracleDigest: 'd'.repeat(64),
      qualified: false,
      completePopulation: false,
      activationAllowed: false,
    })
  );
  const replay = vi.fn(async (record: unknown) => {
    const r = record as RiverAcceptedOracleRequest['records'][number];
    return {
      outcome: 'replayed_exact',
      replayVerified: true,
      recordSha256: r.sha256,
      recordedSource: SOURCE,
      runningSource: SOURCE,
      acceptance: {
        status: 'joined',
        selectedEqualsDecision: true,
        executionStatus: 'intended',
        durableEffectReceipt: 'no_effects',
      },
    } as Awaited<ReturnType<typeof exactReplayHorseDecisionRecord>>;
  });
  return { runningSource: SOURCE, readOracle, replay };
}
describe('finite unsigned aggregate corrective evidence review', () => {
  it('accepts only a genuine protected-plan capability and retires only that issuance gate', async () => {
    const p = { ...plan(), populationBasis: 'accepted-commit-and-immutable-played-v1' };
    const bytes = Buffer.from(JSON.stringify(p)),
      commitSha = '2'.repeat(40),
      path = 'docs/evidence/phase14/plans/future-v1.json';
    const replies: unknown[] = [
      { name: 'main', protected: true, commit: { sha: '3'.repeat(40) } },
      { status: 'ahead', base_commit: { sha: commitSha }, merge_base_commit: { sha: commitSha } },
      [
        {
          state: 'closed',
          number: 123,
          merge_commit_sha: commitSha,
          merged_at: '2026-10-24T01:00:00Z',
          base: { ref: 'main', repo: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' } },
        },
      ],
      {
        type: 'file',
        path,
        encoding: 'base64',
        content: bytes.toString('base64'),
        size: bytes.length,
      },
      {
        status: 'ahead',
        base_commit: { sha: '1'.repeat(40) },
        merge_base_commit: { sha: '1'.repeat(40) },
      },
    ];
    const custody = readCorrectivePredeclaration(
      { commitSha, path, contentSha256: createHash('sha256').update(bytes).digest('hex') },
      () => replies.shift()
    );
    if (custody.status !== 'authenticated_predeclaration')
      throw Error('synthetic provider fixture');
    const reviewer = createCorrectiveKernelEvidenceReviewer({}, dependencies());
    const result = await reviewer(p, requests(), custody.predeclaration);
    expect(result.status).toBe('reviewed_unsigned');
    expect(result.predeclarationDigest).toBe(custody.predeclaration.custodyDigest);
    expect(result.requiredBeforeIssuance).not.toContain('authenticated_predeclaration');
    expect(result.requiredBeforeIssuance).toContain('complete_source_window_census');
    expect(result.qualified).toBe(false);
    expect(
      await reviewer(p, requests(), JSON.parse(JSON.stringify(custody.predeclaration)))
    ).toMatchObject({
      status: 'unavailable',
      reason: 'review_predeclaration_refused',
      predeclarationDigest: null,
    });
    expect(
      await reviewer({ ...p, minimumSamples: 3 }, requests(), custody.predeclaration)
    ).toMatchObject({ status: 'unavailable', reason: 'review_predeclaration_refused' });
  });
  it('refuses a commit-clock row outside the predeclared intersection', async () => {
    const deps = dependencies();
    deps.readOracle.mockResolvedValue({
      ...(await deps.readOracle(request(0))),
      committedAt: '2026-10-26T00:00:00.000Z',
    } as RiverAcceptedOracleResult);
    expect(
      await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), requests())
    ).toMatchObject({
      status: 'unavailable',
      reason: 'review_commit_window_mismatch',
      reviewDigest: null,
    });
  });

  it('refuses unknown or different independently configured source before replay', async () => {
    for (const runningSource of [null, '2'.repeat(40)]) {
      const deps = { ...dependencies(), runningSource };
      expect(
        await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), requests())
      ).toMatchObject({
        status: 'unavailable',
        reason: 'review_running_source_identity_unavailable',
      });
      expect(deps.replay).not.toHaveBeenCalled();
      expect(deps.readOracle).not.toHaveBeenCalled();
    }
  });
  it('rebuilds model/numerics and holdout from direct dependency reads, retaining all issuance gates', async () => {
    const deps = dependencies(),
      rows = requests();
    const result = await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), rows);
    expect(result).toMatchObject({
      status: 'reviewed_unsigned',
      checkedCases: 2,
      reason: 'independent_issuance_gates_unavailable',
      qualified: false,
      completePopulation: false,
      activationAllowed: false,
      measurement: { status: 'measured', samples: 2, changed: 2 },
    });
    expect(result.requiredBeforeIssuance).toEqual(CORRECTIVE_KERNEL_UNRESOLVED_GATES);
    expect(result.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      deps.replay.mock.calls.map((call) => (call[0] as (typeof rows)[0]['records'][0]).sha256)
    ).toEqual(rows.map((row) => row.input.binding.decisionDigest));
    expect(deps.readOracle).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/spades|declaredRange|password|"snapshot"|"hero"/);
  });
  it.each([
    'non_replayable:original_source',
    'non_replayable:original_runtime',
    'replayed_mismatch',
  ])('refuses %s before any oracle query', async (outcome) => {
    const deps = dependencies();
    deps.replay.mockResolvedValue({ outcome, replayVerified: false } as Awaited<
      ReturnType<typeof exactReplayHorseDecisionRecord>
    >);
    const result = await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), requests());
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'review_exact_replay_refused',
      reviewDigest: null,
    });
    expect(deps.readOracle).not.toHaveBeenCalled();
  });
  it('does not accept caller oracle, replay, timestamps or qualification flags', async () => {
    for (const addition of [
      { oracle: { foldBb: 0, callBb: 500 } },
      { playedAt: '2026-10-25T01:00:00.000Z' },
      { qualified: true },
      { replayVerified: true },
    ]) {
      const deps = dependencies(),
        rows = requests();
      Object.assign(rows[0], addition);
      expect(await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), rows)).toMatchObject({
        status: 'unavailable',
        reason: 'review_input_unreadable',
      });
      expect(deps.replay).not.toHaveBeenCalled();
      expect(deps.readOracle).not.toHaveBeenCalled();
    }
  });
  it('uses authenticated oracle time and refuses a window mismatch rather than dropping the hand', async () => {
    const deps = dependencies();
    deps.readOracle.mockResolvedValue({
      ...(await deps.readOracle(request(0))),
      playedAt: '2026-10-24T23:59:59.999Z',
    } as RiverAcceptedOracleResult);
    const result = await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), requests());
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'review_holdout_refused',
      reviewDigest: null,
    });
  });
  it('refuses old oracle results with no authenticated timestamp', async () => {
    const deps = dependencies(),
      oracle = await deps.readOracle(request(0));
    delete (oracle as { playedAt?: string }).playedAt;
    deps.readOracle.mockResolvedValue(oracle);
    expect(
      await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), requests())
    ).toMatchObject({
      reason: 'review_authenticated_window_time_unavailable',
      reviewDigest: null,
    });
  });
  it('refuses missing original source binding and never promotes a partial batch', async () => {
    const deps = dependencies(),
      rows = requests();
    rows[1].input.binding.decisionDigest = '0'.repeat(64);
    const result = await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), rows);
    expect(result).toMatchObject({
      status: 'unavailable',
      checkedCases: 1,
      reason: 'review_original_binding_refused',
      reviewDigest: null,
      sourceCustodyDigest: null,
    });
  });
  it('contains dependency errors and keeps absent acquisition credentials unavailable', async () => {
    const deps = dependencies();
    deps.replay.mockRejectedValue(Error('secret private error'));
    expect(
      await createCorrectiveKernelEvidenceReviewer({}, deps)(plan(), requests())
    ).toMatchObject({
      status: 'unavailable',
      reason: 'review_dependency_unavailable',
      reviewDigest: null,
    });
    const missingCredentials = await createCorrectiveKernelEvidenceReviewer(
      {},
      {
        ...dependencies(),
        readOracle: createRiverAcceptedOracleReader({}),
      }
    )(plan(), requests());
    expect(missingCredentials).toMatchObject({
      status: 'unavailable',
      reason: 'review_authenticated_oracle_refused',
      reviewDigest: null,
    });
  });
  it('refuses empty or oversized batches before dependency work', async () => {
    const deps = dependencies(),
      review = createCorrectiveKernelEvidenceReviewer({}, deps);
    for (const rows of [[], Array(10001).fill(null)])
      expect(await review(plan(), rows)).toMatchObject({
        status: 'unavailable',
        reason: 'review_input_bounds',
      });
    expect(deps.replay).not.toHaveBeenCalled();
    expect(deps.readOracle).not.toHaveBeenCalled();
  });
});
