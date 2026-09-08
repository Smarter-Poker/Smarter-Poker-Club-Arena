/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MARKETPLACE — shared types, catalogs, and the /api/store fetch helper
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
 *  The client only ever sends ids/plan keys — never amounts or prices.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { normalizeThemePresetId } from '../../lib/tableTheme';
import { ALL_COSMETICS, normalizeCosmeticToken } from '../../cosmetics/avatarCosmetics';
import { uuid } from '../../utils/uuid';
import { leaveForHub } from '../../lib/openExternal';
import { isNativePlatform } from '../../lib/appBase';
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
  available_from?: string | null;
  available_until?: string | null;
  sort_order?: number;
  /**
   * Admin view only. /api/club-arena/marketplace-items already filters to
   * is_active=true and does NOT select the column, so it is undefined there.
   */
  is_active?: boolean;
  purchase_count?: number;
  /** admin view only — real revenue from price_paid */
  revenue?: number;
  /** the CALLER's own non-refunded purchases of this item (for per_user_limit) */
  my_purchase_count?: number;
}

/** What the buyer will actually be charged (sale-aware). Server re-decides. */
export function effectivePrice(item: { price: number; sale_price?: number | null }): number {
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
  },
  owned: boolean,
  stackable: boolean
): 'sold_out' | 'not_yet' | 'ended' | 'owned' | 'limit_reached' | null {
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
      return `${qty} Free ${qty === 1 ? 'Throw' : 'Throws'}`;
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
   * history listed a refunded purchase identically to a live one — the member
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

export interface WalletInfo {
  diamonds: number;
  isVip: boolean;
  vipTier: string | null;
  vipExpiresAt: string | null;
  loaded: boolean;
  /** set when the balance could not be read — never render 0 in that case */
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

/**
 * `<input type="datetime-local">` yields "2026-08-20T18:00" with NO timezone
 * designator. Per spec that is LOCAL time — but the server parses it with
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

/* ═══ Club shop categories (must match WH shop-items.js VALID_CATEGORIES) ═══ */

export const CATEGORIES = ['All', 'Time Banks', 'Table Skins', 'Throwables', 'Emotes', 'Avatars'];

export type SortMode = 'newest' | 'price-low' | 'price-high' | 'popular';

/* ═══ Chip packages — mirrors server table in /api/club-arena/purchase-chips ═══ */

/* ═══ Diamond packages — mirrors VALID_DIAMOND_PACKAGES in create-checkout-session ═══ */

export interface DiamondPackage {
  id: string;
  diamonds: number;
  priceUsd: number;
  bonus: number;
  name: string;
  popular?: boolean;
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

/* ═══ VIP membership plans — mirrors VIP_MEMBERSHIP in WH diamondStoreData.js ═══ */

export interface VipPlan {
  /** key sent to /api/store/purchase-vip-with-diamonds */
  planKey: 'monthly' | 'yearly' | 'lifetime' | null;
  /**
   * Plan id sent to create-checkout-session for Stripe. NULL means this term
   * has no card path: lifetime is one payment, and the World Hub's session
   * builder has no one-time VIP mode (and its webhook no one-time VIP grant),
   * so a card session would be paid and grant nothing. The tab hides the card
   * button when this is null rather than offering one that refuses.
   */
  checkoutPlan: string | null;
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
    name: 'Yearly VIP',
    period: 'Per Year',
    priceUsd: 199.99,
    priceDiamonds: 19999,
    features: ['Everything In Monthly', 'Two Months Free Vs Monthly', 'Best Long-Run Value'],
  },
  {
    id: 'vip-lifetime',
    planKey: 'lifetime',
    checkoutPlan: null,
    name: 'Lifetime VIP',
    period: 'One Payment',
    priceUsd: 499,
    priceDiamonds: 49900,
    features: ['Every VIP Feature, Permanently', 'Never Renews, Never Expires', 'One Payment'],
  },
];

/* ═══ /api/store + /api/vip fetch helper ═══ */

interface StoreFetchOpts {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
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
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || (data && data.success === false)) {
    const errField = data?.error;
    const msg =
      (typeof errField === 'string' && errField) ||
      errField?.message ||
      data?.message ||
      `Request failed (HTTP ${res.status})`;
    throw new Error(msg);
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

/** Load diamond balance + VIP status in one call. */
export async function loadWalletInfo(): Promise<WalletInfo> {
  const data = await storeFetch<{
    isVip: boolean;
    diamonds: number;
    vipTier?: string | null;
    vipExpiresAt?: string | null;
  }>('/api/vip/check-status');
  return {
    diamonds: data.diamonds || 0,
    isVip: !!data.isVip,
    vipTier: data.vipTier ?? null,
    vipExpiresAt: data.vipExpiresAt ?? null,
    loaded: true,
    error: null,
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
  return null; // lifetime is not a store product (audit: monthly and annual)
}

/**
 * Start a Stripe Checkout session and redirect. type 'diamonds' | 'subscription'.
 * The server only honours return URLs on its own origin; anything else falls
 * back to /hub/diamond-store, which is acceptable.
 */
export async function startCheckout(
  type: 'diamonds' | 'subscription',
  items: Record<string, unknown>[],
  returnParams: string,
  idempotencyKey: string = uuid()
): Promise<void> {
  // THE APP (2026-09-08, store readiness phase 3c): the store's own billing.
  // Apple 3.1.1 / Play Payments: diamonds and VIP bought inside the app go
  // through StoreKit / Play Billing (RevenueCat), never Stripe Checkout. The
  // store sheet opens over the marketplace; the credit lands through the
  // webhook, so on success the page is sent to the same ?purchase=success
  // return it already handles for Stripe (it polls the wallet for the credit).
  if (isNativePlatform()) {
    const { data: sess } = await supabase.auth.getSession();
    const userId = sess?.session?.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const req = nativePurchaseRequestFor(type, items);
    if (!req) throw new Error('This Item Is Not Available In The App Store Yet.');
    const { purchaseNative } = await import('../../lib/native/purchases');
    const result = await purchaseNative(userId, req);
    if (result.cancelled) {
      appNavigate(`${window.location.pathname}?${returnParams}&purchase=canceled`, {
        replace: true,
      });
      return;
    }
    if (!result.ok) {
      if (result.error === 'store_not_configured') {
        throw new Error('Purchases Are Not Set Up On This Build Yet.');
      }
      if (result.error === 'product_not_in_store') {
        throw new Error('This Item Is Not Available In The Store Yet.');
      }
      throw new Error('The Purchase Could Not Be Completed.');
    }
    appNavigate(`${window.location.pathname}?${returnParams}&purchase=success`, { replace: true });
    return;
  }

  const base = `${window.location.origin}${window.location.pathname}`;
  const data = await storeFetch<{ success: true; data: { url: string } }>(
    '/api/store/create-checkout-session',
    {
      body: {
        type,
        items,
        idempotencyKey,
        successUrl: `${base}?${returnParams}&purchase=success`,
        cancelUrl: `${base}?${returnParams}&purchase=canceled`,
      },
    }
  );
  const url = data?.data?.url;
  if (!url) throw new Error('Checkout session did not return a URL');
  // Web: Stripe Checkout takes over the tab. Native: it opens in the in-app
  // browser for now; phase 3 replaces this path with StoreKit / Play Billing.
  leaveForHub(url);
}

/* ═══ Server catalog — the marketplace's single source of truth ═══ */

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
  { name: 'Table Skins', grantType: 'table_skin', grantUnit: null },
  { name: 'Throwables', grantType: 'throwable', grantUnit: 'throws' },
  { name: 'Emotes', grantType: 'emote_pack', grantUnit: null },
  { name: 'Avatars', grantType: 'avatar', grantUnit: null },
];

/** Shape guards — the server response is `any` until proven otherwise. */

const isDiamondPkg = (p: unknown): p is DiamondPackage =>
  !!p &&
  typeof (p as DiamondPackage).id === 'string' &&
  Number.isFinite((p as DiamondPackage).diamonds) &&
  Number.isFinite((p as DiamondPackage).priceUsd);

const isVipPlan = (p: unknown): p is VipPlan =>
  !!p &&
  typeof (p as VipPlan).id === 'string' &&
  Number.isFinite((p as VipPlan).priceDiamonds) &&
  Array.isArray((p as VipPlan).features);

const isCategory = (c: unknown): c is ShopCategoryInfo =>
  !!c &&
  typeof (c as ShopCategoryInfo).name === 'string' &&
  typeof (c as ShopCategoryInfo).grantType === 'string';

const pickFulfillableCategories = (raw: unknown): ShopCategoryInfo[] => {
  const picked = pick(raw, isCategory, FALLBACK_SHOP_CATEGORIES).filter(
    (category) => category.grantType !== 'none'
  );
  return picked.length > 0 ? picked : FALLBACK_SHOP_CATEGORIES;
};

function pick<T>(raw: unknown, guard: (v: unknown) => v is T, fallback: T[]): T[] {
  if (!Array.isArray(raw)) return fallback;
  const valid = raw.filter(guard);
  return valid.length > 0 ? valid : fallback;
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
export async function loadStoreCatalog(): Promise<StoreCatalog> {
  if (catalogCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) return catalogCache;
  try {
    const res = await fetch('/api/club-arena/store-catalog');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || 'catalog unavailable');
    catalogCache = {
      diamondPackages: pick(data.diamondPackages, isDiamondPkg, FALLBACK_DIAMOND_PACKAGES),
      vipPlans: pick(data.vipPlans, isVipPlan, FALLBACK_VIP_PLANS),
      // A category with `grantType: none` is not a product. It creates a paid
      // receipt with no executable fulfillment path, so it is never offered.
      shopCategories: pickFulfillableCategories(data.shopCategories),
      fromServer: true,
    };
    catalogFetchedAt = Date.now();
    return catalogCache;
  } catch (err) {
    // Must be reported: a silent failure here used to make the admin form
    // create items that granted nothing, with zero telemetry.
    reportError(err, 'marketplaceShared.loadStoreCatalog');
    return FALLBACK_CATALOG;
  }
}
