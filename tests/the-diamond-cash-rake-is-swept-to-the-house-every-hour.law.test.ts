/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE DIAMOND CASH RAKE IS SWEPT TO THE HOUSE EVERY HOUR (2026-10-07)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A raked Diamond cash hand accrues its rake player-side, in
 * ca_diamond_rake_accrual inside the arena float. The house receives it only
 * when fn_ca_diamond_sweep_cash_rake runs (design R4: "a periodic sweep: one
 * house write per sweep, not per hand"). Until 2026-10-07 nothing called it.
 * Migration 20261007034146 runs it every hour at :14 UTC: ruling 26, decided
 * by Claude on Dan's delegation.
 *
 * This pins the schedule and how it runs: one transaction with live proofs and
 * a periodic-work reason; one job, by name, at a minute outside the :50-:03
 * break window; its budget as a separate first statement (20261003025058), an
 * advisory lock on its own name, and the freeze gate before the sweep, which
 * is its only work (CLAUDE.md section 13, invariant 5); a proof that checks
 * exactly the command it scheduled, the arena switches and the Diamond
 * identity; no switch write and no sweep call of its own; and the cron roster
 * and ruling 26 naming the same job and minute.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const FILE = '20261007034146_the_diamond_cash_rake_is_swept_to_the_house_every_hour.sql';
const sql = readFileSync(join(ROOT, 'supabase', 'migrations', FILE), 'utf8');
const JOB = 'ca-diamond-cash-rake-sweep-hourly';
const SCHEDULE = '14 * * * *';

/** SQL with its comments removed, so prose about a call is never read as the call. */
const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
/** Every $cron$ body: the command scheduled, then the one the proof compares. */
const commands = [...code.matchAll(/\$cron\$([\s\S]*?)\$cron\$/g)].map((m) => m[1]);

describe('LAW: the Diamond cash rake is swept to the house every hour', () => {
  it('is one transaction with live proofs and a periodic-work reason', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(
      /^-- @live-proof: \(SELECT count\(\*\) = 1 FROM cron\.job WHERE jobname = 'ca-diamond-cash-rake-sweep-hourly' AND active AND schedule = '14 \* \* \* \*'\)$/m
    );
    expect(sql).toMatch(
      /^-- periodic-work: design R4 says per-hand Diamond rake accrues player-side/m
    );
  });

  it('schedules exactly one job, by name, and removes an earlier one first', () => {
    const scheduled = [...code.matchAll(/cron\.schedule\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/g)];
    expect(scheduled.map((m) => [m[1], m[2]])).toEqual([[JOB, SCHEDULE]]);
    expect(code).toMatch(
      /SELECT cron\.unschedule\(jobid\) FROM cron\.job WHERE jobname = 'ca-diamond-cash-rake-sweep-hourly';/
    );
  });

  it('runs at one minute an hour, outside the :50-:03 break window', () => {
    const [minute, ...rest] = SCHEDULE.split(' ');
    expect(rest).toEqual(['*', '*', '*', '*']);
    expect(Number(minute)).toBeGreaterThan(3);
    expect(Number(minute)).toBeLessThan(50);
  });

  it('wraps the sweep like the hourly jobs, behind the freeze gate', () => {
    expect(commands).toHaveLength(2);
    const [command, proved] = commands;
    expect(proved, 'the proof must check exactly the command it scheduled').toBe(command);
    expect(command.startsWith("SET statement_timeout = '60s'; DO $job$ BEGIN")).toBe(true);
    const lock = command.indexOf(`IF NOT pg_try_advisory_lock(hashtext('${JOB}'))`);
    const frozen = command.indexOf('ELSIF public.fn_platform_frozen() THEN');
    const sweep = command.indexOf('ELSE PERFORM public.fn_ca_diamond_sweep_cash_rake(');
    expect(lock).toBeGreaterThan(-1);
    expect(frozen).toBeGreaterThan(lock);
    expect(sweep).toBeGreaterThan(frozen);
    expect(command.match(/PERFORM /g), 'the sweep is its only work').toHaveLength(1);
  });

  it('proves the job, the switches and the Diamond identity before it commits', () => {
    expect(code).toMatch(/AND active AND schedule = '14 \* \* \* \*' AND command = c_command\)/);
    expect(code).toMatch(
      /v_before text := current_setting\('ca\.rake_sweep_schedule_switches', true\);/
    );
    expect(code).toMatch(/v_after IS DISTINCT FROM v_before/);
    expect(code).toMatch(
      /SELECT difference INTO v_diff FROM public\.fn_ca_diamond_register_vs_supply\(\);/
    );
    expect(code).toMatch(
      /to_regprocedure\('public\.fn_ca_diamond_sweep_cash_rake\(text\)'\) IS NULL/
    );
    expect(code).toMatch(
      /fn_ca_diamond_economic_text\('cash_rake_destination', 'all'\) IS DISTINCT FROM 'ca_diamond_house'/
    );
  });

  it('never writes an arena switch, and never sweeps by itself', () => {
    expect(code).not.toMatch(/\bUPDATE\s+(?:public\.)?ca_arena_settings\b/i);
    const outsideTheJob = code.replace(/\$cron\$[\s\S]*?\$cron\$/g, ' ');
    expect(outsideTheJob).not.toMatch(/fn_ca_diamond_sweep_cash_rake\s*\(\s*'/);
  });

  it('the cron roster and ruling 26 name the same job and minute', () => {
    const roster = readFileSync(join(ROOT, 'docs', 'attestation', 'cron-roster.tsv'), 'utf8');
    expect(roster).toMatch(/^ca-diamond-cash-rake-sweep-hourly\t14 \* \* \* \*$/m);
    const rulings = readFileSync(join(ROOT, 'docs', 'DIAMOND-RULINGS.md'), 'utf8');
    expect(rulings).toMatch(
      /^## Ruling 26 \(decided by Claude on Dan's delegation, 2026-10-07\): the Diamond cash rake is swept to the house hourly at :14 UTC$/m
    );
    expect(rulings).toContain('`ca-diamond-cash-rake-sweep-hourly`');
  });
});
