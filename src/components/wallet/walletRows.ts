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
 * `standalone` - the club is NOT in a union, so it keeps its own rake and gets
 * a Rake Treasury row. A club inside a union sends its rake to the union's
 * treasury, which is union money and must never appear on a club surface.
 *
 * `chipWallet` - false inside an arena that holds no chips at all. Every row
 * below is a CHIP ledger, so in Diamond Arena there is not a role that may see
 * one: the component's always-on Diamonds row is the whole wallet. This is the
 * server's own `capabilities.chipWallet`, never a guess from the route.
 */
export function clubWalletRows(
  role: unknown,
  opts: { standalone?: boolean; spinsActive?: boolean; chipWallet?: boolean } = {}
): WalletRowKey[] {
  if (opts.chipWallet === false) return [];
  const r = normaliseRole(role);
  const rows: WalletRowKey[] = [];

  // 1. Club Bank
  if (canSeeClubBank(r)) {
    rows.push('club_bank');
  }

  // 2. Promo Wallet
  // 3. Agent Wallet
  if (isAgentRole(r) || canSeeClubBank(r)) {
    rows.push('promo_wallet', 'agent_wallet');
  }

  // 4. Player Wallet
  // Dan 2026-09-02: "ALL CLUB OWNERS AND CO-OWNERS SHOULD HAVE A PLAYER
  // WALLET (ADMIN'S SHOULD NOT). I KNOW WE'VE SAID THEY SHOULDN'T PREVIOUSLY,
  // BUT NOW I'M SEEING THE VALUE IN IT." An admin runs the club's money and
  // never plays out of it; everyone else, owners included, has the one wallet
  // that actually buys into a game.
  if (r !== 'admin') rows.push('player_wallet');

  // And the rest if applicable
  if (canSeeClubBank(r)) {
    if (opts.standalone) {
      rows.push('rake_treasury');
      rows.push('backup_bbj');
    }
    if (opts.standalone && opts.spinsActive) rows.push('spins_wallet');
  }

  return rows;
}

/**
 * Whether the Spins Treasury row has anything to show (2026-09-20).
 *
 * The row used to be gated on `spins.state !== null`. The server's owner-state
 * read never answers null for a club that may ask: a standalone club that has
 * NEVER touched Spins gets a real object back with `is_active: false`,
 * `balance: 0` and `seeded_amount: 0` (20260823160000_spin_wallet_hardening,
 * the NOT FOUND branch). So "state exists" was true for every standalone owner
 * and each of them was shown a Spins Treasury holding zero chips, for a product
 * they had not switched on.
 *
 * A row is a wallet, so it appears when there is a wallet: Spins is running,
 * or the reserve holds chips, or a seed is still outstanding in it. A reserve
 * that is switched off but still funded stays visible - hiding that made real
 * club money vanish from the owner's panel.
 */
export function spinsWalletRowVisible(
  state:
    | {
        is_active?: boolean | null;
        balance?: number | string | null;
        seeded_amount?: number | string | null;
      }
    | null
    | undefined
): boolean {
  if (!state) return false;
  if (state.is_active === true) return true;
  const holds = (value: number | string | null | undefined) => {
    const amount = Number(value ?? 0);
    return Number.isFinite(amount) && amount > 0;
  };
  return holds(state.balance) || holds(state.seeded_amount);
}

/**
 * The club lobby is a glance surface, not the cashier.
 *
 * It deliberately shows at most two club-scoped rows beside the always-on
 * Diamond Wallet tile. Every omitted ledger remains available through the
 * Cashier; this only keeps the lobby header from growing into a financial
 * dashboard on a phone.
 *
 * The visibility law still applies: this function may hide a row that the
 * fuller wallet panel shows, but it must never add one that `clubWalletRows`
 * would withhold from the viewer.
 */
export function clubLobbyWalletRows(
  role: unknown,
  opts: { chipWallet?: boolean } = {}
): WalletRowKey[] {
  if (opts.chipWallet === false) return [];
  const r = normaliseRole(role);

  // Dan 2026-09-02: an owner or co-owner plays out of a player wallet, so the
  // glance surface leads with the bank and the wallet they can sit down with.
  // An admin has no player wallet, so the bank and the agent wallet remain.
  if (r === 'owner' || r === 'co_owner') return ['club_bank', 'player_wallet'];
  if (canSeeClubBank(r)) return ['club_bank', 'agent_wallet'];
  if (isAgentRole(r)) return ['agent_wallet', 'player_wallet'];
  return ['player_wallet'];
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
