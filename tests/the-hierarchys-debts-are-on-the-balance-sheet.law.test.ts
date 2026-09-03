/**
 * THE HIERARCHY'S DEBTS ARE ON THE BALANCE SHEET.
 *
 * 2026-09-03, Chip Accounting Standard Phase 2.3 / F8, and the F9 remainder.
 *
 * Commission a club owes its agents (agent_commissions.settled_at IS NULL)
 * and rakeback it owes its players (rakeback_periods.status = 'pending') are
 * obligations no balance-sheet view knew about: 640k / 129k / 63k of
 * commission and 28k / 48k / 45k / 232k of rakeback on 2026-09-03, invisible
 * to the trial balance and the solvency checks. fn_ca_hierarchy_payables
 * reports them beside the treasury, pricing rakeback at BOTH the rate stamped
 * on the row and the contract rate (fn_player_rakeback_rate), because which
 * one pays is Dan's ruling and the ruling should be priced (67,675.62 apart).
 *
 * The rules this pins:
 *
 *   - the report is read-only: no UPDATE, INSERT or DELETE in its body;
 *   - it is not a browser door: revoked from PUBLIC, anon and authenticated,
 *     granted to service_role, and gated for JWT callers the way
 *     fn_ca_post_correction is (incident recipients, admin or god);
 *   - it prices rakeback at the contract rate as well as the row rate;
 *   - calculate_cascading_commission is no longer executable by PUBLIC or
 *     anon, and the self-check refuses if a real caller lost its grant.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const FILE = readdirSync(DIR)
  .filter((f) => f.includes('the_hierarchys_debts_are_on_the_balance_sheet'))
  .sort()
  .pop();
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';

function body(): string {
  const open = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_hierarchy_payables');
  expect(open, 'fn_ca_hierarchy_payables has moved or gone').toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe("the hierarchy's debts are on the balance sheet", () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the phase-2.3 migration is missing').toBeTruthy();
  });

  it('reads and never writes', () => {
    const b = body();
    expect(b).not.toMatch(/\bUPDATE\s+public\./i);
    expect(b).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(b).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).toMatch(/\n\s*STABLE\s*\n/);
  });

  it('is not a browser door', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_hierarchy_payables\(uuid\) FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_hierarchy_payables\(uuid\) TO service_role;/
    );
    const b = body();
    expect(b).toContain("COALESCE(auth.role(), '') <> 'service_role'");
    expect(b).toContain('ca_incident_recipients');
    expect(b).toContain("p.role IN ('admin','god')");
  });

  it('prices rakeback at the contract rate as well as the row rate', () => {
    const b = body();
    expect(b).toContain('fn_player_rakeback_rate(r.user_id, r.club_id, r.rake_generated)');
    expect(b).toContain('sum(r.rakeback_amount)');
    expect(b).toContain("r.status = 'pending'");
    expect(b).toContain('a.settled_at IS NULL');
  });

  it('closes the anonymous door on the commission calculator without touching its real callers', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.calculate_cascading_commission\([^)]*\) FROM PUBLIC, anon;/
    );
    expect(SQL).not.toMatch(
      /REVOKE ALL ON FUNCTION public\.calculate_cascading_commission\([^)]*\) FROM[^;]*authenticated/
    );
    expect(SQL).toContain('a real caller of calculate_cascading_commission lost its grant');
  });
});
