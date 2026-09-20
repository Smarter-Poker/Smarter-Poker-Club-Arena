/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MARKETPLACE : shared types, catalogs, and the /api/store fetch helper
 *  Split out of MarketplacePage.tsx in the 2026-08-19 rebuild.
 *
 *  IMPORTANT: every package/plan list here is DISPLAY COPY ONLY. The server
 *  holds the authoritative price tables:
 *    (Chips are NOT purchasable. Diamonds are the global purchasable currency;
 *     chips are a per-club gambling balance and the two never convert. The
 *     conversion path was removed 2026-08-19 and EXECUTE on fn_purchase_chips /
 *     fn_purchase_club_chips is revoked from every role, service_role included.)
 *    - diamond packages: WH pages/api/store/create-checkout-session.js
 *    - VIP plans:        WH src/data/diamondStoreData.js + store routes
 *  The client only ever sends ids/plan keys : never amounts or prices.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { normalizeThemePresetId } from '../../lib/tableTheme';
import { ALL_COSMETICS, normalizeCosmeticToken } from '../../cosmetics/avatarCosmetics';
import { uuid } from '../../utils/uuid';
import {
  clearSessionPurchaseRequestById,
  clearSessionPurchaseRequestIfMatches,
  readOrCreateSessionPurchaseRequest,
  readSessionPurchaseRequest,
  readSessionPurchaseRequestById,
  type SessionPurchaseRequest,
} from '../../utils/sessionPurchaseRequest';
import { leaveForHub } from '../../lib/openExternal';
import { APP_BASE_URL, IS_NATIVE_BUILD, isNativePlatform } from '../../lib/appBase';
import { appNavigate } from '../../lib/routerBridge';

/* ═══ Types ═══ */

export interface GrantSpec {
  type: 'time_bank' | 'throwable' | 'emote_pack' | 'table_skin' | 'avatar' | 'none';
  qty?: number;
  avatar_id?: string;
  theme_id?: string;
}

export interface MarketplaceItem {
  id: string;
  club_id: string;
  name: string;
  description?: string;
  price: number;
  image_url?: string;
  category?: string;
  item_type?: string | null;
  grant_spec?: GrantSpec | null;
  /** remaining units; null/undefined = unlimited, 0 = sold out */
  stock?: number | null;
  /** consumables may be held several times over; unlocks may not */
  stackable?: boolean;
  /** max lifetime purchases per member; null = unlimited */
  per_user_limit?: number | null;
  /** discounted price actually charged; null = charge `price` */
  sale_price?: number | null;
  /** Server-authoritative sale-aware price returned by marketplace-items. */
  effective_price?: number;
  /** Server-authoritative list price returned by marketplace-items. */
  list_price?: number;
  on_sale?: boolean;
  available?: boolean;
  availability_reason?: string | null;
  card_checkout_available?: boolean;
  card_checkout_reason?: string | null;
  card_quote?: {
    packageId: string;
    quantity: number;
    cardChargeCents: number;
    cardCharge: number;
    diamondsPurchased: number;
    diamondPurchaseBalance: number;
    diamondShortfall: number;
    cardPurchaseBalance: number;
  } | null;
  available_from?: string | null;
  available_until?: string | null;
  sort_order?: number;
  /**
   * Admin view only. /api/club-arena/marketplace-items already filters to
   * is_active=true and does NOT select the column, so it is undefined there.
   */
  is_active?: boolean;
  purchase_count?: number;
  /** admin view only : real revenue from price_paid */
  revenue?: number;
  /** the CALLER's own non-refunded purchases of this item (for per_user_limit) */
  my_purchase_count?: number;
}

const VERIFIED_PURCHASE_ITEM_TYPES: Record<string, GrantSpec['type']> = {
  'Time Banks': 'time_bank',
  Throwables: 'throwable',
};
const ALL_THROWABLES_OFFER_NAME = 'All Throwables Pack (10)';

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * Treat the Marketplace API as an untrusted serialization boundary. The
 * server deliberately sends only offers the installed fulfillment authority
 * can deliver, plus a locked availability/price decision for each one. An old
 * or partial route response must not be interpreted as permission to buy.
 */
export function verifiedMarketplaceItems(raw: unknown): MarketplaceItem[] | null {
  if (!Array.isArray(raw)) return null;
  const verified: MarketplaceItem[] = [];

  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') return null;
    const item = candidate as MarketplaceItem;
    const expectedGrant = VERIFIED_PURCHASE_ITEM_TYPES[String(item.category || '')];
    const grant = item.grant_spec;
    if (
      !isUuid(item.id) ||
      typeof item.name !== 'string' ||
      item.name.trim().length === 0 ||
      !expectedGrant ||
      item.item_type !== expectedGrant ||
      item.stackable !== true ||
      !grant ||
      grant.type !== expectedGrant ||
      !Number.isSafeInteger(grant.qty) ||
      Number(grant.qty) <= 0 ||
      !isNonNegativeSafeInteger(item.price) ||
      !isNonNegativeSafeInteger(item.effective_price) ||
      !isNonNegativeSafeInteger(item.list_price) ||
      Number(item.list_price) < Number(item.effective_price) ||
      typeof item.available !== 'boolean' ||
      typeof item.card_checkout_available !== 'boolean'
    ) {
      return null;
    }

    if (
      expectedGrant === 'throwable' &&
      (item.name !== ALL_THROWABLES_OFFER_NAME || Number(grant.qty) !== 10)
    ) {
      return null;
    }
    if (expectedGrant === 'time_bank' && Number(grant.qty) > 1000) return null;
    if (
      item.available === false &&
      (typeof item.availability_reason !== 'string' || !item.availability_reason.trim())
    ) {
      return null;
    }
    if (item.card_checkout_available === true) {
      const quote = item.card_quote;
      if (
        !quote ||
        typeof quote.packageId !== 'string' ||
        !quote.packageId.trim() ||
        !Number.isSafeInteger(quote.quantity) ||
        quote.quantity <= 0 ||
        !isNonNegativeSafeInteger(quote.cardChargeCents) ||
        !Number.isFinite(quote.cardCharge) ||
        quote.cardCharge < 0 ||
        !isNonNegativeSafeInteger(quote.diamondsPurchased) ||
        !isNonNegativeSafeInteger(quote.diamondPurchaseBalance) ||
        !isNonNegativeSafeInteger(quote.diamondShortfall) ||
        !isNonNegativeSafeInteger(quote.cardPurchaseBalance)
      ) {
        return null;
      }
    }
    verified.push(item);
  }

  return verified;
}

/** What the buyer will actually be charged (sale-aware). Server re-decides. */
export function effectivePrice(item: {
  price: number;
  sale_price?: number | null;
  effective_price?: number;
}): number {
  if (Number.isSafeInteger(item.effective_price) && Number(item.effective_price) >= 0) {
    return Number(item.effective_price);
  }
  const sale = item.sale_price;
  return sale !== null && sale !== undefined && sale < item.price ? sale : item.price;
}

export function isOnSale(item: { price: number; sale_price?: number | null }): boolean {
  return effectivePrice(item) < item.price;
}

/**
 * Why an item cannot be bought right now, or null when it can.
 * Mirrors fn_shop_item_availability so the card and the server agree.
 */
export function unavailableReason(
  item: {
    stock?: number | null;
    available_from?: string | null;
    available_until?: string | null;
    per_user_limit?: number | null;
    my_purchase_count?: number;
    available?: boolean;
    availability_reason?: string | null;
  },
  owned: boolean,
  stackable: boolean
): 'sold_out' | 'not_yet' | 'ended' | 'owned' | 'limit_reached' | 'unavailable' | null {
  if (item.available === false) {
    switch (item.availability_reason) {
      case 'sold_out':
        return 'sold_out';
      case 'not_yet':
      case 'not_yet_available':
        return 'not_yet';
      case 'ended':
      case 'no_longer_available':
        return 'ended';
      case 'limit_reached':
        return 'limit_reached';
      case 'already_owned':
        return 'owned';
      default:
        return 'unavailable';
    }
  }
  const now = Date.now();
  if (item.available_from && now < new Date(item.available_from).getTime()) return 'not_yet';
  if (item.available_until && now >= new Date(item.available_until).getTime()) return 'ended';
  if (item.stock !== null && item.stock !== undefined && item.stock <= 0) return 'sold_out';
  if (owned && !stackable) return 'owned';
  // Mirrors fn_shop_item_availability. Without this the button stayed enabled
  // and the member only learned about the cap after confirming a purchase.
  if (
    item.per_user_limit !== null &&
    item.per_user_limit !== undefined &&
    (item.my_purchase_count ?? 0) >= item.per_user_limit
  ) {
    return 'limit_reached';
  }
  return null;
}

/** Fallback seconds per time-bank use; the server catalog is authoritative. */
const DEFAULT_SECONDS_PER_TIME_BANK_USE = 20;

/**
 * Human-readable summary of what redeeming an item gives you.
 * Returns null when the item grants nothing automatically.
 */
export function describeGrant(
  spec?: GrantSpec | null,
  secondsPerUse: number = DEFAULT_SECONDS_PER_TIME_BANK_USE
): string | null {
  if (!spec || spec.type === 'none') return null;
  const qty = Math.max(1, Math.floor(Number(spec.qty) || 1));
  switch (spec.type) {
    case 'time_bank':
      return `+${qty * secondsPerUse}s Table Time (${qty} ${qty === 1 ? 'Use' : 'Uses'})`;
    case 'throwable':
      return `${qty} ${qty === 1 ? 'Use' : 'Uses'} Across All 49 Table Throwables`;
    case 'emote_pack':
      return 'Unlocks The Emote Pack';
    case 'table_skin':
      return 'Unlocks The Table Theme';
    case 'avatar':
      return 'Unlocks The Avatar';
    default:
      return null;
  }
}

