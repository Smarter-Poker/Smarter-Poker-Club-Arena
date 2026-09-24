/**
 * ===========================================================================
 *  LAW: THE HORSE CLAIM TICK IS KEPT, AND IT LOCKS IN PRIMARY KEY ORDER
 * ===========================================================================
 *
 * ca-horse-claim-due-minute runs every minute, 1,440 times a day, which is the
 * same cadence as ca-auto-reconcile-tick. That job was retired on 2026-09-24
 * for repairing nothing. This one was read against the same standard on the
 * same day and KEPT. The point of this law is that the next agent does not
 * have to re-derive that from scratch, and cannot quietly reverse it either.
 *
 * WHY IT IS KEPT. It repairs no state and stands in for no writer. It IS the
 * horse's claim button: a human is shown a completed reward and presses Claim,
 * a horse has no browser, so the engine presses for it. CLAUDE.md 10.5 names
 * that input-device branch as legitimate, alongside HorseLogic,
 * scheduleHorseAction and the synthetic heartbeat. Nothing else claims for a
 * horse, so retiring it would simply leave horses unpaid, which is the exact
 * opposite of what retiring a compensation loop does.
 *
 * THE HONEST COUNTER-ARGUMENT, recorded so it is not rediscovered as news.
 * Measured on production 2026-09-24: of 54,661 claims since 2026-09-09, 54,141
 * (99.05%) were paid on the first tick after completion and NONE was paid more
 * than a day later. The clock never adds a row to its candidate set, because
 * completed_at >= now() - 7 days is a lower bound and time only ever removes;
 * rows enter when a writer sets completed. So it does behave like a poll
 * standing in for a trigger. What makes it legitimate anyway is that the state
 * it acts on is not a defect: completed and unclaimed is the normal, correct
 * state of a reward for every player, and a human sits in it for up to seven
 * days by choice. Paying it is an action in the domain, not a correction of a
 * bad write.
 *
 * WHAT WAS ACTUALLY WRONG, and what 20260924183308 fixed. 33 claims died with
 * `deadlock detected` between 2026-09-09 and 2026-09-22 across 29 horses. The
 * whole loop is one transaction, so it holds every row lock it takes for the
 * length of the batch, and it took them in completed_at order while the four
 * daily-missions-outbox-minute shards update one player's rows in a single
 * unordered bulk UPDATE on the same minute. Overlapping rows taken in two
 * different orders is the cycle. fn_expire_daily_challenge_rewards hit the
 * same thing on 2026-09-09 and its body carries the answer: primary key order
 * for acquisition, SKIP LOCKED so a row someone else holds is left for the
 * next run. The claim loop never got it. Now it has it.
 *
 * WHAT THIS PINS
 *
 *   1. The job stays scheduled, and no migration unschedules it. Retiring it
 *      is then a deliberate edit to this law with an argument attached, not a
 *      quiet line in an unrelated migration.
 *   2. The fix is in the function the migration ships: the candidates are
 *      still chosen oldest first, and the rows are LOCKED in primary key order
 *      with SKIP LOCKED.
 *   3. The negative that matters: the locking select is not ordered by
 *      completed_at. That is the defect, and it is asserted against source
 *      with comments stripped, because the migration's own header quotes the
 *      broken ordering in prose (CLAUDE.md 7.3).
 *   4. The detector is live against the shape it must catch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const ROSTER = join(ROOT, 'docs', 'attestation', 'cron-roster.tsv');

const JOB = 'ca-horse-claim-due-minute';
const FIX = '20260924183308_the_horse_claim_takes_its_rows_in_primary_key_order.sql';

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** Line comments blanked, so a sentence in a header can never satisfy an assertion. */
const code = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/**
 * The body of the statement that TAKES THE LOCKS: everything from the join
 * onto the candidate set up to and including the row-locking clause. The
 * choosing select is a separate statement inside the CTE and is not this.
 */
const lockingSelect = (sql: string): string | null => {
  const m = /JOIN\s+oldest\b[\s\S]*?FOR\s+UPDATE\b[^\n]*/i.exec(code(sql));
  return m ? m[0] : null;
};

/** Does this migration schedule the job, by position or by job_name =>? */
const schedulesJob = (body: string): boolean =>
  new RegExp(
    `\\bcron\\s*\\.\\s*schedule(?:_in_database)?\\s*\\(\\s*(?:job_name\\s*=>\\s*)?'${JOB}'`,
    'i'
  ).test(body);

/**
 * Every migration that RETIRES this job: it unschedules the name and does not
 * put it back. 20260908161327_reading_a_report_changed_it, which created the
 * job, unschedules first for idempotency and schedules immediately after. That
 * is a rewrite, not a retirement, and it must not read as one.
 */
