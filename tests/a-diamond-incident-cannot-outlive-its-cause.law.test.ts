/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND INCIDENT CANNOT OUTLIVE ITS CAUSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured in production on 2026-09-19: forty-five DR0:health_critical rows
 * sat open in ca_diamond_incidents, filed hourly between 09-09 and 09-11 by
 * fn_ca_diamond_health_watch. Every cause they named (expired horse rewards,
 * a -100 money-identity difference, an unexplained deploy gate) had read ok
 * since 09-11 16:35. Nothing in the estate resolved a DR0 row, so the
 * programme's public-release condition, "no open critical ca_diamond_incidents",
 * was literally unmet eight days after the last real critical condition.
 *
 * A watch that files a critical row is the watch that reads the source on
 * every tick, so it is the one that can say the cause has gone. The rule this
 * law pins: the newest definition of each Diamond watch resolves the rows it
 * filed, by the cause named on the row, once that cause reads clear; it
 * resolves only its own rules (DR0 for the health watch, DR11 and DR12 for the
 * trial balance watch); and it never deletes anything but the thirty-day
 * housekeeping of resolved info rows the trial balance watch has always had.
 *
 * The migration is read with its comments stripped: its header discusses
 * every string the assertions look for, and prose is not the rule.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '..', 'supabase', 'migrations');

const file = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith('_the_health_watch_resolves_what_it_filed.sql'))
  .sort()
  .at(-1);
if (!file) throw new Error('the health watch resolution migration is missing');

const executable = readFileSync(join(MIGRATIONS, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

/** The executable text of one CREATE OR REPLACE FUNCTION body. */
function body(name: string): string {
  const start = executable.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  expect(start, `${name} must be redefined by the migration`).toBeGreaterThan(-1);
  const end = executable.indexOf('$function$;', start);
  expect(end).toBeGreaterThan(start);
  return executable.slice(start, end);
}

/** Every migration that defines a watch, newest last. */
function definitions(name: string): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => ({ file: n, sql: readFileSync(join(MIGRATIONS, n), 'utf8') }))
    .filter((m) => m.sql.includes(`CREATE OR REPLACE FUNCTION public.${name}()`));
}

describe('LAW: a Diamond incident cannot outlive its cause', () => {
  it('is the newest definition of both watches', () => {
    // A later redefinition is allowed, but it must carry the resolution with
    // it. This pin is what makes a future "CREATE OR REPLACE" that drops the
    // clause fail here rather than in production.
    for (const name of ['fn_ca_diamond_health_watch', 'fn_ca_diamond_trial_balance_watch']) {
      const defs = definitions(name);
      const newest = defs.at(-1)!;
      const text = newest.sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
      expect(text, `${newest.file} must resolve what ${name} filed`).toContain(
        'resolved_at = now()'
      );
      expect(text).toContain('resolution = ');
    }
  });

  it('the health watch resolves a DR0 row only when every area it named has cleared', () => {
    const hw = body('fn_ca_diamond_health_watch');
    // Still files what it filed.
    expect(hw).toContain(
      "'DR0:health_critical', 'critical', NULL, NULL, 'fn_ca_diamond_health_watch'"
    );
    // Resolves by the areas recorded on the row, all of them.
    expect(hw).toContain("i.rule = 'DR0:health_critical' AND i.resolved_at IS NULL");
    expect(hw).toContain("d->>'area' = ANY (v_bad_areas)");
    expect(hw).toMatch(/NOT EXISTS \(SELECT 1 FROM jsonb_array_elements\(i\.detail->'detail'\)/);
    // A row that names no area is left for a person.
    expect(hw).toContain("jsonb_array_length(i.detail->'detail') > 0");
    // A report that vanished clears nothing.
    expect(hw).toMatch(/IF v_read = 0 THEN\s+RETURN v_bad;/);
    // The note says it was automatic and what was read.
    expect(hw).toContain("'auto: '");
    // Only its own rule, and never a delete.
    expect(hw).not.toMatch(/DELETE/);
    expect(hw).not.toMatch(/'DR1[0-9]:/);
  });

  it('the trial balance watch resolves a break by the account that now reads zero', () => {
    const tb = body('fn_ca_diamond_trial_balance_watch');
    for (const rule of [
      'DR11:trial_balance_break',
      'DR11:trial_balance_summary',
      'DR12:suspense_nonzero',
      'DR6:fixture_harness_unregistered_movement',
    ]) {
      expect(tb, `${rule} must still be filed`).toContain(`'${rule}'`);
    }
    expect(tb).toContain("i.rule = 'DR11:trial_balance_break' AND i.resolved_at IS NULL");
    expect(tb).toContain("i.detail->>'account' = ANY (v_clean)");
    expect(tb).toContain("i.rule = 'DR12:suspense_nonzero' AND i.resolved_at IS NULL");
    // NULL is "could not be read" and clears nothing.
    expect(tb).toMatch(/r\.difference IS NOT NULL AND r\.difference = 0/);
    expect(tb).toMatch(/r\.balance_now IS NOT NULL AND r\.balance_now = 0/);
    // The one DELETE it has always had, unchanged, and no other.
    const deletes = tb.match(/DELETE FROM public\.ca_diamond_incidents/g) ?? [];
    expect(deletes).toHaveLength(1);
    expect(tb).toContain(
      "WHERE severity = 'info' AND resolved_at IS NOT NULL AND occurred_at < now() - interval '30 days'"
    );
    // The seven-day sweep stays info-only.
    expect(tb).toContain(
      "WHERE resolved_at IS NULL AND severity = 'info' AND occurred_at < now() - interval '7 days'"
    );
  });

  it('records why a row was resolved, and nobody can call a watch without an account', () => {
    expect(executable).toMatch(/ADD COLUMN IF NOT EXISTS resolution text/);
    for (const name of ['fn_ca_diamond_health_watch', 'fn_ca_diamond_trial_balance_watch']) {
      expect(executable).toContain(
        `REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated`
      );
      expect(executable).toContain(`GRANT EXECUTE ON FUNCTION public.${name}() TO service_role`);
    }
  });

  it('starts from the bodies it read and refuses to commit with a critical cause still present', () => {
    // md5 pins on both live bodies, so a body another agent changed underneath
    // stops the migration instead of being overwritten.
    expect(executable).toMatch(
      /md5\(pg_get_functiondef\('public\.fn_ca_diamond_health_watch\(\)'::regprocedure\)\)/
    );
    expect(executable).toMatch(
      /md5\(pg_get_functiondef\('public\.fn_ca_diamond_trial_balance_watch\(\)'::regprocedure\)\)/
    );
    // One tick by the deployed code, then the gate is read, and a critical
    // cause that is still present refuses the migration: the gate is not to
    // be met by a migration.
    expect(executable).toContain('v_bad := public.fn_ca_diamond_health_watch();');
    expect(executable).toContain('v_filed := public.fn_ca_diamond_trial_balance_watch();');
    expect(executable).toMatch(/IF v_crit_after <> 0 THEN\s+RAISE EXCEPTION/);
    // A watched function's redefinition goes through the declaration door.
    expect(executable).toContain('fn_ca_declare_guard_redefinition');
  });
});