export interface ShopPurchase {
  id: string;
  item_id: string;
  price_paid: number;
  /** 'diamonds' for every purchase since 2026-08-23; 'chips' = legacy rows */
  currency?: 'chips' | 'diamonds';
  created_at: string;
  item_name?: string | null;
  item_category?: string | null;
  /**
   * Set when the purchase was reversed and the chips returned. Without it the
   * history listed a refunded purchase identically to a live one : the member
   * saw chips they no longer owed, and an admin got an enabled Refund button
   * that could only ever come back "already refunded".
   */
  refunded_at?: string | null;
}

export interface InventoryRow {
  id: string;
  item_id?: string | null;
  /** links back to club_shop_purchases so the row can inherit its currency */
  purchase_id?: string | null;
  item_name: string | null;
  category: string | null;
  price_paid: number;
  status: string;
  acquired_at: string;
  /** Non-null once the benefit has actually reached its entitlement ledger. */
  redeemed_at?: string | null;
}

export type VipTier = 'monthly' | 'yearly' | 'lifetime';

export interface WalletInfo {
  diamonds: number;
  isVip: boolean;
  vipTier: VipTier | null;
  vipExpiresAt: string | null;
  loaded: boolean;
  /** set when the balance could not be read : never render 0 in that case */
  error: string | null;
}

/** Frozen so a consumer cannot poison every future mount by mutating it. */
export const EMPTY_WALLET: WalletInfo = Object.freeze({
  diamonds: 0,
  isVip: false,
  vipTier: null,
  vipExpiresAt: null,
  loaded: false,
  error: null,
});

/**
 * ONE definition of "owned" shared by the Store and My Items tabs.
 * Anything that is not explicitly redeemed still belongs to the player, so a
 * future status value ('delivered', 'pending', ...) can never make the Store
 * offer a Buy button for something My Items is showing as owned.
 */
/** Statuses that mean the player no longer holds the item. */
const SPENT_STATUSES = new Set(['redeemed', 'refunded', 'revoked', 'expired']);

export function isOwnedRow(row: { status?: string | null }): boolean {
  // Vocabulary: 'owned' | 'redeemed' | 'refunded' (fn_deliver_shop_purchase /
  // fn_redeem_shop_item / fn_refund_shop_purchase). Fail-safe: anything not
  // explicitly spent still belongs to the player, so the Store can never offer
  // to re-sell something My Items is calling Owned.
  return !SPENT_STATUSES.has(String(row.status ?? 'owned'));
}

/**
 * Permanent grants stay owned after activation. Derive ownership from the
 * entitlement ledger as well as inventory, otherwise a redeemed avatar/theme
 * becomes purchasable again even though the picker still knows it is owned.
 */
