/**
 * A SAMPLE OF ONE IS NOT A VERDICT
 *
 * Cron Health run 37105150898 called two DAILY jobs "RAN AND NEVER SUCCEEDED -
 * these are broken, not flaky" on the strength of `1 failed / 1 runs`. A
 * '25 3 * * *' job puts exactly one run inside the function's 24 hour window,
 * so `successes = 0` says nothing at all about whether the job is broken, and
 * fn_ca_cron_health was asserting its strongest verdict off that (CLAUDE.md
 * 10.86 rule 1: "I could not tell" needs its own answer, not the confident
 * one).
 *
 * 20261003072524 resolves the single-sample case against the job's last THREE
 * finished runs instead. This pins the three things a future edit could get
 * wrong, in the direction each would go wrong:
 *
 *   1. the look-back must stay BOUNDED and stay at three. Five would have
 *      cleared both jobs in that run and turned the migration into a way of
 *      making the board green; the file says so, and this makes widening it a
 *      deliberate, reviewed edit rather than a quiet one.
 *   2. the branch must only fire for a genuine sample of one. If it stopped
 *      checking `failures + successes = 1`, a minutely job with 1,431 failed
 *      runs would be excused by one success three runs ago, which is the
 *      outage (sp_upcoming_tournament_pushes) this function exists for.
 *   3. 'critical' must still exist and still be reachable. A verdict nobody
 *      can reach is a muted check.
 *
 * CI has no database credentials, so this reads the migration the same way
 * tests/one-row-of-cron-health-must-describe-one-run.law.test.ts does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceDollarQuoted } from '../helpers/sourceWindow';

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  'supabase',
  'migrations',
  '20261003072524_a_single_failed_run_of_a_daily_job_is_not_a_broken_job.sql'
);

/**
 * Blank SQL line comments FIRST, then string literals, preserving length.
 *
 * The opposite order (which the 20260919172421 law uses) cannot be used here:
 * this function body is explained by comments containing apostrophes, and
 * blanking literals first makes "the job's last three" open a literal that
 * runs to the next apostrophe and swallows the code between them. That ate
 * the sparse and decided CTEs on the first run of this test. Comments first is
 * safe in this direction because no literal in this body contains "--".
 */
const sqlCode = (sql: string): string =>
  sql
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));

const raw = (): string => readFileSync(MIGRATION, 'utf8');
const body = (): string => sliceDollarQuoted(raw(), '$function$');

