/**
 * MARKETPLACE — Store tab: club shop items bought with DIAMONDS from the
 * player's global wallet (never chips — product rule, Dan 2026-08-23).
 * Purchases go through /api/club-arena/marketplace-purchase (server-authoritative).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { useToast } from '../../components/common/Toast';
import { masterBus } from '../../core/MasterBus';
import { fmt } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import ItemArt from './ItemArt';
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
  /** the buyer's DIAMOND balance (global wallet) — all prices are in diamonds */
  balance: number;
  /** jump to the Diamonds tab to top up */
  onGoDiamonds: () => void;
  isAdmin: boolean;
  /** true while the shop is still loading — do NOT claim the shop is empty */
  loading: boolean;
  /**
   * Set when the shop FETCH failed. An empty list and a failed read are
   * different statements, and this rendered both as "The Club Shop Is
   * Currently Empty." - complete with an admin "Add First Item" call to
   * action - while the real reason sat in a banner above.
   */
  error?: string | null;
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
  onGoDiamonds,
  isAdmin,
  loading,
  error = null,
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
  /**
   * The modal holds an ID and derives the item LIVE (Dan 2026-08-25).
   *
   * It used to hold a frozen snapshot taken at click time, while the page
   * refreshes `items` behind it on every balance bus event and on visibility
   * return. End a sale or raise a price with the modal open and the modal kept
   * rendering the OLD price and checking affordability against it, while the
   * server charged the new one: confirm 500, get debited 900.
   */
  const [buyTargetId, setBuyTargetId] = useState<string | null>(null);
  const buyTarget = useMemo(
    () => (buyTargetId ? (items.find((i) => i.id === buyTargetId) ?? null) : null),
    [items, buyTargetId]
  );
  /**
   * One key per purchase INTENT, minted when the modal opens and reused by
   * every retry of that same intent. See ClubArenaApiOptions.idempotencyKey.
   */
  const purchaseKeyRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
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
        /* "Featured", not "Newest" (Dan 2026-08-25). This case was
           `default: break` - the select's DEFAULT option was inert, so a member
           who picked "Price: Low To High" and then tried to undo it got whatever
           arbitrary order the API returned. MarketplaceItem has no created_at,
           so a truthful "Newest" is impossible without an API change and
           faking it would be worse. It DOES have sort_order, which admins set
           in ManageTab under the hint "Lower Shows First" and which the
           storefront never honoured. */
        result.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
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
      if (e.key === 'Escape' && !processing) closeBuy();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [buyTarget, processing]);

  const modalImg = buyTarget ? safeImageUrl(buyTarget.image_url) : null;

  const openBuy = (item: MarketplaceItem) => {
    purchaseKeyRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBuyTargetId(item.id);
  };

  const closeBuy = () => {
    purchaseKeyRef.current = null;
    setBuyTargetId(null);
  };

  /**
   * Re-checked on every render, not captured at click time. `ownedItemIds` and
   * `stock` change while the modal sits open (the page reloads inventory and
   * the shop behind it), so Confirm stayed live for an item that had since
   * become owned / sold out / ended, and only the server stopped the charge.
   */
  const modalBlocked = buyTarget
    ? unavailableReason(buyTarget, ownedItemIds.has(buyTarget.id), !!buyTarget.stackable)
    : null;

  const handlePurchase = async () => {
    if (!buyTarget) return;
    // A REF, not the state flag. `processing` is only visible to a later event
    // after React commits, so a synthetic double-fire in the same tick (iOS
    // touch-then-click, Enter landing with a click) passed both guards.
    if (inFlightRef.current) return;
    if (modalBlocked) return;
    inFlightRef.current = true;
    setProcessing(true);
    try {
      const data = await callClubArenaApi<{ newBalance: number }>(
        'marketplace-purchase',
        { clubId, itemId: buyTarget.id },
        { idempotencyKey: purchaseKeyRef.current ?? undefined }
      );
      toast.success(`Purchased ${buyTarget.name}`);
      masterBus.emit('BALANCE_UPDATED', { source: 'marketplace_purchase', clubId });
      closeBuy();
      onPurchased(typeof data.newBalance === 'number' ? data.newBalance : null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
      // A stale card (sold out, or already owned in another tab) must not leave
      // the confirm modal sitting open over data we now know is wrong.
      const flags = (
        err as { data?: { soldOut?: boolean; alreadyOwned?: boolean; limitReached?: boolean } }
      )?.data;
      if (flags?.soldOut || flags?.alreadyOwned || flags?.limitReached) {
        closeBuy();
        onPurchased(null);
      }
    } finally {
      inFlightRef.current = false;
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

  // A failed read is NOT an empty shop. Checked before the empty state so the
  // page never tells an owner their stock is gone because a request failed.
  if (items.length === 0 && error) {
    return (
      <div className={styles.emptyState} role="alert">
        <span className={styles.emptyText}>Could Not Load The Shop.</span>
        <span className={styles.emptySubText}>
          Your Items Are Still There. We Just Could Not Reach Them Right Now.
        </span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyArt}>
          <ItemArt category="Exclusive" seed="empty-shop" />
        </div>
        <span className={styles.emptyText}>The Club Shop Is Currently Empty.</span>
        <span className={styles.emptySubText}>
          Club Owners Can Add In-Game Items Like Time Banks, Table Skins, Throwables, And Emotes For
          Members To Purchase With Diamonds.
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
        <div className={styles.modalOverlay} onClick={() => !processing && closeBuy()}>
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
                  <ItemArt category={buyTarget.category} seed={buyTarget.id} />
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
                  {fmt(effectivePrice(buyTarget))} Diamonds
                </span>
              </div>
              <div className={styles.priceItem}>
                <span className={styles.priceLabel}>Your Diamonds</span>
                <span className={styles.priceValueGreen}>{fmt(balance)}</span>
              </div>
            </div>
            {balance < effectivePrice(buyTarget) && (
              <div className={styles.insufficientFunds}>
                <span>
                  Insufficient Diamonds. You Need {fmt(effectivePrice(buyTarget) - balance)} More.
                </span>
                <button
                  className={styles.inlineLink}
                  onClick={() => {
                    closeBuy();
                    onGoDiamonds();
                  }}
                >
                  Get Diamonds
                </button>
              </div>
            )}
            <div className={styles.modalActions}>
              <button onClick={closeBuy} className={styles.btnGhost} disabled={processing}>
                Cancel
              </button>
              <button
                ref={confirmBtnRef}
                onClick={handlePurchase}
                className={styles.btnPrimary}
                disabled={processing || !!modalBlocked || balance < effectivePrice(buyTarget)}
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
          placeholder="Search Items..."
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
          <option value="newest">Featured</option>
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
                  ? 'Sold Out'
                  : blocked === 'not_yet'
                    ? 'Coming Soon'
                    : blocked === 'ended'
                      ? 'Ended'
                      : blocked === 'limit_reached'
                        ? 'Limit Reached'
                        : stackable && alreadyOwned
                          ? 'Buy Again'
                          : 'Buy';
            return (
              <div key={item.id} className={styles.itemCard}>
                <div className={styles.itemImageArea}>
                  {/* Custom dynamic HD art always renders underneath; an
                      admin-supplied image simply layers over it, so a broken
                      URL degrades to the 3D scene instead of a blank panel. */}
                  <ItemArt category={item.category} seed={item.id} className={styles.itemArt} />
                  {img && (
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
                  )}
                  <span className={styles.categoryTag}>{item.category || 'Time Banks'}</span>
                  {soldOut && <span className={styles.soldOutTag}>SOLD OUT</span>}
                  {/* Every number a member reads goes through fmt (house rule:
                      .toLocaleString, never a raw interpolation). A shop with
                      12000 units in stock printed "12000 Left". */}
                  {limited && !soldOut && (
                    <span className={styles.stockTag}>{fmt(item.stock)} Left</span>
                  )}
                  {onSale && !soldOut && <span className={styles.saleTag}>SALE</span>}
                  {item.per_user_limit && !blocked ? (
                    <span className={styles.stockTag}>
                      {fmt(Math.max(0, item.per_user_limit - (item.my_purchase_count ?? 0)))} Left
                      For You
                    </span>
                  ) : null}
                </div>
                <div className={styles.itemBody}>
                  <div className={styles.itemName}>{item.name}</div>
                  <div className={styles.itemDesc}>
                    {item.description || 'No Description Available.'}
                  </div>
                  {grantText(item) && <div className={styles.grantBadge}>{grantText(item)}</div>}
                  <div className={styles.itemFooter}>
                    <div>
                      <span className={styles.itemPrice}>
                        {onSale && <span className={styles.strikePrice}>{fmt(item.price)}</span>}
                        {fmt(effectivePrice(item))} Diamonds
                      </span>
                      {(item.purchase_count || 0) > 0 && (
                        <div className={styles.soldCount}>{fmt(item.purchase_count)} Sold</div>
                      )}
                    </div>
                    <button
                      onClick={() => openBuy(item)}
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
