/**
 * A MERGED MIGRATION IS ONE THE APPLIER WILL TAKE (2026-10-26).
 *
 * The merger dispatches every migration a PR adds (dispatch-merged-migrations.sh),
 * and apply-merged-migration.yml installs it. On 2026-10-25 two merged files
 * were dispatched and refused, and nothing owned them afterwards:
 *
 * - 20261025143717_digest_counts_original_alerts_rather_than_source_updates
 *   (run 40215906092): its `-- @live-proof:` comments followed COMMIT;, which
 *   the applier refuses (the 2026-10-19 packaging ruling). Nothing at merge
 *   time had asked the applier's question.
 * - 20261025233013_registered_add_on_breaks_are_sixty_seconds (run
 *   40252376234): dispatched into an announced engine maintenance window and
 *   refused at once, though the window releases in minutes.
 *
 * These cases pin the repair: one shared shape rule for the merge check and
 * the applier, and a bounded wait for a refusal that releases on its own.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

import { migrationTransactionShape } from '../../scripts/ci/migration-transaction-shape.mjs';

const ROOT = resolve(__dirname, '../..');
const DIR = join(ROOT, 'supabase/migrations');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

/** From here on, every migration on this branch must be one the applier takes. */
const CHECKED_FROM = '20261019000000';
/**
 * Unwrapped files from that period that were installed by another route
 * before the merge check existed. Each is already in production; none is ever
 * dispatched to the applier again. Never add a name here: wrap the file.
 */
const INSTALLED_BEFORE_THE_CHECK = new Set([
  '20261022014819_ca_orphaned_certification_account_sweep.sql',
  '20261022021302_remove_ca_orphaned_certification_account_sweep.sql',
  '20261022145452_a_diamond_bounty_paid_during_a_rebuy_reaches_the_winner_s_wa.sql',
  '20261022163616_anti_cheat_multi_account_v2_true_multi_accounts_only.sql',
  '20261022170343_anti_cheat_multi_account_v2_collapse_before_join.sql',
  '20261022172522_a_bust_backlog_pages_within_four_minutes.sql',
  '20261022173217_anti_cheat_multi_account_v2_use_ip_index.sql',
  '20261022173330_hourly_slots_after_the_daily_reset_are_not_breaks.sql',
  '20261022190328_the_small_sunrise_and_midnight_bounties_spawn_again.sql',
  '20261022190338_late_registration_never_seats_onto_a_table_being_broken.sql',
  '20261022191059_spin_sweep_finds_recent_spins_by_an_index.sql',
  '20261022220915_anti_cheat_multi_account_v3_device_hands_auto_ranges.sql',
  '20261023024134_the_jackpot_drop_goes_10_main_30_backup_60_promo.sql',
  '20261023030641_only_the_midway_union_jackpot_drops_10_30_60.sql',
  '20261023031034_the_pool_policy_is_read_only_to_the_service_role.sql',
  '20261023072007_the_horse_roster_is_the_top_performers_and_plo_is_the_best_o.sql',
  '20261023123901_the_promo_bank_check_counts_chips_moved_into_promo_from_the_.sql',
  '20261023160921_benched_horses_play_tournaments_and_only_the_roster_plays_ca.sql',
  '20261023160959_cash_game_stake_cap_allows_one_two_for_every_variant.sql',
  '20261023175018_the_lightning_pilot_club_is_exempt_from_the_horse_cash_roste.sql',
  '20261023175910_plo_roster_horses_play_plo_cash.sql',
  '20261023182203_the_horse_roster_sizes_itself_to_the_floor_and_keeps_its_hor.sql',
  '20261023192030_plo_low_stakes_open_to_the_roster_on_the_floor_sized_roster.sql',
  '20261024223153_woowoo_half_earned_rake_credited_to_kingfish.sql',
]);

