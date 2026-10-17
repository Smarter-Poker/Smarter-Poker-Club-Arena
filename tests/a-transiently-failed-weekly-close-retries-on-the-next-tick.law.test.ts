/**
 * A TRANSIENTLY FAILED WEEKLY CLOSE RETRIES ON THE NEXT TICK (2026-10-17).
 *
 * Pinned on migration 20261017180833_a_transiently_failed_weekly_close_retries_on_the_next_tick.sql.
 *
 * Job 272 re-ran a failed close every 5 minutes only after a time-budget
 * failure. A deadlock, or a visit cut off by the 240 s statement timeout,
 * waited for the next :40 tick, and an hourly attempt can never reuse the
 * 30 minute READY report receipt, so the 2026-10-05 Midway close could not
 * reach round 3. This keeps the 240 s bound and every other admission rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261017180833_a_transiently_failed_weekly_close_retries_on_the_next_tick.sql'
  ),
  'utf8'
);
const anchor = sql.match(/v_anchor constant text:=\$a\$(.*?)\$a\$;/s)?.[1] ?? '';
const replacement = sql.match(/v_new constant text:=\$r\$(.*?)\$r\$;/s)?.[1] ?? '';

describe('a transiently failed weekly close retries on the next tick', () => {
  it('is one transaction with a live proof and pinned pre and post images', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain('b8be947fc591eeac63d2c194932fac66'); // job 272 command before
    expect(sql).toContain('e5c941909e8efd80b930ffd616f0f69e'); // job 272 command after
    expect(sql).toContain('cron.alter_job(before_job.jobid,command:=command_after)');
    expect(sql).toContain("'weekly close cron changed beyond its command'");
  });

  it('keeps the time-budget retry and adds only transient failures', () => {
    expect(anchor).toContain("q.result->>'error'='weekly_scope_time_budget_exhausted'");
    expect(replacement).toContain("q.result->>'error'='weekly_scope_time_budget_exhausted'");
    expect(replacement).toContain("q.result->>'sqlstate' IN ('40P01','40001','55P03')");
    expect(replacement).toContain("v.last_outcome='statement_timeout'");
    // the same 3 hour window bounds every branch
    expect(replacement).toContain("q.status='failed' AND q.finished_at>now()-interval '3 hours'");
    expect(replacement).toContain("v.last_visit_at>now()-interval '3 hours'");
  });

  it('never widens the tick budget', () => {
    expect(sql).not.toMatch(/statement_timeout','(?!240s)\d+s'/);
    expect(replacement).not.toMatch(/set_config|scope_budget|attempt_budget|interval '(?!3 hours)/);
  });
});
