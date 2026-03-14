/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Marketplace Page
 *  2 Tabs: Store | My Items  (+Manage tab for admins)
 *  Ported from World Hub native page → Club Arena TSX
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import styles from './MarketplacePage.module.css';

const fmt = (n: number) => Number(n || 0).toLocaleString();
const fmtChips = (n: number) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return fmt(v);
};
const timeAgo = (ts: string | null) => {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

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
}

export default function MarketplacePage() {
  const { user } = useAuthUser();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [tab, setTab] = useState<'store' | 'my_items' | 'manage'>('store');
  const [loading, setLoading] = useState(true);
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

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const loadMarketplace = useCallback(
    async (cId?: string, silent = false) => {
      const targetClub = cId || clubId;
      if (!targetClub || !user) return;
      try {
        if (!silent) {
          setLoading(true);
        }

        const [{ data: itemsData }, { data: purchasesData }, { data: memberData }] =
          await Promise.all([
            supabase
              .from('marketplace_items')
              .select('*')
              .eq('club_id', targetClub)
              .eq('is_active', true)
              .order('created_at', { ascending: false }),
            supabase
              .from('marketplace_purchases')
              .select('*')
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

  // Realtime bus listeners
  useEffect(() => {
    if (!clubId) return;
    const refresh = () => loadMarketplace(clubId, true);
    const unsubs = [
      masterBus.subscribe('CHIPS_DISTRIBUTED', refresh),
      masterBus.subscribe('BALANCE_UPDATED', refresh),
      // Phase 4: Cross-page sync (ported from World Hub marketplace.js)
      masterBus.subscribe('CASHIER_BALANCE_CHANGED', refresh),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, loadMarketplace]);

  // Supabase real-time for marketplace item changes (stock updates, new items)
  useEffect(() => {
    if (!clubId) return;
    const channelKey = `marketplace-live-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'marketplace_items',
          filter: `club_id=eq.${clubId}`,
        },
        () => {
          loadMarketplace(clubId, true);
        }
      )
      .subscribe();

    return () => {
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
        balance: balance - buyTarget.price,
      });
      setBuyTarget(null);
      loadMarketplace(clubId);
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
        .select('*')
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
          <Link to="/lobby" className={styles.btnGhost}>
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
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>🛍️</span>
              <span className={styles.emptyText}>The store is currently empty.</span>
            </div>
          ) : (
            <div className={styles.itemGrid}>
              {items.map((item) => {
                const alreadyOwned = purchasedItemIds.has(item.id);
                return (
                  <div key={item.id} className={styles.itemCard}>
                    <div className={styles.itemImageArea}>
                      {item.image_url ? (
                        <img src={item.image_url} alt={item.name} className={styles.itemCover} />
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
          )}
        </div>
      )}

      {/* My Items Tab */}
      {tab === 'my_items' && (
        <div className={styles.section}>
          {purchases.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>📦</span>
              <span className={styles.emptyText}>You haven&apos;t purchased any items yet.</span>
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
                    const itemData = itemMap[p.item_id];
                    return (
                      <tr key={p.id}>
                        <td style={{ fontWeight: 600 }}>{itemData?.name || 'Unknown Item'}</td>
                        <td>
                          <span className={styles.categorySmall}>
                            {itemData?.category || 'General'}
                          </span>
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
              disabled={processing || !newItemName || !newItemPrice}
              onClick={async () => {
                const price = Math.floor(Number(newItemPrice));
                if (!price || !Number.isFinite(price) || price <= 0) {
                  toast.error('Price must be a positive number');
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
                          const { error: delErr } = await supabase
                            .from('marketplace_items')
                            .delete()
                            .eq('id', item.id);
                          if (delErr) throw delErr;
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
