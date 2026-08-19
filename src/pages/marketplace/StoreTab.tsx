/**
 * MARKETPLACE — Store tab: club shop items bought with club chips.
 * Purchases go through /api/club-arena/marketplace-purchase (server-authoritative).
 */

import { useMemo, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { useToast } from '../../components/common/Toast';
import { masterBus } from '../../core/MasterBus';
import { fmtChips } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import { CATEGORIES, type MarketplaceItem, type SortMode } from './marketplaceShared';

interface StoreTabProps {
  clubId: string;
  items: MarketplaceItem[];
  ownedItemIds: Set<string>;
  balance: number;
  isAdmin: boolean;
  onGoManage: () => void;
  onGoChips: () => void;
  onPurchased: (newBalance: number | null) => void;
}

export default function StoreTab({
  clubId,
  items,
  ownedItemIds,
  balance,
  isAdmin,
  onGoManage,
  onGoChips,
  onPurchased,
}: StoreTabProps) {
  const toast = useToast();
  const [buyTarget, setBuyTarget] = useState<MarketplaceItem | null>(null);
  const [processing, setProcessing] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [sortMode, setSortMode] = useState<SortMode>('newest');

  const filteredItems = useMemo(() => {
    let result = [...items];
    if (categoryFilter !== 'All') {
      result = result.filter(
        (item) => (item.category || 'Time Banks').toLowerCase() === categoryFilter.toLowerCase()
      );
    }
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      result = result.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          (item.category || '').toLowerCase().includes(q) ||
          (item.description || '').toLowerCase().includes(q)
      );
    }
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
      default:
        break;
    }
    return result;
  }, [items, categoryFilter, searchFilter, sortMode]);

  const handlePurchase = async () => {
    if (!buyTarget || processing) return;
    setProcessing(true);
    try {
      const data = await callClubArenaApi<{ newBalance: number }>('marketplace-purchase', {
        clubId,
        itemId: buyTarget.id,
      });
      toast.success(`Purchased ${buyTarget.name}`);
      masterBus.emit('BALANCE_UPDATED', { source: 'marketplace_purchase', clubId });
      setBuyTarget(null);
      onPurchased(typeof data.newBalance === 'number' ? data.newBalance : null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setProcessing(false);
    }
  };

  if (items.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon}>◇</span>
        <span className={styles.emptyText}>The club shop is currently empty.</span>
        <span className={styles.emptySubText}>
          Club owners can add in-game items like time banks, table skins, throwables, and emotes
          for members to purchase with chips.
        </span>
        {isAdmin && (
          <button className={styles.emptyButton} onClick={onGoManage}>
            + Add First Item
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Buy confirm modal */}
      {buyTarget && (
        <div className={styles.modalOverlay} onClick={() => !processing && setBuyTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>Confirm Purchase</h2>
            <div className={styles.purchasePreview}>
              <div className={styles.purchaseImage}>
                {buyTarget.image_url ? (
                  <img src={buyTarget.image_url} alt="" className={styles.itemImg} />
                ) : (
                  <div className={styles.itemPlaceholder}>◇</div>
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
                Insufficient chips. You need {fmtChips(buyTarget.price - balance)} more.{' '}
                <button className={styles.inlineLink} onClick={onGoChips}>
                  Get Chips
                </button>
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

      {/* Search + sort */}
      <div className={styles.toolbar}>
        <input
          type="text"
          placeholder="Search items..."
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
          <option value="price-low">Price: Low to High</option>
          <option value="price-high">Price: High to Low</option>
          <option value="popular">Most Popular</option>
        </select>
      </div>

      {/* Item grid */}
      {filteredItems.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>?</span>
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
            const alreadyOwned = ownedItemIds.has(item.id);
            return (
              <div key={item.id} className={styles.itemCard}>
                <div className={styles.itemImageArea}>
                  {item.image_url ? (
                    <img src={item.image_url} alt={item.name} className={styles.itemCover} />
                  ) : (
                    <div className={styles.itemPlaceholderLg}>◇</div>
                  )}
                  <span className={styles.categoryTag}>{item.category || 'Time Banks'}</span>
                </div>
                <div className={styles.itemBody}>
                  <div className={styles.itemName}>{item.name}</div>
                  <div className={styles.itemDesc}>
                    {item.description || 'No description available.'}
                  </div>
                  <div className={styles.itemFooter}>
                    <div>
                      <span className={styles.itemPrice}>{fmtChips(item.price)} chips</span>
                      {(item.purchase_count || 0) > 0 && (
                        <div className={styles.soldCount}>{item.purchase_count} sold</div>
                      )}
                    </div>
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
    </>
  );
}
