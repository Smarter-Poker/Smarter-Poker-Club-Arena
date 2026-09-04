import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A SEARCH NARROWS THE LIST, NOT THE DENOMINATOR (binding)
 *
 * The breakdowns are paged, so search and sort had to move to the server:
 * filtering the fifty rows that happen to be loaded, out of two hundred, finds
 * only what was already fetched, and looks like it works.
 *
 * THE PART THAT IS EASY TO GET WRONG is not the filtering, it is what a SHARE
 * means once a filter is on. Two totals stop being the same number:
 *
 *   total          how many rows MATCH. Otherwise the list claims 33 rows
 *                  behind a page that is showing 3, and Load More never
 *                  resolves.
 *
 *   total_direct   the sum over EVERY row, matched or not, because a share is
 *                  a share OF THE CLUB. Were it the filtered sum, searching a
 *                  single agent would show them at 100 percent - true "of the
 *                  rows shown" and useless - and every percentage on screen
 *                  would move as the operator typed.
 *
 * So the sums must be taken BEFORE the filter and the count AFTER it, and this
 * law is what stops a later hand tidying them back into one pass.
 *
 * Verified numerically when written, on production, as the club owner:
 * unfiltered the club list returned 34 rows, denominator 96,873.22, commission
 * 23,330.55. Searching "chi" returned 1 row - and the same 96,873.22 and the
 * same 23,330.55. Asking for offset 500 of that one row result returned no
 * rows and still reported a count of 1.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');
const HELPERS = ['fn_ca_rake_by_agent', 'fn_ca_rake_by_club', 'fn_ca_rake_by_downline'];

/**
 * 2026-09-04: memoised, and the whole tree read ONCE.
 *
 * This walked all 2,098 migration files (18 MB) for every call, and both
 * `latestDefining` and `body` call it - so a single `it.each` over three
 * helpers re-read the tree six times. It timed out at the 5-second default
 * under a full-suite run on 2026-09-04, which stops the publisher for
 * everyone (CLAUDE.md 5.8). Nothing about what is asserted changes; only how
 * many times the same bytes are read off disk.
 */
const migrationSources = (() => {
  let cache: string[] | null = null;
  return (): string[] => {
    if (!cache) {
      cache = readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'));
    }
    return cache;
  };
})();

const definingCache = new Map<string, string>();

function latestDefining(fnName: string): string {
  const cached = definingCache.get(fnName);
  if (cached !== undefined) return cached;
  let found = '';
  for (const sql of migrationSources()) {
    if (sql.includes(`FUNCTION public.${fnName}(`)) found = sql;
  }
  definingCache.set(fnName, found);
  return found;
}

/** Just that function, not the file it lives in - these files hold several. */
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

/**
 * One named CTE, balanced on parentheses rather than on the next comma.
 *
 * Reading to the next "), " would stop at the first nested subquery and hand
 * back a fragment - and a fragment that happens to exclude the search
 * predicate would let this law pass a totals CTE that filters.
 */
function cte(sql: string, name: string): string {
  const m = new RegExp(`${name}\\s+AS\\s+(?:MATERIALIZED\\s+)?\\(`).exec(sql);
  if (!m) return '';
  let depth = 0;
  const from = m.index + m[0].length - 1;
  for (let i = from; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(from + 1, i);
    }
  }
  return '';
}

