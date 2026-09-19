/**
 * ===========================================================================
 *  LAW: AN INDEX PREDICATE THAT LISTS VALUES GOES STALE
 * ===========================================================================
 *
 * Three scheduled jobs were `critical` in `fn_ca_cron_health()` on 2026-09-19,
 * meaning each had run and never once succeeded:
 *
 *   tourney_money_conservation_hourly       12 * * * *     24 runs, 0 ok
 *   ca-pay-backed-payout-shortfalls-hourly  26 * * * *     24 runs, 0 ok
 *   tourney_money_conservation_deep_daily   25 3 * * *      1 run,  0 ok
 *
 * All three died on `canceling statement due to statement timeout` inside
 * `fn_tournament_conservation_delta`, and `cron.job_run_details` puts their
 * last successes within minutes of each other on 2026-09-12: 09:12, 09:26 and
 * 03:25.
 *
 * 2026-09-12 is the day the `seat_income` term learned about tickets. It went
 * from `source = 'satellite_seat'` to
 * `source IN ('satellite_seat','satellite_ticket')`, and nobody widened
 * `idx_tournament_payouts_satellite_target`, whose predicate still read
 * `WHERE source = 'satellite_seat'`.
 *
 * A PARTIAL INDEX WHOSE PREDICATE DOES NOT COVER THE QUERY'S CANNOT BE USED AT
 * ALL. The planner cannot prove the rows are in there, so it reads everything.
 * EXPLAIN showed `Parallel Seq Scan on tournament_payouts`: 161,772 rows,
 * 176 MB, per tournament, 200 tournaments an hour. Nothing was wrong with the
 * arithmetic. Three money-conservation checks simply stopped being affordable
 * and produced no verdict for seven days.
 *
 * WIDENING THE PREDICATE IS NOT THE FIX, and that is the whole law. It repairs
 * today's query and leaves the next widening free to do the identical thing,
 * silently. The predicate was a COPY of a value list that lives in a function
 * body, and a copy of a fact goes stale. The defect is the copy, not the value
 * that happened to be missing from it.
 *
 * So the final index has no predicate at all. There is no list, so there is
 * nothing to fall behind, and a source value nobody has invented yet reaches
 * it. Measured: the same 200 tournaments went from timing out past 120,000 ms
 * to 207 ms.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const WIDENED =
  'supabase/migrations/20260919154808_the_ticket_that_widened_the_query_never_widened_the_index.sql';
const FINAL =
  'supabase/migrations/20260919155648_an_index_predicate_that_lists_values_goes_stale_so_this_one_lists_none.sql';

/** The index this law is about. */
const INDEX = 'idx_tournament_payouts_satellite_target';
/** This law lands here; anything newer is bound by the forward guard. */
const THIS_VERSION = '20260919155648';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');

const WIDENED_SQL = read(WIDENED);
const FINAL_SQL = read(FINAL);

/**
 * Every statement of a migration, comments removed, split on the statement
 * terminator. Good enough for DDL: an index definition has no `;` inside it.
 */
function statements(sql: string): string[] {
  return strip(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The CREATE INDEX statements in a migration that name a given index. */
function createsOf(sql: string, index: string): string[] {
  return statements(sql).filter((s) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(s) && s.includes(index));
}

function migrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('an index predicate that lists values goes stale', () => {
  it('both migrations are on disk, because production applied both', () => {
    // The first is kept rather than squashed: a repo that does not carry what
    // production ran is a repo nobody can rebuild from.
    expect(WIDENED_SQL.length).toBeGreaterThan(0);
    expect(FINAL_SQL.length).toBeGreaterThan(0);
    expect(WIDENED_SQL).toContain(
      'Applied to production as schema_migrations version 20260919154533'
    );
    expect(FINAL_SQL).toContain(
      'Applied to production as schema_migrations version 20260919154718'
    );
  });

  it('the first one only widened the copy, and says so', () => {
    const [create] = createsOf(WIDENED_SQL, INDEX);
    expect(create, 'the widening migration creates the index').toBeDefined();
    expect(create).toMatch(/WHERE\s+source\s+IN/i);
    // And its header refuses to call that the fix.
    expect(WIDENED_SQL).toContain('It does NOT stop the next widening doing this again');
  });

  it('the final index carries no predicate at all', () => {
    const [create] = createsOf(FINAL_SQL, INDEX);
    expect(create, 'the final migration creates the index').toBeDefined();
    // Asserted against the statement with comments stripped, so the header's
    // explanation of the old predicate cannot satisfy or break this.
    expect(create).not.toMatch(/\bWHERE\b/i);
    expect(create).toMatch(/\(\(metadata->>'satellite_target_id'\)\)/);
  });

  it('it refuses to commit if a predicate is somehow still there', () => {
    expect(FINAL_SQL).toMatch(/pg_get_expr\(i\.indpred, i\.indrelid\)/);
    expect(FINAL_SQL).toMatch(/the index still carries a predicate/);
  });

  /**
   * The probe that makes this structural rather than a patch. Two probes would
   * only show that today's query works; a value nobody has invented yet
   * reaching the index is the proof there is no list left to fall behind.
   */
  it('it proves a source value nobody has invented yet still reaches the index', () => {
    expect(FINAL_SQL).toContain('satellite_something_new');
    expect(FINAL_SQL).toMatch(/Seq Scan on tournament_payouts/);
    expect(FINAL_SQL).toMatch(/does not reach the index/);
  });

  it('and it measures the real workload against the real job budget', () => {
    expect(FINAL_SQL).toMatch(/fn_tournament_conservation_delta\(t\.id\)/);
    expect(FINAL_SQL).toMatch(/LIMIT 200/);
    expect(FINAL_SQL).toMatch(/will not fit the 120s job budget/);
  });

  /**
   * THE ONE THAT MATTERS LATER. The next person to touch this index will be
   * looking at a slow query and a partial index is the obvious tool. It is the
   * tool that broke it.
   */
  it('no later migration gives this index a predicate again', () => {
    const offenders: string[] = [];
    for (const file of migrations()) {
      if (file.slice(0, file.indexOf('_')) <= THIS_VERSION) continue;
      for (const create of createsOf(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'), INDEX)) {
        if (/\bWHERE\b/i.test(create)) offenders.push(file);
      }
    }
    expect(
      offenders,
      `a migration recreates ${INDEX} with a WHERE predicate. That predicate is a copy of a ` +
        'value list that lives in fn_tournament_conservation_delta, and on 2026-09-12 the ' +
        'function grew a value the index did not: a partial index whose predicate does not ' +
        'cover the query cannot be used AT ALL, so the term read all 161,772 rows per ' +
        'tournament and three money-conservation jobs produced no verdict for seven days. ' +
        'Leave it unpartitioned. A few MB is cheaper than a week of silence on money.'
    ).toEqual([]);
  });
});