export function isMarketplaceItemOwned(item: MarketplaceItem, entitlements: Entitlements): boolean {
  if (!entitlements.loaded || !item.grant_spec) return false;
  const spec = item.grant_spec;
  if (spec.type === 'table_skin' && spec.theme_id) {
    const themeId = normalizeThemePresetId(spec.theme_id);
    return !!themeId && entitlements.themes.includes(themeId);
  }
  if (spec.type === 'avatar' && spec.avatar_id) {
    const wanted = normalizeCosmeticToken(spec.avatar_id);
    return [...entitlements.avatars, ...entitlements.avatarCosmetics].some(
      (owned) => normalizeCosmeticToken(owned) === wanted
    );
  }
  if (spec.type === 'emote_pack') return entitlements.emotePack;
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export type MarketplacePurchaseChannel = 'vip-diamonds' | 'vip-card' | 'diamond-package-card';

/**
 * A stable browser-session scope owns at most one unresolved request for an
 * account, payment channel, and offer. The server-priced terms remain in the
 * payload binding, not the scope, so repricing cannot silently mint a second
 * identity while the outcome of an earlier request is still unknown.
 */
export function marketplacePurchaseScope(
  userId: string,
  channel: MarketplacePurchaseChannel,
  offerId: string
): string {
  const normalizedOffer = String(offerId || '').trim();
  if (!isUuid(userId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalizedOffer)) {
    throw new Error('Protected Purchase Identity Is Invalid');
  }
  return `marketplace:${channel}:${userId}:${normalizedOffer}`;
}

/**
 * Reuse the durable request only when its exact terms match. The underlying
 * session record intentionally does not clear a different payload: that record
 * may represent a committed request whose response was lost.
 */
function exactMarketplacePurchaseIntent(
  request: SessionPurchaseRequest | null,
  payloadKey: string
): SessionPurchaseRequest | null {
  if (!request) return null;
  if (request.payloadKey !== payloadKey) {
    const error = new Error(
      'An Earlier Purchase For This Offer Has Different Terms And Must Be Verified Before A New Purchase.'
    ) as Error & { code?: string };
    error.code = 'PENDING_PURCHASE_TERMS_CONFLICT';
    throw error;
  }
  return request;
}

export function readMarketplacePurchaseIntent(
  scope: string,
  payloadKey: string
): SessionPurchaseRequest | null {
  return exactMarketplacePurchaseIntent(readSessionPurchaseRequest(scope), payloadKey);
}

export function readOrCreateMarketplacePurchaseIntent(
  scope: string,
  payloadKey: string
): SessionPurchaseRequest {
  return exactMarketplacePurchaseIntent(
    readOrCreateSessionPurchaseRequest(scope, payloadKey),
    payloadKey
  ) as SessionPurchaseRequest;
}

/** Clear only after a verified success or definitive pre-commit refusal. */
export function retireMarketplacePurchaseIntent(scope: string, expectedRequestId: string): boolean {
  try {
    return clearSessionPurchaseRequestIfMatches(scope, expectedRequestId);
  } catch (error) {
    reportError(error, 'marketplaceShared.retireMarketplacePurchaseIntent');
    return false;
  }
}

export function readMarketplacePurchaseIntentByRequestId(requestId: string) {
  return readSessionPurchaseRequestById(requestId);
}

export function retireMarketplacePurchaseIntentByRequestId(requestId: string): boolean {
  try {
    return clearSessionPurchaseRequestById(requestId);
  } catch (error) {
    reportError(error, 'marketplaceShared.retireMarketplacePurchaseIntentByRequestId');
    return false;
  }
}

/**
 * `<input type="datetime-local">` yields "2026-08-20T18:00" with NO timezone
 * designator. Per spec that is LOCAL time : but the server parses it with
 * `new Date()` under UTC, so sending it raw shifted every promo window by the
 * admin's offset (UTC+10 setting 18:00 got 04:00 the next day).
 * Returns null for blank so the caller can clear the field.
 */
export function localInputToIso(local: string | null | undefined): string | null {
  const v = (local ?? '').trim();
  if (!v) return null;
  const d = new Date(v); // interpreted in the BROWSER's zone, which is what the admin meant
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Inverse: an ISO instant back into a datetime-local value in local time. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Only https or same-origin paths may be used as an item image. */
export function safeImageUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const v = String(raw).trim();
  if (!v) return null;
  // '//evil.example/x.gif' starts with '/' but resolves to a THIRD PARTY.
  if (v.startsWith('//')) return null;
  if (v.startsWith('/')) return v;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

export { uuid };

/* ═══ Purchase-enabled Club Shop categories from the World Hub catalog ═══ */

export const CATEGORIES = ['All', 'Time Banks', 'Throwables'];

export type SortMode = 'newest' | 'price-low' | 'price-high' | 'popular';

/** One deterministic comparator for every storefront sort mode. Unavailable
 *  inventory always remains below buyable inventory, including after a price
 *  sort, so a second sort can never accidentally reshuffle the visible quote. */
export function sortMarketplaceItems(items: MarketplaceItem[], mode: SortMode): MarketplaceItem[] {
  return [...items].sort((a, b) => {
    const unavailableDelta =
      Number(Boolean(unavailableReason(a, false, true))) -
      Number(Boolean(unavailableReason(b, false, true)));
    if (unavailableDelta !== 0) return unavailableDelta;

    switch (mode) {
      case 'price-low':
        return effectivePrice(a) - effectivePrice(b);
      case 'price-high':
        return effectivePrice(b) - effectivePrice(a);
      case 'popular':
        return (b.purchase_count || 0) - (a.purchase_count || 0);
      default:
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    }
  });
}

/* ═══ Chip packages : mirrors server table in /api/club-arena/purchase-chips ═══ */

/* ═══ Diamond packages : mirrors VALID_DIAMOND_PACKAGES in create-checkout-session ═══ */

export interface DiamondPackage {
  id: string;
  diamonds: number;
  priceUsd: number;
  /** Integer cents from the same server-owned row used by checkout. */
  priceCents?: number;
  bonus: number;
  name: string;
  popular?: boolean;
  cardCheckoutReady?: boolean;
  diamondCheckoutReady?: boolean;
}

function exactUsdCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 1e-8 ? cents : null;
}

const FALLBACK_DIAMOND_PACKAGES: DiamondPackage[] = [
  { id: 'micro', diamonds: 100, priceUsd: 1, bonus: 0, name: 'Micro' },
  { id: 'small', diamonds: 500, priceUsd: 5, bonus: 0, name: 'Small' },
  { id: 'medium', diamonds: 1000, priceUsd: 10, bonus: 0, name: 'Medium' },
  { id: 'standard', diamonds: 2500, priceUsd: 25, bonus: 0, name: 'Standard' },
  { id: 'large', diamonds: 5000, priceUsd: 50, bonus: 0, name: 'Large', popular: true },
  { id: 'value', diamonds: 10000, priceUsd: 100, bonus: 500, name: 'Value' },
  { id: 'premium', diamonds: 25000, priceUsd: 250, bonus: 1250, name: 'Premium' },
  { id: 'whale', diamonds: 50000, priceUsd: 500, bonus: 2500, name: 'Whale' },
];

/* ═══ VIP membership plans : mirrors VIP_MEMBERSHIP in WH diamondStoreData.js ═══ */

export interface VipPlan {
  /** key sent to /api/store/purchase-vip-with-diamonds */
  planKey: 'monthly' | 'yearly' | 'lifetime' | null;
  /**
   * Plan id sent to create-checkout-session for Stripe. A non-null value only
   * identifies a server-side term; cardCheckoutReady is the fail-closed source
   * of truth for whether its complete charge, grant, refund and dispute
   * lifecycle is safe to expose.
   */
  checkoutPlan: string | null;
  /** Server gate for terms whose complete card lifecycle is published. */
  cardCheckoutReady: boolean;
  /** Server gate for terms whose Diamond debit and membership grant are published. */
  diamondCheckoutReady: boolean;
  id: string;
  name: string;
  period: string;
  priceUsd: number | null;
  /** diamond price. Stripe plans: 100 diamonds per dollar (server-computed). */
  priceDiamonds: number;
  features: string[];
  featured?: boolean;
}

/**
 * Mirrors /api/club-arena/store-catalog, which mirrors VIP_MEMBERSHIP in the
 * World Hub. Three terms since 2026-09-05 (Dan: "just vip, monthly, yearly or
 * lifetime, add lifetime for $499"); the Daily Pass was retired the same day,
 * unsold, and "Annual" became "Yearly". 100 diamonds per dollar throughout.
 */
const FALLBACK_VIP_PLANS: VipPlan[] = [
  {
    id: 'vip-monthly',
    planKey: 'monthly',
    checkoutPlan: 'vip-monthly',
    cardCheckoutReady: false,
    diamondCheckoutReady: false,
    name: 'Monthly VIP',
    period: 'Per Month',
    priceUsd: 19.99,
    priceDiamonds: 1999,
    features: [
      'All VIP Features, All Month',
      'Daily + Monthly Diamond Bonuses',
      'Time Bank, Offline Protection, Throwables',
      'VIP Badge Across Smarter.Poker',
    ],
    featured: true,
  },
  {
    id: 'vip-yearly',
    planKey: 'yearly',
    checkoutPlan: 'vip-yearly',
    cardCheckoutReady: false,
    diamondCheckoutReady: false,
    name: 'Yearly VIP',
    period: 'Per Year',
    priceUsd: 199.99,
    priceDiamonds: 19999,
    features: ['Everything In Monthly', 'Two Months Free Vs Monthly', 'Best Long-Run Value'],
  },
  {
    id: 'vip-lifetime',
    planKey: 'lifetime',
    checkoutPlan: 'vip-lifetime',
    cardCheckoutReady: false,
    diamondCheckoutReady: false,
    name: 'Lifetime VIP',
    period: 'One Payment',
    priceUsd: 499,
    priceDiamonds: 49900,
    features: [
      'Every VIP Feature, Permanently',
      'Unlimited Throwables, Rabbit Hunts, And Standard Time Banks',
      'Every Cataloged Table Skin, Card Back, Dealer Button, And VIP Avatar',
      'Never Renews, Never Expires',
    ],
  },
];

/* ═══ /api/store + /api/vip fetch helper ═══ */

interface StoreFetchOpts {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * Sent as `X-Idempotency-Key`. The money routes on the World Hub
   * (`/api/store/diamond-transfer` since #1696, 2026-09-09) REFUSE a request
   * without one - 400 "Invalid Transfer Request" - and the key is what lets a
   * retry after a lost response replay the server's own answer instead of
   * moving the money twice. Mint one per INTENT and reuse it on every retry of
   * that intent (StoreTab's session-persisted purchase request is the pattern);
   * rotate it only after a `definitive` refusal.
   */
  idempotencyKey?: string;
  /**
   * When a payable action began from account A, the fresh Supabase token used
   * for the request must still belong to account A. This closes the gap where
   * a stale React user and a newly switched auth session could authorize two
   * different players at the same button press.
   */
  expectedUserId?: string;
}

function verifiedLocalCheckoutPrecommitError(message: string): Error {
  const error = new Error(message) as Error & { checkoutPrecommitRefusal?: boolean };
  error.checkoutPrecommitRefusal = true;
  return error;
}

type StoreAuthSessionResult = Awaited<ReturnType<typeof supabase.auth.getSession>>;

function checkoutAbortError(): Error {
  const error = new Error('The Secure Checkout Request Was Canceled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Supabase's session read does not accept an AbortSignal. Race it against the
 * caller's checkout deadline so a stalled auth adapter cannot leave a payment
 * control permanently consumed before the network request even begins.
 */
function readStoreAuthSession(signal?: AbortSignal): Promise<StoreAuthSessionResult> {
  const pending = supabase.auth.getSession();
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(checkoutAbortError());

  return new Promise<StoreAuthSessionResult>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(checkoutAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Authenticated fetch against the World Hub store/vip APIs (same origin).
 * Throws with the server-supplied message on failure. Response shapes vary
 * per route, so this returns the parsed JSON as-is.
 */
export async function storeFetch<T = Record<string, unknown>>(
  path: string,
  opts: StoreFetchOpts = {}
): Promise<T> {
  const {
    data: { session },
  } = await readStoreAuthSession(opts.signal);
  const token = session?.access_token;
  const sessionUserId = session?.user?.id;
  if (!token || !sessionUserId) {
    if (opts.expectedUserId !== undefined) {
      throw verifiedLocalCheckoutPrecommitError(
        'Your Player Session Expired. Sign In And Review The Purchase Before Trying Again.'
      );
    }
    throw new Error('Not authenticated');
  }
  if (opts.expectedUserId !== undefined) {
    if (!isUuid(opts.expectedUserId) || sessionUserId !== opts.expectedUserId) {
      throw verifiedLocalCheckoutPrecommitError(
        'Your Player Account Changed. Review The Purchase Before Trying Again.'
      );
    }
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  const data = await res.json().catch(() => null);

  if (opts.expectedUserId !== undefined) {
    let currentSession: StoreAuthSessionResult;
    try {
      currentSession = await readStoreAuthSession(opts.signal);
    } catch (cause) {
      const error = new Error(
        'The Current Player Account Could Not Be Reverified. The Protected Purchase Request Was Retained.'
      ) as Error & {
        cause?: unknown;
        status?: number;
        responseReceived?: boolean;
        responsePath?: string;
        data?: unknown;
      };
      error.cause = cause;
      error.status = res.status;
      error.responseReceived = true;
      error.responsePath = path;
      error.data = data;
      throw error;
    }
    if (currentSession.error || currentSession.data.session?.user?.id !== opts.expectedUserId) {
      const error = new Error(
        'Your Player Account Changed. The Protected Purchase Request Was Retained For Verification.'
      ) as Error & {
        status?: number;
        responseReceived?: boolean;
        responsePath?: string;
        data?: unknown;
      };
      error.status = res.status;
      error.responseReceived = true;
      error.responsePath = path;
      error.data = data;
      throw error;
    }
  }

  if (!res.ok || (data && data.success === false)) {
    const errField = data?.error;
    const msg =
      (typeof errField === 'string' && errField) ||
      errField?.message ||
      data?.message ||
      `Request failed (HTTP ${res.status})`;
    /* TERMINAL OR AMBIGUOUS (2026-09-09). A caller holding a money
       idempotency key needs to know which: a terminal refusal (validation,
       auth, not found) means the attempt is finished and the next press is a
       new purchase, while a 5xx, a 408/409/425/429 or a transport exception
       may be a purchase that COMMITTED and lost its response - retiring the
       key there is what charges a player twice. Same list as
       UnionApiService and clubArenaApi. */
    const err = new Error(msg) as Error & {
      status?: number;
      definitive?: boolean;
      responseReceived?: boolean;
      responsePath?: string;
      data?: unknown;
    };
    err.status = res.status;
    err.definitive = [400, 401, 403, 404, 405, 422].includes(res.status);
    err.responseReceived = true;
    err.responsePath = path;
    err.data = data;
    throw err;
  }
  if (data == null) throw new Error('Empty response from server');
  return data as T;
}

/* ═══ Entitlements a player currently holds (what redemption granted) ═══ */

export interface Entitlements {
  timeBankUses: number;
  timeBankSeconds: number;
  throwables: number;
  emotePack: boolean;
  themeUnlock: boolean;
  avatars: string[];
  /** Frames and auras share avatar_unlocks, but are not avatar artwork. */
  avatarCosmetics: string[];
  /**
   * The SPECIFIC themes the player owns, from `theme_asset_unlocks`.
   *
   * `themeUnlock` above preserves the retired generic
   * `feature_purchases.theme_unlock` receipt. It cannot say WHICH theme, so
   * "you own a table theme" was the most the strip could ever claim. The modern
   * category ledger carries the exact preset and each bundled asset, which is
   * what Table Studio and the database guard both gate on.
   */
  themes: string[];
  loaded: boolean;
}

export const EMPTY_ENTITLEMENTS: Entitlements = Object.freeze({
  timeBankUses: 0,
  timeBankSeconds: 0,
  throwables: 0,
  emotePack: false,
  themeUnlock: false,
  avatars: [],
  avatarCosmetics: [],
  themes: [],
  loaded: false,
});

/**
 * Read the player's live entitlement balances. Every table is RLS-scoped
 * to the caller (feature_purchases_select_own / "Users can view their own
 * unlocks"), so this is a safe direct read.
 *
 * EVERY read is checked. `avatar_unlocks` used to be read with its error
 * discarded, so a failed request rendered as "you own no avatars" - the same
 * failure-as-empty-success shape the Store tab already had to fix. A caller
 * that cannot tell "none" from "could not ask" will always print the wrong one.
 */
export async function loadEntitlements(
  userId: string,
  secondsPerUse = DEFAULT_SECONDS_PER_TIME_BANK_USE
): Promise<Entitlements> {
  const nowIso = new Date().toISOString();
  const [fp, av, th, themeAssets] = await Promise.all([
    supabase
      .from('feature_purchases')
      .select('feature, uses_remaining, expires_at')
      .eq('user_id', userId),
    supabase.from('avatar_unlocks').select('avatar_id').eq('user_id', userId),
    supabase.from('theme_unlocks').select('theme_id').eq('user_id', userId),
    supabase.from('theme_asset_unlocks').select('category, asset_id').eq('user_id', userId),
  ]);
  if (fp.error) throw fp.error;
  if (av.error) throw av.error;
  if (th.error) throw th.error;
  if (themeAssets.error) throw themeAssets.error;

  const live = (fp.data || []).filter((r) => !r.expires_at || r.expires_at > nowIso);
  const sumUses = (feature: string) =>
    live
      .filter((r) => r.feature === feature)
      .reduce((n, r) => n + (Number(r.uses_remaining) || 0), 0);
  const hasPermanent = (feature: string) =>
    live.some((r) => r.feature === feature && r.uses_remaining == null);

  const timeBankUses = sumUses('time_bank_seconds');
  const styleTokens = new Set(ALL_COSMETICS.map((cosmetic) => cosmetic.unlockToken));
  const legacyStyleAliases: Record<string, string> = {
    gold_frame: 'frame_gold',
    royal_crown: 'frame_hellfire',
    diamond_halo: 'frame_diamond',
  };
  const avatarLedger = Array.from(new Set((av.data || []).map((row) => String(row.avatar_id))));
  const normalizedAvatarLedger = avatarLedger.map((raw) => {
    const normalized = normalizeCosmeticToken(raw);
    return { raw, styleToken: legacyStyleAliases[normalized] || normalized };
  });

  // Composite theme receipts are deduped across the modern ledger and rolling-
  // deployment compatibility rows.
  const themes = Array.from(
    new Set(
      [
        ...(themeAssets.data || [])
          .filter((row) => row.category === 'theme_id')
          .map((row) => String(row.asset_id)),
        // Legacy rows remain readable during rolling deployment and preserve the
        // receipt trail; the migration backfills every recognised one above.
        ...(th.data || []).map((row) => normalizeThemePresetId(String(row.theme_id))),
      ].filter((themeId): themeId is string => !!themeId)
    )
  );
  return {
    timeBankUses,
    timeBankSeconds: timeBankUses * secondsPerUse,
    throwables: sumUses('throwable'),
    emotePack: hasPermanent('emoji_pack'),
    themeUnlock: hasPermanent('theme_unlock') || themes.length > 0,
    avatars: normalizedAvatarLedger
      .filter(({ styleToken }) => !styleTokens.has(styleToken))
      .map(({ raw }) => raw),
    avatarCosmetics: Array.from(
      new Set(
        normalizedAvatarLedger
          .map(({ styleToken }) => styleToken)
          .filter((styleToken) => styleTokens.has(styleToken))
      )
    ),
    themes,
    loaded: true,
  };
}

const VIP_TIERS = new Set<VipTier>(['monthly', 'yearly', 'lifetime']);
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function timestampMillis(value: unknown): number | null {
  if (typeof value !== 'string' || !OFFSET_TIMESTAMP.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Validate the complete wallet/VIP relationship before marking it loaded.
 * Expired monthly/yearly rows remain valid inactive history, while Lifetime
 * must never carry an expiry or arrive inactive.
 */
export function verifiedWalletInfo(raw: unknown, now = Date.now()): WalletInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as {
    diamonds?: unknown;
    isVip?: unknown;
    vipTier?: unknown;
    vipExpiresAt?: unknown;
  };
  if (!isNonNegativeSafeInteger(data.diamonds) || typeof data.isVip !== 'boolean') return null;

  const tier = data.vipTier;
  const expiry = data.vipExpiresAt;
  if (tier === null) {
    if (expiry !== null || data.isVip) return null;
  } else {
    if (typeof tier !== 'string' || !VIP_TIERS.has(tier as VipTier)) return null;
    if (tier === 'lifetime') {
      if (expiry !== null || data.isVip !== true) return null;
    } else {
      const expiryMillis = timestampMillis(expiry);
      if (expiryMillis === null || (data.isVip ? expiryMillis <= now : expiryMillis > now)) {
        return null;
      }
    }
  }

  return {
    diamonds: data.diamonds,
    isVip: data.isVip,
    vipTier: tier as VipTier | null,
    vipExpiresAt: expiry as string | null,
    loaded: true,
    error: null,
  };
}

/** Load diamond balance + VIP status in one account-bound call. */
export async function loadWalletInfo(
  expectedUserId?: string,
  signal?: AbortSignal
): Promise<WalletInfo> {
  const data = await storeFetch<unknown>('/api/vip/check-status', {
    expectedUserId,
    signal,
  });
  const wallet = verifiedWalletInfo(data);
  if (!wallet) throw new Error('The Wallet Returned An Unverified Status Response.');
  return wallet;
}

export interface VipDiamondPurchaseReceipt {
  success: true;
  accountId: string;
  requestId: string;
  idempotent: boolean;
  duplicate: boolean;
  isVip: true;
  plan: VipTier;
  tier: VipTier;
  cost: number;
  daysAdded: number | null;
  expiresAt: string | null;
  newBalance: number;
}

const VIP_TERM_DAYS: Record<VipTier, number | null> = {
  monthly: 30,
  yearly: 365,
  lifetime: null,
};

const VIP_ALLOWED_RESULT_TIERS: Record<VipTier, ReadonlySet<VipTier>> = {
  monthly: new Set(['monthly', 'yearly']),
  yearly: new Set(['yearly']),
  lifetime: new Set(['lifetime']),
};

/** Accept only the exact receipt for the plan and cost the member confirmed. */
export function verifiedVipDiamondPurchaseReceipt(
  raw: unknown,
  expected: {
    accountId: string;
    requestId: string;
    plan: VipTier;
    cost: number;
  },
  now = Date.now()
): VipDiamondPurchaseReceipt | null {
  const { accountId, requestId, plan, cost: expectedCost } = expected;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !isUuid(accountId) ||
    !isUuid(requestId) ||
    !isNonNegativeSafeInteger(expectedCost) ||
    expectedCost === 0
  ) {
    return null;
  }
  const receipt = raw as Partial<VipDiamondPurchaseReceipt>;
  const resultingTier = receipt.tier;
  if (
    receipt.success !== true ||
    receipt.accountId !== accountId ||
    receipt.requestId !== requestId ||
    receipt.isVip !== true ||
    receipt.plan !== plan ||
    typeof resultingTier !== 'string' ||
    !VIP_TIERS.has(resultingTier as VipTier) ||
    !VIP_ALLOWED_RESULT_TIERS[plan].has(resultingTier as VipTier) ||
    receipt.cost !== expectedCost ||
    !isNonNegativeSafeInteger(receipt.newBalance) ||
    typeof receipt.duplicate !== 'boolean' ||
    typeof receipt.idempotent !== 'boolean' ||
    receipt.duplicate !== receipt.idempotent ||
    receipt.daysAdded !== VIP_TERM_DAYS[plan]
  ) {
    return null;
  }
  if (plan === 'lifetime') {
    if (receipt.expiresAt !== null) return null;
  } else {
    const expiryMillis = timestampMillis(receipt.expiresAt);
    if (expiryMillis === null || (receipt.idempotent !== true && expiryMillis <= now)) return null;
  }
  return receipt as VipDiamondPurchaseReceipt;
}

interface StoreResponseFailure {
  responseReceived?: boolean;
  responsePath?: string;
  status?: number;
  data?: unknown;
  checkoutPrecommitRefusal?: boolean;
}

function responseErrorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as { code?: unknown; error?: unknown };
  if (typeof body.code === 'string') return body.code;
  if (body.error && typeof body.error === 'object') {
    const code = (body.error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * Only a received, route-matched pre-commit refusal can retire a Diamond VIP
 * request. A timeout, transport failure, 5xx, generic 409, or processing replay
 * keeps the same key because the debit may already have committed.
 */
export function isVerifiedVipPurchasePrecommitRefusal(
  error: unknown,
  expected: { accountId: string; requestId: string }
): boolean {
  const failure = error as StoreResponseFailure;
  if (!isUuid(expected?.accountId) || !isUuid(expected?.requestId)) return false;
  if (failure?.checkoutPrecommitRefusal === true) return true;
  if (
    failure?.responseReceived !== true ||
    failure.responsePath !== '/api/store/purchase-vip-with-diamonds'
  ) {
    return false;
  }
  const status = failure.status;
  if (typeof status !== 'number' || !Number.isInteger(status)) return false;
  const body = failure.data as {
    success?: unknown;
    accountId?: unknown;
    requestId?: unknown;
    code?: unknown;
  } | null;
  if (
    !body ||
    body.success !== false ||
    body.accountId !== expected.accountId ||
    body.requestId !== expected.requestId ||
    ![400, 409].includes(status)
  ) {
    return false;
  }
  const code = responseErrorCode(failure.data);
  return [
    'ACTIVE_SUBSCRIPTION_EXISTS',
    'CARD_CHECKOUT_EXISTS',
    'ALREADY_LIFETIME',
    'INSUFFICIENT_DIAMONDS',
    'OFFER_PRICE_CHANGED',
  ].includes(code || '');
}

/** A Card request is safe to rotate only when checkout creation did not occur. */
export function isVerifiedCheckoutPrecommitRefusal(error: unknown): boolean {
  const failure = error as StoreResponseFailure;
  if (failure?.checkoutPrecommitRefusal === true) return true;
  if (
    failure?.responseReceived !== true ||
    failure.responsePath !== '/api/store/create-checkout-session'
  ) {
    return false;
  }
  const status = failure.status;
  if (typeof status !== 'number' || !Number.isInteger(status)) return false;
  if ([400, 401, 403, 404, 405, 410, 413, 422].includes(status)) return true;
  if (status !== 409) return false;
  return [
    'ACTIVE_SUBSCRIPTION_EXISTS',
    'CHECKOUT_EXPIRED',
    'DIAMOND_WALLET_CAPACITY_EXCEEDED',
    'LIFETIME_VIP_ALREADY_OWNED',
    'OFFER_CONFIRMATION_MISMATCH',
    'SUBSCRIPTION_CHECKOUT_EXISTS',
    'VIP_ENTITLEMENT_ACTIVE',
  ].includes(responseErrorCode(failure.data) || '');
}

/** A resumed Card key may retire only after its linked provider session is
 * authoritatively known to be expired. A bare intent conflict can still own
 * an open, payable Stripe URL and therefore remains recoverable. */
export function isVerifiedCheckoutTerminalExpiration(error: unknown): boolean {
  const failure = error as StoreResponseFailure;
  return (
    failure?.responseReceived === true &&
    failure.responsePath === '/api/store/create-checkout-session' &&
    failure.status === 409 &&
    responseErrorCode(failure.data) === 'CHECKOUT_EXPIRED'
  );
}

/** Restrict browser takeover to Stripe Checkout's exact HTTPS origin. */
export function verifiedStripeCheckoutUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw !== raw.trim()) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.origin !== 'https://checkout.stripe.com' || parsed.username || parsed.password) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export interface VerifiedStripeCheckoutResponse {
  url: string;
  sessionId: string;
  requestId: string;
  duplicate: boolean;
  offer: CheckoutOfferConfirmation;
}

export interface DiamondCheckoutOfferConfirmation {
  version: 1;
  accountId: string;
  type: 'diamonds';
  currency: 'usd';
  totalCents: number;
  totalDiamonds: number;
  totalBonus: number;
  items: Array<{
    packageId: string;
    quantity: number;
    unitCents: number;
    diamonds: number;
    bonus: number;
  }>;
}

export interface SubscriptionCheckoutOfferConfirmation {
  version: 1;
  accountId: string;
  type: 'subscription';
  currency: 'usd';
  plan: 'monthly' | 'yearly';
  interval: 'month' | 'year';
  quantity: 1;
  unitCents: number;
  totalCents: number;
}

export interface VipDiamondOfferConfirmation {
  version: 1;
  accountId: string;
  type: 'vip_diamonds';
  currency: 'diamonds';
  plan: 'monthly' | 'yearly' | 'lifetime';
  cost: number;
}

export type CheckoutOfferConfirmation =
  | DiamondCheckoutOfferConfirmation
  | SubscriptionCheckoutOfferConfirmation;

function hasExactObjectKeys(raw: unknown, expected: string[]): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const actual = Object.keys(raw).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactJsonValueMatches(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => exactJsonValueMatches(entry, right[index]))
    );
  }
  const leftIsObject = left !== null && typeof left === 'object';
  const rightIsObject = right !== null && typeof right === 'object';
  if (leftIsObject || rightIsObject) {
    if (!leftIsObject || !rightIsObject) return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index]) &&
      leftKeys.every((key) => exactJsonValueMatches(leftRecord[key], rightRecord[key]))
    );
  }
  return Object.is(left, right);
}

function isCheckoutOfferConfirmation(
  raw: unknown,
  expectedType: 'diamonds' | 'subscription',
  expectedUserId: string
): raw is CheckoutOfferConfirmation {
  if (
    !hasExactObjectKeys(
      raw,
      expectedType === 'diamonds'
        ? [
            'version',
            'accountId',
            'type',
            'currency',
            'totalCents',
            'totalDiamonds',
            'totalBonus',
            'items',
          ]
        : [
            'version',
            'accountId',
            'type',
            'currency',
            'plan',
            'interval',
            'quantity',
            'unitCents',
            'totalCents',
          ]
    )
  ) {
    return false;
  }
  if (
    raw.version !== 1 ||
    raw.accountId !== expectedUserId ||
    raw.type !== expectedType ||
    raw.currency !== 'usd'
  ) {
    return false;
  }

  if (expectedType === 'subscription') {
    const plan = raw.plan;
    return (
      (plan === 'monthly' || plan === 'yearly') &&
      raw.interval === (plan === 'monthly' ? 'month' : 'year') &&
      raw.quantity === 1 &&
      Number.isSafeInteger(raw.unitCents) &&
      Number(raw.unitCents) > 0 &&
      raw.totalCents === raw.unitCents
    );
  }

  if (!Array.isArray(raw.items) || raw.items.length === 0) return false;
  let totalCents = 0n;
  let totalDiamonds = 0n;
  let totalBonus = 0n;
  let previousPackageId = '';
  for (const item of raw.items) {
    if (
      !hasExactObjectKeys(item, ['packageId', 'quantity', 'unitCents', 'diamonds', 'bonus']) ||
      typeof item.packageId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.packageId) ||
      (previousPackageId !== '' && previousPackageId.localeCompare(item.packageId) >= 0) ||
      !Number.isSafeInteger(item.quantity) ||
      Number(item.quantity) < 1 ||
      Number(item.quantity) > 10 ||
      !Number.isSafeInteger(item.unitCents) ||
      Number(item.unitCents) < 1 ||
      !Number.isSafeInteger(item.diamonds) ||
      Number(item.diamonds) < 1 ||
      !Number.isSafeInteger(item.bonus) ||
      Number(item.bonus) < 0
    ) {
      return false;
    }
    previousPackageId = item.packageId;
    totalCents += BigInt(item.unitCents as number) * BigInt(item.quantity as number);
    totalDiamonds += BigInt(item.diamonds as number) * BigInt(item.quantity as number);
    totalBonus += BigInt(item.bonus as number) * BigInt(item.quantity as number);
  }
  return (
    totalCents <= BigInt(Number.MAX_SAFE_INTEGER) &&
    totalDiamonds <= BigInt(Number.MAX_SAFE_INTEGER) &&
    totalBonus <= BigInt(Number.MAX_SAFE_INTEGER) &&
    raw.totalCents === Number(totalCents) &&
    raw.totalDiamonds === Number(totalDiamonds) &&
    raw.totalBonus === Number(totalBonus)
  );
}

export function diamondCheckoutOfferConfirmation(
  userId: string,
  pkg: DiamondPackage,
  quantity = 1
): DiamondCheckoutOfferConfirmation | null {
  if (!pkg || typeof pkg !== 'object') return null;
  const unitCents = pkg.priceCents;
  if (
    !isUuid(userId) ||
    typeof pkg.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pkg.id) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 10 ||
    !Number.isSafeInteger(unitCents) ||
    Number(unitCents) < 1 ||
    unitCents !== exactUsdCents(pkg.priceUsd) ||
    !Number.isSafeInteger(pkg.diamonds) ||
    pkg.diamonds < 1 ||
    !Number.isSafeInteger(pkg.bonus) ||
    pkg.bonus < 0
  ) {
    return null;
  }
  const offer: DiamondCheckoutOfferConfirmation = {
    version: 1,
    accountId: userId,
    type: 'diamonds',
    currency: 'usd',
    totalCents: Number(unitCents) * quantity,
    totalDiamonds: pkg.diamonds * quantity,
    totalBonus: pkg.bonus * quantity,
    items: [
      {
        packageId: pkg.id,
        quantity,
        unitCents: Number(unitCents),
        diamonds: pkg.diamonds,
        bonus: pkg.bonus,
      },
    ],
  };
  return isCheckoutOfferConfirmation(offer, 'diamonds', userId) ? offer : null;
}

