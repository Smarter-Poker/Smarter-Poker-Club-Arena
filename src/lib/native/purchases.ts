/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PURCHASES — StoreKit and Play Billing through RevenueCat (native only)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Store readiness, phase 3c. Apple 3.1.1 and Play's Payments policy: diamonds
 * (a consumable) and VIP (auto-renewing) sold INSIDE the app go through the
 * store. This module is reached only from src/pages/marketplace/
 * marketplaceShared.ts's startCheckout(), only when the bridge says native;
 * the web keeps Stripe Checkout untouched.
 *
 * Money never moves here. The SDK completes the store transaction; RevenueCat
 * validates the receipt and POSTs the Hub's webhook; public.fn_iap_settle_event
 * credits through the same idempotent path a Stripe purchase takes
 * (docs/changelog/2026-09-08-in-app-purchases.md). This module's job is to
 * put the right product in front of the store sheet, wait for the credit to
 * appear, and say so.
 *
 * Keys: VITE_REVENUECAT_IOS_KEY / VITE_REVENUECAT_ANDROID_KEY are RevenueCat's
 * PUBLIC SDK keys (they are designed to ship in the binary; the secret keys
 * never leave the dashboard). Unset = the store is not configured on this
 * build, and the purchase button says so instead of failing silently.
 */

import { nativePlatform } from '../appBase';
import { diamondProductId, vipProductId } from '../iapProducts';

let configuredFor: string | null = null;

async function sdk() {
  const { Purchases, LOG_LEVEL } = await import('@revenuecat/purchases-capacitor');
  return { Purchases, LOG_LEVEL };
}

export function storeKeyForThisPlatform(): string | undefined {
  const p = nativePlatform();
  const key =
    p === 'ios'
      ? (import.meta.env.VITE_REVENUECAT_IOS_KEY as string | undefined)
      : p === 'android'
        ? (import.meta.env.VITE_REVENUECAT_ANDROID_KEY as string | undefined)
        : undefined;
  return key && key.trim() ? key.trim() : undefined;
}

/** Configure once per user. The Supabase user id is the RevenueCat app user id (the webhook needs it). */
export async function configurePurchases(userId: string): Promise<boolean> {
  const key = storeKeyForThisPlatform();
  if (!key) return false;
  const { Purchases, LOG_LEVEL } = await sdk();
  if (configuredFor === userId) return true;
  if (configuredFor === null) {
    await Purchases.setLogLevel({ level: import.meta.env.DEV ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN });
    await Purchases.configure({ apiKey: key, appUserID: userId });
  } else {
    await Purchases.logIn({ appUserID: userId });
  }
  configuredFor = userId;
  return true;
}

export type NativePurchaseRequest =
  { kind: 'diamonds'; packageKey: string } | { kind: 'vip'; tier: 'monthly' | 'yearly' | 'annual' };

export interface NativePurchaseResult {
  ok: boolean;
  /** The player closed the sheet. Not an error. */
  cancelled?: boolean;
  productId?: string;
  transactionId?: string;
  error?: string;
}

/** Open the store sheet for one product. Resolves when the store transaction is done (or cancelled). */
export async function purchaseNative(
  userId: string,
  req: NativePurchaseRequest
): Promise<NativePurchaseResult> {
  const configured = await configurePurchases(userId);
  if (!configured) return { ok: false, error: 'store_not_configured' };
  const productId =
    req.kind === 'diamonds' ? diamondProductId(req.packageKey) : vipProductId(req.tier);
  const { Purchases } = await sdk();
  try {
    const { products } = await Purchases.getProducts({ productIdentifiers: [productId] });
    const product = products.find((p) => p.identifier === productId);
    if (!product) return { ok: false, productId, error: 'product_not_in_store' };
    const result = await Purchases.purchaseStoreProduct({ product });
    return { ok: true, productId, transactionId: result.transaction?.transactionIdentifier };
  } catch (e) {
    const err = e as { code?: string | number; message?: string; userCancelled?: boolean };
    if (err?.userCancelled || String(err?.code) === '1' || /cancel/i.test(err?.message || '')) {
      return { ok: false, cancelled: true, productId };
    }
    return { ok: false, productId, error: err?.message || 'purchase_failed' };
  }
}

/** App Store requirement for subscriptions: a Restore Purchases button. */
export async function restoreNativePurchases(
  userId: string
): Promise<{ ok: boolean; error?: string }> {
  const configured = await configurePurchases(userId);
  if (!configured) return { ok: false, error: 'store_not_configured' };
  const { Purchases } = await sdk();
  try {
    await Purchases.restorePurchases();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'restore_failed' };
  }
}

/** The stores' own subscription management screen (App Store requirement). */
export async function openNativeSubscriptionManagement(): Promise<void> {
  const { Purchases } = await sdk();
  const info = await Purchases.getCustomerInfo();
  const url = info.customerInfo.managementURL;
  if (url) {
    const { openInAppBrowser } = await import('./browser');
    await openInAppBrowser(url);
  }
}
