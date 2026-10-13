import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
const p = 'scripts/qualification/weekly-cohort-cutoff/';
const read = (n: string) => fs.readFileSync(n, 'utf8');
const migration =
  'supabase/migrations/20261013195428_weekly_cohort_cutoff_runs_once_per_earning_club.sql';
describe('Weekly cohort preserves all admission and other branches', () => {
  it('changes only the earning arm and distinct cutoff key CTEs', () => {
    const before = read(p + 'before-helper.sql');
    const after = read(p + 'after-helper.sql');
    const arm =
      'SELECT s.club_id FROM public.accounting_payable_earning_sources s\n    WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to';
    expect(
      after
        .replace(
          'RETURN QUERY WITH ' + read(p + 'earning-ctes.sql') + ', initial AS (',
          'RETURN QUERY WITH initial AS ('
        )
        .replace('SELECT s.club_id FROM accepted_earnings s', arm)
    ).toBe(before);
    expect(read(migration)).toContain(after.trimEnd() + ';');
    expect(after).toContain('GROUP BY e.club_id');
    expect(after).toContain('b.club_id=s.club_id');
    expect(after).not.toContain('SELECT s.*');
    expect(after).toContain('s.charged_at>=b.cutoff');
    expect(after).toContain('s.recognized_at>=b.cutoff');
  });
  it('enforces exact private guarded native delivery without skipped completion', () => {
    const s = read(migration);
    expect(splitConcurrentPreamble(s).ok).toBe(true);
    expect(s).toContain("('20261013182759',56531,'b3b2ab25d944efb292f8e918e93d7b8f')");
    expect(s).toContain(
      'REVOKE ALL ON FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role'
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
    ])
      expect(s).toContain('weekly_cohort_' + gate);
    expect(s).toContain('d9a70f1d932538025e656bfe2b4d091d');
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 scripts/qualification/weekly-cohort-cutoff/run-native.py'
    );
    const driver = read(p + 'semantic-driver.py');
    expect(driver).toContain('oldids==newids==expected');
    expect(driver).toContain("counts['new']==len(candidates)");
    expect(read(p + 'history-driver.py')).toContain('outputs==[expected,expected]');
    expect(read(p + 'installer-driver.py')).toContain('exact-recorded-history');
  });
});
