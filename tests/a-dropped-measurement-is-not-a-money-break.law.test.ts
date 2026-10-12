/**
 * A DROPPED MEASUREMENT IS NOT A MONEY BREAK (2026-10-04).
 *
 * Pinned on migration 20261004224309. The clean-accounting release gate is
 * read from the hourly DR11:trial_balance_summary series, and three ticks in
 * four days produced no reading at all (2026-10-01 00:20 `job startup
 * timeout`, 2026-10-01 23:20 and 2026-10-03 20:20 never fired). Nothing named
 * a dropped tick: fn_ca_diamond_trial_balance_watch's blanket handler raised a
 * warning into the Postgres log and filed nothing, and the un-paged health
 * outcome filed under the rule name 'DR0:health_critical'. CLAUDE.md 10.86
 * rule 1 forbids folding "I could not tell" into silence or into a critical.
 *
 * The three outcomes this law pins, and the direction of failure:
 *
 *   a money break      stays critical and keeps every bit of its force -
 *                      DR11:trial_balance_break over 1,000 (ruling 13) and a
 *                      'critical' health area filing DR0:health_critical on
 *                      the FIRST tick.
 *   a clean reading    DR11:trial_balance_summary, info, reading_complete true.
 *   nobody could tell  DR14:trial_balance_unreadable at warning, and the
 *                      'trial balance reading' area reading 'unknown' - never
 *                      'critical' - which the health watch escalates to
 *                      critical only if the NEXT hourly reading still cannot
 *                      tell. So a single dropped tick never files a critical
 *                      money incident, and books that genuinely stop being
 *                      measured still page.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PATH = 'supabase/migrations/20261004224309_a_dropped_measurement_is_not_a_money_break.sql';
const sql = readFileSync(resolve(process.cwd(), PATH), 'utf8');

/** The migration with every comment stripped: prose is not the rule. */
const executable = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

