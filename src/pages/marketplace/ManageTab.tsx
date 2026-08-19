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
import { CATEGORIES, type MarketplaceItem } from './marketplaceShared';

interface ManageTabProps {
  clubId: string;
  onShopChanged: () => void;
}

interface EditDraft {
  name: string;
  price: string;
  description: string;
  category: string;
  imageUrl: string;
}

export default function ManageTab({ clubId, onShopChanged }: ManageTabProps) {
  const toast = useToast();
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [desc, setDesc] = useState('');
  const [category, setCategory] = useState('Time Banks');
  const [imageUrl, setImageUrl] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);

  const loadItems = useCallback(async () => {
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
      setLoaded(true);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load shop items');
    }
  }, [clubId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const stats = {
    total: items.length,
    active: items.filter((i) => i.is_active).length,
    totalSold: items.reduce((sum, i) => sum + (i.purchase_count || 0), 0),
    totalRevenue: items.reduce((sum, i) => sum + (i.purchase_count || 0) * i.price, 0),
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
    try {
      await callClubArenaApi('manage-shop', { action: 'toggle', clubId, itemId: item.id });
      toast.success(item.is_active ? 'Item hidden' : 'Item activated');
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Toggle failed');
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
    try {
      await callClubArenaApi('manage-shop', { action: 'delete', clubId, itemId: item.id });
      toast.success('Item deleted');
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
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
            className={styles.formInput}
            maxLength={100}
          />
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Price (chips)"
            min="1"
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
            placeholder="Image URL (optional)"
            className={styles.formInput}
          />
        </div>
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
                  </div>
                </div>
                <div className={styles.adminActions}>
                  <button
                    onClick={() => (editingId === item.id ? setEditingId(null) : startEdit(item))}
                    className={styles.btnEditSmall}
                  >
                    {editingId === item.id ? 'Close' : 'Edit'}
                  </button>
                  <button
                    onClick={() => handleToggle(item)}
                    className={item.is_active ? styles.btnActiveToggle : styles.btnInactiveToggle}
                  >
                    {item.is_active ? 'Active' : 'Hidden'}
                  </button>
                  <button
                    onClick={() => handleDelete(item)}
                    className={styles.btnDeleteSmall}
                    disabled={(item.purchase_count || 0) > 0}
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