describe('a sample of one is not a verdict', () => {
  it('the single-sample branch reads a bounded look-back of three finished runs', () => {
    const code = sqlCode(body());

    // The look-back exists, is ranked per job, and reads only finished runs.
    expect(code).toMatch(/successes_in_last_3/);
    expect(code).toMatch(
      /row_number\(\)\s+over\s*\(\s*partition\s+by\s+\w+\.jobid\s+order\s+by\s+\w+\.start_time\s+desc\s*\)/i
    );
    expect(code).toMatch(/rn\s*<=\s*3\b/);

    // Bounded by RUNS, not by a second time window: another interval would be
    // a second thing to keep in step with p_window.
    expect(code).not.toMatch(/successes_in_last_3[\s\S]{0,400}?interval/i);
  });

  it('the look-back is three, so widening it cannot happen quietly', () => {
    const code = sqlCode(body());
    const ranks = [...code.matchAll(/rn\s*<=\s*(\d+)/gi)].map((m) => Number(m[1]));
    expect(ranks).toContain(3);
    // Nothing in this function may look back further than three runs without
    // moving this test and the migration header together.
    expect(ranks.filter((n) => n > 3)).toEqual([]);
  });

  it('THE ONE THAT MATTERS LATER: the look-back is one pass, never a scan per job', () => {
    const code = sqlCode(body());

    // cron.job_run_details has NO index, so every read of it is a sequential
    // scan of ~280k rows. The first version of this function asked for the
    // last three runs in a CORRELATED subquery, once per sparse job: right
    // verdicts, 27,665 ms instead of 546 ms, and it could not apply. The
    // ranked form is 698 ms. So: the log may be read in a top-level CTE, and
    // a correlated read keyed on an outer job id is forbidden.
    const reads = [...code.matchAll(/cron\.job_run_details/gi)];
    expect(reads.length).toBeLessThanOrEqual(2);

    // No read of the log may be filtered by an id coming from another alias -
    // that is what makes it run once per row instead of once.
    expect(code).not.toMatch(/cron\.job_run_details[\s\S]{0,300}?\bjobid\s*=\s*a\./i);
    expect(code).not.toMatch(/\border\s+by\s+\w*\.?start_time\s+desc\s+limit\s+\d/i);
  });

  it('the branch fires only when the window really held one finished run', () => {
    const code = sqlCode(body());

    // BOTH halves on ONE case branch. If it stopped checking that the window
    // held exactly one finished run, a minutely job with 1,431 failed runs
    // would be excused by a success three runs ago - which is the outage
    // (sp_upcoming_tournament_pushes) this whole function exists for.
    // String literals are blanked by sqlCode, so the branch is matched up to
    // its `then` rather than by the verdict word it yields.
    expect(code).toMatch(
      /when\s+a\.successes\s*=\s*0\s+and\s+a\.failures\s*\+\s*a\.successes\s*=\s*1\s+and\s+coalesce\(\s*b\.successes_in_last_3\s*,\s*0\s*\)\s*>\s*0\s+then\b/i
    );

    // The excuse is earned by evidence, never by identity: no job name, no
    // schedule string, no allow-list.
    expect(code).not.toMatch(/jobname\s*(=|in|like)/i);
    expect(code).not.toMatch(/schedule\s*(=|in|like)\s*'/i);
  });

  it("'critical' is still reachable, and only AFTER the narrow excuse", () => {
    const withLiterals = raw().replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
    const fn = sliceDollarQuoted(withLiterals, '$function$');

    // The excuse is a narrower branch, so CASE must reach it first; the
    // unconditional critical must still sit behind it, reachable by any job
    // that has more than one finished run and no success.
    const excuse = fn.search(/successes_in_last_3\s*,\s*0\s*\)\s*>\s*0/i);
    const critical = fn.search(/when\s+a\.successes\s*=\s*0\s+then\s+'critical'/i);
    expect(excuse).toBeGreaterThan(-1);
    expect(critical).toBeGreaterThan(-1);
    expect(critical).toBeGreaterThan(excuse);
  });

  it('the verdict is computed once, and the ordering reads that one copy', () => {
    const code = sqlCode(body());
    // It used to be written twice, select list and ORDER BY, free to drift.
    expect(code).toMatch(/decided\s+as\s*\(/i);
    expect(code).toMatch(/order\s+by[\s\S]{0,120}case\s+d\.verdict/i);
  });

  it('the one-row evidence shape from 20260919172421 is preserved', () => {
    const code = sqlCode(body());
    expect(code).toContain('distinct on (w.jobid)');
    expect(code).not.toMatch(/(?:max|min|array_agg|string_agg)\s*\(\s*[a-z_]*\.?return_message/i);
  });

  it('the re-budget refuses to overwrite a command it did not read', () => {
    const sql = raw();
    // An md5 preimage guard, and only the budget moves.
    expect(sql).toMatch(/md5\(v_old\)\s*<>\s*'[0-9a-f]{32}'/);
    expect(sql).toMatch(/replace\(v_old,\s*'600s',\s*'1500s'\)/);
    // The schedule is asserted on read-back, so a re-budget cannot move it.
    expect(sql).toMatch(/schedule[\s\S]{0,80}'25 3 \* \* \*'/);
  });

  it('the header keeps the measurement and the refusal to widen', () => {
    const sql = raw();
    // Asserted against the RAW source: this is meant to be prose, and an
    // editor deleting the reasoning should fail here.
    expect(sql).toContain('6.20 ms/event');
    expect(sql).toContain('THE ANSWER IS NOT A THIRD BUDGET');
    expect(sql).toContain('multixact_member');
    // And the record of why the first apply failed, so the next person does
    // not reach for the correlated form again.
    expect(sql).toContain('27,665 ms');
  });

  it('the read-back times the function, not just that it answered', () => {
    const sql = raw();
    // "It returns the right rows" passed at 27.7s. Cost is asserted now.
    expect(sql).toMatch(/v_elapsed_ms/);
    expect(sql).toMatch(/IF v_elapsed_ms > \d+ THEN/);
    // The migration's own budget must cover the WHOLE file: the applier sends
    // it in one client.query(), so statement_timeout is not per statement.
    expect(sql).toMatch(/SET LOCAL statement_timeout = '180s'/);
  });
});
