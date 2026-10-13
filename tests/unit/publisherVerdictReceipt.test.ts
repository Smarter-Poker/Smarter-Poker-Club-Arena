import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReceipt,
  mergePublisherReceipt,
  receiptName,
  validateReceipt,
  PROOFS,
} from '../../scripts/ci/publisher-verdict-receipt.mjs';
const sha = 'a'.repeat(40);
const selected = 'b'.repeat(40);
const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
function env(job = 'publish-to-origin', verdict = 'publish') {
  return {
    GITHUB_JOB: job,
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: '42',
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-club-arena.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    RECEIPT_SELECTED_SHA: selected,
    RECEIPT_RUNTIME_SHA: verdict === 'publish' ? selected : sha,
    RECEIPT_VERDICT: verdict,
    RECEIPT_CONCLUSIONS: JSON.stringify(
      job === 'retain-runtime'
        ? ['success', 'success']
        : verdict === 'publish'
          ? ['success', 'success', 'success']
          : ['success', 'skipped', 'skipped']
    ),
  };
}
function trusted(jobKey = 'publish-to-origin') {
  return {
    repositoryId: '42',
    triggerSha: sha,
    workflowSha: sha,
    run: {
      id: 123,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: sha,
      path: '.github/workflows/publish-club-arena.yml',
      repository: { id: 42, full_name: repository },
    },
    job: {
      id: 456,
      run_id: 123,
      run_attempt: 1,
      name: jobKey,
      status: 'completed',
      conclusion: 'success',
      head_sha: sha,
      steps: [] as any[],
    },
    artifact: {
      id: 789,
      expired: false,
      name: receiptName(jobKey, 1),
      workflow_run: {
        id: 123,
        repository_id: 42,
        head_repository_id: 42,
        head_sha: sha,
        head_branch: 'main',
      },
    },
  };
}
describe('original publisher verdict receipt', () => {
  it.each([
    ['publish-to-origin', 'publish'],
    ['publish-to-origin', 'standdown'],
    ['retain-runtime', 'retained'],
  ])('preserves actual %s %s conclusions', (job, verdict) => {
    const receipt = createReceipt(env(job, verdict));
    const merged = mergePublisherReceipt(receipt, trusted(job));
    expect(merged.steps).toEqual(receipt.steps);
    expect(merged.steps.map((s: any) => s.name)).toEqual(PROOFS[job]);
    expect(trusted(job).job.steps).toEqual([]);
  });
  it('writes actual validated JSON once and refuses overwriting the same attempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'publisher-verdict-test-'));
    try {
      const path = join(dir, 'receipt.json');
      const command = ['scripts/ci/publisher-verdict-receipt.mjs', 'write', path];
      execFileSync(process.execPath, command, { env: { ...process.env, ...env() } });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(createReceipt(env()));
      expect(() =>
        execFileSync(process.execPath, command, {
          env: { ...process.env, ...env() },
          stdio: 'pipe',
        })
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('preserves an earlier successful origin attempt after an optional rerun failure', () => {
    const t = trusted();
    t.run.run_attempt = 2;
    t.run.conclusion = 'failure';
    expect(mergePublisherReceipt(createReceipt(env()), t).steps).toHaveLength(3);
  });
  it('preserves completed origin proof after later optional cancellation', () => {
    const t = trusted();
    t.run.conclusion = 'cancelled';
    expect(mergePublisherReceipt(createReceipt(env()), t).steps).toHaveLength(3);
  });
  it('refuses untrusted branch, workflow and replayed artifact attempt', () => {
    const receipt = createReceipt(env());
    for (const change of [
      (t: ReturnType<typeof trusted>) => {
        t.run.head_branch = 'feature';
      },
      (t: ReturnType<typeof trusted>) => {
        t.run.path = '.github/workflows/other.yml';
      },
      (t: ReturnType<typeof trusted>) => {
        t.artifact.name = receiptName('publish-to-origin', 2);
      },
      (t: ReturnType<typeof trusted>) => {
        t.run.status = 'in_progress';
      },
    ]) {
      const t = trusted();
      change(t);
      expect(() => mergePublisherReceipt(receipt, t)).toThrow();
    }
  });
  it('never overwrites matching nonempty metadata', () => {
    const r = createReceipt(env());
    const t = trusted();
    t.job.steps = r.steps;
    expect(mergePublisherReceipt(r, t)).toBe(t.job);
  });
  it.each(['failure', 'cancelled', '', 'unknown'])(
    'refuses an actual original step conclusion %s',
    (status) => {
      const e = env();
      e.RECEIPT_CONCLUSIONS = JSON.stringify(['success', status, 'success']);
      expect(() => createReceipt(e)).toThrow();
    }
  );
  it.each(['run', 'job', 'artifact', 'repo', 'trigger', 'workflow', 'attempt', 'expired', 'fork'])(
    'refuses foreign or ambiguous %s ownership',
    (kind) => {
      const t = trusted();
      if (kind === 'run') t.run.id = 999;
      if (kind === 'job') t.job.conclusion = 'failure';
      if (kind === 'artifact') t.artifact.workflow_run.id = 999;
      if (kind === 'repo') t.run.repository.id = 999;
      if (kind === 'trigger') t.triggerSha = selected;
      if (kind === 'workflow') t.workflowSha = selected;
      if (kind === 'attempt') t.job.run_attempt = 2;
      if (kind === 'expired') t.artifact.expired = true;
      if (kind === 'fork') t.artifact.workflow_run.head_repository_id = 999;
      expect(() => mergePublisherReceipt(createReceipt(env()), t)).toThrow();
    }
  );
  it.each(['partial', 'duplicate', 'conflicting'])(
    'refuses %s nonempty proof instead of filling it',
    (kind) => {
      const r = createReceipt(env());
      const t = trusted();
      t.job.steps =
        kind === 'partial'
          ? [r.steps[0]]
          : kind === 'duplicate'
            ? [...r.steps, r.steps[0]]
            : r.steps.map((s: any, i: number) => (i ? s : { ...s, conclusion: 'failure' }));
      expect(() => mergePublisherReceipt(r, t)).toThrow();
    }
  );
  it('refuses unknown fields, malformed sources and an invalid named proof', () => {
    const r = createReceipt(env());
    expect(() => validateReceipt({ ...r, extra: true })).toThrow();
    expect(() => validateReceipt({ ...r, runtimeSha: 'not-sha' })).toThrow();
    expect(() =>
      validateReceipt({
        ...r,
        steps: [...r.steps.slice(0, 2), { ...r.steps[2], name: 'Invented Proof' }],
      })
    ).toThrow();
  });
  it('captures original GitHub conclusions without changing original transaction conditions', () => {
    const source = readFileSync('.github/workflows/publish-club-arena.yml', 'utf8');
    expect(source).toContain(
      'steps.verdict.conclusion, steps.immutable_publish.conclusion, steps.verified.conclusion'
    );
    expect(source).toContain(
      'steps.retained_verified.conclusion, steps.retained_recorded.conclusion'
    );
    expect(source).toContain("if: steps.verdict.outputs.verdict == 'publish'");
    expect(source.indexOf('Preserve original publisher verdict evidence')).toBeGreaterThan(
      source.indexOf('Remove origin credentials and control sockets')
    );
  });
});
