import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261026143349_weekly_close_refusal_checks_read_only_their_scope.sql',
  'utf8'
);
describe('the weekly refusal check reads the receipt cover', () => {
  it('qualifies a concurrent compact cover and replaces only its exact query owner', () => {
    expect(sql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_receipts_refusal_cover'
    );
    expect(sql).toContain('INCLUDE (earned_at,scope)');
    expect(sql).toContain("md5(original)<>'ac7d777693e79eca6a13084b51cd1305'");
    expect(sql).toContain('after_meta IS DISTINCT FROM before_meta');
    expect(sql).toContain('i.indisvalid AND i.indisready AND i.indislive');
    expect(sql).toContain('WITH scoped_refusals AS MATERIALIZED');
    expect(sql).toContain('WHERE x.id=w.receipt_id OFFSET 0');
    expect(sql).not.toMatch(/UPDATE public\.|INSERT INTO public\.|cron\.schedule/);
  });
  it('executes native parity and index-only proof in the existing financial check', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain(
      'python3 -B scripts/ci/test-weekly-refusal-cover-postgres.py --pg-bin "$PG_BIN" --scratch "${{ runner.temp }}"'
    );
    const native = readFileSync('scripts/ci/test-weekly-refusal-cover-postgres.py', 'utf8');
    expect(native).toContain('assert answers()==baseline');
    expect(native).toContain("n['Heap Fetches']==0");
    expect(native).toContain('forced_rollback');
  });
});
