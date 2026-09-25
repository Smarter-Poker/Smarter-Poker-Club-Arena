/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE MARKETPLACE: the Club Arena marketplace IS the World Hub marketplace
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-21: "CLUB ARENA MARKETPLACE, SHOULD BE THE EXACT SAME PAGES AS
 * THE MARKETPLACE THAT EXISTS IN THE WORLD HUB."
 *
 * The World Hub owns one storefront with one address per view (a single
 * implementation, pages/hub/diamond-store.js, behind thin route wrappers):
 *
 *   /hub/marketplace       308 to /hub/diamond-store
 *   /hub/diamond-store     Diamonds
 *   /hub/vip-membership    VIP Membership
 *   /hub/merch-store       Merch
 *   /hub/smarter-rewards   Smarter Rewards
 *   /hub/club-shop         Club Shop (Store, My Purchases, Manage) ?clubId=<uuid>
 *
 * Club Arena had grown a second storefront at /marketplace that sold the same
 * things through the same APIs and looked nothing like it. This module maps
 * every Club Arena marketplace address onto the World Hub page that shows the
 * same thing, so `MarketplaceRoute` can hand the player straight to it:
 *
 *   ?tab=diamonds                  -> /hub/diamond-store
 *   ?tab=membership                -> /hub/vip-membership
 *   ?tab=store                     -> /hub/club-shop[?clubId=<uuid>]
 *   ?tab=my_items                  -> /hub/club-shop[?clubId=<uuid>]&view=my-purchases
 *   ?tab=manage                    -> /hub/club-shop[?clubId=<uuid>]&view=manage
 *   no tab, with a club            -> /hub/club-shop?clubId=<uuid>
 *   no tab, no club                -> /hub/diamond-store (= /hub/marketplace)
 *
 * Two kinds of address keep the in-app storefront (MarketplacePage), on purpose:
 *
 *   - A CARD CHECKOUT RETURN (?purchase=, ?session_id=, ?checkout_request_id=).
 *     Every Club Arena card checkout, the in-table Diamond top-up included,
 *     returns to /marketplace, and that page is the one that verifies the
 *     Stripe session against this browser's durable purchase intent, retires
 *     the intent, and offers the way back to the table. The Hub page reads a
 *     different return shape and knows nothing of that intent.
 *   - A TOP-UP THAT OWES THE PLAYER A WAY BACK (?next=<in-app path>). The
 *     wallet sends a player who is short of the cheapest Diamond Arena seat to
 *     `?tab=diamonds&next=/clubs/diamond-arena`; the storefront carries that
 *     through the checkout and offers "Continue To The Diamond Arena" on the
 *     way back. Nothing on the Hub carries a Club Arena continuation.
 *
 * The native app keeps the storefront for every address: Apple 3.1.1 and
 * Play's Payments policy put diamonds and VIP through StoreKit / Play Billing,
 * which only marketplaceShared.startCheckout speaks.
 *
 * Pure: no DOM, no network. `MarketplaceRoute` resolves a slug or 6-digit club
 * code to its UUID first; anything that is still not a UUID is dropped rather
 * than handed to a page that would refuse it.
 */

import { IS_NATIVE_BUILD, isNativePlatform } from '../lib/appBase';
import { safeInAppRedirect } from '../lib/signIn';

/** The World Hub marketplace pages this route hands the player to. */
export const HUB_MARKETPLACE_PATHS = {
  diamonds: '/hub/diamond-store',
  membership: '/hub/vip-membership',
  clubShop: '/hub/club-shop',
} as const;

/**
 * The Club Arena storefront tabs that are views of one club's shop, and the
 * Hub Club Shop sub-view each one opens (`?view=`; the Store view is the Hub's
 * default and needs no parameter).
 */
const CLUB_SHOP_TAB_VIEWS: Record<string, string | null> = {
  store: null,
  my_items: 'my-purchases',
  manage: 'manage',
};

/** The plans /hub/vip-membership preselects from `?plan=`. */
const HUB_VIP_PLANS = new Set(['vip-monthly', 'vip-yearly', 'vip-lifetime']);