export function subscriptionCheckoutOfferConfirmation(
  userId: string,
  plan: VipPlan
): SubscriptionCheckoutOfferConfirmation | null {
  if (!plan || typeof plan !== 'object') return null;
  const planKey = plan.planKey;
  const unitCents = exactUsdCents(plan.priceUsd);
  if (
    !isUuid(userId) ||
    (planKey !== 'monthly' && planKey !== 'yearly') ||
    plan.checkoutPlan !== `vip-${planKey}` ||
    !Number.isSafeInteger(unitCents) ||
    Number(unitCents) < 1 ||
    plan.cardCheckoutReady !== true
  ) {
    return null;
  }
  const offer: SubscriptionCheckoutOfferConfirmation = {
    version: 1,
    accountId: userId,
    type: 'subscription',
    currency: 'usd',
    plan: planKey,
    interval: planKey === 'monthly' ? 'month' : 'year',
    quantity: 1,
    unitCents: Number(unitCents),
    totalCents: Number(unitCents),
  };
  return isCheckoutOfferConfirmation(offer, 'subscription', userId) ? offer : null;
}

export function vipDiamondOfferConfirmation(
  userId: string,
  plan: VipPlan
): VipDiamondOfferConfirmation | null {
  const planKey = plan?.planKey;
  if (
    !isUuid(userId) ||
    (planKey !== 'monthly' && planKey !== 'yearly' && planKey !== 'lifetime') ||
    !Number.isSafeInteger(plan.priceDiamonds) ||
    plan.priceDiamonds < 1 ||
    plan.priceDiamonds > 100_000
  ) {
    return null;
  }
  return {
    version: 1,
    accountId: userId,
    type: 'vip_diamonds',
    currency: 'diamonds',
    plan: planKey,
    cost: plan.priceDiamonds,
  };
}

