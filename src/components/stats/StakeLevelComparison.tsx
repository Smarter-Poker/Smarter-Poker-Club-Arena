/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STAKE LEVEL COMPARISON — Compare stats across different stakes
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Groups session_history by big_blind and shows comparative metrics:
 * win rate, avg session P/L, VPIP, PFR, total hands, total profit.
 *
 * Improvements:
 *  - Exponential backoff retry on transient fetch failures
 *  - SWR cache: show cached data instantly, refresh in background
 *  - Supabase Realtime subscription for cross-tab sync
 *  - CSV data export
 *  - Enhanced empty state
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { retryFetch } from '../../utils/retryFetch';
import StatsExportButton from './StatsExportButton';
import './StakeLevelComparison.css';
import { reportError } from '../../utils/errorReporter';

interface StakeLevelComparisonProps {
  userId: string;
}

interface SessionRecord {
  big_blind: number;
  profit_loss: number;
  hands_played: number;
  hands_won: number;
  vpip_percent: number;
  pfr_percent: number;
  bb_won: number;
  duration_minutes: number;
}

interface StakeGroup {
  label: string;
  bigBlind: number;
  sessions: number;
  totalHands: number;
  totalProfit: number;
  avgVPIP: number;
  avgPFR: number;
  winRate: number;
  bbPer100: number;
  avgDuration: number;
}

// ── SWR Cache helpers ──
const CACHE_PREFIX = 'slc_cache_';
function getCached(userId: string): SessionRecord[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + userId);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    reportError(err, 'StakeLevelComparison.Error');
    return null;
  }
}
function setCache(userId: string, data: SessionRecord[]) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + userId, JSON.stringify(data));
  } catch (err) {
    reportError(err, 'StakeLevelComparison.Error');
    /* quota exceeded */
  }
}

