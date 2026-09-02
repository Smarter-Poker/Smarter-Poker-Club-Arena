/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPINS WALLET BELONGS TO EXACTLY ONE OWNER, AND SAYS SO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "ADD THE SPINS WALLET TO THE UNION, AND CLUBS WHEN THEY
 * ENABLE SPINS. IF A CLUB JOINS A UNION, THAT WALLET MUST DISAPPEAR."
 *
 * TWO POTS THAT LOOK LIKE ONE.
 *
 * The union dashboard already had a tile called "Spin Reserve" — and it does
 * NOT show this wallet. That one reads union_wallets.spin_reserve_wallet:
 * operator capital earmarked for Spins but NOT YET DEPLOYED. The migration
 * that created it says so: "The DEPLOYED reserve is spin_bonus_pools.balance —
 * this wallet holds only what is NOT currently in the pool, so the two never
 * double-count." So the live float every multiplier is paid from appeared on
 * no wallet surface in the entire product.
 *
 * THE DISAPPEARING ACT IS A DATA PROBLEM BEFORE IT IS A UI ONE.
 *
 * fn_spin_reserve_owner resolves COALESCE(clubs.union_id, club_id). The moment
 * clubs.union_id is written, the club's own pool row becomes unreachable
 * through every code path — balance stranded, seed unrepayable, is_active
 * still true. Hiding the row in the UI would have left the money orphaned. The
 * database moves it in the same transaction as the join.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { clubWalletRows } from '../../src/components/wallet/walletRows';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const dir = resolve(root, 'supabase/migrations');
const sql = readdirSync(dir)
  .filter((f) => f.includes('club_spin_pool_absorbed_on_union_join'))
  .map((f) => readFileSync(resolve(dir, f), 'utf8'))
  .join('\n');
const hook = read('src/hooks/useSpinsWallet.ts');
const union = read('src/pages/UnionDashboardPage.tsx');
const wallet = read('src/components/wallet/DynamicWallet.tsx');

describe('a standalone club that enabled Spins gets the row', () => {
  it('shows it to club-bank staff', () => {
    expect(clubWalletRows('owner', { standalone: true, spinsActive: true })).toContain(
      'spins_wallet'
    );
    expect(clubWalletRows('admin', { standalone: true, spinsActive: true })).toContain(
      'spins_wallet'
    );
  });

  it('does not show it to a player or an agent', () => {
    expect(clubWalletRows('player', { standalone: true, spinsActive: true })).not.toContain(
      'spins_wallet'
    );
    expect(clubWalletRows('agent', { standalone: true, spinsActive: true })).not.toContain(
      'spins_wallet'
    );
  });

  it('does not park a permanent zero on a club that never enabled Spins', () => {
    expect(clubWalletRows('owner', { standalone: true, spinsActive: false })).not.toContain(
      'spins_wallet'
    );
  });
});

describe('a club inside a union has no Spins wallet at all', () => {
  it('is hidden however active Spins are', () => {
    // The pool belongs to the UNION. Showing it here would put union money in
    // the club's own wallet - the same mistake rake_treasury guards against.
    expect(clubWalletRows('owner', { standalone: false, spinsActive: true })).not.toContain(
      'spins_wallet'
    );
  });

  it('is governed by the same flag as the rake treasury, not a new rule', () => {
    const inUnion = clubWalletRows('owner', { standalone: false, spinsActive: true });
    expect(inUnion).not.toContain('rake_treasury');
    expect(inUnion).not.toContain('spins_wallet');
  });

  it('is not even fetched for a club in a union', () => {
    /* The GATE is what this test is about: a club inside a union must not
       even ask. The first argument is the club identifier and is deliberately
       not pinned - it moved from the raw prop to the resolved UUID so the
       hook's device cache keys match every other read on the surface, which
       changes nothing about who owns the wallet. */
    expect(wallet).toMatch(/useSpinsWallet\([^)]*,\s*variant !== 'union' && !isClubInUnion\)/);
  });
});

describe('the money disappears correctly, not merely the row', () => {
  it('winds the pool down on the join itself', () => {
    expect(sql).toMatch(/fn_spin_absorb_club_pool_into_union/);
    expect(sql).toMatch(/trg_spin_pool_follows_union_membership/);
  });

  it('is a trigger, so a third join path cannot reintroduce the leak', () => {
    expect(sql).toMatch(/a club could join a union and strand its Spins wallet/);
  });

  it('refuses to pass while any club in a union still holds a wallet', () => {
    expect(sql).toMatch(/a club inside a union still holds a Spins wallet/);
  });

  it('checks the pools still reconcile afterwards', () => {
    expect(sql).toMatch(/seeded_amount \+ total_deposited - total_drawn/);
  });
});

describe('the two pots are never confused for each other', () => {
  it('the hook says which one it reads, and why not a plain select', () => {
    expect(hook).toMatch(/NOT YET DEPLOYED/);
    expect(hook).toMatch(/fn_spin_owner_state/);
  });

  it('reads through the owner lookup, so a club in a union reports its union', () => {
    expect(hook).toMatch(/spinActivationApi\.getState\(ownerKey\)/);
  });

  it('renders "-" rather than a made-up zero when it cannot be read', () => {
    expect(union).toMatch(/unionSpins\.state === null \? '-' :/);
    expect(wallet).toMatch(/known: spins\.state !== null/);
  });

  it('the union shows BOTH tiles, in both tabs', () => {
    expect((union.match(/Spins Wallet ›/g) ?? []).length).toBe(2);
    expect((union.match(/Spin Reserve ›/g) ?? []).length).toBe(2);
  });
});
