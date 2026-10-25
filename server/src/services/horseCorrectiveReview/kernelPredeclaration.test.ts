import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  readCorrectivePredeclaration,
  isAuthenticatedCorrectivePredeclaration,
} from './kernelPredeclaration.js';
import { RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { RIVER_CORRECTION_KERNEL } from './kernelDefinition.js';
function fixture() {
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
  const request = {
    commitSha: '2'.repeat(40),
    path: 'docs/evidence/phase14/plans/future-v1.json',
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const replies: unknown[] = [
    { name: 'main', protected: true, commit: { sha: '3'.repeat(40) } },
    {
      status: 'ahead',
      base_commit: { sha: request.commitSha },
      merge_base_commit: { sha: request.commitSha },
    },
    [
      {
        state: 'closed',
        number: 123,
        merge_commit_sha: request.commitSha,
        merged_at: '2026-10-25T01:00:00Z',
        base: { ref: 'main', repo: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' } },
      },
    ],
    {
      type: 'file',
      path: request.path,
      encoding: 'base64',
      content: bytes.toString('base64') + '\n',
      size: bytes.length,
    },
    {
      status: 'ahead',
      base_commit: { sha: '1'.repeat(40) },
      merge_base_commit: { sha: '1'.repeat(40) },
    },
  ];
  const api = vi.fn((_path: string) => replies[api.mock.calls.length - 1]);
  return { request, replies, api, plan };
}
describe('authenticated protected-provider predeclaration', () => {
  it('binds actual mergedAt and exact immutable plan bytes, separately from engine component source', () => {
    const f = fixture(),
      result = readCorrectivePredeclaration(f.request, f.api);
    expect(result.status).toBe('authenticated_predeclaration');
    if (result.status !== 'authenticated_predeclaration')
      throw Error('expected synthetic provider fixture');
    expect(result.predeclaration).toMatchObject({
      commitSha: f.request.commitSha,
      plan: { sourceRelease: '1'.repeat(40) },
      mergedAt: '2026-10-25T01:00:00.000Z',
      pullRequest: 123,
    });
    expect(isAuthenticatedCorrectivePredeclaration(result.predeclaration)).toBe(true);
    expect(
      isAuthenticatedCorrectivePredeclaration(JSON.parse(JSON.stringify(result.predeclaration)))
    ).toBe(false);
    expect(Object.isFrozen(result.predeclaration.plan.selectionHandKeys)).toBe(true);
    expect(f.api.mock.calls.map((call) => call[0])).toEqual([
      `repos/Smarter-Poker/Smarter-Poker-Club-Arena/branches/main`,
      `repos/Smarter-Poker/Smarter-Poker-Club-Arena/compare/${f.request.commitSha}...${'3'.repeat(40)}`,
      `repos/Smarter-Poker/Smarter-Poker-Club-Arena/commits/${f.request.commitSha}/pulls?per_page=100`,
      `repos/Smarter-Poker/Smarter-Poker-Club-Arena/contents/${f.request.path}?ref=${f.request.commitSha}`,
      `repos/Smarter-Poker/Smarter-Poker-Club-Arena/compare/${'1'.repeat(40)}...${f.request.commitSha}`,
    ]);
    expect(result).toMatchObject({ qualified: false, activationAllowed: false });
  });
  it.each([
    'unprotected',
    'other-ancestor',
    'late-merge',
    'other-pr-source',
    'other-file',
    'tampered-bytes',
    'wrong-base',
    'unprotected-engine',
  ])('refuses %s instead of trusting declaredAt or caller hash', (fault) => {
    const f = fixture();
    if (fault === 'unprotected-engine')
      (f.replies[4] as Record<string, unknown>).status = 'diverged';
    if (fault === 'unprotected') (f.replies[0] as Record<string, unknown>).protected = false;
    if (fault === 'other-ancestor')
      (f.replies[1] as Record<string, unknown>).merge_base_commit = { sha: '0'.repeat(40) };
    if (fault === 'late-merge')
      (f.replies[2] as Record<string, unknown>[])[0].merged_at = '2026-10-26T00:00:00Z';
    if (fault === 'other-pr-source')
      (f.replies[2] as Record<string, unknown>[])[0].merge_commit_sha = '0'.repeat(40);
    if (fault === 'wrong-base')
      (f.replies[2] as Record<string, unknown>[])[0].base = {
        ref: 'other',
        repo: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' },
      };
    if (fault === 'other-file')
      (f.replies[3] as Record<string, unknown>).path =
        'docs/evidence/phase14/plans/substituted.json';
    if (fault === 'tampered-bytes')
      (f.replies[3] as Record<string, unknown>).content = Buffer.from('{}').toString('base64');
    expect(readCorrectivePredeclaration(f.request, f.api)).toMatchObject({
      status: 'unavailable',
      qualified: false,
      activationAllowed: false,
    });
  });
  it('contains unknown/auth errors and refuses path/ref injection before provider access', () => {
    const f = fixture(),
      api = vi.fn(() => {
        throw Error('private auth or transport detail');
      });
    expect(readCorrectivePredeclaration(f.request, api)).toMatchObject({
      status: 'unavailable',
      reason: 'predeclaration_provider_unavailable',
    });
    const untouched = vi.fn();
    for (const request of [
      { ...f.request, path: 'docs/evidence/phase14/plans/../policy.json' },
      { ...f.request, commitSha: 'main?ref=other' },
      { ...f.request, qualified: true },
    ])
      expect(readCorrectivePredeclaration(request, untouched)).toMatchObject({
        status: 'unavailable',
        reason: 'predeclaration_request_invalid',
      });
    expect(untouched).not.toHaveBeenCalled();
  });
  it('refuses a malformed future plan even when its provider hash agrees', () => {
    const f = fixture(),
      bytes = Buffer.from(JSON.stringify({ ...f.plan, minimumSamples: 10001 }));
    f.request.contentSha256 = createHash('sha256').update(bytes).digest('hex');
    Object.assign(f.replies[3] as object, {
      content: bytes.toString('base64'),
      size: bytes.length,
    });
    expect(readCorrectivePredeclaration(f.request, f.api)).toMatchObject({
      status: 'unavailable',
      reason: 'predeclaration_plan_invalid',
    });
  });
});
