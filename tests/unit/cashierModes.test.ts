/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CASHIER MODE LAW — pinned (Dan 2026-08-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "CLUB BANK NEEDS THE ABILITY TO CLAIM BACK, NOT JUST SEND OUT."
 * "PROMO WALLET NEEDS THE ABILITY TO SEND TO PLAYER WALLETS OR AGENT WALLETS.
 *  IF ITS SENT TO AN AGENT WALLET, IT LANDS IN THEIR PROMO WALLET. IF IT
 *  LANDS IN A PLAYER WALLET, ITS JUST AS GOOD AS CASH."
 *
 * These tests pin the mode rules in cashierModes.ts. If a refactor drops the
 * Claim Back tab, offers the promo wallet a destination it must not have, or
 * lets a player open a cashier, a test goes red before a deploy goes out.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cashierTabs,
  cashierDestinations,
  canUseCashier,
  destinationBlurb,
  claimNeedsConfirm,
  DEFAULT_CASHIER_WALLET,
  type CashierWalletType,
} from '../../src/components/wallet/cashierModes';
import { CLUB_ROLES } from '../../src/types/clubRoles';

/**
 * ── THE CASHIER NEVER OPENS ON THE CLUB BANK (Dan 2026-08-25, binding) ──────
 *
 * "If they simply just click cashier, this must always default to Agent and
 *  player wallets only... they need to click on the global bank to send from
 *  the global bank."
 *
 * Two things have to hold, and only one of them is a function call. The other
 * is that none of the four mount points reintroduces its own fallback: each
 * page used to spell `activeCashier || 'club_bank'` out by hand, so the default
 * lived in five places and a fifth page would have copied it.
 */
describe('the default wallet', () => {
  it('is the agent wallet, and is not the club bank', () => {
    expect(DEFAULT_CASHIER_WALLET).toBe('agent_wallet');
    expect(DEFAULT_CASHIER_WALLET).not.toBe('club_bank');
  });

  it('is never the club bank for any role, because it does not depend on role', () => {
    for (const role of CLUB_ROLES) {
      const opened: CashierWalletType = DEFAULT_CASHIER_WALLET;
      expect(opened).not.toBe('club_bank');
      // And a role that may not stand at the club bank must still not be able
      // to use it even if something hands it that wallet type explicitly.
      if (!['owner', 'co_owner', 'admin', 'super_agent'].includes(role)) {
        expect(canUseCashier('club_bank', role)).toBe(false);
      }
    }
  });

  it('no page hardcodes club_bank as the cashier fallback any more', () => {
    const root = join(__dirname, '../../src/pages');
    for (const page of [
      'ClubHomePage.tsx',
      'CashierPage.tsx',
      'ClubFinancialsPage.tsx',
      'CashierTradePage.tsx',
    ]) {
      const src = readFileSync(join(root, page), 'utf8');
      expect(src).not.toContain("activeCashier || 'club_bank'");
      expect(src).toContain('activeCashier || DEFAULT_CASHIER_WALLET');
    }
  });
});

describe('cashierTabs', () => {
  it('gives the club bank all three tabs, claim back included', () => {
    expect(cashierTabs('club_bank')).toEqual(['send', 'claim', 'ledger']);
  });

  it('gives the agent wallet a claim back tab, for the ten minute window', () => {
    expect(cashierTabs('agent_wallet')).toEqual(['send', 'claim']);
  });

  it('gives the promo wallet a send tab only, because a promo has no inverse', () => {
    expect(cashierTabs('promo_wallet')).toEqual(['send']);
  });
});

describe('cashierDestinations', () => {
  it('club bank reaches all three wallets, in the funding-first order', () => {
    expect(cashierDestinations('club_bank')).toEqual([
      'agent_wallet',
      'promo_wallet',
      'player_wallet',
    ]);
  });

  it('promo wallet sends to player wallets or agent wallets, nothing else', () => {
    expect(cashierDestinations('promo_wallet')).toEqual(['player_wallet', 'agent_wallet']);
  });

  /**
   * CHANGED 2026-08-25, in the commit that implemented it. The agent wallet
   * could only reach a player wallet, which left a super agent with no way at
   * all to fund the agents beneath them: the three tier hierarchy had exactly
   * one funding route, and it was the club bank.
   */
  it('agent wallet funds a player, or a downline agents own float', () => {
    expect(cashierDestinations('agent_wallet')).toEqual(['player_wallet', 'agent_wallet']);
  });
});

