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

export interface MarketplaceItem {
  id: string;
  club_id: string;
  name: string;
  description?: string;
  price: number;
  image_url?: string;
  category?: string;
  item_type?: string | null;
  is_active: boolean;
  purchase_count?: number;
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
}

export const EMPTY_WALLET: WalletInfo = {
  diamonds: 0,
  isVip: false,
  vipTier: null,
  vipExpiresAt: null,
  loaded: false,
};

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
  bonus?: number;
  popular?: boolean;
}

export const CHIP_PACKAGES: ChipPackage[] = [
  { id: 'small', chips: 1000, diamonds: 10 },
  { id: 'medium', chips: 5000, diamonds: 45, bonus: 10 },
  { id: 'large', chips: 10000, diamonds: 80, bonus: 20, popular: true },
  { id: 'mega', chips: 50000, diamonds: 350, bonus: 30 },
  { id: 'ultra', chips: 100000, diamonds: 600, bonus: 50 },
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

export const DIAMOND_PACKAGES: DiamondPackage[] = [
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

export const VIP_PLANS: VipPlan[] = [
  {
    id: 'vip-daily',
    planKey: null,
    checkoutPlan: null,
    name: 'Daily Pass',
    period: '24 hours',
    priceUsd: null,
    priceDiamonds: 150,
    features: ['All VIP table features for 24h', 'Rabbit hunt + stack in BB', 'Great for trying VIP'],
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
  const base = `${window.location.origin}/hub/club-arena/marketplace`;
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
