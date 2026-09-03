/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SPIN WALLET THAT BELONGS TO SOMEBODY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "YOU NEED TO CREATE A WALLET FOR THE SPINS FOR CLUB OWNERS
 * NOT APART OF THE UNION, AND FOR UNIONS. SPINS SHOULD BE 'ACTIVATED' IN THE
 * OWNERS MENU, AND WHEN THEY ARE, THEY NEED TO DECIDE HOW MUCH THEY ARE
 * 'SEEDING' INTO THE WALLET. (THOSE FUNDS ARE RETURNED ONCE ENOUGH IS
 * COLLECTED) AND ALL PROCEEDS ARE KEPT THERE TO FUND THE MULTIPLIER PAYOUTS."
 *
 * And: "100X IS THE HIGHEST IT GOES. YES IT RETURNS EVERYTHING IT COLLECTS,
 * RAKE GOES INTO THE RAKE TREASURY, BUT IT NEEDS TO COLLECT FIRST TO
 * DISTRIBUTE."
 *
 * WHAT WAS ALREADY THERE, AND WHY IT DID NOTHING
 * spin_bonus_pools was already keyed on an owner -- fn_spin_reserve_owner
 * resolves COALESCE(clubs.union_id, club_id), so a union owns the pool for its
 * clubs and a standalone club owns its own. That much was right. Everything
 * that made it a feature was missing:
 *
 *   * is_active was DEAD CODE. Not read by any function, API route, the
 *     engine, or the client. Every pool was active forever by default.
 *   * seeded_amount existed and nothing ever repaid it.
 *   * fn_spin_reserve_seed MINTED -- credited the pool, debited nobody. A
 *     "seed" created chips from nothing. It had no caller in application code,
 *     which is the only reason that never mattered.
 *   * A standalone club had NO destination wallet, so the surplus return
 *     resolved to nothing and was booked with no counterparty.
 *
 * The whole platform therefore ran on exactly ONE pool.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredSeed, SPIN_TIERS } from '../../src/config/spinSpec';

const root = resolve(__dirname, '../../');
const migrationsDir = resolve(root, 'supabase/migrations');
const sql = readdirSync(migrationsDir)
  .filter((f) => f.includes('spin_wallet_per_owner'))
  .map((f) => readFileSync(resolve(migrationsDir, f), 'utf8'))
  .join('\n');

describe('the wallet knows who it belongs to', () => {
  it('ships the migration at all', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it('records a club owner separately from a union owner', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_spin_owner_kind/i);
    expect(sql).toMatch(/FROM public\.unions u WHERE u\.id = p_owner_id/i);
  });

  it('gives a standalone club a real destination, which it never had', () => {
    // This is the gap: union_wallets has no row for a club id, so before today
    // a club-owned pool had nowhere to send money back to.
    expect(sql).toMatch(/UPDATE public\.clubs SET/i);
    expect(sql).toMatch(/'chip_treasury','promo_balance'/);
  });

  it('still routes a union through union_wallets', () => {
    expect(sql).toMatch(/UPDATE public\.union_wallets SET/i);
    expect(sql).toMatch(/'chip_balance','promo_wallet','rake_wallet','spin_reserve_wallet'/);
  });

  it('allow-lists the wallet column instead of interpolating whatever it is given', () => {
    // format(%I) on an unchecked string would be an arbitrary-column write
    // primitive sitting behind a SECURITY DEFINER function.
    expect(sql).toMatch(/RAISE EXCEPTION 'unknown union wallet %'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'unknown club wallet %'/);
  });

  it('refuses to overdraw a wallet', () => {
    expect(sql).toMatch(/\+ \$1 >= 0/);
  });
});

describe('activation is a real event, not a default', () => {
  it('stamps who turned it on and when', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS activated_at\s+timestamptz/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS activated_by\s+uuid/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS deactivated_at\s+timestamptz/i);
  });

  it('takes the seed BEFORE marking the pool active', () => {
    const move = sql.indexOf('v_wallet_after := public.fn_spin_move_owner_wallet(');
    const active = sql.indexOf('is_active          = true');
    expect(move).toBeGreaterThan(-1);
    expect(active).toBeGreaterThan(-1);
    // If the pool were opened first and funding then failed, the board would be
    // live against a wallet that never paid.
    expect(move).toBeLessThan(active);
  });

  it('refuses a seed below the required amount', () => {
    expect(sql).toMatch(/'seed_below_required'/);
    expect(sql).toMatch(/IF COALESCE\(p_seed_amount,0\) < v_required THEN/);
  });

  it('refuses when the wallet cannot fund it', () => {
    expect(sql).toMatch(/'insufficient_funds_or_no_wallet'/);
  });

  it('refuses to activate twice', () => {
    expect(sql).toMatch(/'already_active'/);
  });

  it('finally makes is_active mean something', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_spin_owner_can_open/i);
    expect(sql).toMatch(/p\.is_active AND p\.activated_at IS NOT NULL AND p\.balance > 0/);
  });

  it('deactivation moves no money', () => {
    // Bound the slice to the function DEFINITION. Searching for the bare name
    // finds the COMMENT ON COLUMN above it, which names activate and
    // deactivate in the same sentence and would drag activate's body in.
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_spin_deactivate');
    const body = sql.slice(start, sql.indexOf('COMMENT ON FUNCTION public.fn_spin_deactivate'));
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/is_active = false/);
    expect(body).not.toMatch(/fn_spin_move_owner_wallet/);
  });
});

