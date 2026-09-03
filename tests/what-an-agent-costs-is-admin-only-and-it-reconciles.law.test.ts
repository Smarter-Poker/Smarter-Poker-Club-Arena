import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WHAT AN AGENT COSTS IS ADMIN-ONLY, AND IT RECONCILES (binding)
 *
 * TWO invariants, and they fail in opposite directions.
 *
 * 1. THE GATE. fn_club_commission_accrued - the estate's own reader for this
 *    money - is gated on fn_is_club_admin_uid: owner, co-owner, admin, manager.
 *    ca_rake_snapshot runs under ca_can_view_club_finances, which ALSO admits
 *    super_agent. Adding commission columns without their own gate would show a
 *    super agent the club's commission bill, including what their peers earn,
 *    through a door the estate deliberately closed. That is the same shape as
 *    the horse flag one phase earlier, which is why it is a law and not a note.
 *
 *    Masked as NULL, never 0. Zero says "this agent costs nothing"; null says
 *    "not disclosed", and the panel renders it as a dash.
 *
 * 2. THE RECONCILIATION. The per-agent column has to sum to the club's own
 *    total. It did not: 22,378.97 against fn_club_commission_accrued's
 *    22,460.11, because 81.14 was earned by 59 recipients with no agents row in
 *    the club. Commission cascades, people leave, and the ledger keeps paying
 *    whoever earned it. A residual row carries them, so the column reconciles
 *    exactly - verified at 22,460.11 three ways.
 *
 * COMMISSION IS NOT RAKE TIMES RATE. It cascades: an upline earns on their
 * downline's rake and has its own ledger rows for it. Deriving it from the rake
 * column would produce a smaller, plausible, wrong number, so the figure is
 * read from agent_commissions and never computed.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

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

/** Just that function, not the migration around it. */
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

describe('what an agent costs', () => {
  it('is gated on the admin helper, not on the finances gate', () => {
    const sql = body('fn_ca_rake_by_agent');
    expect(sql, 'the commission columns have no gate of their own').toContain(
      'fn_is_club_admin_uid'
    );
  });

  it('masks to NULL rather than to zero', () => {
    // CASE WHEN v_cost THEN ... END with no ELSE yields NULL. An ELSE 0 here
    // would tell an unentitled viewer that every agent is free.
    //
    // The first version of this used [^E]* to bound the search and could not
    // span the uppercase E in COALESCE, so the ELSE-0 mutation it was written
    // for walked straight through it. Cut the expression out and read it.
    const sql = body('fn_ca_rake_by_agent');
    const cols = ['commission_earned', 'commission_outstanding', 'commission_settled'];
    for (const col of cols) {
      const end = sql.indexOf(`END AS ${col}`);
      expect(end, `${col} is not produced by a gated CASE`).toBeGreaterThan(-1);
      const start = sql.lastIndexOf('CASE WHEN v_cost', end);
      expect(start, `${col} is not gated on v_cost`).toBeGreaterThan(-1);
      const expr = sql.slice(start, end);
      expect(expr, `${col} falls back to a number instead of null: ${expr}`).not.toMatch(
        /\bELSE\b/i
      );
    }
  });

  it('reads the ledger and never derives commission from rake', () => {
    const sql = body('fn_ca_rake_by_agent');
    expect(sql).toContain('agent_commissions');
    // rate x rake, in any arrangement, would be the plausible wrong answer.
    expect(sql).not.toMatch(/commission_rate\s*\*/);
    expect(sql).not.toMatch(/\*\s*ca\.commission_rate/);
  });

  it('carries commission owed to people the agent table does not list', () => {
    // Without this the column silently disagrees with the club's own total.
    const sql = body('fn_ca_rake_by_agent');
    expect(sql).toMatch(/unlisted/i);
    expect(sql).toMatch(/NOT EXISTS[\s\S]{0,160}club_agents/);
  });

  it('matches the window of the estate reader it must agree with', () => {
    // fn_club_commission_accrued is half-open: >= since, < until. A closed
    // upper bound here would double-count the boundary row and the two totals
    // would differ by exactly one instant's commission.
    const sql = body('fn_ca_rake_by_agent');
    expect(sql).toMatch(/ac\.created_at >= v_from AND ac\.created_at < v_to/);
  });

  it('sums the commission column, because one row has one recipient', () => {
    // Unlike network_rake this genuinely sums - the cascade is already
    // expanded into per-recipient rows by the ledger.
    //
    // This asserted SUM(...) OVER () until search arrived, which was the
    // MECHANISM rather than the law. A window sums whatever rows survive the
    // WHERE, so once a search could filter the set, the club's commission bill
    // would silently have become the bill for the rows that matched what
    // somebody typed. It is now summed from the unfiltered set, and the law is
    // that the total spans every agent - not how it is reached.
    const sql = body('fn_ca_rake_by_agent');
    expect(sql).toMatch(
      /totals AS \([\s\S]*?SUM\(l\.commission_earned\)\s+AS total_commission[\s\S]*?FROM listed l/
    );
    expect(sql).toMatch(/'total_commission',\s*\(SELECT t\.total_commission FROM totals t\)/);
  });

  it('the snapshot passes the club total out rather than dropping it', () => {
    // Read across ALL migrations, not the one that last defined the function.
    // The wiring is a DO block that rewrites the deployed body, so scoping this
    // to the defining migration asserted against a version that predates the
    // key and failed a change that was correct.
    const all = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
      .join('\n');
    expect(all, 'commission_total is computed and then never returned').toMatch(
      /'commission_total',\(v_pack->>'total_commission'\)|''commission_total'',\(v_pack->>''total_commission''\)/
    );
  });

  it('the wiring asserts its anchor instead of silently adding nothing', () => {
    const all = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
      .join('\n');
    expect(all).toContain("RAISE EXCEPTION 'ca_rake_snapshot: breakdown_offset anchor not found'");
  });
});