const STRIPE_CHECKOUT_SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]{6,255}$/;

/**
 * Bind a payable Stripe URL to both the protected browser request and the
 * exact Checkout Session recovered or created for it. Origin alone is not
 * enough: an unrelated valid Stripe URL must never retire this request.
 */
export function verifiedStripeCheckoutResponse(
  raw: unknown,
  expectedRequestId: string,
  expectedOffer: CheckoutOfferConfirmation
): VerifiedStripeCheckoutResponse | null {
  const expectedType = expectedOffer?.type;
  const expectedAccountId = expectedOffer?.accountId;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !isUuid(expectedRequestId) ||
    (expectedType !== 'diamonds' && expectedType !== 'subscription') ||
    !isUuid(expectedAccountId) ||
    !isCheckoutOfferConfirmation(expectedOffer, expectedType, expectedAccountId)
  ) {
    return null;
  }
  const response = raw as {
    success?: unknown;
    duplicate?: unknown;
    data?: { session_id?: unknown; request_id?: unknown; url?: unknown; offer?: unknown };
  };
  if (
    response.success !== true ||
    (response.duplicate !== undefined && typeof response.duplicate !== 'boolean') ||
    !response.data ||
    typeof response.data.session_id !== 'string' ||
    !STRIPE_CHECKOUT_SESSION_ID.test(response.data.session_id) ||
    response.data.request_id !== expectedRequestId ||
    !exactJsonValueMatches(response.data.offer, expectedOffer)
  ) {
    return null;
  }
  const url = verifiedStripeCheckoutUrl(response.data.url);
  if (!url) return null;
  try {
    const pathSegments = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
    if (!pathSegments.includes(response.data.session_id)) return null;
  } catch {
    return null;
  }
  return {
    url,
    sessionId: response.data.session_id,
    requestId: expectedRequestId,
    duplicate: response.duplicate === true,
    offer: expectedOffer,
  };
}

