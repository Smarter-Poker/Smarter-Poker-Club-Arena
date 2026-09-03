/**
 * THE WEEKLY UNION CLOSE PAYS FROM THE RAKE TREASURY, AND ONLY FROM IT.
 *
 * 2026-09-03, Chip Accounting Standard Phase 2.1 (lane-2 audit F1, CRITICAL).
 *
 * The close used to debit two union pots for one payout: the rake treasury
 * by the period total AND the general bank by the clubs' share, while the
 * clubs received the share once. The retained share vanished and the payout
 * left twice. Its guard demanded that the general bank cover a treasury
 * payout, so a union with 2.05M in the treasury and 69k in the bank would
 * have refused a 160k week forever.
 *
 * The rules this pins are the ones that keep chips conserved on the one
 * day a week real money moves between the union and its clubs:
 *
 *   - the treasury is debited by the period total, once;
 *   - the retained share is CREDITED to the general bank, never debited;
 *   - the general bank is never a source and never consulted by the guard;
 *   - conservation is asserted on the balances inside the guarded section,
 *     so a miss rolls the whole close back;
 *   - the club credits are op-keyed, so a retried close cannot pay twice;
 *   - the union side is declared through fn_ca_declare_ledger with the
 *     union_wallets auto-ledger skipped, and the retained share is written
 *     as one explicit union_wallet -> union_bank row.
 *
 * Rolled-back probe on the real 2026-08-24..08-31 period (transcript in
 * docs/changelog/2026-09-03-chip-std-phase2-union-close.md): treasury
 * -962,179.99, bank +961,039.51, clubs +1,140.48, sum 0.00, replay refused.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const FILE = readdirSync(DIR)
  .filter((f) => f.includes('the_weekly_union_close_pays_from_the_rake_treasury'))
  .sort()
  .pop();
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';

/** The function body, bounded by its own dollar-quoted block. */
function body(): string {
  const open = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close');
  expect(open, 'fn_union_weekly_rakeback_close has moved or gone').toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end, 'the function body is not dollar-quoted as expected').toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe('the weekly union close pays from one pot', () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the phase-2.1 migration is missing').toBeTruthy();
  });

  it('debits the rake treasury by the period total, once', () => {
    expect(body()).toMatch(/rake_wallet\s*=\s*rake_wallet\s*-\s*v_period_total/);
    expect(body()).not.toMatch(/LEAST\(v_period_total,\s*COALESCE\(v_wallet\.rake_wallet/);
  });

  it('credits the retained share to the general bank and never debits it', () => {
    const b = body();
    expect(b).toMatch(/chip_balance\s*=\s*chip_balance\s*\+\s*v_retained/);
    expect(b).not.toMatch(/chip_balance\s*=\s*chip_balance\s*-\s*v_payout_total/);
  });

  it('never consults the general bank in the solvency guard', () => {
    const b = body();
    expect(b).not.toMatch(/v_payout_total\s*>\s*COALESCE\(v_wallet\.chip_balance/);
    expect(b).toMatch(/v_period_total\s*>\s*COALESCE\(v_wallet\.rake_wallet,\s*0\)/);
  });

  it('asserts conservation on the balances inside the guarded section', () => {
    const b = body();
    const guard = b.indexOf('guarded money section');
    const assert = b.indexOf('conservation violation in the weekly union close');
    const handler = b.indexOf('EXCEPTION WHEN OTHERS THEN', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(assert).toBeGreaterThan(guard);
    expect(handler, 'the guarded section has no handler').toBeGreaterThan(assert);
    expect(b).toMatch(/round\(v_new_rw - v_rw_before, 2\)\s*<>\s*round\(-v_period_total, 2\)/);
    expect(b).toMatch(
      /round\(v_clubs_after - v_clubs_before, 2\)\s*<>\s*round\(v_payout_total, 2\)/
    );
  });

  it('keys every club credit so a retried close cannot pay twice', () => {
    expect(body()).toMatch(/'union_close:' \|\| v_sid::text \|\| ':' \|\| v_club\.club_id::text/);
  });

  it('declares the union side and writes the retained share as one explicit row', () => {
    const b = body();
    expect(b).toMatch(
      /fn_ca_declare_ledger\('rakeback',\s*'union_wallet',\s*p_union_id,\s*v_sid,\s*NULL,\s*ARRAY\['union_wallets'\]\)/
    );
    expect(b).toMatch(/'union_wallet',\s*p_union_id,\s*'union_bank',\s*p_union_id/);
    expect(b).toMatch(/'union_close:' \|\| v_sid::text \|\| ':retained'/);
    // the old "informational" retained credit that moved nothing is gone
    expect(b).not.toContain('chip_balance total unchanged by retention');
  });

  it('keeps the return shape the cascade reads', () => {
    const b = body();
    for (const key of ["'success'", "'clubs_paid'", "'total_rakeback'", "'union_retained'"]) {
      expect(b).toContain(key);
    }
  });
});
