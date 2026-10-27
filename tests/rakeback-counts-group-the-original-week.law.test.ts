import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(p, 'utf8');
const files = readdirSync('supabase/migrations').filter((f) =>
  f.endsWith('_rakeback_counts_group_the_original_closed_week_once.sql')
);
describe('The original keeper groups exact source counts', () => {
  it('replaces only the guarded counts loop without adding financial owners or retry infrastructure', () => {
    expect(files).toHaveLength(1);
    const sql = read('supabase/migrations/' + files[0]);
    for (const term of [
      '2d8ab8647146824b837ee193b624834c',
      'a4f76df2ab80d5b19ccbd923318658d4',
      'rakeback_grouped_counts_owner_changed',
      'rakeback_grouped_counts_postimage_changed',
      'incomplete_pairs AS MATERIALIZED',
      'GROUP BY d.club_id,d.window_start',
      "began+interval '90 seconds'",
    ])
      expect(sql).toContain(term);
    expect(sql).not.toMatch(
      /cron\.(schedule|alter_job)|CREATE TABLE|CREATE OR REPLACE FUNCTION|enable_nestloop|ca\.break_window_migration_override/
    );
  });
  it('enforces actual source parity, keeper restart/rollback/lock and installer qualification', () => {
    expect(read('.github/workflows/unpaid-lightning-funding-contracts.yml')).toContain(
      'python3 -B scripts/ci/test-grouped-rakeback-counts-keeper-postgres.py'
    );
    const fixture = 'scripts/ci/fixtures/grouped-rakeback-counts/';
    const kernel = read(fixture + 'kernel-native.py');
    const keeper = read(fixture + 'keeper-native.py');
    for (const term of [
      'actual_grouped_body_no_repeated_heavy_cte_rescans',
      'fall_dst_169h',
      'spring_dst_167h',
    ])
      expect(kernel).toContain(term);
    for (const term of [
      'fresh_partial_restart',
      'actual_original_club_week_lock',
      'original_shared90second_admission',
      'actual_malformed_original_contract',
      'exact_reserved_installer_replay_refusal',
    ])
      expect(keeper).toContain(term);
    expect(read('scripts/ci/test-grouped-rakeback-counts-keeper-postgres.py')).toContain(
      'Production budget'
    );
  });
});