const retirers = (): string[] =>
  files.filter((f) => {
    const body = code(readFileSync(join(MIGRATIONS, f), 'utf8'));
    return (
      /\bcron\s*\.\s*unschedule\s*\(/i.test(body) &&
      body.includes(`'${JOB}'`) &&
      !schedulesJob(body)
    );
  });

describe('the horse claim tick is kept, and locks in primary key order', () => {
  describe('it is kept', () => {
    it('no migration retires it', () => {
      expect(
        retirers(),
        `${JOB} is the horse's claim button, not a compensation loop: nothing else ` +
          'claims for a horse, so unscheduling it leaves horses unpaid. If that is ' +
          'genuinely intended, change this law and bring the argument (CLAUDE.md 10.5).'
      ).toEqual([]);
    });

    it('the scheduled-work roster still lists it', () => {
      const listed = readFileSync(ROSTER, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.startsWith('#'))
        .map((l) => l.split('\t')[0]);
      expect(listed).toContain(JOB);
    });

    it('the migration that fixed it schedules and unschedules nothing', () => {
      const body = code(readFileSync(join(MIGRATIONS, FIX), 'utf8'));
      expect(body).not.toMatch(/\bcron\s*\.\s*schedule(?:_in_database)?\s*\(/i);
      expect(body).not.toMatch(/\bcron\s*\.\s*unschedule\s*\(/i);
      expect(body).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    });
  });

  describe('the fix is in the function it ships', () => {
    const sql = readFileSync(join(MIGRATIONS, FIX), 'utf8');

    it('exists on disk under the reserved version', () => {
      expect(files).toContain(FIX);
    });

    it('still chooses the oldest first, so a limit strands nothing near expiry', () => {
      expect(code(sql)).toContain('ORDER BY u.completed_at, u.id');
    });

    it('LOCKS in primary key order, with SKIP LOCKED', () => {
      const locking = lockingSelect(sql);
      expect(locking).not.toBeNull();
      expect(locking).toMatch(/ORDER\s+BY\s+u\.id\b/i);
      expect(locking).toMatch(/FOR\s+UPDATE\s+OF\s+u\s+SKIP\s+LOCKED/i);
    });

    it('THE NEGATIVE: the locking select is not ordered by completed_at', () => {
      const locking = lockingSelect(sql);
      expect(locking).not.toBeNull();
      expect(
        locking,
        'taking the row locks in completed_at order is the defect that deadlocked ' +
          '33 claims across 29 horses between 2026-09-09 and 2026-09-22'
      ).not.toMatch(/completed_at/i);
    });

    it('keeps the guards it already had', () => {
      const body = code(sql);
      expect(body).toContain('pg_try_advisory_xact_lock');
      expect(body).toContain('fn_platform_frozen');
      expect(body).toContain('claim_daily_challenge_serialized_body');
      expect(body).toContain('CH3:horse_claim_failed');
      expect(body).toContain('DR7:user_over_daily_cap');
    });

    it('asserts its own post-state rather than hoping', () => {
      const body = code(sql);
      expect(body.trim().startsWith('BEGIN;')).toBe(true);
      expect(body.trim().endsWith('COMMIT;')).toBe(true);
      expect(body).toContain('v_active IS DISTINCT FROM 121 OR v_total IS DISTINCT FROM 123');
    });

    it('states a live proof the merged-migration check can ask production', () => {
      expect(sql).toMatch(/^-- @live-proof: .+SKIP LOCKED.+$/m);
    });
  });

  describe('the detector is live', () => {
    it('catches the defective shape it exists to refuse', () => {
      const broken =
        'FOR r IN\n' +
        '  WITH oldest AS (SELECT u.id FROM public.user_daily_challenges u ' +
        'ORDER BY u.completed_at, u.id LIMIT 500)\n' +
        '  SELECT u.id, u.user_id FROM public.user_daily_challenges u\n' +
        '  JOIN oldest o ON o.id = u.id\n' +
        '  ORDER BY u.completed_at, u.id\n' +
        '  FOR UPDATE OF u\n' +
        'LOOP';
      const locking = lockingSelect(broken);
      expect(locking).not.toBeNull();
      expect(locking).toMatch(/completed_at/i);
      expect(locking).not.toMatch(/SKIP\s+LOCKED/i);
    });

    it('is not satisfied by the broken ordering appearing only in a comment', () => {
      const prose =
        '-- it used to say JOIN oldest o ON o.id = u.id ORDER BY u.completed_at FOR UPDATE\n' +
        'SELECT 1;';
      expect(lockingSelect(prose)).toBeNull();
    });

    /** The rule `retirers` applies, run against one migration's text. */
    const retires = (sql: string): boolean => {
      const body = code(sql);
      return (
        /\bcron\s*\.\s*unschedule\s*\(/i.test(body) &&
        body.includes(`'${JOB}'`) &&
        !schedulesJob(body)
      );
    };

    it('sees a retirement however the unschedule is written', () => {
      expect(retires(`SELECT cron.unschedule('${JOB}');`)).toBe(true);
      expect(
        retires(
          `DO $d$ BEGIN PERFORM cron.unschedule((SELECT jobid FROM cron.job WHERE jobname = '${JOB}')); END $d$;`
        )
      ).toBe(true);
    });

    it('does not read a rewrite as a retirement', () => {
      expect(
        retires(
          `SELECT cron.unschedule('${JOB}') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${JOB}');\n` +
            `SELECT cron.schedule('${JOB}', '* * * * *', $$SELECT public.fn_ca_horse_claim_due(500)$$);`
        )
      ).toBe(false);
      expect(
        retires(
          `SELECT cron.unschedule('${JOB}');\n` +
            `SELECT cron.schedule(job_name => '${JOB}', schedule => '* * * * *', command => 'SELECT 1');`
        )
      ).toBe(false);
    });

    it('does not read a commented-out unschedule as a real one', () => {
      expect(retires(`-- PERFORM cron.unschedule('${JOB}');\nSELECT 1;`)).toBe(false);
    });
  });
});
