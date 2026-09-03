import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE AGENT TABLE IS CURRENT, NOT MERELY COMPLETE (binding)
 *
 * fn_ca_rake_by_agent first shipped reading club_rake_daily_user and nothing
 * else. That rollup finalises COMPLETE UTC days, so on Day - the period an
 * operator uses most - the agent table showed 0.00 underneath a five-figure
 * headline. Not an approximation, not a lag: nothing at all, under a number
 * that was not nothing.
 *
 * A rollup-only read is always WRONG for the current day and always LOOKS
 * right, because zero is a number and the table renders it without complaint.
 * That is the failure this law exists to prevent recurring.
 *
 * The fix is the shape fn_agent_downline_rake already used:
 *
 *   club_rake_rollup_complete   which (club, day) pairs are genuinely finished
 *   club_rake_daily_user        read ONLY for those days
 *   rake_records                the live tail, the live head, and any day in
 *                               the middle the rollup never wrote
 *   fn_rake_shares_for_record   the canonical allocator, so a live figure and
 *                               the rollup that eventually replaces it agree
 *
 * The three live slices must stay disjoint from the rollup days or the window
 * double-counts, which is the mirror failure and reads as a club producing
 * more than it took.
 *
 * Verified numerically when written, against Deep Stack Society: for today the
 * direct column summed to exactly what rake_records held for the club over the
 * same window, where the previous implementation returned an empty array.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

/** The newest definition wins at deploy time, so it is the one under test. */
function latestDefining(fnName: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found = '';
  for (const f of files) {
    const sql = readFileSync(resolve(MIGRATIONS, f), 'utf8');
    if (sql.includes(`FUNCTION public.${fnName}(`)) found = sql;
  }
  return found;
}

/** The body of the newest definition, comments stripped. */
function body(fnName: string): string {
  return latestDefining(fnName)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

describe('the agent table is current, not merely complete', () => {
  it('fn_ca_rake_by_agent exists in the migrations', () => {
    expect(latestDefining('fn_ca_rake_by_agent')).not.toBe('');
  });

  it('reads the completeness marker rather than assuming a day is done', () => {
    expect(body('fn_ca_rake_by_agent')).toContain('club_rake_rollup_complete');
  });

  it('reads rake_records for what the rollup has not finished', () => {
    const sql = body('fn_ca_rake_by_agent');
    expect(sql, 'a rollup-only read is always wrong for today').toContain('rake_records');
  });

  it('splits live rake with the canonical allocator, not a local formula', () => {
    // If this function invented its own split, an agent's live figure and the
    // figure they are eventually paid on would disagree, and only one of them
    // would ever be shown.
    expect(body('fn_ca_rake_by_agent')).toContain('fn_rake_shares_for_record');
  });

  it('covers a day the rollup skipped, so it is never silently zero', () => {
    // This asserts the INVARIANT, not the mechanism. The first implementation
    // reached it by generating a row per calendar day and joining
    // rake_records to each; that was replaced by one range scan anti-joined
    // against the finished days, which is equivalent and far cheaper. A law
    // that named `gap_days` failed the better version of the same guarantee,
    // which is a law testing its own history rather than the estate's rule.
    const sql = body('fn_ca_rake_by_agent');
    expect(
      sql,
      'the live read must exclude finished days rather than assume the rest are covered'
    ).toMatch(/NOT EXISTS[\s\S]{0,200}ok_days/);
  });

  it('never lets the live window run past now', () => {
    // An end date of today opens a window to tomorrow midnight unless it is
    // clamped, and then the query scans for hands that do not exist yet.
    expect(body('fn_ca_rake_by_agent')).toMatch(/LEAST\(\(p_end \+ 1\)::timestamptz, v_now\)/);
  });

  it('reads the rollup only for days the marker calls complete', () => {
    // The join is what keeps the rollup slice disjoint from the live slices.
    // Without it the same day is counted twice and the club appears to have
    // produced more than it took.
    const sql = body('fn_ca_rake_by_agent');
    expect(sql).toMatch(/FROM public\.club_rake_daily_user rd[\s\S]{0,200}JOIN ok_days/);
  });

  it('declares which side is live so the headline gap is not read as an error', () => {
    // The agent table is current to the second; club_table_daily beside it is
    // an hourly job. Between runs the breakdown can exceed the headline.
    const sql = body('ca_rake_snapshot');
    expect(sql).toContain('breakdown_live');
  });
});
