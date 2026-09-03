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

describe('the rake snapshot denominator', () => {
  it('ca_rake_snapshot exists in the migrations at all', () => {
    expect(latestDefining('ca_rake_snapshot')).not.toBe('');
  });

  it('never sums network_rake into breakdown_total, on any scope', () => {
    // There is one assignment per scope. Every one of them has to be safe, so
    // the law reads all of them rather than whichever happens to be first -
    // the first version of this test read only the first and passed while the
    // club scope, the one that actually has a network column, went unchecked.
    const sql = latestDefining('ca_rake_snapshot');
    const assignments = [...sql.matchAll(/SELECT[\s\S]{0,400}?INTO v_btotal/g)].map((m) => m[0]);
    expect(assignments.length, 'no breakdown_total is ever computed').toBeGreaterThan(0);
    for (const block of assignments) {
      expect(block, `this assignment sums the double-counted column: ${block}`).not.toContain(
        'network_rake'
      );
    }
  });

  it('the scope that has a network column sums the direct one', () => {
    const sql = latestDefining('ca_rake_snapshot');
    const assignments = [...sql.matchAll(/SELECT[\s\S]{0,400}?INTO v_btotal/g)].map((m) => m[0]);
    expect(assignments.some((b) => b.includes("'direct_rake'"))).toBe(true);
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
      for (const g of grants) {
        expect(g).not.toContain('anon');
        expect(g).not.toMatch(/\bauthenticated\b/);
      }
    }
  });
});
