/**
 * ===========================================================================
 *  LAW: THE SCHEDULED-WORK ROSTER IS PINNED, AND MOVING IT IS A DECISION
 * ===========================================================================
 *
 * MEASURED 2026-09-22: 121 ACTIVE pg_cron jobs, 123 rows in cron.job, once
 * 20260922155223 is applied. The roster file says how that was measured:
 * production read at its observed_at (132 of 134), minus the eleven rows that
 * migration unschedules. The two that are not active are the bust sweeps that
 * 20260910073355_the_retired_sweeps_keep_their_disabled_schedule_rows restored
 * and disabled, so the staged retirement chain 20260910000850 - whose CHECK
 * constraints demand exactly two rows - can still be applied.
 *
 * WHY A FILE AND NOT A QUERY. Law tests run in CI with no database
 * credentials, so this cannot ask production anything. It does not need to.
 * The count lives in docs/attestation/cron-roster.tsv, which git owns and
 * Supabase cannot reach, exactly as docs/attestation/ already does for the
 * ledger, and scripts/ci/anchor-cron-roster.mjs refreshes it from Cron Health's
 * EXISTING schedule. No new timer, and no roster table: 20260906114257 deleted
 * ca_expected_cron_jobs and its hourly watcher on the owner's order, and
 * nothing here brings either back.
 *
 * WHAT IT CATCHES, IN BOTH DIRECTIONS. A job that appears is periodic work
 * nobody reviewed. A job that VANISHES is 20260831112020 happening again: a
 * migration recorded as applied whose cron job was simply not in cron.job any
 * more, which no other check in this estate can see, because every one of them
 * measures jobs that RUN AND FAIL and a job that no longer exists never fails.
 *
 * THE ONE THAT MATTERS LATER. The pin binds from the file's own observed_at.
 * Any job added after it moves the body, the header and the constant below,
 * and all three have to move together in one reviewed diff. That is the whole
 * mechanism: the number is not defended, it is made impossible to change
 * quietly.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const ROSTER = join(ROOT, 'docs', 'attestation', 'cron-roster.tsv');

/**
 * Measured 2026-09-20. Moving these is the deliberate edit this law is for.
 *
 * 135 -> 132 on 2026-09-20. Migration
 * three_watchers_whose_defects_were_fixed_stop_running retired
 * union-seat-provenance-heal, ca-bbj-repair-unbanked-15m and
 * reconcile-club-table-counts-nightly. Each one repaired a column whose writer
 * had since been made universal, so each repaired nothing and was read as
 * coverage. The argument for every one of the three is in that migration's
 * header, and the roster header records the same change. The two retained
 * inactive rows are untouched.
 *
 * 132 -> 121 on 2026-09-22. Migration
 * 20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running
 * retired ca-redrive-unbanked-rake-15m, rake-repair-unbanked-hourly,
 * ca-union-rake-attribution-hourly, ca-bounty-backpay-hourly,
 * ca-payout-sweep-hourly, spin_repair_missing_multiplier, spin_sweep_unbooked,
 * ca-spin-return-unawarded-draws-15m, ca-promo-accrual-retry-10m,
 * ca-post-commit-orphan-drain-10m and ca-pgrst-reload-if-stale. Each one
 * compensated for a writer that is now correct at its source, each candidate
 * set was empty, and each had done no work for seven days or more; the
 * argument for every one is in that migration's header. The two retained
 * inactive rows are untouched again, and
 * tests/a-retired-compensation-job-is-never-scheduled-again.law.test.ts keeps
 * all fourteen names from coming back.
 *
 * 121 -> 124 active and 2 -> 3 retained inactive on 2026-09-30, read live.
 * No previously pinned job changed its schedule. Four jobs appeared:
 * rakeback-settler-stranded-source-check-hourly (applied migration
 * 20260927220353), horse-stackoff-audit-20m (20260927221321),
 * horse-daily-audit-fallback (20260928000527, an applied migration with no
 * file in either repo), and midway-close-once-20260929d, which no migration
 * mentions at all: it carries union-weekly-rakeback-close's command as a
 * one-shot for 2026-09-29 13:04 UTC, ran once on that minute, and is now a
 * spent schedule whose next fire is 2027. One job left the ACTIVE set without
 * vanishing: union-weekly-rakeback-close is still row jobid 272 of cron.job
 * with active = false, stood down while 20260928164258 reworked the weekly
 * close, which is why RETAINED_INACTIVE moves with ACTIVE_JOBS here. Each move
 * is named in docs/attestation/cron-roster.tsv's header beside this one.
 *
 * 124 -> 125 active and 3 -> 2 retained inactive on 2026-10-03, read live from
 * fn_ca_cron_health('24 hours'). TOTAL_JOBS is 127 on both sides of this move,
 * and that is a coincidence of three separate rows, not one row standing still:
 *   - client-error-events-prune APPEARED, scheduled by applied migration
 *     20261003080431 players_errors_reach_a_first_party_sink. It prunes
 *     public.client_error_events on a 14-day retention, which is the kind of
 *     timer CLAUDE.md 10.12 explicitly allows: its schedule is the work.
 *   - union-weekly-rakeback-close RETURNED to the active set. Applied migration
 *     20261003101805 the_weekly_close_commits_one_round_at_a_time re-armed
 *     jobid 272 with cron.alter_job(..., active := true), so it leaves
 *     retained-inactive (3 -> 2) and enters the body (124 -> 125). The two
 *     remaining inactive rows are the bust sweeps 20260910073355 restored.
 *   - midway-close-once-20260929d VANISHED from cron.job entirely. The
 *     2026-09-30 note above recorded it as a hand-made spent one-shot and said
 *     unscheduling it was its owner's call; it has been unscheduled, also by
 *     hand (no applied migration's statements name it). It is therefore NOT
 *     20260831112020 recurring: no migration is recorded as applied whose job
 *     went missing underneath it. The argument for all three is in
 *     docs/attestation/cron-roster.tsv's header beside this one.
 */
