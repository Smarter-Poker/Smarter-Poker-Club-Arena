/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DISTRIBUTION HISTORY — Full audit log of agent chip distributions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows all distributions made by the current agent in the club with:
 * - Date range filters (7d, 30d, 90d, all)
 * - Clawback status indicators
 * - Per-player grouping and totals
 */

import { useState, useEffect, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './DistributionHistory.css';
import { reportError } from '../../utils/errorReporter';

interface DistributionHistoryProps {
  userId: string;
  clubId: string;
}

interface DistributionRecord {
  id: string;
  to_user_id: string;
  amount: number;
  created_at: string;
  transaction_type: string;
  notes: string | null;
  clawed_back: boolean;
  recipientName?: string;
}

type DateRange = '7d' | '30d' | '90d' | 'all';

export default function DistributionHistory({ userId, clubId }: DistributionHistoryProps) {
  const [records, setRecords] = useState<DistributionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [searchTerm, setSearchTerm] = useState('');
  const isMounted = useIsMounted();

  const loadHistory = useCallback(async () => {
    if (!userId || !clubId) return;
    setLoading(true);

    try {
      const resolvedClub = await resolveClubUUID(clubId);

      let query = supabase
        .from('chip_transactions')
        .select('id, to_user_id, amount, created_at, transaction_type, notes, clawed_back')
        .eq('from_user_id', userId)
        .eq('club_id', resolvedClub)
        .in('transaction_type', ['agent_to_player', 'promo_agent_to_player', 'send'])
        .order('created_at', { ascending: false })
        .limit(200);

      // Apply date range filter
      if (dateRange !== 'all') {
        const days = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        query = query.gte('created_at', cutoff);
      }

      const { data, error } = await query;
      if (error) throw error;

      // Fetch recipient display names
      const toIds = [...new Set((data || []).map((r) => r.to_user_id))];
      const { data: profiles } =
        toIds.length > 0
          ? await supabase.from('profiles').select('id, display_name, username').in('id', toIds)
          : { data: [] };

      const nameMap = new Map(
        (profiles || []).map((p) => [p.id, p.display_name || p.username || 'Unknown'])
      );

      const enriched = (data || []).map((r) => ({
        ...r,
        recipientName: nameMap.get(r.to_user_id) || 'Unknown',
      }));

      if (isMounted.current) setRecords(enriched);
    } catch (err) {
      reportError(err, 'DistributionHistory.Error');
      if (isMounted.current) setRecords([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [userId, clubId, dateRange]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Bus listeners
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', () => loadHistory(), 500),
      masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadHistory(), 1000),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadHistory]);

  // Computed stats
  const filtered = searchTerm
    ? records.filter((r) => r.recipientName?.toLowerCase().includes(searchTerm.toLowerCase()))
    : records;

  const totalDistributed = filtered.reduce((s, r) => s + r.amount, 0);
  const totalClawedBack = filtered.filter((r) => r.clawed_back).reduce((s, r) => s + r.amount, 0);
  const uniqueRecipients = new Set(filtered.map((r) => r.to_user_id)).size;

  return (
    <div className="dh-container">
      <div className="dh-header">
        <h3 className="dh-title">Distribution History</h3>
        <div className="dh-filters">
          {(['7d', '30d', '90d', 'all'] as DateRange[]).map((range) => (
            <button
              key={range}
              className={`dh-range-btn ${dateRange === range ? 'dh-range-active' : ''}`}
              onClick={() => setDateRange(range)}
            >
              {range === 'all' ? 'All' : range}
            </button>
          ))}
        </div>
      </div>

      {/* Stats summary */}
      <div className="dh-stats">
        <div className="dh-stat">
          <span className="dh-stat-label">Total</span>
          <span className="dh-stat-value">{totalDistributed.toLocaleString()}</span>
        </div>
        <div className="dh-stat">
          <span className="dh-stat-label">Clawed Back</span>
          <span className="dh-stat-value dh-negative">{totalClawedBack.toLocaleString()}</span>
        </div>
        <div className="dh-stat">
          <span className="dh-stat-label">Net Out</span>
          <span className="dh-stat-value dh-positive">
            {(totalDistributed - totalClawedBack).toLocaleString()}
          </span>
        </div>
        <div className="dh-stat">
          <span className="dh-stat-label">Recipients</span>
          <span className="dh-stat-value">{uniqueRecipients}</span>
        </div>
      </div>

      {/* Search */}
      <input
        type="text"
        className="dh-search"
        placeholder="Search By Player Name..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />

      {/* Transaction list */}
      {loading ? (
        <div className="dh-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="dh-skeleton" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="dh-empty">No Distributions Found For This Period</div>
      ) : (
        <div className="dh-list">
          {filtered.map((r) => {
            const dateStr = new Date(r.created_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            });
            return (
              <div key={r.id} className={`dh-row ${r.clawed_back ? 'dh-row-clawedback' : ''}`}>
                <div className="dh-row-info">
                  <span className="dh-row-name">{r.recipientName}</span>
                  <span className="dh-row-date">{dateStr}</span>
                </div>
                <div className="dh-row-right">
                  <span className={`dh-row-amount ${r.clawed_back ? 'dh-strikethrough' : ''}`}>
                    {r.amount.toLocaleString()}
                  </span>
                  {r.clawed_back && <span className="dh-clawback-badge">↩ Clawed Back</span>}
                  {r.transaction_type === 'promo_agent_to_player' && (
                    <span className="dh-promo-badge">Promo</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
