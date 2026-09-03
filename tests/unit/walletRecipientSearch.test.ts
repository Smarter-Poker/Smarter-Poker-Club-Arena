import { describe, it, expect } from 'vitest';
import { canHoldAgentWallet, canSeeClubBank } from '../../src/components/wallet/walletRows';
import { CLUB_ROLES } from '../../src/types/clubRoles';

describe('Wallet Recipient Search & Self Transfer Law', () => {
  it('allows staff and agent roles to hold agent/promo wallets', () => {
    const eligibleRoles = ['owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent'];
    for (const r of eligibleRoles) {
      expect(canHoldAgentWallet(r)).toBe(true);
    }
    expect(canHoldAgentWallet('player')).toBe(false);
  });

  it('allows owners, co-owners, admins, and super-agents to see and spend from club bank', () => {
    const bankRoles = ['owner', 'co_owner', 'admin', 'super_agent'];
    for (const r of bankRoles) {
      expect(canSeeClubBank(r)).toBe(true);
    }
    for (const r of ['agent', 'sub_agent', 'player']) {
      expect(canSeeClubBank(r)).toBe(false);
    }
  });

  it('ensures all declared roles are classified', () => {
    for (const r of CLUB_ROLES) {
      expect(typeof canHoldAgentWallet(r)).toBe('boolean');
      expect(typeof canSeeClubBank(r)).toBe('boolean');
    }
  });
});