describe('canUseCashier', () => {
  const bankRoles = ['owner', 'co_owner', 'admin', 'super_agent'];
  const agentRoles = ['agent', 'sub_agent', 'super_agent'];

  it('club bank admits exactly the four bank roles', () => {
    for (const r of bankRoles) expect(canUseCashier('club_bank', r)).toBe(true);
    for (const r of ['agent', 'sub_agent', 'player', 'manager', undefined, null, 'nonsense']) {
      expect(canUseCashier('club_bank', r)).toBe(false);
    }
  });

  it('promo wallet admits agents and the bank roles, never a player', () => {
    for (const r of [...bankRoles, ...agentRoles]) {
      expect(canUseCashier('promo_wallet', r)).toBe(true);
    }
    expect(canUseCashier('promo_wallet', 'player')).toBe(false);
    expect(canUseCashier('promo_wallet', undefined)).toBe(false);
  });

  it('agent wallet admits the same set as the promo wallet', () => {
    for (const r of [...bankRoles, ...agentRoles]) {
      expect(canUseCashier('agent_wallet', r)).toBe(true);
    }
    expect(canUseCashier('agent_wallet', 'player')).toBe(false);
  });

  it('an unrecognised role normalises toward not seeing, the safe direction', () => {
    expect(canUseCashier('club_bank', 'chief_vibes_officer')).toBe(false);
    expect(canUseCashier('promo_wallet', 'chief_vibes_officer')).toBe(false);
  });
});

describe('destinationBlurb', () => {
  it('promo chips to a player wallet read as cash, spendable anywhere', () => {
    const blurb = destinationBlurb('promo_wallet', 'player_wallet');
    expect(blurb).toContain('Cash');
    expect(blurb).toContain('Tournament');
  });

  it('promo chips to an agent land in their promo wallet', () => {
    expect(destinationBlurb('promo_wallet', 'agent_wallet')).toContain('Their Promo Wallet');
  });

  it('claim blurbs describe pulling chips back into the club bank', () => {
    for (const d of ['agent_wallet', 'promo_wallet', 'player_wallet'] as const) {
      expect(destinationBlurb('club_bank', d, 'claim')).toContain('Back Into The Club Bank');
    }
  });

  it('the agent claim blurb says the window and what happens after it', () => {
    const blurb = destinationBlurb('agent_wallet', 'player_wallet', 'claim');
    expect(blurb).toContain('Ten Minutes');
    expect(blurb).toContain('Cash Out');
  });

  it('no blurb uses an em dash, and every word is capitalised', () => {
    const wallets = ['club_bank', 'promo_wallet', 'agent_wallet'] as const;
    const dests = ['agent_wallet', 'promo_wallet', 'player_wallet'] as const;
    for (const w of wallets) {
      for (const d of dests) {
        for (const tab of ['send', 'claim'] as const) {
          const blurb = destinationBlurb(w, d, tab);
          expect(blurb).not.toMatch(/[–—]/);
          for (const word of blurb.split(/\s+/).filter(Boolean)) {
            if (/^[a-z]/.test(word)) {
              throw new Error(`"${blurb}" has an uncapitalised word: ${word}`);
            }
          }
        }
      }
    }
  });
});

describe('claimNeedsConfirm', () => {
  it('every real claim confirms once — taking chips out is never routine', () => {
    expect(claimNeedsConfirm(1)).toBe(true);
    expect(claimNeedsConfirm(1_000_000)).toBe(true);
  });

  it('a zero or empty amount has nothing to confirm', () => {
    expect(claimNeedsConfirm(0)).toBe(false);
  });
});
