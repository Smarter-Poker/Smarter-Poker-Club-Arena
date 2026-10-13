import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
const read = (p: string) => readFileSync(resolve(import.meta.dirname, '..', p), 'utf8');
const migration =
  'supabase/migrations/20261013121004_rake_agent_reports_read_qualified_days_and_uncovered_commiss.sql';
describe('Rake agent native reporting qualification', () => {
  it('runs the actual migration and JSON equivalence fixture in the required native verdict', () => {
    expect(
      read('scripts/ci/test-data-console-postgres-contracts.sh').split(
        'scripts/dev/test-rake-agent-report-postgres.sh'
      )
    ).toHaveLength(2);
    const script = read('scripts/dev/test-rake-agent-report-postgres.sh');
    expect(script).toContain(migration);
    expect(script).toContain('RAKE_REPORT_SOURCE_PREIMAGE_CHANGED');
    expect(script).toContain('DATA_CONSOLE_PG_SCRATCH_PARENT');
    expect(script.split('qualify-rake-report-installation-fixture.mjs')).toHaveLength(2);
    expect(read('tests/fixtures/rake-agent-report/assertions.sql')).toContain(
      'RAKE_EQUIVALENCE_FAILURE'
    );
  });
  it('uses qualified exact days, preserves raw gaps, and does not replace financial writers', () => {
    const sql = read(migration);
    expect(sql).toContain('m.complete IS TRUE OR (m.club_id IS NULL');
    expect(sql).toContain('commission_unpaid_ranges');
    expect(sql).toContain('a.settled_at IS NULL');
    expect(sql).toContain('a.user_id IS NULL');
    expect(sql).toContain('e.amount=COALESCE(o.amount,0)');
    expect(sql).toContain('a.amount IS NOT NULL');
    expect(sql).toContain("e.amount::text IN ('Infinity','-Infinity','NaN')");
    expect(sql).not.toMatch(/CREATE (?:OR REPLACE )?(?:TRIGGER|TABLE)/i);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.trg_');
    expect(sql).toContain("session_user NOT IN ('postgres','supabase_admin')");
    expect(sql).toContain('p_day<v_today-731');
    expect(sql).toContain('RAKE_REPORT_BASELINE_ALREADY_QUALIFIED');
  });
  it.each([
    migration,
    'scripts/dev/test-rake-agent-report-postgres.sh',
    'scripts/dev/qualify-rake-report-installation-fixture.mjs',
    'tests/fixtures/rake-agent-report/assertions.sql',
  ])('routes changed input %s to financial native checks', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
});
