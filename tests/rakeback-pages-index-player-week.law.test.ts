import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(p, 'utf8');
describe('rakeback pages retain original math with matching player indexes', () => {
  it('uses two sanctioned concurrent preambles and guards their actual catalogue shape', () => {
    const sql = read(
      'supabase/migrations/20261027040245_rakeback_pages_index_the_player_and_earning_week.sql'
    );
    expect(sql.match(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /gm)).toHaveLength(2);
    expect(sql).toContain('(club_id,player_id,earned_at)');
    expect(sql).toContain('(club_id,player_id)');
    for (const term of [
      'indisvalid',
      'indisready',
      'indislive',
      'indclass',
      'indcollation',
      'indoption',
      'rakeback_player_week_index_shape_changed',
    ])
      expect(sql).toContain(term);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION|UPDATE public\.|INSERT INTO public\.|DELETE FROM public\./
    );
  });
  it('directly wires meaningful native invariance and interruption qualification', () => {
    const native = read('scripts/ci/test-rakeback-player-week-indexes-postgres.py');
    for (const term of [
      'before_allocation',
      'before_financial',
      'source_fingerprints',
      'authority',
      'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)',
      'CREATE UNIQUE INDEX CONCURRENTLY',
      'invalid_oid',
      'partial_first_valid_second_missing',
    ])
      expect(native).toContain(term);
    expect(read('.github/workflows/unpaid-lightning-funding-contracts.yml')).toContain(
      'run: python3 -B scripts/ci/test-rakeback-player-week-indexes-postgres.py'
    );
  });
});
