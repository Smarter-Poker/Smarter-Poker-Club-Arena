/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLUB'S PROMO WALLET IS THE BBJ SLICE, NOT THE VIEWER'S AGENT FLOAT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, binding: "NONE OF THE CHIPS FROM THE BBJ RAKE ARE GOING INTO
 * THE PROMO WALLET, GET TO THE ROOT CAUSE OF WHY THATS NOT HAPPENING AND FIX IT
 * PLEASE. THIS NEEDS TO BE STANDARD AND HARD WIRED INTO EVERY CLUB, OLD AND
 * NEW."
 *
 * They were going in. Measured on Deep Stack Society, 2026-09-02 22:25 UTC:
 *
 *   bbj_contributions   14,341 hands, 4,928.83 dropped
 *                       main 2,464.52 / backup 1,233.18 / promo 1,231.13
 *   bbj_pools           main 3,438.53 (1,000 seed + accrual), backup 1,219.26,
 *                       promo 14.78 (the last few minutes, not yet swept)
 *   clubs.promo_balance 1,220.19   <- the promo slice, swept and banked
 *
 * The split is right (50/25/25 in bbj_record_contribution) and the sweep runs
 * (684 club sweeps for 29,962.67; 4,848 union sweeps for 57,806.50). What was
 * broken is that NOTHING COULD READ THE CLUB ACCOUNT: fn_club_money_panel never
 * returned clubs.promo_balance, so the club's Promo Wallet row fell back to the
 * VIEWER'S OWN agents.promo_wallet_balance - 0.00 for an owner who is not an
 * agent. 1,220.19 of real club money, banked correctly, invisible everywhere.
 *
 * Three names, one label. These pins hold which account the row means:
 *
 *   union surface            union_wallets.promo_wallet   (the swept slice)
 *   club surface, club bank  clubs.promo_balance          (this club's slice)
 *   club surface, an agent   agents.promo_wallet_balance  (their own float)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { blankNonCode } from '../helpers/sourceWindow';
import { canSeeClubBank } from '../../src/components/wallet/walletRows';

const WALLET = readFileSync(
  resolve(__dirname, '../../src/components/wallet/DynamicWallet.tsx'),
  'utf8'
);
const CODE = blankNonCode(WALLET);

describe('the club Promo Wallet row reads the club account', () => {
  it('the panel figure is carried in its own field, never merged with the float', () => {
    expect(CODE).toMatch(/clubPromoWallet: number;/);
    expect(CODE).toMatch(/clubPromoWallet: num\(panel\.club_promo_wallet\)/);
  });

  it('the club account is read for exactly the roles that see the Club Bank', () => {
    expect(CODE).toMatch(/const clubPromoIsClubMoney = canSeeClubBank\(viewerRole\);/);
  });

  it('and the row picks the account by surface, then by role', () => {
    // union -> union promo; club + bank role -> club promo; otherwise the float.
    // Raw source, not blankNonCode: these assertions contain string literals,
    // which blankNonCode deliberately erases.
    expect(WALLET).toMatch(
      /effectiveVariant === 'union'\s*\?\s*data\.unionPromo\s*:\s*clubPromoIsClubMoney\s*\?\s*data\.clubPromoWallet\s*:\s*data\.promoBalance/
    );
  });

  it('the settled value agrees with the animated one, or the row would flicker', () => {
    expect(WALLET).toMatch(
      /case 'promo_wallet':\s*return clubPromoIsClubMoney \? data\.clubPromoWallet : data\.promoBalance;/
    );
  });

  it('a stepping balance is labelled as such, so it cannot read as unfunded', () => {
    expect(WALLET).toMatch(/25% BBJ Slice · Swept Every 5 Min/);
  });
});

describe('the roles that hold the club promo account', () => {
  it('are the Club Bank roles, and no others', () => {
    for (const role of ['owner', 'co_owner', 'admin', 'super_agent']) {
      expect(canSeeClubBank(role), role).toBe(true);
    }
    for (const role of ['agent', 'sub_agent', 'player', 'member']) {
      expect(canSeeClubBank(role), role).toBe(false);
    }
  });
});

describe('the migration that exposed it is in the repo', () => {
  it('fn_club_money_panel returns club_promo_wallet', () => {
    const dir = resolve(__dirname, '../../supabase/migrations');
    const file = readdirSync(dir).find((f) =>
      f.includes('the_club_promo_wallet_the_bbj_has_been_funding_all_along')
    );
    expect(file, 'the applied migration must be mirrored in supabase/migrations').toBeTruthy();
    const sql = readFileSync(resolve(dir, file as string), 'utf8');
    expect(sql).toMatch(/'club_promo_wallet', round\(COALESCE\(v_club\.promo_balance, 0\), 2\)/);
  });
});
