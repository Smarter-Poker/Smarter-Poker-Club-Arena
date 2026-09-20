/**
 * MARKETPLACE : Store tab: club shop items can be bought with Diamonds from
 * the player's global wallet or handed off in the same page for Card checkout
 * (never chips : product rule, Dan 2026-08-23). Diamond purchases go through
 * /api/club-arena/marketplace-purchase (server-authoritative).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { useToast } from '../../components/common/Toast';
import { masterBus } from '../../core/MasterBus';
import { leaveForHub } from '../../lib/openExternal';
import { fmt } from '../../utils/format';
import { reportError } from '../../utils/errorReporter';
import { formatPopupText } from '../../utils/popupStyle';
import {
  clearSessionPurchaseRequestIfMatches,
  readOrCreateSessionPurchaseRequest,
  readSessionPurchaseRequest,
} from '../../utils/sessionPurchaseRequest';
import styles from '../MarketplacePage.module.css';
import ItemArt, { hasCuratedItemArt } from './ItemArt';
import {
  CATEGORIES,
  describeGrant,
  effectivePrice,
  isUuid,
  isOnSale,
  safeImageUrl,
  sortMarketplaceItems,
  unavailableReason,
  type MarketplaceItem,
  type ShopCategoryInfo,
  type SortMode,
} from './marketplaceShared';

interface MarketplacePurchaseReceipt {
  success: true;
  purchaseId: string;
  requestId: string;
  accountId: string;
  clubId: string;
  itemId: string;
  newBalance: number;
  currency: 'diamonds';
  pricePaid: number;
  duplicate: boolean;
  item: {
    name: string;
    type: string;
  };
}

/**
 * The HTTP client establishes a successful status, but the body is still an
 * untrusted serialization boundary. Do not retire the durable purchase key or
 * announce delivery until the receipt identifies the exact item and price the
 * member confirmed.
 */
export function verifiedMarketplacePurchaseReceipt(
  raw: unknown,
  expected: {
    accountId: string;
    requestId: string;
    clubId: string;
    itemId: string;
    name: string;
    itemType: string;
    price: number;
  }
): MarketplacePurchaseReceipt | null {
  if (!raw || typeof raw !== 'object') return null;
  const receipt = raw as Partial<MarketplacePurchaseReceipt>;
  const item = receipt.item;
  if (
    !expected.name ||
    !expected.itemType ||
    !Number.isSafeInteger(expected.price) ||
    expected.price < 0 ||
    !expected.accountId ||
    !isUuid(expected.requestId) ||
    receipt.success !== true ||
    !isUuid(receipt.purchaseId) ||
    receipt.requestId !== expected.requestId ||
    receipt.accountId !== expected.accountId ||
    receipt.clubId !== expected.clubId ||
    receipt.itemId !== expected.itemId ||
    !Number.isSafeInteger(receipt.newBalance) ||
    Number(receipt.newBalance) < 0 ||
    receipt.currency !== 'diamonds' ||
    !Number.isSafeInteger(receipt.pricePaid) ||
    receipt.pricePaid !== expected.price ||
    typeof receipt.duplicate !== 'boolean' ||
    !item ||
    item.name !== expected.name ||
    item.type !== expected.itemType
  ) {
    return null;
  }
  return receipt as MarketplacePurchaseReceipt;
}

interface StoreTabProps {
  clubId: string;
  userId: string;
  items: MarketplaceItem[];
  ownedItemIds: Set<string>;
  /** the buyer's DIAMOND balance (global wallet) : all prices are in diamonds */
  balance: number;
  /** jump to the Diamonds tab to top up */
  onGoDiamonds: () => void;
  isAdmin: boolean;
  /** true while the shop is still loading : do NOT claim the shop is empty */
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
  /** Refresh the authoritative catalog after a server-detected stale price. */
  onCatalogStale: () => void;
  onPurchased: (
    settlement: { accountId: string; clubId: string; newBalance: number } | null
  ) => void;
}

const cardCheckoutUnavailableCopy = (reason?: string | null) => {
  switch (reason) {
    case 'card_not_required':
      return 'Card Not Required';
    case 'wallet_debt':
      return 'Card Checkout Requires A Current Diamond Balance';
    case 'unsupported_item_price':
      return 'Card Checkout Is Not Available For This Price';
    case 'package_catalog_unavailable':
    case 'wallet_unavailable':
    case 'verification_unavailable':
      return 'Card Checkout Is Temporarily Unavailable';
    case 'fulfillment_unavailable':
      return 'Digital Delivery Is Not Available For This Item';
    default:
      return 'Card Checkout Is Unavailable';
  }
};

