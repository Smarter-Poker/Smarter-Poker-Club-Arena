import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const script = 'scripts/ci/test-accepted-horse-window-index-postgres.py';
const migration = 'supabase/migrations/20261025210847_indexes_accepted_horse_window_reads.sql';
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const harness = readFileSync(script, 'utf8');

describe('accepted horse window index executes its required native PostgreSQL qualification', () => {
  it.each([script, migration, 'tests/unit/acceptedHorseWindowIndexCi.test.ts'])(
    'selects accounting and contract checks for %s',
    (path) => {
      expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
    }
  );
  it('does not widen native admission to similarly named unrelated scripts or tests', () => {
    for (const path of [
      'scripts/ci/test-accepted-horse-window-index-postgres-backup.py',
      'tests/unit/acceptedHorseWindowIndexCi-other.test.ts',
    ])
      expect(classifyChangedPaths([path]).server).toBe(false);
  });
  it('runs exactly once on the existing PostgreSQL 17 accounting shard without failure suppression or provider credentials', () => {
    const steps = ci.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes(script)
    );
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step.id).toBe('accepted_horse_window_index');
    expect(step.if).toBe('matrix.shard == 4');
    expect(step['timeout-minutes']).toBe(2);
    expect(step.env).toEqual({ PG_BIN: '/usr/lib/postgresql/17/bin' });
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.run.trim()).toBe(
      `python3 -B ${script} --root "$GITHUB_WORKSPACE" --scratch-parent "$RUNNER_TEMP" --output "$GITHUB_WORKSPACE/artifacts/accepted-horse-window-index" --pg-bin "$PG_BIN"`
    );
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
  });
  it('retains actual native receipts for the exact run and attempt with missing proof refused', () => {
    const uploads = ci.jobs.accounting_postgres.steps.filter(
      (step: { with?: { path?: string } }) =>
        step.with?.path === 'artifacts/accepted-horse-window-index/'
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      uses: 'actions/upload-artifact@v4',
      with: { 'if-no-files-found': 'error' },
    });
    expect(uploads[0].if).toBe(
      `always() && matrix.shard == 4 && contains(fromJSON('["success", "failure", "cancelled"]'), steps.accepted_horse_window_index.outcome)`
    );
    expect(uploads[0].with.name).toBe(
      'accepted-horse-window-index-${{ github.run_id }}-${{ github.run_attempt }}'
    );
  });
  it('binds the exact SQL and maintained preamble parser while retaining genuine conflict and invalid-build counterexamples', () => {
    const expected = /EXPECTED\s*=\s*'([a-f0-9]{64})'/.exec(harness)?.[1];
    expect(expected).toBe(createHash('sha256').update(readFileSync(migration)).digest('hex'));
    expect(harness).toContain('migration-concurrent-preamble.mjs');
    expect(harness).toContain('splitConcurrentPreamble');
    expect(harness).toContain("[*psql,'-f',migration]");
    expect(harness).toContain("'PGOPTIONS':'-c statement_timeout=500ms'");
    expect(harness).toContain("checks['idempotentSameOid']");
    expect(harness).toContain("checks['wrongColumnsRefusedWithoutRebuild']");
    expect(harness).toContain("checks['realConcurrentBuildFailure']");
    expect(harness).toContain("checks['invalidResumeRefusedSameOidNoRepair']");
    expect(harness).toContain("checks['ownClusterStopped']");
    expect(harness).toContain("checks['ownClusterDataAndSocketRemoved']");
    expect(harness).not.toMatch(/(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+pg_(?:index|class)/i);
  });
});
