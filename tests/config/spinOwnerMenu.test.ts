/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE OWNER'S SPIN MENU
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "SPINS SHOULD BE 'ACTIVATED' IN THE OWNERS MENU, AND WHEN
 * THEY ARE, THEY NEED TO DECIDE HOW MUCH THEY ARE 'SEEDING' INTO THE WALLET."
 *
 * Three numbers have to agree or an owner is quoted one price and charged
 * another: requiredSeed() in spinSpec, fn_spin_required_seed in the database,
 * and requiredSeedForStake() here in the panel's own service. This file pins
 * all three together.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredSeed, SPIN_TIERS } from '../../src/config/spinSpec';
import {
  requiredSeedForStake,
  SPIN_BOARD_STAKES,
  SPIN_SEED_SOURCES,
} from '../../src/services/SpinActivationService';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const panel = read('src/components/club/SpinActivationPanel.tsx');
const service = read('src/services/SpinActivationService.ts');
const settings = read('src/pages/ClubSettingsPage.tsx');

describe('the quoted seed is the seed that gets charged', () => {
  it('agrees with spinSpec on every board price point', () => {
    for (const stake of SPIN_BOARD_STAKES) {
      expect(requiredSeedForStake(stake)).toBe(requiredSeed(stake));
    }
  });

  it('is two top-tier jackpots, and the top tier is 100x', () => {
    expect(SPIN_TIERS[SPIN_TIERS.length - 1].multiplier).toBe(100);
    expect(requiredSeedForStake(10)).toBe(10 * 100 * 2);
    expect(requiredSeedForStake(100)).toBe(100 * 100 * 2);
  });

  it('offers exactly the board it can actually open', () => {
    expect([...SPIN_BOARD_STAKES]).toEqual([1, 2, 3, 5, 10, 20, 50, 100]);
  });

  it('never quotes a negative seed', () => {
    expect(requiredSeedForStake(-5)).toBe(0);
    expect(requiredSeedForStake(0)).toBe(0);
  });
});

describe('the money never goes straight from the browser to the database', () => {
  it('activation and deactivation go through the World Hub route', () => {
    expect(service).toMatch(/fetch\('\/api\/club-arena\/spin-activation'/);
  });

  it('does not call the revoked money functions over supabase.rpc', () => {
    // fn_spin_activate is REVOKEd from authenticated precisely so this cannot
    // work; calling it here would fail silently for every real browser user.
    expect(service).not.toMatch(/supabase\.rpc\(\s*'fn_spin_activate'/);
    expect(service).not.toMatch(/supabase\.rpc\(\s*'fn_spin_deactivate'/);
    expect(panel).not.toMatch(/supabase\.rpc\(/);
  });

  it('sends the session token, not a user id from the client', () => {
    expect(service).toMatch(/Authorization: `Bearer \$\{token\}`/);
    expect(service).not.toMatch(/userId/);
  });
});

describe('the panel tells the owner the truth about whose money it is', () => {
  it('says so when the union owns the wallet', () => {
    expect(panel).toMatch(/isUnionOwned/);
    expect(panel).toMatch(/Only The Union Lead/);
  });

  it('obeys the ROUTE on who may act, and fails closed until it answers', () => {
    // Changed 2026-08-23. The panel inferred permission from owner_kind, which
    // was wrong in BOTH directions: `canManage && !isUnionOwned` hid the off
    // switch from the union lead -- the one person allowed to press it -- while
    // the activate button had no such guard and was offered to a club owner
    // inside a union whose request the API answers 403.
    expect(panel).toMatch(/const canAct = canManage && routeCanManage === true;/);
    expect(panel).not.toMatch(/canManage && !isUnionOwned/);
  });

  it('gates BOTH buttons on the same answer', () => {
    const matches = panel.match(/\{canAct && \(/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('only claims you cannot change it when you actually cannot', () => {
    expect(panel).toMatch(/\{isUnionOwned && !canAct && \(/);
  });

  it('takes canManage from the route response, never from owner_kind', () => {
    expect(panel).toMatch(/setRouteCanManage\(Boolean\(res\.canManage\)\)/);
    expect(service).toMatch(/canManage: boolean/);
  });

  it('lists only the wallets that owner kind actually holds', () => {
    expect(SPIN_SEED_SOURCES.club.map((s) => s.value)).toEqual(['chip_treasury', 'promo_balance']);
    expect(SPIN_SEED_SOURCES.union.map((s) => s.value)).toEqual([
      'chip_balance',
      'promo_wallet',
      'rake_wallet',
      'spin_reserve_wallet',
    ]);
  });

  it('defaults the source to one the owner really has', () => {
    // Defaulting to a club wallet for a union owner would send a request that
    // the route is guaranteed to reject.
    expect(panel).toMatch(/sources\.some\(\(s\) => s\.value === w\)/);
  });
});

describe('the seed is presented as a loan, because that is what it is', () => {
  it('says the seed comes back', () => {
    expect(panel).toMatch(/The Seed Is A Loan, Not A Fee/);
  });

  it('shows how much further play has to go before it returns', () => {
    expect(panel).toMatch(/seed_repayable_in/);
    expect(panel).toMatch(/Returns After Another/);
  });

  it('says what happens to proceeds once the seed is repaid', () => {
    expect(panel).toMatch(/Stays Here To Fund Multipliers/);
  });

  it('quotes the required seed on the button itself, before the click', () => {
    expect(panel).toMatch(/Activate Spins And Seed \$\{chips\(required\)\}/);
  });

  it('recomputes the quote when the stake changes', () => {
    expect(panel).toMatch(/const required = requiredSeedForStake\(maxStake\)/);
  });
});

describe('it is wired into the owner menu', () => {
  it('renders on the club settings page', () => {
    expect(settings).toMatch(
      /import SpinActivationPanel from '\.\.\/components\/club\/SpinActivationPanel'/
    );
    expect(settings).toMatch(/<SpinActivationPanel clubId=\{clubId\} canManage=\{isOwner\} \/>/);
  });

  it('only lets the owner manage it', () => {
    expect(settings).toMatch(/canManage=\{isOwner\}/);
  });
});