describe('a merged migration is one the applier will take', () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql') && f.slice(0, 14) >= CHECKED_FROM)
    .sort();

  it('checks a real, non-empty set of recent files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files.filter((f) => !INSTALLED_BEFORE_THE_CHECK.has(f)))('%s', (file) => {
    const shape = migrationTransactionShape(file, read(file));
    expect(shape.ok ? 'installable' : shape.reason).toBe('installable');
  });

  it('keeps the grandfathered list closed: every name is a real, unwrapped file', () => {
    for (const file of INSTALLED_BEFORE_THE_CHECK) {
      expect(migrationTransactionShape(file, read(file)).ok, file).toBe(false);
    }
  });
});

describe('the shared shape rule', () => {
  it('accepts the corrected 20261025143717, its proofs moved inside the envelope', () => {
    const file = '20261025143717_digest_counts_original_alerts_rather_than_source_updates.sql';
    const sql = read(file);
    expect(migrationTransactionShape(file, sql).ok).toBe(true);
    expect(sql.split('\n').filter((l) => l.startsWith('-- @live-proof:'))).toHaveLength(3);
  });

  it('refuses a comment after COMMIT;, as the applier always has (2026-10-19 ruling)', () => {
    const shape = migrationTransactionShape(
      'x.sql',
      'BEGIN;\nSELECT 1;\nCOMMIT;\n-- @live-proof: true\n'
    );
    expect(shape.ok).toBe(false);
    expect(
      migrationTransactionShape('x.sql', '-- @live-proof: true\nBEGIN;\nSELECT 1;\nCOMMIT;\n').ok
    ).toBe(true);
  });

  it('still refuses a statement after COMMIT;', () => {
    const shape = migrationTransactionShape('x.sql', 'BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\n');
    expect(shape.ok).toBe(false);
  });

  it('still refuses a file with no transaction of its own', () => {
    expect(migrationTransactionShape('x.sql', 'SELECT 1;\n').ok).toBe(false);
    expect(migrationTransactionShape('x.sql', 'BEGIN;\nSELECT 1;\n').ok).toBe(false);
  });

  it('keeps the sanctioned CREATE INDEX CONCURRENTLY preamble', () => {
    const file = '20260925205938_the_weekly_rakeback_gate_stops_proving_every_tournament_one_.sql';
    const shape = migrationTransactionShape(file, read(file));
    expect(shape.ok).toBe(true);
    if (shape.ok) expect(shape.indexes.length).toBeGreaterThan(0);
  });
});

describe('the applier uses that rule and waits out a refusal that releases', () => {
  const applier = readFileSync(join(ROOT, 'scripts/ci/apply-recorded-migration.mjs'), 'utf8');
  const workflow = parse(
    readFileSync(join(ROOT, '.github/workflows/apply-merged-migration.yml'), 'utf8')
  );
  const job = workflow.jobs.apply;
  const run: string = job.steps.find((s: { id?: string }) => s.id === 'apply').run;

  it('asks the same shape question the merge check asks', () => {
    expect(applier).toContain("from './migration-transaction-shape.mjs'");
    expect(applier).toContain('migrationTransactionShape(file, sql)');
    expect(applier).not.toMatch(/COMMIT\\s\*;\\s\*\$\/i\.test\(sql\.trim\(\)\)/);
  });

  it('waits a bounded time on the database answer and sends nothing meanwhile', () => {
    expect(applier).toMatch(/const DDL_ADMISSION_WAIT_MS = 12 \* 60_000;/);
    expect(applier).toMatch(/const DDL_ADMISSION_POLL_MS = 15_000;/);
    expect(applier).toContain('last = await refusalNow();');
    // A check-only run never waits.
    expect(applier).toContain('DRY_RUN ? refusal : await waitForDdlAdmission(refusal)');
  });

  it('gives the queue and the job room for that wait', () => {
    const queue = Number(/deadline=\$\(\( \$\(date \+%s\) \+ (\d+) \)\)/.exec(run)?.[1]);
    expect(queue).toBeGreaterThanOrEqual(12 * 60);
    expect(run).toContain(`still active after ${queue}s`);
    expect(job['timeout-minutes'] * 60).toBeGreaterThanOrEqual(queue + 12 * 60 + 5 * 60);
  });
});
