import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = '20261018183243_report_reader_generic_plans_retain_bounded_bitmap_scans.sql';

describe('qualified report execution settings', () => {
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