describe('the required seed matches the client spec exactly', () => {
  it('is two top-tier jackpots at the largest offered stake', () => {
    expect(sql).toMatch(/GREATEST\(COALESCE\(p_offered_max_stake, 0\), 0\) \* 100 \* 2/);
  });

  it('100x really is the top of the ladder, as Dan said', () => {
    expect(SPIN_TIERS[SPIN_TIERS.length - 1].multiplier).toBe(100);
  });

  it('agrees with requiredSeed() in spinSpec for every board stake', () => {
    // The board's price points. If these ever diverge, an owner is quoted one
    // number in the menu and charged another by the database.
    for (const stake of [1, 2, 3, 5, 10, 20, 50, 100]) {
      expect(requiredSeed(stake)).toBe(stake * 100 * 2);
    }
  });

  it('asserts the 100-stake case inside the migration itself', () => {
    expect(sql).toMatch(/fn_spin_required_seed\(100\) <> 20000/);
  });
});

describe('the seed is a loan, and it comes back', () => {
  it('remembers where the seed came from so it returns to the same place', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS seed_source_wallet\s+text/i);
    expect(sql).toMatch(/seed_source_wallet = p_source_wallet/);
  });

  it('will not repay a seed whose source was never recorded', () => {
    // The one pool predating this carries a 20,000 seed from before any source
    // was written down. Money does not move on a guess.
    expect(sql).toMatch(/v_wallet IS NOT NULL/);
  });

  it('requires that PLAY alone collected the seed, so it is never repaid out of itself', () => {
    expect(sql).toMatch(/v_collected_play >= v_required/);
  });

  it('requires the pool still stands on its own AFTER repaying', () => {
    // The condition that is easy to omit and wrong to. total_deposited is
    // cumulative forever, so on a mature pool the first condition is true
    // immediately -- repaying on that alone drains the float the instant it
    // qualifies and re-locks the top of the ladder.
    expect(sql).toMatch(/\(v_bal - v_seed\) >= v_required/);
  });

  it('clears the outstanding seed and keeps the historical total', () => {
    expect(sql).toMatch(/seeded_amount\s+= 0/);
    expect(sql).toMatch(/seed_returned_amount = seed_returned_amount \+ v_seed/);
  });

  it('writes a ledger row for the repayment', () => {
    expect(sql).toMatch(/'seed_return'/);
    expect(sql).toMatch(/CHECK \(kind = ANY \(ARRAY\[[\s\S]*'seed_return'/);
  });
});

describe('the ceiling is retired: it collects first, then distributes', () => {
  it('zeroes every ceiling still on a row', () => {
    expect(sql).toMatch(/UPDATE public\.spin_bonus_pools SET ceiling_amount = 0/i);
  });

  it('asserts no pool escapes with a ceiling', () => {
    expect(sql).toMatch(/ceiling retired but % pool\(s\) still carry one/);
  });

  it("asserts the settle path no longer sweeps, by the sweep's own signature", () => {
    // Deliberately NOT a grep for "ceiling_amount". pg_get_functiondef includes
    // comments, and the block explaining why the ceiling was retired names it --
    // so that assertion would fail on its own explanation.
    expect(sql).toMatch(/surplus_returned = surplus_returned%'\) THEN/);
    expect(sql).toMatch(/fn_spin_settle_game still sweeps surplus to the operator/);
  });

  it('no longer sweeps surplus to the operator on settle', () => {
    // End the slice at the grants. Past that point the migration deliberately
    // zeroes ceiling_amount and asserts on it, and running to end-of-file would
    // match the very cleanup that retires the thing being asserted absent.
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_spin_settle_game');
    const settle = sql.slice(start, sql.indexOf('REVOKE ALL ON FUNCTION'));
    expect(start).toBeGreaterThan(-1);
    expect(settle.length).toBeGreaterThan(1000);
    // Strip SQL comments first. The prose inside settle explains what the
    // ceiling WAS, so asserting on raw text would fail on the explanation
    // rather than on the code -- the same trap the migration assertion hit.
    const code = settle.replace(/^\s*--.*$/gm, '');
    expect(code).not.toMatch(/ceiling_amount/);
    expect(code).not.toMatch(/surplus_returned = surplus_returned/);
  });

  it('leaves rake alone -- that is the revenue line, and it still books per club', () => {
    const settle = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_spin_settle_game'),
      sql.indexOf('REVOKE ALL ON FUNCTION')
    );
    expect(settle).toMatch(/INSERT INTO public\.rake_records/);
    expect(settle).toMatch(/VALUES \(NULL, NULL, p_club_id, v_rake/);
  });
});

describe('the money movers are not reachable from a browser', () => {
  it('revokes the wallet primitive from anon and authenticated', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_spin_move_owner_wallet[\s\S]*?FROM anon, authenticated/
    );
  });

  it('revokes activation and deactivation too', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_spin_activate[\s\S]*?FROM anon, authenticated/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_spin_deactivate[\s\S]*?FROM anon, authenticated/
    );
  });

  it('still lets a signed-in owner READ their own state for the menu', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_spin_owner_state\(uuid\) TO authenticated/
    );
  });
});

describe('the owner menu can be built from one read', () => {
  it('returns everything the panel needs', () => {
    for (const key of [
      'is_active',
      'balance',
      'offered_max_stake',
      'required_seed',
      'seeded_amount',
      'seed_returned_amount',
      'seed_repayable_in',
      'collected_from_play',
      'total_drawn',
      'spin_count',
    ]) {
      expect(sql).toContain(`'${key}'`);
    }
  });

  it('tells the owner how much further play has to go before the seed returns', () => {
    expect(sql).toMatch(/'seed_repayable_in', GREATEST\(v_required - v_r\.total_deposited, 0\)/);
  });

  it('answers for an owner that has no pool row yet', () => {
    expect(sql).toMatch(/IF NOT FOUND THEN/);
  });
});
