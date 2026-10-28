import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration = readFileSync(
  'supabase/migrations/20261027223143_standalone_entry_covers_original_tournament_witnesses.sql',
  'utf8'
);
const native = readFileSync('scripts/ci/test-standalone-entry-cover-postgres.py', 'utf8');
const entry = readFileSync('scripts/ci/fixtures/standalone-entry-cover/original-entry.sql', 'utf8');
const workflow = readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8');
describe('Standalone entry retains the complete original historical first-week evidence', () => {
  it('adds only the exact NULL-coordinator scalar cover with maintained catalog and freeze guards', () => {
    expect(migration).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(migration).toContain('btree(club_id,tournament_id)');
    expect(migration).toContain(
      'INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NULL'
    );
    expect(migration).toContain('ix.indnkeyatts<>2 OR ix.indnatts<>6');
    expect(migration).toContain('ix.indclass[j-1] IS DISTINCT FROM op');
    expect(migration).toContain('public.fn_platform_frozen()');
    expect(migration).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION|UPDATE public\.|DELETE FROM|ALTER TABLE|DISABLE TRIGGER|GRANT |REVOKE /i
    );
  });
  it('qualifies whole ENTRY rows and all original cutoff, history, pending and debt branches', () => {
    for (const proof of [
      'actual_scope.index',
      'all_six_function_definitions_metadata_unchanged',
      'all_eleven_table_columns_constraints_owner_acl_unchanged',
      'actual_invalid_concurrent_build',
      'mvcc_heap_fallback',
      'whole_original_entry_rows_identical',
    ])
      expect(native).toContain(proof);
    expect(entry).toContain('s.coordinator_union_id IS NULL');
    expect(entry).toContain('s.recognized_rake_credit=s.rake_credit');
    expect(entry).toContain('s.recognized_at=s.recognition_at');
    expect(entry).toContain('NOT s.union_id IS DISTINCT FROM s.recognition_union_id');
    expect(entry).toContain('public.fn_club_settlement_floor_week(x.club_id)');
    expect(entry).toContain("q.status='complete' AND q.period_end<$2");
    expect(native).not.toMatch(/enable_seqscan|enable_bitmapscan|enable_indexscan/);
    expect(workflow).toContain('python3 -B scripts/ci/test-standalone-entry-cover-postgres.py');
    expect(workflow).toContain('scripts/ci/fixtures/standalone-entry-cover/**');
  });
});
