/**
 * WALLET VISIBILITY LAW (Dan 2026-08-23, binding).
 *
 * "PLAYERS ONLY SEE A DIAMOND WALLET AND PLAYER WALLET. SUB AGENTS SEE DIAMOND
 *  WALLET, PLAYER WALLET, AGENT WALLET AND PROMO WALLET (NEVER CLUB BANK).
 *  AGENTS [the same]. SUPER AGENTS, ADMINS, CO-OWNERS AND OWNERS SEE ... AND
 *  CLUB BANK (RAKE TREASURY IF THEY ARE A STAND ALONE CLUB)."
 *
 * Every one of the seven roles is pinned in both directions: what it sees, and
 * what it must NEVER see. The Club Bank case is the one that matters — an
 * agent who can see the club's operating balance is one edit away from an
 * agent who can spend it.
 */
import { describe, it, expect } from 'vitest';
import {
  clubLobbyWalletRows,
  clubWalletRows,
  canSeeClubBank,
  canMintInClubBank,
  canHoldAgentWallet,
  CLUB_BANK_ROLES,
} from '../../src/components/wallet/walletRows';
import { CLUB_ROLES } from '../../src/types/clubRoles';

const BANK_ROLES = ['owner', 'co_owner', 'admin', 'super_agent'] as const;
const NON_BANK_ROLES = ['agent', 'sub_agent', 'player'] as const;

describe('who may see the Club Bank', () => {
  it('admits exactly owner, co_owner, admin and super_agent', () => {
    expect([...CLUB_BANK_ROLES].sort()).toEqual([...BANK_ROLES].sort());
    for (const r of BANK_ROLES) expect(canSeeClubBank(r)).toBe(true);
    for (const r of NON_BANK_ROLES) expect(canSeeClubBank(r)).toBe(false);
  });

  it('refuses anything it does not recognise', () => {
    // normaliseRole maps 'manager', 'member', 'guest' and junk onto 'player'.
    for (const junk of ['manager', 'member', 'guest', '', 'OWNER', null, undefined, 7]) {
      expect(canSeeClubBank(junk)).toBe(false);
    }
  });

  it('covers every declared role, so a new one cannot slip in unclassified', () => {
    for (const r of CLUB_ROLES) {
      expect(typeof canSeeClubBank(r)).toBe('boolean');
    }
  });
});

describe('club wallet rows by role', () => {
  it('a player sees only their own player wallet', () => {
    expect(clubWalletRows('player')).toEqual(['player_wallet']);
    expect(clubWalletRows('player', { standalone: true })).toEqual(['player_wallet']);
  });

  it('sub agents and agents add an agent wallet and a promo wallet, never the bank', () => {
    for (const r of ['sub_agent', 'agent'] as const) {
      expect(clubWalletRows(r)).toEqual(['promo_wallet', 'agent_wallet', 'player_wallet']);
      // Standalone makes no difference: no bank means no rake treasury either.
      expect(clubWalletRows(r, { standalone: true })).toEqual([
        'promo_wallet',
        'agent_wallet',
        'player_wallet',
      ]);
    }
  });

  it('the four bank roles add the Club Bank, in a union', () => {
    for (const r of BANK_ROLES) {
      expect(clubWalletRows(r, { standalone: false })).toEqual([
        'club_bank',
        'promo_wallet',
        'agent_wallet',
        'player_wallet',
      ]);
    }
  });

  it('a STANDALONE club also shows its own Rake Treasury', () => {
    for (const r of BANK_ROLES) {
      expect(clubWalletRows(r, { standalone: true })).toEqual([
        'club_bank',
        'promo_wallet',
        'agent_wallet',
        'player_wallet',
        'rake_treasury',
        'backup_bbj',
      ]);
    }
  });

  it('shows spins_wallet only for standalone clubs with spins active', () => {
    for (const r of BANK_ROLES) {
      expect(clubWalletRows(r, { standalone: true, spinsActive: true })).toContain('spins_wallet');
      expect(clubWalletRows(r, { standalone: true, spinsActive: false })).not.toContain(
        'spins_wallet'
      );
      expect(clubWalletRows(r, { standalone: false, spinsActive: true })).not.toContain(
        'spins_wallet'
      );
    }
  });

  it('REGRESSION: no non-bank role ever receives club_bank or rake_treasury', () => {
    for (const r of NON_BANK_ROLES) {
      for (const standalone of [true, false]) {
        const rows = clubWalletRows(r, { standalone });
        expect(rows).not.toContain('club_bank');
        expect(rows).not.toContain('rake_treasury');
      }
    }
  });
});

describe('compact lobby wallet rows by role', () => {
  it('keeps a player lobby to Diamond plus Player Wallet', () => {
    expect(clubLobbyWalletRows('player')).toEqual(['player_wallet']);
  });

  it.each(['agent', 'sub_agent'] as const)(
    'shows %s the Agent and Player wallets beneath Diamonds',
    (role) => {
      expect(clubLobbyWalletRows(role)).toEqual(['agent_wallet', 'player_wallet']);
    }
  );

  it.each(['owner', 'co_owner', 'admin', 'super_agent'] as const)(
    'shows %s the Club Bank and Agent Wallet beneath Diamonds',
    (role) => {
      expect(clubLobbyWalletRows(role)).toEqual(['club_bank', 'agent_wallet']);
    }
  );

  it('fails closed for an unknown role', () => {
    expect(clubLobbyWalletRows('legacy_member')).toEqual(['player_wallet']);
  });
});

describe('who can receive a Club Bank send into an agent wallet', () => {
  /**
   * The Club Bank Cashier filters its recipient list with this, and
   * fn_club_bank_send refuses anything else. If the two disagree, the cashier
   * offers a recipient the server will reject and the user gets a refusal with
   * no way to work out why.
   */
  it('is the agent roles and staff roles', () => {
    for (const r of ['owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent'] as const) {
      expect(canHoldAgentWallet(r)).toBe(true);
    }
    for (const r of ['player'] as const) {
      expect(canHoldAgentWallet(r)).toBe(false);
    }
  });

  it('refuses junk, like every other gate here', () => {
    for (const junk of ['manager', 'member', '', null, undefined, 7]) {
      expect(canHoldAgentWallet(junk)).toBe(false);
    }
  });
});

describe('chip minting', () => {
  it('is revoked for every role once the club is in a union', () => {
    for (const r of CLUB_ROLES) {
      expect(canMintInClubBank(r, { standalone: false })).toBe(false);
      expect(canMintInClubBank(r)).toBe(false);
    }
  });

  it('is owner, co_owner or admin on a standalone club - matching the RPC', () => {
    expect(canMintInClubBank('owner', { standalone: true })).toBe(true);
    expect(canMintInClubBank('co_owner', { standalone: true })).toBe(true);
    expect(canMintInClubBank('admin', { standalone: true })).toBe(true);
  });

  it('excludes super_agent: standing at the bank is not authority to create money', () => {
    expect(canSeeClubBank('super_agent')).toBe(true);
    expect(canMintInClubBank('super_agent', { standalone: true })).toBe(false);
  });

  it('excludes agents, sub agents and players outright', () => {
    for (const r of ['agent', 'sub_agent', 'player'] as const) {
      expect(canMintInClubBank(r, { standalone: true })).toBe(false);
    }
  });
});
