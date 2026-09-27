import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const root = resolve(import.meta.dirname, '..');
describe('reserved cleanup player index native enforcement', () => {
  it.each([
    'scripts/ci/test-certification-player-index-postgres.py',
    'scripts/ci/fixtures/certification-player-index/installed.sql',
    'scripts/ci/fixtures/certification-retirement/setup.sql',
    'scripts/ops/build-certification-player-index-concurrently.sql',
    'tests/certificationPlayerIndexRegression.test.ts',
  ])('selects the required accounting and client checks for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('runs actual cleanup, FK and concurrency proof in the required native shard', () => {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.accounting_postgres;
    const steps = job.steps.filter((step: { run?: string }) =>
      step.run?.includes('python3 scripts/ci/test-certification-player-index-postgres.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 4');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
  });
  it('builds only the missing leading UUID lookup without changing financial rows or FK semantics', () => {
    const sql = readFileSync(
      resolve(root, 'scripts/ops/build-certification-player-index-concurrently.sql'),
      'utf8'
    ).replace(/--[^\n]*/g, '');
    expect(sql.match(/;/g)).toHaveLength(1);
    expect(sql).toContain('CREATE INDEX CONCURRENTLY idx_cash_rake_sources_player');
    expect(sql).toContain('ON public.accounting_cash_rake_sources USING btree (player_id)');
    expect(sql).not.toMatch(/INCLUDE|WHERE|IF NOT EXISTS|DROP|BEGIN|UPDATE|DELETE|ALTER/);
  });
});
