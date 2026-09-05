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
 * The shape is:
 *
 *   club_rake_rollup_complete   which (club, day) pairs are genuinely finished
 *   club_rake_daily_user        read ONLY for those days
 *   ca_club_rake_daily_user     the live edge - every day the marker has not
 *                               called complete, kept exact per player by
 *                               statement-level triggers on rake_attributions
 *
 * The live slice must stay disjoint from the rollup days or the window
 * double-counts, which is the mirror failure and reads as a club producing
 * more than it took.
 *
 * THE LIVE SOURCE CHANGED ON 2026-09-05 AND THE PINS MOVED WITH IT
 * (20260905042000). The live edge used to be `rake_records` split through
 * `fn_rake_shares_for_record`, the canonical allocator, called ONCE PER RAKED
 * HAND - 61,156 lookups on the busiest club, 29.7 seconds, past every timeout,
 * so `ca_rake_snapshot` answered 500 and the panel sat on dashes. It now reads
 * `rake_attributions` grouped per player: the per-player credit the engine
 * writes as the hand is raked, and THE VERY TABLE `fn_club_rake_rollup_day`
 * builds `club_rake_daily_user` from.
 *
 * So the guarantee the old allocator pin protected - a live figure and the
 * rollup that eventually replaces it agree - is now structural rather than
 * procedural: the two are computed from the same rows with the same rounding,
 * instead of by two code paths that had to be kept in step. The invariant is
 * unchanged and the pins below assert it against the source that now carries
 * it. Nothing here was weakened to let a change through; the pin that named
 * `fn_rake_shares_for_record` had in fact stopped guarding anything, because
 * the string still appears in the migration's own assertion that the function
 * must NOT call it, and a substring pin cannot tell those apart.
 *
 * AND THE LIVE SOURCE MOVED ONCE MORE ON THE SAME DAY (20260905074228), for a
 * reason that is the sharpest version of this law's own point. Reading the
 * attributions directly measured 490ms at 03:55 and 3,402ms at 07:37 - the
 * live edge is TODAY, and today gets bigger every hour, reaching a third of a
 * million rows on a busy day. So the panel would have healed every morning and
 * failed every evening: current, then not, then current again. The live half
 * now reads `ca_club_rake_daily_user`, an incremental per-player rollup kept
 * exact by statement-level triggers ON `rake_attributions` - the same rows,
 * summed as they arrive instead of on every page load. The pins below check
 * BOTH ends of that chain, because a rollup nothing maintains is exactly the
 * silent zero this law exists to prevent.
 *
 * Verified numerically when written, against Deep Stack Society: for today the
 * direct column summed to exactly what rake_records held for the club over the
 * same window, where the previous implementation returned an empty array.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

/** Every migration that mentions a name, oldest first. */
function migrationsMentioning(needle: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
    .filter((sql) => sql.includes(needle));
}

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

  it('reads the incremental rollup for what the sealed rollup has not finished', () => {
    const sql = body('fn_ca_rake_by_agent');
    expect(sql, 'a sealed-days-only read is always wrong for today').toContain(
      'public.ca_club_rake_daily_user du'
    );
    expect(sql, 'the live edge is per player, like the sealed days it stands in for').toContain(
      'du.user_id'
    );
  });

  it('and something keeps that live rollup current, from the attributions themselves', () => {
    // The other end of the chain. A live edge that reads a table nothing
    // writes is a rollup-only read wearing a disguise, and it reads as zero.
    const writers = migrationsMentioning('ca_club_rake_daily_user');
    expect(writers.length, 'the rollup is declared somewhere').toBeGreaterThan(0);
    const all = writers.join('\n');
    expect(all).toContain('AFTER INSERT ON public.rake_attributions');
    expect(all).toContain('AFTER UPDATE ON public.rake_attributions');
    expect(all).toContain('AFTER DELETE ON public.rake_attributions');
    // And it can never fail the hand it is counting.
    expect(all).toContain('EXCEPTION WHEN OTHERS THEN');
  });

  it('does not re-derive a share per raked hand to get there', () => {
    // The open paren is the whole point: the migration's own assertion NAMES
    // fn_rake_shares_for_record to check the body no longer calls it, so a
    // bare substring pin passes on the guard rather than on the code. Only a
    // CALL has a paren after it.
    const sql = body('fn_ca_rake_by_agent');
    expect(sql, 'the live edge is grouped, not allocated hand by hand').not.toContain(
      'fn_rake_shares_for_record('
    );
  });

  it('rounds the live edge the way the sealed days are rounded', () => {
    // Same rounding as fn_club_rake_rollup_day: each row to a cent, then
    // summed. Without this the live edge and the day that replaces it differ
    // by fractions of a chip and the table appears to change its mind at
    // midnight. It is accumulated now rather than summed in one pass, so the
    // cents are stored as an integer and divided once - the same arithmetic in
    // an order that cannot drift.
    expect(body('fn_ca_rake_by_agent')).toContain('du.rake_cents::numeric / 100');
    const writers = migrationsMentioning('ca_club_rake_daily_user').join('\n');
    expect(writers).toContain('SUM(round(ra.rake_amount * 100))::bigint');
    expect(writers).toContain('rake_cents  bigint');
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