/*
 * 125 -> 126 active on 2026-10-04: postgrest-pool-renew-10m, scheduled by
 * the_api_pool_is_renewed_before_it_outgrows_the_host (argument in its header).
 *
 * 126 -> 128 active on 2026-10-07, read live from fn_ca_cron_health('24 hours')
 * (127 active) plus the one job 20261007034146 schedules:
 * ca-diamond-cash-rake-sweep-hourly, design R4's periodic sweep of the Diamond
 * cash rake to the house (ruling 26; argument in that migration's header).
 * The reading also found horse-presence-heartbeat, scheduled by applied
 * migration 20261005174041 without this file being moved, and
 * ca-ratchet-watch-hourly moved from :35 to :29 by applied migration
 * 20261004002936. The roster header names all three.
 * 128 -> 129 active on 2026-10-09: lightning-alert-sweep-1m, scheduled by
 * 20261009144343 lightning_phase_12_operator_dashboard_and_alerting through
 * the managed cron API (Lightning operator alerting, Phase 21; argument in
 * that migration's header).
 */
const ACTIVE_JOBS = 129;
const RETAINED_INACTIVE = 2;
const TOTAL_JOBS = ACTIVE_JOBS + RETAINED_INACTIVE;

const raw = readFileSync(ROSTER, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim() !== '');
const body = lines.filter((l) => !l.startsWith('#'));
const headerValue = (k: string): string =>
  (new RegExp(`^#\\s*${k}:\\s*([^\\t\\n]+)`, 'm').exec(raw)?.[1] ?? '').trim();

describe('the scheduled-work roster is pinned', () => {
  it('holds exactly the number of active jobs this law was measured against', () => {
    expect(
      body.length,
      `the roster holds ${body.length} active job(s) and this law was measured at ` +
        `${ACTIVE_JOBS}. A job appeared or vanished on production. Do not edit one ` +
        `number to match the other: find out which job moved and why, then move the ` +
        `file, its "# active:" header and ACTIVE_JOBS together in one reviewed change.`
    ).toBe(ACTIVE_JOBS);
  });

  it('the file agrees with itself about how many it holds', () => {
    expect(Number(headerValue('active'))).toBe(body.length);
    expect(Number(headerValue('retained-inactive'))).toBe(RETAINED_INACTIVE);
  });

  it('131 total is 129 active plus the two rows cron.job keeps inactive', () => {
    expect(TOTAL_JOBS).toBe(131);
    // The two bust sweeps 20260910073355 restored disabled are both of them
    // again: union-weekly-rakeback-close was the third until 20261003101805
    // re-armed jobid 272, and it is now an ACTIVE row of the body instead.
    expect(raw).toContain('20260910073355');
    expect(body.some((l) => l.startsWith('union-weekly-rakeback-close\t'))).toBe(true);
  });

  it('every row is one job name and one schedule, and no name repeats', () => {
    const seen = new Set<string>();
    for (const line of body) {
      const [name, schedule, ...rest] = line.split('\t');
      expect(rest, `extra columns: ${line}`).toHaveLength(0);
      expect(name, `a roster row has no job name: ${line}`).toMatch(/\S/);
      expect(
        schedule.trim().split(/\s+/).length,
        `${name} has a malformed schedule "${schedule}"`
      ).toBeGreaterThanOrEqual(5);
      expect(seen.has(name), `${name} appears twice`).toBe(false);
      seen.add(name);
    }
  });

  it('it says when it was observed, and what produced it', () => {
    expect(Number.isFinite(Date.parse(headerValue('observed_at')))).toBe(true);
    expect(raw).toContain('scripts/ci/anchor-cron-roster.mjs');
    expect(raw).toContain('fn_ca_cron_health');
  });

  it('it is refreshed from a schedule that already existed, never a new one', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/cron-health.yml'), 'utf8');
    expect(wf).toContain('node scripts/ci/anchor-cron-roster.mjs');
    const crons = [...wf.matchAll(/- cron:/g)].length;
    expect(crons, 'the roster must ride the existing timer, not add one').toBe(1);
  });

  it('the generator refuses an unreadable or empty answer rather than erasing the roster', () => {
    const gen = readFileSync(join(ROOT, 'scripts/ci/anchor-cron-roster.mjs'), 'utf8');
    expect(gen).toContain('refusing to treat that as "no jobs"');
    expect(gen).toContain('That is not a normal empty; refusing.');
  });

  it('the generator does not recreate the table or the watcher that were deleted', () => {
    // Asserted against CODE, not prose. The generator's own docblock explains
    // that 20260906114257 removed ca_expected_cron_jobs and its hourly watcher,
    // so a raw match would fail on the explanation of why it must not exist -
    // the CLAUDE.md 7.3 trap. blankNonCode blanks JavaScript comments and
    // string literals, which is exactly the right scope here.
    const code = blankNonCode(
      readFileSync(join(ROOT, 'scripts/ci/anchor-cron-roster.mjs'), 'utf8')
    );
    expect(code).not.toMatch(/ca_expected_cron_jobs/);
    expect(code).not.toMatch(/cron\.schedule\s*\(/);
  });
});
