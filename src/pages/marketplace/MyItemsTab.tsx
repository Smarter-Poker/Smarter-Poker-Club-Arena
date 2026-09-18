/**
 * MARKETPLACE : My Items tab: delivered inventory (club_shop_inventory) with
 * redemption, plus full purchase history from club_shop_purchases.
 * Reads are RLS-scoped to the owner; redemption goes through fn_redeem_shop_item.
 */

import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { fmt, timeAgo } from '../../utils/format';
import { formatPopupText } from '../../utils/popupStyle';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { masterBus } from '../../core/MasterBus';
import styles from '../MarketplacePage.module.css';
import ItemArt from './ItemArt';
import {
  isOwnedRow,
  type Entitlements,
  type InventoryRow,
  type ShopPurchase,
} from './marketplaceShared';

/** 'Diamonds' for post-2026-08-23 purchases, 'Chips' for legacy rows. */
const unitOf = (currency?: string | null) => (currency === 'chips' ? 'Chips' : 'Diamonds');

interface MyItemsTabProps {
  clubId: string | null;
  userId: string;
  /** owners/admins may reverse a purchase that has not been redeemed */
  isAdmin: boolean;
  inventory: InventoryRow[];
  purchases: ShopPurchase[];
  /** live balances granted by redemption (time bank, throws, unlocks) */
  entitlements: Entitlements;
  onGoStore: () => void;
  onRedeemed: () => void;
}

