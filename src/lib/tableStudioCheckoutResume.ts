/**
 * Durable hand-off between Table Studio and Stripe Checkout.
 *
 * Stripe leaves the SPA, so component state cannot remember which locked
 * design sent the player to buy diamonds. Keep only the minimum, non-financial
 * intent in session storage. Prices and ownership are deliberately NOT stored:
 * Table Studio re-reads both from the server before it offers the purchase
 * again.
 */

export type TableStudioCheckoutTab = 'themes' | 'table' | 'button' | 'background' | 'cards';

export interface TableStudioCheckoutIntent {
  userId: string;
  tab: TableStudioCheckoutTab;
  assetId: string;
  createdAt: number;
}

export type TableStudioCheckoutResult = 'success' | 'canceled';

const STORAGE_KEY = 'table-studio-checkout-intent:v1';
const MAX_INTENT_AGE_MS = 2 * 60 * 60 * 1_000;
const VALID_TABS = new Set<TableStudioCheckoutTab>([
  'themes',
  'table',
  'button',
  'background',
  'cards',
]);

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberTableStudioCheckoutIntent(
  intent: Omit<TableStudioCheckoutIntent, 'createdAt'>
): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...intent, createdAt: Date.now() }));
  } catch {
    // A blocked storage API must never block checkout. The return path simply
    // cannot auto-resume and the player may reopen the Studio normally.
  }
}

export function clearTableStudioCheckoutIntent(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Best effort only; reads still reject expired or malformed entries.
  }
}

export function readTableStudioCheckoutIntent(
  expectedUserId?: string
): TableStudioCheckoutIntent | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TableStudioCheckoutIntent>;
    const age = typeof parsed.createdAt === 'number' ? Date.now() - parsed.createdAt : Number.NaN;
    const valid =
      typeof parsed.userId === 'string' &&
      !!parsed.userId &&
      typeof parsed.tab === 'string' &&
      VALID_TABS.has(parsed.tab as TableStudioCheckoutTab) &&
      typeof parsed.assetId === 'string' &&
      !!parsed.assetId &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= MAX_INTENT_AGE_MS &&
      (!expectedUserId || parsed.userId === expectedUserId);
    if (!valid) {
      clearTableStudioCheckoutIntent();
      return null;
    }
    return parsed as TableStudioCheckoutIntent;
  } catch {
    clearTableStudioCheckoutIntent();
    return null;
  }
}

export function tableStudioCheckoutResult(
  search: string = typeof window === 'undefined' ? '' : window.location.search
): TableStudioCheckoutResult | null {
  const params = new URLSearchParams(search);
  if (params.get('from') !== 'table-studio') return null;
  const result = params.get('purchase');
  return result === 'success' || result === 'canceled' ? result : null;
}

/** Remove only the checkout hand-off keys; preserve table, club and game links. */
export function clearTableStudioCheckoutReturnUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('from');
  url.searchParams.delete('purchase');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export const TABLE_STUDIO_CHECKOUT_RETURN_PARAMS = 'from=table-studio';
