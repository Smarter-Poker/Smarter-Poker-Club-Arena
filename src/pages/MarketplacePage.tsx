/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — MARKETPLACE / CASHIER STOREFRONT (2026-08-19 full rebuild)
 *
 *  Tabs:
 *    Store       — club shop items bought with DIAMONDS from the player's
 *                  global wallet (server-authoritative). The marketplace is
 *                  fully funded by diamonds, never chips (Dan, 2026-08-23).
 *    (Get Chips was removed 2026-08-19: chips are won and transferred,
 *     never bought. The diamonds -> chips conversion no longer exists.)
 *    Diamonds    — real-money diamond packages via Stripe Checkout (/api/store)
 *    Membership  — VIP daily pass / monthly / annual (diamonds or Stripe)
 *    My Items    — delivered inventory (club_shop_inventory) + redemption + history
 *    Manage      — owner/admin CRUD via /api/club-arena/manage-shop (RLS-safe)
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
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { useIsMounted } from '../hooks/useIsMounted';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { fmt } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import styles from './MarketplacePage.module.css';
import ClubBottomNav from '../components/club/ClubBottomNav';
import {
  EMPTY_ENTITLEMENTS,
  EMPTY_WALLET,
  FALLBACK_CATALOG,
  isOwnedRow,
  isUuid,
  loadEntitlements,
  loadStoreCatalog,
  loadWalletInfo,
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

type TabKey = 'store' | 'diamonds' | 'membership' | 'my_items' | 'manage';
const VALID_TABS: TabKey[] = ['store', 'diamonds', 'membership', 'my_items', 'manage'];

export default function MarketplacePage() {
  const { user } = useAuthUser();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

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
  const [wallet, setWallet] = useState<WalletInfo>(EMPTY_WALLET);
  const [shopError, setShopError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [catalog, setCatalog] = useState<StoreCatalog>(FALLBACK_CATALOG);
  const [entitlements, setEntitlements] = useState<Entitlements>(EMPTY_ENTITLEMENTS);

  const mountedRef = useIsMounted();
  // Monotonic request token: only the newest load may write state. Replaces the
  // old loadingRef guard, which every caller had to defeat and which dropped
  // (rather than queued) refreshes that arrived during an in-flight load.
  const reqRef = useRef(0);
  // Mirrors clubId for the init effect without adding it as a dependency.
  const clubIdRef = useRef<string | null>(null);

  /** Drop everything scoped to a club (switch, invalid link, or no club). */
  const resetClubState = useCallback(() => {
    setItems([]);
    setPurchases([]);
    setInventory([]);
    setBalance(0);
    setRole('player');
    setShopError(null);
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

  /* ═══ Club shop data — via /api/club-arena/marketplace-items ═══ */
  const loadShop = useCallback(
    async (cId?: string, silent = false) => {
      const targetClub = cId || clubId;
      if (!targetClub || !user) return;
      const myReq = ++reqRef.current;
      try {
        if (!silent) setLoading(true);
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error('Not authenticated');

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
        if (!mountedRef.current || myReq !== reqRef.current) return;

        setItems(
          (data.items || []).map((i: MarketplaceItem) => ({
            ...i,
            purchase_count: i.purchase_count || 0,
          }))
        );
        setPurchases(data.purchases || []);
        setBalance(data.balance || 0);
        setRole(data.role ?? 'player');
        setShopError(null);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to load shop';
        // Always report. Silent refreshes previously failed with no toast, no
        // Sentry event and no state change -- the shop just went quietly stale.
        reportError(err, 'MarketplacePage.loadShop');
        if (mountedRef.current && myReq === reqRef.current) {
          setShopError(msg);
          // Toast only for the current request: a superseded club-A failure
          // must not pop an error over club B's freshly loaded shop.
          if (!silent) toast.error(msg);
        }
      } finally {
        if (mountedRef.current && myReq === reqRef.current) setLoading(false);
      }
    },
    [clubId, user?.id] // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ═══ Diamond balance + VIP status ═══ */
  const loadWallet = useCallback(async () => {
    if (!user) return;
    try {
      const info = await loadWalletInfo();
      if (mountedRef.current) setWallet(info);
    } catch (err) {
      reportError(err, 'MarketplacePage.loadWallet');
      // Never leave the UI asserting "you have 0 diamonds" when we simply
      // could not read the balance -- that silently disables every buy button.
      if (mountedRef.current) {
        setWallet((prev) => ({
          ...prev,
          loaded: false,
          error: err instanceof Error ? err.message : 'Could not load your balance',
        }));
      }
    }
  }, [user?.id, mountedRef]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ═══ Live entitlement balances (what redemption actually granted) ═══ */
  const secondsPerUse =
    catalog.shopCategories.find((c) => c.grantType === 'time_bank')?.secondsPerUse ?? 20;

  const loadEnt = useCallback(async () => {
    if (!user?.id) return;
    try {
      const e = await loadEntitlements(user.id, secondsPerUse);
      if (mountedRef.current) setEntitlements(e);
    } catch (err) {
      reportError(err, 'MarketplacePage.loadEntitlements');
    }
  }, [user?.id, secondsPerUse, mountedRef]);

  useEffect(() => {
    if (tab === 'my_items') loadEnt();
  }, [tab, loadEnt]);

  /* ═══ Delivered inventory (loaded eagerly — ownership state depends on it) ═══ */
  const invReqRef = useRef(0);
  const loadInventory = useCallback(
    async (cId?: string, silent = true) => {
      const target = cId || clubId;
      if (!target || !user) return;
      const myReq = ++invReqRef.current;
      try {
        // supabase-js resolves (never rejects) on RLS/network failure, so the
        // error MUST be destructured -- otherwise a failure looked exactly like
        // "you own nothing" and invited the user to re-buy what they already had.
        const { data, error } = await supabase
          .from('club_shop_inventory')
          .select('id, item_id, purchase_id, item_name, category, price_paid, status, acquired_at')
          .eq('club_id', target)
          .eq('user_id', user.id)
          .order('acquired_at', { ascending: false });
        if (error) throw error;
        // Same stale-response guard as loadShop: on a club switch the older
        // query can resolve last, and ownership state drives the Buy buttons.
        if (mountedRef.current && myReq === invReqRef.current) setInventory(data || []);
      } catch (err) {
        reportError(err, 'MarketplacePage.loadInventory');
        if (!silent && mountedRef.current) {
          toast.error('Could not load your items. Tap Refresh to try again.');
        }
      }
    },
    [clubId, user?.id, mountedRef] // eslint-disable-line react-hooks/exhaustive-deps
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
        const { data: mem } = await supabase
          .from('club_members')
          .select('club_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();
        targetClub = mem?.club_id || null;
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

  /* ═══ Stripe Checkout return handling (?purchase=success|canceled) ═══
   * The delayed re-check used to be scheduled in an effect keyed on
   * searchParams and then cancelled ~immediately by its own URL cleanup, so it
   * never fired and users came back from Stripe seeing a stale balance.
   * The latch below survives the navigation. */
  const purchaseResult = searchParams.get('purchase');
  const purchaseHandledRef = useRef(false);
  const pollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Always call the freshest loadWallet without making it an effect dependency
  // (`user` is a new object on every auth-store write, so depending on the
  // callback identity tore the timers down repeatedly).
  const loadWalletRef = useRef(loadWallet);
  loadWalletRef.current = loadWallet;

  useEffect(() => {
    if (!purchaseResult || purchaseHandledRef.current) return;
    purchaseHandledRef.current = true;

    if (purchaseResult === 'success') {
      toast.success('Payment received. Your balance will update momentarily.');
      // Webhook fulfilment lags checkout by seconds. These timers are stored in
      // a ref and cleared ONLY on unmount: the previous version scheduled them
      // in an effect keyed on `purchaseResult`, and stripping the param below
      // changed that key, so the cleanup killed every timer within ~10ms and
      // the buyer was left staring at a stale balance.
      pollTimersRef.current = [1500, 5000, 12000].map((ms) =>
        setTimeout(() => loadWalletRef.current(), ms)
      );
    } else if (purchaseResult === 'canceled') {
      toast.error('Checkout canceled. You have not been charged.');
    }

    // Strip the param WITHOUT mutating the router's memoized instance.
    const next = new URLSearchParams(searchParams);
    next.delete('purchase');
    setSearchParams(next, { replace: true });
  }, [purchaseResult]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => pollTimersRef.current.forEach(clearTimeout), []);

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
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, loadShop, loadWallet]);

  useVisibilityRefresh(async () => {
    if (clubId) {
      loadShop(clubId, true);
      loadInventory();
    }
    loadWallet();
  });

  // Keep the ref in step when clubId changes by any route.
  useEffect(() => {
    clubIdRef.current = clubId;
  }, [clubId]);

  /* ═══ Derived ═══ */
  // Ownership = an unredeemed inventory copy. Redeemed consumables can be re-bought.
  // Single shared predicate with My Items, so the Store can never offer Buy for
  // something the inventory list is calling "Owned".
  const ownedItemIds = useMemo(
    () =>
      new Set(inventory.filter((r) => isOwnedRow(r) && r.item_id).map((r) => r.item_id as string)),
    [inventory]
  );
  const ownedCount = useMemo(() => inventory.filter(isOwnedRow).length, [inventory]);
  const isAdmin = ['owner', 'co_owner', 'admin'].includes(role);

  const switchTab = (t: TabKey) => {
    setTab(t);
    // Copy — never mutate the instance react-router memoizes per location.
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
      ]);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

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

  if (loading && items.length === 0 && !shopError) {
    return <PageSkeleton variant="dashboard" />;
  }

  const TABS: { key: TabKey; label: string; badge?: number; adminOnly?: boolean }[] = [
    { key: 'store', label: 'Store', badge: items.length },
    { key: 'diamonds', label: 'Diamonds' },
    { key: 'membership', label: 'Membership' },
    { key: 'my_items', label: 'My Items', badge: ownedCount || undefined },
    { key: 'manage', label: 'Manage', adminOnly: true },
  ];

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>Marketplace</h1>
          <div className={styles.walletBar}>
            {/* One wallet, one currency: diamonds. The shop API and the VIP
                status API both report the same profiles.diamonds balance. */}
            {/* Never assert a balance we do not have. `balance` initialises to 0
                and resetClubState puts it back to 0, so with no club - or with
                both the wallet and the shop failing - this pill confidently
                read "0 Diamonds", which is the one thing it must never say. */}
            <span className={styles.walletPillDiamond} aria-live="polite">
              {wallet.loaded
                ? `${fmt(wallet.diamonds)} Diamonds`
                : !wallet.error && clubId && !shopError
                  ? `${fmt(balance)} Diamonds`
                  : 'Diamonds Unavailable'}
            </span>
            {wallet.isVip && <span className={styles.vipPill}>VIP</span>}
          </div>
        </div>
        <div className={styles.headerActions}>
          <Link to="/" className={styles.btnGhost}>
            Lobby
          </Link>
          <button onClick={refreshAll} className={styles.btnGhost} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className={styles.tabNav} role="tablist" aria-label="Marketplace sections">
        {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
            {t.badge ? (
              <span className={styles.tabBadge} aria-label={`${t.badge} ${t.label}`}>
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {/* Failure banners — these used to be silent on every refresh path */}
      {shopError && (
        <div className={styles.errorBanner} role="alert">
          <span>Could Not Load The Shop: {formatPopupText(shopError)}</span>
          <button className={styles.inlineLink} onClick={refreshAll} disabled={refreshing}>
            Retry
          </button>
        </div>
      )}
      {wallet.error && (
        <div className={styles.errorBanner} role="alert">
          <span>{formatPopupText(wallet.error)}</span>
          <button className={styles.inlineLink} onClick={() => loadWallet()}>
            Retry
          </button>
        </div>
      )}

      <div className={styles.section}>
        {tab === 'store' && clubId && (
          <StoreTab
            clubId={clubId}
            items={items}
            ownedItemIds={ownedItemIds}
            balance={wallet.loaded ? wallet.diamonds : balance}
            onGoDiamonds={() => switchTab('diamonds')}
            isAdmin={isAdmin}
            loading={loading}
            error={shopError}
            categories={catalog.shopCategories}
            onGoManage={() => switchTab('manage')}
            onPurchased={(newBalance) => {
              // The BALANCE_UPDATED bus subscription reloads the shop + wallet;
              // only the optimistic diamond balance and the inventory are
              // needed here. Both balance mirrors must move together or the
              // header pill and the buy modal disagree until the reload lands.
              if (typeof newBalance === 'number') {
                setBalance(newBalance);
                setWallet((prev) => (prev.loaded ? { ...prev, diamonds: newBalance } : prev));
              }
              loadInventory(clubId);
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
        {tab === 'diamonds' && (
          <DiamondsTab clubId={clubId || ''} wallet={wallet} packages={catalog.diamondPackages} />
        )}
        {tab === 'membership' && (
          <MembershipTab
            clubId={clubId || ''}
            wallet={wallet}
            plans={catalog.vipPlans}
            onWalletChanged={loadWallet}
          />
        )}
        {tab === 'my_items' && (
          <MyItemsTab
            clubId={clubId}
            isAdmin={isAdmin}
            inventory={inventory}
            purchases={purchases}
            entitlements={entitlements}
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
            key={clubId}
            clubId={clubId}
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
      {/* Dan 2026-08-25: the footer belongs on every page the footer can
          reach. /marketplace is a top-level route, so clubId comes from the
          page's own resolution when it has one and from LAST_CLUB otherwise.
          The Market tab hides itself while you are here. */}
      <ClubBottomNav clubId={clubId || undefined} />
    </div>
  );
}
