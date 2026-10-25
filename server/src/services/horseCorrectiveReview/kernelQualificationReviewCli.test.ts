import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHorseCorrectiveKernelReview } from '../../scripts/horseCorrectiveKernelReview.js';
import type { CorrectiveKernelEvidenceReview } from './kernelQualificationReview.js';
import { readCorrectivePredeclaration } from './kernelPredeclaration.js';
import { RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { RIVER_CORRECTION_KERNEL } from './kernelDefinition.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'kernel-review-cli-'));
  dirs.push(dir);
  const input = join(dir, 'input.json'),
    output = join(dir, 'output.json');
  const plan = {
    populationBasis: 'accepted-commit-and-immutable-played-v1',
    sourceRelease: '1'.repeat(40),
    producerDigest: 'a'.repeat(64),
    qualificationId: 'future-reviewed-policy',
    evidenceClass: 'reviewed_reference',
    modelVersion: RIVER_DECISION_MODEL.version,
    policyVersion: RIVER_CORRECTION_KERNEL.version,
    declaredAt: '2026-10-25T00:00:00.000Z',
    holdoutStartsAt: '2026-10-26T00:00:00.000Z',
    holdoutEndsAt: '2026-10-27T00:00:00.000Z',
    selectionHandKeys: ['b'.repeat(64)],
    minimumSamples: 100,
    maximumAbsoluteDeltaBb: 5,
    familyWiseAlpha: 0.05,
    familySize: 45,
  };
  const bytes = Buffer.from(JSON.stringify(plan));
  const predeclaration = {
    commitSha: '2'.repeat(40),
    path: 'docs/evidence/phase14/plans/future-v1.json',
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const value = {
    version: 1,
    predeclaration,
    requests: [{ private: 'original-record-1' }, { private: 'original-record-2' }],
  };
  writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
  const replies: unknown[] = [
    { name: 'main', protected: true, commit: { sha: '3'.repeat(40) } },
    {
      status: 'ahead',
      base_commit: { sha: predeclaration.commitSha },
      merge_base_commit: { sha: predeclaration.commitSha },
    },
    [
      {
        state: 'closed',
        number: 123,
        merge_commit_sha: predeclaration.commitSha,
        merged_at: '2026-10-25T01:00:00Z',
        base: { ref: 'main', repo: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' } },
      },
    ],
    {
      type: 'file',
      path: predeclaration.path,
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
  const custody = readCorrectivePredeclaration(predeclaration, () => replies.shift());
  if (custody.status !== 'authenticated_predeclaration')
    throw Error('synthetic protected plan fixture');
  const reader = vi.fn(() => custody);
  return { dir, input, output, value, plan, custody, reader };
}
const reviewed: CorrectiveKernelEvidenceReview = {
  version: 'horse-corrective-kernel-evidence-review-v1',
  status: 'reviewed_unsigned',
  reason: 'independent_issuance_gates_unavailable',
  checkedCases: 2,
  reviewDigest: 'a'.repeat(64),
  sourceCustodyDigest: 'b'.repeat(64),
  numericReviewDigest: 'c'.repeat(64),
  predeclarationDigest: 'd'.repeat(64),
  measurement: null,
  requiredBeforeIssuance: [
    'complete_source_window_census',
    'qualified_rollback',
    'independently_held_signer',
  ],
  qualified: false,
  completePopulation: false,
  activationAllowed: false,
};
describe('explicit private aggregate review operator', () => {
  it('authenticates the protected plan then awaits the reviewer, writing private output and status-only stdout', async () => {
    const s = setup();
    let finish!: (value: CorrectiveKernelEvidenceReview) => void;
    const reviewer = vi.fn(
      () =>
        new Promise<CorrectiveKernelEvidenceReview>((resolve) => {
          finish = resolve;
        })
    );
    const pending = runHorseCorrectiveKernelReview(
      [s.input, s.output],
      { DATABASE_URL: 'must-not-appear' },
      reviewer,
      s.reader
    );
    expect(s.reader).toHaveBeenCalledWith(s.value.predeclaration);
    expect(reviewer).toHaveBeenCalledWith(s.plan, s.value.requests, s.custody.predeclaration);
    expect(existsSync(s.output)).toBe(false);
    finish(reviewed);
    const result = await pending;
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toEqual(reviewed);
    expect(statSync(s.output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(result.output)).toEqual({
      status: 'reviewed_unsigned',
      outputWritten: true,
      qualified: false,
      completePopulation: false,
      activationAllowed: false,
    });
    expect(result.output).not.toMatch(/original-record|must-not-appear|reviewDigest|measurement/);
  });
  it('writes unknown provider custody as unavailable before source review rather than trusting uploaded plan JSON', async () => {
    const s = setup(),
      reviewer = vi.fn(async () => reviewed);
    const result = await runHorseCorrectiveKernelReview([s.input, s.output], {}, reviewer, () => ({
      status: 'unavailable',
      reason: 'predeclaration_provider_unavailable',
      qualified: false,
      activationAllowed: false,
    }));
    expect(result.code).toBe(2);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({
      status: 'unavailable',
      reason: 'predeclaration_provider_unavailable',
      predeclarationDigest: null,
    });
    expect(reviewer).not.toHaveBeenCalled();
  });
  it('preserves unavailable review and refuses a forged qualification response', async () => {
    const s = setup(),
      unavailable = {
        ...reviewed,
        status: 'unavailable' as const,
        reviewDigest: null,
        reason: 'review_exact_replay_refused',
      };
    expect(
      (
        await runHorseCorrectiveKernelReview(
          [s.input, s.output],
          {},
          async () => unavailable,
          s.reader
        )
      ).code
    ).toBe(2);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toEqual(unavailable);
    const other = setup();
    expect(
      (
        await runHorseCorrectiveKernelReview(
          [other.input, other.output],
          {},
          async () => ({ ...reviewed, qualified: true }) as never,
          other.reader
        )
      ).code
    ).toBe(3);
    expect(existsSync(other.output)).toBe(false);
  });
  it('refuses existing output, shared input and caller authority fields before any provider/reviewer call', async () => {
    const reviewer = vi.fn(async () => reviewed),
      existing = setup();
    writeFileSync(existing.output, 'original', { mode: 0o600 });
    expect(
      (
        await runHorseCorrectiveKernelReview(
          [existing.input, existing.output],
          {},
          reviewer,
          existing.reader
        )
      ).code
    ).toBe(3);
    expect(readFileSync(existing.output, 'utf8')).toBe('original');
    expect(existing.reader).not.toHaveBeenCalled();
    const shared = setup();
    chmodSync(shared.input, 0o644);
    expect(
      (
        await runHorseCorrectiveKernelReview(
          [shared.input, shared.output],
          {},
          reviewer,
          shared.reader
        )
      ).code
    ).toBe(3);
    expect(shared.reader).not.toHaveBeenCalled();
    const forged = setup();
    writeFileSync(forged.input, JSON.stringify({ ...forged.value, qualified: true }));
    expect(
      (
        await runHorseCorrectiveKernelReview(
          [forged.input, forged.output],
          {},
          reviewer,
          forged.reader
        )
      ).code
    ).toBe(3);
    expect(forged.reader).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
  });
  it('requires explicit paths and contains private dependency errors', async () => {
    const s = setup(),
      reviewer = vi.fn(async () => {
        throw Error('private credentials or cards');
      });
    for (const args of [[], ['relative', 'other'], [s.input, s.output, '--sign']])
      expect((await runHorseCorrectiveKernelReview(args, {}, reviewer, s.reader)).code).toBe(64);
    const result = await runHorseCorrectiveKernelReview(
      [s.input, s.output],
      {},
      reviewer,
      s.reader
    );
    expect(result.code).toBe(3);
    expect(result.output).not.toMatch(/credentials|cards/);
    expect(existsSync(s.output)).toBe(false);
  });
});
