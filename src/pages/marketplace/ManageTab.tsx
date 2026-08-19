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
import {
  CATEGORIES,
  describeGrant,
  type MarketplaceItem,
  type ShopCategoryInfo,
} from './marketplaceShared';

interface ManageTabProps {
  clubId: string;
  /** category -> grant mapping from /api/club-arena/store-catalog */
  categories?: ShopCategoryInfo[];
  onShopChanged: () => void;
}

interface EditDraft {
  name: string;
  price: string;
  description: string;
  category: string;
  imageUrl: string;
}

export default function ManageTab({ clubId, categories, onShopChanged }: ManageTabProps) {
  const toast = useToast();
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [grantQty, setGrantQty] = useState('1');
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
      setItems([]);
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
  const grantInfo = (categories || []).find((c) => c.name === category);

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
        grantType: grantInfo?.grantType,
        grantQty: grantInfo?.grantUnit ? Math.max(1, Number(grantQty) || 1) : undefined,
      });
      toast.success('Item created');
      setName('');
      setPrice('');
      setDesc('');
      setImageUrl('');
      setCategory('Time Banks');
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
      category: item.category && CATEGORIES.includes(item.category) ? item.category : 'Time Banks',
      imageUrl: item.image_url || '',
    });
  };

  const handleSaveEdit = async (item: MarketplaceItem) => {
    if (!draft) return;
    const numPrice = validate(draft.name, draft.price);
    if (numPrice == null) return;
    setProcessing(true);
    try {
      await callClubArenaApi('manage-shop', {
        action: 'update',
        clubId,
        itemId: item.id,
        name: draft.name.trim(),
        price: numPrice,
        description: draft.description.trim(),
        category: draft.category,
        imageUrl: draft.imageUrl.trim() || null,
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
    if ((item.purchase_count || 0) > 0) {
      toast.error(
        'This item has sales. Deleting it would erase its purchase history — hide it instead.'
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
          >
            {CATEGORIES.filter((c) => c !== 'All').map((cat) => (
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
        {grantInfo && !grantInfo.grantUnit && (
          <div className={styles.grantHint}>
            {grantInfo.grantType === 'none'
              ? 'Exclusive items grant nothing automatically — your club fulfils them.'
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
          <span className={styles.emptyText}>Loading items...</span>
        </div>
      ) : loadError ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Could not load shop items.</span>
          <span className={styles.emptySubText}>{loadError}</span>
          <button className={styles.emptyButton} onClick={loadItems}>
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>No shop items. Create one above.</span>
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
                    {fmtChips(item.price)} chips {' - '}
                    <span className={styles.categorySmall}>{item.category || 'Time Banks'}</span>
                    {' - '}
                    {item.purchase_count || 0} sold
                    {item.revenue ? ` - ${fmtChips(item.revenue)} earned` : ''}
                  </div>
                  {describeGrant(item.grant_spec) && (
                    <div className={styles.grantHint}>Grants: {describeGrant(item.grant_spec)}</div>
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
                    >
                      {CATEGORIES.filter((c) => c !== 'All').map((cat) => (
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