export default function MyItemsTab({
  clubId,
  userId,
  isAdmin,
  inventory,
  purchases,
  entitlements,
  onGoStore,
  onRedeemed,
}: MyItemsTabProps) {
  const toast = useToast();
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  /**
   * REFS, NOT THE STATE FLAGS. `refunding`/`redeeming` only become visible to a
   * later event once React has committed, so two handlers firing in the SAME
   * tick (iOS touch-then-click, Enter landing alongside a click) both read null
   * and both proceed - two confirm dialogs over one purchase. StoreTab already
   * carries this fix for Buy; refund moves real diamonds, so it needs it more.
   * The state flags stay: they are what disables the buttons.
   */
  const refundingRef = useRef(false);
  const redeemingRef = useRef(false);
  const mountedRef = useRef(true);
  const activeOwnerRef = useRef({ userId, clubId });
  const refundAttemptRef = useRef(0);
  const refundAbortRef = useRef<AbortController | null>(null);
  const redeemAttemptRef = useRef(0);

  useLayoutEffect(() => {
    mountedRef.current = true;
    activeOwnerRef.current = { userId, clubId };
    refundAttemptRef.current += 1;
    refundAbortRef.current?.abort();
    refundAbortRef.current = null;
    redeemAttemptRef.current += 1;
    refundingRef.current = false;
    redeemingRef.current = false;
    setRefunding(null);
    setRedeeming(null);
    return () => {
      mountedRef.current = false;
      refundAttemptRef.current += 1;
      refundAbortRef.current?.abort();
      refundAbortRef.current = null;
      redeemAttemptRef.current += 1;
      refundingRef.current = false;
      redeemingRef.current = false;
    };
  }, [clubId, userId]);

  const handleRefund = async (purchaseId: string, itemName: string, currency?: string | null) => {
    if (refundingRef.current || !clubId || !userId) return;
    const expectedUserId = userId;
    const expectedClubId = clubId;
    const attemptId = ++refundAttemptRef.current;
    refundAbortRef.current?.abort();
    const controller = new AbortController();
    refundAbortRef.current = controller;
    const isCurrent = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      refundAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === expectedUserId &&
      activeOwnerRef.current.clubId === expectedClubId;
    const unit = unitOf(currency);
    // CLAIM THE FLAG BEFORE THE DIALOG (Dan 2026-08-25). It was set after the
    // await, so for the whole time the confirm dialog was open `refunding` was
    // still null and every Refund button was still enabled - two dialogs could
    // be opened and both confirmed, for two refunds.
    refundingRef.current = true;
    setRefunding(purchaseId);
    if (
      !(await confirmDialog({
        title: 'Refund Purchase',
        message: `Refund "${itemName}"? The ${unit} Go Back To The Buyer And The Copy Is Revoked. Items That Have Already Been Redeemed Cannot Be Refunded Automatically.`,
        confirmText: 'Refund',
        variant: 'danger',
      }))
    ) {
      if (isCurrent()) {
        refundAbortRef.current = null;
        refundingRef.current = false;
        setRefunding(null);
      }
      return;
    }
    if (!isCurrent()) return;
    try {
      const res = await callClubArenaApi<{
        amount: number;
        currency?: string;
        alreadyRefunded?: boolean;
      }>(
        'refund-purchase',
        { clubId: expectedClubId, purchaseId },
        // ONE KEY PER REFUND INTENT, derived from the purchase itself. A retry
        // of the same refund must carry the same key or the server sees two
        // distinct intents; the default in callClubArenaApi mints a fresh uuid
        // per CALL, which defends nothing against the retry it exists for.
        {
          idempotencyKey: `refund:${expectedClubId}:${purchaseId}`,
          expectedUserId,
          signal: controller.signal,
        }
      );
      if (!isCurrent()) return;
      toast.success(
        res.alreadyRefunded
          ? 'That Purchase Was Already Refunded'
          : `Refunded ${fmt(res.amount)} ${unitOf(res.currency || currency)}`
      );
      onRedeemed();
    } catch (err: unknown) {
      if (!isCurrent() || (err instanceof Error && err.name === 'AbortError')) return;
      toast.error(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      if (refundAbortRef.current === controller && refundAttemptRef.current === attemptId) {
        refundAbortRef.current = null;
        refundingRef.current = false;
        setRefunding(null);
      }
    }
  };
  const [showHistory, setShowHistory] = useState(false);

  const handleRedeem = async (inventoryId: string) => {
    if (redeemingRef.current || !userId) return;
    const expectedUserId = userId;
    const expectedClubId = clubId;
    const attemptId = ++redeemAttemptRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      redeemAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === expectedUserId &&
      activeOwnerRef.current.clubId === expectedClubId;
    // Same shape as handleRefund: claim first, release on cancel.
    redeemingRef.current = true;
    setRedeeming(inventoryId);
    if (
      !(await confirmDialog({
        title: 'Redeem Item',
        message:
          'Mark This Item As Used/Redeemed? This Cannot Be Undone. Once Redeemed, You Can Buy The Item Again From The Store.',
        confirmText: 'Redeem',
        variant: 'default',
      }))
    ) {
      if (isCurrent()) {
        redeemingRef.current = false;
        setRedeeming(null);
      }
      return;
    }
    if (!isCurrent()) return;
    try {
      const {
        data: { session: initiatingSession },
      } = await supabase.auth.getSession();
      if (!isCurrent() || initiatingSession?.user?.id !== expectedUserId) {
        throw new Error('The Signed-In Player Changed Before This Request Started.');
      }
      const { data, error } = await supabase.rpc('fn_redeem_shop_item', {
        p_inventory_id: inventoryId,
      });
      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || 'Redeem failed');
      }
      const {
        data: { session: confirmedSession },
      } = await supabase.auth.getSession();
      if (!isCurrent() || confirmedSession?.user?.id !== expectedUserId) return;
      // fn_redeem_shop_item now grants a real entitlement and reports it back.
      const g = data?.granted as
        | {
            type?: 'time_bank' | 'throwable' | 'emote_pack' | 'table_skin' | 'avatar' | 'none';
            uses?: number;
            seconds?: number;
            theme_id?: string;
            avatar_id?: string;
          }
        | undefined;
      if (g?.type === 'time_bank' && g.seconds) {
        toast.success(`Redeemed - +${fmt(g.seconds)}s Of Table Time Added`);
      } else if (g?.type === 'throwable' && g.uses) {
        toast.success(`Redeemed - ${fmt(g.uses)} All Throwables Uses Added`);
      } else if (g?.type === 'emote_pack') {
        toast.success('Redeemed - Emote Pack Unlocked');
      } else if (g?.type === 'table_skin') {
        toast.success('Redeemed - Table Theme Unlocked');
      } else if (g?.type === 'avatar') {
        toast.success('Redeemed - Avatar Unlocked');
      } else {
        toast.error('Redemption Did Not Return A Verified Digital Grant');
      }
      if (g?.type === 'table_skin' || g?.type === 'avatar') {
        masterBus.emit('COSMETIC_OWNERSHIP_CHANGED', {
          // The function only redeems inventory owned by auth.uid(); the user id
          // is returned by the grant response in the new contract.
          userId: String(data.user_id || ''),
          category: g.type === 'avatar' ? 'avatar' : 'theme_id',
          assetId: g.avatar_id || g.theme_id,
          source: 'club-redemption',
        });
      }
      if (g?.type && g.type !== 'none') {
        masterBus.emit('ENTITLEMENTS_CHANGED', {
          userId: String(data.user_id || ''),
          category: g.type,
          assetId: g.avatar_id || g.theme_id,
          quantity: g.uses,
          source: 'club-redemption',
        });
      }
      onRedeemed();
    } catch (err: unknown) {
      if (!isCurrent()) return;
      toast.error(err instanceof Error ? err.message : 'Redeem failed');
      reportError(err, 'MyItemsTab.handleRedeem');
    } finally {
      if (redeemAttemptRef.current === attemptId) {
        redeemingRef.current = false;
        setRedeeming(null);
      }
    }
  };

  const ent = entitlements;
  /**
   * Counts, not vague claims. "Table Theme" was printed off a retired generic
   * receipt, so a member who had bought and redeemed four skins was told the
   * same thing as one who had bought one.
   * `theme_asset_unlocks` knows which, so say how many.
   */
  const themeCount = ent.themes.length || (ent.themeUnlock ? 1 : 0);
  const entitlementChips = ent.loaded
    ? [
        ent.timeBankSeconds > 0 ? `${fmt(ent.timeBankSeconds)}s Table Time` : null,
        ent.throwables > 0 ? `${fmt(ent.throwables)} All Throwables Uses` : null,
        ent.emotePack ? 'Emote Pack' : null,
        themeCount > 0 ? `${fmt(themeCount)} Table Theme${themeCount > 1 ? 's' : ''}` : null,
        ent.avatars.length > 0
          ? `${fmt(ent.avatars.length)} Avatar${ent.avatars.length > 1 ? 's' : ''}`
          : null,
        ent.avatarCosmetics.length > 0
          ? `${fmt(ent.avatarCosmetics.length)} Avatar Style${ent.avatarCosmetics.length > 1 ? 's' : ''}`
          : null,
      ].filter(Boolean)
    : [];

  // Inventory rows inherit their purchase's currency (legacy rows were chips).
  const currencyByPurchase = useMemo(() => {
    const m = new Map<string, string>();
    // 'diamonds', matching unitOf's default. These two disagreed, so a row with a
    // null currency showed "500 Chips" in the inventory table and "500 Diamonds"
    // in the history table - the same purchase, on the same screen. Chips have
    // not been purchasable since 2026-08-23 either.
    purchases.forEach((p) => m.set(p.id, p.currency || 'diamonds'));
    return m;
  }, [purchases]);

  const deliveredPurchaseIds = useMemo(
    () =>
      new Set(
        inventory
          .filter((item) => !!item.redeemed_at || item.status === 'redeemed')
          .map((item) => item.purchase_id)
          .filter((purchaseId): purchaseId is string => !!purchaseId)
      ),
    [inventory]
  );

  const entitlementStrip =
    entitlementChips.length > 0 ? (
      <div className={styles.entitlementStrip}>
        <span className={styles.entitlementLabel}>You Currently Hold:</span>
        {entitlementChips.map((c) => (
          <span key={c as string} className={styles.entitlementChip}>
            {c}
          </span>
        ))}
      </div>
    ) : null;

  if (inventory.length === 0 && purchases.length === 0) {
    return (
      <>
        {entitlementStrip}
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>You Have Not Purchased Any Items Yet.</span>
          <button className={styles.emptyButton} onClick={onGoStore}>
            Browse Store
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {entitlementStrip}
      {inventory.length > 0 ? (
        <div className={styles.tableScroll}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Price Paid</th>
                <th>Acquired</th>
                <th>Status</th>
                <th>
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((it) => {
                const spent = !isOwnedRow(it);
                const delivered = !!it.redeemed_at;
                const activated = !spent && delivered;
                const redeemed = spent;
                /* SPENT_STATUSES is {redeemed, refunded, revoked, expired}, and
                   `redeemed = spent` collapsed all four into one badge - so a
                   revoked or expired row told the member they had USED
                   something that was actually taken away or had timed out.
                   Dan 2026-08-25. */
                const statusLabel =
                  it.status === 'refunded'
                    ? 'Refunded'
                    : it.status === 'revoked'
                      ? 'Revoked'
                      : it.status === 'expired'
                        ? 'Expired'
                        : activated
                          ? 'Active'
                          : it.status === 'redeemed'
                            ? 'Redeemed'
                            : spent
                              ? 'Spent'
                              : 'Owned';
                const rowUnit = unitOf(
                  it.purchase_id ? currencyByPurchase.get(it.purchase_id) : undefined
                );
                return (
                  <tr key={it.id}>
                    <td data-label="Item" className={styles.dataItemName}>
                      <span className={styles.rowWithArt}>
                        <span className={styles.rowArt} aria-hidden="true">
                          <ItemArt
                            category={it.category}
                            name={it.item_name}
                            seed={it.item_id || it.id}
                          />
                        </span>
                        {formatPopupText(it.item_name || 'Unknown Item')}
                      </span>
                    </td>
                    <td data-label="Category">
                      <span className={styles.categorySmall}>
                        {formatPopupText(it.category || 'Uncategorized')}
                      </span>
                    </td>
                    <td data-label="Price Paid" className={styles.dataValuePrice}>
                      {fmt(it.price_paid)} {rowUnit}
                    </td>
                    <td data-label="Acquired" className={styles.dataValueMuted}>
                      {formatPopupText(timeAgo(it.acquired_at))}
                    </td>
                    <td data-label="Status">
                      <span
                        className={`${styles.inventoryStatus} ${
                          redeemed ? styles.inventoryStatusMuted : styles.inventoryStatusActive
                        }`}
                      >
                        {statusLabel}
                      </span>
                    </td>
                    <td data-label="Actions">
                      {!redeemed && !delivered && (
                        <button
                          className={styles.emptyButton}
                          style={{ padding: '4px 12px', fontSize: '12px' }}
                          onClick={() => handleRedeem(it.id)}
                          disabled={redeeming !== null}
                        >
                          {redeeming === it.id ? 'Redeeming' : 'Redeem'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>No Items In Your Inventory Right Now.</span>
          <button className={styles.emptyButton} onClick={onGoStore}>
            Browse Store
          </button>
        </div>
      )}

      {/* Purchase history */}
      {purchases.length > 0 && (
        <div className={styles.historyBlock}>
          <button className={styles.historyToggle} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide' : 'Show'} Purchase History ({purchases.length})
          </button>
          {showHistory && (
            <div className={styles.tableScroll}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th>Paid</th>
                    <th>When</th>
                    <th>Status</th>
                    {isAdmin && (
                      <th>
                        <span className={styles.srOnly}>Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Item" className={styles.dataItemName}>
                        {formatPopupText(p.item_name || 'Unknown Item')}
                      </td>
                      <td data-label="Category">
                        <span className={styles.categorySmall}>
                          {formatPopupText(p.item_category || 'Uncategorized')}
                        </span>
                      </td>
                      <td data-label="Paid" className={styles.dataValuePrice}>
                        {fmt(p.price_paid)} {unitOf(p.currency)}
                      </td>
                      <td data-label="When" className={styles.dataValueMuted}>
                        {formatPopupText(timeAgo(p.created_at))}
                      </td>
                      <td data-label="Status">
                        <span
                          className={`${styles.inventoryStatus} ${
                            p.refunded_at
                              ? styles.inventoryStatusMuted
                              : styles.inventoryStatusActive
                          }`}
                          title={
                            p.refunded_at
                              ? `Refunded ${formatPopupText(timeAgo(p.refunded_at))}`
                              : undefined
                          }
                        >
                          {p.refunded_at ? 'Refunded' : 'Paid'}
                        </span>
                      </td>
                      {isAdmin && (
                        <td data-label="Actions">
                          {/* A refunded purchase cannot be refunded again : the
                              server answers "already refunded". Say so here
                              instead of offering the action. */}
                          {p.refunded_at || deliveredPurchaseIds.has(p.id) ? (
                            <span className={styles.dataValueMuted}>-</span>
                          ) : (
                            <button
                              className={styles.btnDeleteSmall}
                              onClick={() =>
                                handleRefund(p.id, p.item_name || 'This Item', p.currency)
                              }
                              disabled={refunding !== null}
                              aria-label={`Refund ${formatPopupText(p.item_name || 'This Item')}`}
                            >
                              {refunding === p.id ? 'Refunding' : 'Refund'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
