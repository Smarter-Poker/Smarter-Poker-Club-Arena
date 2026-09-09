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

/**
 * Comments stripped. Every `not.toMatch` below reads THIS, not the raw file:
 * three separate assertions this session have failed on their own explanation,
 * because the comment describing what was removed necessarily names it.
 */
const panelCode = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

  it('obeys the ROUTE on who may act, and nothing else', () => {
    // Two corrections, in order.
    //
    // First it inferred permission from owner_kind, which was wrong in BOTH
    // directions: it hid the off switch from the union lead and offered
    // activation to a club owner inside a union.
    //
    // Then it ANDed the route's answer with the PAGE's guess
    // (ClubSettingsPage passes its own isOwner) -- and that AND was the same
    // bug again, because a union lead who is not the club owner has
    // isOwner === false. The route knows about union_admins and
    // clubs.owner_id; the page knows about neither.
    expect(panelCode).toMatch(/const canAct = routeCanManage === true;/);
    expect(panelCode).not.toMatch(/canManage && routeCanManage/);
    expect(panelCode).not.toMatch(/canManage && !isUnionOwned/);
  });

  it('does not take a permission prop at all, so a page cannot override truth', () => {
    expect(panelCode).not.toMatch(/canManage: boolean;/);
    expect(settings).toMatch(/<SpinActivationPanel clubId=\{clubId\} \/>/);
  });

  it('fails closed while the route has not answered yet', () => {
    expect(panel).toMatch(/useState<boolean \| null>\(null\)/);
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

  it('shows the repayment PLAN, not a single distant date', () => {
    // Was `Returns After Another N Is Collected From Play` - an all-or-nothing
    // rule that, on a zero-drift pool, described an event that might never
    // arrive. It is instalments now: a share of the surplus each time the
    // wallet clears its trigger.
    expect(panel).toMatch(/seed_repayable_in/);
    expect(panel).toMatch(/Repayment Plan/);
    expect(panel).toMatch(/Next Instalment/);
  });

  it('says what happens to proceeds once the seed is repaid', () => {
    expect(panel).toMatch(/Stays Here To Fund Multipliers/);
  });

  it('quotes what will actually be charged on the button, before the click', () => {
    // Was `chips(required)`. An outstanding seed now counts toward the bar, so
    // quoting the gross would promise a bill that never arrives.
    expect(panel).toMatch(/Activate Spins And Seed \$\{chips\(stillNeeded\)\}/);
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
    expect(settings).toMatch(/<SpinActivationPanel clubId=\{clubId\} \/>/);
  });

  it('is also on the UNION dashboard -- the half that was missing', () => {
    // A union OWNS the Spin wallet for every club inside it, so its lead had
    // nowhere to switch Spins on unless they happened to also own a club.
    const union = read('src/pages/UnionDashboardPage.tsx');
    expect(union).toMatch(/import SpinActivationPanel from/);
    expect(union).toMatch(/<SpinActivationPanel clubId=\{unionId\} \/>/);
  });
});

describe('the seed is quoted net of what is already in the wallet', () => {
  it('charges only the shortfall', () => {
    expect(panel).toMatch(
      /const stillNeeded = Math\.max\(required - Number\(state\?\.seeded_amount \?\? 0\), 0\)/
    );
    /* The call now also carries the caller's idempotency key (2026-09-09):
       activation seeds a pool out of a real wallet and the transport used to
       mint a fresh key inline on every request, so a committed activation
       whose response was lost seeded it again. Arguments, in order, with the
       key allowed to follow. */
    expect(panel).toMatch(
      /spinActivationApi\.activate\(\s*clubId,\s*stillNeeded,\s*maxStake,\s*wallet[,)]/
    );
    expect(panel).toMatch(/activateKeyRef\.current\.key/);
  });

  it('quotes that number on the button, not the gross', () => {
    expect(panel).toMatch(/Activate Spins And Seed \$\{chips\(stillNeeded\)\}/);
    expect(panelCode).not.toMatch(/Activate Spins And Seed \$\{chips\(required\)\}/);
  });

  it('shows an outstanding seed while Spins are OFF -- when the owner is deciding', () => {
    // It used to render only inside the is_active branch, so a deactivated
    // owner saw a full fresh bill and no sign of the money already sitting
    // there.
    expect(panel).toMatch(/\{!state\.is_active && state\.seeded_amount > 0 && \(/);
  });

  it('admits when a seed can never be returned', () => {
    expect(panel).toMatch(/seed_is_repayable/);
    expect(panel).toMatch(/No Recorded Source Wallet/);
  });
});
