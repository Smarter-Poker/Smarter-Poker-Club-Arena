/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMISSION HISTORY MODAL — Agent Earnings View
 * Shows rake earned, payouts, and timeline
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE CONSOLE (#ClubArenaConsole). This was a 16px rounded amber sheet with a
 * header bar, a 32px square close button, three boxed summary cards (one of
 * them a gradient "highlight"), two boxed month cards, a rounded green trend
 * pill, six rounded filter pills and one bordered card per commission row.
 * Every one of those drew a control the master already paints.
 *
 * It is now Dan's approved spade master: COMMISSION HISTORY is engraved in the
 * header well, the agent's name is the eyebrow, and every figure prints as a
 * ROW on the black glass - label in the master's lit blue on the left, the
 * figure in engraved silver on the right, an engraved rule between. The
 * filters are lit words; the close is a lit word on the flat cap, because a
 * surface with ONE action leaves the second painted plate empty.
 *
 * NOTHING IN THE DATA LAYER MOVED. The same `agent_commissions` read, the same
 * date window, the same summary arithmetic, the same stagger timers and the
 * same reportError call. This screen only reads: it moves no money, so its
 * figures are browsing figures and print through compactChips (Dan: "once
 * something hits over 1,000 use 1K").
 */

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import styles from './CommissionHistoryModal.module.css';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';
import { SpadeConsole } from '../console/SpadeConsole';

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

  const formatAmount = (amount: number, type: string) => {
    const sign = type === 'payout' ? '-' : '+';
    return `${sign}${compactChips(Math.abs(amount))}`;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const trendPercent =
    summary.thisMonth > summary.lastMonth
      ? Math.round(((summary.thisMonth - summary.lastMonth) / Math.max(summary.lastMonth, 1)) * 100)
      : null;

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <SpadeConsole
          as="div"
          eyebrow={agentName}
          title="Commission History"
          titleId="commission-history-title"
          foot="foot"
        >
          {/* Earnings, as rows on the glass. */}
          <div className={styles.rows}>
            <div className={styles.row}>
              <span className={`${styles.rowLabel} sc-label sc-ink--blue`}>Total Earned</span>
              <span className={`${styles.rowValue} sc-ink--silver`}>
                {compactChips(summary.totalEarned)}
              </span>
            </div>
            <div className={styles.row}>
              <span className={`${styles.rowLabel} sc-label sc-ink--blue`}>Total Paid Out</span>
              <span className={`${styles.rowValue} sc-ink--silver`}>
                {compactChips(summary.totalPaid)}
              </span>
            </div>
            {/* Pending is money owed and not yet moved: the master's held ink. */}
            <div className={styles.row}>
              <span className={`${styles.rowLabel} sc-label sc-ink--blue`}>Pending</span>
              <span className={`${styles.rowValue} sc-ink--gold`}>
                {compactChips(summary.pending)}
              </span>
            </div>
            <div className={styles.row}>
              <span className={`${styles.rowLabel} sc-label sc-ink--blue`}>This Month</span>
              <span className={`${styles.rowValue} sc-ink--silver`}>
                {compactChips(summary.thisMonth)}
              </span>
            </div>
            <div className={styles.row}>
              <span className={`${styles.rowLabel} sc-label sc-ink--blue`}>Last Month</span>
              <span className={`${styles.rowValue} sc-ink--silver`}>
                {compactChips(summary.lastMonth)}
              </span>
            </div>
            {trendPercent !== null && (
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-label sc-ink--blue`}>Month On Month</span>
                <span className={`${styles.rowValue} sc-ink--green`}>+{trendPercent}%</span>
              </div>
            )}
          </div>

          {/* Filters: lit words, never rounded pills. */}
          <div className={styles.filters}>
            <div className={styles.filterGroup} role="group" aria-label="Commission Type">
              <button
                type="button"
                className={`${styles.filterBtn} ${filter === 'all' ? styles.filterOn : ''}`}
                aria-pressed={filter === 'all'}
                onClick={() => setFilter('all')}
              >
                All
              </button>
              <button
                type="button"
                className={`${styles.filterBtn} ${filter === 'rake' ? styles.filterOn : ''}`}
                aria-pressed={filter === 'rake'}
                onClick={() => setFilter('rake')}
              >
                Rake
              </button>
              <button
                type="button"
                className={`${styles.filterBtn} ${filter === 'payout' ? styles.filterOn : ''}`}
                aria-pressed={filter === 'payout'}
                onClick={() => setFilter('payout')}
              >
                Payouts
              </button>
            </div>
            <div className={styles.filterGroup} role="group" aria-label="Date Range">
              <button
                type="button"
                className={`${styles.filterBtn} ${dateRange === 'week' ? styles.filterOn : ''}`}
                aria-pressed={dateRange === 'week'}
                onClick={() => setDateRange('week')}
              >
                Week
              </button>
              <button
                type="button"
                className={`${styles.filterBtn} ${dateRange === 'month' ? styles.filterOn : ''}`}
                aria-pressed={dateRange === 'month'}
                onClick={() => setDateRange('month')}
              >
                Month
              </button>
              <button
                type="button"
                className={`${styles.filterBtn} ${dateRange === 'all' ? styles.filterOn : ''}`}
                aria-pressed={dateRange === 'all'}
                onClick={() => setDateRange('all')}
              >
                All Time
              </button>
            </div>
          </div>

          {/* Every movement, one engraved row each. */}
          <div className={styles.entriesList}>
            {loading ? (
              <div className={`${styles.state} sc-copy sc-copy--center`}>Loading...</div>
            ) : filteredEntries.length === 0 ? (
              <div className={`${styles.state} sc-copy sc-copy--center`}>
                No Commission History Found
              </div>
            ) : (
              filteredEntries.map((entry, i) => (
                <div
                  key={entry.id}
                  className={styles.entry}
                  style={{
                    opacity: visibleEntries.has(i) ? 1 : 0,
                    transform: visibleEntries.has(i) ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span className={styles.entryDesc}>
                    {entry.description || (entry.type === 'rake' ? 'Rake Commission' : 'Payout')}
                  </span>
                  <span
                    className={`${styles.entryAmount} ${
                      entry.type === 'payout' ? 'sc-ink--red' : 'sc-ink--green'
                    }`}
                  >
                    {formatAmount(entry.amount, entry.type)}
                  </span>
                  <span className={styles.entryMeta}>
                    {entry.sourcePlayer && `From: ${entry.sourcePlayer}`}
                    {entry.sourceTable && ` ${entry.sourceTable}`}
                  </span>
                  <span className={styles.entryDate}>{formatDate(entry.date)}</span>
                </div>
              ))
            )}
          </div>

          {/* ONE action, so it is a lit word on the glass and the foot stays the
              flat closing cap: two painted plates with one of them empty reads
              as broken rather than spare. */}
          <div className={styles.close}>
            <button type="button" className={styles.closeWord} onClick={onClose}>
              Close
            </button>
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}
