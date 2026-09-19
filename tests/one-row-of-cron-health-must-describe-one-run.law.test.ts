/**
 * ===========================================================================
 *  LAW: ONE ROW OF CRON HEALTH MUST DESCRIBE ONE RUN
 * ===========================================================================
 *
 * `fn_ca_cron_health()` is the first query in the estate handoff and the
 * thing CI reads to decide whether any scheduled job is failing silently.
 * It built each row out of TWO DIFFERENT RUNS:
 *
 *   max(r.start_time)                                      as last_run_at
 *   left(max(r.return_message) filter (...failed...), 200) as last_error
 *
 * `last_run_at` is the most recent run of any status. `last_error` is an
 * aggregate over failure TEXT, so it returns the lexicographically greatest
 * message anywhere in the window. It is not the most recent failure, and it
 * bears no relationship to the run printed beside it.
 *
 * MEASURED 2026-09-19. Three jobs had been fixed that morning and had already
 * succeeded (`tourney_money_conservation_hourly` at 16:12,
 * `ca-pay-backed-payout-shortfalls-hourly` at 16:26, `rake-law-adherence-hourly`
 * at 15:40 and 16:40). All three still displayed a statement-timeout error
 * beside a current timestamp, and `ca-conservation-sweep-hourly` displayed one
 * while its five most recent runs had all succeeded. An agent reading that
 * output concluded the estate was broken and began re-diagnosing finished
 * work. That is the most expensive direction for this particular function to
 * be wrong in, because it is the function people consult to decide what to
 * work on.
 *
 * THE FIX was not to pick a better failure. It was to stop letting one row
 * describe two runs: `last_run_status`, `last_error` and `last_error_at` are
 * now columns of a single `DISTINCT ON` row, so they cannot disagree.
 *
 * MEASURED across all migrations mentioning `return_message`: exactly two
 * carry an aggregate over it, `20260831193608_nothing_was_watching_the_scheduled_work`
 * and `20260831193846_a_job_that_is_still_running_has_not_failed`, which are
 * the two that built the old shape. Both are superseded by
 * `20260919172421`. THE ONE THAT MATTERS LATER is the forward guard: it binds
 * from 20260920, the day after this fix, so every migration written from here
 * on is covered and the two historical definitions stay readable.
 *
 * NOTE ON ASSERTING THE NEGATIVE (CLAUDE.md 7.3): this migration's own header
 * quotes the band-aid it refuses, `(array_agg(r.return_message ORDER BY ...))`.
 * `blankNonCode` from tests/helpers/sourceWindow blanks JavaScript comments and
 * does not know about SQL's `--`, so every negative assertion below runs
 * against a SQL-comment-stripped copy. Without that, this law would fail on the
 * prose that explains it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceDollarQuoted } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const THIS_MIGRATION = '20260919172421_one_row_of_cron_health_must_describe_one_run.sql';

/** The day after this fix. Everything from here on is covered. */
const FORWARD_GUARD_FROM = '20260920';

/**
 * Blank SQL string literals first, then SQL line comments, preserving length.
 * Literals go first on purpose: a literal such as '----' would otherwise be
 * read as the start of a comment and eat the rest of the line.
 */
const sqlCode = (sql: string): string =>
  sql
    .replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length))
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));

/** max/min/array_agg/string_agg applied to return_message, in any alias. */
const AGGREGATE_OVER_RETURN_MESSAGE =
  /(?:max|min|array_agg|string_agg)\s*\(\s*[a-z_]*\.?return_message/i;

const read = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

const offendingLines = (sql: string): string[] =>
  sqlCode(sql)
    .split('\n')
    .filter((line) => AGGREGATE_OVER_RETURN_MESSAGE.test(line));

describe('one row of cron health must describe one run', () => {
  it('the fix does not aggregate over failure text', () => {
    const body = sliceDollarQuoted(read(THIS_MIGRATION), '$function$');
    expect(offendingLines(body)).toEqual([]);
  });

  it('the evidence columns come from one DISTINCT ON row', () => {
    const body = sqlCode(sliceDollarQuoted(read(THIS_MIGRATION), '$function$'));

    // The single row every evidence column reads from.
    expect(body).toContain('distinct on (w.jobid)');

    // last_error, last_run_status and last_error_at must all read that row's
    // alias. If any one of them stopped doing so, the pairing this law exists
    // to protect would be broken again.
    const evidence = body.split('\n').filter((line) => /\blf\./.test(line));
    expect(evidence.length).toBeGreaterThanOrEqual(3);
  });

  it('the header still argues against the band-aid it refused', () => {
    // Asserted against the RAW source: this one is supposed to be prose, and
    // a future editor deleting the explanation should fail this law.
    const raw = read(THIS_MIGRATION);
    expect(raw).toContain('array_agg(r.return_message ORDER BY r.start_time DESC)');
    expect(raw).toContain('a row describes two runs at once');
  });

  it('THE ONE THAT MATTERS LATER: no migration after 20260920 reintroduces it', () => {
    const offenders: string[] = [];

    for (const file of readdirSync(MIGRATIONS)) {
      if (!file.endsWith('.sql')) continue;
      if (file < FORWARD_GUARD_FROM) continue;

      const sql = read(file);
      if (!sqlCode(sql).includes('fn_ca_cron_health')) continue;

      for (const line of offendingLines(sql)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
