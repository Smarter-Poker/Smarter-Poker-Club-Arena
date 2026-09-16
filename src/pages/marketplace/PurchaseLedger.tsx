/**
 * MARKETPLACE — club-wide purchase ledger (owner/admin only).
 *
 * The refund endpoint always accepted any purchase in the club, but the only
 * control that called it lived in the buyer's OWN history table — so an admin
 * could only refund themselves, and the case refunds were built for (a member
 * bought the wrong item) was unreachable. This is that list.
 *
 * A redeemed item is shown but not refundable: the granted benefit (table time,
 * throw credits, an unlock) is already spent and cannot be taken back
 * automatically. The server enforces the same rule.
 */

import { useCallback, useEffect, useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { fmt, timeAgo } from '../../utils/format';
import styles from '../MarketplacePage.module.css';

interface LedgerRow {
  id: string;
  itemName: string;
  category: string | null;
  buyerId: string;
  buyerName: string;
  pricePaid: number;
  /** 'diamonds' for post-2026-08-23 purchases, 'chips' for legacy rows */
  currency?: 'chips' | 'diamonds';
  createdAt: string;
  refundedAt: string | null;
  status: 'owned' | 'redeemed' | 'refunded' | 'not_delivered';
  refundable: boolean;
}

const unitOf = (currency?: string | null) => (currency === 'chips' ? 'Chips' : 'Diamonds');

const PAGE = 25;

export default function PurchaseLedger({ clubId }: { clubId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not authenticated');
      const url =
        `/api/club-arena/shop-purchases?clubId=${encodeURIComponent(clubId)}` +
        `&limit=${PAGE}&offset=${offset}` +
        (query.trim() ? `&q=${encodeURIComponent(query.trim())}` : '');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({ success: false }));
      if (!data.success) throw new Error(data.error || 'Failed to load purchases');
      setRows(data.purchases || []);
      setTotal(data.total || 0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load purchases';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [clubId, offset, query, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const handleRefund = async (row: LedgerRow) => {
    if (refunding) return;
    if (
      !(await confirmDialog({
        title: 'Refund Purchase',
        message: `Refund ${fmt(row.pricePaid)} ${unitOf(row.currency)} To ${row.buyerName} For "${row.itemName}"? Their Copy Is Revoked And Any Limited Stock Goes Back.`,
        confirmText: 'Refund',
        variant: 'danger',
      }))
    )
      return;
    setRefunding(row.id);
    try {
      const res = await callClubArenaApi<{
        amount: number;
        currency?: string;
        alreadyRefunded?: boolean;
      }>('refund-purchase', { clubId, purchaseId: row.id });
      toast.success(
        res.alreadyRefunded
          ? 'That Purchase Was Already Refunded'
          : `Refunded ${fmt(res.amount)} ${unitOf(res.currency || row.currency)} To ${row.buyerName}`
      );
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      setRefunding(null);
    }
  };

  if (!open) {
    return (
      <div className={styles.analyticsBlock}>
        <button className={styles.historyToggle} onClick={() => setOpen(true)}>
          Purchase Ledger &amp; Refunds
        </button>
      </div>
    );
  }

  return (
    <div className={styles.analyticsBlock}>
      <div className={styles.analyticsHeader}>
        <h3 className={styles.createTitle}>Purchase Ledger</h3>
        <button className={styles.btnGhost} onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>

      <div className={styles.formRow}>
        <input
          value={query}
          onChange={(e) => {
            setOffset(0);
            setQuery(e.target.value);
          }}
          placeholder="Search Item Or Member..."
          aria-label="Search Purchases By Item Or Member"
          className={styles.formInput}
        />
      </div>

      {loading && rows.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Loading Purchases...</span>
        </div>
      ) : error && rows.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Could Not Load Purchases.</span>
          <button className={styles.emptyButton} onClick={load}>
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>
            {query.trim() ? 'No Purchases Match That Search.' : 'No Purchases Yet.'}
          </span>
        </div>
      ) : (
        <>
          <div className={styles.tableScroll}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Item</th>
                  <th>Paid</th>
                  <th>When</th>
                  <th>Status</th>
                  <th>
                    <span className={styles.srOnly}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.buyerName}</td>
                    <td>{r.itemName}</td>
                    <td style={{ color: '#00d4ff', fontWeight: 700 }}>
                      {fmt(r.pricePaid)} {unitOf(r.currency)}
                    </td>
                    <td style={{ fontSize: '12px', color: '#8b8d91' }}>{timeAgo(r.createdAt)}</td>
                    <td>
                      <span className={styles.categorySmall}>
                        {r.status === 'refunded'
                          ? 'Refunded'
                          : r.status === 'redeemed'
                            ? 'Redeemed'
                            : r.status === 'not_delivered'
                              ? 'Not Delivered'
                              : 'Owned'}
                      </span>
                    </td>
                    <td>
                      {r.refundable ? (
                        <button
                          className={styles.btnDeleteSmall}
                          onClick={() => handleRefund(r)}
                          disabled={refunding !== null}
                        >
                          {refunding === r.id ? '...' : 'Refund'}
                        </button>
                      ) : (
                        <span
                          className={styles.grantHint}
                          title={
                            r.status === 'redeemed'
                              ? 'Already Used - The Granted Benefit Cannot Be Taken Back Automatically'
                              : r.status === 'refunded'
                                ? 'Already Refunded'
                                : 'No Delivered Copy To Revoke'
                          }
                        >
                          -
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.crossSell}>
            <button
              className={styles.inlineLink}
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </button>
            <span>
              {offset + 1}-{offset + rows.length} Of {total}
            </span>
            <button
              className={styles.inlineLink}
              disabled={offset + PAGE >= total || loading}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
