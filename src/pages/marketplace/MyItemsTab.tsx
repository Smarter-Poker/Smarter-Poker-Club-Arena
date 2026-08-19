/**
 * MARKETPLACE — My Items tab: delivered inventory (club_shop_inventory) + redemption.
 * Reads are RLS-scoped to the owner; redemption goes through fn_redeem_shop_item.
 */

import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { fmtChips, timeAgo } from '../../utils/format';
import { useState } from 'react';
import styles from '../MarketplacePage.module.css';
import type { InventoryRow } from './marketplaceShared';

interface MyItemsTabProps {
  inventory: InventoryRow[];
  onGoStore: () => void;
  onRedeemed: () => void;
}

export default function MyItemsTab({ inventory, onGoStore, onRedeemed }: MyItemsTabProps) {
  const toast = useToast();
  const [redeeming, setRedeeming] = useState<string | null>(null);

  const handleRedeem = async (inventoryId: string) => {
    if (redeeming) return;
    if (
      !(await confirmDialog({
        title: 'Redeem item',
        message: 'Mark this item as used/redeemed? This cannot be undone.',
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
      toast.success('Item redeemed');
      onRedeemed();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Redeem failed');
      reportError(err, 'MyItemsTab.handleRedeem');
    } finally {
      setRedeeming(null);
    }
  };

  if (inventory.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon}>◇</span>
        <span className={styles.emptyText}>You have not purchased any items yet.</span>
        <button className={styles.emptyButton} onClick={onGoStore}>
          Browse Store
        </button>
      </div>
    );
  }

  return (
    <div className={styles.tableScroll}>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th>Price Paid</th>
            <th>Acquired</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {inventory.map((it) => {
            const redeemed = it.status === 'redeemed';
            return (
              <tr key={it.id}>
                <td style={{ fontWeight: 700 }}>{it.item_name || 'Unknown Item'}</td>
                <td>
                  <span className={styles.categorySmall}>{it.category || '-'}</span>
                </td>
                <td style={{ fontWeight: 800, color: '#f7c52a' }}>{fmtChips(it.price_paid)}</td>
                <td style={{ fontSize: '12px', color: '#8b8d91' }}>{timeAgo(it.acquired_at)}</td>
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
                    {redeemed ? 'Redeemed' : 'Owned'}
                  </span>
                </td>
                <td>
                  {!redeemed && (
                    <button
                      className={styles.emptyButton}
                      style={{ padding: '4px 12px', fontSize: '12px' }}
                      onClick={() => handleRedeem(it.id)}
                      disabled={redeeming === it.id}
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
  );
}