export default function StoreTab({
  clubId,
  userId,
  items,
  ownedItemIds,
  balance,
  onGoDiamonds,
  isAdmin,
  loading,
  error = null,
  categories,
  onGoManage,
  onCatalogStale,
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
  const inFlightRef = useRef(false);
  const operationRef = useRef(0);
  const purchaseAbortRef = useRef<AbortController | null>(null);
  const activeOwnerRef = useRef({ userId, clubId });
  const [processing, setProcessing] = useState(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [pendingPurchasePrice, setPendingPurchasePrice] = useState<number | null>(null);
  const [resumingPurchase, setResumingPurchase] = useState(false);
  const [recoveryBlockedItemId, setRecoveryBlockedItemId] = useState<string | null>(null);

  // This component remains mounted when auth or the selected club changes.
  // Revoke the prior confirmation immediately and abort its transport. The
  // durable request remains available to the original account when an abort
  // leaves the server outcome unknown.
  useLayoutEffect(() => {
    activeOwnerRef.current = { userId, clubId };
    operationRef.current += 1;
    purchaseAbortRef.current?.abort();
    purchaseAbortRef.current = null;
    inFlightRef.current = false;
    setProcessing(false);
    setPendingPurchasePrice(null);
    setResumingPurchase(false);
    setRecoveryBlockedItemId(null);
    setBuyTargetId(null);
  }, [userId, clubId]);

  useEffect(
    () => () => {
      operationRef.current += 1;
      purchaseAbortRef.current?.abort();
      purchaseAbortRef.current = null;
      inFlightRef.current = false;
    },
    []
  );

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
    return sortMarketplaceItems(result, sortMode);
  }, [items, categoryFilter, searchFilter, sortMode]);

  // Modal a11y: Escape to close, initial focus on Confirm, background locked.
  // Scroll lock + initial focus: keyed on the target only, so a busy-state
  // toggle cannot yank focus back to Confirm mid-interaction.
  useEffect(() => {
    if (!buyTarget) return;
    const prevOverflow = document.body.style.overflow;
    const trigger = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const confirm = confirmBtnRef.current;
    const initialFocus =
      confirm && !confirm.disabled
        ? confirm
        : modalRef.current?.querySelector<HTMLElement>('button:not([disabled])');
    initialFocus?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      trigger?.focus?.();
    };
  }, [buyTarget]);

  // Escape and a small focus trap need the live `processing` value, so they
  // get their own effect. The purchase sheet is the only interactive surface
  // while open; keyboard focus must not escape into the shop behind it.
  useEffect(() => {
    if (!buyTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !processing) closeBuy();
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [buyTarget, processing]);

  const modalImg =
    buyTarget &&
    !hasCuratedItemArt(
      buyTarget.name,
      buyTarget.category,
      buyTarget.item_type,
      buyTarget.grant_spec?.type,
      buyTarget.grant_spec?.avatar_id || buyTarget.grant_spec?.theme_id
    )
      ? safeImageUrl(buyTarget.image_url)
      : null;

  const purchaseScopeFor = (item: MarketplaceItem) =>
    `club-shop:${userId}:${clubId}:${item.id}:qty=1`;
  const purchasePayloadFor = (price: number) => `expected-price=${price}`;
  const priceFromPurchasePayload = (payload: string) => {
    const match = /^expected-price=(\d{1,10})$/.exec(payload);
    if (!match) return null;
    const price = Number(match[1]);
    return Number.isSafeInteger(price) && price >= 0 ? price : null;
  };

  const openBuy = (item: MarketplaceItem) => {
    if (recoveryBlockedItemId === item.id) {
      toast.warning(
        'This Verified Purchase Could Not Release Its Recovery Key. Start A New Browser Session Before Buying This Item Again.'
      );
      return;
    }
    const scope = purchaseScopeFor(item);
    let pending: ReturnType<typeof readSessionPurchaseRequest>;
    try {
      pending = readSessionPurchaseRequest(scope);
    } catch (error: unknown) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Protected Purchase Storage Is Unavailable. This Purchase Was Not Started.'
      );
      return;
    }
    const pendingPrice = pending ? priceFromPurchasePayload(pending.payloadKey) : null;
    if (pending && pendingPrice === null) {
      toast.error(
        'An Earlier Purchase Could Not Be Safely Recovered. Start A New Browser Session.'
      );
      return;
    }
    setPendingPurchasePrice(pendingPrice ?? effectivePrice(item));
    setResumingPurchase(pendingPrice !== null);
    setBuyTargetId(item.id);
  };

  const closeBuy = () => {
    setPendingPurchasePrice(null);
    setResumingPurchase(false);
    setBuyTargetId(null);
  };

  const openCardCheckout = (item: MarketplaceItem) => {
    const itemPath = encodeURIComponent(item.id);
    const clubQuery = encodeURIComponent(clubId);
    // The World Hub detail route owns its Stripe quote, request idempotency,
    // checkout-status verification, and atomic item fulfillment. Keep this a
    // same-surface handoff instead of duplicating money logic in Club Arena.
    leaveForHub(`/hub/club-shop/${itemPath}?clubId=${clubQuery}`);
  };

  /**
   * Re-checked on every render, not captured at click time. `ownedItemIds` and
   * `stock` change while the modal sits open (the page reloads inventory and
   * the shop behind it), so Confirm stayed live for an item that had since
   * become owned / sold out / ended, and only the server stopped the charge.
   */
  const purchasePrice = buyTarget ? (pendingPurchasePrice ?? effectivePrice(buyTarget)) : 0;
  const modalBlocked =
    buyTarget && !resumingPurchase
      ? unavailableReason(buyTarget, ownedItemIds.has(buyTarget.id), !!buyTarget.stackable)
      : null;

  const handlePurchase = async () => {
    if (!buyTarget) return;
    // This must run before an intent is created. A blocked/synthetic click or
    // a duplicate event while the first request is in flight is not a new
    // server attempt and must not leave a pending request in session storage.
    if (inFlightRef.current) return;
    if (modalBlocked) return;
    const purchaseItem = buyTarget;
    const purchaseAccountId = userId;
    const purchaseClubId = clubId;
    if (!purchaseAccountId || !purchaseClubId) return;
    const purchaseScope = purchaseScopeFor(purchaseItem);
    let purchaseIntent: ReturnType<typeof readOrCreateSessionPurchaseRequest>;
    try {
      purchaseIntent = readOrCreateSessionPurchaseRequest(
        purchaseScope,
        purchasePayloadFor(effectivePrice(purchaseItem))
      );
    } catch (error: unknown) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Protected Purchase Storage Is Unavailable. This Purchase Was Not Started.'
      );
      return;
    }
    const confirmedPrice = priceFromPurchasePayload(purchaseIntent.payloadKey);
    if (confirmedPrice === null) {
      // An invalid durable binding may belong to a request whose response was
      // lost. Never erase it and mint a second charge identity automatically.
      toast.error(
        'An Earlier Purchase Could Not Be Safely Recovered. Start A New Browser Session.'
      );
      return;
    }
    setPendingPurchasePrice(confirmedPrice);
    setResumingPurchase(purchaseIntent.resumed);
    // A REF, not the state flag. `processing` is only visible to a later event
    // after React commits, so a synthetic double-fire in the same tick (iOS
    // touch-then-click, Enter landing with a click) passed both guards.
    inFlightRef.current = true;
    setProcessing(true);
    const operationId = ++operationRef.current;
    const controller = new AbortController();
    purchaseAbortRef.current = controller;
    const isCurrentOperation = () =>
      operationRef.current === operationId &&
      activeOwnerRef.current.userId === purchaseAccountId &&
      activeOwnerRef.current.clubId === purchaseClubId;
    let completedReceipt: MarketplacePurchaseReceipt | null = null;
    let completedRecoveryRetired = true;
    try {
      const data = await callClubArenaApi<MarketplacePurchaseReceipt>(
        'marketplace-purchase',
        {
          clubId: purchaseClubId,
          itemId: purchaseItem.id,
          // The confirmation and the debit are one price contract. PostgreSQL
          // locks the item and rejects this exact value when an admin changes
          // the price after the sheet opened, so a player can never confirm
          // one amount and be charged another.
          expectedPrice: confirmedPrice,
        },
        {
          idempotencyKey: purchaseIntent.requestId,
          expectedUserId: purchaseAccountId,
          signal: controller.signal,
        }
      );
      const receipt = verifiedMarketplacePurchaseReceipt(data, {
        accountId: purchaseAccountId,
        requestId: purchaseIntent.requestId,
        clubId: purchaseClubId,
        itemId: purchaseItem.id,
        name: purchaseItem.name,
        itemType: purchaseItem.item_type || purchaseItem.grant_spec?.type || '',
        price: confirmedPrice,
      });
      if (!receipt) {
        throw new Error(
          'Purchase Status Could Not Be Verified. Retry This Same Item To Check The Original Purchase.'
        );
      }
      try {
        if (!clearSessionPurchaseRequestIfMatches(purchaseScope, purchaseIntent.requestId)) {
          completedRecoveryRetired = false;
          reportError(
            new Error('Verified Purchase Request Was Not The Current Protected Store Intent.'),
            'StoreTab.retireVerifiedPurchaseMismatch'
          );
        }
      } catch (retirementError) {
        completedRecoveryRetired = false;
        // The financial result is already exact and terminal. Retaining its
        // key is safe (the server replays it); rotating or relabeling this
        // verified success would be unsafe.
        reportError(retirementError, 'StoreTab.retireVerifiedPurchase');
      }
      completedReceipt = receipt;
    } catch (err: unknown) {
      const apiError = err as {
        definitive?: boolean;
        status?: number;
        data?: {
          code?: string;
          reason?: string;
          soldOut?: boolean;
          alreadyOwned?: boolean;
          limitReached?: boolean;
        };
      };
      const definitiveRefusal = apiError.definitive === true;
      const resumedPurchase = purchaseIntent.resumed;

      // price_changed is a special, explicitly pre-commit 409. The database
      // refused the debit because the locked server price no longer equals
      // expectedPrice. Retire this intent, dismiss its stale confirmation,
      // and reload server truth before the player can confirm again. Every
      // other 409 conflict remains ambiguous and keeps its key for replay
      // safety unless the route explicitly proves this exact price mismatch.
      if (apiError.status === 409 && apiError.data?.reason === 'price_changed') {
        if (resumedPurchase) {
          if (isCurrentOperation()) {
            setPendingPurchasePrice(confirmedPrice);
            setResumingPurchase(true);
            toast.error(
              'An Earlier Purchase Is Still Protected. Retry This Same Purchase To Verify Its Final Status Before Starting Another.'
            );
          }
          return;
        }
        try {
          if (!clearSessionPurchaseRequestIfMatches(purchaseScope, purchaseIntent.requestId)) {
            throw new Error('Protected Purchase Identity Changed Before Retirement.');
          }
        } catch (retirementError) {
          reportError(retirementError, 'StoreTab.retireStalePricePurchase');
          if (isCurrentOperation()) {
            setResumingPurchase(true);
            toast.error(
              'The Price Changed, But Protected Purchase Recovery Could Not Be Cleared. Start A New Browser Session Before Trying Again.'
            );
          }
          return;
        }
        if (isCurrentOperation()) {
          toast.error(err instanceof Error ? err.message : 'The Price Changed. Please Review It.');
          closeBuy();
          onCatalogStale();
        }
        return;
      }
      /*
       * ONE KEY PER ATTEMPT, NOT ONE KEY PER MODAL. The short response cache
       * stores a successful response briefly, while the purchase row keeps
       * the hashed charge reference permanently. The modal stays open after
       * a refusal such as "Insufficient diamonds", so a
       * player who topped up and pressed Confirm again sent the SAME key and
       * got the SAME cached 400 back - a purchase that could now succeed was
       * told, again, that it could not. A refused attempt is finished; the
       * next press is a new attempt and carries a new key.
       *
       * ONLY WHEN THE REFUSAL IS TERMINAL (2026-09-09). `callClubArenaApi`
       * throws the same shape for a transport failure, a 5xx and a
       * `{success:false}` body, so rotating unconditionally rotated after a
       * COMMITTED purchase whose response was lost - and the next press
       * charged the diamonds again. `definitive` is the same 400/401/403/
       * 404/405/422 list UnionApiService uses; anything else keeps the key so
       * the server replays its own answer.
       */
      if (definitiveRefusal && resumedPurchase) {
        if (isCurrentOperation()) {
          setPendingPurchasePrice(confirmedPrice);
          setResumingPurchase(true);
          toast.error(
            'An Earlier Purchase Is Still Protected. Retry This Same Purchase To Verify Its Final Status Before Starting Another.'
          );
        }
      } else if (definitiveRefusal) {
        try {
          if (!clearSessionPurchaseRequestIfMatches(purchaseScope, purchaseIntent.requestId)) {
            throw new Error('Protected Purchase Identity Changed Before Retirement.');
          }
        } catch (retirementError) {
          reportError(retirementError, 'StoreTab.retireRefusedPurchase');
          if (isCurrentOperation()) {
            setResumingPurchase(true);
            toast.error(
              'The Purchase Was Refused, But Protected Recovery Could Not Be Cleared. Start A New Browser Session Before Trying Again.'
            );
          }
          return;
        }
        if (isCurrentOperation()) {
          setPendingPurchasePrice(effectivePrice(purchaseItem));
          setResumingPurchase(false);
          toast.error(err instanceof Error ? err.message : 'Purchase Failed');
        }
      } else if (isCurrentOperation()) {
        setPendingPurchasePrice(confirmedPrice);
        setResumingPurchase(true);
        toast.error(
          'Purchase Status Is Uncertain. Retry This Same Item To Verify The Original Purchase Before Buying Again.'
        );
      }
      // Only an authoritative refusal may dismiss stale inventory. A 409 can
      // also be an uncertain replay, so it keeps the modal and request key.
      const flags = apiError.data;
      if (
        isCurrentOperation() &&
        !resumedPurchase &&
        definitiveRefusal &&
        (flags?.soldOut || flags?.alreadyOwned || flags?.limitReached)
      ) {
        closeBuy();
        onPurchased(null);
      }
    } finally {
      if (operationRef.current === operationId) {
        purchaseAbortRef.current = null;
        inFlightRef.current = false;
        setProcessing(false);
      }
    }

    // The financial result is already verified and its key is retired. Keep
    // presentation callbacks outside the purchase catch so a local event or
    // toast failure can never relabel a confirmed purchase as ambiguous and
    // invite a second charge identity.
    if (!completedReceipt) return;
    if (!isCurrentOperation()) return;
    if (!completedRecoveryRetired) setRecoveryBlockedItemId(purchaseItem.id);
    closeBuy();
    onPurchased({
      accountId: completedReceipt.accountId,
      clubId: completedReceipt.clubId,
      newBalance: completedReceipt.newBalance,
    });
    if (completedRecoveryRetired) {
      toast.success(`Purchased ${purchaseItem.name}`);
    } else {
      toast.warning(
        `${purchaseItem.name} Was Purchased, But Its Secure Recovery Key Could Not Be Cleared. Do Not Submit This Item Again In This Browser Session.`
      );
    }
    masterBus.emit('BALANCE_UPDATED', {
      source: 'marketplace_purchase',
      clubId: purchaseClubId,
    });
    const grant = purchaseItem.grant_spec;
    if (grant && grant.type !== 'none') {
      const quantity = Math.max(1, Math.floor(Number(grant.qty) || 1));
      const assetId = grant.theme_id || grant.avatar_id;
      masterBus.emit('ENTITLEMENTS_CHANGED', {
        userId: purchaseAccountId,
        category: grant.type,
        assetId,
        quantity,
        source: 'club-purchase',
      });
      if (grant.type === 'table_skin' || grant.type === 'avatar') {
        masterBus.emit('COSMETIC_OWNERSHIP_CHANGED', {
          userId: purchaseAccountId,
          category: grant.type === 'avatar' ? 'avatar' : 'theme_id',
          assetId,
          source: 'club-purchase',
        });
      }
    }
  };

  if (items.length === 0 && loading) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyText}>Loading The Shop</span>
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
        <span className={styles.emptyText}>The Club Shop Is Currently Empty.</span>
        <span className={styles.emptySubText}>
          Club Owners Can Add Verified Time Bank Offers. The All Throwables Pack Is Managed By
          Smarter.Poker.
        </span>
        {isAdmin && (
          <button className={styles.emptyButton} onClick={onGoManage}>
            Add First Item
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
            ref={modalRef}
            className={styles.modal}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="buy-modal-title"
            aria-describedby="buy-modal-description"
          >
            <div className={styles.modalHandle} aria-hidden="true" />
            <button
              type="button"
              className={styles.modalClose}
              onClick={closeBuy}
              disabled={processing}
              aria-label="Close Purchase"
            >
              Close
            </button>
            <span className={styles.modalEyebrow}>Instant Account Delivery</span>
            <h2 className={styles.modalTitle} id="buy-modal-title">
              Confirm Purchase
            </h2>
            <div className={styles.purchasePreview}>
              <div className={styles.purchaseImage}>
                <ItemArt
                  category={buyTarget.category}
                  name={buyTarget.name}
                  itemType={buyTarget.item_type}
                  grantType={buyTarget.grant_spec?.type}
                  artRef={buyTarget.grant_spec?.avatar_id || buyTarget.grant_spec?.theme_id}
                  seed={buyTarget.id}
                />
                {modalImg && (
                  <img
                    src={modalImg}
                    alt=""
                    className={styles.itemImg}
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    onError={(event) => {
                      (event.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
              </div>
              <div>
                <div className={styles.itemName}>{formatPopupText(buyTarget.name)}</div>
                <div className={styles.itemDesc} id="buy-modal-description">
                  {formatPopupText(buyTarget.description || 'No Description Available.')}
                </div>
                {grantText(buyTarget) && (
                  <div className={styles.grantLine}>
                    Delivered Instantly: {grantText(buyTarget)}
                  </div>
                )}
              </div>
            </div>
            <div className={styles.priceBox}>
              <div className={styles.priceItem}>
                <span className={styles.priceLabel}>
                  {resumingPurchase ? 'Pending Purchase Price' : 'Item Price'}
                </span>
                <span className={styles.priceValueRed}>
                  {!resumingPurchase && isOnSale(buyTarget) && (
                    <span className={styles.strikePrice}>{fmt(buyTarget.price)}</span>
                  )}
                  {fmt(purchasePrice)} Diamonds
                </span>
              </div>
              <div className={styles.priceItem}>
                <span className={styles.priceLabel}>Your Diamonds</span>
                <span className={styles.priceValueBalance}>{fmt(balance)}</span>
              </div>
            </div>
            {resumingPurchase && (
              <div className={styles.insufficientFunds} role="status">
                Purchase Status Is Uncertain. Confirm Again To Verify The Original Purchase With The
                Same Protected Request Before Buying Again.
              </div>
            )}
            {!resumingPurchase && balance < purchasePrice && (
              <div className={styles.insufficientFunds}>
                <span>Insufficient Diamonds. You Need {fmt(purchasePrice - balance)} More.</span>
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
                disabled={
                  processing || !!modalBlocked || (!resumingPurchase && balance < purchasePrice)
                }
                aria-label={`${resumingPurchase ? 'Verify' : 'Confirm'} ${formatPopupText(buyTarget.name)} Purchase With Diamonds`}
              >
                {processing
                  ? 'Verifying Purchase'
                  : resumingPurchase
                    ? 'Verify Purchase'
                    : 'Confirm Purchase'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={styles.storeIntro}>
        <div>
          <span className={styles.eyebrow}>Curated For This Club</span>
          <h2 className={styles.sectionTitle}>Premium Table Upgrades</h2>
          <p className={styles.sectionSub}>
            Own A New Look Or Add A Gameplay Perk. Every Eligible Purchase Appears Without A Reload.
          </p>
        </div>
        <span className={styles.deliveryStatus}>Live Delivery</span>
      </div>

      {/* Category filters */}
      {/* A filter chip row is a set of toggles, not a list of unrelated
          buttons: without aria-pressed a screen reader reads seven identical
          "button" nodes and cannot say which category is active. The visual
          state was carried only by a CSS class. */}
      <div className={styles.categoryFilters} role="group" aria-label="Filter Items By Category">
        {categoryNames.map((cat) => (
          <button
            key={cat}
            type="button"
            aria-pressed={categoryFilter === cat}
            className={`${styles.categoryBtn} ${categoryFilter === cat ? styles.categoryBtnActive : ''}`}
            onClick={() => setCategoryFilter(cat)}
          >
            {formatPopupText(cat)}
          </button>
        ))}
      </div>

      {/* Search + sort */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <input
            type="search"
            placeholder="Search The Collection"
            aria-label="Search Shop Items"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className={styles.searchInput}
          />
        </div>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className={styles.sortSelect}
          aria-label="Sort Shop Items"
        >
          <option value="newest">Featured</option>
          <option value="price-low">Price: Low To High</option>
          <option value="price-high">Price: High To Low</option>
          <option value="popular">Most Popular</option>
        </select>
      </div>

      <div className={styles.resultSummary} aria-live="polite">
        <span>
          Showing <strong>{fmt(filteredItems.length)}</strong> Of{' '}
          <strong>{fmt(items.length)}</strong> Items
        </span>
        {(categoryFilter !== 'All' || searchFilter) && (
          <button
            type="button"
            onClick={() => {
              setCategoryFilter('All');
              setSearchFilter('');
            }}
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Item grid */}
      {filteredItems.length === 0 ? (
        <div className={styles.emptyState}>
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
            const img = hasCuratedItemArt(
              item.name,
              item.category,
              item.item_type,
              item.grant_spec?.type,
              item.grant_spec?.avatar_id || item.grant_spec?.theme_id
            )
              ? null
              : safeImageUrl(item.image_url);
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
                    ? 'Not Yet Available'
                    : blocked === 'ended'
                      ? 'Ended'
                      : blocked === 'limit_reached'
                        ? 'Limit Reached'
                        : blocked === 'unavailable'
                          ? 'Unavailable'
                          : stackable && alreadyOwned
                            ? 'Buy Again'
                            : 'Buy';
            // Missing is not approval. Older or partial API responses must not
            // expose a Card action without a verified server quote.
            const cardCheckoutUnavailable = item.card_checkout_available !== true;
            const cardCheckoutCopy = cardCheckoutUnavailable
              ? cardCheckoutUnavailableCopy(item.card_checkout_reason)
              : 'Buy With Card';
            return (
              <div key={item.id} className={styles.itemCard}>
                <div className={styles.itemImageArea}>
                  {/* Approved catalog photography renders in this existing
                      card slot. An approved, unmapped admin image may layer
                      over the resilient category scene for a custom item. */}
                  <ItemArt
                    category={item.category}
                    name={item.name}
                    itemType={item.item_type}
                    grantType={item.grant_spec?.type}
                    artRef={item.grant_spec?.avatar_id || item.grant_spec?.theme_id}
                    seed={item.id}
                    className={styles.itemArt}
                  />
                  {img && (
                    <img
                      src={img}
                      alt=""
                      className={styles.itemCover}
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )}
                  <div className={styles.itemBadgesLeft}>
                    <span className={styles.categoryTag}>
                      {formatPopupText(item.category || 'Time Banks')}
                    </span>
                    {onSale && !soldOut && <span className={styles.saleTag}>Sale</span>}
                  </div>
                  <div className={styles.itemBadgesRight}>
                    {soldOut && <span className={styles.soldOutTag}>Sold Out</span>}
                    {/* Every number a member reads goes through fmt (house rule:
                      .toLocaleString, never a raw interpolation). A shop with
                      12000 units in stock printed "12000 Left". */}
                    {limited && !soldOut && !item.per_user_limit && (
                      <span className={styles.stockTag}>{fmt(item.stock)} Left</span>
                    )}
                    {item.per_user_limit && !blocked ? (
                      <span className={styles.stockTag}>
                        {fmt(Math.max(0, item.per_user_limit - (item.my_purchase_count ?? 0)))} Left
                        For You
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className={styles.itemBody}>
                  <div className={styles.itemName}>{formatPopupText(item.name)}</div>
                  <div className={styles.itemDesc}>
                    {formatPopupText(item.description || 'No Description Available.')}
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
                    <div className={styles.itemPurchaseActions}>
                      <button
                        onClick={() => openBuy(item)}
                        className={blocked === 'owned' ? styles.btnOwned : styles.btnPrimary}
                        disabled={!!blocked || processing || recoveryBlockedItemId === item.id}
                        title={
                          blocked === 'not_yet' && item.available_from
                            ? `Available From ${new Date(item.available_from).toLocaleString()}`
                            : undefined
                        }
                        aria-label={`${buyLabel} ${formatPopupText(item.name)} With Diamonds`}
                      >
                        {recoveryBlockedItemId === item.id
                          ? 'Recovery Locked'
                          : blocked
                            ? buyLabel
                            : 'Buy With Diamonds'}
                      </button>
                      <button
                        type="button"
                        onClick={() => openCardCheckout(item)}
                        className={styles.btnGhost}
                        disabled={!!blocked || processing || cardCheckoutUnavailable}
                        aria-label={`Buy ${formatPopupText(item.name)} With Card`}
                        title={cardCheckoutUnavailable ? cardCheckoutCopy : undefined}
                      >
                        {cardCheckoutCopy}
                      </button>
                    </div>
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
