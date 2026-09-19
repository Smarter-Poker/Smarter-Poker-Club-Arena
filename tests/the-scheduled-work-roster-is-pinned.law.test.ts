/**
 * ===========================================================================
 *  LAW: THE SCHEDULED-WORK ROSTER IS PINNED, AND MOVING IT IS A DECISION
 * ===========================================================================
 *
 * MEASURED 2026-09-19: 135 ACTIVE pg_cron jobs, 137 rows in cron.job. The two
 * that are not active are the bust sweeps that
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

/** Measured 2026-09-19. Moving these is the deliberate edit this law is for. */
const ACTIVE_JOBS = 135;
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

  it('137 total is 135 active plus the two rows 20260910073355 kept disabled', () => {
    expect(TOTAL_JOBS).toBe(137);
    expect(raw).toContain('20260910073355');
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
