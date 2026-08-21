/**
 * MARKETPLACE — Manage tab (owner/admin only).
 * All CRUD goes through the server route /api/club-arena/manage-shop (the old
 * anon-key supabase writes were silently blocked by the 2026-05-01 RLS lockdown).
 *
 * 2026-08-19 audit pass: added inline editing (the server always supported
 * 'update' but the UI had no editor), and a delete guard — items with sales
 * can only be hidden, because club_shop_purchases.item_id is ON DELETE CASCADE
 * and a hard delete would erase the club's purchase history.
 */

import { useCallback, useEffect, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { fmtChips } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import ShopAnalytics from './ShopAnalytics';
import PurchaseLedger from './PurchaseLedger';
import {
  CATEGORIES,
  describeGrant,
  localInputToIso,
  isoToLocalInput,
  type MarketplaceItem,
  type ShopCategoryInfo,
} from './marketplaceShared';

interface ManageTabProps {
  clubId: string;
  /** category -> grant mapping from /api/club-arena/store-catalog */
  categories: ShopCategoryInfo[];
  /** false when the catalog request failed and we are on bundled defaults */
  catalogFromServer: boolean;
  onShopChanged: () => void;
}

interface EditDraft {
  name: string;
  price: string;
  description: string;
  category: string;
  imageUrl: string;
  grantQty: string;
  grantRef: string;
  /** '' = unlimited */
  stock: string;
  /** '' = no sale */
  salePrice: string;
  /** '' = no cap */
  perUserLimit: string;
  /** '' = always available; local wall-clock, converted on send */
  availableFrom: string;
  availableUntil: string;
  sortOrder: string;
  stackable: boolean;
}

export default function ManageTab({
  clubId,
  categories,
  catalogFromServer,
  onShopChanged,
}: ManageTabProps) {
  const toast = useToast();
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [grantQty, setGrantQty] = useState('1');
  const [grantRef, setGrantRef] = useState('');
  const [stock, setStock] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [perUserLimit, setPerUserLimit] = useState('');
  const [availableUntil, setAvailableUntil] = useState('');
  const [availableFrom, setAvailableFrom] = useState('');
  const [sortOrder, setSortOrder] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [desc, setDesc] = useState('');
  const [category, setCategory] = useState('Time Banks');
  const [imageUrl, setImageUrl] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);

  const loadItems = useCallback(async () => {
    setLoadError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not authenticated');
      const res = await fetch(`/api/club-arena/manage-shop?clubId=${encodeURIComponent(clubId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({ success: false }));
      if (!data.success) throw new Error(data.error || 'Failed to load shop items');
      setItems(data.items || []);
      setTotalRevenue(Number(data.totalRevenue) || 0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load shop items';
      // Keep whatever was already listed: blanking the catalogue on a transient
      // failure is worse than showing slightly stale rows behind a banner.
      setLoadError(msg);
      toast.error(msg);
    } finally {
      // Must be in `finally`: leaving it in the try left the tab stuck on
      // "Loading items..." forever whenever the request failed.
      setLoaded(true);
    }
  }, [clubId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // What the selected category will grant when a member redeems it.
  const grantInfo = categories.find((c) => c.name === category);
  // Table skins and avatars need an id, or every one a club sells collapses to
  // the same theme/avatar (and avatar_unlocks dedupes, granting nothing).
  const secondsPerUse = categories.find((c) => c.grantType === 'time_bank')?.secondsPerUse ?? 20;
  const grantNeedsRef = grantInfo?.grantType === 'table_skin' || grantInfo?.grantType === 'avatar';
  const categoryNames =
    categories.length > 0 ? categories.map((c) => c.name) : CATEGORIES.filter((c) => c !== 'All');

  const stats = {
    total: items.length,
    active: items.filter((i) => i.is_active).length,
    totalSold: items.reduce((sum, i) => sum + (i.purchase_count || 0), 0),
    // Server-computed from price_paid. Multiplying today's price by historical
    // sales let an admin rewrite reported revenue just by editing a price.
    totalRevenue,
  };

  const validate = (n: string, p: string): number | null => {
    const numPrice = Math.floor(Number(p));
    if (!n.trim()) {
      toast.error('Item name required');
      return null;
    }
    if (!numPrice || !Number.isFinite(numPrice) || numPrice <= 0) {
      toast.error('Price must be a positive number');
      return null;
    }
    if (numPrice > 1_000_000_000) {
      toast.error('Price exceeds maximum allowed value');
      return null;
    }
    return numPrice;
  };

  const handleCreate = async () => {
    const numPrice = validate(name, price);
    if (numPrice == null) return;
    setProcessing(true);
    try {
      await callClubArenaApi('manage-shop', {
        action: 'create',
        clubId,
        name: name.trim(),
        price: numPrice,
        description: desc.trim() || null,
        category,
        imageUrl: imageUrl.trim() || null,
        // Only assert a grant type when the catalog is server-truth. On the
        // bundled fallback we omit it so the SERVER derives it from category --
        // sending a fabricated 'none' silently created items that granted
        // nothing while still displaying as Time Banks/Throwables.
        grantType: catalogFromServer ? grantInfo?.grantType : undefined,
        grantQty: grantInfo?.grantUnit ? Math.max(1, Math.floor(Number(grantQty) || 1)) : undefined,
        grantRef: grantNeedsRef ? grantRef.trim() || undefined : undefined,
        stock: stock.trim() === '' ? null : Math.max(0, Math.floor(Number(stock) || 0)),
        salePrice: salePrice.trim() === '' ? null : Math.max(0, Math.floor(Number(salePrice) || 0)),
        perUserLimit:
          perUserLimit.trim() === '' ? null : Math.max(1, Math.floor(Number(perUserLimit) || 1)),
        // datetime-local carries no offset, so it must be converted to a real
        // instant here. Sending it raw made the server (UTC) read the admin's
        // wall clock as UTC — an admin in UTC+10 setting 18:00 got 04:00 next day.
        availableUntil: localInputToIso(availableUntil),
        availableFrom: localInputToIso(availableFrom),
        sortOrder: sortOrder.trim() === '' ? undefined : Math.floor(Number(sortOrder) || 0),
      });
      toast.success('Item created');
      setName('');
      setPrice('');
      setDesc('');
      setImageUrl('');
      setCategory('Time Banks');
      setGrantQty('1');
      setGrantRef('');
      setStock('');
      setSalePrice('');
      setPerUserLimit('');
      setAvailableUntil('');
      setAvailableFrom('');
      setSortOrder('');
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setProcessing(false);
    }
  };

  const startEdit = (item: MarketplaceItem) => {
    setEditingId(item.id);
    setDraft({
      name: item.name,
      price: String(item.price),
      description: item.description || '',
      // Preserve an unrecognised category rather than silently rewriting it to
      // 'Time Banks' and then persisting that rewrite on save.
      category: item.category || 'Time Banks',
      imageUrl: item.image_url || '',
      grantQty: String(item.grant_spec?.qty ?? 1),
      grantRef: item.grant_spec?.avatar_id || item.grant_spec?.theme_id || '',
      stock: item.stock === null || item.stock === undefined ? '' : String(item.stock),
      salePrice:
        item.sale_price === null || item.sale_price === undefined ? '' : String(item.sale_price),
      perUserLimit:
        item.per_user_limit === null || item.per_user_limit === undefined
          ? ''
          : String(item.per_user_limit),
      availableFrom: isoToLocalInput(item.available_from),
      availableUntil: isoToLocalInput(item.available_until),
      sortOrder:
        item.sort_order === null || item.sort_order === undefined ? '' : String(item.sort_order),
      stackable: !!item.stackable,
    });
  };

  const handleSaveEdit = async (item: MarketplaceItem) => {
    if (!draft) return;
    const numPrice = validate(draft.name, draft.price);
    if (numPrice == null) return;
    // club_shop_items_sale_price_valid enforces sale_price <= price. Without
    // this, lowering the price under an active sale surfaced as a bare 500.
    if (draft.salePrice.trim() !== '') {
      const sale = Math.floor(Number(draft.salePrice) || 0);
      if (sale > numPrice) {
        toast.error(
          `Sale price cannot exceed the price (${numPrice}). Lower the sale price first.`
        );
        return;
      }
    }
    setProcessing(true);
    try {
      // The grant MUST travel with the category. Updating category alone left
      // e.g. a time-bank grant on a row now labelled "Avatars", so the card
      // advertised table time and redeeming granted time bank seconds.
      const nextGrant = categories.find((c) => c.name === draft.category);
      await callClubArenaApi('manage-shop', {
        action: 'update',
        clubId,
        itemId: item.id,
        name: draft.name.trim(),
        price: numPrice,
        description: draft.description.trim(),
        category: draft.category,
        imageUrl: draft.imageUrl.trim() || null,
        grantType: nextGrant?.grantType,
        grantQty: nextGrant?.grantUnit
          ? Math.max(1, Math.floor(Number(draft.grantQty) || 1))
          : undefined,
        grantRef: draft.grantRef.trim() || undefined,
        // Restocking was impossible: a limited drop that sold out (or lost a
        // unit to a failed purchase) could never be revived from the UI.
        stock: draft.stock.trim() === '' ? null : Math.max(0, Math.floor(Number(draft.stock) || 0)),
        // Explicit null clears. Omitting these is what made promos write-once:
        // a sale could be started and then never ended except by hiding the item.
        salePrice:
          draft.salePrice.trim() === ''
            ? null
            : Math.max(0, Math.floor(Number(draft.salePrice) || 0)),
        perUserLimit:
          draft.perUserLimit.trim() === ''
            ? null
            : Math.max(1, Math.floor(Number(draft.perUserLimit) || 1)),
        availableFrom: localInputToIso(draft.availableFrom),
        availableUntil: localInputToIso(draft.availableUntil),
        sortOrder: draft.sortOrder.trim() === '' ? 0 : Math.floor(Number(draft.sortOrder) || 0),
        stackable: draft.stackable,
      });
      toast.success('Item updated');
      setEditingId(null);
      setDraft(null);
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setProcessing(false);
    }
  };

  const handleToggle = async (item: MarketplaceItem) => {
    if (processing) return;
    setProcessing(true);
    try {
      await callClubArenaApi('manage-shop', { action: 'toggle', clubId, itemId: item.id });
      toast.success(item.is_active ? 'Item hidden' : 'Item activated');
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      setProcessing(false);
    }
  };

  const handleDelete = async (item: MarketplaceItem) => {
    if (processing) return;
    if ((item.purchase_count || 0) > 0) {
      toast.error(
        'This item has sales. Deleting it would erase its purchase history - hide it instead.'
      );
      return;
    }
    if (
      !(await confirmDialog({
        title: 'Delete item',
        message: `Delete "${item.name}"? This cannot be undone.`,
        confirmText: 'Delete',
        variant: 'danger',
      }))
    )
      return;
    if (processing) return;
    setProcessing(true);
    try {
      await callClubArenaApi('manage-shop', { action: 'delete', clubId, itemId: item.id });
      toast.success('Item deleted');
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <>
      {/* Admin stats */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{stats.total}</span>
          <span className={styles.statLabel}>Total Items</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{stats.active}</span>
          <span className={styles.statLabel}>Active</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{stats.totalSold}</span>
          <span className={styles.statLabel}>Total Sold</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{fmtChips(stats.totalRevenue)}</span>
          <span className={styles.statLabel}>Revenue</span>
        </div>
      </div>

      <ShopAnalytics clubId={clubId} />

      <PurchaseLedger clubId={clubId} />

      {/* Create form */}
      <div className={styles.createForm}>
        <h3 className={styles.createTitle}>Create Shop Item</h3>
        <div className={styles.formRow}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Item name"
            aria-label="Item name"
            className={styles.formInput}
            maxLength={100}
          />
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Price (chips)"
            aria-label="Item price in chips"
            min="1"
            step="1"
            className={styles.formInput}
          />
        </div>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Description (optional)"
          className={styles.formInput}
          maxLength={500}
        />
        <div className={styles.formRow}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={styles.formSelect}
            aria-label="Item category"
          >
            {categoryNames.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="Image URL (https only, optional)"
            aria-label="Item image URL"
            className={styles.formInput}
          />
        </div>
        <div className={styles.formRow}>
          <input
            type="number"
            min="0"
            step="1"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="Stock (blank = unlimited)"
            aria-label="Stock quantity, blank for unlimited"
            className={styles.formInput}
          />
          <input
            type="number"
            min="1"
            step="1"
            value={perUserLimit}
            onChange={(e) => setPerUserLimit(e.target.value)}
            placeholder="Max per member (blank = no cap)"
            aria-label="Maximum purchases per member"
            className={styles.formInput}
          />
        </div>
        <div className={styles.formRow}>
          <input
            type="number"
            min="0"
            step="1"
            value={salePrice}
            onChange={(e) => setSalePrice(e.target.value)}
            placeholder="Sale price (blank = none)"
            aria-label="Discounted sale price"
            className={styles.formInput}
          />
          <input
            type="datetime-local"
            value={availableUntil}
            onChange={(e) => setAvailableUntil(e.target.value)}
            aria-label="Available until"
            className={styles.formInput}
          />
        </div>
        <div className={styles.formRow}>
          <input
            type="datetime-local"
            value={availableFrom}
            onChange={(e) => setAvailableFrom(e.target.value)}
            aria-label="Available from"
            className={styles.formInput}
          />
          <input
            type="number"
            step="1"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            placeholder="Sort order (lower shows first)"
            aria-label="Storefront sort order"
            className={styles.formInput}
          />
        </div>
        <div className={styles.grantHint}>
          Stock Is A Limited Drop; Max-Per-Member Caps Lifetime Purchases; A Sale Price Is What Is
          Actually Charged; &quot;Available Until&quot; Ends The Offer Automatically.
        </div>
        {grantInfo?.grantUnit && (
          <div className={styles.formRow}>
            <input
              type="number"
              min="1"
              step="1"
              value={grantQty}
              onChange={(e) => setGrantQty(e.target.value)}
              placeholder={`How many ${grantInfo.grantUnit}?`}
              aria-label={`Number of ${grantInfo.grantUnit} granted`}
              className={styles.formInput}
            />
            <span className={styles.grantHint}>
              {grantInfo.grantType === 'time_bank'
                ? `= ${(Number(grantQty) || 1) * (grantInfo.secondsPerUse || 20)}s of table time`
                : `${Number(grantQty) || 1} free ${grantInfo.grantUnit}`}
            </span>
          </div>
        )}
        {grantNeedsRef && (
          <div className={styles.formRow}>
            <input
              value={grantRef}
              onChange={(e) => setGrantRef(e.target.value)}
              placeholder={
                grantInfo?.grantType === 'avatar'
                  ? 'Avatar id (e.g. shark)'
                  : 'Theme id (e.g. royal_gold)'
              }
              aria-label={grantInfo?.grantType === 'avatar' ? 'Avatar id' : 'Theme id'}
              className={styles.formInput}
              maxLength={64}
            />
            <span className={styles.grantHint}>
              Unique Per Item - Two Items Sharing An ID Unlock The Same Thing.
            </span>
          </div>
        )}
        {grantInfo && !grantInfo.grantUnit && (
          <div className={styles.grantHint}>
            {grantInfo.grantType === 'none'
              ? 'Exclusive items grant nothing automatically - your club fulfils them.'
              : 'Redeeming unlocks this permanently for the member.'}
          </div>
        )}
        <button
          className={styles.btnPrimary}
          disabled={processing || !name.trim() || !price}
          onClick={handleCreate}
        >
          {processing ? 'Creating...' : 'Create Item'}
        </button>
      </div>

      {/* Item list */}
      {!loaded ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Loading Items...</span>
        </div>
      ) : loadError ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Could Not Load Shop Items.</span>
          <span className={styles.emptySubText}>{loadError}</span>
          <button className={styles.emptyButton} onClick={loadItems}>
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>No Shop Items. Create One Above.</span>
        </div>
      ) : (
        <div className={styles.adminList}>
          {items.map((item) => (
            <div key={item.id} className={styles.adminRowWrap}>
              <div className={styles.adminRow}>
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
                    {fmtChips(item.price)} Chips {' - '}
                    <span className={styles.categorySmall}>{item.category || 'Time Banks'}</span>
                    {' - '}
                    {item.purchase_count || 0} Sold
                    {item.revenue ? ` - ${fmtChips(item.revenue)} earned` : ''}
                    {item.stock !== null && item.stock !== undefined ? ` - ${item.stock} left` : ''}
                    {item.sale_price !== null && item.sale_price !== undefined
                      ? ` - on sale at ${fmtChips(item.sale_price)}`
                      : ''}
                    {item.per_user_limit ? ` - max ${item.per_user_limit}/member` : ''}
                    {item.stackable ? ' - stackable' : ''}
                    {item.available_until
                      ? ` - ends ${new Date(item.available_until).toLocaleDateString()}`
                      : ''}
                  </div>
                  {describeGrant(item.grant_spec, secondsPerUse) && (
                    <div className={styles.grantHint}>
                      Grants: {describeGrant(item.grant_spec, secondsPerUse)}
                    </div>
                  )}
                </div>
                <div className={styles.adminActions}>
                  <button
                    onClick={() => {
                      if (editingId === item.id) {
                        setEditingId(null);
                        setDraft(null);
                      } else {
                        startEdit(item);
                      }
                    }}
                    disabled={processing}
                    className={styles.btnEditSmall}
                  >
                    {editingId === item.id ? 'Close' : 'Edit'}
                  </button>
                  <button
                    onClick={() => handleToggle(item)}
                    disabled={processing}
                    className={item.is_active ? styles.btnActiveToggle : styles.btnInactiveToggle}
                  >
                    {item.is_active ? 'Active' : 'Hidden'}
                  </button>
                  <button
                    onClick={() => handleDelete(item)}
                    className={styles.btnDeleteSmall}
                    disabled={processing || (item.purchase_count || 0) > 0}
                    title={
                      (item.purchase_count || 0) > 0
                        ? 'Items with sales cannot be deleted - hide them instead'
                        : 'Delete this item'
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Inline editor */}
              {editingId === item.id && draft && (
                <div className={styles.editForm}>
                  <div className={styles.formRow}>
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="Item name"
                      className={styles.formInput}
                      maxLength={100}
                    />
                    <input
                      type="number"
                      value={draft.price}
                      onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                      placeholder="Price (chips)"
                      min="1"
                      className={styles.formInput}
                    />
                  </div>
                  <input
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="Description"
                    className={styles.formInput}
                    maxLength={500}
                  />
                  <div className={styles.formRow}>
                    <select
                      value={draft.category}
                      onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                      className={styles.formSelect}
                      aria-label="Item category"
                    >
                      {(categoryNames.includes(draft.category)
                        ? categoryNames
                        : [draft.category, ...categoryNames]
                      ).map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                    <input
                      value={draft.imageUrl}
                      onChange={(e) => setDraft({ ...draft, imageUrl: e.target.value })}
                      placeholder="Image URL (optional)"
                      className={styles.formInput}
                    />
                  </div>
                  <div className={styles.formRow}>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.stock}
                      onChange={(e) => setDraft({ ...draft, stock: e.target.value })}
                      placeholder="Stock (blank = unlimited)"
                      aria-label="Stock quantity, blank for unlimited"
                      className={styles.formInput}
                    />
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.salePrice}
                      onChange={(e) => setDraft({ ...draft, salePrice: e.target.value })}
                      placeholder="Sale price (blank ends the sale)"
                      aria-label="Sale price, blank to end the sale"
                      className={styles.formInput}
                    />
                    <span className={styles.grantHint}>
                      {draft.stock.trim() === '' ? 'Unlimited' : `${draft.stock} available`}
                    </span>
                  </div>
                  <div className={styles.formRow}>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={draft.perUserLimit}
                      onChange={(e) => setDraft({ ...draft, perUserLimit: e.target.value })}
                      placeholder="Max per member (blank = no cap)"
                      aria-label="Maximum purchases per member"
                      className={styles.formInput}
                    />
                    <input
                      type="number"
                      step="1"
                      value={draft.sortOrder}
                      onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })}
                      placeholder="Sort order"
                      aria-label="Storefront sort order"
                      className={styles.formInput}
                    />
                  </div>
                  <div className={styles.formRow}>
                    <input
                      type="datetime-local"
                      value={draft.availableFrom}
                      onChange={(e) => setDraft({ ...draft, availableFrom: e.target.value })}
                      aria-label="Available from"
                      className={styles.formInput}
                    />
                    <input
                      type="datetime-local"
                      value={draft.availableUntil}
                      onChange={(e) => setDraft({ ...draft, availableUntil: e.target.value })}
                      aria-label="Available until"
                      className={styles.formInput}
                    />
                  </div>
                  <div className={styles.formRow}>
                    <label className={styles.grantHint}>
                      <input
                        type="checkbox"
                        checked={draft.stackable}
                        onChange={(e) => setDraft({ ...draft, stackable: e.target.checked })}
                        style={{ marginRight: 8 }}
                      />
                      Stackable - Members May Hold Several Unredeemed Copies
                    </label>
                  </div>
                  {(() => {
                    const g = categories.find((c) => c.name === draft.category);
                    if (!g) return null;
                    return (
                      <div className={styles.formRow}>
                        {g.grantUnit && (
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={draft.grantQty}
                            onChange={(e) => setDraft({ ...draft, grantQty: e.target.value })}
                            placeholder={`How many ${g.grantUnit}?`}
                            aria-label={`Number of ${g.grantUnit} granted`}
                            className={styles.formInput}
                          />
                        )}
                        {(g.grantType === 'avatar' || g.grantType === 'table_skin') && (
                          <input
                            value={draft.grantRef}
                            onChange={(e) => setDraft({ ...draft, grantRef: e.target.value })}
                            placeholder={g.grantType === 'avatar' ? 'Avatar id' : 'Theme id'}
                            aria-label={g.grantType === 'avatar' ? 'Avatar id' : 'Theme id'}
                            className={styles.formInput}
                            maxLength={64}
                          />
                        )}
                      </div>
                    );
                  })()}
                  <div className={styles.formRow}>
                    <button
                      className={styles.btnPrimary}
                      disabled={processing}
                      onClick={() => handleSaveEdit(item)}
                    >
                      {processing ? 'Saving...' : 'Save Changes'}
                    </button>
                    <button
                      className={styles.btnGhost}
                      disabled={processing}
                      onClick={() => {
                        setEditingId(null);
                        setDraft(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
