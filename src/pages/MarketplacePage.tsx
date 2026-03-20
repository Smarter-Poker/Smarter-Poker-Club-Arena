/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Marketplace Page
 *  2 Tabs: Store | My Items  (+Manage tab for admins)
 *  Ported from World Hub native page → Club Arena TSX
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
  marketplace_items?: { name: string; category: string }[];
}

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

  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [balance, setBalance] = useState(0);
  const [buyTarget, setBuyTarget] = useState<MarketplaceItem | null>(null);

  // Admin manage
  const [adminItems, setAdminItems] = useState<MarketplaceItem[]>([]);
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemDesc, setNewItemDesc] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [lastCreateTime, setLastCreateTime] = useState(0);

  const mountedRef = useIsMounted();

  const loadingRef = useRef(false);

  const loadMarketplace = useCallback(
    async (cId?: string, silent = false) => {
      const targetClub = cId || clubId;
      if (!targetClub || !user) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        if (!silent) {
          setLoading(true);
        }

        const [{ data: itemsData }, { data: purchasesData }, { data: memberData }] =
          await Promise.all([
            supabase
              .from('marketplace_items')
              .select(
                'id, club_id, name, description, price, image_url, category, is_active, purchase_count'
              )
              .eq('club_id', targetClub)
              .eq('is_active', true)
              .order('created_at', { ascending: false }),
            supabase
              .from('marketplace_purchases')
              .select('id, item_id, price_paid, created_at, marketplace_items(name, category)')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false }),
            supabase
              .from('club_members')
              .select('chip_balance')
              .eq('club_id', targetClub)
              .eq('user_id', user.id)
              .maybeSingle(),
          ]);

        if (mountedRef.current) {
          setItems(itemsData || []);
          setPurchases(purchasesData || []);
          setBalance(memberData?.chip_balance || 0);
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

  // Init
  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    const init = async () => {
      const qClub = searchParams.get('club') || searchParams.get('clubId');
      let targetClub = qClub;
      if (!targetClub) {
        const { data: mem } = await supabase
          .from('club_members')
          .select('club_id, role')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();
        targetClub = mem?.club_id || null;
        if (mem?.role && isMounted) setRole(mem.role);
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

  // Realtime bus listeners (debounced)
  useEffect(() => {
    if (!clubId) return;
    const refresh = () => loadMarketplace(clubId, true);
    const unsubs = [
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 500),
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 500),
      // Phase 4: Cross-page sync (ported from World Hub marketplace.js)
      masterBus.subscribeDebounced('CASHIER_BALANCE_CHANGED', refresh, 500),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, loadMarketplace]);

  // Supabase real-time for marketplace item changes (stock updates, new items)
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
            table: 'marketplace_items',
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

  // Purchase
  const handlePurchase = async () => {
    if (!buyTarget || !clubId || !user) return;
    setProcessing(true);
    try {
      // Deduct chips
      const { error: deductErr } = await retryAsync(
        () =>
          supabase.rpc('deduct_marketplace_chips', {
            p_club_id: clubId,
            p_user_id: user.id,
            p_amount: buyTarget.price,
            p_item_id: buyTarget.id,
          }),
        3
      );
      if (deductErr) throw deductErr;

      toast.success(`Successfully purchased ${buyTarget.name}!`);
      setBalance((prev) => prev - buyTarget.price);
      masterBus.emit('BALANCE_UPDATED', {
        source: 'marketplace_purchase',
        clubId,
      });
      setBuyTarget(null);
      loadMarketplace(clubId, true);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setProcessing(false);
    }
  };

  // Admin: Load shop items
  const loadAdminItems = useCallback(async () => {
    if (!clubId) return;
    try {
      const { data } = await supabase
        .from('marketplace_items')
        .select(
          'id, club_id, name, description, price, image_url, category, is_active, purchase_count'
        )
        .eq('club_id', clubId)
        .order('created_at', { ascending: false });
      if (mountedRef.current) {
        setAdminItems(data || []);
        setAdminLoaded(true);
      }
    } catch (err: any) {
      toast.error(err.message);
    }
  }, [clubId]); // eslint-disable-line react-hooks/exhaustive-deps

  const purchasedItemIds = useMemo(() => new Set(purchases.map((p) => p.item_id)), [purchases]);
  const itemMap = useMemo(() => {
    const map: Record<string, MarketplaceItem> = {};
    items.forEach((i) => {
      map[i.id] = i;
    });
    return map;
  }, [items]);

  if (loading && items.length === 0) return <PageSkeleton variant="dashboard" />;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>
            🛒 Marketplace
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
                <span className={styles.priceLabel}>Available Chips</span>
                <span className={styles.priceValueGreen}>{fmtChips(balance)}</span>
              </div>
            </div>
            {balance < buyTarget.price && (
              <div className={styles.insufficientFunds}>
                Insufficient chips. You need {fmtChips(buyTarget.price - balance)} more.
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
          Store <span className={styles.tabBadge}>{items.length}</span>
        </button>
        <button
          className={`${styles.tab} ${tab === 'my_items' ? styles.tabActive : ''}`}
          onClick={() => setTab('my_items')}
        >
          My Items{' '}
          {purchases.length > 0 && <span className={styles.tabBadge}>{purchases.length}</span>}
        </button>
        {['owner', 'admin'].includes(role) && (
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

      {/* Store Tab */}
      {tab === 'store' && (
        <div className={styles.section}>
          {items.length === 0 ? (
            <div
              className={styles.emptyState}
              style={{ textAlign: 'center', padding: '2rem 1.5rem' }}
            >
              <span
                className={styles.emptyIcon}
                style={{ fontSize: '2.5rem', display: 'block', marginBottom: '0.75rem' }}
              >
                🛍️
              </span>
              <span
                className={styles.emptyText}
                style={{
                  fontSize: '1.05rem',
                  fontWeight: 600,
                  display: 'block',
                  marginBottom: '0.5rem',
                }}
              >
                The store is currently empty.
              </span>
              <span style={{ color: 'var(--soft-white, #B0B3B8)', fontSize: '0.85rem' }}>
                Check back soon — your club owner can add items for members to purchase with chips.
              </span>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: '12px' }}>
                <input
                  type="text"
                  placeholder="🔍 Search items..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  className={styles.formInput}
                  style={{ width: '100%', maxWidth: '300px' }}
                />
              </div>
              <div className={styles.itemGrid}>
                {items
                  .filter((item) => {
                    if (!searchFilter.trim()) return true;
                    const q = searchFilter.toLowerCase();
                    return (
                      item.name.toLowerCase().includes(q) ||
                      (item.category || '').toLowerCase().includes(q) ||
                      (item.description || '').toLowerCase().includes(q)
                    );
                  })
                  .map((item) => {
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
                          <span className={styles.categoryTag}>{item.category || 'General'}</span>
                        </div>
                        <div className={styles.itemBody}>
                          <div className={styles.itemName}>{item.name}</div>
                          <div className={styles.itemDesc}>
                            {item.description || 'No description available.'}
                          </div>
                          <div className={styles.itemFooter}>
                            <span className={styles.itemPrice}>{fmtChips(item.price)}</span>
                            <button
                              onClick={() => setBuyTarget(item)}
                              className={alreadyOwned ? styles.btnOwned : styles.btnPrimary}
                              disabled={alreadyOwned || processing}
                            >
                              {alreadyOwned ? 'Owned' : 'Buy'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </>
          )}
        </div>
      )}

      {/* My Items Tab */}
      {tab === 'my_items' && (
        <div className={styles.section}>
          {purchases.length === 0 ? (
            <div
              className={styles.emptyState}
              style={{ textAlign: 'center', padding: '2rem 1.5rem' }}
            >
              <span
                className={styles.emptyIcon}
                style={{ fontSize: '2.5rem', display: 'block', marginBottom: '0.75rem' }}
              >
                📦
              </span>
              <span
                className={styles.emptyText}
                style={{
                  fontSize: '1.05rem',
                  fontWeight: 600,
                  display: 'block',
                  marginBottom: '0.5rem',
                }}
              >
                You haven&apos;t purchased any items yet.
              </span>
              <button
                onClick={() => setTab('store')}
                style={{
                  marginTop: '0.75rem',
                  padding: '8px 20px',
                  background: 'rgba(65,105,225,0.15)',
                  border: '1px solid rgba(65,105,225,0.3)',
                  borderRadius: '8px',
                  color: '#a5b4fc',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
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
                    const joinedItem = p.marketplace_items?.[0];
                    const itemData = itemMap[p.item_id];
                    const displayName = joinedItem?.name || itemData?.name || 'Deleted Item';
                    const displayCategory = joinedItem?.category || itemData?.category || 'General';
                    return (
                      <tr key={p.id}>
                        <td style={{ fontWeight: 600 }}>{displayName}</td>
                        <td>
                          <span className={styles.categorySmall}>{displayCategory}</span>
                        </td>
                        <td style={{ fontWeight: 700, color: '#F7C52A' }}>
                          {fmtChips(p.price_paid)}
                        </td>
                        <td style={{ fontSize: '13px', color: '#B0B3B8' }}>
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

      {/* Manage Tab */}
      {tab === 'manage' && (
        <div className={styles.section}>
          <div className={styles.createForm}>
            <h3 className={styles.createTitle}>➕ Create Shop Item</h3>
            <input
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder="Item name"
              className={styles.formInput}
            />
            <input
              type="number"
              value={newItemPrice}
              onChange={(e) => setNewItemPrice(e.target.value)}
              placeholder="Price (chips)"
              min="1"
              className={styles.formInput}
            />
            <input
              value={newItemDesc}
              onChange={(e) => setNewItemDesc(e.target.value)}
              placeholder="Description (optional)"
              className={styles.formInput}
            />
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
                // Validate item name length to prevent abuse
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
                  const { error } = await supabase.from('marketplace_items').insert({
                    club_id: clubId,
                    name: newItemName.trim(),
                    price,
                    description: newItemDesc.trim() || null,
                    is_active: true,
                  });
                  if (error) throw error;
                  toast.success('Item created!');
                  setLastCreateTime(Date.now());
                  setNewItemName('');
                  setNewItemPrice('');
                  setNewItemDesc('');
                  loadAdminItems();
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
                    <div style={{ fontWeight: 600, color: item.is_active ? '#E4E6EB' : '#6B7280' }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#B0B3B8' }}>
                      {fmtChips(item.price)} chips • {item.purchase_count || 0} sold
                    </div>
                  </div>
                  <div className={styles.adminActions}>
                    <button
                      onClick={async () => {
                        try {
                          const { error: togErr } = await supabase
                            .from('marketplace_items')
                            .update({ is_active: !item.is_active })
                            .eq('id', item.id);
                          if (togErr) throw togErr;
                          toast.success(item.is_active ? 'Item hidden' : 'Item activated');
                          loadAdminItems();
                          loadMarketplace(clubId || undefined, true);
                        } catch (err: any) {
                          toast.error(err.message);
                        }
                      }}
                      className={item.is_active ? styles.btnActiveToggle : styles.btnInactiveToggle}
                    >
                      {item.is_active ? 'Active' : 'Hidden'}
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete "${item.name}"?`)) return;
                        try {
                          // SECURITY: Filter by both id AND club_id to prevent cross-club deletion
                          const { error: delErr } = await supabase
                            .from('marketplace_items')
                            .delete()
                            .eq('id', item.id)
                            .eq('club_id', item.club_id);
                          if (delErr) throw delErr;
                          toast.success('Item deleted');
                          loadAdminItems();
                          loadMarketplace(clubId || undefined, true);
                        } catch (err: any) {
                          toast.error(err.message);
                        }
                      }}
                      className={styles.btnDeleteSmall}
                    >
                      🗑️
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
