/**
 * A FAILING HOURLY CRON REACHES THE BOARD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_ca_cron_failure_watch used to report a job only after >= 5 failures and
 * 0 successes inside the last 2 hours. An hourly job fails at most twice in
 * two hours, so for every hourly or slower job the rule could never fire. On
 * 2026-09-27 ca-conservation-sweep-hourly failed 23 of 24 runs (statement
 * timeouts that record nothing for all 30 conservation checks) and nothing
 * reached the board; rake-bbj-invariant-audit-hourly, ca-settlement-correctness-30m
 * and ca-guard-defs-hourly were failing unseen beside it.
 *
 * The rule must be independent of cadence: the last three finished runs all
 * failed with no success in 2 hours, or, over 24 hours, at least 5 failures
 * and more failures than successes. Native proof:
 * scripts/ci/test-cron-failure-watch-postgres.py.
 *
 * cron.job_run_details keeps every run (about 358k rows on 2026-10-01) and is
 * indexed only by runid, so every read of it must be bounded by start_time:
 * a per-job "last three runs" subquery without a time bound is one full
 * table scan per active job, every 30 minutes.
 *
 * IF THIS TEST IS FAILING you restated fn_ca_cron_failure_watch with a window
 * that an hourly job cannot fill, or with an unbounded read of
 * cron.job_run_details. Keep the 24 hour window, the three-in-a-row rule and
 * the single 7 day pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

function newestBody(): { file: string; body: string } {
  const open = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?fn_ca_cron_failure_watch\s*\(/i;
  let found = { file: '', body: '' };
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const at = sql.search(open);
    if (at === -1) continue;
    const rest = sql.slice(at);
    const end = rest.indexOf('$function$;');
    found = { file: f, body: (end === -1 ? rest : rest.slice(0, end)).replace(/--.*$/gm, '') };
  }
  return found;
}

describe('a failing hourly cron reaches the board', () => {
  const { file, body } = newestBody();

  it('the watch is defined in a migration', () => {
    expect(file).toBeTruthy();
  });

  it('does not require a whole-window zero-success count that an hourly job cannot reach', () => {
    expect(body, `${file} still reads only the last 2 hours with zero successes`).not.toMatch(
      /interval\s+'2 hours'[\s\S]*?HAVING[\s\S]*?count\(\*\)\s+FILTER\s*\(WHERE\s+d\.status\s*=\s*'succeeded'\)\s*=\s*0/i
    );
  });

  it('reads a 24 hour window and flags a job failing more often than it succeeds', () => {
    expect(body).toMatch(/d\.start_time\s*>\s*now\(\)\s*-\s*interval\s+'24 hours'/);
    expect(body).toMatch(/fails\s*>=\s*5\s+AND\s+day\.fails\s*>\s*day\.successes/);
  });

  it('flags three straight failed runs with no success in two hours', () => {
    expect(body).toMatch(/finished_rank\s*<=\s*3/);
    expect(body).toMatch(/failed_in_a_row\s*=\s*3/);
    expect(body).toMatch(/last_success\s*<=\s*now\(\)\s*-\s*interval\s+'2 hours'/);
  });

  it('reads cron.job_run_details once, and only inside a start_time bound', () => {
    const reads = body.match(/cron\.job_run_details\s+\w+([\s\S]*?)(?:\)\s*,|\)\s*SELECT|$)/gi) ?? [];
    expect(reads.length, `${file} reads cron.job_run_details ${reads.length} times`).toBe(1);
    expect(reads[0]).toMatch(/WHERE\s+d\.start_time\s*>\s*now\(\)\s*-\s*interval\s+'7 days'/);
    expect(body).not.toMatch(/CROSS\s+JOIN\s+LATERAL/i);
  });

  it('still routes through fn_ca_raise_drift_incident with a per-job daily key', () => {
    expect(body).toMatch(/fn_ca_raise_drift_incident\(\s*'fn_ca_cron_failure_watch'/);
    expect(body).toMatch(/'cron-failing:'\s*\|\|\s*r\.jobname\s*\|\|\s*':'\s*\|\|\s*CURRENT_DATE::text/);
  });
});
