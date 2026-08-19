/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MARKETPLACE — shared types, catalogs, and the /api/store fetch helper
 *  Split out of MarketplacePage.tsx in the 2026-08-19 rebuild.
 *
 *  IMPORTANT: every package/plan list here is DISPLAY COPY ONLY. The server
 *  holds the authoritative price tables:
 *    - chip packages:    WH pages/api/club-arena/purchase-chips.js
 *    - diamond packages: WH pages/api/store/create-checkout-session.js
 *    - VIP plans:        WH src/data/diamondStoreData.js + store routes
 *  The client only ever sends ids/plan keys — never amounts or prices.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';

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
  is_active: boolean;
  purchase_count?: number;
  /** admin view only — real revenue from price_paid */
  revenue?: number;
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
      return `+${qty * secondsPerUse}s table time (${qty} uses)`;
    case 'throwable':
      return `${qty} free ${qty === 1 ? 'throw' : 'throws'}`;
    case 'emote_pack':
      return 'Unlocks the emote pack';
    case 'table_skin':
      return 'Unlocks the table theme';
    case 'avatar':
      return 'Unlocks the avatar';
    default:
      return null;
  }
}

export interface ShopPurchase {
  id: string;
  item_id: string;
  price_paid: number;
  created_at: string;
  item_name?: string | null;
  item_category?: string | null;
}

