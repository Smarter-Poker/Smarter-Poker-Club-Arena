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
import {
  cashierTabs,
  cashierDestinations,
  canUseCashier,
  destinationBlurb,
  claimNeedsConfirm,
} from '../../src/components/wallet/cashierModes';

describe('cashierTabs', () => {
  it('gives the club bank all three tabs, claim back included', () => {
    expect(cashierTabs('club_bank')).toEqual(['send', 'claim', 'ledger']);
  });

  it('gives the promo and agent wallets a send tab only', () => {
    expect(cashierTabs('promo_wallet')).toEqual(['send']);
    expect(cashierTabs('agent_wallet')).toEqual(['send']);
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

  it('agent wallet still sends to a player wallet only', () => {
    expect(cashierDestinations('agent_wallet')).toEqual(['player_wallet']);
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
