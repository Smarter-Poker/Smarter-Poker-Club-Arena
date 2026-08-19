/**
 * MARKETPLACE — My Items tab: delivered inventory (club_shop_inventory) with
 * redemption, plus full purchase history from club_shop_purchases.
 * Reads are RLS-scoped to the owner; redemption goes through fn_redeem_shop_item.
 */

import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { fmtChips, timeAgo } from '../../utils/format';
import { useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import styles from '../MarketplacePage.module.css';
import {
  isOwnedRow,
  type Entitlements,
  type InventoryRow,
  type ShopPurchase,
} from './marketplaceShared';

interface MyItemsTabProps {
  clubId: string | null;
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

  const handleRefund = async (purchaseId: string, itemName: string) => {
    if (refunding || !clubId) return;
    if (
      !(await confirmDialog({
        title: 'Refund purchase',
        message: `Refund "${itemName}"? The chips go back to the buyer and the copy is revoked. Items that have already been redeemed cannot be refunded automatically.`,
        confirmText: 'Refund',
        variant: 'danger',
      }))
    )
      return;
    setRefunding(purchaseId);
    try {
      const res = await callClubArenaApi<{ amount: number; alreadyRefunded?: boolean }>(
        'refund-purchase',
        { clubId, purchaseId }
      );
      toast.success(
        res.alreadyRefunded ? 'That purchase was already refunded' : `Refunded ${res.amount} chips`
      );
      onRedeemed();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      setRefunding(null);
    }
  };
  const [showHistory, setShowHistory] = useState(false);

  const handleRedeem = async (inventoryId: string) => {
    if (redeeming) return;
    if (
      !(await confirmDialog({
        title: 'Redeem item',
        message:
          'Mark this item as used/redeemed? This cannot be undone. Once redeemed, you can buy the item again from the Store.',
        confirmText: 'Redeem',
        variant: 'default',
      }))
    )
      return;
    setRedeeming(inventoryId);
    try {
      const { data, error } = await supabase.rpc('fn_redeem_shop_item', {
        p_inventory_id: inventoryId,
      });
      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || 'Redeem failed');
      }
      // fn_redeem_shop_item now grants a real entitlement and reports it back.
      const g = data?.granted as { type?: string; uses?: number; seconds?: number } | undefined;
      if (g?.type === 'time_bank' && g.seconds) {
        toast.success(`Redeemed — +${g.seconds}s of table time added`);
      } else if (g?.type === 'throwable' && g.uses) {
        toast.success(`Redeemed — ${g.uses} free throws added`);
      } else if (g?.type === 'emote_pack') {
        toast.success('Redeemed — emote pack unlocked');
      } else if (g?.type === 'table_skin') {
        toast.success('Redeemed — table theme unlocked');
      } else if (g?.type === 'avatar') {
        toast.success('Redeemed — avatar unlocked');
      } else {
        toast.success('Redeemed — your club will fulfil this perk');
      }
      onRedeemed();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Redeem failed');
      reportError(err, 'MyItemsTab.handleRedeem');
    } finally {
      setRedeeming(null);
    }
  };

  const ent = entitlements;
  const entitlementChips = ent.loaded
    ? [
        ent.timeBankSeconds > 0 ? `${ent.timeBankSeconds}s table time` : null,
        ent.throwables > 0 ? `${ent.throwables} throws` : null,
        ent.emotePack ? 'Emote pack' : null,
        ent.themeUnlock ? 'Table theme' : null,
        ent.avatars.length > 0
          ? `${ent.avatars.length} avatar${ent.avatars.length > 1 ? 's' : ''}`
          : null,
      ].filter(Boolean)
    : [];

  const entitlementStrip =
    entitlementChips.length > 0 ? (
      <div className={styles.entitlementStrip}>
        <span className={styles.entitlementLabel}>You currently hold:</span>
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
          <span className={styles.emptyIcon}>◇</span>
          <span className={styles.emptyText}>You have not purchased any items yet.</span>
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
                const refunded = it.status === 'refunded';
                const redeemed = spent;
                return (
                  <tr key={it.id}>
                    <td style={{ fontWeight: 700 }}>{it.item_name || 'Unknown Item'}</td>
                    <td>
                      <span className={styles.categorySmall}>{it.category || '-'}</span>
                    </td>
                    <td style={{ fontWeight: 800, color: '#f7c52a' }}>{fmtChips(it.price_paid)}</td>
                    <td style={{ fontSize: '12px', color: '#8b8d91' }}>
                      {timeAgo(it.acquired_at)}
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '8px',
                          color: redeemed ? '#8b8d91' : '#31A24C',
                          background: redeemed ? 'rgba(139,141,145,0.12)' : 'rgba(49,162,76,0.12)',
                        }}
                      >
                        {refunded ? 'Refunded' : redeemed ? 'Redeemed' : 'Owned'}
                      </span>
                    </td>
                    <td>
                      {!redeemed && (
                        <button
                          className={styles.emptyButton}
                          style={{ padding: '4px 12px', fontSize: '12px' }}
                          onClick={() => handleRedeem(it.id)}
                          disabled={redeeming !== null}
                        >
                          {redeeming === it.id ? '...' : 'Redeem'}
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
          <span className={styles.emptyText}>No items in your inventory right now.</span>
          <button className={styles.emptyButton} onClick={onGoStore}>
            Browse Store
          </button>
        </div>
      )}

      {/* Purchase history */}
      {purchases.length > 0 && (
        <div className={styles.historyBlock}>
          <button className={styles.historyToggle} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide' : 'Show'} purchase history ({purchases.length})
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
                      <td style={{ fontWeight: 600 }}>{p.item_name || 'Unknown Item'}</td>
                      <td>
                        <span className={styles.categorySmall}>{p.item_category || '-'}</span>
                      </td>
                      <td style={{ color: '#f7c52a', fontWeight: 700 }}>
                        {fmtChips(p.price_paid)}
                      </td>
                      <td style={{ fontSize: '12px', color: '#8b8d91' }}>
                        {timeAgo(p.created_at)}
                      </td>
                      {isAdmin && (
                        <td>
                          <button
                            className={styles.btnDeleteSmall}
                            onClick={() => handleRefund(p.id, p.item_name || 'this item')}
                            disabled={refunding !== null}
                          >
                            {refunding === p.id ? '...' : 'Refund'}
                          </button>
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
