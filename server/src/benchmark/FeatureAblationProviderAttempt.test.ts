import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateFeatureAblationProviderAttempt } from './IncrementalPressureQualification.js';
const repository = { id: 1132369872, full_name: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena' };
const createdAt = '2026-10-29T10:00:00.000Z';
function fixture() {
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: repository.full_name,
    GITHUB_REPOSITORY_ID: String(repository.id),
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_TOKEN: 'structural-fixture-not-a-credential',
  }))
    vi.stubEnv(key, value);
  const operation = {
    providerRunId: '123',
    runAttempt: 1,
    jobId: '456',
    createdAt,
    createdAtSource: 'job.created_at',
  };
  const job: Record<string, unknown> = {
    id: 456,
    run_id: 123,
    run_attempt: 1,
    name: 'Cell original-cell',
    created_at: createdAt,
  };
  const run: Record<string, unknown> = {
    id: 123,
    repository: { ...repository },
    path: '.github/workflows/horse-feature-ablation-qualification.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    created_at: '2026-10-29T09:59:00.000Z',
  };
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    expect(options.signal).toBeInstanceOf(AbortSignal);
    if (url.endsWith('/actions/jobs/456')) return { ok: true, json: async () => job };
    if (url.endsWith('/actions/runs/123')) return { ok: true, json: async () => run };
    throw Error('Unexpected provider URL');
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    operation,
    job,
    run,
    fetcher,
    verify: () => authenticateFeatureAblationProviderAttempt(operation, 'original-cell', 1),
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('actual original cell provider boundary', () => {
  it('accepts valid transferred repository job metadata before any deal', async () => {
    const f = fixture();
    await expect(f.verify()).resolves.toBeUndefined();
    expect(f.fetcher.mock.calls.map(([url]) => url).sort()).toEqual([
      `https://api.github.com/repos/${repository.full_name}/actions/jobs/456`,
      `https://api.github.com/repos/${repository.full_name}/actions/runs/123`,
    ]);
  });
  it('accepts valid transferred repository run timestamp only when the job lacks one', async () => {
    const f = fixture();
    delete f.job.created_at;
    f.operation.createdAt = String(f.run.created_at);
    f.operation.createdAtSource = 'run.created_at';
    await expect(f.verify()).resolves.toBeUndefined();
  });
  it.each([
    ['GITHUB_REPOSITORY', 'Smarter-Poker/Smarter-Poker-Club-Arena'],
    ['GITHUB_REPOSITORY', 'foreign/Smarter-Poker-Club-Arena'],
    ['GITHUB_REPOSITORY_ID', undefined],
    ['GITHUB_REPOSITORY_ID', '1132369873'],
    ['GITHUB_RUN_ID', '124'],
    ['GITHUB_RUN_ATTEMPT', '2'],
    ['GITHUB_TOKEN', ''],
  ])('refuses workflow substitution %s=%s before access', async (name, value) => {
    const f = fixture();
    vi.stubEnv(name!, value);
    await expect(f.verify()).rejects.toThrow('Actual provider attempt unavailable');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('refuses original attempts above the locked maximum before access', async () => {
    const f = fixture();
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2');
    f.operation.runAttempt = 2;
    await expect(f.verify()).rejects.toThrow('Actual provider attempt unavailable');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('refuses malformed original job ids before access', async () => {
    const f = fixture();
    f.operation.jobId = 'foreign';
    await expect(f.verify()).rejects.toThrow('Actual provider attempt unavailable');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    { full_name: repository.full_name },
    { ...repository, id: 1132369873 },
    { ...repository, id: '1132369872' },
    { ...repository, full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' },
    { ...repository, full_name: 'foreign' },
  ])('refuses original API repository substitution %j', async (identity) => {
    const f = fixture();
    f.run.repository = identity;
    await expect(f.verify()).rejects.toThrow('Original provider job identity mismatch');
  });
  it.each([
    ['job', 'id', 457],
    ['job', 'run_id', 124],
    ['job', 'run_attempt', 2],
    ['job', 'name', 'Cell another-cell'],
    ['job', 'created_at', '2026-10-29T10:01:00.000Z'],
    ['run', 'id', 124],
    ['run', 'id', undefined],
    ['run', 'path', '.github/workflows/foreign.yml'],
    ['run', 'event', 'pull_request'],
    ['run', 'head_branch', 'foreign'],
  ])('refuses original %s.%s substitution', async (owner, field, value) => {
    const f = fixture();
    (owner === 'job' ? f.job : f.run)[field] = value;
    await expect(f.verify()).rejects.toThrow('Original provider job identity mismatch');
  });
  it('refuses a run-time fallback substituted for an existing job timestamp', async () => {
    const f = fixture();
    f.operation.createdAt = String(f.run.created_at);
    f.operation.createdAtSource = 'run.created_at';
    await expect(f.verify()).rejects.toThrow('Original provider job identity mismatch');
  });
  it('refuses timestamp source substitution when the time is unchanged', async () => {
    const f = fixture();
    f.operation.createdAtSource = 'run.created_at';
    await expect(f.verify()).rejects.toThrow('Original provider job identity mismatch');
  });
  it('refuses unreadable original provider responses', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(f.verify()).rejects.toThrow('Provider identity read refused');
  });
  it.each([null, [], 'foreign'])('refuses provider response shape %j', async (body) => {
    const f = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => body }))
    );
    await expect(f.verify()).rejects.toThrow('Provider identity shape refused');
  });
});
