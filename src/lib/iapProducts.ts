/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  IAP PRODUCTS — what the app sells through the stores, by one naming rule
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Inside the iOS and Android apps, diamonds and VIP go through StoreKit and
 * Play Billing (Apple 3.1.1, Play Payments policy) rather than Stripe. Each
 * store product id is derived from the same rule the database seeds
 * `public.iap_products` with, so the client, App Store Connect, the Play
 * Console and `fn_iap_settle_event` all agree without a lookup:
 *
 *   diamonds   poker.smarter.clubarena.diamonds.<package_key>   (consumable)
 *   VIP        poker.smarter.clubarena.vip.<monthly|yearly>     (auto-renewing)
 *
 * The web is unaffected: Stripe Checkout keeps selling the same packages at
 * the same prices; only the store on the device changes.
 *
 * Migration: 20260908000009_in_app_purchases_settle_through_the_same_idempotent_diamond_.sql
 */

export const IAP_PRODUCT_PREFIX = 'poker.smarter.clubarena';

export type IapVipTier = 'monthly' | 'yearly';

/** The App Store / Play Store product id for a diamond package key ('micro', 'small', ...). */
export function diamondProductId(packageKey: string): string {
  const key = packageKey.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key))
    throw new Error(`invalid diamond package key: ${packageKey}`);
  return `${IAP_PRODUCT_PREFIX}.diamonds.${key}`;
}

/** The App Store / Play Store product id for a VIP tier. Stripe's 'annual' is the store's 'yearly'. */
export function vipProductId(tier: IapVipTier | 'annual'): string {
  const t = tier === 'annual' ? 'yearly' : tier;
  if (t !== 'monthly' && t !== 'yearly') throw new Error(`invalid VIP tier: ${tier}`);
  return `${IAP_PRODUCT_PREFIX}.vip.${t}`;
}

export interface ParsedIapProduct {
  kind: 'diamonds' | 'vip';
  key: string;
}

/** Inverse of the two builders. null for anything that is not ours. */
export function parseIapProductId(productId: string): ParsedIapProduct | null {
  const m = /^poker\.smarter\.clubarena\.(diamonds|vip)\.([a-z0-9][a-z0-9_-]*)$/.exec(productId);
  if (!m) return null;
  if (m[1] === 'vip' && m[2] !== 'monthly' && m[2] !== 'yearly') return null;
  return { kind: m[1] as 'diamonds' | 'vip', key: m[2] };
}
