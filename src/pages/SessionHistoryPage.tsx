/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION HISTORY PAGE — Past session analytics with P&L charts
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Improvements:
 *  - retryFetch: exponential backoff on transient failures
 *  - SWR cache: show cached sessions instantly, refresh in background
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import './SessionHistoryPage.css';
import PageSkeleton from '../components/common/PageSkeleton';

import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';

interface SessionRecord {
  id: string;
  table_id: string;
  user_id: string;
  session_start: string;
  session_end: string;
  initial_stack: number;
  final_stack: number;
  buy_in_total: number;
  hands_played: number;
  hands_won: number;
  vpip_percent: number;
  pfr_percent: number;
  profit_loss: number;
  big_blind: number;
  bb_won: number;
  rebuys: number;
  biggest_pot: number;
  trajectory: [number, number][];
}

// ── SWR Cache helpers ──
const SH_CACHE_PREFIX = 'sh_cache_';
function getCachedSH(userId: string, filter: string) {
  try {
    const raw = sessionStorage.getItem(SH_CACHE_PREFIX + userId + '_' + filter);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setCachedSH(userId: string, filter: string, data: any) {
  try {
    sessionStorage.setItem(SH_CACHE_PREFIX + userId + '_' + filter, JSON.stringify(data));
  } catch {
    /* quota */
  }
}

export default function SessionHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeFilter, setTimeFilter] = useState<'7d' | '30d' | 'all'>('30d');
  const isMounted = useIsMounted();
  const hasDataRef = useRef(false);

  // SWR: show cached sessions instantly on mount
  useEffect(() => {
    if (!user?.id) return;
    const cached = getCachedSH(user.id, timeFilter);
    if (cached && cached.length > 0) {
      setSessions(cached);
      hasDataRef.current = true;
      setLoading(false);
    } else {
      hasDataRef.current = false;
    }
  }, [user?.id, timeFilter]);

  const loadingRef = useRef(false);

  const loadSessions = useCallback(async () => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!hasDataRef.current) setLoading(true);
    try {
      let query = supabase
        .from('session_history')
        .select(
          'id, table_id, user_id, session_start, session_end, initial_stack, final_stack, buy_in_total, hands_played, hands_won, vpip_percent, pfr_percent, profit_loss, big_blind, bb_won, rebuys, biggest_pot, trajectory'
        )
        .eq('user_id', user.id)
        .order('session_end', { ascending: false })
        .limit(100);

      if (timeFilter === '7d') {
        const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
        query = query.gte('session_end', cutoff);
      } else if (timeFilter === '30d') {
        const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
        query = query.gte('session_end', cutoff);
      }

      const { data, error } = await retryFetch(() => query.then((r) => r), {
        maxRetries: 2,
        isMountedRef: isMounted,
      });
      if (error) throw error;
      if (!isMounted.current) return;
      const fetched = data || [];
      setSessions(fetched);
      hasDataRef.current = fetched.length > 0;
      setCachedSH(user.id, timeFilter, fetched);
    } catch (err) {
      if (!isMounted.current) return;
      reportError(err, 'SessionHistoryPage.Load_failed');
      toast.error('Failed to load session history');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  }, [user?.id, timeFilter]);

  useEffect(() => {
    if (!user?.id) return;
    loadSessions();
  }, [user?.id, timeFilter, loadSessions]);

  // Auto-refresh on tab return
  useVisibilityRefresh(() => loadSessions());

  // Bus listener: refresh when a session ends or balance changes (debounced)
  // Uses loadSessions from useCallback so deps stay stable
  useEffect(() => {
    if (!user?.id) return;
    const unsubs = [
      masterBus.subscribeDebounced('SESSION_ENDED', () => loadSessions(), 500),
      masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadSessions(), 2000),
    ];

    // WebSocket: live session history updates
    const channelKey = `session-history-${user.id}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'session_history',
          filter: `user_id=eq.${user.id}`,
        },
        () => loadSessions()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'SessionHistoryPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[SessionHistoryPage] Realtime channel timed out');
        }
      });

    return () => {
      unsubs.forEach((u) => u());
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [user?.id, loadSessions]);

  // Aggregate stats
  const totalPL = sessions.reduce((sum, s) => sum + (s.profit_loss || 0), 0);
  const totalHands = sessions.reduce((sum, s) => sum + (s.hands_played || 0), 0);
  const totalSessions = sessions.length;
  const avgVPIP =
    totalSessions > 0
      ? sessions.reduce((sum, s) => sum + (s.vpip_percent || 0), 0) / totalSessions
      : 0;
  const avgPFR =
    totalSessions > 0
      ? sessions.reduce((sum, s) => sum + (s.pfr_percent || 0), 0) / totalSessions
      : 0;
  const winRate =
    totalSessions > 0
      ? (sessions.filter((s) => (s.profit_loss || 0) > 0).length / totalSessions) * 100
      : 0;

  const formatDuration = (start: string, end: string): string => {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  const formatDate = (date: string): string => {
    return new Date(date).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Mini sparkline SVG for each session row
  const renderMiniSparkline = (trajectory: [number, number][] | undefined, profitLoss: number) => {
    if (!trajectory || trajectory.length < 2) return null;
    const values = trajectory.map((t) => t[1]);
    const baseline = values[0];
    const plValues = values.map((v) => v - baseline);
    const min = Math.min(...plValues);
    const max = Math.max(...plValues);
    const range = max - min || 1;
    const W = 80;
    const H = 24;
    const points = plValues.map((v, i) => {
      const x = (i / (plValues.length - 1)) * W;
      const y = H - ((v - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const color = profitLoss >= 0 ? '#22c55e' : '#ef4444';
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ flexShrink: 0 }}>
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  };

  return (
    <div className="session-history-page" data-arena-surface="play">
      <CasinoSurfaceHeader
        eyebrow="Play & Review / Sessions"
        title="Session Ledger"
        description="Review Complete Sessions, Loaded Performance Trends, And Table-Level Results With CSV Export And The Existing Live Session Record Pipeline Intact."
        artPath="assets/club-buttons/lobby/lobby-command-chassis-v2.png"
        status="SESSION INDEX // SYNCHRONIZED"
        metrics={[
          { label: 'Sessions', value: totalSessions },
          { label: 'Hands', value: totalHands.toLocaleString() },
          {
            label: 'Loaded P&L',
            value: `${totalPL >= 0 ? '+' : ''}${totalPL.toLocaleString()}`,
            tone: totalPL >= 0 ? 'live' : 'default',
          },
        ]}
      />

      {/* Aggregate Stats */}
      <div className="sh-aggregate">
        <div className={`sh-stat-card ${totalPL >= 0 ? 'positive' : 'negative'}`}>
          <span className="sh-stat-value">
            {totalPL >= 0 ? '+' : ''}
            {totalPL.toLocaleString()}
          </span>
          <span className="sh-stat-label">Total P&L</span>
        </div>
        <div className="sh-stat-card">
          <span className="sh-stat-value">{totalSessions}</span>
          <span className="sh-stat-label">Sessions</span>
        </div>
        <div className="sh-stat-card">
          <span className="sh-stat-value">{totalHands.toLocaleString()}</span>
          <span className="sh-stat-label">Hands</span>
        </div>
        <div className="sh-stat-card">
          <span className="sh-stat-value">{winRate.toFixed(0)}%</span>
          <span className="sh-stat-label">Win Rate</span>
        </div>
      </div>

      {/* VPIP / PFR Summary */}
      <div className="sh-stats-row">
        <div className="sh-mini-stat">
          <span className="sh-mini-label">Avg VPIP</span>
          <span className="sh-mini-value">{avgVPIP.toFixed(1)}%</span>
        </div>
        <div className="sh-mini-stat">
          <span className="sh-mini-label">Avg PFR</span>
          <span className="sh-mini-value">{avgPFR.toFixed(1)}%</span>
        </div>
      </div>

      {/* Time Filter */}
      <div className="sh-filter-bar">
        {(['7d', '30d', 'all'] as const).map((f) => (
          <button
            key={f}
            className={`sh-filter-chip ${timeFilter === f ? 'active' : ''}`}
            onClick={() => setTimeFilter(f)}
          >
            {f === '7d' ? '7 Days' : f === '30d' ? '30 Days' : 'All Time'}
          </button>
        ))}
        {sessions.length > 0 && (
          <button
            className="sh-filter-chip"
            style={{
              marginLeft: 'auto',
              background: 'rgba(0,200,83,0.15)',
              color: '#00C853',
              border: '1px solid rgba(0,200,83,0.3)',
            }}
            onClick={() => {
              try {
                exportToCSV(sessions, `session_history_${timeFilter}.csv`, [
                  { key: 'session_start', label: 'Start' },
                  { key: 'session_end', label: 'End' },
                  { key: 'hands_played', label: 'Hands' },
                  { key: 'initial_stack', label: 'Buy-In' },
                  { key: 'final_stack', label: 'Cash-Out' },
                  { key: 'profit_loss', label: 'P/L' },
                  { key: 'bb_won', label: 'BB Won' },
                  { key: 'vpip_percent', label: 'VPIP %' },
                  { key: 'pfr_percent', label: 'PFR %' },
                  { key: 'biggest_pot', label: 'Biggest Pot' },
                  { key: 'rebuys', label: 'Rebuys' },
                ]);
                toast.success('Sessions exported!');
              } catch (e) {
                reportError(e, 'SessionHistoryPage');
                toast.error('Failed to export sessions.');
              }
            }}
          >
            ⬇ Export CSV
          </button>
        )}
      </div>

      {/* Sessions List */}
      <div className="sh-sessions-list">
        {loading ? (
          <div className="sh-loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="sh-skeleton-row" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="sh-empty">
            <span className="sh-empty-icon">▦</span>
            <p>No Sessions Found. Play Some Hands To See Your History!</p>
          </div>
        ) : (
          sessions.map((session) => (
            <div key={session.id} className="sh-session-row">
              <div className="sh-session-info">
                <div className="sh-session-date">
                  {formatDate(session.session_end || session.session_start)}
                </div>
                <div className="sh-session-meta">
                  <span>{session.hands_played} Hands</span>
                  <span>•</span>
                  <span>{formatDuration(session.session_start, session.session_end)}</span>
                  <span>•</span>
                  <span>
                    {session.big_blind ? `${session.big_blind / 2}/${session.big_blind}` : '-'}
                  </span>
                </div>
              </div>
              <div className="sh-session-chart">
                {renderMiniSparkline(session.trajectory, session.profit_loss)}
              </div>
              <div
                className={`sh-session-pl ${(session.profit_loss || 0) >= 0 ? 'positive' : 'negative'}`}
              >
                {(session.profit_loss || 0) >= 0 ? '+' : ''}
                {(session.profit_loss || 0).toLocaleString()}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
