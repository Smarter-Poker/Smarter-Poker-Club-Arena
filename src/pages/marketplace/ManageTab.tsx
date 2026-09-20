/**
 * MARKETPLACE : Manage tab (owner/admin only).
 * All CRUD goes through the server route /api/club-arena/manage-shop (the old
 * anon-key supabase writes were silently blocked by the 2026-05-01 RLS lockdown).
 *
 * 2026-08-19 audit pass: added inline editing (the server always supported
 * 'update' but the UI had no editor), and a delete guard : items with sales
 * can only be hidden, because club_shop_purchases.item_id is ON DELETE CASCADE
 * and a hard delete would erase the club's purchase history.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { fmt } from '../../utils/format';
import { formatPopupText } from '../../utils/popupStyle';
import styles from '../MarketplacePage.module.css';
import ShopAnalytics from './ShopAnalytics';
import PurchaseLedger from './PurchaseLedger';
import { THEME_PRESET_CATALOG } from '../../lib/tableTheme';
import { avatarService, type Avatar } from '../../services/AvatarService';
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
  userId: string;
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

const MARKETPLACE_THEME_PRESETS = THEME_PRESET_CATALOG.filter((preset) => preset.tier === 'vip');
const MARKETPLACE_THEME_IDS = new Set(MARKETPLACE_THEME_PRESETS.map((preset) => preset.id));

// The single all-access throwables offer is a platform contract. Club admins
// may tune its commercial fields, but may not split it into tomato/egg/etc.
// packs, replace its clean composite, hide it, or delete its receipt anchor.
const ALL_THROWABLES_NAME = 'All Throwables Pack (10)';
const ALL_THROWABLES_DESCRIPTION =
  'Ten Uses Across All 49 Table Throwables, Including Boxing Gloves, Water Guns, Eggs, Tomatoes, Snowballs, And More.';
const ALL_THROWABLES_IMAGE_URL =
  '/hub/club-arena/images/marketplace/throwables/all-throwables-access-v1.png';

const isThrowableItem = (item: MarketplaceItem) =>
  String(item.category || '').toLowerCase() === 'throwables' ||
  String(item.item_type || '').toLowerCase() === 'throwable' ||
  item.grant_spec?.type === 'throwable';

const isAllThrowablesOffer = (item: MarketplaceItem) =>
  isThrowableItem(item) && item.name.trim().toLowerCase() === ALL_THROWABLES_NAME.toLowerCase();

export default function ManageTab({
  clubId,
  userId,
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
  const [avatarOptions, setAvatarOptions] = useState<Avatar[]>([]);
  const [avatarCatalogState, setAvatarCatalogState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const mountedRef = useRef(true);
  const activeOwnerRef = useRef({ userId, clubId });
  const mutationAttemptRef = useRef(0);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const processingRef = useRef(false);
  const loadAttemptRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    activeOwnerRef.current = { userId, clubId };
    mutationAttemptRef.current += 1;
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = null;
    loadAttemptRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    processingRef.current = false;
    setProcessing(false);
    return () => {
      mountedRef.current = false;
      mutationAttemptRef.current += 1;
      mutationAbortRef.current?.abort();
      mutationAbortRef.current = null;
      loadAttemptRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      processingRef.current = false;
    };
  }, [clubId, userId]);

  const beginMutation = () => {
    if (processingRef.current || !userId || !clubId) return null;
    const expectedUserId = userId;
    const expectedClubId = clubId;
    const attemptId = ++mutationAttemptRef.current;
    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    processingRef.current = true;
    setProcessing(true);
    const isCurrent = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      mutationAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === expectedUserId &&
      activeOwnerRef.current.clubId === expectedClubId;
    return { attemptId, controller, expectedUserId, expectedClubId, isCurrent };
  };

  const finishMutation = (operation: NonNullable<ReturnType<typeof beginMutation>>) => {
    if (
      mutationAbortRef.current === operation.controller &&
      mutationAttemptRef.current === operation.attemptId
    ) {
      mutationAbortRef.current = null;
      processingRef.current = false;
      setProcessing(false);
    }
  };

  const loadItems = useCallback(async () => {
    if (!userId || !clubId) return;
    const expectedUserId = userId;
    const expectedClubId = clubId;
    const attemptId = ++loadAttemptRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const isCurrent = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      loadAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === expectedUserId &&
      activeOwnerRef.current.clubId === expectedClubId;
    setLoadError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || session?.user?.id !== expectedUserId) {
        throw new Error('The Signed-In Player Changed Before This Request Started.');
      }
      const res = await fetch(
        `/api/club-arena/manage-shop?clubId=${encodeURIComponent(expectedClubId)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
      );
      const data = await res.json().catch(() => ({ success: false }));
      if (!data.success) throw new Error(data.error || 'Failed to load shop items');
      if (!isCurrent()) return;
      setItems(data.items || []);
      setTotalRevenue(Number(data.totalRevenue) || 0);
    } catch (err: unknown) {
      if (!isCurrent() || (err instanceof Error && err.name === 'AbortError')) return;
      const msg = err instanceof Error ? err.message : 'Failed to load shop items';
      // Keep whatever was already listed: blanking the catalogue on a transient
      // failure is worse than showing slightly stale rows behind a banner.
      setLoadError(msg);
      toast.error(msg);
    } finally {
      // Must be in `finally`: leaving it in the try left the tab stuck on
      // "Loading items..." forever whenever the request failed.
      if (loadAbortRef.current === controller && loadAttemptRef.current === attemptId) {
        loadAbortRef.current = null;
        setLoaded(true);
      }
    }
  }, [clubId, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // What the selected category will grant when a member redeems it.
  const grantInfo = categories.find((c) => c.name === category);
  const editGrantInfo = draft ? categories.find((c) => c.name === draft.category) : undefined;
  const needsAvatarCatalog =
    grantInfo?.grantType === 'avatar' || editGrantInfo?.grantType === 'avatar';

  useEffect(() => {
    if (!needsAvatarCatalog || avatarCatalogState !== 'idle') return undefined;
    setAvatarCatalogState('loading');
    avatarService
      .getAvatarLibraryResult()
      .then((result) => {
        const presets = result.avatars.filter((avatar) => avatar.category !== 'custom');
        if (result.presetsFailed || presets.length === 0) {
          setAvatarCatalogState('error');
          return;
        }
        setAvatarOptions(presets);
        setAvatarCatalogState('ready');
      })
      .catch(() => {
        setAvatarCatalogState('error');
      });
    return undefined;
  }, [avatarCatalogState, needsAvatarCatalog]);

  const isRealAvatarId = (avatarId: string) =>
    avatarOptions.some((avatar) => avatar.id === avatarId);
  // Table skins and avatars need an id, or every one a club sells collapses to
  // the same theme/avatar (and avatar_unlocks dedupes, granting nothing).
  const secondsPerUse = categories.find((c) => c.grantType === 'time_bank')?.secondsPerUse ?? 20;
  const grantNeedsRef = grantInfo?.grantType === 'table_skin' || grantInfo?.grantType === 'avatar';
  const categoryNames =
    categories.length > 0 ? categories.map((c) => c.name) : CATEGORIES.filter((c) => c !== 'All');
  const creatableCategoryNames = categoryNames.filter(
    (categoryName) =>
      categoryName !== 'Throwables' &&
      categories.find((candidate) => candidate.name === categoryName)?.grantType !== 'throwable'
  );

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
      toast.error('Item Name Required');
      return null;
    }
    if (!numPrice || !Number.isFinite(numPrice) || numPrice <= 0) {
      toast.error('Price Must Be A Positive Number');
      return null;
    }
    if (numPrice > 1_000_000_000) {
      toast.error('Price Exceeds Maximum Allowed Value');
      return null;
    }
    return numPrice;
  };

  const handleCreate = async () => {
    if (!catalogFromServer) {
      toast.error('Live Catalog Verification Is Temporarily Unavailable');
      return;
    }
    if (category === 'Throwables' || grantInfo?.grantType === 'throwable') {
      toast.error('The All Throwables Pack Is Platform Managed And Cannot Be Split');
      return;
    }
    const numPrice = validate(name, price);
    if (numPrice == null) return;
    if (grantInfo?.grantType === 'table_skin' && !MARKETPLACE_THEME_IDS.has(grantRef)) {
      toast.error('Choose A Real Table Studio Theme For This Item');
      return;
    }
    if (grantInfo?.grantType === 'avatar' && !isRealAvatarId(grantRef)) {
      toast.error('Choose A Real Avatar From The 97-Avatar Library For This Item');
      return;
    }
    const operation = beginMutation();
    if (!operation) return;
    try {
      await callClubArenaApi(
        'manage-shop',
        {
          action: 'create',
          clubId: operation.expectedClubId,
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
          grantQty: grantInfo?.grantUnit
            ? Math.max(1, Math.floor(Number(grantQty) || 1))
            : undefined,
          grantRef: grantNeedsRef ? grantRef.trim() || undefined : undefined,
          stock: stock.trim() === '' ? null : Math.max(0, Math.floor(Number(stock) || 0)),
          salePrice:
            salePrice.trim() === '' ? null : Math.max(0, Math.floor(Number(salePrice) || 0)),
          perUserLimit:
            perUserLimit.trim() === '' ? null : Math.max(1, Math.floor(Number(perUserLimit) || 1)),
          // datetime-local carries no offset, so it must be converted to a real
          // instant here. Sending it raw made the server (UTC) read the admin's
          // wall clock as UTC : an admin in UTC+10 setting 18:00 got 04:00 next day.
          availableUntil: localInputToIso(availableUntil),
          availableFrom: localInputToIso(availableFrom),
          sortOrder: sortOrder.trim() === '' ? undefined : Math.floor(Number(sortOrder) || 0),
        },
        { expectedUserId: operation.expectedUserId, signal: operation.controller.signal }
      );
      if (!operation.isCurrent()) return;
      toast.success('Item Created');
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
      if (!operation.isCurrent() || (err instanceof Error && err.name === 'AbortError')) return;
      toast.error(err instanceof Error ? err.message : 'Create failed');
    } finally {
      finishMutation(operation);
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
    if (!catalogFromServer) {
      toast.error('Live Catalog Verification Is Temporarily Unavailable');
      return;
    }
    const platformThrowables = isAllThrowablesOffer(item);
    if (isThrowableItem(item) && !platformThrowables) {
      toast.error('Historical Throwable Rows Are Preserved For Receipts And Cannot Be Edited');
      return;
    }
    const nextName = platformThrowables ? ALL_THROWABLES_NAME : draft.name.trim();
    const nextDescription = platformThrowables
      ? ALL_THROWABLES_DESCRIPTION
      : draft.description.trim();
    const nextCategory = platformThrowables ? 'Throwables' : draft.category;
    const numPrice = validate(nextName, draft.price);
    if (numPrice == null) return;
    const nextGrant = categories.find((c) => c.name === nextCategory);
    if (nextGrant?.grantType === 'table_skin' && !MARKETPLACE_THEME_IDS.has(draft.grantRef)) {
      toast.error('Choose A Real Table Studio Theme For This Item');
      return;
    }
    if (nextGrant?.grantType === 'avatar' && !isRealAvatarId(draft.grantRef)) {
      toast.error('Choose A Real Avatar From The 97-Avatar Library For This Item');
      return;
    }
    // club_shop_items_sale_price_valid enforces sale_price <= price. Without
    // this, lowering the price under an active sale surfaced as a bare 500.
    if (draft.salePrice.trim() !== '') {
      const sale = Math.floor(Number(draft.salePrice) || 0);
      if (sale > numPrice) {
        toast.error(
          `Sale Price Cannot Exceed The Price (${numPrice}). Lower The Sale Price First.`
        );
        return;
      }
    }
    const operation = beginMutation();
    if (!operation) return;
    try {
      // The grant MUST travel with the category. Updating category alone left
      // e.g. a time-bank grant on a row now labelled "Avatars", so the card
      // advertised table time and redeeming granted time bank seconds.
      await callClubArenaApi(
        'manage-shop',
        {
          action: 'update',
          clubId: operation.expectedClubId,
          itemId: item.id,
          name: nextName,
          price: numPrice,
          description: nextDescription,
          category: nextCategory,
          imageUrl: platformThrowables ? ALL_THROWABLES_IMAGE_URL : draft.imageUrl.trim() || null,
          grantType: platformThrowables ? 'throwable' : nextGrant?.grantType,
          grantQty: platformThrowables
            ? 10
            : nextGrant?.grantUnit
              ? Math.max(1, Math.floor(Number(draft.grantQty) || 1))
              : undefined,
          grantRef: platformThrowables ? '' : draft.grantRef.trim() || undefined,
          // Restocking was impossible: a limited drop that sold out (or lost a
          // unit to a failed purchase) could never be revived from the UI.
          stock:
            draft.stock.trim() === '' ? null : Math.max(0, Math.floor(Number(draft.stock) || 0)),
          // Explicit null clears. Omitting these is what made promos write-once:
          // a sale could be started and then never ended except by hiding the item.
          salePrice:
            draft.salePrice.trim() === ''
              ? null
              : Math.max(0, Math.floor(Number(draft.salePrice) || 0)),
          perUserLimit: platformThrowables
            ? null
            : draft.perUserLimit.trim() === ''
              ? null
              : Math.max(1, Math.floor(Number(draft.perUserLimit) || 1)),
          availableFrom: localInputToIso(draft.availableFrom),
          availableUntil: localInputToIso(draft.availableUntil),
          sortOrder: draft.sortOrder.trim() === '' ? 0 : Math.floor(Number(draft.sortOrder) || 0),
          stackable: platformThrowables ? true : draft.stackable,
        },
        {
          expectedUserId: operation.expectedUserId,
          signal: operation.controller.signal,
        }
      );
      if (!operation.isCurrent()) return;
      toast.success('Item Updated');
      setEditingId(null);
      setDraft(null);
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      if (!operation.isCurrent() || (err instanceof Error && err.name === 'AbortError')) return;
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      finishMutation(operation);
    }
  };

  const handleToggle = async (item: MarketplaceItem) => {
    if (processingRef.current) return;
    if (isThrowableItem(item)) {
      toast.error('Throwable Offers Are Platform Managed And Cannot Be Hidden');
      return;
    }
    const operation = beginMutation();
    if (!operation) return;
    try {
      await callClubArenaApi(
        'manage-shop',
        { action: 'toggle', clubId: operation.expectedClubId, itemId: item.id },
        { expectedUserId: operation.expectedUserId, signal: operation.controller.signal }
      );
      if (!operation.isCurrent()) return;
      toast.success(item.is_active ? 'Item Hidden' : 'Item Activated');
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      if (!operation.isCurrent() || (err instanceof Error && err.name === 'AbortError')) return;
      toast.error(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      finishMutation(operation);
    }
  };

  const handleDelete = async (item: MarketplaceItem) => {
    if (processingRef.current) return;
    if (isThrowableItem(item)) {
      toast.error('Throwable Offers Are Platform Managed And Cannot Be Deleted');
      return;
    }
    if ((item.purchase_count || 0) > 0) {
      toast.error(
        'This Item Has Sales. Deleting It Would Erase Its Purchase History - Hide It Instead.'
      );
      return;
    }
    const operation = beginMutation();
    if (!operation) return;
    if (
      !(await confirmDialog({
        title: 'Delete Item',
        message: `Delete "${item.name}"? This Cannot Be Undone.`,
        confirmText: 'Delete',
        variant: 'danger',
      }))
    ) {
      finishMutation(operation);
      return;
    }
    if (!operation.isCurrent()) return;
    try {
      await callClubArenaApi(
        'manage-shop',
        { action: 'delete', clubId: operation.expectedClubId, itemId: item.id },
        { expectedUserId: operation.expectedUserId, signal: operation.controller.signal }
      );
      if (!operation.isCurrent()) return;
      toast.success('Item Deleted');
      loadItems();
      onShopChanged();
    } catch (err: unknown) {
      if (!operation.isCurrent() || (err instanceof Error && err.name === 'AbortError')) return;
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      finishMutation(operation);
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
          <span className={styles.statValue}>{fmt(stats.totalRevenue)}</span>
          <span className={styles.statLabel}>Diamonds Burned</span>
        </div>
      </div>

      <div className={styles.grantHint}>
        Club Shop Sales Are 100% Platform-Owned Diamond Burns. No Club, Owner, Agent, Affiliate, Or
        Commission Ledger Is Credited.
      </div>

      {!catalogFromServer && (
        <div className={styles.grantHint} role="alert">
          Live Catalog Verification Is Temporarily Unavailable. Item Creation And Editing Are
          Disabled Until It Returns.
        </div>
      )}

      <ShopAnalytics clubId={clubId} />

      <PurchaseLedger clubId={clubId} userId={userId} />

      {/* Create form */}
      <div className={styles.createForm}>
        <h3 className={styles.createTitle}>Create Shop Item</h3>
        <div className={styles.formRow}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Item Name"
            aria-label="Item Name"
            className={styles.formInput}
            maxLength={100}
          />
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Price (Diamonds)"
            aria-label="Item Price In Diamonds"
            min="1"
            step="1"
            className={styles.formInput}
          />
        </div>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Description (Optional)"
          className={styles.formInput}
          maxLength={500}
        />
        <div className={styles.formRow}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={styles.formSelect}
            aria-label="Item Category"
          >
            {creatableCategoryNames.map((cat) => (
              <option key={cat} value={cat}>
                {formatPopupText(cat)}
              </option>
            ))}
          </select>
          <input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="Image URL (Https Only, Optional)"
            aria-label="Item Image URL"
            className={`${styles.formInput} ${styles.identifierInput}`}
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <div className={styles.formRow}>
          <input
            type="number"
            min="0"
            step="1"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="Stock (Blank = Unlimited)"
            aria-label="Stock Quantity, Blank For Unlimited"
            className={styles.formInput}
          />
          <input
            type="number"
            min="1"
            step="1"
            value={perUserLimit}
            onChange={(e) => setPerUserLimit(e.target.value)}
            placeholder="Max Per Member (Blank = No Cap)"
            aria-label="Maximum Purchases Per Member"
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
            placeholder="Sale Price (Blank = None)"
            aria-label="Discounted Sale Price"
            className={styles.formInput}
          />
          <input
            type="datetime-local"
            value={availableUntil}
            onChange={(e) => setAvailableUntil(e.target.value)}
            aria-label="Available Until"
            className={styles.formInput}
          />
        </div>
        <div className={styles.formRow}>
          <input
            type="datetime-local"
            value={availableFrom}
            onChange={(e) => setAvailableFrom(e.target.value)}
            aria-label="Available From"
            className={styles.formInput}
          />
          <input
            type="number"
            step="1"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            placeholder="Sort Order (Lower Shows First)"
            aria-label="Storefront Sort Order"
            className={styles.formInput}
          />
        </div>
        <div className={styles.grantHint}>
          Stock Is A Limited Drop; Max-Per-Member Caps Lifetime Purchases; A Sale Price Is What Is
          Actually Charged; &quot;Available Until&quot; Ends The Offer Automatically.
        </div>
        <div className={styles.grantHint}>
          The All Throwables Pack Is Added Automatically And Includes Every Table Throwable. Edit
          Its Commercial Terms Below; Individual Throwable Packs Cannot Be Created.
        </div>
        {grantInfo?.grantUnit && (
          <div className={styles.formRow}>
            <input
              type="number"
              min="1"
              step="1"
              value={grantQty}
              onChange={(e) => setGrantQty(e.target.value)}
              placeholder={`How Many ${grantInfo.grantUnit}?`}
              aria-label={`Number Of ${grantInfo.grantUnit} Granted`}
              className={styles.formInput}
            />
            <span className={styles.grantHint}>
              {grantInfo.grantType === 'time_bank'
                ? `= ${(Number(grantQty) || 1) * (grantInfo.secondsPerUse || 20)}s Of Table Time`
                : `${Number(grantQty) || 1} Free ${grantInfo.grantUnit === 'throws' ? 'Throws' : 'Uses'}`}
            </span>
          </div>
        )}
        {grantNeedsRef && (
          <div className={styles.formRow}>
            {grantInfo?.grantType === 'table_skin' ? (
              <select
                value={grantRef}
                onChange={(event) => setGrantRef(event.target.value)}
                aria-label="Table Studio Theme"
                className={`${styles.formInput} ${styles.identifierInput}`}
              >
                <option value="">Choose A Table Studio Theme</option>
                {MARKETPLACE_THEME_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {formatPopupText(preset.name)}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={grantRef}
                onChange={(event) => setGrantRef(event.target.value)}
                aria-label="Avatar Library Selection"
                className={`${styles.formInput} ${styles.identifierInput}`}
                disabled={avatarCatalogState === 'loading' || avatarCatalogState === 'error'}
              >
                <option value="">
                  {avatarCatalogState === 'loading'
                    ? 'Loading The 97-Avatar Library'
                    : avatarCatalogState === 'error'
                      ? 'Avatar Library Unavailable - Try Again'
                      : 'Choose An Avatar'}
                </option>
                {avatarOptions.map((avatar) => (
                  <option key={avatar.id} value={avatar.id}>
                    {formatPopupText(avatar.name)} ({avatar.category === 'vip' ? 'VIP' : 'Free'})
                  </option>
                ))}
              </select>
            )}
            <span className={styles.grantHint}>
              Unique Per Item - Two Items Sharing An ID Unlock The Same Thing.
            </span>
            {grantInfo?.grantType === 'avatar' && avatarCatalogState === 'error' && (
              <button
                type="button"
                className={styles.btnGhost}
                onClick={() => setAvatarCatalogState('idle')}
              >
                Retry Avatar Library
              </button>
            )}
          </div>
        )}
        {grantInfo && !grantInfo.grantUnit && (
          <div className={styles.grantHint}>
            {grantInfo.grantType === 'none'
              ? 'This Historical Item Has No Verified Digital Delivery And Cannot Be Sold.'
              : 'Redeeming Unlocks This Permanently For The Member.'}
          </div>
        )}
        <button
          className={styles.btnPrimary}
          disabled={processing || !catalogFromServer || !name.trim() || !price}
          onClick={handleCreate}
        >
          {processing ? 'Creating' : 'Create Item'}
        </button>
      </div>

      {/* Item list */}
      {!loaded ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Loading Items</span>
        </div>
      ) : loadError ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Could Not Load Shop Items.</span>
          <span className={styles.emptySubText}>{formatPopupText(loadError)}</span>
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
                    className={item.is_active ? styles.adminItemName : styles.adminItemNameMuted}
                  >
                    {formatPopupText(item.name)}
                  </div>
                  <div className={styles.adminItemMeta}>
                    {fmt(item.price)} Diamonds {' - '}
                    <span className={styles.categorySmall}>
                      {formatPopupText(item.category || 'Time Banks')}
                    </span>
                    {' - '}
                    {item.purchase_count || 0} Sold
                    {item.revenue ? ` - ${fmt(item.revenue)} Burned` : ''}
                    {item.stock !== null && item.stock !== undefined ? ` - ${item.stock} Left` : ''}
                    {item.sale_price !== null && item.sale_price !== undefined
                      ? ` - On Sale At ${fmt(item.sale_price)}`
                      : ''}
                    {item.per_user_limit ? ` - Max ${item.per_user_limit}/Member` : ''}
                    {item.stackable ? ' - Stackable' : ''}
                    {item.available_until
                      ? ` - Ends ${new Date(item.available_until).toLocaleDateString()}`
                      : ''}
                  </div>
                  {describeGrant(item.grant_spec, secondsPerUse) && (
                    <div className={styles.grantHint}>
                      Grants: {describeGrant(item.grant_spec, secondsPerUse)}
                    </div>
                  )}
                </div>
                <div className={styles.adminActions}>
                  {isThrowableItem(item) && !isAllThrowablesOffer(item) ? (
                    <span className={styles.categorySmall}>Historical Receipt Row</span>
                  ) : (
                    <>
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
                        aria-label={`${editingId === item.id ? 'Close' : 'Edit'} ${formatPopupText(item.name)}`}
                      >
                        {editingId === item.id ? 'Close' : 'Edit'}
                      </button>
                      {isAllThrowablesOffer(item) ? (
                        <span className={styles.categorySmall}>Platform Managed</span>
                      ) : (
                        <>
                          <button
                            onClick={() => handleToggle(item)}
                            disabled={processing}
                            className={
                              item.is_active ? styles.btnActiveToggle : styles.btnInactiveToggle
                            }
                            aria-label={`${item.is_active ? 'Hide' : 'Activate'} ${formatPopupText(item.name)}`}
                          >
                            {item.is_active ? 'Active' : 'Hidden'}
                          </button>
                          <button
                            onClick={() => handleDelete(item)}
                            className={styles.btnDeleteSmall}
                            disabled={processing || (item.purchase_count || 0) > 0}
                            title={
                              (item.purchase_count || 0) > 0
                                ? 'Items With Sales Cannot Be Deleted - Hide Them Instead'
                                : 'Delete This Item'
                            }
                            aria-label={`Delete ${formatPopupText(item.name)}`}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Inline editor */}
              {editingId === item.id && draft && (
                <div className={styles.editForm}>
                  <div className={styles.formRow}>
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="Item Name"
                      className={styles.formInput}
                      maxLength={100}
                      readOnly={isAllThrowablesOffer(item)}
                      aria-readonly={isAllThrowablesOffer(item)}
                    />
                    <input
                      type="number"
                      value={draft.price}
                      onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                      placeholder="Price (Diamonds)"
                      min="1"
                      className={styles.formInput}
                    />
                  </div>
                  <input
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="Description"
                    aria-label="Item Description"
                    className={styles.formInput}
                    maxLength={500}
                    readOnly={isAllThrowablesOffer(item)}
                    aria-readonly={isAllThrowablesOffer(item)}
                  />
                  <div className={styles.formRow}>
                    <select
                      value={draft.category}
                      onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                      className={styles.formSelect}
                      aria-label="Item Category"
                      disabled={isAllThrowablesOffer(item)}
                    >
                      {(isAllThrowablesOffer(item)
                        ? ['Throwables']
                        : creatableCategoryNames.includes(draft.category)
                          ? creatableCategoryNames
                          : [draft.category, ...creatableCategoryNames]
                      ).map((cat) => (
                        <option key={cat} value={cat}>
                          {formatPopupText(cat)}
                        </option>
                      ))}
                    </select>
                    <input
                      value={draft.imageUrl}
                      onChange={(e) => setDraft({ ...draft, imageUrl: e.target.value })}
                      placeholder="Image URL (Optional)"
                      className={`${styles.formInput} ${styles.identifierInput}`}
                      inputMode="url"
                      autoCapitalize="none"
                      spellCheck={false}
                      readOnly={isAllThrowablesOffer(item)}
                      aria-readonly={isAllThrowablesOffer(item)}
                    />
                  </div>
                  <div className={styles.formRow}>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.stock}
                      onChange={(e) => setDraft({ ...draft, stock: e.target.value })}
                      placeholder="Stock (Blank = Unlimited)"
                      aria-label="Stock Quantity, Blank For Unlimited"
                      className={styles.formInput}
                    />
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.salePrice}
                      onChange={(e) => setDraft({ ...draft, salePrice: e.target.value })}
                      placeholder="Sale Price (Blank Ends The Sale)"
                      aria-label="Sale Price, Blank To End The Sale"
                      className={styles.formInput}
                    />
                    <span className={styles.grantHint}>
                      {draft.stock.trim() === '' ? 'Unlimited' : `${draft.stock} Available`}
                    </span>
                  </div>
                  <div className={styles.formRow}>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={draft.perUserLimit}
                      onChange={(e) => setDraft({ ...draft, perUserLimit: e.target.value })}
                      placeholder="Max Per Member (Blank = No Cap)"
                      aria-label="Maximum Purchases Per Member"
                      className={styles.formInput}
                      readOnly={isAllThrowablesOffer(item)}
                      aria-readonly={isAllThrowablesOffer(item)}
                    />
                    <input
                      type="number"
                      step="1"
                      value={draft.sortOrder}
                      onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })}
                      placeholder="Sort Order"
                      aria-label="Storefront Sort Order"
                      className={styles.formInput}
                    />
                  </div>
                  <div className={styles.formRow}>
                    <input
                      type="datetime-local"
                      value={draft.availableFrom}
                      onChange={(e) => setDraft({ ...draft, availableFrom: e.target.value })}
                      aria-label="Available From"
                      className={styles.formInput}
                    />
                    <input
                      type="datetime-local"
                      value={draft.availableUntil}
                      onChange={(e) => setDraft({ ...draft, availableUntil: e.target.value })}
                      aria-label="Available Until"
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
                        disabled={isAllThrowablesOffer(item)}
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
                            placeholder={`How Many ${g.grantUnit}?`}
                            aria-label={`Number Of ${g.grantUnit} Granted`}
                            className={styles.formInput}
                            readOnly={isAllThrowablesOffer(item)}
                            aria-readonly={isAllThrowablesOffer(item)}
                          />
                        )}
                        {g.grantType === 'table_skin' && (
                          <select
                            value={draft.grantRef}
                            onChange={(event) =>
                              setDraft({ ...draft, grantRef: event.target.value })
                            }
                            aria-label="Table Studio Theme"
                            className={`${styles.formInput} ${styles.identifierInput}`}
                          >
                            {!MARKETPLACE_THEME_IDS.has(draft.grantRef) && draft.grantRef && (
                              <option value={draft.grantRef}>Legacy: {draft.grantRef}</option>
                            )}
                            <option value="">Choose A Table Studio Theme</option>
                            {MARKETPLACE_THEME_PRESETS.map((preset) => (
                              <option key={preset.id} value={preset.id}>
                                {formatPopupText(preset.name)}
                              </option>
                            ))}
                          </select>
                        )}
                        {g.grantType === 'avatar' && (
                          <>
                            <select
                              value={draft.grantRef}
                              onChange={(e) => setDraft({ ...draft, grantRef: e.target.value })}
                              aria-label="Avatar Library Selection"
                              className={`${styles.formInput} ${styles.identifierInput}`}
                              disabled={avatarCatalogState === 'loading'}
                            >
                              {!isRealAvatarId(draft.grantRef) && draft.grantRef && (
                                <option value={draft.grantRef}>
                                  Invalid Legacy Avatar: {draft.grantRef}
                                </option>
                              )}
                              <option value="">
                                {avatarCatalogState === 'loading'
                                  ? 'Loading The 97-Avatar Library'
                                  : avatarCatalogState === 'error'
                                    ? 'Avatar Library Unavailable - Try Again'
                                    : 'Choose An Avatar'}
                              </option>
                              {avatarOptions.map((avatar) => (
                                <option key={avatar.id} value={avatar.id}>
                                  {formatPopupText(avatar.name)} (
                                  {avatar.category === 'vip' ? 'VIP' : 'Free'})
                                </option>
                              ))}
                            </select>
                            {avatarCatalogState === 'error' && (
                              <button
                                type="button"
                                className={styles.btnGhost}
                                onClick={() => setAvatarCatalogState('idle')}
                              >
                                Retry Avatar Library
                              </button>
                            )}
                          </>
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
                      {processing ? 'Saving' : 'Save Changes'}
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
