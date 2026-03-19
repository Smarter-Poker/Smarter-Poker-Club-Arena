/**
 *  PLAYER STATS PAGE — Detailed Statistics with Charts
 *
 * Improvements:
 *  - retryFetch: exponential backoff on transient failures
 *  - SWR cache: show cached stats instantly, refresh in background
 *  - isMounted guards on all setState calls
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import { useIsMounted } from '../hooks/useIsMounted';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import PositionWinRates from '../components/stats/PositionWinRates';
import SessionHistory from '../components/stats/SessionHistory';
import BankrollTracker from '../components/stats/BankrollTracker';
import AdvancedStatsSummary from '../components/stats/AdvancedStatsSummary';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import './PlayerStatsPage.css';

// ── SWR Cache helpers ──
const STATS_CACHE_KEY = 'ps_stats_';
const SESSION_CACHE_KEY = 'ps_sessions_';
function getCachedStats(userId: string) {
  try {
    const raw = sessionStorage.getItem(STATS_CACHE_KEY + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setCachedStats(userId: string, data: any) {
  try {
    sessionStorage.setItem(STATS_CACHE_KEY + userId, JSON.stringify(data));
  } catch {
    /* quota */
  }
}
function getCachedSessions(userId: string) {
  try {
    const raw = sessionStorage.getItem(SESSION_CACHE_KEY + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setCachedSessions(userId: string, data: any) {
  try {
    sessionStorage.setItem(SESSION_CACHE_KEY + userId, JSON.stringify(data));
  } catch {
    /* quota */
  }
}

interface DetailedStats {
  // Volume
  total_hands: number;
  hands_won: number;
  hands_lost: number;
  showdowns_won: number;
  showdowns_total: number;

  // Style
  vpip: number;
  pfr: number;
  aggression_factor: number;
  three_bet_percent: number;
  fold_to_three_bet: number;
  cbet_flop: number;
  cbet_turn: number;

  // Results
  bb_per_100: number;
  total_profit: number;
  biggest_pot_won: number;
  biggest_pot_lost: number;

  // Time
  hours_played: number;
  avg_session_length: number;
}

interface SessionData {
  date: string;
  profit: number;
  hands: number;
  cumulative: number;
}

type StatCategory = 'overview' | 'performance' | 'positions' | 'analysis';

const CHART_COLORS = ['#4169E1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

// Standalone animated counter hook (must be defined outside component)
function useCountUpNumber(target: number, duration: number = 400) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let startTime: number;
    let rafId: number;
    const animate = (now: number) => {
      if (!startTime) startTime = now;
      const progress = Math.min((now - startTime) / duration, 1);
      setDisplay(Math.floor(target * progress));
      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      } else {
        setDisplay(target);
      }
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [target, duration]);
  return display;
}

export default function PlayerStatsPage() {
  const { userId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();

  const targetUserId = userId || user?.id;
  const [stats, setStats] = useState<DetailedStats | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionData[]>([]);
  const [positionData, setPositionData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<StatCategory>('overview');
  const statsSwipeHandlers = useSwipeTabs({
    tabs: ['overview', 'performance', 'positions', 'analysis'] as StatCategory[],
    activeTab: category,
    onTabChange: setCategory,
  });
  const [visibleSummaryCards, setVisibleSummaryCards] = useState(new Set<number>());
  const [visibleSessionRows, setVisibleSessionRows] = useState(new Set<number>());
  const toast = useToast();
  const isMounted = useIsMounted();
  const hasStatsRef = useRef(false);
  const statsLoadingRef = useRef(false);
  useVisibilityRefresh(() => loadStats());

  // SWR: show cached stats instantly on mount
  useEffect(() => {
    if (!targetUserId) return;
    const cachedStats = getCachedStats(targetUserId);
    if (cachedStats) {
      setStats(cachedStats.stats);
      setPositionData(cachedStats.positionData || []);
      hasStatsRef.current = true;
      setLoading(false);
    }
    const cachedSessions = getCachedSessions(targetUserId);
    if (cachedSessions && cachedSessions.length > 0) {
      setSessionHistory(cachedSessions);
    }
  }, [targetUserId]);

  // Stagger summary cards on mount
  useEffect(() => {
    const timers = [0, 1, 2].map((i) =>
      setTimeout(() => setVisibleSummaryCards((prev) => new Set([...prev, i])), i * 60)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  // Stagger session rows
  useEffect(() => {
    if (sessionHistory.length > 0) {
      const timers = sessionHistory.map((_, i) =>
        setTimeout(() => setVisibleSessionRows((prev) => new Set([...prev, i])), i * 50)
      );
      return () => timers.forEach((t) => clearTimeout(t));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionHistory.length]);

  useEffect(() => {
    let isMounted = true;
    if (targetUserId) {
      loadStats(() => isMounted);
      loadSessionHistory(() => isMounted);
    }
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  // ── Realtime: live stats updates when new hands complete ──
  useEffect(() => {
    if (!targetUserId) return;
    const channelKey = `player-stats-${targetUserId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'hand_history',
          filter: `player_ids=cs.{${targetUserId}}`,
        },
        () => {
          loadStats();
          loadSessionHistory();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('[PlayerStatsPage] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[PlayerStatsPage] ⏱️ Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  // ── Bus Listeners: debounced refresh from engine events ──
  // Debounced at 1s to coalesce with postgres_changes subscription above
  // (both fire for the same hand — bus fires immediately, postgres 100-2000ms later)
  useEffect(() => {
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        loadStats();
        loadSessionHistory();
      },
      1000
    );
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadStats();
      },
      1000
    );
    // Phase 5: Cross-page sync (ported from World Hub player-stats.js)
    const unsubChips = masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', () => loadStats(), 1000);
    const unsubCashout = masterBus.subscribeDebounced('CASHOUT_APPROVED', () => loadStats(), 1000);
    const unsubCredit = masterBus.subscribeDebounced('CREDIT_UPDATED', () => loadStats(), 1000);
    return () => {
      unsubHand();
      unsubBalance();
      unsubChips();
      unsubCashout();
      unsubCredit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadStats = async (getIsMounted?: () => boolean) => {
    if (!targetUserId) return;
    if (statsLoadingRef.current) return;
    statsLoadingRef.current = true;
    if (!hasStatsRef.current) setLoading(true);
    try {
      try {
        const { data, error } = await retryFetch(
          () =>
            supabase
              .from('player_stats')
              .select(
                'total_hands, hands_won, hands_lost, showdowns_won, showdowns_total, vpip, pfr, aggression_factor, three_bet_percent, fold_to_three_bet, cbet_flop, cbet_turn, bb_per_100, total_profit, biggest_pot_won, biggest_pot_lost, hours_played, avg_session_length'
              )
              .eq('user_id', targetUserId)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );

        if (getIsMounted && !getIsMounted()) return;
        if (!isMounted.current) return;

        if (!error && data) {
          setStats(data);
          hasStatsRef.current = true;
        } else {
          // Default stats
          setStats({
            total_hands: 0,
            hands_won: 0,
            hands_lost: 0,
            showdowns_won: 0,
            showdowns_total: 0,
            vpip: 0,
            pfr: 0,
            aggression_factor: 0,
            three_bet_percent: 0,
            fold_to_three_bet: 0,
            cbet_flop: 0,
            cbet_turn: 0,
            bb_per_100: 0,
            total_profit: 0,
            biggest_pot_won: 0,
            biggest_pot_lost: 0,
            hours_played: 0,
            avg_session_length: 0,
          });
        }

        // Fetch literal DB data for the position pie chart instead of mock data #SWEEP-8
        const { data: posData, error: posError } = await retryFetch(
          () =>
            supabase
              .from('player_position_stats')
              .select('position, hands_won')
              .eq('user_id', targetUserId)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );

        if (!posError && posData && posData.length > 0) {
          const fullNames: Record<string, string> = {
            UTG: 'Under The Gun',
            'UTG+1': 'UTG+1',
            MP: 'Middle Position',
            CO: 'Cutoff',
            BTN: 'Button',
            SB: 'Small Blind',
            BB: 'Big Blind',
          };
          const mapped = posData
            .map((p) => ({
              name: p.position,
              value: p.hands_won || 0,
              fullName: fullNames[p.position] || p.position,
            }))
            .filter((p) => p.value > 0); // Only chart positions with actual wins
          if (getIsMounted && !getIsMounted()) return;
          if (!isMounted.current) return;
          setPositionData(mapped.length > 0 ? mapped : []);
        } else {
          if (getIsMounted && !getIsMounted()) return;
          if (!isMounted.current) return;
          setPositionData([]);
        }

        // Update SWR cache
        if (isMounted.current) {
          setCachedStats(targetUserId, { stats: data || stats, positionData: posData || [] });
        }
      } catch (error) {
        console.error('Failed to load stats:', error);
        if (isMounted.current) toast.error('Failed to load player stats');
      }
      if (isMounted.current) setLoading(false);
    } finally {
      statsLoadingRef.current = false;
    }
  };

  const loadSessionHistory = async (getIsMounted?: () => boolean) => {
    try {
      const { data } = await retryFetch(
        () =>
          supabase
            .from('player_sessions')
            .select('date, profit_loss, hands_played')
            .eq('user_id', targetUserId)
            .order('date', { ascending: true })
            .limit(30)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (data && data.length > 0) {
        let cumulative = 0;
        const history = data.map((session) => {
          cumulative += session.profit_loss || 0;
          return {
            date: new Date(session.date).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            }),
            profit: session.profit_loss || 0,
            hands: session.hands_played || 0,
            cumulative,
          };
        });
        if (getIsMounted && !getIsMounted()) return;
        if (!isMounted.current) return;
        setSessionHistory(history);
        setCachedSessions(targetUserId || '', history);
      } else {
        // No real session data yet — show empty state (no fake data)
        if (getIsMounted && !getIsMounted()) return;
        if (!isMounted.current) return;
        setSessionHistory([]);
      }
    } catch (error) {
      console.error('Failed to load session history:', error);
      if (isMounted.current) toast.error('Failed to load session history');
    }
  };

  const winRate =
    stats && stats.total_hands > 0 ? ((stats.hands_won / stats.total_hands) * 100).toFixed(1) : '0';

  const showdownWinRate =
    stats && stats.showdowns_total > 0
      ? ((stats.showdowns_won / stats.showdowns_total) * 100).toFixed(1)
      : '0';

  // Animated win rate counter — hook called at component body level (not inside useMemo)
  const winRateInt = parseInt(winRate.split('.')[0]) || 0;
  const winRateDec = winRate.split('.')[1] || '';
  const countedWinRate = useCountUpNumber(winRateInt, 400);
  const displayedWinRate = winRateDec ? `${countedWinRate}.${winRateDec}` : `${countedWinRate}`;

  if (loading) {
    return (
      <div className="stats-page">
        <PageSkeleton variant="stats" />
      </div>
    );
  }

  return (
    <div className="stats-page">
      {/* Summary Cards */}
      <div className="stats-summary">
        <div
          className="stat-card"
          style={{
            opacity: visibleSummaryCards.has(0) ? 1 : 0,
            transform: visibleSummaryCards.has(0) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <span className="stat-value">{(stats?.total_hands ?? 0).toLocaleString()}</span>
          <span className="stat-label">Hands Played</span>
        </div>
        <div
          className="stat-card"
          style={{
            opacity: visibleSummaryCards.has(1) ? 1 : 0,
            transform: visibleSummaryCards.has(1) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <span className="stat-value">{displayedWinRate}%</span>
          <span className="stat-label">Win Rate</span>
        </div>
        <div
          className="stat-card profit"
          style={{
            opacity: visibleSummaryCards.has(2) ? 1 : 0,
            transform: visibleSummaryCards.has(2) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <span
            className={`stat-value ${(stats?.total_profit || 0) >= 0 ? 'positive' : 'negative'}`}
          >
            {(stats?.total_profit ?? 0).toLocaleString()}
          </span>
          <span className="stat-label">Total Profit</span>
        </div>
      </div>

      {/* Category Tabs — Consolidated 4-tab layout */}
      <div className="stats-tabs">
        {(['overview', 'performance', 'positions', 'analysis'] as StatCategory[]).map((cat) => (
          <button
            key={cat}
            className={category === cat ? 'active' : ''}
            onClick={() => setCategory(cat)}
          >
            {cat === 'overview'
              ? '📊 Overview'
              : cat === 'performance'
                ? '🎯 Performance'
                : cat === 'positions'
                  ? '📍 Positions'
                  : '📈 Analysis'}
          </button>
        ))}
      </div>

      {/* Stats Content — Swipeable */}
      <div className="stats-content" {...statsSwipeHandlers}>
        {category === 'overview' && stats && (
          <>
            <div className="stats-grid">
              <StatRow label="VPIP" value={`${((stats.vpip || 0) * 100).toFixed(1)}%`} />
              <StatRow label="PFR" value={`${((stats.pfr || 0) * 100).toFixed(1)}%`} />
              <StatRow
                label="Aggression Factor"
                value={(stats.aggression_factor || 0).toFixed(2)}
              />
              <StatRow label="Hours Played" value={`${(stats.hours_played || 0).toFixed(1)}h`} />
              <StatRow label="Showdown Win %" value={`${showdownWinRate}%`} />
              <StatRow label="BB/100" value={(stats.bb_per_100 || 0).toFixed(2)} highlight />
            </div>

            {/* Quick-link to Hand Histories */}
            <button
              onClick={() => navigate('/hands')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                width: '100%',
                padding: '12px 16px',
                marginTop: 16,
                background:
                  'linear-gradient(135deg, rgba(65, 105, 225, 0.15) 0%, rgba(139, 92, 246, 0.15) 100%)',
                border: '1px solid rgba(65, 105, 225, 0.3)',
                borderRadius: 10,
                color: '#a5b4fc',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: "'Orbitron', monospace",
                letterSpacing: '0.5px',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  'linear-gradient(135deg, rgba(65, 105, 225, 0.25) 0%, rgba(139, 92, 246, 0.25) 100%)';
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  'rgba(65, 105, 225, 0.5)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  'linear-gradient(135deg, rgba(65, 105, 225, 0.15) 0%, rgba(139, 92, 246, 0.15) 100%)';
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  'rgba(65, 105, 225, 0.3)';
              }}
            >
              📋 View Hand Histories
            </button>
          </>
        )}

        {/* ── Performance Tab (merged: preflop + postflop + results) ── */}
        {category === 'performance' && stats && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Preflop Section */}
            <div>
              <h3
                style={{
                  color: '#00d4ff',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '0.75rem',
                  fontFamily: "'Orbitron', monospace",
                }}
              >
                Preflop
              </h3>
              <div className="stats-grid">
                <StatRow label="VPIP" value={`${((stats.vpip || 0) * 100).toFixed(1)}%`} />
                <StatRow label="PFR" value={`${((stats.pfr || 0) * 100).toFixed(1)}%`} />
                <StatRow
                  label="3-Bet %"
                  value={`${((stats.three_bet_percent || 0) * 100).toFixed(1)}%`}
                />
                <StatRow
                  label="Fold to 3-Bet"
                  value={`${((stats.fold_to_three_bet || 0) * 100).toFixed(1)}%`}
                />
              </div>
            </div>
            {/* Postflop Section */}
            <div>
              <h3
                style={{
                  color: '#8b5cf6',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '0.75rem',
                  fontFamily: "'Orbitron', monospace",
                }}
              >
                Postflop
              </h3>
              <div className="stats-grid">
                <StatRow
                  label="C-Bet Flop"
                  value={`${((stats.cbet_flop || 0) * 100).toFixed(1)}%`}
                />
                <StatRow
                  label="C-Bet Turn"
                  value={`${((stats.cbet_turn || 0) * 100).toFixed(1)}%`}
                />
                <StatRow
                  label="Aggression Factor"
                  value={(stats.aggression_factor || 0).toFixed(2)}
                />
                <StatRow label="Showdown Win %" value={`${showdownWinRate}%`} />
              </div>
            </div>
            {/* Results Section */}
            <div>
              <h3
                style={{
                  color: '#22c55e',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '0.75rem',
                  fontFamily: "'Orbitron', monospace",
                }}
              >
                Results
              </h3>
              <div className="stats-grid">
                <StatRow
                  label="Total Profit"
                  value={`${stats.total_profit.toLocaleString()}`}
                  highlight
                />
                <StatRow label="BB/100" value={(stats.bb_per_100 || 0).toFixed(2)} />
                <StatRow
                  label="Biggest Pot Won"
                  value={`${stats.biggest_pot_won.toLocaleString()}`}
                />
                <StatRow
                  label="Biggest Pot Lost"
                  value={`${stats.biggest_pot_lost.toLocaleString()}`}
                />
                <StatRow label="Hands Won" value={stats.hands_won.toLocaleString()} />
                <StatRow label="Hands Lost" value={stats.hands_lost.toLocaleString()} />
              </div>
            </div>
          </div>
        )}

        {/* ── Positions Tab (unchanged) ── */}
        {category === 'positions' && (
          <div
            style={{
              opacity: 1,
              transform: 'translateY(0)',
              transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <PositionWinRates />
          </div>
        )}

        {/* ── Analysis Tab (merged: advanced + charts + sessions + bankroll) ── */}
        {category === 'analysis' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Advanced Stats */}
            <div>
              <h3
                style={{
                  color: '#f59e0b',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '0.75rem',
                  fontFamily: "'Orbitron', monospace",
                }}
              >
                Advanced Stats
              </h3>
              <AdvancedStatsSummary />
            </div>

            {/* Charts */}
            <div className="charts-section">
              <h3
                style={{
                  color: '#00d4ff',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '0.75rem',
                  fontFamily: "'Orbitron', monospace",
                }}
              >
                Charts
              </h3>
              {sessionHistory.length > 0 && (
                <button
                  style={{
                    background: 'rgba(65,105,225,0.15)',
                    color: '#4169E1',
                    border: '1px solid rgba(65,105,225,0.3)',
                    padding: '6px 14px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    marginBottom: '12px',
                  }}
                  onClick={() => {
                    try {
                      exportToCSV(sessionHistory, 'player_session_history.csv', [
                        { key: 'date', label: 'Date' },
                        { key: 'hands', label: 'Hands' },
                        { key: 'profit', label: 'Profit' },
                        { key: 'cumulative', label: 'Cumulative P/L' },
                      ]);
                    } catch {
                      /* silent */
                    }
                  }}
                >
                  📥 Export Sessions
                </button>
              )}
              {/* Profit Over Time Chart */}
              <div className="chart-card">
                <h3> Profit Over Time</h3>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={sessionHistory}>
                      <defs>
                        <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#4169E1" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#4169E1" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                      <XAxis dataKey="date" stroke="rgba(255,255,255,0.5)" fontSize={12} />
                      <YAxis stroke="rgba(255,255,255,0.5)" fontSize={12} />
                      <Tooltip
                        contentStyle={{
                          background: '#1e1e32',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '8px',
                        }}
                        labelStyle={{ color: '#fff' }}
                      />
                      <Area
                        type="monotone"
                        dataKey="cumulative"
                        stroke="#4169E1"
                        fill="url(#profitGradient)"
                        strokeWidth={2}
                        name="Cumulative Profit"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Session Results Bar Chart */}
              <div className="chart-card">
                <h3> Daily Results</h3>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={sessionHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                      <XAxis dataKey="date" stroke="rgba(255,255,255,0.5)" fontSize={12} />
                      <YAxis stroke="rgba(255,255,255,0.5)" fontSize={12} />
                      <Tooltip
                        contentStyle={{
                          background: '#1e1e32',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '8px',
                        }}
                        labelStyle={{ color: '#fff' }}
                      />
                      <Bar dataKey="profit" name="Profit" radius={[4, 4, 0, 0]}>
                        {sessionHistory.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={entry.profit >= 0 ? '#22c55e' : '#ef4444'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Position Breakdown Pie Chart */}
              <div className="chart-card">
                <h3> Win % by Position</h3>
                <div className="chart-container pie-chart">
                  <ResponsiveContainer width="100%" height={250}>
                    <PieChart>
                      <Pie
                        data={positionData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={90}
                        paddingAngle={2}
                        dataKey="value"
                        nameKey="name"
                        label={({ name, value }) => `${name}: ${value}%`}
                        labelLine={{ stroke: 'rgba(255,255,255,0.3)' }}
                      >
                        {positionData.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={CHART_COLORS[index % CHART_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: '#1e1e32',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '8px',
                        }}
                        formatter={(value, name) => [
                          `${value}%`,
                          positionData.find((p) => p.name === name)?.fullName || name,
                        ]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Sessions */}
            <div>
              <h3
                style={{
                  color: '#3b82f6',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '0.75rem',
                  fontFamily: "'Orbitron', monospace",
                }}
              >
                Session History
              </h3>
              <SessionHistory />
            </div>

            {/* Bankroll */}
            <div>
              <h3
                style={{
                  color: '#10b981',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '0.75rem',
                  fontFamily: "'Orbitron', monospace",
                }}
              >
                Bankroll Tracker
              </h3>
              <BankrollTracker />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={`stat-row ${highlight ? 'highlight' : ''}`}>
      <span className="row-label">{label}</span>
      <span className="row-value">{value}</span>
    </div>
  );
}
