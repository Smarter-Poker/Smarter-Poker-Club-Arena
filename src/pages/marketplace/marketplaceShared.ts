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
  is_active: boolean;
  purchase_count?: number;
  /** admin view only — real revenue from price_paid */
  revenue?: number;
}

/** Seconds of table time granted per time-bank use (fn_time_bank_allowance). */
export const SECONDS_PER_TIME_BANK_USE = 20;

/**
 * Human-readable summary of what redeeming an item gives you.
 * Returns null when the item grants nothing automatically.
 */
export function describeGrant(spec?: GrantSpec | null): string | null {
  if (!spec || spec.type === 'none') return null;
  const qty = Math.max(1, Number(spec.qty) || 1);
  switch (spec.type) {
    case 'time_bank':
      return `+${qty * SECONDS_PER_TIME_BANK_USE}s table time (${qty} uses)`;
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
  return row.status !== 'redeemed';
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Only https or same-origin paths may be used as an item image. */
export function safeImageUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const v = String(raw).trim();
  if (!v) return null;
  if (v.startsWith('/')) return v;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

/** crypto.randomUUID is unavailable on http origins and older Safari. */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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

export const FALLBACK_CATALOG: StoreCatalog = {
  chipPackages: FALLBACK_CHIP_PACKAGES,
  diamondPackages: FALLBACK_DIAMOND_PACKAGES,
  vipPlans: FALLBACK_VIP_PLANS,
  shopCategories: CATEGORIES.filter((c) => c !== 'All').map((name) => ({
    name,
    grantType: 'none' as GrantSpec['type'],
    grantUnit: null,
  })),
  fromServer: false,
};

let catalogCache: StoreCatalog | null = null;

/**
 * Load the package/plan catalog from the server so displayed prices can never
 * drift from what the charging routes actually bill. Falls back to the bundled
 * tables if the request fails, so the storefront still renders offline.
 */
export async function loadStoreCatalog(): Promise<StoreCatalog> {
  if (catalogCache) return catalogCache;
  try {
    const res = await fetch('/api/club-arena/store-catalog');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || 'catalog unavailable');
    catalogCache = {
      chipPackages:
        Array.isArray(data.chipPackages) && data.chipPackages.length
          ? data.chipPackages
          : FALLBACK_CHIP_PACKAGES,
      diamondPackages:
        Array.isArray(data.diamondPackages) && data.diamondPackages.length
          ? data.diamondPackages
          : FALLBACK_DIAMOND_PACKAGES,
      vipPlans:
        Array.isArray(data.vipPlans) && data.vipPlans.length ? data.vipPlans : FALLBACK_VIP_PLANS,
      shopCategories:
        Array.isArray(data.shopCategories) && data.shopCategories.length
          ? data.shopCategories
          : FALLBACK_CATALOG.shopCategories,
      fromServer: true,
    };
    return catalogCache;
  } catch {
    return FALLBACK_CATALOG;
  }
}
