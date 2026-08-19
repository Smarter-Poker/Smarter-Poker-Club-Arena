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
  loadWalletInfo,
  type InventoryRow,
  type MarketplaceItem,
  type ShopPurchase,
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

  const mountedRef = useIsMounted();
  const loadingRef = useRef(false);

  // Safety timeout: never hang the skeleton forever
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  /* ═══ Club shop data — via /api/club-arena/marketplace-items ═══ */
  const loadShop = useCallback(
    async (cId?: string, silent = false) => {
      const targetClub = cId || clubId;
      if (!targetClub || !user) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        if (!silent) setLoading(true);
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error('Not authenticated');

        const fetchWithThrow = async () => {
          const response = await fetch(`/api/club-arena/marketplace-items?clubId=${targetClub}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok) {
            const errBody = await response
              .json()
              .catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error(errBody.error || `Failed to load shop (${response.status})`);
          }
          return response.json();
        };

        const data = await retryAsync(fetchWithThrow, 2);
        if (mountedRef.current) {
          setItems(
            (data.items || []).map((i: MarketplaceItem) => ({
              ...i,
              club_id: targetClub,
              is_active: true,
              purchase_count: i.purchase_count || 0,
            }))
          );
          setPurchases(data.purchases || []);
          setBalance(data.balance || 0);
          if (data.role) setRole(data.role);
        }
      } catch (err: unknown) {
        if (!silent) toast.error(err instanceof Error ? err.message : 'Failed to load shop');
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
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
    }
  }, [user, mountedRef]);

  /* ═══ Delivered inventory (loaded eagerly — ownership state depends on it) ═══ */
  const loadInventory = useCallback(async () => {
    if (!clubId || !user) return;
    try {
      const { data } = await supabase
        .from('club_shop_inventory')
        .select('id, item_id, item_name, category, price_paid, status, acquired_at')
        .eq('club_id', clubId)
        .eq('user_id', user.id)
        .order('acquired_at', { ascending: false });
      if (mountedRef.current) setInventory(data || []);
    } catch (err) {
      reportError(err, 'MarketplacePage.loadInventory');
    }
  }, [clubId, user, mountedRef]);

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
      if (targetClub) {
        setClubId((prev) => {
          if (prev && prev !== targetClub) {
            // Club switched in place: clear stale club-scoped state
            setItems([]);
            setPurchases([]);
            setInventory([]);
            setBalance(0);
            setRole('player');
          }
          return targetClub;
        });
        loadingRef.current = false;
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

  /* ═══ Stripe Checkout return handling (?purchase=success|canceled) ═══ */
  useEffect(() => {
    const result = searchParams.get('purchase');
    if (!result) return;
    if (result === 'success') {
      toast.success('Payment received. Your balance will update momentarily.');
      // Webhook fulfilment can lag checkout by a few seconds — refresh twice.
      loadWallet();
      const t = setTimeout(() => loadWallet(), 4000);
      searchParams.delete('purchase');
      setSearchParams(searchParams, { replace: true });
      return () => clearTimeout(t);
    }
    if (result === 'canceled') {
      toast.error('Checkout canceled. You have not been charged.');
      searchParams.delete('purchase');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /* ═══ Derived ═══ */
  // Ownership = an unredeemed inventory copy. Redeemed consumables can be re-bought.
  const ownedItemIds = useMemo(
    () =>
      new Set(
        inventory.filter((r) => r.status === 'owned' && r.item_id).map((r) => r.item_id as string)
      ),
    [inventory]
  );
  const isAdmin = ['owner', 'admin'].includes(role);

  const switchTab = (t: TabKey) => {
    setTab(t);
    searchParams.set('tab', t);
    setSearchParams(searchParams, { replace: true });
  };

  const refreshAll = () => {
    loadingRef.current = false;
    loadShop(clubId || undefined);
    loadWallet();
    loadInventory();
  };

  /* ═══ Render ═══ */
  if (loading && items.length === 0 && !wallet.loaded) {
    return <PageSkeleton variant="dashboard" />;
  }

  const TABS: { key: TabKey; label: string; badge?: number; adminOnly?: boolean }[] = [
    { key: 'store', label: 'Store', badge: items.length },
    { key: 'chips', label: 'Get Chips' },
    { key: 'diamonds', label: 'Diamonds' },
    { key: 'membership', label: 'Membership' },
    { key: 'my_items', label: 'My Items', badge: inventory.length || undefined },
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
            <span className={styles.walletPillDiamond}>
              {wallet.loaded ? `${fmt(wallet.diamonds)} diamonds` : 'diamonds...'}
            </span>
            {wallet.isVip && <span className={styles.vipPill}>VIP</span>}
          </div>
        </div>
        <div className={styles.headerActions}>
          <Link to="/" className={styles.btnGhost}>
            Lobby
          </Link>
          <button onClick={refreshAll} className={styles.btnGhost}>
            Refresh
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className={styles.tabNav}>
        {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
            {t.badge ? <span className={styles.tabBadge}>{t.badge}</span> : null}
          </button>
        ))}
      </nav>

      <div className={styles.section}>
        {tab === 'store' && clubId && (
          <StoreTab
            clubId={clubId}
            items={items}
            ownedItemIds={ownedItemIds}
            balance={balance}
            isAdmin={isAdmin}
            onGoManage={() => switchTab('manage')}
            onGoChips={() => switchTab('chips')}
            onPurchased={(newBalance) => {
              if (typeof newBalance === 'number') setBalance(newBalance);
              loadingRef.current = false;
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
            onGoDiamonds={() => switchTab('diamonds')}
            onPurchased={() => {
              loadingRef.current = false;
              loadShop(clubId || undefined, true);
              loadWallet();
            }}
          />
        )}
        {tab === 'diamonds' && <DiamondsTab clubId={clubId || ''} wallet={wallet} />}
        {tab === 'membership' && (
          <MembershipTab clubId={clubId || ''} wallet={wallet} onWalletChanged={loadWallet} />
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
            clubId={clubId}
            onShopChanged={() => {
              loadingRef.current = false;
              loadShop(clubId, true);
            }}
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
