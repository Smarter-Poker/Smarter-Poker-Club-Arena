/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA : MARKETPLACE / CASHIER STOREFRONT (2026-08-19 full rebuild)
 *
 *  Tabs:
 *    Store       : club shop items bought with DIAMONDS from the player's
 *                  global wallet (server-authoritative). The marketplace is
 *                  fully funded by diamonds, never chips (Dan, 2026-08-23).
 *    (Get Chips was removed 2026-08-19: chips are won and transferred,
 *     never bought. The diamonds -> chips conversion no longer exists.)
 *    Diamonds    : real-money diamond packages via Stripe Checkout (/api/store)
 *    Membership  : monthly, yearly, or Lifetime VIP (Diamonds or Card when verified)
 *    My Items    : delivered inventory (club_shop_inventory) + redemption + history
 *    Manage      : owner/admin CRUD via /api/club-arena/manage-shop (RLS-safe)
 *
 *  Every price is resolved server-side. The client sends only ids/plan keys.
 *  Tab components live in ./marketplace/.
 *
 *  2026-08-19 audit pass:
 *   - Reacts to ?club= / ?tab= changes while mounted (club quick links navigate
 *     here with a new club without remounting the route).
 *   - Ownership = an UNREDEEMED club_shop_inventory row (consumables can be
 *     re-bought after redemption); inventory loads eagerly for that reason.
 *   - Non-admins deep-linking ?tab=manage get a notice instead of a blank page.
 *
 *  2026-09-21 ONE MARKETPLACE (Dan): "CLUB ARENA MARKETPLACE, SHOULD BE THE
 *  EXACT SAME PAGES AS THE MARKETPLACE THAT EXISTS IN THE WORLD HUB." On the
 *  web, /marketplace now opens the World Hub marketplace page that shows the
 *  same thing (src/pages/MarketplaceRoute.tsx, src/utils/hubMarketplace.ts).
 *  This storefront renders only in the native app, where StoreKit / Play
 *  Billing must sell, and for a card checkout returning here to be verified.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { useUserStore } from '../stores/useUserStore';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { fmt } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import { safeInAppRedirect } from '../lib/signIn';
import { DIAMOND_ARENA_SLUG } from '../lib/constants';
import styles from './MarketplacePage.module.css';
import {
  EMPTY_ENTITLEMENTS,
  EMPTY_WALLET,
  FALLBACK_CATALOG,
  currentMarketplaceCheckoutUserMatches,
  isOwnedRow,
  isMarketplaceItemOwned,
  isUuid,
  loadEntitlements,
  loadStoreCatalog,
  loadWalletInfo,
  readMarketplacePurchaseIntentByRequestId,
  retireMarketplacePurchaseIntentByRequestId,
  storeFetch,
  verifiedMarketplaceCardCheckoutStatus,
  verifiedMarketplaceItems,
  type Entitlements,
  type InventoryRow,
  type MarketplaceItem,
  type ShopPurchase,
  type StoreCatalog,
  type WalletInfo,
} from './marketplace/marketplaceShared';
import StoreTab from './marketplace/StoreTab';
import DiamondsTab from './marketplace/DiamondsTab';
import MembershipTab from './marketplace/MembershipTab';
import MyItemsTab from './marketplace/MyItemsTab';
import ManageTab from './marketplace/ManageTab';
// Banners are not toasts, so they never went through the Toast layer's Title
// Case / em-dash transform. They are the only user-facing strings on this page
// that render raw server text.
import { formatPopupText } from '../utils/popupStyle';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';

type TabKey = 'store' | 'diamonds' | 'membership' | 'my_items' | 'manage';
const VALID_TABS: TabKey[] = ['store', 'diamonds', 'membership', 'my_items', 'manage'];
const CARD_CHECKOUT_STATUS_DELAYS_MS = [0, 1500, 3500, 7000, 12000] as const;
const CARD_CHECKOUT_STATUS_TIMEOUT_MS = 15000;
const STRIPE_CHECKOUT_RETURN_ID = /^cs_(?:test|live)_[A-Za-z0-9]{6,255}$/;

function cardCheckoutTypeForScope(
  scope: string,
  userId: string
): 'diamonds' | 'subscription' | null {
  const diamondPrefix = `marketplace:diamond-package-card:${userId}:`;
  const vipPrefix = `marketplace:vip-card:${userId}:`;
  if (scope.startsWith(diamondPrefix) && scope.length > diamondPrefix.length) return 'diamonds';
  if (scope.startsWith(vipPrefix) && scope.length > vipPrefix.length) return 'subscription';
  return null;
}

