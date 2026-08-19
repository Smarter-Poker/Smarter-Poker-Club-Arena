/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — MARKETPLACE / CASHIER STOREFRONT (2026-08-19 full rebuild)
 *
 *  Tabs:
 *    Store       — club shop items bought with club chips (server-authoritative)
 *    Get Chips   — diamonds -> club chips via /api/club-arena/purchase-chips
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
import {
  EMPTY_WALLET,
  FALLBACK_CATALOG,
  isOwnedRow,
  isUuid,
  loadStoreCatalog,
  loadWalletInfo,
  type InventoryRow,
  type MarketplaceItem,
  type ShopPurchase,
  type StoreCatalog,
  type WalletInfo,
} from './marketplace/marketplaceShared';
import StoreTab from './marketplace/StoreTab';
import ChipsTab from './marketplace/ChipsTab';
import DiamondsTab from './marketplace/DiamondsTab';
import MembershipTab from './marketplace/MembershipTab';
import MyItemsTab from './marketplace/MyItemsTab';
import ManageTab from './marketplace/ManageTab';

type TabKey = 'store' | 'chips' | 'diamonds' | 'membership' | 'my_items' | 'manage';
const VALID_TABS: TabKey[] = ['store', 'chips', 'diamonds', 'membership', 'my_items', 'manage'];

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

  const mountedRef = useIsMounted();
  // Monotonic request token: only the newest load may write state. Replaces the
  // old loadingRef guard, which every caller had to defeat and which dropped
  // (rather than queued) refreshes that arrived during an in-flight load.
  const reqRef = useRef(0);
  // Mirrors clubId for the init effect without adding it as a dependency.
  const clubIdRef = useRef<string | null>(null);

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
        if (mountedRef.current && myReq === reqRef.current) setShopError(msg);
        if (!silent) toast.error(msg);
      } finally {
        if (mountedRef.current && myReq === reqRef.current) setLoading(false);
      }
    },
    [clubId, user] // eslint-disable-line react-hooks/exhaustive-deps
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
  }, [user, mountedRef]);

  /* ═══ Delivered inventory (loaded eagerly — ownership state depends on it) ═══ */
  const loadInventory = useCallback(async () => {
    if (!clubId || !user) return;
    try {
      // supabase-js resolves (never rejects) on RLS/network failure, so the
      // error MUST be destructured -- otherwise a failure looked exactly like
      // "you own nothing" and invited the user to re-buy what they already had.
      const { data, error } = await supabase
        .from('club_shop_inventory')
        .select('id, item_id, item_name, category, price_paid, status, acquired_at')
        .eq('club_id', clubId)
        .eq('user_id', user.id)
        .order('acquired_at', { ascending: false });
      if (error) throw error;
      if (mountedRef.current) setInventory(data || []);
    } catch (err) {
      reportError(err, 'MarketplacePage.loadInventory');
      if (mountedRef.current) {
        toast.error('Could not load your items. Pull to refresh or tap Refresh.');
      }
    }
  }, [clubId, user, mountedRef]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ═══ Init + react to ?club= changes (club quick links navigate in place) ═══ */
  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    const init = async () => {
      let targetClub: string | null = null;
      if (qClubParam) {
        // Accept both UUIDs and legacy 6-digit club codes
        try {
          targetClub = await resolveClubUUID(qClubParam);
        } catch (_e) {
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
        toast.error('That club link looks invalid.');
        setLoading(false);
        loadWallet();
        return;
      }
      if (targetClub) {
        // Reset club-scoped state OUTSIDE the setState updater -- updaters must
        // be pure, and React 19 StrictMode double-invokes them.
        setClubId((prev) => (prev === targetClub ? prev : targetClub));
        if (clubIdRef.current && clubIdRef.current !== targetClub) {
          setItems([]);
          setPurchases([]);
          setInventory([]);
          setBalance(0);
          setRole('player');
          setShopError(null);
        }
        clubIdRef.current = targetClub;
        loadShop(targetClub);
      } else {
        toast.error('No club found. Join a club to use the club shop.');
        setLoading(false);
      }
      loadWallet();
    };
    init();
    return () => {
      isMounted = false;
    };
  }, [user, qClubParam]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ═══ React to ?tab= changes from external navigation ═══ */
  useEffect(() => {
    const t = qTabParam as TabKey | null;
    if (t && VALID_TABS.includes(t)) {
      setTab((prev) => (prev === t ? prev : t));
    }
  }, [qTabParam]);

  /* ═══ Inventory loads as soon as we know the club ═══ */
  useEffect(() => {
    if (clubId) loadInventory();
  }, [clubId, loadInventory]);

  /* ═══ Stripe Checkout return handling (?purchase=success|canceled) ═══
   * The delayed re-check used to be scheduled in an effect keyed on
   * searchParams and then cancelled ~immediately by its own URL cleanup, so it
   * never fired and users came back from Stripe seeing a stale balance.
   * The latch below survives the navigation. */
  const purchaseResult = searchParams.get('purchase');
  const handledPurchaseRef = useRef<string | null>(null);

  useEffect(() => {
    if (!purchaseResult) return;
    if (handledPurchaseRef.current === purchaseResult) return;
    handledPurchaseRef.current = purchaseResult;

    if (purchaseResult === 'success') {
      toast.success('Payment received. Your balance will update momentarily.');
    } else if (purchaseResult === 'canceled') {
      toast.error('Checkout canceled. You have not been charged.');
    }

    // Strip the param WITHOUT mutating the router's memoized instance.
    const next = new URLSearchParams(searchParams);
    next.delete('purchase');
    setSearchParams(next, { replace: true });
  }, [purchaseResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Webhook fulfilment can lag checkout by a few seconds: poll the wallet a few
  // times after a successful return. Lives in its own effect so the URL cleanup
  // above cannot cancel it.
  useEffect(() => {
    if (purchaseResult !== 'success') return;
    const timers = [1500, 5000, 12000].map((ms) => setTimeout(() => loadWallet(), ms));
    return () => timers.forEach(clearTimeout);
  }, [purchaseResult, loadWallet]);

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
  const isAdmin = ['owner', 'admin'].includes(role);

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
      await Promise.all([loadShop(clubId || undefined), loadWallet(), loadInventory()]);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  /* ═══ Render ═══ */
  if (loading && items.length === 0 && !shopError) {
    return <PageSkeleton variant="dashboard" />;
  }

  const TABS: { key: TabKey; label: string; badge?: number; adminOnly?: boolean }[] = [
    { key: 'store', label: 'Store', badge: items.length },
    { key: 'chips', label: 'Get Chips' },
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
            <span className={styles.walletPill}>{fmt(balance)} chips</span>
            <span className={styles.walletPillDiamond} aria-live="polite">
              {wallet.loaded ? `${fmt(wallet.diamonds)} diamonds` : 'diamonds —'}
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
      {shopError && tab === 'store' && (
        <div className={styles.errorBanner} role="alert">
          <span>Could not load the shop: {shopError}</span>
          <button className={styles.inlineLink} onClick={refreshAll} disabled={refreshing}>
            Retry
          </button>
        </div>
      )}
      {wallet.error && (
        <div className={styles.errorBanner} role="alert">
          <span>{wallet.error}</span>
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
            balance={balance}
            isAdmin={isAdmin}
            loading={loading}
            onGoManage={() => switchTab('manage')}
            onGoChips={() => switchTab('chips')}
            onPurchased={(newBalance) => {
              if (typeof newBalance === 'number') setBalance(newBalance);
              loadShop(clubId, true);
              loadInventory();
            }}
          />
        )}
        {tab === 'store' && !clubId && (
          <div className={styles.emptyState}>
            <span className={styles.emptyText}>Join a club to browse its shop.</span>
            <span className={styles.emptySubText}>
              Diamonds and VIP membership are still available in the other tabs.
            </span>
          </div>
        )}
        {tab === 'chips' && (
          <ChipsTab
            wallet={wallet}
            clubId={clubId}
            packages={catalog.chipPackages}
            onGoDiamonds={() => switchTab('diamonds')}
            onPurchased={() => {
              loadShop(clubId || undefined, true);
              loadWallet();
            }}
          />
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
            inventory={inventory}
            purchases={purchases}
            onGoStore={() => switchTab('store')}
            onRedeemed={() => {
              loadInventory();
              // Redeeming may re-enable Buy for that item in the Store tab
              loadShop(clubId || undefined, true);
            }}
          />
        )}
        {tab === 'manage' && isAdmin && clubId && (
          <ManageTab
            key={clubId}
            clubId={clubId}
            categories={catalog.shopCategories}
            onShopChanged={() => loadShop(clubId, true)}
          />
        )}
        {tab === 'manage' && (!isAdmin || !clubId) && (
          <div className={styles.emptyState}>
            <span className={styles.emptyText}>
              {clubId ? 'The Manage tab is for club owners and admins.' : 'Join a club first.'}
            </span>
            <button className={styles.emptyButton} onClick={() => switchTab('store')}>
              Back to Store
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
