import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
const p = 'scripts/qualification/weekly-standalone-selector/';
const read = (n: string) => fs.readFileSync(n, 'utf8');
const migration =
  'supabase/migrations/20261013212336_weekly_standalone_selector_callbacks_run_once_per_earning_cl.sql';
describe('Standalone weekly selector bounds callbacks without changing accounting', () => {
  it('changes only the second selector and preserves the entire other scope body', () => {
    const before = read(p + 'before-scope.sql').trimEnd();
    const after = read(p + 'after-scope-candidate.sql').trimEnd();
    expect(
      after.replace(
        read(p + 'after-second-selector.sql').trimEnd(),
        read(p + 'before-second-selector.sql').trimEnd()
      )
    ).toBe(before);
    expect(read(migration)).toContain(after + ';');
    expect(after).toContain(
      'LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at))'
    );
    expect(after).toContain('GROUP BY e.club_id');
    expect(after).toContain('b.club_id=s.club_id');
    expect(after).not.toContain('SELECT s.*');
    expect(
      read(p + 'earning-ctes.sql').match(/p_club_id IS NULL OR s.club_id=p_club_id/g)
    ).toHaveLength(2);
    expect(after).toContain('p_club_id IS NULL OR x.club_id=p_club_id');
    expect(after).toContain('s.charged_at>=b.cutoff');
    expect(after).toContain('s.recognized_at>=b.cutoff');
  });
  it('keeps exact guarded recorded installation and unchanged private cohort', () => {
    const s = read(migration);
    expect(splitConcurrentPreamble(s).ok).toBe(true);
    expect(s).toContain("('20261013195428',11065,'7be7f54080357418424eaecfa552500d')");
    expect(s).toContain('47df4a9dfae6291b7b3f3d3c16470cfc');
    expect(s).toContain('cc3063873cf25be4b70e7cc893617c37');
    expect(s).toContain(
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
      'override_refused',
      'unchanged_helper_refused',
    ])
      expect(s).toContain('weekly_standalone_selector_' + gate);
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 scripts/qualification/weekly-standalone-selector/run-native.py'
    );
    expect(read(p + 'semantic-driver.py')).toContain('old==new==expected');
    expect(read(p + 'semantic-driver.py')).toContain('assert actual==groups');
    expect(read(p + 'installer-driver.py')).toContain('exact-recorded-history');
  });
});
