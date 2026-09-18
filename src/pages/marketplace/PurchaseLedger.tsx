/**
 * MARKETPLACE : club-wide purchase ledger (owner/admin only).
 *
 * The refund endpoint always accepted any purchase in the club, but the only
 * control that called it lived in the buyer's OWN history table : so an admin
 * could only refund themselves, and the case refunds were built for (a member
 * bought the wrong item) was unreachable. This is that list.
 *
 * A redeemed item is shown but not refundable: the granted benefit (table time,
 * throw credits, an unlock) is already spent and cannot be taken back
 * automatically. The server enforces the same rule.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDebounce } from '../../hooks/useDebounce';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { fmt, timeAgo } from '../../utils/format';
import { formatPopupText } from '../../utils/popupStyle';
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

export default function PurchaseLedger({ clubId, userId }: { clubId: string; userId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  /* One request per pause in typing, not one per keystroke: every change to
     the search box used to refetch /api/club-arena/shop-purchases through the
     World Hub. 300 ms is the same window the roster and hand searches use. */
  const debouncedQuery = useDebounce(query, 300);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const refundingRef = useRef(false);
  const mountedRef = useRef(true);
  const activeOwnerRef = useRef({ userId, clubId });
  const loadAttemptRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const refundAttemptRef = useRef(0);
  const refundAbortRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    activeOwnerRef.current = { userId, clubId };
    loadAttemptRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    refundAttemptRef.current += 1;
    refundAbortRef.current?.abort();
    refundAbortRef.current = null;
    refundingRef.current = false;
    setRefunding(null);
    setRows([]);
    setTotal(0);
    setError(null);
    return () => {
      mountedRef.current = false;
      loadAttemptRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      refundAttemptRef.current += 1;
      refundAbortRef.current?.abort();
      refundAbortRef.current = null;
      refundingRef.current = false;
    };
  }, [clubId, userId]);

  const load = useCallback(async () => {
    if (!open || !userId) return;
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
    setLoading(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || session?.user?.id !== expectedUserId) {
        throw new Error('The Signed-In Player Changed Before This Request Started.');
      }
      const url =
        `/api/club-arena/shop-purchases?clubId=${encodeURIComponent(expectedClubId)}` +
        `&limit=${PAGE}&offset=${offset}` +
        (debouncedQuery.trim() ? `&q=${encodeURIComponent(debouncedQuery.trim())}` : '');
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({ success: false }));
      if (!data.success) throw new Error(data.error || 'Failed to load purchases');
      if (!isCurrent()) return;
      setRows(data.purchases || []);
      setTotal(data.total || 0);
    } catch (err: unknown) {
      if (!isCurrent() || (err instanceof Error && err.name === 'AbortError')) return;
      const msg = err instanceof Error ? err.message : 'Failed to load purchases';
      setError(msg);
      toast.error(msg);
    } finally {
      if (loadAbortRef.current === controller && loadAttemptRef.current === attemptId) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [clubId, offset, debouncedQuery, open, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const handleRefund = async (row: LedgerRow) => {
    if (refundingRef.current || !userId) return;
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
    refundingRef.current = true;
    setRefunding(row.id);
    if (
      !(await confirmDialog({
        title: 'Refund Purchase',
        message: `Refund ${fmt(row.pricePaid)} ${unitOf(row.currency)} To ${row.buyerName} For "${row.itemName}"? Their Copy Is Revoked And Any Limited Stock Goes Back.`,
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
        { clubId: expectedClubId, purchaseId: row.id },
        {
          idempotencyKey: `refund:${expectedClubId}:${row.id}`,
          expectedUserId,
          signal: controller.signal,
        }
      );
      if (!isCurrent()) return;
      toast.success(
        res.alreadyRefunded
          ? 'That Purchase Was Already Refunded'
          : `Refunded ${fmt(res.amount)} ${unitOf(res.currency || row.currency)} To ${row.buyerName}`
      );
      load();
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
          placeholder="Search Item Or Member"
          aria-label="Search Purchases By Item Or Member"
          className={styles.formInput}
        />
      </div>

      {loading && rows.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Loading Purchases</span>
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
                    <td data-label="Member" className={styles.dataItemName}>
                      {formatPopupText(r.buyerName)}
                    </td>
                    <td data-label="Item">{formatPopupText(r.itemName)}</td>
                    <td data-label="Paid" className={styles.dataValuePrice}>
                      {fmt(r.pricePaid)} {unitOf(r.currency)}
                    </td>
                    <td data-label="When" className={styles.dataValueMuted}>
                      {formatPopupText(timeAgo(r.createdAt))}
                    </td>
                    <td data-label="Status">
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
                    <td data-label="Actions">
                      {r.refundable ? (
                        <button
                          className={styles.btnDeleteSmall}
                          onClick={() => handleRefund(r)}
                          disabled={refunding !== null}
                          aria-label={`Refund ${formatPopupText(r.itemName)} For ${formatPopupText(r.buyerName)}`}
                        >
                          {refunding === r.id ? 'Refunding' : 'Refund'}
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
                          Unavailable
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
