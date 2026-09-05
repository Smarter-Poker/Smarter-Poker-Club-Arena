import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE RAKE SNAPSHOT DENOMINATOR IS NOT DOUBLE-COUNTED (binding)
 *
 * fn_ca_rake_by_agent returns two money columns per agent and they mean
 * different things:
 *
 *   direct_rake   the rake of the players assigned to that agent
 *   network_rake  that, plus every agent beneath them, recursively
 *
 * Network rake is the right figure to RANK by - a super agent whose own
 * seventeen players are quiet but whose fifteen sub-agents are not is carrying
 * the club, and direct rake alone would bury them. It is the wrong figure to
 * SUM, because a super agent's network already contains their sub-agents'
 * rows, so the column adds each player's rake once per level above them.
 *
 * On Deep Stack Society that is not a rounding difference. Summing direct
 * gives 58,698.91, which is exactly what club_rake_daily_user holds for the
 * club. Summing network gives roughly 128,000 across the same rows - more
 * than twice the rake the club actually took. Used as a denominator it would
 * put every agent's share at under half its true value, on the screen an owner
 * uses to decide who to pay.
 *
 * So: the share denominator reads direct_rake. This law pins that, and pins
 * the grants, because the helpers underneath ca_rake_snapshot take a club id
 * and check nothing - the entry point has already decided the caller may read
 * it. Granted to `authenticated`, any one of them would hand any signed-in
 * user every club's rake for the asking.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

function migrationsMentioning(needle: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
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

/**
 * JUST THAT FUNCTION, not the whole migration it lives in. These files hold
 * several functions each, so a file-level read lets a mutation in one of them
 * pass because another still matches.
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

describe('the rake snapshot denominator', () => {
  it('ca_rake_snapshot exists in the migrations at all', () => {
    expect(latestDefining('ca_rake_snapshot')).not.toBe('');
  });

  it('never lets network_rake reach breakdown_total, however it is computed', () => {
    // WHAT THIS PINS IS THE INVARIANT, NOT THE MECHANISM.
    //
    // The first version asserted that ca_rake_snapshot summed 'direct_rake'
    // into a v_btotal variable. Pagination moved that sum into the helpers -
    // they now return total_direct, computed with a window over the full set,
    // because summing the PAGE would have made every share a percentage of the
    // first fifty rows. The invariant survived the change; this law did not,
    // and failed the better implementation of the rule it exists to protect.
    //
    // So it now asks the only question that matters: does the double-counted
    // column reach the denominator by ANY route.
    const sql = body('ca_rake_snapshot');
    const denominator = [...sql.matchAll(/'breakdown_total'[^,]*,[^,]*/g)].map((m) => m[0]);
    expect(denominator.length, 'no breakdown_total is ever produced').toBeGreaterThan(0);
    for (const d of denominator) {
      expect(d, `this denominator reads the double-counted column: ${d}`).not.toContain(
        'network_rake'
      );
    }
  });

  it('the denominator spans every row, not just the page that was returned', () => {
    // total_direct is summed with SUM(...) OVER () inside each helper, and
    // window functions run before OFFSET/LIMIT - so it is the whole set. If
    // the snapshot ever went back to summing what it was handed, a share would
    // change every time the operator pressed Load More.
    const sql = body('ca_rake_snapshot');
    expect(sql).toMatch(/total_direct/);
  });

  it('keeps a depth cap on the agent tree recursion', () => {
    // parent_agent_id is a plain uuid column with no cycle constraint. One bad
    // edge without this cap spins until the statement timeout kills the page.
    const sql = latestDefining('fn_ca_rake_by_agent');
    expect(sql).toMatch(/WHERE\s+t\.depth\s*<\s*\d+/);
  });

  it('still reports players who have no agent', () => {
    // Dropping them makes the column sum to less than the club total with
    // nothing on screen saying why.
    const sql = latestDefining('fn_ca_rake_by_agent');
    expect(sql).toContain('is_unassigned');
    expect(sql).toMatch(/agent_id IS NULL/);
  });
});