describe('a search narrows the list, not the denominator', () => {
  it.each(HELPERS)('%s accepts the search and the sort', (fn) => {
    expect(latestDefining(fn), `${fn} has no migration`).not.toBe('');
    expect(body(fn)).toMatch(/p_search text DEFAULT NULL/);
    expect(body(fn)).toMatch(/p_sort text DEFAULT 'rake'/);
  });

  it.each(HELPERS)('%s narrows on what was typed and nothing else', (fn) => {
    const sql = body(fn);
    const filtered = cte(sql, 'filtered');
    expect(filtered, 'there is no filtered CTE to hold the search').not.toBe('');
    expect(filtered).toMatch(/ILIKE/);

    // One place that filters. A second is a second policy, and it is the one
    // nobody remembers to keep out of the totals.
    const ilikes = sql.match(/ILIKE/g) ?? [];
    expect(ilikes.length, 'the search predicate appears outside the filter').toBe(
      (filtered.match(/ILIKE/g) ?? []).length
    );

    // EVERY predicate in there compares against the search term.
    //
    // The first cut of this only counted ILIKEs, so adding a second condition
    // INSIDE the filter - say, quietly dropping every row whose role is not an
    // agent - moved both counts together and passed. That mutation hides rows
    // an operator asked to see, on a criterion they did not type and cannot
    // see, while the count beside it agrees with the shortened list. The list
    // is narrowed by what was typed, or it is not narrowed.
    const term =
      /ILIKE\s*'%'\s*\|\|\s*public\.fn_like_escape\(\s*(?:btrim\(p_search\)|v_q)\s*\)\s*\|\|\s*'%'\s*ESCAPE/g;
    expect(
      (filtered.match(term) ?? []).length,
      'a condition in the filter is not built from the search term'
    ).toBe(ilikes.length);
  });

  it.each(HELPERS)('%s takes its totals from before the filter', (fn) => {
    const totals = cte(body(fn), 'totals');
    expect(totals, 'there is no totals CTE').not.toBe('');
    expect(totals, 'a share that moves as you type is not a share').not.toMatch(/ILIKE/);
    expect(totals).not.toMatch(/p_search|v_q/);
    // It must read the unfiltered set by name. Pointing it at `filtered` is
    // the whole bug this law exists to catch, and it is a one word edit.
    expect(totals).toMatch(/FROM listed/);
    expect(totals).not.toMatch(/FROM filtered/);
  });

  it.each(HELPERS)('%s counts the matches, not the page', (fn) => {
    expect(body(fn)).toMatch(/'total',\s*\(SELECT count\(\*\) FROM filtered\)/);
  });

  it.each(HELPERS)('%s never builds its ORDER BY out of the sort string', (fn) => {
    const sql = body(fn);
    // p_sort arrives from the browser. Concatenated into SQL it is an
    // injection; compared against a CASE it is a whitelist.
    expect(sql).not.toMatch(/EXECUTE/);
    expect(sql).not.toMatch(/format\s*\(/);
    expect(sql).not.toMatch(/quote_ident/);
    // The two sql-language helpers read lower(COALESCE(p_sort,...)) inline
    // where the plpgsql one normalises into v_sort first, so this matches the
    // shape both share: the sort is COMPARED, never concatenated.
    expect(sql).toMatch(/CASE WHEN[^\n]*sort[^\n]*(?:=|IN)/);
  });

  it('the snapshot normalises the sort before echoing it', () => {
    const sql = body('ca_rake_snapshot');
    // The echo exists so a client can tell "the server ran my search" apart
    // from "the server ignored a parameter". Echoing the REQUEST rather than
    // what was applied is a lie in exactly the case the field exists for.
    expect(sql).toMatch(/'applied_search',\s*v_q/);
    expect(sql).toMatch(/'applied_sort',\s*v_sort/);
    const guards = sql.match(/IF v_sort NOT IN \([^)]*\) THEN v_sort := 'rake'; END IF;/g) ?? [];
    expect(
      guards.length,
      'each breakdown offers different sorts, so each branch normalises to its own'
    ).toBe(3);
  });

  it('the snapshot passes the search and the sort down to every breakdown', () => {
    const sql = body('ca_rake_snapshot');
    for (const fn of HELPERS) {
      const call = new RegExp(`public\\.${fn}\\([^;]*v_q, v_sort\\)`);
      expect(sql, `${fn} is called without the search`).toMatch(call);
    }
  });

  it('the pre-search arities are dropped, so no call is ambiguous', () => {
    // Every parameter here carries a default, so leaving the old signature in
    // place means an older call matches both - which Postgres reports as an
    // error on the page rather than by picking one.
    const all = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
      .join('\n');
    expect(all).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_ca_rake_by_agent\(uuid, date, date, integer, integer\)/
    );
    expect(all).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_ca_rake_by_club\(uuid\[\], date, date, integer, integer\)/
    );
    expect(all).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_ca_rake_by_downline\(uuid, uuid, timestamptz, timestamptz, integer, integer\)/
    );
    expect(all).toMatch(
      /DROP FUNCTION IF EXISTS public\.ca_rake_snapshot\(text, uuid, uuid, date, date, uuid, integer, integer\)/
    );
  });
});

describe('a search term is text, not a pattern', () => {
  /**
   * The first cut of the search pasted what the operator typed straight
   * between two percent signs, and LIKE read it as a PATTERN. Typing one
   * percent sign returned all 34 agents; an underscore matched any single
   * character, and fourteen usernames on this estate carry one - bigtony_chi
   * among them - so searching that name also matched bigtonyXchi and there was
   * no way to ask for the literal.
   *
   * Not an injection: the term is a bound parameter and never reaches the
   * planner as SQL. A correctness bug, and the underscore makes it one an
   * operator meets by accident rather than by trying.
   *
   * Measured after the fix: "%" returns 0 where it returned 34, "_" returns 0
   * where it returned 34, a lone backslash and "%_\\%" return 0 without
   * erroring, and an ordinary search still finds its row against an unchanged
   * denominator.
   */
  it('there is an escaper, and it replaces the backslash first', () => {
    const sql = body('fn_like_escape');
    expect(sql, 'no escaper').not.toBe('');

    const BS = String.fromCharCode(92);
    expect(sql, 'the term is not run through three replaces').toMatch(
      /replace\(\s*replace\(\s*replace\(/
    );
    // The INNERMOST replace is the one applied first, and it must be the
    // backslash. Escaping it last would escape the backslashes the other two
    // had just introduced, turning every search containing a percent sign
    // into a search for a literal backslash.
    const innermost = sql.slice(sql.lastIndexOf('replace('));
    expect(
      innermost.startsWith(`replace(p_term, '${BS}'`),
      'the innermost replace is not the backslash one'
    ).toBe(true);
    // And all three characters are handled.
    for (const c of [BS, '%', '_']) {
      expect(sql.includes(`'${BS}${c}'`), `${c} is never escaped`).toBe(true);
    }
  });

  it.each(HELPERS)('%s puts the search term through the escaper', (fn) => {
    const filtered = cte(body(fn), 'filtered');
    const ilikes = (filtered.match(/ILIKE/g) ?? []).length;
    const escaped = (filtered.match(/fn_like_escape/g) ?? []).length;
    expect(ilikes, 'nothing to escape').toBeGreaterThan(0);
    expect(escaped, 'a comparison takes the raw term, so % and _ are operators').toBe(ilikes);
  });

  it.each(HELPERS)('%s says which character escapes', (fn) => {
    // ESCAPE '\\' is the default, and is written out so a reader does not have
    // to know the default to see the escaping is wired up.
    const filtered = cte(body(fn), 'filtered');
    const ilikes = (filtered.match(/ILIKE/g) ?? []).length;
    expect((filtered.match(/ESCAPE/g) ?? []).length).toBe(ilikes);
  });
});