/** The parameters a Stripe (or StoreKit) return lands on /marketplace with. */
export const MARKETPLACE_CHECKOUT_RETURN_PARAMS = [
  'purchase',
  'session_id',
  'checkout_request_id',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paramsOf(search: string | URLSearchParams | null | undefined): URLSearchParams {
  if (!search) return new URLSearchParams();
  return typeof search === 'string' ? new URLSearchParams(search) : search;
}

/**
 * The club the marketplace link names: `?club=` (the Club Arena convention,
 * src/utils/clubScopedPath.ts) or the older `?clubId=`. A slug, a 6-digit club
 * code or a UUID, exactly as the link carried it; null when there is none.
 */
export function marketplaceClubParam(
  search: string | URLSearchParams | null | undefined
): string | null {
  const params = paramsOf(search);
  const raw = params.get('club') || params.get('clubId');
  const trimmed = raw ? raw.trim() : '';
  return trimmed || null;
}

/** True when this visit is a card checkout coming back to be verified. */
export function isMarketplaceCheckoutReturn(
  search: string | URLSearchParams | null | undefined
): boolean {
  const params = paramsOf(search);
  return MARKETPLACE_CHECKOUT_RETURN_PARAMS.some((key) => params.has(key));
}

/**
 * The in-app path this visit owes the player after a purchase (`?next=`),
 * validated the way the sign-in redirect validates one, or null.
 */
export function marketplaceContinuationPath(
  search: string | URLSearchParams | null | undefined
): string | null {
  const raw = paramsOf(search).get('next');
  if (!raw) return null;
  const safe = safeInAppRedirect(raw);
  return safe === '/' ? null : safe;
}

/**
 * True where the in-app storefront is the page that must answer this address:
 * a checkout coming back to be verified, or a top-up that owes the player a
 * way back. Both are things only that page knows how to finish.
 */
export function marketplaceKeepsInAppStorefront(
  search: string | URLSearchParams | null | undefined
): boolean {
  return isMarketplaceCheckoutReturn(search) || marketplaceContinuationPath(search) !== null;
}

/**
 * True where the in-app storefront must stay for every address: a native
 * build, or a native bundle running in the Capacitor shell. Mirrors
 * marketplaceShared.isNativeMarketplaceRuntime, which fails closed the same
 * way; it is restated here so the web route does not download the whole
 * storefront just to learn it is about to leave.
 */
export function usesInAppStorefront(): boolean {
  return IS_NATIVE_BUILD || isNativePlatform();
}

/** True when the destination depends on which club the address names. */
export function hubMarketplaceNeedsClub(
  search: string | URLSearchParams | null | undefined
): boolean {
  const tab = paramsOf(search).get('tab');
  return tab !== 'diamonds' && tab !== 'membership';
}

/**
 * The World Hub marketplace page (path and query, same origin) that shows what
 * this Club Arena marketplace address asked for.
 *
 * `clubId` is the club already resolved to a UUID by the caller. When it is
 * omitted the link's own club parameter is used, and only if it is a UUID.
 */
export function hubMarketplaceDestination(
  search: string | URLSearchParams | null | undefined,
  clubId?: string | null
): string {
  const params = paramsOf(search);
  const tab = params.get('tab');

  if (tab === 'diamonds') return HUB_MARKETPLACE_PATHS.diamonds;

  if (tab === 'membership') {
    const plan = params.get('plan');
    return plan && HUB_VIP_PLANS.has(plan)
      ? `${HUB_MARKETPLACE_PATHS.membership}?plan=${encodeURIComponent(plan)}`
      : HUB_MARKETPLACE_PATHS.membership;
  }

  const club = clubId === undefined ? marketplaceClubParam(params) : clubId;
  const clubUuid = club && UUID_RE.test(club) ? club.toLowerCase() : null;
  const isClubShopTab = tab !== null && tab in CLUB_SHOP_TAB_VIEWS;

  // Store, My Items and Manage are the three views of one club's shop, and the
  // Hub Club Shop holds all three (Store, My Purchases, Manage for an owner or
  // admin), each reachable with ?view=.
  if (isClubShopTab || clubUuid) {
    const query = new URLSearchParams();
    if (clubUuid) query.set('clubId', clubUuid);
    const view = tab ? CLUB_SHOP_TAB_VIEWS[tab] : null;
    if (view) query.set('view', view);
    const search = query.toString();
    return search ? `${HUB_MARKETPLACE_PATHS.clubShop}?${search}` : HUB_MARKETPLACE_PATHS.clubShop;
  }

  // No tab (or one this storefront never had) and no club: the marketplace
  // itself, which is the page /hub/marketplace opens.
  return HUB_MARKETPLACE_PATHS.diamonds;
}
