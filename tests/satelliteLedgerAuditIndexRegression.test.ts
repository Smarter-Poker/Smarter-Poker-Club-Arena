import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const root = resolve(import.meta.dirname, '..');
describe('satellite ledger index native enforcement', () => {
  it.each([
    'scripts/ci/test-satellite-ledger-audit-index-postgres.py',
    'scripts/ci/fixtures/satellite-ledger-audit-index/ledger.sql',
    'scripts/ops/build-satellite-ledger-audit-index-concurrently.sql',
    'tests/satelliteLedgerAuditIndexRegression.test.ts',
  ])('each native input selects required accounting and client checks: %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('runs the real database fixture in the required accounting shard', () => {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.accounting_postgres;
    const steps = job.steps.filter((step: { run?: string }) =>
      step.run?.includes('python3 scripts/ci/test-satellite-ledger-audit-index-postgres.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 4');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
  });
  it('adds one concurrent UUID index without expanding text restrictions or accounting logic', () => {
    const sql = readFileSync(
      resolve(root, 'scripts/ops/build-satellite-ledger-audit-index-concurrently.sql'),
      'utf8'
    ).replace(/--[^\n]*/g, '');
    expect(sql.match(/;/g)).toHaveLength(1);
    expect(sql).toContain('CREATE INDEX CONCURRENTLY idx_chip_ledger_satellite_pool_from');
    expect(sql).toContain('ON public.chip_ledger USING btree (from_entity_id)');
    expect(sql).toContain("WHERE from_type = 'prize_liability' AND category = 'tournament_buyin'");
    expect(sql).not.toMatch(/INCLUDE|IF NOT EXISTS|DROP|BEGIN|CREATE.*FUNCTION/);
  });
});
