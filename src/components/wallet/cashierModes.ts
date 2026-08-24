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
 *   Tabs: Send Chips. Destinations: player wallet (cash) or agent wallet
 *   (their promo float). Anyone who can hold a promo wallet may stand here,
 *   plus the four bank roles.
 *
 * AGENT WALLET — unchanged: sends to a player wallet only.
 *
 * The server does not trust this file. fn_club_bank_claim_back and
 * fn_promo_wallet_send re-check every rule; hiding a button here is a
 * courtesy to the reader, never the security boundary.
 */

import { canSeeClubBank, canHoldAgentWallet } from './walletRows';

export type CashierWalletType = 'club_bank' | 'promo_wallet' | 'agent_wallet';
export type CashierTab = 'send' | 'claim' | 'ledger';
export type CashierDestination = 'agent_wallet' | 'promo_wallet' | 'player_wallet';

/** Which tabs a cashier offers. Only the Club Bank claims back or keeps books. */
export function cashierTabs(walletType: CashierWalletType): CashierTab[] {
  return walletType === 'club_bank' ? ['send', 'claim', 'ledger'] : ['send'];
}

/**
 * Which wallets each cashier can move chips to (send) or from (claim).
 * The claim tab reuses this same list read in the other direction: anything
 * the Club Bank can fund, it can claim back from.
 */
export function cashierDestinations(walletType: CashierWalletType): CashierDestination[] {
  if (walletType === 'club_bank') return ['agent_wallet', 'promo_wallet', 'player_wallet'];
  if (walletType === 'promo_wallet') return ['player_wallet', 'agent_wallet'];
  return ['player_wallet'];
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