export type MarketplaceCardCheckoutType = 'diamonds' | 'subscription';
export type MarketplaceCardCheckoutStatus = 'pending' | 'complete' | 'failed';

export interface VerifiedMarketplaceCardCheckoutStatus {
  status: MarketplaceCardCheckoutStatus;
  sessionId: string;
  requestId: string;
  accountId: string;
  type: MarketplaceCardCheckoutType;
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  sessionStatus: 'open' | 'complete' | 'expired';
  orderId: string | null;
  walletBalance: number | null;
}

/**
 * Treat the checkout-status route as an untrusted serialization boundary.
 * A return URL is not a receipt: completion must bind the exact Stripe
 * session, durable request, authenticated account, and Marketplace rail.
 */
export function verifiedMarketplaceCardCheckoutStatus(
  raw: unknown,
  expected: {
    sessionId: string;
    requestId: string;
    accountId: string;
    type: MarketplaceCardCheckoutType;
  }
): VerifiedMarketplaceCardCheckoutStatus | null {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !expected ||
    !STRIPE_CHECKOUT_SESSION_ID.test(expected.sessionId) ||
    !isUuid(expected.requestId) ||
    !isUuid(expected.accountId) ||
    !['diamonds', 'subscription'].includes(expected.type)
  ) {
    return null;
  }
  const response = raw as {
    success?: unknown;
    data?: Record<string, unknown>;
  };
  const data = response.data;
  if (
    response.success !== true ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.sessionId !== expected.sessionId ||
    data.requestId !== expected.requestId ||
    data.accountId !== expected.accountId ||
    data.type !== expected.type ||
    !['pending', 'complete', 'failed'].includes(String(data.status || '')) ||
    !['paid', 'unpaid', 'no_payment_required'].includes(String(data.paymentStatus || '')) ||
    !['open', 'complete', 'expired'].includes(String(data.sessionStatus || ''))
  ) {
    return null;
  }
  const status = data.status as MarketplaceCardCheckoutStatus;
  const paymentStatus =
    data.paymentStatus as VerifiedMarketplaceCardCheckoutStatus['paymentStatus'];
  const sessionStatus =
    data.sessionStatus as VerifiedMarketplaceCardCheckoutStatus['sessionStatus'];
  const orderId =
    data.orderId === null
      ? null
      : typeof data.orderId === 'string' &&
          data.orderId === data.orderId.trim() &&
          data.orderId.length > 0 &&
          data.orderId.length <= 160
        ? data.orderId
        : null;
  const walletBalance =
    data.walletBalance === null
      ? null
      : Number.isSafeInteger(data.walletBalance) && Number(data.walletBalance) >= 0
        ? Number(data.walletBalance)
        : null;
  if (
    (status === 'complete' &&
      (paymentStatus !== 'paid' || sessionStatus !== 'complete' || !orderId)) ||
    (status === 'failed' && (paymentStatus !== 'unpaid' || sessionStatus !== 'expired')) ||
    (status === 'pending' && sessionStatus === 'expired') ||
    (data.orderId !== null && orderId === null) ||
    (data.walletBalance !== null && walletBalance === null)
  ) {
    return null;
  }
  return {
    status,
    sessionId: expected.sessionId,
    requestId: expected.requestId,
    accountId: expected.accountId,
    type: expected.type,
    paymentStatus,
    sessionStatus,
    orderId,
    walletBalance,
  };
}

/** What the app asks the store for, from the same items the web sends Stripe. */
export function nativePurchaseRequestFor(
  type: 'diamonds' | 'subscription',
  items: Record<string, unknown>[]
): import('../../lib/native/purchases').NativePurchaseRequest | null {
  const first = items[0] || {};
  if (type === 'diamonds') {
    const packageKey = typeof first.packageId === 'string' ? first.packageId : null;
    return packageKey ? { kind: 'diamonds', packageKey } : null;
  }
  const plan = typeof first.plan === 'string' ? first.plan : '';
  if (plan === 'vip-monthly') return { kind: 'vip', tier: 'monthly' };
  if (plan === 'vip-yearly' || plan === 'vip-annual') return { kind: 'vip', tier: 'yearly' };
  return null; // Lifetime is not a native store product; annual is a legacy yearly alias.
}

/**
 * Native StoreKit / Play Billing cannot currently carry the Marketplace's
 * durable request identity across the provider boundary. Keep every native
 * payment control and the central checkout function on the same fail-closed
 * capability flag until an authenticated provider journal can prove an
 * interrupted consumable was not already charged. Web Card checkout and the
 * server-atomic Diamond-wallet routes are unaffected.
 */
export const NATIVE_MARKETPLACE_PAYMENTS_READY = false;
export const NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE =
  'App Store Checkout Is Temporarily Unavailable. Use The Web Store Or Pay With Diamonds.';

export function isNativeMarketplaceRuntime(): boolean {
  // A native bundle must fail closed even during the startup window where the
  // Capacitor bridge is absent or throws. Falling through to Stripe in that
  // window would bypass both the provider hold and native-store policy.
  return IS_NATIVE_BUILD || isNativePlatform();
}

export function checkoutProviderReadyForCurrentPlatform(
  _type: 'diamonds' | 'subscription'
): boolean {
  return !isNativeMarketplaceRuntime() || NATIVE_MARKETPLACE_PAYMENTS_READY;
}

export interface StartCheckoutAuthorization {
  requestId: string;
  expectedUserId: string;
  offerConfirmation: CheckoutOfferConfirmation;
  signal?: AbortSignal;
}

function checkoutItemsMatchOffer(
  type: 'diamonds' | 'subscription',
  items: Record<string, unknown>[],
  offer: CheckoutOfferConfirmation
): boolean {
  if (!Array.isArray(items)) return false;
  if (type === 'subscription') {
    return (
      offer.type === 'subscription' &&
      items.length === 1 &&
      hasExactObjectKeys(items[0], ['plan']) &&
      items[0].plan === `vip-${offer.plan}`
    );
  }
  if (offer.type !== 'diamonds' || items.length !== offer.items.length) return false;
  const normalizedItems = items.map((item) => {
    if (!hasExactObjectKeys(item, ['packageId', 'quantity'])) return null;
    return { packageId: item.packageId, quantity: item.quantity };
  });
  if (normalizedItems.some((item) => item === null)) return false;
  const sorted = (normalizedItems as Array<{ packageId: unknown; quantity: unknown }>).sort(
    (left, right) => String(left.packageId).localeCompare(String(right.packageId))
  );
  return sorted.every(
    (item, index) =>
      item.packageId === offer.items[index].packageId &&
      item.quantity === offer.items[index].quantity
  );
}

export async function currentMarketplaceCheckoutUserMatches(
  expectedUserId: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!isUuid(expectedUserId)) {
    throw new Error('The Expected Marketplace Account Is Invalid.');
  }
  try {
    const { data, error } = await readStoreAuthSession(signal);
    if (error) throw error;
    return data.session?.user?.id === expectedUserId;
  } catch (error) {
    if ((error as { name?: unknown })?.name === 'AbortError') throw error;
    reportError(error, 'marketplace.checkout_session_recheck_failed');
    throw error;
  }
}

