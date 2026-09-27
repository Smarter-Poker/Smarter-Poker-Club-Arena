import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const root = resolve(import.meta.dirname, '..');
describe('satellite audit index native enforcement', () => {
  it.each([
    'scripts/ci/test-satellite-audit-index-postgres.py',
    'scripts/ci/fixtures/satellite-audit-index/bootstrap.sql',
    'scripts/ci/fixtures/satellite-audit-index/installed.sql',
    'scripts/ops/build-satellite-audit-index-concurrently.sql',
    'scripts/ops/recover-satellite-audit-index-concurrently.sql',
    'tests/satelliteAuditIndexRegression.test.ts',
  ])('each changed native input selects required accounting and client checks: %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('executes the real native runner in the existing required accounting job', () => {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));
    const steps = workflow.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('python3 scripts/ci/test-satellite-audit-index-postgres.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 4');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(workflow.jobs.accounting_postgres['continue-on-error']).toBeUndefined();
  });
  it('pins finite concurrent recovery without DROP or a repeating driver', () => {
    const recovery = readFileSync(
      resolve(root, 'scripts/ops/recover-satellite-audit-index-concurrently.sql'),
      'utf8'
    )
      .replace(/--[^\n]*/g, '')
      .trim();
    expect(recovery).toBe(
      'REINDEX INDEX CONCURRENTLY public.idx_rake_records_satellite_seat_source;'
    );
    const native = readFileSync(
      resolve(root, 'scripts/ci/test-satellite-audit-index-postgres.py'),
      'utf8'
    );
    expect(native).toContain('RECOVERY.read_text()');
    expect(native).toContain("phase='waiting for old snapshots'");
    expect(native).toContain('NOT indisvalid AND indisready AND indislive');
  });
  it('builds one concurrent index without a metadata width restriction or fallback', () => {
    const online = readFileSync(
      resolve(root, 'scripts/ops/build-satellite-audit-index-concurrently.sql'),
      'utf8'
    ).replace(/--[^\n]*/g, '');
    expect(online.trim()).toMatch(
      /^CREATE INDEX CONCURRENTLY idx_rake_records_satellite_seat_source/
    );
    expect(online.match(/;/g)).toHaveLength(1);
    expect(online).toContain("WHERE source = 'fn_award_satellite_seat'");
    expect(online).not.toMatch(/INCLUDE|IF NOT EXISTS|DROP|BEGIN|DO\s/);
  });
});
