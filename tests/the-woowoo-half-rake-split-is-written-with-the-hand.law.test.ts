/**
 * ===========================================================================
 *  LAW: THE WOOWOO HALF-RAKE SPLIT IS WRITTEN WITH THE HAND, NOT BY A TIMER
 * ===========================================================================
 *
 * Owner ruling (Dan, 2026-10-24): half of WooWoo's earned cash rake is removed
 * from his credit and given to KingFish. 20261024223153 (applied straight to
 * production, recorded byte-exact here) carried it as the pg_cron job
 * 'woowoo-half-rake-to-kingfish', which recomputed the day rows every five
 * minutes - an after-the-fact adjustment job, which CLAUDE.md 10.12 forbids,
 * and measurably behind the hands between ticks.
 *
 * 20261025030142 installs the rule as functions; 20261025030249 (daily window,
 * because CREATE TRIGGER locks the hot public.ca_hand_facts) attaches it to the
 * hand-fact write, unschedules the job and drops its function.
 *
 * WHAT THIS PINS
 *   1. The applied migration is recorded byte-exact (its md5 is production's).
 *   2. The rule's constants: who, which club, the cut, the cents arithmetic,
 *      the row keys - identical in the retired job and the write-time rule.
 *   3. The write-time rule: three row triggers on public.ca_hand_facts with
 *      WHEN clauses scoped to WooWoo's cash facts after the cut, the
 *      serialising day-row lock, no advisory lock, no is_horse.
 *   4. The job is unscheduled and its function dropped, and no later
 *      migration schedules the name or any command that runs the rule.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR, migrationCorpus, migrationText } from './helpers/migrationCorpus';
import {
  declaresMaintenanceWindow,
  validateWindowMigration,
} from '../scripts/ci/maintenance-window-migrations.mjs';

const RECORDED = '20261024223153_woowoo_half_earned_rake_credited_to_kingfish.sql';
const RECORDED_MD5 = '06c2de274fd75213f0decf83b2b62f20';
const FUNCTIONS = '20261025030142_woowoo_half_rake_split_functions_before_the_window.sql';
const WINDOW = '20261025030249_woowoo_half_rake_is_split_when_the_hand_fact_is_written.sql';

const JOB = 'woowoo-half-rake-to-kingfish';
const SYNC_FN = 'fn_woowoo_half_rake_to_kingfish_sync';
const TRIGGER_FN = 'smarter_private.tr_woowoo_half_rake_split()';

/** The rule. Changing any of these is changing Dan's ruling, not refactoring. */
const RULE = {
  club: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  woowoo: '69f2cefa-017d-49f3-ac3e-61505633747c',
  kingfish: '47965354-0e56-43ef-931c-ddaab82af765',
  cutoff: '2026-10-24 22:21:59.97593+00',
  cents: 'round(sum(coalesce(f.rake_paid, 0)) * 50)',
  woowooKey: "'woowoo-half-split-'",
  kingfishKey: "'kingfish-from-woowoo-split-'",
} as const;

const TRIGGERS = [
  'ca_hand_facts_woowoo_half_rake_split_insert',
  'ca_hand_facts_woowoo_half_rake_split_update',
  'ca_hand_facts_woowoo_half_rake_split_delete',
] as const;

/** Comments blanked; literals kept (the constants live in them). */
const code = (sql: string): string => sql.replace(/--[^\n]*/g, ' ');
const squash = (s: string): string => s.replace(/\s+/g, ' ');

