/**
 * LAW: THE OPEN ALERTS CLOSE ON THEIR VERIFIED CAUSES (2026-10-15).
 *
 * Every alert or drift incident that migration 20261015124934 closes is
 * closed only after its group re-asserts the state it was closed on, inside
 * the same transaction, so the file rolls back whole if the board has moved.
 * It moves no money, writes no ledger row and deletes nothing, and the alerts
 * that are still true today (the open week, the unpaid square-up statements,
 * the spin fairness reading, another change's refused transaction) stay open.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015124934_the_open_alerts_close_on_their_verified_causes_again.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');

describe('the open alerts close on their verified causes', () => {
  it('is one transaction with a live proof and a final assertion that every group closed', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/^-- @live-proof: \(SELECT count\(\*\) FROM public\.financial_alerts/m);
    expect(CODE).toContain("RAISE EXCEPTION 'an alert this file reads as closed is still open'");
    expect(CODE).toContain("RAISE EXCEPTION 'an incident this file resolves is still open'");
  });

  it('asserts each group before it closes it', () => {
    for (const assertion of [
      "'A: the freeroll is not completed, paid and conserved'",
      "'B: the metadata trigger defect has recurred'",
      "'B: a trigger reads NEW.metadata on a table without it'",
      "'B: an open leave_pending alert moved chips'",
      "'C: fn_money_check_health is scheduled after all'",
      "'C: % has not succeeded on its own job within %'",
      "'D: a Free Buy slot due since the board resumed is missing'",
    ])
      expect(CODE).toContain(assertion);
  });

  it('moves no money, deletes nothing and changes no definition', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/i);
    expect(CODE).not.toMatch(/\bINSERT\b/i);
    expect(CODE).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i);
    expect(CODE).not.toMatch(/fn_credit_and_log|chip_ledger|club_members|wallet_transactions/);
    const updated = [...CODE.matchAll(/UPDATE\s+public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(updated)).toEqual(new Set(['financial_alerts']));
  });

  it('leaves the alerts that are still true open', () => {
    for (const source of [
      'union_accounting_scheduler',
      'fn_union_treasury_selftest',
      'fn_union_age_invoices',
      'fn_union_enforce_stop_loss',
      'fn_spin_fairness_check',
      'ledger_invariant',
      'settler_lag',
      'c748f59f',
    ])
      expect(CODE).not.toContain(source);
    expect(CODE).not.toContain("source = 'fn_tournament_money_conservation'");
  });
});