describe('LAW: a dropped measurement is not a money break', () => {
  it('is one transaction that edits only pinned function texts', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    // Section 2 rule 3 and 10.87: the live bodies are md5-pinned before and
    // after, so a body another agent changed underneath stops the migration
    // instead of being overwritten.
    expect(sql).toContain(
      "'public.fn_ca_diamond_trial_balance_watch()',\n  'a8aa11f601f50b9a1bebbab66e777081', 'cc6abde0e69ff67e28147a113aa86575',"
    );
    expect(sql).toContain(
      "'public.fn_ca_diamond_health()',\n  '64b94d13476dd74cf8573de193cc14e2', 'c9d50ee9949726a8db879d31248f8ad3',"
    );
    expect(sql).toContain(
      "'public.fn_ca_diamond_health_watch()',\n  'e5101ef5acb368d1ff88bbf7a0b67cf1', 'fcc74eaf71e7cafcfc5361692c15f117',"
    );
    // Substitution, not redefinition: the sibling law's newest-definition
    // matcher must keep resolving to 20260919223032.
    expect(executable).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
  });

  it('gives a pass that could not run its own name, at warning, never critical', () => {
    // The old handler filed nothing at all. 10.86 rule 1.
    expect(executable).toContain(
      'GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_emsg = MESSAGE_TEXT;'
    );
    expect(executable).toMatch(
      /PERFORM public\.fn_ca_diamond_incident\('DR14:trial_balance_unreadable', 'warning', NULL, NULL,\s+'fn_ca_diamond_trial_balance_watch',\s+jsonb_build_object\('reason', 'read_failed_' \|\| v_state, 'message', v_emsg,/
    );
    // A read that compared no account is named too, rather than leaving a row
    // that looks like a reading.
    expect(executable).toContain("'reason', 'no_accounts_reported'");
    expect(executable).toContain("'reading_complete', v_rows > 0,");
    // DR14 is NEVER critical, and never pages: the trigger fires on
    // severity = 'critical'.
    const dr14 = executable.match(/'DR14:trial_balance_unreadable', '(\w+)'/g) ?? [];
    expect(dr14.length).toBe(2);
    for (const filing of dr14) expect(filing).toContain("'warning'");
    expect(executable).not.toMatch(/'DR14:[a-z_]+', 'critical'/);
  });

  it('names the unmeasured hour unknown, and never critical, on the measured cadence', () => {
    expect(executable).toContain("RETURN QUERY SELECT 'trial balance reading'::text,");
    // 95 minutes is the measured threshold: 718 gaps, 715 of them <= 65
    // minutes, 3 one missed tick, none ever beyond 2h00m01s.
    expect(executable).toContain(
      "CASE WHEN v_t IS NULL OR v_n IS NULL OR v_n > 95 THEN 'unknown' ELSE 'ok' END,"
    );
    // The area reads the series it is judging, by its own rule name.
    expect(executable).toContain("WHERE i.rule = 'DR11:trial_balance_summary';");
    // An unmeasured hour never claims the money is wrong. The slice is the two
    // CASE expressions of the area itself: from its RETURN QUERY to the
    // handler that closes the block.
    const areaStart = executable.indexOf("RETURN QUERY SELECT 'trial balance reading'::text,");
    const areaEnd = executable.indexOf('EXCEPTION WHEN OTHERS', areaStart);
    expect(areaStart).toBeGreaterThan(-1);
    expect(areaEnd).toBeGreaterThan(areaStart);
    const readingArea = executable.slice(areaStart, areaEnd);
    expect(readingArea).toContain("'unknown'");
    expect(readingArea).not.toContain("'critical'");
    expect(readingArea).not.toContain("'attention'");
    // And the area that CAN say the money is wrong is not touched by this
    // migration: no anchor of ours goes near the break branch or ruling 13.
    expect(executable).not.toContain('abs(r.difference) > 1000');
    expect(executable).not.toContain("'DR11:trial_balance_break'");
  });

  it('gives the un-paged health outcome its own rule name and keeps the paged one', () => {
    expect(executable).toContain(
      "CASE WHEN v_persistent > 0 THEN 'DR0:health_critical' ELSE 'DR0:health_unknown' END,"
    );
    // The severity split of 20261003220245 is carried through unchanged: a
    // finding is critical on the first tick, an inability to tell is warning
    // until the next tick still cannot tell.
    expect(executable).toContain("CASE WHEN v_persistent > 0 THEN 'critical' ELSE 'warning' END,");
    // An unknown row still cannot outlive its cause
    // (docs/laws.d/a-diamond-incident-cannot-outlive-its-cause.md).
    expect(executable).toContain(
      "WHERE i.rule IN ('DR0:health_critical', 'DR0:health_unknown') AND i.resolved_at IS NULL"
    );
  });

  it('rewrites no settled record and installs no repair job', () => {
    // 10.9: the history is evidence. The clock restarting from today is the
    // honest position and this migration leaves it that way.
    expect(executable).not.toMatch(/UPDATE\s+public\.ca_diamond_incidents/);
    expect(executable).not.toMatch(/DELETE\s+FROM/);
    expect(executable).not.toMatch(/INSERT\s+INTO\s+public\.ca_diamond_incidents/);
    expect(executable).not.toMatch(/\bbackdate|occurred_at\s*=|resolved_at\s*=\s*now\(\)/);
    // 10.12: no cron, sweep, backfill, reconciler or healer as the answer.
    expect(executable).not.toMatch(/cron\.(schedule|alter_job|unschedule)/);
    // The names 10.12 refuses in review, with their underscores, so that
    // fn_ca_diamond_health_watch is not mistaken for a healer.
    expect(executable).not.toMatch(/fn_[a-z_]*_(repair|backpay|redrive|sweep|catchup|heal)_/);
    // 10.86 rule 3: the reader is named in the file, not left to be guessed.
    expect(sql).toContain("fn_ca_diamond_staff_books('health')");
    expect(sql).toContain('fn_ca_diamond_health_watch at :35');
  });

  it('never flips an arena switch', () => {
    expect(executable).not.toContain('cash_games_enabled');
    expect(executable).not.toContain('tournaments_enabled');
    expect(executable).not.toMatch(/ca_arena_settings/);
  });
});
