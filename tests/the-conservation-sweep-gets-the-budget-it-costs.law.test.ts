import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CONSERVATION SWEEP GETS THE BUDGET IT COSTS (2026-09-27).
 *
 * `ca-conservation-sweep-hourly` ran fn_ca_conservation_sweep() under the
 * postgres login's default 2-minute statement_timeout. The sweep costs
 * 100-120 s (one success in 24 hours at 106.98 s; every other run cancelled at
 * exactly 120 s). A cancel is QUERY_CANCELED, which the sweep's per-check
 * `EXCEPTION WHEN OTHERS` does not catch, so each failed run rolled back its
 * findings and its ca_detector_runs row, and no sweep incident could ever be
 * re-measured or closed.
 *
 * The law: the job that schedules the sweep sets its own statement budget, and
 * that budget is at least three times the measured cost and under the hourly
 * period. The latest migration that defines the job's command is what
 * production runs, so that is the one read.
 */

const MEASURED_SWEEP_SECONDS = 107;
const HOURLY_PERIOD_SECONDS = 3600;

const migrationsDir = resolve(__dirname, '..', 'supabase/migrations');

/** Every migration that sets the sweep job's command, oldest first. */
function commandDefinitions() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(migrationsDir, f), 'utf8') }))
    .map(({ file, sql }) => ({
      file,
      code: sql
        .split('\n')
        .filter((line) => !/^\s*--/.test(line))
        .join('\n'),
    }))
    .filter(
      ({ code }) =>
        /ca-conservation-sweep-hourly/.test(code) &&
        /fn_ca_conservation_sweep\(\)/.test(code) &&
        /cron\.(schedule|alter_job)/.test(code)
    );
}

/** The statement budget, in seconds, a command string gives itself (0 if none). */
export function budgetSeconds(command: string) {
  const m = command.match(/SET\s+statement_timeout\s*=\s*''?(\d+)\s*(s|min|ms)?''?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  return unit === 'min' ? n * 60 : unit === 's' ? n : n / 1000;
}

describe('the conservation sweep gets the budget it costs', () => {
  const defs = commandDefinitions();

  it('the job is defined by a migration on disk', () => {
    expect(defs.length).toBeGreaterThan(0);
  });

  it('the command production runs sets a budget of at least 3x the measured cost and under an hour', () => {
    const latest = defs[defs.length - 1];
    const budget = budgetSeconds(latest.code);
    expect(budget, latest.file).toBeGreaterThanOrEqual(3 * MEASURED_SWEEP_SECONDS);
    expect(budget, latest.file).toBeLessThan(HOURLY_PERIOD_SECONDS);
  });

  it('keeps the schedule and the function unchanged', () => {
    const latest = defs[defs.length - 1];
    expect(latest.code).toContain("'52 * * * *'");
    expect(latest.code).toContain('SELECT public.fn_ca_conservation_sweep();');
  });

  it('NEGATIVE: the command as first scheduled has no budget and would be refused', () => {
    const first = defs[0];
    expect(first.file).toBe('20260902045354_schedule_the_sweep_and_the_orphan_guard.sql');
    const scheduled = first.code.slice(first.code.indexOf("'ca-conservation-sweep-hourly'"));
    const firstCall = scheduled.slice(0, scheduled.indexOf(');') + 2);
    expect(budgetSeconds(firstCall)).toBeLessThan(3 * MEASURED_SWEEP_SECONDS);
  });

  it('the budget reader understands the shapes the estate uses', () => {
    expect(budgetSeconds("SET statement_timeout = '600s'; SELECT 1")).toBe(600);
    expect(budgetSeconds("SET statement_timeout = ''600s''; SELECT 1")).toBe(600);
    expect(budgetSeconds("SET statement_timeout = '10min'; SELECT 1")).toBe(600);
    expect(budgetSeconds(' SELECT public.fn_ca_conservation_sweep(); ')).toBe(0);
  });
});
