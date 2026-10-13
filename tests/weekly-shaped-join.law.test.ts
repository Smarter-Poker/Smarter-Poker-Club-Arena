import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
const p = 'scripts/qualification/weekly-shaped-join/';
const read = (n: string) => fs.readFileSync(n, 'utf8');
const migration =
  'supabase/migrations/20261013215115_weekly_shaped_hands_join_their_unique_touch_once.sql';
describe('Weekly shaped hands preserve their unique touch admission', () => {
  it('changes only the scalar lookup, preserving the entire raw branch', () => {
    const old = read(p + 'before-shaped.sql');
    const next = read(p + 'after-shaped.sql');
    const scalar = `   WHERE (SELECT CASE WHEN h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end
    THEN h.shaped ELSE false END FROM public.union_pnl_cash_outcome_touches h
    WHERE h.table_id=o.table_id AND h.hand_number=o.hand_number) IS TRUE`;
    const join = `   JOIN public.union_pnl_cash_outcome_touches h ON h.table_id=o.table_id AND h.hand_number=o.hand_number
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end AND h.shaped IS TRUE`;
    expect(next.replace(join, scalar)).toBe(old);
    expect(read(migration)).toContain(next + ';');
  });
  it('requires guarded cardinality, exact sources and maintained native enforcement', () => {
    const s = read(migration);
    expect(splitConcurrentPreamble(s).ok).toBe(true);
    for (const guard of [
      'authority_refused',
      'column_semantics_refused',
      'pk_cardinality_refused',
      'history_replay',
      'source40_refused',
      'postimage_refused',
      'freeze_refused',
      'reader_owned',
      'settlement_lane_owned',
      'override_refused',
    ])
      expect(s).toContain('weekly_shaped_' + guard);
    expect(s).toContain('NOT c.condeferrable');
    expect(s).toContain('i.indisunique AND i.indisvalid AND i.indisready');
    expect(s).toContain("ARRAY['table_id','hand_number']");
    expect(s).toContain('f1d7fbfbe0bcebb63579b19bc3143a95');
    expect(s).toContain('edecfc5273ee4c96b608baa0ea863578');
    expect(read(p + 'semantic-driver.py')).toContain('assert out==expected');
    expect(read(p + 'installer-driver.py')).toContain('exact-recorded-history');
    expect(read(p + 'installer-driver.py')).toContain('OWNER_HELD');
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 scripts/qualification/weekly-shaped-join/run-native.py'
    );
  });
});
