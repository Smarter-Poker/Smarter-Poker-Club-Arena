/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE OPERATOR CONSOLE STAYS CLOSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-31. fn_chip_integrity_report() is the platform's money posture in
 * seven rows - total chip supply, ledger throughput, and which invariant is
 * currently failing. It is SECURITY DEFINER, so RLS does not apply, and
 * `authenticated` could execute it. Any account that could log in could read
 * all of it. Thirty-eight routines were in that shape.
 *
 * The live guard is fn_ca_browser_reachable_telemetry(), read in CI by
 * check-telemetry-exposure.mjs. That is the one that matters, because it sees
 * grants made by anybody's migration.
 *
 * These pins cover the half a database guard cannot: the REPO. A migration
 * that re-grants one of the closed routines to `authenticated` would be caught
 * by CI only after it had been applied to production. Here it is caught in the
 * diff, which is a much cheaper place to find it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const GUARD_MIGRATION = '20260831231356_a_guard_where_the_definer_sweep_was.sql';

/** The routines the two sweep migrations closed. A re-grant of any of these is a regression. */
const CLOSED = [
  'fn_chip_integrity_report',
  'fn_ledger_liveness',
  'fn_chip_drift_since_baseline',
  'fn_unpriced_tournaments',
  'fn_bot_flag_disagreement',
  'fn_audit_privileged_grants',
  'fn_verify_privileged_lock',
  'fn_grant_guard_health',
  'fn_ungated_money_rpcs',
  'fn_settlement_conservation_check',
  'fn_bbj_gap_decomposition',
  'fn_bbj_orphaned_payouts',
  'fn_bbj_promo_bank_check',
  'fn_deal_fairness',
  'fn_detect_double_dealing',
  'fn_audit_layer_silence',
  'fn_hand_history_bloat',
  'fn_hand_history_bloat_report',
  'fn_hand_history_prune_backlog',
  'fn_deprecated_table_usage',
  'fn_club_home_scope_parity',
  'fn_hg_text_writing_functions',
  'fn_leaderboard_snapshot_gaps',
  'fn_snapshot_health',
  'fn_recent_place_collisions',
  'fn_solver_v2_progress',
  'fn_tournament_metrics',
  'fn_strip_client_writes_from_new_views',
  'verify_home_games_health',
  'verify_home_games_health_addendum',
  'ca_brain_telemetry',
  'ca_horse_daily_audit',
  'fn_club_profit_conservation',
  'fn_club_profit_drift',
  'fn_nit_evictions',
  'sp_backfill_member_fee_rollup',
  'training_leaderboard_refresh',
  'sum_anti_farming_ips',
];

/**
 * The sweep is the line in time. Migrations BEFORE it are how these routines
 * came to be open in the first place - 20260826_the_ledger_going_silent_must_be_loud
 * granted fn_ledger_liveness to `authenticated` on purpose - and rewriting
 * history is not the job. Only what lands after the closure can reopen it.
 */
const SWEEP_VERSION = '20260831204718';

const laterMigrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .filter((f) => (f.match(/^(\d{8,14})/)?.[1] ?? '') >= SWEEP_VERSION)
  // The sweep migrations name these routines while REVOKING them.
  .filter((f) => !f.includes('the_operator_console_was_open_to_every_player'))
  .filter((f) => !f.includes('three_handles_a_player_could_pull'));

describe('no migration after the sweep re-opens a closed operator routine', () => {
  it.each(CLOSED)('%s is never granted back to a browser role', (fname) => {
    const offenders: string[] = [];
    for (const file of laterMigrations) {
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      if (!sql.includes(fname)) continue;

      for (const raw of sql.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('--')) continue;
        // A real grant statement, not the word `grant` inside a RAISE message.
        if (!/\bgrant\s+execute\s+on\b/i.test(line)) continue;
        if (!line.includes(fname)) continue;
        if (!/\b(authenticated|anon)\b|\bto\s+public\b/i.test(line)) continue;
        // The whole line, not a truncated window: a re-grant is one statement
        // and the reviewer should see all of it.
        offenders.push(`${file}: ${line}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('is looking at migrations at all, not silently scanning an empty list', () => {
    // A filter bug that matched nothing would make every pin above vacuous.
    expect(laterMigrations.length).toBeGreaterThan(0);
  });
});

describe('the allowlist is a record of decisions, not a bare list', () => {
  const guard = readFileSync(join(MIGRATIONS, GUARD_MIGRATION), 'utf8');

  it('every allowlisted routine carries a written reason', () => {
    const block = guard.slice(
      guard.indexOf('insert into public.ca_browser_definer_allowlist'),
      guard.indexOf('on conflict (proname) do update')
    );
    const rows = [...block.matchAll(/\('([a-z0-9_]+)',\s*'((?:[^']|'')*)'\)/g)];
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const [, name, reason] of rows) {
      // The database CHECK constraint enforces 20 characters. A reason that
      // short is a placeholder, so the repo asks for a sentence.
      expect(reason.trim().length, `${name} has no real reason`).toBeGreaterThan(40);
      expect(reason, `${name}'s reason should say something, not restate its name`).not.toBe(name);
    }
  });

  it('the database enforces the reason too, so a direct INSERT cannot skip it', () => {
    expect(guard).toMatch(/check\s*\(\s*length\(btrim\(reason\)\)\s*>=\s*20\s*\)/i);
  });
});

describe('the guard cannot be quietly narrowed', () => {
  const guard = readFileSync(join(MIGRATIONS, GUARD_MIGRATION), 'utf8');

  it('excludes trigger functions by return type, not by a list of names', () => {
    // Seven trigger functions matched the first sweep. Naming them would have
    // been a list that rots; a return type does not.
    expect(guard).toMatch(/prorettype\s*<>\s*'pg_catalog\.trigger'::regtype/);
  });

  it('still requires that the routine never consults the caller', () => {
    for (const probe of ['auth.uid()', 'auth.role()', 'auth.jwt()']) {
      expect(guard).toContain(probe);
    }
  });

  it('is not readable by a browser, since it lists what browsers can reach', () => {
    expect(guard).toMatch(
      /revoke all on function public\.fn_ca_browser_reachable_telemetry\(\) from public, anon, authenticated/
    );
  });
});