export interface InventoryRow {
  id: string;
  item_id?: string | null;
  item_name: string | null;
  category: string | null;
  price_paid: number;
  status: string;
  acquired_at: string;
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
export function isOwnedRow(row: { status?: string | null }): boolean {
  // Vocabulary written today: 'owned' | 'redeemed' (fn_deliver_shop_purchase /
  // fn_redeem_shop_item). Fail-safe: anything not explicitly redeemed still
  // belongs to the player. A future 'refunded'/'revoked' status MUST be added
  // here, or those rows become permanently un-rebuyable.
  return row.status !== 'redeemed';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

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

export { uuid } from '../../utils/uuid';

/* ═══ Club shop categories (must match WH shop-items.js VALID_CATEGORIES) ═══ */

export const CATEGORIES = [
  'All',
  'Time Banks',
  'Table Skins',
  'Throwables',
  'Emotes',
  'Avatars',
  'Exclusive',
];

export type SortMode = 'newest' | 'price-low' | 'price-high' | 'popular';

/* ═══ Chip packages — mirrors server table in /api/club-arena/purchase-chips ═══ */

export interface ChipPackage {
  id: string;
  chips: number;
  diamonds: number;
  /** premium over the base rate, computed server-side */
  valuePct?: number;
  bonus?: number;
  popular?: boolean;
}

// bonus = real extra value vs the base rate (small pack = 100 chips/diamond),
// e.g. large = 10000/80 = 125 chips/diamond = +25%. Server table is authoritative.
const FALLBACK_CHIP_PACKAGES: ChipPackage[] = [
  { id: 'small', chips: 1000, diamonds: 10 },
  { id: 'medium', chips: 5000, diamonds: 45, bonus: 11 },
  { id: 'large', chips: 10000, diamonds: 80, bonus: 25, popular: true },
  { id: 'mega', chips: 50000, diamonds: 350, bonus: 43 },
  { id: 'ultra', chips: 100000, diamonds: 600, bonus: 67 },
];

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
  /** key sent to /api/store/purchase-vip-with-diamonds ('monthly' | 'annual') */
  planKey: 'monthly' | 'annual' | null;
  /** plan id sent to create-checkout-session for Stripe ('vip-monthly' | 'vip-annual') */
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

const FALLBACK_VIP_PLANS: VipPlan[] = [
  {
    id: 'vip-daily',
    planKey: null,
    checkoutPlan: null,
    name: 'Daily Pass',
    period: '24 hours',
    priceUsd: null,
    priceDiamonds: 150,
    features: [
      'All VIP table features for 24h',
      'Rabbit hunt + stack in BB',
      'Great for trying VIP',
    ],
  },
  {
    id: 'vip-monthly',
    planKey: 'monthly',
    checkoutPlan: 'vip-monthly',
    name: 'Monthly VIP',
    period: 'per month',
    priceUsd: 19.99,
    priceDiamonds: 1999,
    features: [
      'All VIP features, all month',
      'Daily + monthly diamond bonuses',
      'Time bank, offline protection, throwables',
      'VIP badge across Smarter.Poker',
    ],
    featured: true,
  },
  {
    id: 'vip-annual',
    planKey: 'annual',
    checkoutPlan: 'vip-annual',
    name: 'Annual VIP',
    period: 'per year',
    priceUsd: 199.99,
    priceDiamonds: 19999,
    features: ['Everything in Monthly', 'Two months free vs monthly', 'Best long-run value'],
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
  loaded: boolean;
}

export const EMPTY_ENTITLEMENTS: Entitlements = Object.freeze({
  timeBankUses: 0,
  timeBankSeconds: 0,
  throwables: 0,
  emotePack: false,
  themeUnlock: false,
  avatars: [],
  loaded: false,
});

/**
 * Read the player's live entitlement balances. Both tables are RLS-scoped to
 * the caller (feature_purchases_select_own / "Users can view their own
 * unlocks"), so this is a safe direct read.
 */
export async function loadEntitlements(
  userId: string,
  secondsPerUse = DEFAULT_SECONDS_PER_TIME_BANK_USE
): Promise<Entitlements> {
  const nowIso = new Date().toISOString();
  const [fp, av] = await Promise.all([
    supabase
      .from('feature_purchases')
      .select('feature, uses_remaining, expires_at')
      .eq('user_id', userId),
    supabase.from('avatar_unlocks').select('avatar_id').eq('user_id', userId),
  ]);
  if (fp.error) throw fp.error;

  const live = (fp.data || []).filter((r) => !r.expires_at || r.expires_at > nowIso);
  const sumUses = (feature: string) =>
    live
      .filter((r) => r.feature === feature)
      .reduce((n, r) => n + (Number(r.uses_remaining) || 0), 0);
  const hasPermanent = (feature: string) =>
    live.some((r) => r.feature === feature && r.uses_remaining == null);

  const timeBankUses = sumUses('time_bank_seconds');
  return {
    timeBankUses,
    timeBankSeconds: timeBankUses * secondsPerUse,
    throwables: sumUses('throwable'),
    emotePack: hasPermanent('emoji_pack'),
    themeUnlock: hasPermanent('theme_unlock'),
    avatars: (av.data || []).map((r) => String(r.avatar_id)),
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

/**
 * Start a Stripe Checkout session and redirect. type 'diamonds' | 'subscription'.
 * The server only honours return URLs on its own origin; anything else falls
 * back to /hub/diamond-store, which is acceptable.
 */
export async function startCheckout(
  type: 'diamonds' | 'subscription',
  items: Record<string, unknown>[],
  returnParams: string
): Promise<void> {
  const base = `${window.location.origin}${window.location.pathname}`;
  const data = await storeFetch<{ success: true; data: { url: string } }>(
    '/api/store/create-checkout-session',
    {
      body: {
        type,
        items,
        successUrl: `${base}?${returnParams}&purchase=success`,
        cancelUrl: `${base}?${returnParams}&purchase=canceled`,
      },
    }
  );
  const url = data?.data?.url;
  if (!url) throw new Error('Checkout session did not return a URL');
  window.location.assign(url);
}

/* ═══ Server catalog — the marketplace's single source of truth ═══ */

export interface ShopCategoryInfo {
  name: string;
  grantType: GrantSpec['type'];
  grantUnit: string | null;
  secondsPerUse?: number;
}

export interface StoreCatalog {
  chipPackages: ChipPackage[];
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
  { name: 'Exclusive', grantType: 'none', grantUnit: null },
];

/** Shape guards — the server response is `any` until proven otherwise. */
const isChipPkg = (p: unknown): p is ChipPackage =>
  !!p &&
  typeof (p as ChipPackage).id === 'string' &&
  Number.isFinite((p as ChipPackage).chips) &&
  Number.isFinite((p as ChipPackage).diamonds);

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

function pick<T>(raw: unknown, guard: (v: unknown) => v is T, fallback: T[]): T[] {
  if (!Array.isArray(raw)) return fallback;
  const valid = raw.filter(guard);
  return valid.length > 0 ? valid : fallback;
}

export const FALLBACK_CATALOG: StoreCatalog = {
  chipPackages: FALLBACK_CHIP_PACKAGES,
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
      chipPackages: pick(data.chipPackages, isChipPkg, FALLBACK_CHIP_PACKAGES),
      diamondPackages: pick(data.diamondPackages, isDiamondPkg, FALLBACK_DIAMOND_PACKAGES),
      vipPlans: pick(data.vipPlans, isVipPlan, FALLBACK_VIP_PLANS),
      shopCategories: pick(data.shopCategories, isCategory, FALLBACK_SHOP_CATEGORIES),
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
