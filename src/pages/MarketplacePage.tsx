/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Item Shop (Marketplace)
 *  Club Arena in-game purchases: Time Banks, Table Skins, Throwables, Emotes
 *  3 Tabs: Store | My Items  (+Manage tab for admins)
 *  ── Wired to World Hub APIs: /api/club-arena/marketplace-items & purchase ──
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
import styles from './MarketplacePage.module.css';
import { useIsMounted } from '../hooks/useIsMounted';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { fmt, fmtChips, timeAgo } from '../utils/format';

/* ═══ Types ═══ */
interface MarketplaceItem {
  id: string;
  club_id: string;
  name: string;
  description?: string;
  price: number;
  image_url?: string;
  category?: string;
  is_active: boolean;
  purchase_count?: number;
}

interface Purchase {
  id: string;
  item_id: string;
  price_paid: number;
  created_at: string;
  // BUG-12 FIX: API now joins item name+category so My Items works even for hidden/deleted items
  item_name?: string | null;
  item_category?: string | null;
}

/* ═══ Constants ═══ */
const CATEGORIES = [
  'All',
  'Time Banks',
  'Table Skins',
  'Throwables',
  'Emotes',
  'Avatars',
  'Exclusive',
];
type SortMode = 'newest' | 'price-low' | 'price-high' | 'popular';

