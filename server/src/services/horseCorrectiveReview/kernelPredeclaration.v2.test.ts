import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  readCorrectivePredeclaration,
  isAuthenticatedCorrectivePredeclaration,
} from './kernelPredeclaration.js';
import { RIVER_DECISION_MODEL, RIVER_CORRECTION_KERNEL } from './kernelDefinition.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  TOURNAMENT_RIVER_DECISION_MODEL,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
function fixture(tournament = true, patch: Record<string, unknown> = {}) {
  const plan = {
    populationBasis: 'accepted-commit-and-immutable-played-v1',
    domain: { variant: 'nlh', format: 'cash', mode: 'cash' },
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
  const value: Record<string, unknown> = { ...plan };
  if (tournament) {
    delete value.maximumAbsoluteDeltaBb;
    Object.assign(value, {
      objective: TOURNAMENT_KERNEL_OBJECTIVE,
      utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
      domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
      modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
      policyVersion: TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
      maximumAbsoluteDelta: 0.05,
    });
  }
  Object.assign(value, patch);
  const bytes = Buffer.from(JSON.stringify(value));
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

describe('protected-provider strict tournament predeclaration adapter', () => {
  it('authenticates exact immutable v2 plan bytes and freezes detached plan/domain/selection without trusting copies', () => {
    const f = fixture(),
      r = readCorrectivePredeclaration(f.request, f.api);
    expect(r.status).toBe('authenticated_predeclaration');
    if (r.status !== 'authenticated_predeclaration') throw Error(r.reason);
    expect(r.predeclaration.plan).toMatchObject({
      objective: TOURNAMENT_KERNEL_OBJECTIVE,
      utilityUnit: 'prize_share',
      maximumAbsoluteDelta: 0.05,
    });
    expect(isAuthenticatedCorrectivePredeclaration(r.predeclaration)).toBe(true);
    expect(isAuthenticatedCorrectivePredeclaration(structuredClone(r.predeclaration))).toBe(false);
    expect(Object.isFrozen(r.predeclaration.plan)).toBe(true);
    expect(Object.isFrozen(r.predeclaration.plan.domain)).toBe(true);
    expect(Object.isFrozen(r.predeclaration.plan.selectionHandKeys)).toBe(true);
    expect(r).toMatchObject({ qualified: false, activationAllowed: false });
  });
  it('requires actual protected ancestry and provider merge before the future holdout', () => {
    for (const fault of ['unprotected', 'plan-ancestor', 'source-ancestor', 'late-merge']) {
      const f = fixture();
      if (fault === 'unprotected') (f.replies[0] as Record<string, unknown>).protected = false;
      if (fault === 'plan-ancestor')
        (f.replies[1] as Record<string, unknown>).merge_base_commit = { sha: '0'.repeat(40) };
      if (fault === 'source-ancestor')
        (f.replies[4] as Record<string, unknown>).status = 'diverged';
      if (fault === 'late-merge')
        (f.replies[2] as Record<string, unknown>[])[0].merged_at = '2026-10-26T00:00:00Z';
      expect(readCorrectivePredeclaration(f.request, f.api).status).toBe('unavailable');
    }
  });
  it('refuses wrong units/code versions, mixed BB fields, unknown objective and understated support even with correctly hashed provider bytes', () => {
    for (const patch of [
      { utilityUnit: 'bb' },
      { objective: 'other' },
      { modelVersion: 'river-public-finite-prior-v1' },
      { maximumAbsoluteDelta: 0.04 },
      { maximumAbsoluteDeltaBb: 1 },
    ]) {
      const f = fixture(true, patch);
      expect(readCorrectivePredeclaration(f.request, f.api).status).toBe('unavailable');
    }
  });
  it('retains unchanged cash v1 plan admission without inferring a tournament objective', () => {
    const f = fixture(false),
      r = readCorrectivePredeclaration(f.request, f.api);
    expect(r.status).toBe('authenticated_predeclaration');
    if (r.status !== 'authenticated_predeclaration') throw Error(r.reason);
    expect(r.predeclaration.plan).toEqual(f.plan);
    expect(r.predeclaration.plan).not.toHaveProperty('objective');
  });
});