export default function StakeLevelComparison({ userId }: StakeLevelComparisonProps) {
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const hasDataRef = useRef(false);

  // SWR: show cached data instantly
  useEffect(() => {
    if (!userId) return;
    const cached = getCached(userId);
    if (cached && cached.length > 0) {
      setRecords(cached);
      hasDataRef.current = true;
      setLoading(false);
    }
  }, [userId]);

  const loadRecords = useCallback(async () => {
    if (!userId) return;
    // Only show full loading state if we have no cached/existing data
    if (!hasDataRef.current) setLoading(true);

    try {
      const { data, error } = await retryFetch(
        () =>
          supabase
            .from('session_history')
            .select(
              'big_blind, profit_loss, hands_played, hands_won, vpip_percent, pfr_percent, bb_won, duration_minutes'
            )
            .eq('user_id', userId)
            .order('big_blind', { ascending: true })
            .limit(500),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (error) {
        console.warn('[StakeLevelComparison] Fetch error:', error.message);
        if (isMounted.current) setRecords([]);
      } else {
        const fetched = data || [];
        if (isMounted.current) {
          setRecords(fetched);
          hasDataRef.current = fetched.length > 0;
          setCache(userId, fetched);
        }
      }
    } catch (err) {
      reportError(err, 'StakeLevelComparison.Error');
      if (isMounted.current) setRecords([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    loadRecords();
  }, [userId, loadRecords]);

  // Bus listeners for live updates
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('HAND_COMPLETED', () => loadRecords(), 2000),
      masterBus.subscribeDebounced('SESSION_ENDED', () => loadRecords(), 1000),
      masterBus.subscribeDebounced('DATA_MUTATED', () => loadRecords(), 3000),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadRecords]);

  // Supabase Realtime subscription for cross-tab sync
  useEffect(() => {
    if (!userId) return;
    const channelKey = `slc_realtime_${userId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'session_history', filter: `user_id=eq.${userId}` },
        () => loadRecords()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'StakeLevelComparison._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[StakeLevelComparison] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [userId, loadRecords]);

  const groups = useMemo<StakeGroup[]>(() => {
    if (records.length === 0) return [];

    const map = new Map<number, SessionRecord[]>();
    records.forEach((r) => {
      const existing = map.get(r.big_blind) || [];
      existing.push(r);
      map.set(r.big_blind, existing);
    });

    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([bb, recs]) => {
        const totalHands = recs.reduce((s, r) => s + r.hands_played, 0);
        const totalWon = recs.reduce((s, r) => s + r.hands_won, 0);
        const totalProfit = recs.reduce((s, r) => s + r.profit_loss, 0);
        const totalBBWon = recs.reduce((s, r) => s + r.bb_won, 0);
        const avgVPIP = recs.reduce((s, r) => s + r.vpip_percent, 0) / recs.length;
        const avgPFR = recs.reduce((s, r) => s + r.pfr_percent, 0) / recs.length;
        const avgDuration = recs.reduce((s, r) => s + r.duration_minutes, 0) / recs.length;

        return {
          label: `$${(bb / 2).toFixed(2)}/$${bb.toFixed(2)}`,
          bigBlind: bb,
          sessions: recs.length,
          totalHands,
          totalProfit,
          avgVPIP: Math.round(avgVPIP),
          avgPFR: Math.round(avgPFR),
          winRate: totalHands > 0 ? Math.round((totalWon / totalHands) * 100) : 0,
          bbPer100: totalHands > 0 ? parseFloat(((totalBBWon / totalHands) * 100).toFixed(1)) : 0,
          avgDuration: Math.round(avgDuration),
        };
      });
  }, [records]);

  // Find the best performing stake
  const bestStake = useMemo(() => {
    if (groups.length === 0) return null;
    return groups.reduce((best, g) => (g.bbPer100 > best.bbPer100 ? g : best), groups[0]);
  }, [groups]);

  // CSV export data
  const exportHeaders = [
    'Stakes',
    'Sessions',
    'Hands',
    'P/L',
    'BB/100',
    'VPIP%',
    'PFR%',
    'Avg Dur (min)',
  ];
  const exportRows = useMemo(
    () =>
      groups.map((g) => [
        g.label,
        g.sessions,
        g.totalHands,
        g.totalProfit,
        g.bbPer100,
        g.avgVPIP,
        g.avgPFR,
        g.avgDuration,
      ]),
    [groups]
  );

  if (loading) {
    return (
      <div className="slc-widget">
        <h3 className="slc-title">Stake Level Comparison</h3>
        <div className="slc-loading">
          <div className="slc-skeleton" />
          <div className="slc-skeleton" />
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="slc-widget">
        <h3 className="slc-title">Stake Level Comparison</h3>
        <div className="slc-empty">
          <div className="slc-empty-icon">--</div>
          <div className="slc-empty-title">No Stake Data Yet</div>
          <div className="slc-empty-desc">
            Play Sessions At Different Stakes To Compare Your Performance Across Varying Levels.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="slc-widget">
      <div className="slc-header-row">
        <h3 className="slc-title">Stake Level Comparison</h3>
        <StatsExportButton
          headers={exportHeaders}
          rows={exportRows}
          filename="stake-comparison"
          label="CSV"
        />
      </div>

      {bestStake && groups.length > 1 && (
        <div className="slc-best-badge">
          Best: <strong>{bestStake.label}</strong> ({bestStake.bbPer100 >= 0 ? '+' : ''}
          {bestStake.bbPer100} BB/100)
        </div>
      )}

      {/* Table */}
      <div className="slc-table-wrap">
        <div className="slc-table-header">
          <span>Stakes</span>
          <span>Sessions</span>
          <span>Hands</span>
          <span>P/L</span>
          <span>BB/100</span>
          <span>VPIP</span>
          <span>PFR</span>
        </div>

        {groups.map((g) => {
          const plClass = g.totalProfit >= 0 ? 'slc-positive' : 'slc-negative';
          const isBest = bestStake && g.bigBlind === bestStake.bigBlind && groups.length > 1;

          return (
            <div key={g.bigBlind} className={`slc-row ${isBest ? 'slc-row-best' : ''}`}>
              <span className="slc-stakes">{g.label}</span>
              <span className="slc-val">{g.sessions}</span>
              <span className="slc-val">{g.totalHands.toLocaleString()}</span>
              <span className={`slc-val ${plClass}`}>
                {g.totalProfit >= 0 ? '+' : ''}
                {g.totalProfit.toLocaleString()}
              </span>
              <span className={`slc-val ${g.bbPer100 >= 0 ? 'slc-positive' : 'slc-negative'}`}>
                {g.bbPer100 >= 0 ? '+' : ''}
                {g.bbPer100}
              </span>
              <span className="slc-val">{g.avgVPIP}%</span>
              <span className="slc-val">{g.avgPFR}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
