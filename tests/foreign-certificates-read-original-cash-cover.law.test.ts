import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const migration = readFileSync(
  'supabase/migrations/20261027194250_foreign_certificates_read_their_original_cash_cover.sql',
  'utf8'
);
const native = readFileSync('scripts/ci/test-foreign-certificate-cash-cover-postgres.py', 'utf8');
const hook = readFileSync(
  'scripts/ci/fixtures/foreign-certificate-cash-cover/native-hook.py',
  'utf8'
);
const workflow = readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8');
describe('Foreign certificates retain the complete original cash source projection', () => {
  it('adds only the exact covering access path, never a financial filter or source rewrite', () => {
    expect(migration).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_foreign_certificate_club_week_cover'
    );
    expect(migration).toContain(
      'btree(club_id,earned_at) INCLUDE(id,player_id,rake_record_id,coordinator_union_id,rake_credit)'
    );
    expect(migration).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION|UPDATE public\.|DELETE FROM|ALTER TABLE|is_horse|DISABLE TRIGGER/i
    );
    expect(migration).toContain('ix.indnkeyatts<>2 OR ix.indnatts<>7');
    expect(migration).toContain('IF j<=2 THEN');
    expect(migration).toContain('public.fn_platform_frozen()');
  });
  it('requires the real unchanged helper, views, full monetary family and visibility behavior', () => {
    expect(native).toContain('test-zero-standalone-foreign-postgres.py');
    expect(native).toContain('SOURCE_CASH_COVER_MIGRATION.read_text()');
    expect(hook).toContain('154b8afb11b7a9c7617d16fd047c9918');
    expect(hook).toContain("n['Node Type']=='Index Only Scan'");
    expect(hook).toContain('EXCEPT ALL');
    expect(hook).toContain('ISOLATION LEVEL REPEATABLE READ');
    expect(hook).toContain('actual-invalid-concurrent-index');
    expect(workflow).toContain(
      'python3 -B scripts/ci/test-foreign-certificate-cash-cover-postgres.py'
    );
    expect(hook).not.toMatch(
      /enable_seqscan|enable_bitmapscan|enable_indexscan|force_custom_plan|force_generic_plan/
    );
  });
});
