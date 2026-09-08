/**
 * READING A REPORT MUST NOT CHANGE WHAT IT REPORTS ON.
 *
 * An adversarial review of the same afternoon's work found thirteen items. The
 * most expensive one was not a defect, and that finding is pinned here too:
 *
 * **4,674 horse rewards worth 159,275 diamonds expired unclaimed** — against 29
 * rows and 772 diamonds for humans, a 206x disparity that looks exactly like the
 * 10.5 failure settled hours earlier. It is Ruling 3, already applied. Dan's
 * ruling: "no clawback, no retroactive mint into idle wallets, humans and horses
 * treated alike." Amendment 2 records the backlog as **4,703 rows**; the review's
 * own counts are 4,674 + 29 = **4,703 exactly**. Same rows, one written decision.
 * Paying them would violate a ruling. What was missing was only that the decision
 * lived in a markdown file, so somebody querying the database found 159,275
 * diamonds gone with nothing beside them saying why.
 *
 * The eleven that were real share one shape, and five were shipped that same
 * afternoon by the work this file guards:
 *
 *  1. `fn_ca_diamond_health()` was declared STABLE and called
 *     `fn_ca_diamond_snapshot()`, which is VOLATILE and INSERTs. Its own
 *     `deploy gate` area reports "unexplained since the last snapshot" — so
 *     **reading the report advanced the baseline it was about to measure
 *     against.** 25 snapshots in eight hours where 8 belonged to the hourly cron;
 *     one timestamp appeared seven times. The instrument destroyed the series it
 *     existed to read.
 *  2. `fn_ca_horse_claim_due` moved money every minute with **no maintenance
 *     freeze gate** (CLAUDE.md 13 rule 5), and the Postgres backstop does not
 *     cover it: `zz_freeze_guard` is on the chip and seat tables, and neither
 *     `profiles` nor `diamond_transactions` is among them.
 *  3. After DR7 arms, a capped horse reward would die silently **and the health
 *     row would turn green as it died** — an expired row leaves the `horse
 *     claims` count. The number that must never be non-zero is rewards that
 *     expired unclaimed, and nothing watched it.
 *  4. The "fourth gate" was inert. `since_config` resets whenever any column of
 *     the config row is touched, and for DR7 the epoch was the newest of all
 *     fourteen cap rows — so touching the `wheel` cap erased DR7's evidence.
 *     Live: would_refuse 4,553 over seven days, since_config 0, gate passing.
 *  5. `pg_try_advisory_lock` skipped its unlock on a statement timeout, because
 *     `EXCEPTION WHEN OTHERS` does not trap `query_canceled` — harmless under
 *     pg_cron, a permanent leak from a pooled service_role backend. And
 *     `RETURN 0` for "could not get the lock" was byte-identical to "nothing was
 *     owed".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('reading a report does not change it', () => {
  const sql = read('reading_a_report_changed_it');
  const body = code(sql);

  describe('1. the health report reads and never writes', () => {
    it('reads the stored snapshot instead of taking one', () => {
      expect(body).toMatch(/FROM public\.ca_diamond_snapshots s ORDER BY s\.taken_at DESC LIMIT 1/);
      expect(body).not.toContain('public.fn_ca_diamond_snapshot()');
    });

    it('says so when the stored snapshot is stale, rather than reporting it as current', () => {
      expect(body).toContain('the hourly job is not running');
      expect(body).toContain('no snapshot has ever been taken');
    });

    it('proves it by counting snapshots across two reads', () => {
      expect(body).toContain('reading the health report still writes snapshots');
    });

    it('stops the dry run filing the liveness beacon', () => {
      expect(body).toContain('IF NOT p_dry_run THEN');
      expect(body).toContain('a dry run still files the liveness beacon');
    });
  });

  describe('2. the claim sweep respects the platform freeze', () => {
    it('checks fn_platform_frozen before moving anything', () => {
      expect(body).toContain('fn_platform_frozen()');
      expect(body).toContain('still moves money without checking the maintenance freeze');
    });

    it('records that the Postgres backstop does not cover diamonds', () => {
      expect(sql).toMatch(/neither `profiles` nor `diamond_transactions` is among them/);
    });
  });

  describe('3. what must never be non-zero has an area', () => {
    it('watches rewards that expired unclaimed', () => {
      expect(body).toContain('rewards lost to expiry');
      expect(body).toContain('nothing watches rewards that expire unclaimed');
    });

    it('excludes Ruling 3 by reference to the recorded decision, not a hard-coded date', () => {
      expect(body).toContain('DR0:ruling_3_backlog_expired');
      expect(body).not.toMatch(/expired_at > '2026-09-08/);
    });

    it('counts capped claims separately instead of returning a bare number', () => {
      expect(body).toMatch(
        /RETURNS TABLE \(claimed integer, capped integer, failed integer, ran boolean\)/
      );
      expect(body).toContain('v_capped := v_capped + 1');
    });
  });

  describe('4. the flip gate reads what a rule would refuse', () => {
    it('gates on would_refuse, not on the resettable since_config', () => {
      expect(body).toContain('IF v_fc.would_refuse > 0 THEN');
    });

    it('calls a window younger than the evidence period unknown, never clean', () => {
      expect(body).toContain("'unknown'::text");
      expect(body).toContain('evidence window is too short to judge');
    });

    it('asserts the cap rule cannot arm while thousands of refusals sit in its window', () => {
      expect(body).toContain('the cap rule would arm despite thousands of refusals');
    });
  });

  describe('5. the lock cannot leak and silence cannot mean success', () => {
    it('uses an xact-scoped lock with no unlock path to miss', () => {
      expect(body).toContain('pg_try_advisory_xact_lock');
      expect(body).not.toContain('pg_advisory_unlock');
    });

    it('distinguishes "did not run" from "nothing was owed"', () => {
      expect(body).toMatch(/RETURN QUERY SELECT 0, 0, 0, false/);
      expect(body).toContain('the sweep reported it did not run outside a freeze');
    });
  });

  describe('the report knows when it cannot tell', () => {
    it('isolates every area so one failure does not empty the report', () => {
      // Fourteen areas, each in its own BEGIN/EXCEPTION.
      expect((body.match(/could not be read: /g) || []).length).toBeGreaterThanOrEqual(13);
    });

    it('has an unknown status and refuses anything outside its four', () => {
      expect(body).toContain("h.status NOT IN ('ok', 'attention', 'critical', 'unknown')");
    });

    it('reads cron liveness from run history, not from active alone', () => {
      expect(body).toContain('cron.job_run_details');
      expect(body).toContain('Scheduled is not running.');
    });
  });

  describe('Ruling 3 is recorded where people look', () => {
    it('files the write-off through the platform incident path', () => {
      expect(body).toContain("'DR0:ruling_3_backlog_expired'");
      expect(body).toContain('fn_ca_diamond_incident');
    });

    it('says plainly that these are not owed, and why', () => {
      expect(body).toContain('Do not pay them.');
      expect(body).toContain('4674 horse + 29 human = 4703');
    });

    it('pays nobody', () => {
      expect(body).not.toMatch(/UPDATE\s+public\.profiles\s+SET\s+diamonds/i);
      expect(body).not.toMatch(
        /UPDATE public\.user_daily_challenges[\s\S]{0,80}expired_at = NULL/i
      );
    });

    it('is asserted to exist, so the decision is findable in the database', () => {
      expect(body).toContain('still recorded only in a markdown file');
    });
  });

  describe('the small ones', () => {
    it('excludes the beacon namespace from the retired-rule report', () => {
      expect(body).toContain('DR0:%');
      expect(body).toContain('NOT LIKE');
    });

    it('puts OVERDUE above "probably fixed already"', () => {
      expect(body).toContain('OVERDUE AND LOUD');
    });

    it('revokes the normaliser from anon and authenticated', () => {
      expect(body).toMatch(
        /REVOKE ALL ON FUNCTION public\.fn_ca_normalise_claim_loop\(text\) FROM PUBLIC, anon, authenticated/
      );
      expect(body).toContain('still executable by authenticated');
    });

    it('extends the append-only trigger to TRUNCATE, which a row trigger never sees', () => {
      expect(body).toMatch(/BEFORE TRUNCATE ON public\.ca_diamond_engine_spend/);
    });

    it('clears the stale comment describing a claim that has moved', () => {
      expect(body).toContain('through the SAME claim');
    });
  });

  describe('the whole migration', () => {
    it('moves no money and proves it', () => {
      expect(body).toContain('players + float <> register');
    });

    it('creates nothing that repairs or backfills (CLAUDE.md 10.12)', () => {
      expect(body).not.toMatch(
        /CREATE\s+(OR REPLACE\s+)?FUNCTION[^;]{0,200}(_repair_|_backpay_|_redrive_|_catchup_|_heal_)/i
      );
    });

    it('records the most expensive finding as NOT a defect, with the arithmetic', () => {
      expect(sql).toContain('The most expensive one is');
      expect(sql).toContain('not a defect');
      expect(sql).toContain('4,703 exactly');
    });
  });
});
