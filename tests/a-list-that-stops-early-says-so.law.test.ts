import { describe, expect, it } from 'vitest';
import { migrationCorpus, migrationsMentioning } from './helpers/migrationCorpus';

/**
 * A LIST THAT STOPS EARLY SAYS SO (binding)
 *
 * All three rake breakdowns took p_limit, defaulted it to 50, and returned a
 * bare array. A union with fifty-one clubs showed fifty and said nothing, so
 * the fifty-first was indistinguishable from a club that produced no rake at
 * all. Same for an agent's fifty-first player. Silence is the bug: an operator
 * cannot audit a list that will not admit it is incomplete.
 *
 * THE PART THAT IS EASY TO GET WRONG is not the paging, it is the DENOMINATOR.
 * ca_rake_snapshot computed breakdown_total by summing the array it was handed.
 * That was correct while the array was the whole list. Paginate the same code
 * and the denominator silently becomes the PAGE - so every share on screen
 * would be a percentage of the first fifty rows, and every one of them would
 * CHANGE as the operator pressed Load More. The helpers therefore return
 * total_direct, summed with a window over the full set, and the snapshot reads
 * that rather than summing what it received.
 *
 * Window functions run BEFORE OFFSET and LIMIT, which is the whole reason the
 * count and the full-set sum can come back attached to the page for free.
 *
 * Verified numerically when written: three pages of ten over a thirty-three
 * row list returned thirty rows with thirty distinct identities - no overlap,
 * no duplicate - and breakdown_total was 83,909.72 on every page and on the
 * unpaged read.
 */

const HELPERS = ['fn_ca_rake_by_agent', 'fn_ca_rake_by_club', 'fn_ca_rake_by_downline'];

/**
 * The LAST migration that defines this function, which is the one in force.
 *
 * This used to read all of `supabase/migrations` from disk on every call, and
 * `body()` below called it a second time for the same name - about two full
 * directory reads per question, over 2,897 files and growing. It crossed
 * vitest's 5-second default under a loaded full-suite run and passed in the
 * next run on unchanged work, which is the coin flip `migrationCorpus`'s header
 * was written about. The corpus is read once per test file and memoised; the
 * answer is identical, and the assertions below are untouched.
 */
function latestDefining(fnName: string): string {
  const defining = migrationsMentioning(`FUNCTION public.${fnName}(`);
  return defining.length ? defining[defining.length - 1].sql : '';
}

/**
 * JUST THAT FUNCTION, not the file it lives in.
 *
 * The first version of this returned the whole migration, and these files hold
 * three functions each - so gutting the window sum in ONE of them still matched
 * the other two and the law passed a mutation that would have shipped a
 * page-sized denominator. A law that reads the file instead of the function is
 * only testing that SOMETHING in the file is correct.
 */
function body(fnName: string): string {
  const sql = latestDefining(fnName);
  const start = sql.indexOf(`FUNCTION public.${fnName}(`);
  if (start < 0) return '';
  const end = sql.indexOf('$function$;', start);
  return sql
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

describe('a list that stops early says so', () => {
  it.each(HELPERS)('%s takes an offset', (fn) => {
    expect(latestDefining(fn), `${fn} has no migration`).not.toBe('');
    expect(body(fn)).toMatch(/p_offset/);
  });

  it.each(HELPERS)('%s reports how many rows exist behind the page', (fn) => {
    const sql = body(fn);
    expect(sql, 'a page with no count cannot admit it is a page').toMatch(/'total'/);
    // Originally this asserted count(*) OVER (), which was the MECHANISM and
    // not the law. Search replaced it, because a window over the SLICE reads
    // correctly right up until the slice is empty: ask for offset 60 of a 33
    // row result and it answers "total 0" - nothing matches, while matches
    // plainly exist. The count is now counted over the filtered set, which
    // cannot depend on which page was asked for. What the law actually forbids
    // is deriving the count from the rows that came back.
    expect(sql, 'a count taken from the page reports zero whenever the page is empty').toMatch(
      /'total',\s*\(SELECT count\(\*\) FROM filtered\)/
    );
  });

  it.each(HELPERS)('%s sums the WHOLE set, not the page', (fn) => {
    // Also once a mechanism assertion (SUM(...) OVER ()). The law is that the
    // denominator spans every row, so that a share does not change as the
    // operator pages or types. It is now a totals CTE reading the unsliced,
    // unfiltered set - which additionally survives search, where a window
    // would have silently started summing only the matches.
    const sql = body(fn);
    expect(sql).toMatch(/total_direct/);
    expect(sql, 'the denominator needs a set of its own to sum').toMatch(
      /totals AS \(\s*SELECT COALESCE\(SUM\([a-z_.]+\),0\) AS total_direct[\s\S]*?FROM listed/
    );
    expect(sql, 'total_direct must be read from that set, not from the page').toMatch(
      /'total_direct',\s*\(SELECT t\.total_direct FROM totals t\)/
    );
  });

  it('the snapshot reads total_direct instead of summing what it was handed', () => {
    const sql = body('ca_rake_snapshot');
    expect(
      sql,
      'summing the page makes every share a percentage of the first page and move as you page'
    ).toMatch(/'breakdown_total'\s*,\s*\(v_pack->>'total_direct'\)/);
    expect(sql).toMatch(/'breakdown_count'/);
  });

  it('the snapshot passes the offset down rather than always reading page one', () => {
    expect(body('ca_rake_snapshot')).toMatch(/p_limit\s*,\s*v_off/);
  });

  it('the old un-paged arities are dropped, so no call is ambiguous', () => {
    // Adding p_offset with a DEFAULT creates a SECOND definition rather than
    // replacing the first, and a call with the old argument count then matches
    // both. Postgres resolves that by erroring - on the page.
    const all = migrationCorpus()
      .map((m) => m.sql)
      .join('\n');
    expect(all).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_ca_rake_by_agent\(uuid, date, date, integer\)/
    );
    expect(all).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_ca_rake_by_club\(uuid\[\], date, date, integer\)/
    );
    expect(all).toMatch(
      /DROP FUNCTION IF EXISTS public\.ca_rake_snapshot\(text,uuid,uuid,date,date,uuid,integer\)/
    );
  });
});
