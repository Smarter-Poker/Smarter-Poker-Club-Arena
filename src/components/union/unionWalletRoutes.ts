/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHERE A UNION WALLET SEND TO A CLUB GOES (Dan 2026-09-05, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure rules, no client, so tests/union-promo-goes-to-the-promo-wallet
 * .law.test.ts can pin them without rendering the modal.
 *
 * On 2026-09-05 02:51 UTC Dan opened the union Promo Wallet, picked two clubs
 * and sent 5,000 to each. Every club target went through
 * `unionApi.sendToClub` (fn_union_send_to_club_atomic), which only knows one
 * route: union BANK -> club BANK. The promo wallet never moved, and both club
 * Promo Wallets read 0.00. So a club target is routed HERE, by the wallet that
 * is open and the kind that is picked, and a route that does not exist is a
 * sentence on screen, never a silent substitution.
 */

export type UnionWalletKey = 'chips' | 'rake' | 'bbj' | 'promo' | 'spin_reserve';
export type UnionSendKind = 'chips' | 'diamonds' | 'promo';

/** The union_wallets column each wallet key reads and journals under. */
export const UNION_WALLET_COLUMN: Record<UnionWalletKey, string> = {
  chips: 'chip_balance',
  rake: 'rake_wallet',
  bbj: 'bbj_wallet',
  promo: 'promo_wallet',
  spin_reserve: 'spin_reserve_wallet',
};

export type ClubSendRoute =
  | { kind: 'promo' }
  | { kind: 'bank' }
  | { kind: 'refused'; reason: string };

/**
 *   promo wallet, or Promo kind  -> 'promo'   unionApi.promoSend(..., 'club')
 *                                             union promo wallet -> club Promo Wallet
 *   union bank / BBJ, Chips kind -> 'bank'    unionApi.sendToClub
 *                                             union bank -> Club Bank
 *   rake wallet                  -> refused   the Rake Treasury is held IN TRUST
 *                                             for the member clubs until the
 *                                             weekly close (20260820b_rake_only_to
 *                                             _treasury, 20260903161443_the_weekly
 *                                             _union_close_pays_from_the_rake
 *                                             _treasury_and_only_from_it;
 *                                             fn_union_move_rake_to_chips_atomic is
 *                                             retired for the same reason). A
 *                                             manual rake -> club send would spend
 *                                             money that belongs to the clubs, so
 *                                             it is not built, and the old code's
 *                                             silent draw on the bank is gone
 *   diamonds                     -> refused   a club has no diamond wallet
 */
export function clubSendRoute(walletKey: UnionWalletKey, kind: UnionSendKind): ClubSendRoute {
  if (kind === 'diamonds') {
    return { kind: 'refused', reason: 'Diamonds Go To A Member, Not A Club.' };
  }
  if (walletKey === 'promo' || kind === 'promo') return { kind: 'promo' };
  if (walletKey === 'rake') {
    return {
      kind: 'refused',
      reason:
        'The Rake Treasury Is Held In Trust For The Clubs Until The Weekly Close. To Fund A Club Bank Now, Open The Union Bank.',
    };
  }
  if (walletKey === 'spin_reserve') {
    return { kind: 'refused', reason: 'The Spin Reserve Is Not A Send Source.' };
  }
  return { kind: 'bank' };
}
