import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261027180331_cash_evidence_reads_the_accrual_status_cover.sql',
  'utf8'
);
describe('cash evidence reads the accrual status cover', () => {
  it('covers exactly the unchanged raw completeness owner read', () => {
    expect(sql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_batches_status_cover'
    );
    expect(sql).toContain('btree(rake_record_id) INCLUDE(status)');
    expect(sql).toContain('0df1c3e9fe3e1a0e53a043baf57127d7');
    for (const invariant of [
      'ix.indpred IS NOT NULL',
      'ix.indisunique',
      'ix.indisprimary',
      'ix.indisvalid',
      'ix.indisready',
      'ix.indislive',
      'cash_status_cover_original_owner_changed',
      'cash_status_cover_install_frozen',
    ])
      expect(sql).toContain(invariant);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION|UPDATE public\.|INSERT INTO public\.|DELETE FROM public\.|cron\./
    );
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
  it('enforces actual whole-owner parity, natural cover and MVCC through maintained CI', () => {
    const n = readFileSync('scripts/ci/test-cash-assert-status-cover-postgres.py', 'utf8');
    for (const proof of [
      'assert answers()==baseline',
      'before_meta',
      'before_data',
      'Heap Fetches',
      'other.stdin',
      'CREATE UNIQUE INDEX CONCURRENTLY',
      'forced_cover_rollback',
      'invalid_cash_commission_scope',
    ])
      expect(n).toContain(proof);
    expect(readFileSync('.github/workflows/weekly-refusal-cover.yml', 'utf8')).toContain(
      'python3 -B scripts/ci/test-cash-assert-status-cover-postgres.py --pg-bin "$PG_BIN" --scratch "${{ runner.temp }}"'
    );
  });
});
