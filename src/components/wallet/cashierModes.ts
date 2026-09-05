/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CASHIER MODE LAW (Dan 2026-08-24, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One modal, three wallets, and the rules of each spelled out where a test
 * can pin them rather than buried in JSX conditionals:
 *
 * CLUB BANK — "NEEDS THE ABILITY TO CLAIM BACK, NOT JUST SEND OUT."
 *   Tabs: Send Chips / Claim Back / Transaction Ledger. Sends go out to any
 *   of the three wallets; claims pull FROM any of the three wallets back into
 *   clubs.chip_treasury. Owner, co-owner, admin, super agent only.
 *
 * PROMO WALLET — "NEEDS THE ABILITY TO SEND TO PLAYER WALLETS OR AGENT
 *   WALLETS. IF ITS SENT TO AN AGENT WALLET, IT LANDS IN THEIR PROMO WALLET.
 *   IF IT LANDS IN A PLAYER WALLET, ITS JUST AS GOOD AS CASH."
 *   Tabs: Send Chips / Transaction Ledger. Destinations: player wallet (cash)
 *   or agent wallet (their promo float). Anyone who can hold a promo wallet
 *   may stand here, plus the four bank roles.
 *
 *   TWO ACCOUNTS WEAR THE NAME "PROMO WALLET" ON A CLUB SURFACE (2026-09-05).
 *   The Club Bank roles are looking at the CLUB'S promo pot,
 *   clubs.promo_balance - the account the union's promo wallet pays into and
 *   the BBJ promo slice is swept into. An agent is looking at their OWN float,
 *   agents.promo_wallet_balance. Dan sent 5,000 promo from the Midway Union
 *   to KingFish; it landed in his agent float while the row on the lobby read
 *   the club pot, 0.00, and he reported the chips as missing. `promoSourceFor`
 *   is the one rule that decides which account a viewer stands at, and a bank
 *   role who ALSO holds a float may switch between the two.
 *
 * AGENT WALLET — unchanged: sends to a player wallet only.
 *
 * The server does not trust this file. fn_club_bank_claim_back,
 * fn_promo_wallet_send and fn_club_promo_wallet_send re-check every rule;
 * hiding a button here is a courtesy to the reader, never the security
 * boundary.
 */

import { canSeeClubBank, canHoldAgentWallet } from './walletRows';

export type CashierWalletType = 'club_bank' | 'promo_wallet' | 'agent_wallet';
export type CashierTab = 'send' | 'claim' | 'ledger';
export type CashierDestination = 'agent_wallet' | 'promo_wallet' | 'player_wallet';

/**
 * Which promo account a viewer spends from at the Promo Wallet cashier.
 *   club_pot  - clubs.promo_balance, spent through fn_club_promo_wallet_send
 *   own_float - agents.promo_wallet_balance, spent through fn_promo_wallet_send
 */
export type PromoSource = 'club_pot' | 'own_float';

/**
 * The default promo account for a role. The same rule that decides the Club
 * Bank row decides this (walletRows.canSeeClubBank), so the balance the row
 * shows and the balance the cashier spends are the SAME account.
 */
export function promoSourceFor(role: unknown): PromoSource {
  return canSeeClubBank(role) ? 'club_pot' : 'own_float';
}

/** The RPC that spends a promo source. Pinned so a test can read it. */
export function promoSendRpc(
  source: PromoSource
): 'fn_club_promo_wallet_send' | 'fn_promo_wallet_send' {
  return source === 'club_pot' ? 'fn_club_promo_wallet_send' : 'fn_promo_wallet_send';
}

/** The scope fn_promo_wallet_ledger reads for a promo source. */
export function promoLedgerScope(source: PromoSource): 'club' | 'agent' {
  return source === 'club_pot' ? 'club' : 'agent';
}

/**
 * THE CASHIER NEVER OPENS ON THE CLUB BANK (Dan 2026-08-25, binding).
 *
 * "If they simply just click cashier, this must always default to Agent and
 *  player wallets only... they need to click on the global bank to send from
 *  the global bank."
 *
 * So the wallet a bare cashier entry point opens is the AGENT wallet, for every
 * role including an owner. The Club Bank is reachable only by clicking the Club
 * Bank row, which passes 'club_bank' explicitly. This constant is what every
 * mount point falls back to, and `tests/unit/cashierModes.test.ts` pins that it
 * can never become 'club_bank' again - the four pages each carried their own
 * `activeCashier || 'club_bank'` and a fifth would have copied it.
 */
export const DEFAULT_CASHIER_WALLET: CashierWalletType = 'agent_wallet';

/**
 * Which tabs a cashier offers.
 *
 * The Club Bank keeps its books and claims from anyone. The AGENT wallet gained
 * a Claim Back tab on 2026-08-25 - not the club bank's kind, which picks a
 * member and an amount, but the ten minute mistake eraser: a list of the sends
 * this agent made in the last ten minutes, each undoable in one tap until its
 * window closes. See fn_agent_wallet_claim_back.
 *
 * The promo wallet has no claim: a promo hand-out is not a float that gets
 * reconciled, and fn_promo_wallet_send has no inverse. It DOES have a ledger
 * (Dan 2026-09-05: "MAKE SURE YOU ADD AND HAVE A TRANSACTION LEDGER ATTACHED
 * TO EVERY PROMO WALLET") - fn_promo_wallet_ledger, scoped to the account the
 * viewer is standing at.
 */
export function cashierTabs(walletType: CashierWalletType): CashierTab[] {
  if (walletType === 'club_bank') return ['send', 'claim', 'ledger'];
  if (walletType === 'agent_wallet') return ['send', 'claim'];
  return ['send', 'ledger'];
}

/**
 * Which wallets each cashier can move chips to (send) or from (claim).
 * The claim tab reuses this same list read in the other direction: anything
 * the Club Bank can fund, it can claim back from.
 *
 * The agent wallet funds a player OR a downline agent's own float. Without the
 * second, a super agent could never fund the agents beneath them and the three
 * tier hierarchy had no funding route at all below the club bank.
 */
export function cashierDestinations(walletType: CashierWalletType): CashierDestination[] {
  if (walletType === 'club_bank') return ['agent_wallet', 'promo_wallet', 'player_wallet'];
  if (walletType === 'promo_wallet') return ['player_wallet', 'agent_wallet'];
  return ['player_wallet', 'agent_wallet'];
}

/**
 * Who may stand at each cashier. The Club Bank keeps its four roles; the
 * promo and agent wallet cashiers belong to anyone who can HOLD those
 * wallets — an agent must be able to open their own float — and to the four
 * bank roles, who fund them.
 */
export function canUseCashier(walletType: CashierWalletType, role: unknown): boolean {
  if (walletType === 'club_bank') return canSeeClubBank(role);
  return canHoldAgentWallet(role) || canSeeClubBank(role);
}

/**
 * What each destination MEANS, per cashier. The promo wallet's blurbs are
 * Dan's words nearly verbatim: to a player it is just as good as cash; to an
 * agent it stays promotional money.
 */
export function destinationBlurb(
  walletType: CashierWalletType,
  destination: CashierDestination,
  tab: CashierTab = 'send'
): string {
  if (tab === 'claim') {
    if (walletType === 'agent_wallet') {
      return 'Undo A Send You Made In The Last Ten Minutes. After That The Player Must Request A Cash Out.';
    }
    switch (destination) {
      case 'agent_wallet':
        return 'Pull Chips From An Agent Float Back Into The Club Bank.';
      case 'promo_wallet':
        return 'Pull Unspent Promo Chips Back Into The Club Bank.';
      default:
        return 'Pull Chips From A Member Wallet Back Into The Club Bank.';
    }
  }
  if (walletType === 'promo_wallet') {
    return destination === 'player_wallet'
      ? 'Just As Good As Cash. Spendable In Any Cash Game Or Tournament.'
      : 'Lands In Their Promo Wallet, Held Apart From Their Working Float.';
  }
  if (walletType === 'agent_wallet') {
    return destination === 'player_wallet'
      ? 'Straight Out Of Your Agent Wallet Into Their Playing Balance.'
      : 'Funds A Downline Agent Float So They Can Carry Their Own Players.';
  }
  switch (destination) {
    case 'agent_wallet':
      return 'The Float An Agent Carries For Their Own Players. This Is The Funding Route.';
    case 'promo_wallet':
      return 'Promotional Chips An Agent Hands Out. Held Apart From Their Working Float.';
    default:
      return 'Straight To A Member. The Wallet Buy Ins Come Out Of.';
  }
}

/**
 * A claim always confirms once — taking chips OUT of someone's wallet is
 * never routine. A send confirms only at or above the share-of-bank
 * threshold the caller computes.
 */
export function claimNeedsConfirm(amount: number): boolean {
  return amount > 0;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AGENT TO AGENT ALWAYS CREDITS THE AGENT WALLET — and nothing wider
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, binding: "AGENT TO AGENT SEND OR CLAIM BACK ALWAYS CREDIT TO
 * AGENT WALLETS."
 *
 * fn_agent_wallet_send derives the destination from the recipient's role and
 * ignores what the client asked for, so this is only the half that stops the
 * mistake being OFFERED. It lives here rather than inline in the modal because
 * the version that lived inline applied to EVERY cashier and BOTH tabs, and
 * that quietly broke three things the law does not touch:
 *
 *   - the Club Bank could no longer fund an agent's PROMO wallet;
 *   - the Club Bank could no longer credit a player-wallet balance to someone
 *     who happens to hold a float;
 *   - the Club Bank's Claim Back could only pull from an agent's float, never
 *     from their promo wallet or their playing balance, though
 *     fn_club_bank_claim_back accepts all three.
 *
 * "Agent to agent" is fn_agent_wallet_send. It is not fn_club_bank_send and it
 * is not fn_promo_wallet_send, both of which take an explicit destination the
 * server honours. So: the AGENT wallet, on its SEND tab, to a recipient who
 * holds a float. `recipientHoldsFloat` is canHoldAgentWallet(role) — passed in
 * rather than re-derived, so the caller and this rule cannot disagree.
 */
export function coercesToAgentWallet(
  walletType: CashierWalletType,
  tab: CashierTab,
  recipientHoldsFloat: boolean
): boolean {
  return walletType === 'agent_wallet' && tab === 'send' && recipientHoldsFloat;
}

/**
 * Which cashiers will have a self-send refused by the server.
 *
 * fn_agent_wallet_send and fn_promo_wallet_send both refuse
 * `p_to_user_id = auth.uid()` outright. fn_club_bank_send deliberately does
 * NOT: an owner funding their own agent float out of the treasury is how an
 * owner gets a float at all, and removing themselves from that list would cut
 * the funding route the whole hierarchy hangs off.
 *
 * fn_club_cashier_members returns the caller in its own result for a staff
 * viewer (scope 'all' is every active member), so without this the roster
 * offered the viewer their own name and the send failed on tap.
 */
export function cashierRefusesSelfSend(
  walletType: CashierWalletType,
  promoSource: PromoSource = 'own_float'
): boolean {
  if (walletType === 'club_bank') return false;
  /* The CLUB'S promo pot is club money, and an owner moving it into their own
     promo float is the same funding route the Club Bank keeps open for the
     agent float. fn_club_promo_wallet_send accepts the caller as recipient;
     fn_promo_wallet_send (the agent's own float) still refuses a self-send. */
  if (walletType === 'promo_wallet' && promoSource === 'club_pot') return false;
  return true;
}

/**
 * What the balance header on the Promo Wallet cashier is called. The word
 * "Club" is the whole difference between the two accounts, so it is never
 * dropped for the pot.
 */
export function promoBalanceLabel(source: PromoSource): string {
  return source === 'club_pot' ? 'Club Promo Wallet Balance' : 'Your Promo Float';
}

/** The sentence under the source switch, in the viewer's terms. */
export function promoSourceBlurb(source: PromoSource): string {
  return source === 'club_pot'
    ? 'The Club Promo Wallet. Funded By The Union Promo Wallet And The Jackpot Promo Slice. Spent By Club Staff.'
    : 'Your Own Promo Float. Promo Chips Sent To You As An Agent, To Hand Out To Your Players.';
}

/**
 * THE TEN MINUTE COUNTDOWN IS THE SERVER'S, NOT THE PHONE'S.
 *
 * `fn_agent_wallet_reversible` returns `seconds_left` alongside
 * `reversible_until`, and both cashier surfaces ignored it: each subtracted
 * `Date.now()` from `reversible_until`, which is the browser wall clock.
 * A device ten minutes fast showed "nothing is claimable" with live sends on
 * the list; ten minutes slow offered every expired row and each tap collected a
 * refusal from fn_agent_wallet_claim_back.
 *
 * So the deadline is anchored ONCE at fetch time and only locally measured
 * elapsed time is taken off it. Callers pass elapsed milliseconds measured with
 * performance.now(), which is monotonic — unaffected by a wrong clock, an NTP
 * correction or a daylight saving jump. The database still has the final word
 * on every claim; this only decides what to OFFER.
 */
export function secondsLeftFromServer(serverSecondsLeft: unknown, elapsedMs: number): number {
  const start = Number(serverSecondsLeft);
  if (!Number.isFinite(start) || start <= 0) return 0;
  const elapsed = Math.floor(Math.max(0, elapsedMs) / 1000);
  return Math.max(0, start - elapsed);
}