/* ═══ Component ═══ */
export default function MarketplacePage() {
  const { user } = useAuthUser();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [tab, setTab] = useState<'store' | 'my_items' | 'manage'>('store');
  const [loading, setLoading] = useState(true);

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  const [clubId, setClubId] = useState<string | null>(null);
  const [role, setRole] = useState('player');
  const [processing, setProcessing] = useState(false);
  const [showSuccess, setShowSuccess] = useState<string | null>(null);

  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [balance, setBalance] = useState(0);
  const [buyTarget, setBuyTarget] = useState<MarketplaceItem | null>(null);

  // Filters & sort
  const [searchFilter, setSearchFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [sortMode, setSortMode] = useState<SortMode>('newest');

  // Admin manage
  const [adminItems, setAdminItems] = useState<MarketplaceItem[]>([]);
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemDesc, setNewItemDesc] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('Time Banks');
  const [newItemImage, setNewItemImage] = useState('');
  const [lastCreateTime, setLastCreateTime] = useState(0);

  const mountedRef = useIsMounted();
  const loadingRef = useRef(false);

  /* ═══ Data Loading — via World Hub API ═══ */
  const loadMarketplace = useCallback(
    async (cId?: string, silent = false) => {
      const targetClub = cId || clubId;
      if (!targetClub || !user) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        if (!silent) setLoading(true);

        // Get auth token for API call
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error('Not authenticated');

        // BUG-1 FIX: fetch() never throws on HTTP errors — wrap with explicit throw
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
            (data.items || []).map((i: any) => ({
              ...i,
              club_id: targetClub,
              is_active: true,
              // BUG-11 FIX: Use API-provided purchase_count instead of hardcoding 0
              purchase_count: i.purchase_count || 0,
            }))
          );
          setPurchases(data.purchases || []);
          setBalance(data.balance || 0);
          if (data.role) setRole(data.role);
        }
      } catch (err: any) {
        if (!silent) toast.error(err.message);
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [clubId, user]
  );

  /* ═══ Init ═══ */
  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    const init = async () => {
      const qClub = searchParams.get('club') || searchParams.get('clubId');
      let targetClub = qClub;
      // BUG-3 FIX: Only query club_members for club discovery when no clubId param.
      // Role is returned by the API in loadMarketplace — no need for redundant query.
      if (!targetClub) {
        const { data: mem } = await supabase
          .from('club_members')
          .select('club_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();
        targetClub = mem?.club_id || null;
      }
      if (targetClub && isMounted) {
        setClubId(targetClub);
        loadMarketplace(targetClub);
      } else if (isMounted) {
        toast.error('No club found.');
        setLoading(false);
      }
    };
    init();
    return () => {
      isMounted = false;
    };
  }, [user, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ═══ Realtime bus listeners ═══ */
  useEffect(() => {
    if (!clubId) return;
    const refresh = () => loadMarketplace(clubId, true);
    const unsubs = [
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 500),
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 500),
      masterBus.subscribeDebounced('CASHIER_BALANCE_CHANGED', refresh, 500),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, loadMarketplace]);

  /* ═══ Supabase real-time for item changes ═══ */
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    const channelKey = `marketplace-live-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'club_shop_items',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => {
            loadMarketplace(clubId, true);
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            console.error('[MarketplacePage] ❌ Realtime channel error:', err?.message || err);
          }
          if (status === 'TIMED_OUT') {
            console.warn('[MarketplacePage] ⏱️ Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[MarketplacePage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, loadMarketplace]);

  useVisibilityRefresh(async () => {
    if (clubId) loadMarketplace(clubId, true);
  });

  /* ═══ Purchase handler — via World Hub API ═══ */
  const handlePurchase = async () => {
    if (!buyTarget || !clubId || !user) return;
    setProcessing(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not authenticated');

      // BUG-1 FIX: fetch() never throws on HTTP errors — wrap with explicit throw
      // BUG-9 FIX: API requires X-Idempotency-Key header (UUID) to prevent double-charges
      const idempotencyKey = crypto.randomUUID();
      const purchaseWithThrow = async () => {
        const response = await fetch('/api/club-arena/marketplace-purchase', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ clubId, itemId: buyTarget.id }),
        });
        const responseData = await response
          .json()
          .catch(() => ({ success: false, error: `HTTP ${response.status}` }));
        if (!responseData.success) {
          throw new Error(responseData.error || 'Purchase failed');
        }
        return responseData;
      };

      const data = await retryAsync(purchaseWithThrow, 1);

      setShowSuccess(`Successfully purchased ${buyTarget.name}!`);
      setTimeout(() => setShowSuccess(null), 2500);
      setBalance(data.newBalance ?? balance - buyTarget.price);
      masterBus.emit('BALANCE_UPDATED', {
        source: 'marketplace_purchase',
        clubId,
      });
      setBuyTarget(null);
      // BUG-6 FIX: reset loadingRef before calling loadMarketplace so it's not blocked
      loadingRef.current = false;
      loadMarketplace(clubId, true);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setProcessing(false);
    }
  };

  /* ═══ Admin: Load all items ═══ */
  const loadAdminItems = useCallback(async () => {
    if (!clubId) return;
    try {
      const { data } = await supabase
        .from('club_shop_items')
        .select('id, club_id, name, description, price, image_url, category, is_active')
        .eq('club_id', clubId)
        .order('created_at', { ascending: false });
      if (mountedRef.current) {
        setAdminItems((data || []).map((i: any) => ({ ...i, purchase_count: 0 })));
        setAdminLoaded(true);
      }
    } catch (err: any) {
      toast.error(err.message);
    }
  }, [clubId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ═══ Computed data ═══ */
  const purchasedItemIds = useMemo(() => new Set(purchases.map((p) => p.item_id)), [purchases]);
  const itemMap = useMemo(() => {
    const map: Record<string, MarketplaceItem> = {};
    items.forEach((i) => {
      map[i.id] = i;
    });
    return map;
  }, [items]);

  const isAdmin = ['owner', 'admin'].includes(role);

  /* ═══ Filtered + sorted store items ═══ */
  const filteredItems = useMemo(() => {
    let result = [...items];

    // Category filter
    if (categoryFilter !== 'All') {
      result = result.filter(
        (item) => (item.category || 'Time Banks').toLowerCase() === categoryFilter.toLowerCase()
      );
    }

    // Search filter
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      result = result.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          (item.category || '').toLowerCase().includes(q) ||
          (item.description || '').toLowerCase().includes(q)
      );
    }

    // Sort
    switch (sortMode) {
      case 'price-low':
        result.sort((a, b) => a.price - b.price);
        break;
      case 'price-high':
        result.sort((a, b) => b.price - a.price);
        break;
      case 'popular':
        result.sort((a, b) => (b.purchase_count || 0) - (a.purchase_count || 0));
        break;
      case 'newest':
      default:
        // Already sorted by created_at desc from API
        break;
    }

    return result;
  }, [items, categoryFilter, searchFilter, sortMode]);

  /* ═══ Admin stats ═══ */
  const adminStats = useMemo(() => {
    const total = adminItems.length;
    const active = adminItems.filter((i) => i.is_active).length;
    const totalSold = adminItems.reduce((sum, i) => sum + (i.purchase_count || 0), 0);
    const totalRevenue = adminItems.reduce((sum, i) => sum + (i.purchase_count || 0) * i.price, 0);
    return { total, active, totalSold, totalRevenue };
  }, [adminItems]);

  /* ═══ Render ═══ */
  if (loading && items.length === 0) return <PageSkeleton variant="dashboard" />;

  return (
    <div className={styles.page}>
      {/* Success flash */}
      {showSuccess && <div className={styles.successFlash}>✅ {showSuccess}</div>}

      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>
            🛒 Item Shop
            <span className={styles.balanceBadge}>💰 {fmt(balance)} chips</span>
          </h1>
        </div>
        <div className={styles.headerActions}>
          <Link to="/" className={styles.btnGhost}>
            🏠 Lobby
          </Link>
          <button onClick={() => loadMarketplace(clubId || undefined)} className={styles.btnGhost}>
            ↻ Refresh
          </button>
        </div>
      </header>

      {/* Buy Confirm Modal */}
      {buyTarget && (
        <div className={styles.modalOverlay} onClick={() => !processing && setBuyTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>Confirm Purchase</h2>
            <div className={styles.purchasePreview}>
              <div className={styles.purchaseImage}>
                {buyTarget.image_url ? (
                  <img src={buyTarget.image_url} alt="" className={styles.itemImg} />
                ) : (
                  <div className={styles.itemPlaceholder}>🛒</div>
                )}
              </div>
              <div>
                <div className={styles.itemName}>{buyTarget.name}</div>
                <div className={styles.itemDesc}>{buyTarget.description}</div>
              </div>
            </div>
            <div className={styles.priceBox}>
              <div className={styles.priceItem}>
                <span className={styles.priceLabel}>Item Price</span>
                <span className={styles.priceValueRed}>{fmtChips(buyTarget.price)}</span>
              </div>
              <div className={styles.priceItem}>
                <span className={styles.priceLabel}>Your Balance</span>
                <span className={styles.priceValueGreen}>{fmtChips(balance)}</span>
              </div>
            </div>
            {balance < buyTarget.price && (
              <div className={styles.insufficientFunds}>
                ⚠️ Insufficient chips. You need {fmtChips(buyTarget.price - balance)} more.
              </div>
            )}
            <div className={styles.modalActions}>
              <button
                onClick={() => setBuyTarget(null)}
                className={styles.btnGhost}
                disabled={processing}
              >
                Cancel
              </button>
              <button
                onClick={handlePurchase}
                className={styles.btnPrimary}
                disabled={processing || balance < buyTarget.price}
              >
                {processing ? 'Purchasing...' : 'Confirm Purchase'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <nav className={styles.tabNav}>
        <button
          className={`${styles.tab} ${tab === 'store' ? styles.tabActive : ''}`}
          onClick={() => setTab('store')}
        >
          🛍️ Store <span className={styles.tabBadge}>{items.length}</span>
        </button>
        <button
          className={`${styles.tab} ${tab === 'my_items' ? styles.tabActive : ''}`}
          onClick={() => setTab('my_items')}
        >
          📦 My Items{' '}
          {purchases.length > 0 && <span className={styles.tabBadge}>{purchases.length}</span>}
        </button>
        {isAdmin && (
          <button
            className={`${styles.tab} ${tab === 'manage' ? styles.tabActive : ''}`}
            onClick={() => {
              setTab('manage');
              if (!adminLoaded) loadAdminItems();
            }}
          >
            🛠️ Manage
          </button>
        )}
      </nav>

      {/* ═══ Store Tab ═══ */}
      {tab === 'store' && (
        <div className={styles.section}>
          {items.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>🛍️</span>
              <span className={styles.emptyText}>The shop is currently empty.</span>
              <span className={styles.emptySubText}>
                Club owners can add in-game items like time banks, table skins, throwables, and
                emotes for members to purchase with chips.
              </span>
              {isAdmin && (
                <button
                  className={styles.emptyButton}
                  onClick={() => {
                    setTab('manage');
                    if (!adminLoaded) loadAdminItems();
                  }}
                >
                  ➕ Add First Item
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Category filters */}
              <div className={styles.categoryFilters}>
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    className={`${styles.categoryBtn} ${categoryFilter === cat ? styles.categoryBtnActive : ''}`}
                    onClick={() => setCategoryFilter(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Search + Sort toolbar */}
              <div className={styles.toolbar}>
                <input
                  type="text"
                  placeholder="🔍 Search items..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  className={styles.searchInput}
                />
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  className={styles.sortSelect}
                >
                  <option value="newest">Newest First</option>
                  <option value="price-low">Price: Low → High</option>
                  <option value="price-high">Price: High → Low</option>
                  <option value="popular">Most Popular</option>
                </select>
              </div>

              {/* Item grid */}
              {filteredItems.length === 0 ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>🔍</span>
                  <span className={styles.emptyText}>No items match your filters.</span>
                  <button
                    className={styles.emptyButton}
                    onClick={() => {
                      setCategoryFilter('All');
                      setSearchFilter('');
                    }}
                  >
                    Clear Filters
                  </button>
                </div>
              ) : (
                <div className={styles.itemGrid}>
                  {filteredItems.map((item) => {
                    const alreadyOwned = purchasedItemIds.has(item.id);
                    return (
                      <div key={item.id} className={styles.itemCard}>
                        <div className={styles.itemImageArea}>
                          {item.image_url ? (
                            <img
                              src={item.image_url}
                              alt={item.name}
                              className={styles.itemCover}
                            />
                          ) : (
                            <div className={styles.itemPlaceholderLg}>🎁</div>
                          )}
                          <span className={styles.categoryTag}>
                            {item.category || 'Time Banks'}
                          </span>
                        </div>
                        <div className={styles.itemBody}>
                          <div className={styles.itemName}>{item.name}</div>
                          <div className={styles.itemDesc}>
                            {item.description || 'No description available.'}
                          </div>
                          <div className={styles.itemFooter}>
                            <div>
                              <span className={styles.itemPrice}>💰 {fmtChips(item.price)}</span>
                              {(item.purchase_count || 0) > 0 && (
                                <div className={styles.soldCount}>{item.purchase_count} sold</div>
                              )}
                            </div>
                            <button
                              onClick={() => setBuyTarget(item)}
                              className={alreadyOwned ? styles.btnOwned : styles.btnPrimary}
                              disabled={alreadyOwned || processing}
                            >
                              {alreadyOwned ? '✓ Owned' : 'Buy'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══ My Items Tab ═══ */}
      {tab === 'my_items' && (
        <div className={styles.section}>
          {purchases.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>📦</span>
              <span className={styles.emptyText}>You haven&apos;t purchased any items yet.</span>
              <button className={styles.emptyButton} onClick={() => setTab('store')}>
                Browse Store
              </button>
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th>Price Paid</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p) => {
                    // BUG-12 FIX: Use API-joined item_name first, then itemMap fallback
                    const itemData = itemMap[p.item_id];
                    const displayName = p.item_name || itemData?.name || 'Unknown Item';
                    const displayCategory = p.item_category || itemData?.category || 'Time Banks';
                    return (
                      <tr key={p.id}>
                        <td style={{ fontWeight: 700 }}>{displayName}</td>
                        <td>
                          <span className={styles.categorySmall}>{displayCategory}</span>
                        </td>
                        <td style={{ fontWeight: 800, color: '#f7c52a' }}>
                          {fmtChips(p.price_paid)}
                        </td>
                        <td style={{ fontSize: '12px', color: '#8b8d91' }}>
                          {timeAgo(p.created_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══ Manage Tab ═══ */}
      {tab === 'manage' && (
        <div className={styles.section}>
          {/* Admin Stats */}
          <div className={styles.statsRow}>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{adminStats.total}</span>
              <span className={styles.statLabel}>Total Items</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{adminStats.active}</span>
              <span className={styles.statLabel}>Active</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{adminStats.totalSold}</span>
              <span className={styles.statLabel}>Total Sold</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{fmtChips(adminStats.totalRevenue)}</span>
              <span className={styles.statLabel}>Revenue</span>
            </div>
          </div>

          {/* Create Form */}
          <div className={styles.createForm}>
            <h3 className={styles.createTitle}>➕ Create Shop Item</h3>
            <div className={styles.formRow}>
              <input
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                placeholder="Item name"
                className={styles.formInput}
                maxLength={100}
              />
              <input
                type="number"
                value={newItemPrice}
                onChange={(e) => setNewItemPrice(e.target.value)}
                placeholder="Price (chips)"
                min="1"
                className={styles.formInput}
              />
            </div>
            <input
              value={newItemDesc}
              onChange={(e) => setNewItemDesc(e.target.value)}
              placeholder="Description (optional)"
              className={styles.formInput}
              maxLength={500}
            />
            <div className={styles.formRow}>
              <select
                value={newItemCategory}
                onChange={(e) => setNewItemCategory(e.target.value)}
                className={styles.formSelect}
              >
                {CATEGORIES.filter((c) => c !== 'All').map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
              <input
                value={newItemImage}
                onChange={(e) => setNewItemImage(e.target.value)}
                placeholder="Image URL (optional)"
                className={styles.formInput}
              />
            </div>
            <button
              className={styles.btnPrimary}
              disabled={processing || !newItemName.trim() || !newItemPrice}
              onClick={async () => {
                // Throttle: 3 second cooldown between creates
                const now = Date.now();
                if (now - lastCreateTime < 3000) {
                  toast.error('Please wait a moment before creating another item');
                  return;
                }
                if (newItemName.trim().length > 100) {
                  toast.error('Item name must be 100 characters or less');
                  return;
                }
                if (newItemDesc.trim().length > 500) {
                  toast.error('Description must be 500 characters or less');
                  return;
                }
                const price = Math.floor(Number(newItemPrice));
                if (!price || !Number.isFinite(price) || price <= 0) {
                  toast.error('Price must be a positive number');
                  return;
                }
                if (price > 1_000_000_000) {
                  toast.error('Price exceeds maximum allowed value');
                  return;
                }
                setProcessing(true);
                try {
                  const { error } = await supabase.from('club_shop_items').insert({
                    club_id: clubId,
                    name: newItemName.trim(),
                    price,
                    description: newItemDesc.trim() || null,
                    category: newItemCategory,
                    image_url: newItemImage.trim() || null,
                    is_active: true,
                  });
                  if (error) throw error;
                  toast.success('Item created!');
                  setLastCreateTime(Date.now());
                  setNewItemName('');
                  setNewItemPrice('');
                  setNewItemDesc('');
                  setNewItemImage('');
                  setNewItemCategory('Time Banks');
                  loadAdminItems();
                  // BUG-6 FIX: reset loadingRef so marketplace reload isn't blocked
                  loadingRef.current = false;
                  loadMarketplace(clubId || undefined, true);
                } catch (err: any) {
                  toast.error(err.message);
                } finally {
                  setProcessing(false);
                }
              }}
            >
              {processing ? 'Creating...' : 'Create Item'}
            </button>
          </div>

          {/* Admin item list */}
          {adminItems.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>🛠️</span>
              <span className={styles.emptyText}>No shop items. Create one above.</span>
            </div>
          ) : (
            <div className={styles.adminList}>
              {adminItems.map((item) => (
                <div key={item.id} className={styles.adminRow}>
                  <div>
                    <div
                      style={{
                        fontWeight: 700,
                        color: item.is_active ? '#e4e6eb' : '#6B7280',
                        fontSize: '14px',
                      }}
                    >
                      {item.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#8b8d91', marginTop: 2 }}>
                      {fmtChips(item.price)} chips •{' '}
                      <span className={styles.categorySmall}>{item.category || 'Time Banks'}</span>{' '}
                      • {item.purchase_count || 0} sold
                    </div>
                  </div>
                  <div className={styles.adminActions}>
                    <button
                      onClick={async () => {
                        try {
                          // BUG-5 FIX: scope update to club_id for safety
                          const { error: togErr } = await supabase
                            .from('club_shop_items')
                            .update({ is_active: !item.is_active })
                            .eq('id', item.id)
                            .eq('club_id', item.club_id);
                          if (togErr) throw togErr;
                          toast.success(item.is_active ? 'Item hidden' : 'Item activated');
                          loadAdminItems();
                          loadingRef.current = false;
                          loadMarketplace(clubId || undefined, true);
                        } catch (err: any) {
                          toast.error(err.message);
                        }
                      }}
                      className={item.is_active ? styles.btnActiveToggle : styles.btnInactiveToggle}
                    >
                      {item.is_active ? '✓ Active' : 'Hidden'}
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete "${item.name}"?`)) return;
                        try {
                          const { error: delErr } = await supabase
                            .from('club_shop_items')
                            .delete()
                            .eq('id', item.id)
                            .eq('club_id', item.club_id);
                          if (delErr) throw delErr;
                          toast.success('Item deleted');
                          loadAdminItems();
                          loadingRef.current = false;
                          loadMarketplace(clubId || undefined, true);
                        } catch (err: any) {
                          toast.error(err.message);
                        }
                      }}
                      className={styles.btnDeleteSmall}
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