describe('the WooWoo half-rake split is written with the hand, not by a timer', () => {
  const recorded = migrationText(RECORDED);
  const functions = code(migrationText(FUNCTIONS));
  const window = migrationText(WINDOW);
  const windowCode = code(window);

  it('records the applied migration byte-exact', () => {
    const bytes = readFileSync(join(MIGRATIONS_DIR, RECORDED));
    expect(createHash('md5').update(bytes).digest('hex')).toBe(RECORDED_MD5);
    expect(recorded).toContain(`cron.schedule('${JOB}'`);
  });

  it('keeps the rule exactly as the retired job computed it', () => {
    for (const [name, value] of Object.entries(RULE)) {
      expect(recorded, `the job carried ${name}`).toContain(value);
      expect(functions, `the write-time rule carries ${name}`).toContain(value);
    }
    // Rounded once on the day total, in bigint cents; the UTC day.
    expect(squash(functions)).toContain(`coalesce(${RULE.cents}, 0)::bigint`);
    expect(functions).toContain("(p_day::timestamp AT TIME ZONE 'UTC')");
    expect(functions).toContain("((p_day + 1)::timestamp AT TIME ZONE 'UTC')");
    expect(functions).toContain("(NEW.played_at AT TIME ZONE 'UTC')::date");
    expect(functions).toContain("to_char(v_day, 'YYYY-MM-DD')");
    // +half to WooWoo, -half to KingFish, both KINGS CLUB.
    expect(squash(functions)).toContain(
      `VALUES ('woowoo-half-split-' || v_key, c_club, c_woowoo, v_day, v_half,`
    );
    expect(squash(functions)).toContain(
      `VALUES ('kingfish-from-woowoo-split-' || v_key, c_club, c_kingfish, v_day, -v_half,`
    );
    // A non-positive day writes nothing, as the job.
    expect(functions).toContain('CONTINUE WHEN v_half <= 0;');
  });

  it('serialises concurrent hands on the day row, without an advisory lock', () => {
    expect(functions).toMatch(/ON CONFLICT \(operation_key\) DO NOTHING;\s*IF FOUND THEN/);
    expect(squash(functions)).toContain(
      "PERFORM 1 FROM smarter_private.player_fee_redemptions WHERE operation_key = 'woowoo-half-split-' || v_key FOR UPDATE;"
    );
    expect(functions).not.toMatch(/pg_advisory/i);
    expect(functions).toMatch(/RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER/);
    expect(functions).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.tr_woowoo_half_rake_split() FROM PUBLIC, anon, authenticated;'
    );
    expect(functions).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.fn_woowoo_half_rake_day_cents(date) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('never asks whether a player is a horse (10.5)', () => {
    expect(functions).not.toMatch(/is_horse/i);
    expect(windowCode).not.toMatch(/is_horse/i);
  });

  it('attaches the rule to the hand-fact write, inside the daily window', () => {
    expect(declaresMaintenanceWindow(window)).toBe(true);
    expect(validateWindowMigration(WINDOW, window)).toBe(true);
    expect(declaresMaintenanceWindow(migrationText(FUNCTIONS))).toBe(false);

    const ops = { insert: 'AFTER INSERT', update: 'AFTER UPDATE OF', delete: 'AFTER DELETE' };
    for (const name of TRIGGERS) {
      const at = windowCode.indexOf(`CREATE TRIGGER ${name}`);
      expect(at, `${name} is created`).toBeGreaterThan(-1);
      const stmt = squash(windowCode.slice(at, windowCode.indexOf(';', at) + 1));
      const op = ops[name.split('_').pop() as keyof typeof ops];
      expect(stmt).toContain(`${op}`);
      expect(stmt).toContain('ON public.ca_hand_facts FOR EACH ROW WHEN (');
      expect(stmt).toContain(`user_id = '${RULE.woowoo}'::uuid`);
      expect(stmt).toContain('tournament_id IS NULL');
      expect(stmt).toContain(`played_at > '${RULE.cutoff}'::timestamptz`);
      expect(stmt).toContain(`EXECUTE FUNCTION ${TRIGGER_FN};`);
    }
    expect(squash(windowCode)).toContain(
      'AFTER UPDATE OF user_id, tournament_id, played_at, rake_paid ON public.ca_hand_facts'
    );
  });

  it('unschedules the job, drops its function, and schedules nothing', () => {
    expect(windowCode).toContain(`PERFORM cron.unschedule('${JOB}');`);
    expect(windowCode).toContain(`DROP FUNCTION IF EXISTS smarter_private.${SYNC_FN}();`);
    expect(windowCode).not.toMatch(/cron\.schedule\s*\(/i);
    expect(functions).not.toMatch(/cron\.schedule\s*\(/i);
    // and proves all of it before COMMIT, against the job's own expression
    expect(windowCode).toContain(`IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${JOB}') THEN`);
    expect(squash(windowCode)).toContain(`round(sum(coalesce(f.rake_paid, 0)) * 50)::bigint AS half_cents`);
    expect(window).toMatch(/^-- @live-proof: \(NOT EXISTS \(SELECT 1 FROM cron\.job WHERE jobname = 'woowoo-half-rake-to-kingfish'\)/m);
  });

  it('no later migration brings the timer back', () => {
    const later = migrationCorpus().filter((m) => m.name > WINDOW);
    for (const m of later) {
      const sql = code(m.sql);
      expect(sql, `${m.name} schedules ${JOB}`).not.toMatch(
        new RegExp(`cron\\.schedule(_in_database)?\\s*\\(\\s*(job_name\\s*=>\\s*)?'${JOB}'`, 'i')
      );
      for (const fn of [SYNC_FN, 'tr_woowoo_half_rake_split', 'fn_woowoo_half_rake_day_cents']) {
        const scheduled = [...sql.matchAll(/cron\.schedule(_in_database)?\s*\(([\s\S]*?)\);/gi)];
        for (const s of scheduled)
          expect(s[2], `${m.name} schedules a command running ${fn}`).not.toContain(fn);
      }
    }
  });
});
