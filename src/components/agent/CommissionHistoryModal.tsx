/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMISSION HISTORY MODAL — Agent Earnings View
 * Shows rake earned, payouts, and timeline
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import styles from './CommissionHistoryModal.module.css';
import { reportError } from '../../utils/errorReporter';
import { formatChips } from '../../utils/format';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface CommissionEntry {
  id: string;
  date: string;
  type: 'rake' | 'payout' | 'adjustment';
  amount: number;
  description: string;
  sourcePlayer?: string;
  sourceTable?: string;
}

interface CommissionSummary {
  totalEarned: number;
  totalPaid: number;
  pending: number;
  thisMonth: number;
  lastMonth: number;
}

interface CommissionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function CommissionHistoryModal({
  isOpen,
  onClose,
  agentId,
  agentName,
}: CommissionHistoryModalProps) {
  const [entries, setEntries] = useState<CommissionEntry[]>([]);
  const [summary, setSummary] = useState<CommissionSummary>({
    totalEarned: 0,
    totalPaid: 0,
    pending: 0,
    thisMonth: 0,
    lastMonth: 0,
  });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'rake' | 'payout'>('all');
  const [dateRange, setDateRange] = useState<'week' | 'month' | 'all'>('month');
  const [visibleEntries, setVisibleEntries] = useState<Set<number>>(new Set());

  useEffect(() => {
    const timers = entries.map((_, i) =>
      setTimeout(() => setVisibleEntries((prev) => new Set(prev).add(i)), i * 50)
    );
    return () => timers.forEach(clearTimeout);
  }, [entries.length]);

  useEffect(() => {
    if (isOpen && agentId) {
      loadCommissions();
    }
  }, [isOpen, agentId, dateRange]);

  const loadCommissions = async () => {
    setLoading(true);
    try {
      // Build date filter
      let dateFilter = '';
      const now = new Date();
      if (dateRange === 'week') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        dateFilter = weekAgo.toISOString();
      } else if (dateRange === 'month') {
        const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
        dateFilter = monthAgo.toISOString();
      }

      // Fetch commission entries
      // agent_commissions schema: id, club_id, user_id, amount, commission_rate, source_type, source_id, notes, created_at
      let query = supabase
        .from('agent_commissions')
        .select('id, created_at, source_type, amount, notes')
        .eq('user_id', agentId)
        .order('created_at', { ascending: false });

      if (dateFilter) {
        query = query.gte('created_at', dateFilter);
      }

      const { data, error } = await query;

      if (!error && data) {
        setEntries(
          data.map((e: any) => ({
            id: e.id,
            date: e.created_at,
            type: e.source_type || 'rake',
            amount: e.amount,
            description: e.notes || '',
            sourcePlayer: undefined,
            sourceTable: undefined,
          }))
        );

        // Calculate summary
        const totalEarned = data
          .filter((e: any) => (e.source_type || 'rake') === 'rake')
          .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
        const totalPaid = data
          .filter((e: any) => (e.source_type || 'rake') === 'payout')
          .reduce((sum: number, e: any) => sum + Math.abs(e.amount || 0), 0);

        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

        const thisMonth = data
          .filter(
            (e: any) =>
              new Date(e.created_at) >= thisMonthStart && (e.source_type || 'rake') === 'rake'
          )
          .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);

        const lastMonth = data
          .filter(
            (e: any) =>
              new Date(e.created_at) >= lastMonthStart &&
              new Date(e.created_at) < thisMonthStart &&
              (e.source_type || 'rake') === 'rake'
          )
          .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);

        setSummary({
          totalEarned,
          totalPaid,
          pending: totalEarned - totalPaid,
          thisMonth,
          lastMonth,
        });
      }
    } catch (err) {
      reportError(err, 'CommissionHistoryModal.Failed_to_load_commissions');
    }
    setLoading(false);
  };

  const filteredEntries = filter === 'all' ? entries : entries.filter((e) => e.type === filter);

  // A payout leaves the wallet, everything else arrives. Two places always:
  // a bare toLocaleString() gave Intl's default of three, so 12.3456 read
  // "12.346" and 12.5 read "12.5" with the cent column missing.
  const formatAmount = (amount: number, type: string) => {
    const sign = type === 'payout' ? '-' : '+';
    return `${sign}${formatChips(Math.abs(amount))}`;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <h2> Commission History</h2>
          <span className={styles.agentName}>{agentName}</span>
          <button className={styles.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Summary Cards */}
        <div className={styles.summary}>
          <div className={styles.summaryCard}>
            <span className={styles.summaryValue}>{formatChips(summary.totalEarned)}</span>
            <span className={styles.summaryLabel}>Total Earned</span>
          </div>
          <div className={styles.summaryCard}>
            <span className={styles.summaryValue}>{formatChips(summary.totalPaid)}</span>
            <span className={styles.summaryLabel}>Total Paid Out</span>
          </div>
          <div className={`${styles.summaryCard} ${styles.highlight}`}>
            <span className={styles.summaryValue}>{formatChips(summary.pending)}</span>
            <span className={styles.summaryLabel}>Pending</span>
          </div>
        </div>

        {/* Month Comparison */}
        <div className={styles.comparison}>
          <div className={styles.compCard}>
            <span className={styles.compLabel}>This Month</span>
            <span className={styles.compValue}>{formatChips(summary.thisMonth)}</span>
          </div>
          <div className={styles.compCard}>
            <span className={styles.compLabel}>Last Month</span>
            <span className={styles.compValue}>{formatChips(summary.lastMonth)}</span>
          </div>
          {summary.thisMonth > summary.lastMonth && (
            <span className={styles.trend}>
              {' '}
              +
              {Math.round(
                ((summary.thisMonth - summary.lastMonth) / Math.max(summary.lastMonth, 1)) * 100
              )}
              %
            </span>
          )}
        </div>

        {/* Filters */}
        <div className={styles.filters}>
          <div className={styles.filterGroup}>
            <button
              className={`${styles.filterBtn} ${filter === 'all' ? styles.active : ''}`}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            <button
              className={`${styles.filterBtn} ${filter === 'rake' ? styles.active : ''}`}
              onClick={() => setFilter('rake')}
            >
              Rake
            </button>
            <button
              className={`${styles.filterBtn} ${filter === 'payout' ? styles.active : ''}`}
              onClick={() => setFilter('payout')}
            >
              Payouts
            </button>
          </div>
          <div className={styles.filterGroup}>
            <button
              className={`${styles.filterBtn} ${dateRange === 'week' ? styles.active : ''}`}
              onClick={() => setDateRange('week')}
            >
              Week
            </button>
            <button
              className={`${styles.filterBtn} ${dateRange === 'month' ? styles.active : ''}`}
              onClick={() => setDateRange('month')}
            >
              Month
            </button>
            <button
              className={`${styles.filterBtn} ${dateRange === 'all' ? styles.active : ''}`}
              onClick={() => setDateRange('all')}
            >
              All Time
            </button>
          </div>
        </div>

        {/* Entries List */}
        <div className={styles.entriesList}>
          {loading ? (
            <div className={styles.loading}>Loading...</div>
          ) : filteredEntries.length === 0 ? (
            <div className={styles.empty}>No Commission History Found</div>
          ) : (
            filteredEntries.map((entry, i) => (
              <div
                key={entry.id}
                className={styles.entryCard}
                style={{
                  opacity: visibleEntries.has(i) ? 1 : 0,
                  transform: visibleEntries.has(i) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className={styles.entryIcon}>{entry.type === 'rake' ? '' : ''}</div>
                <div className={styles.entryInfo}>
                  <span className={styles.entryDesc}>
                    {entry.description || (entry.type === 'rake' ? 'Rake Commission' : 'Payout')}
                  </span>
                  <span className={styles.entryMeta}>
                    {entry.sourcePlayer && `From: ${entry.sourcePlayer}`}
                    {entry.sourceTable && ` • ${entry.sourceTable}`}
                  </span>
                </div>
                <div className={styles.entryRight}>
                  <span className={`${styles.entryAmount} ${styles[entry.type]}`}>
                    {formatAmount(entry.amount, entry.type)}
                  </span>
                  <span className={styles.entryDate}>{formatDate(entry.date)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