export function marketplaceCheckoutReturnUrls(
  currentHref: string,
  returnParams: string,
  requestId: string,
  appBaseUrl = APP_BASE_URL
): { successUrl: string; cancelUrl: string } | null {
  if (!isUuid(requestId) || typeof returnParams !== 'string' || returnParams.length > 2048) {
    return null;
  }
  let currentUrl: URL;
  try {
    currentUrl = new URL(currentHref);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(currentUrl.protocol)) return null;
  const baseToken = String(appBaseUrl || '').replace(/^\/+|\/+$/g, '');
  const normalizedBase = baseToken ? `/${baseToken}/` : '/';
  const appBasePath = normalizedBase === '/' ? '' : normalizedBase.replace(/\/$/, '');
  const currentInAppPath =
    currentUrl.pathname === appBasePath
      ? '/'
      : appBasePath && currentUrl.pathname.startsWith(`${appBasePath}/`)
        ? currentUrl.pathname.slice(appBasePath.length)
        : currentUrl.pathname;
  const alreadyInMarketplace =
    currentInAppPath === '/marketplace' || currentInAppPath.startsWith('/marketplace/');
  const successParams = alreadyInMarketplace
    ? new URLSearchParams(currentUrl.search)
    : new URLSearchParams();
  successParams.delete('purchase');
  successParams.delete('session_id');
  successParams.delete('checkout_request_id');
  new URLSearchParams(returnParams).forEach((value, key) => successParams.set(key, value));
  if (!alreadyInMarketplace && currentInAppPath !== '/' && !successParams.has('next')) {
    successParams.set('next', `${currentInAppPath}${currentUrl.search}${currentUrl.hash}`);
  }
  successParams.set('purchase', 'success');
  successParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  successParams.set('checkout_request_id', requestId);
  const successQuery = successParams
    .toString()
    .replace(
      `session_id=${encodeURIComponent('{CHECKOUT_SESSION_ID}')}`,
      'session_id={CHECKOUT_SESSION_ID}'
    );

  const cancelUrl = new URL(currentUrl.href);
  const cancelParams = new URLSearchParams(currentUrl.search);
  cancelParams.delete('purchase');
  cancelParams.delete('session_id');
  cancelParams.delete('checkout_request_id');
  new URLSearchParams(returnParams).forEach((value, key) => cancelParams.set(key, value));
  cancelParams.set('purchase', 'canceled');
  cancelParams.set('checkout_request_id', requestId);
  cancelUrl.search = cancelParams.toString();

  return {
    successUrl: `${currentUrl.origin}${normalizedBase}marketplace?${successQuery}${alreadyInMarketplace ? currentUrl.hash : ''}`,
    cancelUrl: cancelUrl.href,
  };
}

export function marketplaceNativeReturnPath(
  currentHref: string,
  returnParams: string,
  status: 'success' | 'canceled',
  requestId: string
): string | null {
  if (!isUuid(requestId) || typeof returnParams !== 'string' || returnParams.length > 2048) {
    return null;
  }
  let currentUrl: URL;
  try {
    currentUrl = new URL(currentHref);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(currentUrl.protocol)) return null;
  const params = new URLSearchParams(currentUrl.search);
  params.delete('purchase');
  params.delete('session_id');
  params.delete('checkout_request_id');
  new URLSearchParams(returnParams).forEach((value, key) => params.set(key, value));
  params.set('purchase', status);
  params.set('checkout_request_id', requestId);
  const query = params.toString();
  return `${currentUrl.pathname}${query ? `?${query}` : ''}${currentUrl.hash}`;
}

/**
 * Start the verified payment provider for this platform. Web uses Stripe in
 * the current tab; native uses StoreKit or Play Billing in the app. Return URLs
 * stay on the current Smarter.Poker surface.
 */
export async function startCheckout(
  type: 'diamonds' | 'subscription',
  items: Record<string, unknown>[],
  returnParams: string,
  authorization: StartCheckoutAuthorization
): Promise<void> {
  const requestId = authorization?.requestId;
  const expectedUserId = authorization?.expectedUserId;
  const offerConfirmation = authorization?.offerConfirmation;
  const signal = authorization?.signal;
  if (signal?.aborted) throw checkoutAbortError();
  if (
    !isUuid(requestId) ||
    !isUuid(expectedUserId) ||
    !isCheckoutOfferConfirmation(offerConfirmation, type, expectedUserId) ||
    !checkoutItemsMatchOffer(type, items, offerConfirmation)
  ) {
    throw verifiedLocalCheckoutPrecommitError(
      'The Checkout Terms Could Not Be Verified. Review The Purchase Before Trying Again.'
    );
  }

  // THE APP (2026-09-08, store readiness phase 3c): the store's own billing.
  // Apple 3.1.1 / Play Payments: diamonds and VIP bought inside the app go
  // through StoreKit / Play Billing (RevenueCat), never Stripe Checkout. The
  // store sheet opens over the marketplace; the credit lands through the
  // webhook, so on success the page is sent to the same ?purchase=success
  // return it already handles for Stripe (it polls the wallet for the credit).
  if (isNativeMarketplaceRuntime()) {
    if (!NATIVE_MARKETPLACE_PAYMENTS_READY) {
      throw verifiedLocalCheckoutPrecommitError(NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE);
    }
    const { data: sess, error: sessError } = await readStoreAuthSession(signal);
    if (sessError) reportError(sessError, 'marketplace.startCheckout_native_session_read_failed');
    const userId = sess?.session?.user?.id;
    if (sessError || !userId || userId !== expectedUserId) {
      throw verifiedLocalCheckoutPrecommitError(
        'Your Player Account Changed. Review The Purchase Before Trying Again.'
      );
    }
    const req = nativePurchaseRequestFor(type, items);
    if (!req) {
      throw verifiedLocalCheckoutPrecommitError('This Item Is Not Available In The App Store Yet.');
    }
    const { purchaseNative } = await import('../../lib/native/purchases');
    if (signal?.aborted) throw checkoutAbortError();
    const result = await purchaseNative(userId, req);
    if (signal?.aborted) throw checkoutAbortError();
    if (!(await currentMarketplaceCheckoutUserMatches(expectedUserId, signal))) {
      throw new Error(
        'Your Player Account Changed While The Purchase Was Processing. Verify The Receipt Before Trying Again.'
      );
    }
    if (result.cancelled) {
      const returnPath = marketplaceNativeReturnPath(
        window.location.href,
        returnParams,
        'canceled',
        requestId
      );
      if (!returnPath) {
        throw new Error('The Purchase Return Path Could Not Be Verified.');
      }
      if (signal?.aborted) throw checkoutAbortError();
      appNavigate(returnPath, { replace: true });
      return;
    }
    if (!result.ok) {
      if (result.error === 'store_not_configured') {
        throw verifiedLocalCheckoutPrecommitError('Purchases Are Not Set Up On This Build Yet.');
      }
      if (result.error === 'product_not_in_store') {
        throw verifiedLocalCheckoutPrecommitError('This Item Is Not Available In The Store Yet.');
      }
      throw new Error('The Purchase Could Not Be Completed.');
    }
    const returnPath = marketplaceNativeReturnPath(
      window.location.href,
      returnParams,
      'success',
      requestId
    );
    if (!returnPath) {
      throw new Error('The Purchase Return Path Could Not Be Verified.');
    }
    if (signal?.aborted) throw checkoutAbortError();
    appNavigate(returnPath, { replace: true });
    return;
  }

  // Every Card success converges on the one route that owns authenticated
  // Stripe-status verification and exact durable-request retirement. Callers
  // elsewhere in the SPA receive a safe continuation after recovery.
  const returnUrls = marketplaceCheckoutReturnUrls(window.location.href, returnParams, requestId);
  if (!returnUrls) {
    throw verifiedLocalCheckoutPrecommitError(
      'The Checkout Return Path Could Not Be Verified. No Payment Was Started.'
    );
  }
  const data = await storeFetch<unknown>('/api/store/create-checkout-session', {
    body: {
      type,
      items,
      successUrl: returnUrls.successUrl,
      cancelUrl: returnUrls.cancelUrl,
      offerConfirmation,
    },
    idempotencyKey: requestId,
    expectedUserId,
    signal,
  });
  const checkout = verifiedStripeCheckoutResponse(data, requestId, offerConfirmation);
  if (!checkout) {
    throw new Error('Checkout Session Returned An Unverified Redirect. No Navigation Was Started.');
  }
  if (!(await currentMarketplaceCheckoutUserMatches(expectedUserId, signal))) {
    throw new Error(
      'Your Player Account Changed While Checkout Was Starting. Return To The Marketplace And Verify The Pending Purchase.'
    );
  }
  // Web only: Stripe Checkout takes over this tab. Native returned above after
  // StoreKit or Play Billing completed inside the app.
  if (signal?.aborted) throw checkoutAbortError();
  leaveForHub(checkout.url);
}

/* ═══ Server catalog : the marketplace's single source of truth ═══ */

export interface ShopCategoryInfo {
  name: string;
  grantType: GrantSpec['type'];
  grantUnit: string | null;
  secondsPerUse?: number;
}

export interface StoreCatalog {
  diamondPackages: DiamondPackage[];
  vipPlans: VipPlan[];
  shopCategories: ShopCategoryInfo[];
  /** true when these values came from the server rather than the local fallback */
  fromServer: boolean;
}

/**
 * Mirrors GRANT_TYPE_BY_CATEGORY in pages/api/club-arena/manage-shop.js.
 * Previously every fallback category mapped to 'none', so a failed catalog
 * fetch made the admin form silently create items that granted NOTHING.
 */