export default function MarketplacePage() {
  const { user } = useAuthUser();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  const activeUserIdRef = useRef(user?.id);
  useLayoutEffect(() => {
    locationRef.current = location;
    activeUserIdRef.current = user?.id;
  }, [location, user?.id]);

  const qClubParam = searchParams.get('club') || searchParams.get('clubId');
  const qTabParam = searchParams.get('tab');

  const initialTab = ((): TabKey => {
    const t = qTabParam as TabKey | null;
    return t && VALID_TABS.includes(t) ? t : 'store';
  })();

  const [tab, setTab] = useState<TabKey>(initialTab);
  const [loading, setLoading] = useState(true);
  const [clubId, setClubId] = useState<string | null>(null);
  const [role, setRole] = useState('player');
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [purchases, setPurchases] = useState<ShopPurchase[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [balance, setBalance] = useState(0);
  const [shopScope, setShopScope] = useState<string | null>(null);
  const [inventoryScope, setInventoryScope] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletInfo>(EMPTY_WALLET);
  const [walletOwnerId, setWalletOwnerId] = useState<string | null>(null);
  const activeWallet = user?.id && walletOwnerId === user.id ? wallet : EMPTY_WALLET;
  const [shopError, setShopError] = useState<string | null>(null);
  const [shopErrorScope, setShopErrorScope] = useState<string | null>(null);
  const [loadingScope, setLoadingScope] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [catalog, setCatalog] = useState<StoreCatalog>(FALLBACK_CATALOG);
  const [entitlements, setEntitlements] = useState<Entitlements>(EMPTY_ENTITLEMENTS);
  const [entitlementsOwnerId, setEntitlementsOwnerId] = useState<string | null>(null);

  // Toasts render through a document-level portal. Scope their success color
  // while this route is mounted so Marketplace never inherits the shared
  // positive success treatment, without changing any other Club Arena surface.
  useEffect(() => {
    document.body.classList.add('marketplace-color-scope');
    return () => document.body.classList.remove('marketplace-color-scope');
  }, []);

  const mountedRef = useIsMounted();
  // Monotonic request token: only the newest load may write state. Replaces the
  // old loadingRef guard, which every caller had to defeat and which dropped
  // (rather than queued) refreshes that arrived during an in-flight load.
  const reqRef = useRef(0);
  const walletReqRef = useRef(0);
  const invReqRef = useRef(0);
  const entReqRef = useRef(0);
  // Mirrors clubId for the init effect without adding it as a dependency.
  const clubIdRef = useRef<string | null>(null);

  /** Drop everything scoped to a club (switch, invalid link, or no club). */
  const resetClubState = useCallback(() => {
    reqRef.current += 1;
    invReqRef.current += 1;
    setItems([]);
    setPurchases([]);
    setInventory([]);
    setBalance(0);
    setShopScope(null);
    setInventoryScope(null);
    setRole('player');
    setShopError(null);
    setShopErrorScope(null);
    setLoadingScope(null);
  }, []);

  // Server-owned package/plan catalog so displayed prices cannot drift.
  useEffect(() => {
    let alive = true;
    loadStoreCatalog().then((c) => {
      if (alive && mountedRef.current) setCatalog(c);
    });
    return () => {
      alive = false;
    };
  }, [mountedRef]);

  // A mounted storefront may outlive the catalog TTL. Every purchase asks for
  // strict server truth again and also refreshes the displayed rail, so a
  // repriced package can never be authorized from stale copy.
  const refreshCatalogForPurchase = useCallback(async () => {
    const freshCatalog = await loadStoreCatalog({ force: true });
    if (mountedRef.current) setCatalog(freshCatalog);
    return freshCatalog;
  }, [mountedRef]);

  /* ═══ Club shop data : via /api/club-arena/marketplace-items ═══ */
  const loadShop = useCallback(
    async (cId?: string, silent = false) => {
      const targetClub = cId || clubId;
      const expectedAccountId = activeUserIdRef.current;
      if (!targetClub || !expectedAccountId) return;
      const expectedScope = `${expectedAccountId}:${targetClub}`;
      const myReq = ++reqRef.current;
      try {
        setLoadingScope(expectedScope);
        if (!silent) setLoading(true);
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token || session?.user?.id !== expectedAccountId) {
          throw new Error('Not authenticated');
        }

        const fetchWithThrow = async () => {
          const response = await fetch(
            `/api/club-arena/marketplace-items?clubId=${encodeURIComponent(targetClub)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!response.ok) {
            const errBody = await response
              .json()
              .catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error(errBody.error || `Failed to load shop (${response.status})`);
          }
          return response.json();
        };

        const data = await retryAsync(fetchWithThrow, 2);
        // Only the newest request may write: a club switch fires a second load
        // while the first is still in flight, and the loser must not win.
        const authenticatedAccountStillActive =
          await currentMarketplaceCheckoutUserMatches(expectedAccountId);
        if (
          !authenticatedAccountStillActive ||
          !mountedRef.current ||
          myReq !== reqRef.current ||
          activeUserIdRef.current !== expectedAccountId ||
          clubIdRef.current !== targetClub
        ) {
          return;
        }

        const verifiedItems = verifiedMarketplaceItems(data?.items);
        if (
          data?.success !== true ||
          data?.accountId !== expectedAccountId ||
          data?.clubId !== targetClub ||
          !verifiedItems ||
          verifiedItems.some((item) => item.club_id !== targetClub) ||
          !Array.isArray(data.purchases) ||
          !Number.isSafeInteger(data.balance) ||
          typeof data.role !== 'string'
        ) {
          throw new Error('The Shop Returned An Unverified Catalog Response.');
        }
        setItems(verifiedItems);
        setPurchases(data.purchases);
        setBalance(data.balance);
        setRole(data.role);
        setShopScope(expectedScope);
        setShopError(null);
        setShopErrorScope(null);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to load shop';
        // Always report. Silent refreshes previously failed with no toast, no
        // error-reporting event and no state change -- the shop just went quietly stale.
        reportError(err, 'MarketplacePage.loadShop');
        if (
          mountedRef.current &&
          myReq === reqRef.current &&
          activeUserIdRef.current === expectedAccountId &&
          clubIdRef.current === targetClub
        ) {
          setShopError(msg);
          setShopErrorScope(expectedScope);
          // Toast only for the current request: a superseded club-A failure
          // must not pop an error over club B's freshly loaded shop.
          if (!silent) toast.error(msg);
        }
      } finally {
        if (
          mountedRef.current &&
          myReq === reqRef.current &&
          activeUserIdRef.current === expectedAccountId &&
          clubIdRef.current === targetClub
        ) {
          setLoading(false);
        }
      }
    },
    [clubId, user?.id] // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ═══ Diamond balance + VIP status ═══ */
  const loadWallet = useCallback(
    async (expectedAccountId = activeUserIdRef.current, signal?: AbortSignal) => {
      if (!expectedAccountId) return;
      const myReq = ++walletReqRef.current;
      try {
        const info = await loadWalletInfo(expectedAccountId, signal);
        if (!(await currentMarketplaceCheckoutUserMatches(expectedAccountId, signal))) {
          return;
        }
        if (
          mountedRef.current &&
          myReq === walletReqRef.current &&
          activeUserIdRef.current === expectedAccountId
        ) {
          setWallet(info);
          setWalletOwnerId(expectedAccountId);
        }
      } catch (err) {
        if ((err as { name?: unknown })?.name === 'AbortError') throw err;
        reportError(err, 'MarketplacePage.loadWallet');
        // Never leave the UI asserting "you have 0 diamonds" when we simply
        // could not read the balance -- that silently disables every buy button.
        if (
          mountedRef.current &&
          myReq === walletReqRef.current &&
          activeUserIdRef.current === expectedAccountId
        ) {
          setWallet({
            ...EMPTY_WALLET,
            loaded: false,
            error: err instanceof Error ? err.message : 'Could not load your balance',
          });
          setWalletOwnerId(expectedAccountId);
        }
      }
    },
    [mountedRef]
  );

  // A response from the previous account must never authorize a purchase for
  // the next one. Invalidate every in-flight read and revoke loaded state as
  // soon as the authenticated account changes or signs out.
  useEffect(() => {
    reqRef.current += 1;
    walletReqRef.current += 1;
    invReqRef.current += 1;
    entReqRef.current += 1;
    setClubId(null);
    clubIdRef.current = null;
    setItems([]);
    setPurchases([]);
    setInventory([]);
    setBalance(0);
    setShopScope(null);
    setInventoryScope(null);
    setRole('player');
    setShopError(null);
    setShopErrorScope(null);
    setLoadingScope(null);
    setWallet(EMPTY_WALLET);
    setWalletOwnerId(null);
    setEntitlements(EMPTY_ENTITLEMENTS);
    setEntitlementsOwnerId(null);
    setLoading(Boolean(user?.id));
    setRefreshing(false);
  }, [user?.id]);

  /* ═══ Live entitlement balances (what redemption actually granted) ═══ */
  const secondsPerUse =
    catalog.shopCategories.find((c) => c.grantType === 'time_bank')?.secondsPerUse ?? 20;

  const loadEnt = useCallback(
    async (requestedAccountId?: string) => {
      const expectedAccountId = requestedAccountId || activeUserIdRef.current;
      if (!expectedAccountId) return;
      const myReq = ++entReqRef.current;
      try {
        const e = await loadEntitlements(expectedAccountId, secondsPerUse);
        const authenticatedAccountStillActive =
          await currentMarketplaceCheckoutUserMatches(expectedAccountId);
        if (
          authenticatedAccountStillActive &&
          mountedRef.current &&
          myReq === entReqRef.current &&
          activeUserIdRef.current === expectedAccountId
        ) {
          setEntitlements(e);
          setEntitlementsOwnerId(expectedAccountId);
        }
      } catch (err) {
        reportError(err, 'MarketplacePage.loadEntitlements');
      }
    },
    [secondsPerUse, mountedRef]
  );

  // Ownership drives Store buttons, so entitlements are eager rather than
  // waiting for the member to visit My Items.
  useEffect(() => {
    loadEnt();
  }, [loadEnt, user?.id]);

  /* ═══ Delivered inventory (loaded eagerly : ownership state depends on it) ═══ */
  const loadInventory = useCallback(
    async (cId?: string, silent = true) => {
      const target = cId || clubId;
      const expectedAccountId = activeUserIdRef.current;
      if (!target || !expectedAccountId) return;
      const expectedScope = `${expectedAccountId}:${target}`;
      const myReq = ++invReqRef.current;
      try {
        // supabase-js resolves (never rejects) on RLS/network failure, so the
        // error MUST be destructured -- otherwise a failure looked exactly like
        // "you own nothing" and invited the user to re-buy what they already had.
        const { data, error } = await supabase
          .from('club_shop_inventory')
          .select(
            'id, item_id, purchase_id, item_name, category, price_paid, status, acquired_at, redeemed_at'
          )
          .eq('club_id', target)
          .eq('user_id', expectedAccountId)
          .order('acquired_at', { ascending: false });
        if (error) throw error;
        // Same stale-response guard as loadShop: on a club switch the older
        // query can resolve last, and ownership state drives the Buy buttons.
        const authenticatedAccountStillActive =
          await currentMarketplaceCheckoutUserMatches(expectedAccountId);
        if (
          authenticatedAccountStillActive &&
          mountedRef.current &&
          myReq === invReqRef.current &&
          activeUserIdRef.current === expectedAccountId &&
          clubIdRef.current === target
        ) {
          setInventory(data || []);
          setInventoryScope(expectedScope);
        }
      } catch (err) {
        reportError(err, 'MarketplacePage.loadInventory');
        if (
          !silent &&
          mountedRef.current &&
          myReq === invReqRef.current &&
          activeUserIdRef.current === expectedAccountId &&
          clubIdRef.current === target
        ) {
          toast.error('Could not load your items. Tap Refresh to try again.');
        }
      }
    },
    [clubId, mountedRef] // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ═══ Init + react to ?club= changes (club quick links navigate in place) ═══ */
  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    const init = async () => {
      let targetClub: string | null = null;
      if (qClubParam) {
        // Accept both UUIDs and legacy 6-digit club codes
        // resolveClubUUID never throws - it swallows the miss, warns, and
        // returns the raw param, which is exactly what the catch did. Optional
        // catch binding so the belt costs no unused variable.
        try {
          targetClub = await resolveClubUUID(qClubParam);
        } catch {
          targetClub = qClubParam;
        }
      }
      if (!targetClub) {
        /*
         * WHICH CLUB'S SHOP? Not "the first membership row PostgREST hands
         * back". That read was `.limit(1)` with no ORDER BY, so a player in
         * five clubs landed on whichever one the planner returned first - for
         * Dan, Deep Stack Society with zero items, while Shark Club had twelve
         * on sale. The page then said "The Club Shop Is Currently Empty" and
         * he concluded diamonds could not buy anything (2026-09-04).
         *
         * Order of preference: the club the player is currently inside; then
         * the club with the most active stock; then any membership at all.
         */
        const { data: mems, error: memsError } = await supabase
          .from('club_members')
          .select('club_id')
          .eq('user_id', user.id);
        if (memsError) reportError(memsError, 'MarketplacePage.resolveClub.memberships');
        const memberClubIds = (mems || [])
          .map((m) => m.club_id as string)
          .filter((id): id is string => Boolean(id));
        const insideClub = useUserStore.getState().currentClubId;
        if (insideClub && memberClubIds.includes(insideClub)) {
          targetClub = insideClub;
        } else if (memberClubIds.length > 0) {
          const { data: stock, error: stockError } = await supabase
            .from('club_shop_items')
            .select('club_id')
            .in('club_id', memberClubIds)
            .eq('is_active', true);
          // A failed stock read is not a reason to have no shop: report it and
          // fall through to the first membership, which is what the page did
          // before it learned to prefer stock.
          if (stockError) reportError(stockError, 'MarketplacePage.resolveClub.stock');
          const counts = new Map<string, number>();
          for (const row of stock || []) {
            const id = row.club_id as string;
            counts.set(id, (counts.get(id) || 0) + 1);
          }
          targetClub =
            memberClubIds.slice().sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0))[0] ||
            null;
        }
      }
      if (!isMounted) return;
      if (targetClub && !isUuid(targetClub)) {
        // Do NOT keep browsing the previous club's shop behind an invalid URL.
        toast.error('That club link looks invalid.');
        setClubId(null);
        clubIdRef.current = null;
        resetClubState();
        setLoading(false);
        loadWallet();
        return;
      }
      if (targetClub) {
        // Reset club-scoped state OUTSIDE the setState updater -- updaters must
        // be pure, and React 19 StrictMode double-invokes them.
        setClubId((prev) => (prev === targetClub ? prev : targetClub));
        if (clubIdRef.current && clubIdRef.current !== targetClub) resetClubState();
        clubIdRef.current = targetClub;
        // targetClub passed EXPLICITLY: the closed-over clubId is a render
        // behind here, and this effect's dep array deliberately omits it. Do
        // not drop the argument.
        loadShop(targetClub);
        loadInventory(targetClub);
      } else {
        toast.error('No club found. Join a club to use the club shop.');
        setClubId(null);
        clubIdRef.current = null;
        resetClubState();
        setLoading(false);
      }
      loadWallet();
    };
    init();
    return () => {
      isMounted = false;
    };
  }, [user?.id, qClubParam]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ═══ React to ?tab= changes from external navigation ═══ */
  useEffect(() => {
    const t = qTabParam as TabKey | null;
    if (t && VALID_TABS.includes(t)) {
      setTab((prev) => (prev === t ? prev : t));
    }
  }, [qTabParam]);

  /* ═══ Inventory: the init effect loads it for the resolved club; this keeps
   * it fresh if clubId is set by any other route. ═══ */
  useEffect(() => {
    if (clubId) loadInventory(clubId);
  }, [clubId, loadInventory]);

  /* ═══ Stripe Checkout return handling (?purchase=success|canceled) ═══ */
  const purchaseResult = searchParams.get('purchase');
  const checkoutSessionId = searchParams.get('session_id');
  const checkoutRequestId = searchParams.get('checkout_request_id');
  const purchaseHandledRef = useRef<string | null>(null);
  /* WHERE THE DIAMONDS ARE GOING (phase 3, 2026-09-14). The wallet sends a
     player who is short of the cheapest Diamond Arena seat here with
     `?next=/clubs/diamond-arena`; the checkout carries it through the Stripe
     (or StoreKit) round trip, and when the player lands back on
     `?purchase=success` the page offers the way onward instead of leaving
     them on the store. Same validator the sign-in redirect uses: an in-app
     path or nothing. THE DIAMOND ARENA IS DIAMONDS ONLY. */
  const nextParam = searchParams.get('next');
  const nextPath = useMemo(() => {
    if (!nextParam) return null;
    const safe = safeInAppRedirect(nextParam);
    return safe === '/' ? null : safe;
  }, [nextParam]);
  const [verifiedContinuation, setVerifiedContinuation] = useState<{
    ownerId: string;
    path: string;
  } | null>(null);
  const continueLabel =
    verifiedContinuation?.path === `/clubs/${DIAMOND_ARENA_SLUG}`
      ? 'Continue To The Diamond Arena'
      : 'Continue';
  const goOnward = () => {
    const destination = verifiedContinuation?.path;
    if (!destination || verifiedContinuation.ownerId !== user?.id) return;
    setVerifiedContinuation(null);
    navigate(destination);
  };
  const pollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Always call the freshest loadWallet without making it an effect dependency
  // (`user` is a new object on every auth-store write, so depending on the
  // callback identity tore the timers down repeatedly).
  const loadWalletRef = useRef(loadWallet);
  useLayoutEffect(() => {
    loadWalletRef.current = loadWallet;
  }, [loadWallet]);

  useEffect(() => {
    if (!purchaseResult) {
      purchaseHandledRef.current = null;
      return;
    }
    const returnIdentity = [
      purchaseResult,
      checkoutSessionId || '',
      checkoutRequestId || '',
      user?.id || '',
    ].join(':');
    if (purchaseHandledRef.current === returnIdentity) return;

    const clearReturnUrl = () => {
      const current = locationRef.current;
      const next = new URLSearchParams(current.search);
      next.delete('purchase');
      next.delete('session_id');
      next.delete('checkout_request_id');
      navigate(
        {
          pathname: current.pathname,
          search: next.toString() ? `?${next.toString()}` : '',
          hash: current.hash,
        },
        { replace: true }
      );
    };

    if (purchaseResult === 'canceled') {
      purchaseHandledRef.current = returnIdentity;
      toast.error('Checkout Closed. No Completed Payment Was Verified.');
      // A canceled Checkout session can remain payable. Keep its durable key
      // so a deliberate retry recovers the same provider session.
      clearReturnUrl();
      return;
    }
    if (purchaseResult !== 'success') {
      purchaseHandledRef.current = returnIdentity;
      toast.error('Checkout Return Could Not Be Verified.');
      clearReturnUrl();
      return;
    }
    if (!user?.id) return;

    purchaseHandledRef.current = returnIdentity;
    let cancelled = false;
    let activeStatusController: AbortController | null = null;
    let locatedIntent: ReturnType<typeof readMarketplacePurchaseIntentByRequestId> = null;
    let intentLookupFailed = false;
    try {
      if (
        !checkoutSessionId ||
        !STRIPE_CHECKOUT_RETURN_ID.test(checkoutSessionId) ||
        !checkoutRequestId ||
        !isUuid(checkoutRequestId)
      ) {
        throw new Error('Checkout Return Is Missing Its Protected Receipt Identity.');
      }
      locatedIntent = readMarketplacePurchaseIntentByRequestId(checkoutRequestId);
    } catch (error) {
      intentLookupFailed = true;
      reportError(error, 'marketplace.checkout_return_identity_failed');
    }
    if (intentLookupFailed) {
      toast.error(
        'Protected Purchase Recovery Could Not Be Read. Reload This Page To Check The Same Purchase.'
      );
      return;
    }
    if (!locatedIntent) {
      toast.error(
        'This Checkout Return Is Not Available In This Browser. Reload Or Sign Back Into The Original Account To Verify It.'
      );
      return;
    }
    const expectedType = locatedIntent
      ? cardCheckoutTypeForScope(locatedIntent.scope, user.id)
      : null;
    if (!expectedType) {
      toast.error(
        'Sign Back Into The Account That Started This Checkout, Then Reload To Verify The Same Purchase.'
      );
      return;
    }

    const pollStatus = async (attempt: number) => {
      const statusController = new AbortController();
      activeStatusController = statusController;
      const timeout = setTimeout(() => statusController.abort(), CARD_CHECKOUT_STATUS_TIMEOUT_MS);
      pollTimersRef.current.push(timeout);
      let deadlineActive = true;
      const endStatusDeadline = () => {
        if (!deadlineActive) return;
        deadlineActive = false;
        clearTimeout(timeout);
        pollTimersRef.current = pollTimersRef.current.filter((pending) => pending !== timeout);
        if (activeStatusController === statusController) activeStatusController = null;
      };
      try {
        const raw = await storeFetch<unknown>(
          `/api/store/checkout-status?session_id=${encodeURIComponent(checkoutSessionId as string)}`,
          { method: 'GET', expectedUserId: user.id, signal: statusController.signal }
        );
        if (cancelled) return;
        if (!(await currentMarketplaceCheckoutUserMatches(user.id, statusController.signal))) {
          toast.error(
            'Your Player Account Changed While Payment Was Being Verified. Sign Back Into The Original Account And Reload To Check The Same Purchase.'
          );
          return;
        }
        const receipt = verifiedMarketplaceCardCheckoutStatus(raw, {
          sessionId: checkoutSessionId as string,
          requestId: checkoutRequestId as string,
          accountId: user.id,
          type: expectedType,
        });
        if (!receipt) {
          toast.error(
            'Payment Status Returned An Unverified Receipt. Reload This Page To Check The Same Protected Purchase.'
          );
          return;
        }
        if (receipt.status === 'pending') {
          const nextAttempt = attempt + 1;
          if (nextAttempt >= CARD_CHECKOUT_STATUS_DELAYS_MS.length) {
            toast.info(
              'Payment Is Still Being Verified. Reload This Page To Check The Same Purchase.'
            );
            return;
          }
          const timer = setTimeout(() => {
            pollTimersRef.current = pollTimersRef.current.filter((pending) => pending !== timer);
            void pollStatus(nextAttempt);
          }, CARD_CHECKOUT_STATUS_DELAYS_MS[nextAttempt]);
          pollTimersRef.current.push(timer);
          return;
        }

        if (!(await currentMarketplaceCheckoutUserMatches(user.id, statusController.signal))) {
          toast.error(
            'Your Player Account Changed Before Payment Recovery Finished. Sign Back Into The Original Account And Reload To Check The Same Purchase.'
          );
          return;
        }

        // Status is terminal and account-bound. End its deadline before
        // durable retirement; wallet refresh is a separate follow-up and must
        // never rewrite this terminal outcome.
        endStatusDeadline();

        const retired = retireMarketplacePurchaseIntentByRequestId(receipt.requestId);
        if (!retired) {
          toast.error(
            'Payment Status Was Verified, But Protected Purchase Recovery Could Not Be Cleared. Reload To Retry Safely.'
          );
          void loadWalletRef.current(receipt.accountId);
          return;
        }
        if (receipt.status === 'failed') {
          toast.error('Checkout Expired Without A Completed Payment.');
          clearReturnUrl();
          return;
        }

        toast.success('Payment Confirmed. Your Account Has Been Updated.');
        if (nextPath) {
          setVerifiedContinuation({ ownerId: receipt.accountId, path: nextPath });
        }
        clearReturnUrl();
        void loadWalletRef.current(receipt.accountId);
        if (receipt.type === 'subscription') {
          masterBus.emit('ENTITLEMENTS_CHANGED', {
            userId: user.id,
            category: 'vip',
            source: 'vip-purchase',
          });
        }
      } catch (error) {
        if (cancelled) return;
        if ((error as { name?: unknown })?.name === 'AbortError') {
          toast.error(
            'Payment Status Timed Out. The Protected Request Was Retained. Reload This Page To Check The Same Purchase.'
          );
          return;
        }
        reportError(error, 'marketplace.checkout_status_failed');
        toast.error(
          'Payment Status Could Not Be Verified. Reload This Page To Check The Same Protected Purchase.'
        );
      } finally {
        endStatusDeadline();
      }
    };

    void pollStatus(0);
    return () => {
      cancelled = true;
      activeStatusController?.abort();
      pollTimersRef.current.forEach(clearTimeout);
      pollTimersRef.current = [];
    };
  }, [purchaseResult, checkoutSessionId, checkoutRequestId, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setVerifiedContinuation((current) => {
      if (!current) return current;
      return current.ownerId === user?.id && current.path === nextPath ? current : null;
    });
  }, [nextPath, user?.id]);

  useEffect(
    () => () => {
      pollTimersRef.current.forEach(clearTimeout);
      pollTimersRef.current = [];
    },
    []
  );

  /* ═══ Live refresh: bus events + tab visibility ═══ */
  useEffect(() => {
    if (!clubId) return;
    const refresh = () => {
      loadShop(clubId, true);
      loadWallet();
    };
    const unsubs = [
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 500),
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 500),
      masterBus.subscribeDebounced('CASHIER_BALANCE_CHANGED', refresh, 500),
      masterBus.subscribeDebounced(
        'ENTITLEMENTS_CHANGED',
        (event) => {
          if (event.payload.userId !== user?.id) return;
          loadInventory(clubId, true);
          loadEnt();
          refresh();
        },
        100
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, loadShop, loadWallet, loadInventory, loadEnt, user?.id]);

  useVisibilityRefresh(async () => {
    await Promise.all([
      clubId ? loadShop(clubId, true) : Promise.resolve(),
      clubId ? loadInventory() : Promise.resolve(),
      loadWallet(),
      loadEnt(),
      refreshCatalogForPurchase(),
    ]);
  });

  // Keep the ref in step when clubId changes by any route.
  useEffect(() => {
    clubIdRef.current = clubId;
  }, [clubId]);

  /* ═══ Derived ═══ */
  const activeClubScope = user?.id && clubId ? `${user.id}:${clubId}` : null;
  const hasActiveClubScope = activeClubScope !== null;
  const activeItems = useMemo(
    () => (hasActiveClubScope && shopScope === activeClubScope ? items : []),
    [activeClubScope, hasActiveClubScope, items, shopScope]
  );
  const activePurchases = hasActiveClubScope && shopScope === activeClubScope ? purchases : [];
  const activeBalance = hasActiveClubScope && shopScope === activeClubScope ? balance : null;
  const activeRole = hasActiveClubScope && shopScope === activeClubScope ? role : 'player';
  const activeInventory = useMemo(
    () => (hasActiveClubScope && inventoryScope === activeClubScope ? inventory : []),
    [activeClubScope, hasActiveClubScope, inventory, inventoryScope]
  );
  const activeEntitlements =
    user?.id && entitlementsOwnerId === user.id ? entitlements : EMPTY_ENTITLEMENTS;
  const activeShopError =
    hasActiveClubScope && shopErrorScope === activeClubScope ? shopError : null;
  const activeShopLoading = hasActiveClubScope
    ? loadingScope === activeClubScope
      ? loading
      : shopScope !== activeClubScope && shopErrorScope !== activeClubScope
    : false;
  // Ownership = an unredeemed inventory copy. Redeemed consumables can be re-bought.
  // Single shared predicate with My Items, so the Store can never offer Buy for
  // something the inventory list is calling "Owned".
  const ownedItemIds = useMemo(
    () =>
      new Set([
        ...activeInventory
          .filter((r) => isOwnedRow(r) && r.item_id)
          .map((r) => r.item_id as string),
        ...activeItems
          .filter((item) => isMarketplaceItemOwned(item, activeEntitlements))
          .map((item) => item.id),
      ]),
    [activeInventory, activeItems, activeEntitlements]
  );
  const ownedCount = useMemo(() => activeInventory.filter(isOwnedRow).length, [activeInventory]);
  const isAdmin = ['owner', 'co_owner', 'admin'].includes(activeRole);

  const switchTab = (t: TabKey) => {
    setTab(t);
    // Copy : never mutate the instance react-router memoizes per location.
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    setSearchParams(next, { replace: true });
  };

  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        loadShop(clubId || undefined, true),
        loadWallet(),
        loadInventory(clubId || undefined, false),
        loadEnt(),
        refreshCatalogForPurchase(),
      ]);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  /**
   * "3d" / "6h" / "Today" until the VIP pass lapses. Empty for lifetime, for a
   * missing date, and for anything already expired - the pill should never
   * announce a negative remainder.
   */
  const vipRemaining = useMemo(() => {
    if (!activeWallet.isVip || !activeWallet.vipExpiresAt || activeWallet.vipTier === 'lifetime')
      return '';
    const t = new Date(activeWallet.vipExpiresAt).getTime();
    if (!Number.isFinite(t)) return '';
    const ms = t - Date.now();
    if (ms <= 0) return '';
    const hours = Math.floor(ms / 3_600_000);
    if (hours < 1) return '<1h';
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }, [activeWallet.isVip, activeWallet.vipExpiresAt, activeWallet.vipTier]);

  /* ═══ Render ═══ */
  // FAILSAFE: ensure skeleton does not display indefinitely.
  useEffect(() => {
    // Browser build has no NodeJS namespace -- infer the platform's timer type.
    let timer: ReturnType<typeof setTimeout> | undefined;
    // GATED on a fetch actually being in flight (Dan 2026-08-25). `loading`
    // starts true and the init effect returns immediately when there is no
    // user, so a slow auth hydration produced "Could Not Load The Shop:
    // Failed to load shop (timeout)" while clubId was still null - and that
    // banner's Retry called loadShop(undefined), which returns instantly,
    // so the banner could never be cleared.
    //
    // 12s, not 5: loadShop retries twice with 500ms + 1000ms backoff, so a
    // slow-but-succeeding request routinely crossed the old window and
    // flashed a failure over a request that then worked.
    if (loading && clubId && user) {
      timer = setTimeout(() => {
        if (mountedRef.current) {
          setLoading(false);
          setShopError((prev) => prev || 'The Shop Took Too Long To Answer.');
        }
      }, 12000);
    }
    return () => clearTimeout(timer);
  }, [loading, mountedRef, clubId, user]);

  /* THE CHROME STAYS UP (Dan 2026-08-25).
     This returned <PageSkeleton variant="dashboard" /> for the WHOLE page -
     header, wallet pill, tab bar and bottom nav included. Two consequences: a
     player tapping Market from the footer saw an unrecognisable page for the
     first second and could not tell they had arrived; and on a club switch the
     tabs vanished and reappeared, throwing someone reading the Diamonds tab
     back to a skeleton for a load that has nothing to do with Diamonds -
     Diamonds and Membership do not read `items` at all. The Store's own
     "Loading The Shop..." state is the correct, scoped fallback. */

  const TABS: { key: TabKey; label: string; badge?: number; adminOnly?: boolean }[] = [
    // undefined, not 0, while the shop is still loading: a badge reading "0"
    // states the shop is empty, which is the claim this page must not make
    // before it knows.
    {
      key: 'store',
      label: 'Store',
      badge: activeShopLoading && activeItems.length === 0 ? undefined : activeItems.length,
    },
    { key: 'diamonds', label: 'Diamonds' },
    { key: 'membership', label: 'Membership' },
    { key: 'my_items', label: 'My Items', badge: ownedCount || undefined },
    { key: 'manage', label: 'Manage', adminOnly: true },
  ];

  return (
    <div className={styles.page}>
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Marketplace"
        title="Club Marketplace"
        description="Acquire Table Upgrades, Player Perks, Club Exclusives, Diamond Packages, And VIP Access Through The Existing Server-Priced Storefront."
        art="market"
        status="Player Exchange / Live"
        pillInk="blue"
        crest="club"
        metrics={[
          {
            label: 'Diamonds',
            value: activeWallet.loaded ? fmt(activeWallet.diamonds) : 'Checking',
            tone: 'attention',
          },
          {
            label: 'Store Items',
            value: activeShopLoading && activeItems.length === 0 ? 'Checking' : activeItems.length,
          },
          { label: 'Owned', value: ownedCount },
        ]}
        plates={{
          secondary: { label: 'Back To Lobby', onClick: () => navigate('/') },
          primary: {
            label: refreshing ? 'Refreshing' : 'Refresh',
            ink: 'white',
            onClick: refreshAll,
            disabled: refreshing,
            'aria-busy': refreshing,
          },
        }}
      />

      <div className={styles.marketStatusBar} aria-label="Marketplace Wallet Status">
        <div className={styles.walletBar}>
          {/* One wallet, one currency: diamonds. The shop API and the VIP
                status API both report the same profiles.diamonds balance. */}
          {/* Never assert a balance we do not have. `balance` initialises to 0
                and resetClubState puts it back to 0, so with no club - or with
                both the wallet and the shop failing - this pill confidently
                read "0 Diamonds", which is the one thing it must never say. */}
          <span className={styles.walletPillDiamond} aria-live="polite">
            {activeWallet.loaded
              ? `${fmt(activeWallet.diamonds)} Diamonds`
              : !activeWallet.error && activeBalance !== null && !activeShopError
                ? `${fmt(activeBalance)} Diamonds`
                : 'Diamonds Unavailable'}
          </span>
          {/* vipExpiresAt is fetched by loadWalletInfo and rendered ONLY inside
                the Membership tab, so someone who bought a 24-hour pass had no
                idea when it lapses unless they opened a tab they have no reason
                to open. `title` alone is useless on touch, so the short form is
                visible and the full date stays in the title. Dan 2026-08-25. */}
          {activeWallet.isVip && (
            <span
              className={styles.vipPill}
              title={
                activeWallet.vipExpiresAt
                  ? `Expires ${new Date(activeWallet.vipExpiresAt).toLocaleString()}`
                  : undefined
              }
            >
              VIP{vipRemaining ? ` \u00b7 ${vipRemaining}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <nav
        className={styles.tabNav}
        role="tablist"
        aria-label="Marketplace Sections"
        onKeyDown={(e) => {
          /* Same fix as the Stats tablist: selection was moving, focus was not.
             Each tab is `tabIndex={tab === t.key ? 0 : -1}`, so the previously
             selected button dropped out of the tab order with focus still on it.
             Note the key list is the ADMIN-FILTERED one, so End lands on the last
             tab this particular user can actually see. */
          const KEYS = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
          if (!KEYS.includes(e.key)) return;
          e.preventDefault();
          const keys = TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => t.key);
          const i = keys.indexOf(tab);
          if (i < 0) return;
          const next =
            e.key === 'Home'
              ? keys[0]
              : e.key === 'End'
                ? keys[keys.length - 1]
                : e.key === 'ArrowRight'
                  ? keys[(i + 1) % keys.length]
                  : keys[(i - 1 + keys.length) % keys.length];
          switchTab(next);
          document.getElementById(`market-tab-${next}`)?.focus();
        }}
      >
        {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
          <button
            key={t.key}
            role="tab"
            id={`market-tab-${t.key}`}
            aria-controls="market-panel"
            aria-selected={tab === t.key}
            /* The badge carried its own aria-label INSIDE the button, so the
               button's computed name came out as "Store 5 Store". A count
               belongs in the button's name, not as a second labelled node. */
            aria-label={t.badge ? `${t.label}, ${t.badge.toLocaleString()} Items` : undefined}
            tabIndex={tab === t.key ? 0 : -1}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
            {t.badge ? (
              <span className={styles.tabBadge} aria-hidden="true">
                {t.badge.toLocaleString()}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {/* Failure banners : these used to be silent on every refresh path */}
      {activeShopError && (
        <div className={styles.errorBanner} role="alert">
          <span>Could Not Load The Shop: {formatPopupText(activeShopError)}</span>
          <button className={styles.inlineLink} onClick={refreshAll} disabled={refreshing}>
            Retry
          </button>
        </div>
      )}
      {activeWallet.error && (
        <div className={styles.errorBanner} role="alert">
          <span>{formatPopupText(activeWallet.error)}</span>
          <button className={styles.inlineLink} onClick={() => loadWallet()}>
            Retry
          </button>
        </div>
      )}

      {/* The tabs declared role="tab" with nothing to control: a screen reader
          announced "tab 3 of 5" and then landed in unlabelled content. */}
      <div
        className={styles.section}
        role="tabpanel"
        id="market-panel"
        aria-labelledby={`market-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === 'store' && clubId && (
          <StoreTab
            clubId={clubId}
            userId={user?.id || ''}
            items={activeItems}
            ownedItemIds={ownedItemIds}
            balance={activeWallet.loaded ? activeWallet.diamonds : (activeBalance ?? 0)}
            onGoDiamonds={() => switchTab('diamonds')}
            isAdmin={isAdmin}
            loading={activeShopLoading}
            error={activeShopError}
            categories={catalog.shopCategories}
            onGoManage={() => switchTab('manage')}
            onCatalogStale={() => loadShop(clubId, true)}
            onPurchased={(settlement) => {
              const expectedAccountId = settlement?.accountId || user?.id;
              const expectedClubId = settlement?.clubId || clubId;
              if (
                !expectedAccountId ||
                !expectedClubId ||
                activeUserIdRef.current !== expectedAccountId ||
                clubIdRef.current !== expectedClubId ||
                shopScope !== `${expectedAccountId}:${expectedClubId}`
              ) {
                return;
              }
              // The BALANCE_UPDATED bus subscription reloads the shop + wallet;
              // only the optimistic diamond balance and the inventory are
              // needed here. Both balance mirrors must move together or the
              // header pill and the buy modal disagree until the reload lands.
              if (settlement) {
                setBalance(settlement.newBalance);
                setShopScope(`${expectedAccountId}:${expectedClubId}`);
                if (walletOwnerId === expectedAccountId) {
                  setWallet((prev) =>
                    prev.loaded ? { ...prev, diamonds: settlement.newBalance } : prev
                  );
                }
              }
              loadInventory(expectedClubId);
              loadEnt(expectedAccountId);
            }}
          />
        )}
        {tab === 'store' && !clubId && (
          <div className={styles.emptyState}>
            <span className={styles.emptyText}>Join A Club To Browse Its Shop.</span>
            <span className={styles.emptySubText}>
              Diamonds And VIP Membership Are Still Available In The Other Tabs.
            </span>
          </div>
        )}
        {verifiedContinuation?.ownerId === user?.id && verifiedContinuation?.path === nextPath && (
          <div className={styles.sectionIntro} role="status">
            <p className={styles.sectionSub}>
              Payment Received. Your Diamonds Land In A Few Seconds, And Your Seat Is Waiting.
            </p>
            <div>
              <button type="button" className={styles.btnPrimary} onClick={goOnward}>
                {continueLabel}
              </button>
            </div>
          </div>
        )}
        {tab === 'diamonds' && (
          <DiamondsTab
            clubId={clubId || ''}
            userId={user?.id || ''}
            wallet={activeWallet}
            packages={catalog.diamondPackages}
            catalogVerified={catalog.fromServer}
            refreshCatalogForPurchase={refreshCatalogForPurchase}
            nextPath={nextPath}
          />
        )}
        {tab === 'membership' && (
          <MembershipTab
            clubId={clubId || ''}
            userId={user?.id || ''}
            wallet={activeWallet}
            plans={catalog.vipPlans}
            catalogVerified={catalog.fromServer}
            refreshCatalogForPurchase={refreshCatalogForPurchase}
            onWalletChanged={loadWallet}
          />
        )}
        {tab === 'my_items' && (
          <MyItemsTab
            key={`${user?.id || 'signed-out'}:${clubId || 'no-club'}`}
            clubId={clubId}
            userId={user?.id || ''}
            isAdmin={isAdmin}
            inventory={activeInventory}
            purchases={activePurchases}
            entitlements={activeEntitlements}
            onGoStore={() => switchTab('store')}
            onRedeemed={() => {
              loadInventory(clubId || undefined);
              // Redeeming may re-enable Buy for that item in the Store tab
              loadShop(clubId || undefined, true);
              loadEnt();
            }}
          />
        )}
        {tab === 'manage' && isAdmin && clubId && (
          <ManageTab
            key={`${user?.id || 'signed-out'}:${clubId}`}
            clubId={clubId}
            userId={user?.id || ''}
            categories={catalog.shopCategories}
            catalogFromServer={catalog.fromServer}
            onShopChanged={() => loadShop(clubId, true)}
          />
        )}
        {tab === 'manage' && (!isAdmin || !clubId) && (
          <div className={styles.emptyState}>
            <span className={styles.emptyText}>
              {clubId ? 'The Manage Tab Is For Club Owners And Admins.' : 'Join A Club First.'}
            </span>
            <button className={styles.emptyButton} onClick={() => switchTab('store')}>
              Back To Store
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
