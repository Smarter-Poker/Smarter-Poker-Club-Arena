import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration = readFileSync(
  'supabase/migrations/20261027233555_original_recognition_windows_cover_the_hand_join_keys.sql',
  'utf8'
);
const native = readFileSync('scripts/ci/test-outcome-recognition-join-cover-postgres.py', 'utf8');
const workflow = readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8');
describe('Original recognition windows cover only scalar hand join keys', () => {
  it('adds one exact nonpartial time cover without source, generation or JSON changes', () => {
    expect(migration).toContain('btree(recognized_at) INCLUDE(table_id,hand_number)');
    expect(migration).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(migration).toContain('ix.indnkeyatts<>1 OR ix.indnatts<>3');
    expect(migration).toContain('ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL');
    expect(migration).toContain('public.fn_platform_frozen()');
    expect(migration).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION|UPDATE public\.|DELETE FROM|ALTER TABLE|DISABLE TRIGGER|DROP INDEX|INCLUDE\([^)]*(?:evidence|game_scope|proof)/i
    );
  });
  it('runs current full schema, every competing index and all84 original witness families', () => {
    for (const key of [
      'actual-neighbor-relations.sql',
      'original-generation.sql',
      'all84',
      'wholeweek_reducer',
      'all_four_actual_logical_table_catalogs_unchanged',
      'scalar_include_mvcc_heap_visibility',
      'actual_invalid_concurrent_index_refused',
      'installer_browser_service_role_refused',
    ])
      expect(native).toContain(key);
    expect(native).toContain("x['Node Type']=='Index Only Scan'");
    expect(native).not.toMatch(/enable_seqscan|enable_bitmapscan|enable_indexscan/);
    expect(workflow).toContain(
      'python3 -B scripts/ci/test-outcome-recognition-join-cover-postgres.py'
    );
    expect(workflow).toContain('scripts/ci/fixtures/outcome-recognition-join-cover/**');
  });
});
