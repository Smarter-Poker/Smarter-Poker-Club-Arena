/**
 * MARKETPLACE : sales analytics for club owners/admins.
 *
 * The Manage tab could only show lifetime totals, so an owner had no way to
 * tell whether the shop was working, what sold, or whether a promo did
 * anything. Burn totals come from /api/club-arena/shop-analytics, which sums
 * price_paid rather than the item's current price : an admin editing a price
 * must not rewrite history.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../components/common/Toast';
import { fmt } from '../../utils/format';
import { formatPopupText } from '../../utils/popupStyle';
import styles from '../MarketplacePage.module.css';

interface DayPoint {
  date: string;
  sales: number;
  revenue: number;
}
interface ItemRow {
  itemId: string;
  name: string;
  category: string | null;
  sales: number;
  revenue: number;
}
interface BuyerRow {
  userId: string;
  name?: string;
  purchases: number;
  spent: number;
}
interface Analytics {
  days: number;
  truncated?: boolean;
  totals: {
    sales: number;
    grossRevenue: number;
    refundedAmount: number;
    netRevenue: number;
    uniqueBuyers: number;
    averageSale: number;
  };
  series: DayPoint[];
  topItems: ItemRow[];
  topBuyers: BuyerRow[];
}

const RANGES = [7, 30, 90];

export default function ShopAnalytics({ clubId }: { clubId: string }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not authenticated');
      const res = await fetch(
        `/api/club-arena/shop-analytics?clubId=${encodeURIComponent(clubId)}&days=${days}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await res.json().catch(() => ({ success: false }));
      if (!json.success) throw new Error(json.error || 'Failed to load analytics');
      setData(json);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load analytics';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [clubId, days]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const peak = data ? Math.max(1, ...data.series.map((d) => d.revenue)) : 1;

  return (
    <div className={styles.analyticsBlock}>
      <div className={styles.analyticsHeader}>
        <h3 className={styles.createTitle}>Sales</h3>
        <div className={styles.rangeTabs} role="group" aria-label="Analytics Date Range">
          {RANGES.map((d) => (
            <button
              key={d}
              className={`${styles.rangeBtn} ${days === d ? styles.rangeBtnActive : ''}`}
              onClick={() => setDays(d)}
              aria-pressed={days === d}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Loading Sales</span>
        </div>
      ) : error && !data ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Could Not Load Sales.</span>
          <button className={styles.emptyButton} onClick={load}>
            Retry
          </button>
        </div>
      ) : data ? (
        <>
          <div className={styles.statsRow}>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{fmt(data.totals.sales)}</span>
              <span className={styles.statLabel}>Sales</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{fmt(data.totals.netRevenue)}</span>
              <span className={styles.statLabel}>Net Diamonds Burned</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{fmt(data.totals.uniqueBuyers)}</span>
              <span className={styles.statLabel}>Buyers</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{fmt(data.totals.averageSale)}</span>
              <span className={styles.statLabel}>Avg Sale</span>
            </div>
          </div>

          {data.totals.refundedAmount > 0 && (
            <div className={styles.grantHint}>
              Gross {fmt(data.totals.grossRevenue)} Less {fmt(data.totals.refundedAmount)} Refunded.
            </div>
          )}

          {data.totals.sales === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyText}>No Sales In The Last {data.days} Days.</span>
              <span className={styles.emptySubText}>
                Try A Sale Price, Or A Limited Drop To Create Urgency.
              </span>
            </div>
          ) : (
            <>
              {/* Pure-CSS bar chart: no chart library in this bundle. */}
              <div
                className={styles.chart}
                role="list"
                aria-label={`Daily Diamond Burns Over ${data.days} Days`}
              >
                {data.series.map((d) => (
                  <div
                    key={d.date}
                    className={styles.chartBar}
                    style={{ height: `${Math.round((d.revenue / peak) * 100)}%` }}
                    title={`${d.date}: ${d.sales} Sale(s), ${d.revenue} Diamonds`}
                    role="listitem"
                    aria-label={`${d.date}: ${d.sales} Sales, ${d.revenue} Diamonds Burned`}
                  />
                ))}
              </div>

              <div className={styles.tableScroll}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>Top Items</th>
                      <th>Sold</th>
                      <th>Diamonds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topItems.map((i) => (
                      <tr key={i.itemId}>
                        <td data-label="Top Items" className={styles.dataItemName}>
                          {formatPopupText(i.name)}
                        </td>
                        <td data-label="Sold">{fmt(i.sales)}</td>
                        <td data-label="Diamonds" className={styles.dataValuePrice}>
                          {fmt(i.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {data.topBuyers.length > 0 && (
                <div className={styles.tableScroll}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th>Top Buyers</th>
                        <th>Purchases</th>
                        <th>Diamonds</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topBuyers.map((b) => (
                        <tr key={b.userId}>
                          <td data-label="Top Buyers" className={styles.dataItemName}>
                            {formatPopupText(b.name || 'Member')}
                          </td>
                          <td data-label="Purchases">{fmt(b.purchases)}</td>
                          <td data-label="Diamonds" className={styles.dataValuePrice}>
                            {fmt(b.spent)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
