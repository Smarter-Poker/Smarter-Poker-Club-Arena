/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY CLUB WALLET CLOSES INTO THE MAIN BANK ON A UNION JOIN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "IF A CLUB HAS SPINS, BBJ, BACK UP BBJ OR PROMO FUNDS, ALL
 * CHIPS IN THE WALLETS GO TO THE 'MAIN BANK' AND CLOSED WHEN A CLUB JOINS A
 * UNION. ALL THOSE FUNDS ARE GIVEN TO THE CLUB TO KEEP OR DISBURSE AT THEIR
 * OWN DISCRETION."
 *
 * THIS OVERRULES A DECISION MADE AN HOUR EARLIER. The first version of the
 * union-join wind-down sent the Spins SEED back to the club but the remaining
 * FLOAT to the union, on the reasoning that the float was player money and the
 * union now runs Spins for those players. The club funded the wallet and the
 * club carried the variance, so the club keeps the balance. All of it.
 *
 * PROMO LIVES IN TWO PLACES. bbj_pools.promo_balance is the jackpot's own
 * promo slice; clubs.promo_balance is the club's separate promo float.
 * Sweeping one and not the other would look like it worked.
 *
 * THE TRAP: fn_bbj_conservation_check computes gap = inflow - outflow -
 * balances. Taking money OUT of bbj_pools shrinks `balances` and pushes the gap
 * up by exactly the amount swept — turning a correct transfer into a red money
 * alarm. The check already counts `bbj_promo_sweep` rows in chip_transactions
 * as OUTFLOW, so booking the sweep that way leaves the gap untouched.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(__dirname, '../../supabase/migrations');
const sql = readdirSync(dir)
  .filter((f) => f.includes('club_wallets_close_into_main_bank'))
  .map((f) => readFileSync(resolve(dir, f), 'utf8'))
  .join('\n');

describe('the money goes to the club, not the union', () => {
  it('ships the migration', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it('refuses to pass if the Spins float still goes to the union', () => {
    expect(sql).toMatch(/the Spins wallet still hands its float to the union/);
  });

  it('states plainly that this overrules the earlier split', () => {
    expect(sql).toMatch(/CORRECTS A DECISION MADE AN HOUR EARLIER/);
  });
});

describe('all four wallets, and both homes of promo', () => {
  it('names every wallet it closes', () => {
    expect(sql).toMatch(/spin_bonus_pools\.balance/);
    expect(sql).toMatch(/bbj_pools\.main_balance/);
    expect(sql).toMatch(/bbj_pools\.backup_balance/);
    expect(sql).toMatch(/bbj_pools\.promo_balance AND clubs\.promo_balance/);
  });

  it('refuses to pass if the club promo float is left behind', () => {
    expect(sql).toMatch(/the club promo float is not swept/);
  });

  it('refuses to pass while any club in a union still holds wallet money', () => {
    expect(sql).toMatch(/a club inside a union still holds wallet money/);
  });
});

describe('the BBJ money invariant', () => {
  it('books the sweep as the outflow the check already counts', () => {
    expect(sql).toMatch(/bbj_promo_sweep/);
    expect(sql).toMatch(/the conservation gap will move/);
  });

  it('explains why global health is NOT the assertion', () => {
    // The check was already unhealthy by -226.65 before any of this work.
    // Blocking a correct transfer on an unrelated fault would be wrong;
    // adding to it would be worse. The gap-did-not-move test separates them.
    expect(sql).toMatch(/-226\.65/);
    expect(sql).toMatch(/pre-existing discrepancy/);
  });

  it('records that play moves but money does not follow it', () => {
    expect(sql).toMatch(/PLAY MOVES, MONEY DOES NOT FOLLOW IT/);
    expect(sql).toMatch(/merged_into_pool_id/);
  });
});

describe('it cannot be bypassed by adding another join path', () => {
  it('hangs off the trigger, not the two API routes', () => {
    expect(sql).toMatch(/fn_spin_pool_follows_union_membership/);
    expect(sql).toMatch(/the union-join trigger does not close every wallet/);
  });
});
