/**
 * MARKETPLACE — My Items tab: delivered inventory (club_shop_inventory) with
 * redemption, plus full purchase history from club_shop_purchases.
 * Reads are RLS-scoped to the owner; redemption goes through fn_redeem_shop_item.
 */

import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { fmt, timeAgo } from '../../utils/format';
import { useMemo, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
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

  const handleRefund = async (purchaseId: string, itemName: string, currency?: string | null) => {
    if (refunding || !clubId) return;
    const unit = unitOf(currency);
    if (
      !(await confirmDialog({
        title: 'Refund Purchase',
        message: `Refund "${itemName}"? The ${unit} Go Back To The Buyer And The Copy Is Revoked. Items That Have Already Been Redeemed Cannot Be Refunded Automatically.`,
        confirmText: 'Refund',
        variant: 'danger',
      }))
    )
      return;
    setRefunding(purchaseId);
    try {
      const res = await callClubArenaApi<{
        amount: number;
        currency?: string;
        alreadyRefunded?: boolean;
      }>('refund-purchase', { clubId, purchaseId });
      toast.success(
        res.alreadyRefunded
          ? 'That Purchase Was Already Refunded'
          : `Refunded ${fmt(res.amount)} ${unitOf(res.currency || currency)}`
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
        title: 'Redeem Item',
        message:
          'Mark This Item As Used/Redeemed? This Cannot Be Undone. Once Redeemed, You Can Buy The Item Again From The Store.',
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
        toast.success(`Redeemed - +${g.seconds}s Of Table Time Added`);
      } else if (g?.type === 'throwable' && g.uses) {
        toast.success(`Redeemed - ${g.uses} Free Throws Added`);
      } else if (g?.type === 'emote_pack') {
        toast.success('Redeemed - Emote Pack Unlocked');
      } else if (g?.type === 'table_skin') {
        toast.success('Redeemed - Table Theme Unlocked');
      } else if (g?.type === 'avatar') {
        toast.success('Redeemed - Avatar Unlocked');
      } else {
        toast.success('Redeemed - Your Club Will Fulfil This Perk');
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
        ent.timeBankSeconds > 0 ? `${ent.timeBankSeconds}s Table Time` : null,
        ent.throwables > 0 ? `${ent.throwables} Throws` : null,
        ent.emotePack ? 'Emote Pack' : null,
        ent.themeUnlock ? 'Table Theme' : null,
        ent.avatars.length > 0
          ? `${ent.avatars.length} Avatar${ent.avatars.length > 1 ? 's' : ''}`
          : null,
      ].filter(Boolean)
    : [];

  // Inventory rows inherit their purchase's currency (legacy rows were chips).
  const currencyByPurchase = useMemo(() => {
    const m = new Map<string, string>();
    purchases.forEach((p) => m.set(p.id, p.currency || 'chips'));
    return m;
  }, [purchases]);

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
          <div className={styles.emptyArt}>
            <ItemArt category="Avatars" seed="empty-inventory" />
          </div>
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
                const refunded = it.status === 'refunded';
                const redeemed = spent;
                const rowUnit = unitOf(
                  it.purchase_id ? currencyByPurchase.get(it.purchase_id) : undefined
                );
                return (
                  <tr key={it.id}>
                    <td style={{ fontWeight: 700 }}>
                      <span className={styles.rowWithArt}>
                        <span className={styles.rowArt} aria-hidden="true">
                          <ItemArt category={it.category} seed={it.item_id || it.id} />
                        </span>
                        {it.item_name || 'Unknown Item'}
                      </span>
                    </td>
                    <td>
                      <span className={styles.categorySmall}>{it.category || '-'}</span>
                    </td>
                    <td style={{ fontWeight: 800, color: '#00d4ff' }}>
                      {fmt(it.price_paid)} {rowUnit}
                    </td>
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
                      <td style={{ fontWeight: 600 }}>{p.item_name || 'Unknown Item'}</td>
                      <td>
                        <span className={styles.categorySmall}>{p.item_category || '-'}</span>
                      </td>
                      <td style={{ color: '#00d4ff', fontWeight: 700 }}>
                        {fmt(p.price_paid)} {unitOf(p.currency)}
                      </td>
                      <td style={{ fontSize: '12px', color: '#8b8d91' }}>
                        {timeAgo(p.created_at)}
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: '8px',
                            color: p.refunded_at ? '#8b8d91' : '#31A24C',
                            background: p.refunded_at
                              ? 'rgba(139,141,145,0.12)'
                              : 'rgba(49,162,76,0.12)',
                          }}
                          title={p.refunded_at ? `Refunded ${timeAgo(p.refunded_at)}` : undefined}
                        >
                          {p.refunded_at ? 'Refunded' : 'Paid'}
                        </span>
                      </td>
                      {isAdmin && (
                        <td>
                          {/* A refunded purchase cannot be refunded again — the
                              server answers "already refunded". Say so here
                              instead of offering the action. */}
                          {p.refunded_at ? (
                            <span style={{ fontSize: '11px', color: '#8b8d91' }}>-</span>
                          ) : (
                            <button
                              className={styles.btnDeleteSmall}
                              onClick={() =>
                                handleRefund(p.id, p.item_name || 'This Item', p.currency)
                              }
                              disabled={refunding !== null}
                            >
                              {refunding === p.id ? '...' : 'Refund'}
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
