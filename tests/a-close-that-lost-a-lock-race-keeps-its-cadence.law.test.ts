/**
 * A CLOSE THAT LOST A LOCK RACE KEEPS ITS CADENCE (2026-10-17)
 *
 * Job 272 retried a failed close every 5 minutes only for a time-budget
 * failure. A deadlocked round 3 (40P01) was therefore retried once an hour,
 * after its 30-minute report receipt had expired, so every hourly attempt
 * timed out and the book never reached round 3 again. A transient lock error
 * now keeps the same 5-minute, 3-hour retry as a time-budget failure; every
 * other failure keeps the hourly one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017174849_a_close_that_lost_a_lock_race_keeps_its_cadence.sql',
  'utf8'
);
const added = sql.split('$n$')[1];

describe('a close that lost a lock race keeps its cadence', () => {
  it('retries exactly the transient lock errors, for three hours', () => {
    expect(added).toContain(
      "OR EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status='failed' AND q.result->>'sqlstate' IN ('40P01','40001','55P03') AND q.finished_at>now()-interval '3 hours')"
    );
    expect(added.match(/IN \('40P01','40001','55P03'\)/g)?.length).toBe(1);
  });

  it('keeps the time-budget retry and changes nothing else in job 272', () => {
    expect(added.startsWith(sql.split('$o$')[1])).toBe(true);
    expect(sql).toContain("PERFORM cron.alter_job(j, schedule := '*/5 * * * *', command := c, active := true);");
    expect(sql).toContain("'b8be947fc591eeac63d2c194932fac66'");
    expect(sql).toContain("'c74214f0f7e65064769601dbe867ec28'");
    expect(sql).toContain('fn_ca_break_window_refuses_migrations(now())');
  });
});