const FALLBACK_SHOP_CATEGORIES: ShopCategoryInfo[] = [
  { name: 'Time Banks', grantType: 'time_bank', grantUnit: 'uses', secondsPerUse: 20 },
  { name: 'Throwables', grantType: 'throwable', grantUnit: 'throws' },
];

/** Shape guards : the server response is `any` until proven otherwise. */

const isDiamondPkg = (p: unknown): p is DiamondPackage =>
  !!p &&
  typeof (p as DiamondPackage).id === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test((p as DiamondPackage).id) &&
  typeof (p as DiamondPackage).name === 'string' &&
  (p as DiamondPackage).name.trim().length > 0 &&
  (p as DiamondPackage).name.length <= 200 &&
  Number.isSafeInteger((p as DiamondPackage).diamonds) &&
  (p as DiamondPackage).diamonds > 0 &&
  exactUsdCents((p as DiamondPackage).priceUsd) !== null &&
  Number.isSafeInteger((p as DiamondPackage).priceCents) &&
  (p as DiamondPackage).priceCents === exactUsdCents((p as DiamondPackage).priceUsd) &&
  Number.isSafeInteger((p as DiamondPackage).bonus) &&
  (p as DiamondPackage).bonus >= 0 &&
  Number.isSafeInteger((p as DiamondPackage).diamonds + (p as DiamondPackage).bonus) &&
  (p as DiamondPackage).cardCheckoutReady === true &&
  (p as DiamondPackage).diamondCheckoutReady === false &&
  (typeof (p as DiamondPackage).popular === 'undefined' ||
    typeof (p as DiamondPackage).popular === 'boolean');

const isVipPlan = (p: unknown): p is VipPlan =>
  !!p &&
  typeof (p as VipPlan).id === 'string' &&
  /^vip-(monthly|yearly|lifetime)$/.test((p as VipPlan).id) &&
  ['monthly', 'yearly', 'lifetime'].includes(String((p as VipPlan).planKey)) &&
  ((typeof (p as VipPlan).checkoutPlan === 'string' &&
    Boolean((p as VipPlan).checkoutPlan?.trim())) ||
    (p as VipPlan).checkoutPlan === null) &&
  typeof (p as VipPlan).name === 'string' &&
  (p as VipPlan).name.trim().length > 0 &&
  (p as VipPlan).name.length <= 200 &&
  typeof (p as VipPlan).period === 'string' &&
  (p as VipPlan).period.trim().length > 0 &&
  ((p as VipPlan).priceUsd === null || exactUsdCents((p as VipPlan).priceUsd) !== null) &&
  Number.isSafeInteger((p as VipPlan).priceDiamonds) &&
  (p as VipPlan).priceDiamonds > 0 &&
  typeof (p as VipPlan).cardCheckoutReady === 'boolean' &&
  typeof (p as VipPlan).diamondCheckoutReady === 'boolean' &&
  (!(p as VipPlan).cardCheckoutReady ||
    (typeof (p as VipPlan).checkoutPlan === 'string' &&
      exactUsdCents((p as VipPlan).priceUsd) !== null)) &&
  Array.isArray((p as VipPlan).features) &&
  (p as VipPlan).features.length > 0 &&
  (p as VipPlan).features.every(
    (feature) => typeof feature === 'string' && feature.trim().length > 0 && feature.length <= 300
  );

const EXPECTED_CATEGORY_CONTRACT: Record<
  string,
  { grantType: GrantSpec['type']; grantUnit: string | null; secondsPerUse?: number }
> = {
  'Time Banks': { grantType: 'time_bank', grantUnit: 'uses', secondsPerUse: 20 },
  Throwables: { grantType: 'throwable', grantUnit: 'throws' },
};

const isCategory = (c: unknown): c is ShopCategoryInfo =>
  !!c &&
  typeof (c as ShopCategoryInfo).name === 'string' &&
  (() => {
    const category = c as ShopCategoryInfo;
    const expected = EXPECTED_CATEGORY_CONTRACT[category.name];
    if (
      !expected ||
      category.grantType !== expected.grantType ||
      category.grantUnit !== expected.grantUnit
    ) {
      return false;
    }
    if (expected.secondsPerUse !== undefined) {
      return category.secondsPerUse === expected.secondsPerUse;
    }
    return category.secondsPerUse === undefined;
  })();

function verifiedList<T>(raw: unknown, guard: (v: unknown) => v is T): T[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(guard)) return null;
  return raw;
}

function verifiedDiamondPackageList(raw: unknown): DiamondPackage[] | null {
  const packages = verifiedList(raw, isDiamondPkg);
  if (!packages || new Set(packages.map((pkg) => pkg.id)).size !== packages.length) return null;
  return packages;
}

const EXPECTED_VIP_PLAN_CONTRACT: Record<
  VipTier,
  {
    id: string;
    checkoutPlan: string;
    priceUsd: number;
    priceDiamonds: number;
    cardCheckoutReady: boolean;
  }
> = {
  monthly: {
    id: 'vip-monthly',
    checkoutPlan: 'vip-monthly',
    priceUsd: 19.99,
    priceDiamonds: 1999,
    cardCheckoutReady: true,
  },
  yearly: {
    id: 'vip-yearly',
    checkoutPlan: 'vip-yearly',
    priceUsd: 199.99,
    priceDiamonds: 19999,
    cardCheckoutReady: true,
  },
  lifetime: {
    id: 'vip-lifetime',
    checkoutPlan: 'vip-lifetime',
    priceUsd: 499,
    priceDiamonds: 49900,
    cardCheckoutReady: false,
  },
};

function verifiedVipPlanList(raw: unknown): VipPlan[] | null {
  const plans = verifiedList(raw, isVipPlan);
  if (!plans) return null;
  const keys = plans.map((plan) => plan.planKey);
  const ids = plans.map((plan) => plan.id);
  if (
    plans.length !== Object.keys(EXPECTED_VIP_PLAN_CONTRACT).length ||
    new Set(keys).size !== plans.length ||
    new Set(ids).size !== plans.length ||
    Object.keys(EXPECTED_VIP_PLAN_CONTRACT).some((key) => !keys.includes(key as VipTier)) ||
    plans.some((plan) => {
      if (!plan.planKey) return true;
      const expected = EXPECTED_VIP_PLAN_CONTRACT[plan.planKey];
      return (
        plan.id !== expected.id ||
        plan.checkoutPlan !== expected.checkoutPlan ||
        plan.priceUsd !== expected.priceUsd ||
        plan.priceDiamonds !== expected.priceDiamonds ||
        plan.cardCheckoutReady !== expected.cardCheckoutReady ||
        plan.diamondCheckoutReady !== true
      );
    })
  ) {
    return null;
  }
  return plans;
}

function verifiedCategoryList(raw: unknown): ShopCategoryInfo[] | null {
  const categories = verifiedList(raw, isCategory);
  if (!categories) return null;
  const names = new Set(categories.map((category) => category.name));
  const expectedNames = Object.keys(EXPECTED_CATEGORY_CONTRACT);
  if (
    names.size !== categories.length ||
    categories.length !== expectedNames.length ||
    expectedNames.some((name) => !names.has(name))
  ) {
    return null;
  }
  return categories;
}

export const FALLBACK_CATALOG: StoreCatalog = {
  diamondPackages: FALLBACK_DIAMOND_PACKAGES,
  vipPlans: FALLBACK_VIP_PLANS,
  shopCategories: FALLBACK_SHOP_CATEGORIES,
  fromServer: false,
};

let catalogCache: StoreCatalog | null = null;
let catalogFetchedAt = 0;
/** Matches the route's s-maxage so a long-lived tab cannot show stale prices. */
const CATALOG_TTL_MS = 300_000;

/**
 * Load the package/plan catalog from the server so displayed prices can never
 * drift from what the charging routes actually bill. Falls back to the bundled
 * tables if the request fails, so the storefront still renders offline.
 */
export async function loadStoreCatalog(
  options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<StoreCatalog> {
  if (options.signal?.aborted) throw checkoutAbortError();
  if (!options.force && catalogCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }
  try {
    // Strict mode makes the World Hub refuse a stale fallback Diamond catalog.
    // The bundled tables below remain useful display copy, but may never
    // authorize a payment.
    const res = await fetch('/api/club-arena/store-catalog?strict=1', {
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.success !== true) throw new Error(data?.error || 'catalog unavailable');
    if (
      !Array.isArray(data.warnings) ||
      data.warnings.length !== 0 ||
      data.diamondCatalogSource !== 'database' ||
      !Array.isArray(data.chipPackages) ||
      data.chipPackages.length !== 0 ||
      data.diamondsPerDollar !== 100
    ) {
      throw new Error('catalog response reported drift or an unverified pricing source');
    }
    const diamondPackages = verifiedDiamondPackageList(data.diamondPackages);
    const vipPlans = verifiedVipPlanList(data.vipPlans);
    const shopCategories = verifiedCategoryList(data.shopCategories);
    if (!diamondPackages || !vipPlans || !shopCategories) {
      throw new Error('catalog response failed validation');
    }
    catalogCache = {
      diamondPackages,
      vipPlans,
      shopCategories,
      fromServer: true,
    };
    catalogFetchedAt = Date.now();
    return catalogCache;
  } catch (err) {
    if ((err as { name?: unknown })?.name === 'AbortError') throw err;
    // Any failed live read revokes the previous verification. Leaving an old
    // entry cached can re-enable a stale offer after a clock change or remount.
    catalogCache = null;
    catalogFetchedAt = 0;
    // Must be reported: a silent failure here used to make the admin form
    // create items that granted nothing, with zero telemetry.
    reportError(err, 'marketplaceShared.loadStoreCatalog');
    return FALLBACK_CATALOG;
  }
}
