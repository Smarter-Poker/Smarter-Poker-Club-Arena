import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
const read = (p: string) => readFileSync(p, 'utf8');
const sql = read(
  'supabase/migrations/20261016161247_weekly_close_freshness_checks_use_recorded_source_indexes.sql'
);
describe('weekly close source freshness indexes', () => {
  it('uses the maintained concurrent preamble with exact covering columns', () => {
    const s = splitConcurrentPreamble(sql);
    expect(s.ok).toBe(true);
    if (!s.ok) throw new Error(s.reason);
    expect(s.indexes).toHaveLength(2);
    expect(s.indexes[0].statement).toContain('(club_id,recorded_at) INCLUDE (earned_at)');
    expect(s.indexes[1].statement).toContain('(club_id,recorded_at) INCLUDE (charged_at)');
    expect(s.body).toContain('weekly_source_freshness_index_shape_changed');
    expect(s.body).toContain('ix.indnkeyatts<>2 OR ix.indnatts<>3');
    expect(s.body).toContain("ARRAY['club_id','recorded_at',r.time_column]");
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION|UPDATE public\.|DELETE FROM public\./);
  });
  it('runs the actual predicate qualification in the required accounting parent', () => {
    const parent = read('scripts/ci/test_launch_reset_floor.py');
    expect(parent).toContain("'test-weekly-source-freshness-postgres.py'");
    const native = read('scripts/ci/test-weekly-source-freshness-postgres.py');
    expect(native).toContain('weekly-source-freshness-preparation.sql');
    expect(native).toContain('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)');
    expect(native).toContain("'recorded_at' in n.get('Index Cond','')");
    expect(native).toContain('old_blocks>new_blocks*5');
  });
});