describe('the rake snapshot grants', () => {
  const UNGATED_HELPERS = [
    'fn_ca_rake_window',
    'fn_ca_rake_series',
    'fn_ca_rake_by_club',
    'fn_ca_rake_by_agent',
    'fn_ca_rake_by_downline',
  ];

  it.each(UNGATED_HELPERS)('%s is revoked from authenticated', (fn) => {
    const sql = latestDefining(fn);
    expect(sql, `${fn} has no migration defining it`).not.toBe('');
    const revokes = sql
      .split('\n')
      .join(' ')
      .match(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*FROM[^;]*;`, 'g'));
    expect(revokes, `${fn} is never revoked`).toBeTruthy();
    expect(revokes!.join(' ')).toContain('authenticated');
  });

  it('ca_rake_snapshot is the one door that authenticated may open', () => {
    const sql = latestDefining('ca_rake_snapshot');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_rake_snapshot\([^)]*\)\s*TO authenticated/
    );
  });

  it('every scope in the entry point checks something before it reads', () => {
    const sql = latestDefining('ca_rake_snapshot');
    expect(sql).toContain('ca_can_view_club_finances');
    expect(sql).toContain('ca_can_oversee_union');
    // The agent scope delegates its gate rather than duplicating it.
    expect(sql).toContain('fn_agent_downline_rake');
  });

  it('no migration ever grants a rake helper to anon', () => {
    for (const sql of migrationsMentioning('fn_ca_rake_')) {
      const grants = sql.match(/GRANT EXECUTE ON FUNCTION public\.fn_ca_rake_[^;]*;/g) ?? [];
      for (const g of grants) expect(g).not.toContain('anon');
    }
  });

  /**
   * A helper opened to `authenticated` has to be SHUT AGAIN BY A LATER
   * MIGRATION, or this fails - which is not the same as "no migration may ever
   * contain that grant", and the difference is the incident that widened it.
   *
   * On 2026-09-05 `20260905042000` shipped the right query behind
   * `GRANT ... TO authenticated, service_role` - the shape every GATED RPC in
   * this programme uses, applied to the one family where the gate lives a
   * level up in `ca_rake_snapshot`. This law caught it in the full-suite run
   * before the commit, and `20260905043000` re-issued the function with the
   * grant closed. An applied migration is never edited (AGENT-PLAYBOOK), so
   * the bad line is still in the tree and always will be; what matters is
   * whether the door is shut by the end of the sequence.
   *
   * So an UNCORRECTED bad grant still fails here, exactly as it did then.
   */
  it('any rake helper opened to authenticated is closed again by a later migration', () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const opened = new Map<string, string>();
    const closedAfter = new Map<string, string[]>();
    for (const f of files) {
      const sql = readFileSync(resolve(MIGRATIONS, f), 'utf8');
      for (const g of sql.match(/GRANT EXECUTE ON FUNCTION public\.(fn_ca_rake_\w+)[^;]*;/g) ??
        []) {
        if (!/\bauthenticated\b/.test(g)) continue;
        const fn = /public\.(fn_ca_rake_\w+)/.exec(g)![1];
        if (!opened.has(fn)) opened.set(fn, f);
      }
      for (const r of sql.match(/REVOKE ALL ON FUNCTION public\.(fn_ca_rake_\w+)[^;]*;/g) ?? []) {
        if (!/\bauthenticated\b/.test(r)) continue;
        const fn = /public\.(fn_ca_rake_\w+)/.exec(r)![1];
        closedAfter.set(fn, [...(closedAfter.get(fn) ?? []), f]);
      }
    }
    for (const [fn, openedIn] of opened) {
      const shut = (closedAfter.get(fn) ?? []).filter((f) => f > openedIn);
      expect(
        shut.length,
        `${fn} is granted to authenticated in ${openedIn} and never revoked from it afterwards`
      ).toBeGreaterThan(0);
    }
  });
});
