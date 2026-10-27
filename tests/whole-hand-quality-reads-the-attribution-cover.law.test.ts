import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261027192602_whole_hand_rakeback_reads_the_original_attribution_cover.sql',
  'utf8'
);
describe('whole-hand quality reads the attribution cover', () => {
  it('covers the unchanged all-club whole-hand read without rewriting money or guards', () => {
    expect(sql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS rake_attributions_whole_hand_cover'
    );
    expect(sql).toContain(
      'btree(rake_record_id) INCLUDE(id,hand_id,player_id,club_id,weighted_rake_credit)'
    );
    for (const invariant of [
      'ix.indpred IS NOT NULL',
      'ix.indisunique',
      'ix.indisprimary',
      'ix.indisvalid',
      'ix.indisready',
      'ix.indislive',
      'ix.indnkeyatts<>1',
      'ix.indnatts<>6',
      'whole_hand_cover_install_frozen',
    ])
      expect(sql).toContain(invariant);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION|UPDATE public\.|INSERT INTO public\.|DELETE FROM public\.|cron\./
    );
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
  it('enforces original bags, full metadata, catalog faults and real concurrent visibility in CI', () => {
    const n = readFileSync('scripts/ci/test-whole-hand-attribution-cover-postgres.py', 'utf8');
    for (const proof of [
      'assert answers()==baseline',
      'before_meta',
      'before_data',
      'Heap Fetches',
      'other.stdin',
      'CREATE UNIQUE INDEX CONCURRENTLY',
      'forced_rollback',
      'weighted_rake_credit=9',
    ])
      expect(n).toContain(proof);
    expect(readFileSync('.github/workflows/whole-hand-attribution-cover.yml', 'utf8')).toContain(
      'python3 -B scripts/ci/test-whole-hand-attribution-cover-postgres.py --pg-bin "$PG_BIN" --scratch "${{ runner.temp }}"'
    );
  });
});
