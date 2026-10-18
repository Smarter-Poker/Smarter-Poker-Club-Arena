import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring } from '../helpers/migrations';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = '20261018183243_report_reader_generic_plans_retain_bounded_bitmap_scans.sql';

describe('qualified report execution settings', () => {
  it('uses the qualified generic bitmap plan on the first call as well as warm backends', () => {
    const sql = read(
      'supabase/migrations/20261018195533_bomb_catchup_retains_its_qualified_generic_bitmap_plan.sql'
    );
    expect(sql).toContain('SET plan_cache_mode=force_generic_plan');
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION|ALTER ROLE|ALTER DATABASE/);
    const runner = read('scripts/dev/test-statement-availability-postgres.sh');
    expect(runner).toContain(
      '20261018195533_bomb_catchup_retains_its_qualified_generic_bitmap_plan.sql'
    );
    expect(runner).toContain('bomb-plan-cache-after.sql');
    expect(runner).toContain('cache-replay.log');
    const native = read('tests/fixtures/union-statement-availability/bomb-plan-cache-after.sql');
    expect(native).toContain('18e6c2541c8d13062478fe22b4670147');
    expect(native).toContain('has_function_privilege');
    expect(native).toContain('cache setting escaped its call');
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
