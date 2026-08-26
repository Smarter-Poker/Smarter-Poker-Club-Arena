/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WALLET VISIBILITY LAW (Dan 2026-08-23, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "THE SAME DYNAMIC WALLET FUNCTIONALITY MUST EXIST FOR ALL ROLE TYPES.
 *  PLAYERS ONLY SEE A DIAMOND WALLET AND PLAYER WALLET. SUB AGENTS SEE
 *  DIAMOND WALLET, PLAYER WALLET, AGENT WALLET AND PROMO WALLET (NEVER CLUB
 *  BANK). AGENTS [the same]. SUPER AGENTS, ADMINS, CO-OWNERS AND OWNERS SEE
 *  DIAMOND WALLET, PLAYER WALLET, AGENT WALLET, PROMO WALLET AND CLUB BANK
 *  (RAKE TREASURY IF THEY ARE A STAND ALONE CLUB)."
 *
 * Kept OUT of the component on purpose. This is the rule that decides whether
 * a person can see the club's money, and a rule of that weight should be
 * readable in twenty lines and testable without mounting a component with six
 * realtime subscriptions attached to it. `tests/unit/walletRows.test.ts` pins
 * every role.
 *
 * NOT SEEING IS THE DEFAULT. An unrecognised role normalises to 'player' via
 * normaliseRole, which is the safe direction to be wrong in: a player shown
 * one row too few asks a question, an agent shown the club bank spends it.
 *
 * The server does not trust this file. fn_can_use_club_bank enforces the same
 * four roles for every read and every send, so hiding a row is a courtesy to
 * the reader, never the security boundary.
 */

import { normaliseRole, isAgentRole, type ClubRole } from '../../types/clubRoles';

export type WalletRowKey =
  | 'player_wallet'
  | 'agent_wallet'
  | 'promo_wallet'
  | 'club_bank'
  | 'rake_treasury'
  | 'spins_wallet'
  | 'backup_bbj';

/** The four roles that may see, open and spend from the Club Bank. */
export const CLUB_BANK_ROLES: ClubRole[] = ['owner', 'co_owner', 'admin', 'super_agent'];

export function canSeeClubBank(role: unknown): boolean {
  return CLUB_BANK_ROLES.includes(normaliseRole(role));
}

/**
 * Who holds an Agent Wallet and a Promo Wallet, and can therefore be the
 * recipient of a Club Bank send into one.
 *
 * Mirrors the check inside fn_club_bank_send, which refuses any other role
 * outright. Kept here so the cashier's recipient list and the server's refusal
 * cannot drift apart - a list that offers someone the server will reject is a
 * dead end the user cannot diagnose.
 *
 * Deliberately NOT the same set as canSeeClubBank. An owner may spend from the
 * bank without holding an agent float; an agent holds the float without ever
 * seeing the bank.
 */
export function canHoldAgentWallet(role: unknown): boolean {
  const r = normaliseRole(role);
  return isAgentRole(r) || canSeeClubBank(r);
}

/**
 * Which rows a club-scoped wallet shows, in display order. The Diamonds row is
 * not listed: every role has one and the component renders it unconditionally
 * above these.
 *
 * `standalone` — the club is NOT in a union, so it keeps its own rake and gets
 * a Rake Treasury row. A club inside a union sends its rake to the union's
 * treasury, which is union money and must never appear on a club surface.
 */
export function clubWalletRows(
  role: unknown,
  opts: { standalone?: boolean; spinsActive?: boolean } = {}
): WalletRowKey[] {
  const r = normaliseRole(role);
  const rows: WalletRowKey[] = ['player_wallet'];

  // An agent wallet is the float an agent carries for their downline. Staff
  // hold one too - they can be handed chips the same way anyone else can.
  if (isAgentRole(r) || canSeeClubBank(r)) {
    rows.push('agent_wallet', 'promo_wallet');
  }

  if (canSeeClubBank(r)) {
    rows.push('club_bank');
    if (opts.standalone) {
      rows.push('rake_treasury');
      rows.push('backup_bbj');
    }
    /**
     * The Spins wallet, under exactly the law above.
     *
     * Dan 2026-08-23: "ADD THE SPINS WALLET TO THE UNION, AND CLUBS WHEN THEY
     * ENABLE SPINS. IF A CLUB JOINS A UNION, THAT WALLET MUST DISAPPEAR."
     *
     * `standalone` is doing the disappearing. A club inside a union does not
     * have a Spins wallet -- fn_spin_reserve_owner resolves the pool to the
     * UNION -- so showing one on a club surface would be showing union money
     * in the club's own wallet, the same mistake rake_treasury guards against.
     * The database enforces the other half: joining a union empties and
     * switches off the club's pool row in the same transaction as the join.
     *
     * `spinsActive` keeps it off the panel of a club that never turned Spins
     * on, rather than parking a permanent 0.00 next to real balances.
     */
    if (opts.standalone && opts.spinsActive) rows.push('spins_wallet');
  }

  return rows;
}

/**
 * Chip minting law (Dan 2026-08-21, restated 2026-08-23):
 * "THE ABILITY TO MINT CHIPS MUST DISAPPEAR ONCE THEY ARE A PART OF A UNION.
 *  IF IT IS A STAND ALONE CLUB, CHIP MINTING EXISTS INSIDE THEIR CLUB BANK."
 *
 * So: standalone club + owner, co-owner or admin. There is no longer any mint
 * entry point on the wallet panel itself - it lives one level in, inside the
 * Club Bank Cashier, which is the account it credits.
 *
 * NOT super_agent. A super agent may stand at the Club Bank and move what is
 * already in it, but fn_mint_chips_from_diamonds admits only the owner, a
 * co-owner or an admin - minting is creating money, which is a different
 * authority from spending it. Offering the tab to a super agent would show a
 * button that can only ever be refused by the server.
 */
export function canMintInClubBank(role: unknown, opts: { standalone?: boolean } = {}): boolean {
  if (!opts.standalone) return false;
  const r = normaliseRole(role);
  return r === 'owner' || r === 'co_owner' || r === 'admin';
}
