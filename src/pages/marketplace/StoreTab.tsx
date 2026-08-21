/**
 * MARKETPLACE — Store tab: club shop items bought with club chips.
 * Purchases go through /api/club-arena/marketplace-purchase (server-authoritative).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { useToast } from '../../components/common/Toast';
import { masterBus } from '../../core/MasterBus';
import { fmt, fmtChips } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import {
  CATEGORIES,
  describeGrant,
  effectivePrice,
  isOnSale,
  safeImageUrl,
  unavailableReason,
  type MarketplaceItem,
  type ShopCategoryInfo,
  type SortMode,
} from './marketplaceShared';

interface StoreTabProps {
  clubId: string;
  items: MarketplaceItem[];
  ownedItemIds: Set<string>;
  balance: number;
  isAdmin: boolean;
  /** true while the shop is still loading — do NOT claim the shop is empty */
  loading: boolean;
  /** server catalog categories (drives the filter chips + grant wording) */
  categories: ShopCategoryInfo[];
  onGoManage: () => void;
  onPurchased: (newBalance: number | null) => void;
}

export default function StoreTab({
  clubId,
  items,
  ownedItemIds,
  balance,
  isAdmin,
  loading,
  categories,
  onGoManage,
  onPurchased,
}: StoreTabProps) {
  const toast = useToast();
  // Server-truth seconds per time-bank use, so the card and the Manage preview
  // can never disagree.
  const secondsPerUse = categories.find((c) => c.grantType === 'time_bank')?.secondsPerUse ?? 20;
  const grantText = (item: MarketplaceItem) => describeGrant(item.grant_spec, secondsPerUse);
  // L18: category chips come from the server catalog when it is available.
  const categoryNames =
    categories.length > 0 ? ['All', ...categories.map((c) => c.name)] : CATEGORIES;
  const [buyTarget, setBuyTarget] = useState<MarketplaceItem | null>(null);
  const [processing, setProcessing] = useState(false);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
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
    // Sold-out items always sink, whatever the sort.
    const soldOutRank = (i: MarketplaceItem) => (unavailableReason(i, false, true) ? 1 : 0);
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
    result.sort((a, b) => soldOutRank(a) - soldOutRank(b));
    return result;
  }, [items, categoryFilter, searchFilter, sortMode]);

  // Modal a11y: Escape to close, initial focus on Confirm, background locked.
  // Scroll lock + initial focus: keyed on the target only, so a busy-state
  // toggle cannot yank focus back to Confirm mid-interaction.
  useEffect(() => {
    if (!buyTarget) return;
    const prevOverflow = document.body.style.overflow;
    const trigger = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    confirmBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      trigger?.focus?.();
    };
  }, [buyTarget]);

  // Escape needs the live `processing` value, so it gets its own effect.
  useEffect(() => {
    if (!buyTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !processing) setBuyTarget(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [buyTarget, processing]);

  const modalImg = buyTarget ? safeImageUrl(buyTarget.image_url) : null;

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
      // A stale card (sold out, or already owned in another tab) must not leave
      // the confirm modal sitting open over data we now know is wrong.
      const flags = (
        err as { data?: { soldOut?: boolean; alreadyOwned?: boolean; limitReached?: boolean } }
      )?.data;
      if (flags?.soldOut || flags?.alreadyOwned || flags?.limitReached) {
        setBuyTarget(null);
        onPurchased(null);
      }
    } finally {
      setProcessing(false);
    }
  };

  if (items.length === 0 && loading) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyText}>Loading The Shop...</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon}>◇</span>
        <span className={styles.emptyText}>The Club Shop Is Currently Empty.</span>
        <span className={styles.emptySubText}>
          Club Owners Can Add In-Game Items Like Time Banks, Table Skins, Throwables, And Emotes For
          Members To Purchase With Chips.
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
          <div
            className={styles.modal}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="buy-modal-title"
          >
            <h2 className={styles.modalTitle} id="buy-modal-title">
              Confirm Purchase
            </h2>
            <div className={styles.purchasePreview}>
              <div className={styles.purchaseImage}>
                {modalImg ? (
                  <img
                    src={modalImg}
                    alt={buyTarget.name}
                    className={styles.itemImg}
                    referrerPolicy="no-referrer"
                    loading="lazy"
                  />
                ) : (
                  <div className={styles.itemPlaceholder}>◇</div>
                )}
              </div>
              <div>
                <div className={styles.itemName}>{buyTarget.name}</div>
                <div className={styles.itemDesc}>{buyTarget.description}</div>
                {grantText(buyTarget) && (
                  <div className={styles.grantLine}>Grants On Redeem: {grantText(buyTarget)}</div>
                )}
              </div>
            </div>
            <div className={styles.priceBox}>
              <div className={styles.priceItem}>
                <span className={styles.priceLabel}>Item Price</span>
                <span className={styles.priceValueRed}>
                  {isOnSale(buyTarget) && (
                    <span className={styles.strikePrice}>{fmt(buyTarget.price)}</span>
                  )}
                  {fmt(effectivePrice(buyTarget))}
                </span>
              </div>
              <div className={styles.priceItem}>
                <span className={styles.priceLabel}>Your Balance</span>
                <span className={styles.priceValueGreen}>{fmt(balance)}</span>
              </div>
            </div>
            {balance < effectivePrice(buyTarget) && (
              <div className={styles.insufficientFunds}>
                {/* The "Get Chips" upsell pointed at the diamonds -> chips
                    conversion, which is forbidden (product rule, Dan
                    2026-08-19). Chips are won and transferred, never bought. */}
                Insufficient Chips. You Need {fmt(effectivePrice(buyTarget) - balance)} More.
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
                ref={confirmBtnRef}
                onClick={handlePurchase}
                className={styles.btnPrimary}
                disabled={processing || balance < effectivePrice(buyTarget)}
              >
                {processing ? 'Purchasing...' : 'Confirm Purchase'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Category filters */}
      {/* A filter chip row is a set of toggles, not a list of unrelated
          buttons: without aria-pressed a screen reader reads seven identical
          "button" nodes and cannot say which category is active. The visual
          state was carried only by a CSS class. */}
      <div className={styles.categoryFilters} role="group" aria-label="Filter items by category">
        {categoryNames.map((cat) => (
          <button
            key={cat}
            type="button"
            aria-pressed={categoryFilter === cat}
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
          aria-label="Search shop items"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          className={styles.searchInput}
        />
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className={styles.sortSelect}
          aria-label="Sort shop items"
        >
          <option value="newest">Newest First</option>
          <option value="price-low">Price: Low To High</option>
          <option value="price-high">Price: High To Low</option>
          <option value="popular">Most Popular</option>
        </select>
      </div>

      {/* Item grid */}
      {filteredItems.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>?</span>
          <span className={styles.emptyText}>No Items Match Your Filters.</span>
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
            const img = safeImageUrl(item.image_url);
            const limited = item.stock !== null && item.stock !== undefined;
            const stackable = !!item.stackable;
            const blocked = unavailableReason(item, alreadyOwned, stackable);
            const soldOut = blocked === 'sold_out';
            const onSale = isOnSale(item);
            const buyLabel =
              blocked === 'owned'
                ? 'Owned'
                : blocked === 'sold_out'
                  ? 'Sold out'
                  : blocked === 'not_yet'
                    ? 'Coming soon'
                    : blocked === 'ended'
                      ? 'Ended'
                      : blocked === 'limit_reached'
                        ? 'Limit reached'
                        : stackable && alreadyOwned
                          ? 'Buy again'
                          : 'Buy';
            return (
              <div key={item.id} className={styles.itemCard}>
                <div className={styles.itemImageArea}>
                  {img ? (
                    <img
                      src={img}
                      alt={item.name}
                      className={styles.itemCover}
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className={styles.itemPlaceholderLg}>◇</div>
                  )}
                  <span className={styles.categoryTag}>{item.category || 'Time Banks'}</span>
                  {soldOut && <span className={styles.soldOutTag}>SOLD OUT</span>}
                  {limited && !soldOut && (
                    <span className={styles.stockTag}>{item.stock} Left</span>
                  )}
                  {onSale && !soldOut && <span className={styles.saleTag}>SALE</span>}
                  {item.per_user_limit && !blocked ? (
                    <span className={styles.stockTag}>
                      {Math.max(0, item.per_user_limit - (item.my_purchase_count ?? 0))} Left For
                      You
                    </span>
                  ) : null}
                </div>
                <div className={styles.itemBody}>
                  <div className={styles.itemName}>{item.name}</div>
                  <div className={styles.itemDesc}>
                    {item.description || 'No description available.'}
                  </div>
                  {grantText(item) && <div className={styles.grantBadge}>{grantText(item)}</div>}
                  <div className={styles.itemFooter}>
                    <div>
                      <span className={styles.itemPrice}>
                        {onSale && (
                          <span className={styles.strikePrice}>{fmtChips(item.price)}</span>
                        )}
                        {fmtChips(effectivePrice(item))} Chips
                      </span>
                      {(item.purchase_count || 0) > 0 && (
                        <div className={styles.soldCount}>{item.purchase_count} Sold</div>
                      )}
                    </div>
                    <button
                      onClick={() => setBuyTarget(item)}
                      className={blocked === 'owned' ? styles.btnOwned : styles.btnPrimary}
                      disabled={!!blocked || processing}
                      title={
                        blocked === 'not_yet' && item.available_from
                          ? `Available from ${new Date(item.available_from).toLocaleString()}`
                          : undefined
                      }
                    >
                      {buyLabel}
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
