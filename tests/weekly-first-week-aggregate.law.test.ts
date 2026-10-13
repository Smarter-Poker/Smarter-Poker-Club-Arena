import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
import { namingProblems } from '../scripts/ci/check-new-migration-version-collisions.mjs';
const p = 'scripts/qualification/weekly-first-week-aggregate/';
const old = 'min(public.fn_union_week_start(s.earned_at))';
const replacement =
  'LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at))';
const name = 'supabase/migrations/20261013182759_weekly_first_week_calendar_runs_once_per_club.sql';
const read = (n: string) => fs.readFileSync(n, 'utf8');
describe('Global first week preserves original errors and work', () => {
  it('changes only one global expression, preserving every other byte', () => {
    const before = read(p + 'before-scope.sql'),
      after = read(p + 'after-scope.sql');
    expect(after.replace(replacement, old)).toBe(before);
    expect(after.split(replacement)).toHaveLength(2);
    expect(after.split(old)).toHaveLength(2);
    expect(read(name)).toContain(after.trimEnd() + ';');
  });
  it('retains guarded private installation and enforced native proof', () => {
    const migration = read(name);
    expect(namingProblems(name)).toEqual([]);
    expect(splitConcurrentPreamble(migration).ok).toBe(true);
    expect(migration).toContain("('20261013163310',56447,'e5e59a4139319168dd1fee09411989f6')");
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role'
    );
    for (const gate of [
      'source40_refused',
      'preimage_refused',
      'postimage_refused',
      'history_replay',
      'reader_owned',
      'settlement_lane_owned',
      'freeze_refused',
    ])
      expect(migration).toContain('weekly_selector_' + gate);
    const grid = read(p + 'calendar-grid.sql');
    expect(grid).toContain('4714-11-24 BC');
    expect(grid).toContain('2025-11-01');
    expect(grid).toContain('EXCEPTION WHEN OTHERS');
    const runner = read(p + 'run-native.py');
    expect(runner).toContain("grid['mismatches']==0");
    expect(runner).toContain('assert primitive_before==primitive_after');
    expect(runner).toContain("measured['after']==len(primitive_rows)");
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 scripts/qualification/weekly-first-week-aggregate/run-native.py'
    );
  });
});
