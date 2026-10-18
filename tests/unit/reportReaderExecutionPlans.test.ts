import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring } from '../helpers/migrations';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = '20261018183243_report_reader_generic_plans_retain_bounded_bitmap_scans.sql';

describe('qualified report execution settings', () => {
  it('retains exact ledger precision in the original producer and qualifies historical correction', () => {
    const sql = read(
      'supabase/migrations/20261018210833_reporting_rake_retains_precision_until_the_final_total.sql'
    );
    expect(sql).toContain('SUM(f.fee), COALESCE(MAX(h.hands), 0)');
    expect(sql).toContain('UPDATE public.club_table_daily d SET rake=f.rake');
    expect(sql).not.toMatch(/ALTER ROLE|ALTER DATABASE/);
    const native = read('scripts/ci/test-club-data-report-db-postgres.py');
    expect(native).toContain(
      '20261018210833_reporting_rake_retains_precision_until_the_final_total.sql'
    );
    expect(native).toContain('precision-scenario.sql');
    expect(native).toContain('precision correction preserves every ledger fact');
    expect(native).toContain('precision migration replay is refused before a recount');
  });

  it('qualifies the indexed source, real producer, saturation and private read budgets', () => {
    const sql = read(
      'supabase/migrations/20261018195533_bomb_catchup_retains_its_qualified_generic_bitmap_plan.sql'
    );
    expect(sql).not.toMatch(/ALTER ROLE|ALTER DATABASE/);
    for (const marker of [
      'bomb_table_days AS MATERIALIZED',
      'bomb_candidates AS MATERIALIZED',
      'CROSS JOIN LATERAL',
      'OFFSET 0',
      'v_caught < 40',
      "statement_timeout='30s'",
      "interval '15 minutes'",
    ])
      expect(sql).toContain(marker);
    expect(sql).toContain('pg_advisory_xact_lock');
    const runner = read('scripts/dev/test-statement-availability-postgres.sh');
    expect(runner).toContain(
      '20261018195533_bomb_catchup_retains_its_qualified_generic_bitmap_plan.sql'
    );
    expect(runner).toContain('bomb-real-rollup-before.sql');
    expect(runner).toContain('before transactionid');
    expect(runner).toContain('after advisory');
    expect(runner).toContain('bomb-plan-cache-after.sql');
    expect(runner).toContain('cache-replay.log');
    const native = read('tests/fixtures/union-statement-availability/bomb-plan-cache-after.sql');
    expect(native).toContain('has_function_privilege');
    expect(native).toContain('cache setting escaped its call');
    expect(native).toContain('Saturation must retain unsealed history');
    expect(native).toContain('Real rollup producer lost closed or live hand values');
    expect(native).toContain('Session timezone moved the UTC window');
  });
  it('body source resolution ignores guarded precision patches that grant the producer', () => {
    const source = latestDeclaring('fn_ca_reporting_rollups_from_facts');
    expect(source.name).not.toContain('20261018210833');
    expect(functionBody(source.sql, 'fn_ca_reporting_rollups_from_facts')).toContain(
      'FROM public.ca_club_data_fact f'
    );
  });
  it('body source resolution ignores settings-only migrations', () => {
    const source = latestDeclaring('ca_rake_snapshot');
    expect(source.name).not.toBe(migration);
    expect(functionBody(source.sql, 'ca_rake_snapshot')).toContain('breakdown_live');
  });
  it('qualifies the exact migration and its replay refusal in the required native report path', () => {
    const runner = read('scripts/dev/test-statement-availability-postgres.sh');
    expect(runner).toContain(migration);
    expect(runner).toContain('reader-settings-after.sql');
    expect(runner).toContain('settings-replay.log');
    expect(read('scripts/dev/test-union-ops-financial-admin-postgres.sh')).toContain(
      'test-statement-availability-postgres.sh'
    );
  });

  it('protects unchanged calculations and caller authority through actual native catalog assertions', () => {
    const native = read('tests/fixtures/union-statement-availability/reader-settings-after.sql');
    expect(native).toContain('18e6c2541c8d13062478fe22b4670147');
    expect(native).toContain('59e6f3ea0f8529de6d64971a90c8f470');
    expect(native).toContain('has_function_privilege');
    expect(native).toContain('setting escaped its call');
    const sql = read(`supabase/migrations/${migration}`);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION|\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(sql).not.toMatch(/ALTER ROLE|ALTER DATABASE/);
  });
});
