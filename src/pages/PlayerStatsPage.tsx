/**
 *  PLAYER STATS PAGE — Premium Glassmorphism Design
 *
 * Performance improvements:
 *  - Parallel queries: all 3 Supabase calls fire simultaneously
 *  - localStorage SWR cache: instant render on revisit
 *  - isMounted guards on all setState calls
 *  - retryFetch with exponential backoff
 */

import { useState, useEffect, useRef, useMemo } from 'react';
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

// ── SWR Cache helpers (localStorage for cross-session persistence) ──
const STATS_CACHE_KEY = 'ps_stats_v2_';
const SESSION_CACHE_KEY = 'ps_sessions_v2_';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedStats(userId: string) {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.cachedAt && Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}
function setCachedStats(userId: string, data: any) {
  try {
    localStorage.setItem(
      STATS_CACHE_KEY + userId,
      JSON.stringify({ ...data, cachedAt: Date.now() })
    );
  } catch {
    /* quota */
  }
}
function getCachedSessions(userId: string) {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.cachedAt && Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
    return parsed.sessions || null;
  } catch {
    return null;
  }
}
function setCachedSessions(userId: string, sessions: any) {
  try {
    localStorage.setItem(
      SESSION_CACHE_KEY + userId,
      JSON.stringify({ sessions, cachedAt: Date.now() })
    );
  } catch {
    /* quota */
  }
}

interface DetailedStats {
  total_hands: number;
  hands_won: number;
  hands_lost: number;
  showdowns_won: number;
  showdowns_total: number;
  vpip: number;
  pfr: number;
  aggression_factor: number;
  three_bet_percent: number;
  fold_to_three_bet: number;
  cbet_flop: number;
  cbet_turn: number;
  bb_per_100: number;
  total_profit: number;
  biggest_pot_won: number;
  biggest_pot_lost: number;
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

const DEFAULT_STATS: DetailedStats = {
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
};

// ── Animated counter hook ──
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

// ── Win Rate Gauge SVG ──
function WinRateGauge({ winRate }: { winRate: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const fillPercent = Math.min(100, Math.max(0, winRate));
  const dashOffset = circumference - (fillPercent / 100) * circumference;

  // Color based on win rate
  const getColor = () => {
    if (fillPercent >= 55) return '#10b981';
    if (fillPercent >= 45) return '#00d4ff';
    if (fillPercent >= 35) return '#f59e0b';
    return '#ef4444';
  };

  const countedRate = useCountUpNumber(Math.floor(fillPercent), 800);

  return (
    <div className="hero-gauge">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle className="gauge-bg" cx="50" cy="50" r={radius} />
        <circle
          className="gauge-fill"
          cx="50"
          cy="50"
          r={radius}
          stroke={getColor()}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ filter: `drop-shadow(0 0 6px ${getColor()}40)` }}
        />
      </svg>
      <div className="gauge-center">
        <span className="gauge-value" style={{ color: getColor() }}>
          {countedRate}%
        </span>
        <span className="gauge-label">Win Rate</span>
      </div>
    </div>
  );
}

export default function PlayerStatsPage() {
  const { userId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();

  const targetUserId = userId || user?.id;
  const [stats, setStats] = useState<DetailedStats | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionData[]>([]);
  const [rawSessionData, setRawSessionData] = useState<any[] | null>(null);
  const [positionData, setPositionData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<StatCategory>('overview');
  const statsSwipeHandlers = useSwipeTabs({
    tabs: ['overview', 'performance', 'positions', 'analysis'] as StatCategory[],
    activeTab: category,
    onTabChange: setCategory,
  });
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
      setStats(cachedStats.stats || null);
      setPositionData(cachedStats.positionData || []);
      hasStatsRef.current = true;
      setLoading(false);
    }
    const cachedSessions = getCachedSessions(targetUserId);
    if (cachedSessions && cachedSessions.length > 0) {
      setSessionHistory(cachedSessions);
    }
  }, [targetUserId]);

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    let isMounted = true;
    if (targetUserId) {
      loadAllData(() => isMounted);
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
          loadAllData();
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
  useEffect(() => {
    const unsubHand = masterBus.subscribeDebounced('HAND_COMPLETED', () => loadAllData(), 1000);
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadStats(), 1000);
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
  }, [targetUserId]);

  // ── PARALLEL data loading — all queries at once ──
  const loadAllData = async (getIsMounted?: () => boolean) => {
    if (!targetUserId) return;
    if (statsLoadingRef.current) return;
    statsLoadingRef.current = true;
    if (!hasStatsRef.current) setLoading(true);

    try {
      // Fire ALL queries in parallel
      const [statsResult, posResult, sessionsResult] = await Promise.allSettled([
        retryFetch(
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
        ),
        retryFetch(
          () =>
            supabase
              .from('player_position_stats')
              .select('position, hands_won')
              .eq('user_id', targetUserId)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        retryFetch(
          () =>
            supabase
              .from('player_sessions')
              .select('date, profit_loss, hands_played')
              .eq('user_id', targetUserId)
              .order('date', { ascending: true })
              .limit(30)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
      ]);

      if (getIsMounted && !getIsMounted()) return;
      if (!isMounted.current) return;

      // Process stats
      let resolvedStats: DetailedStats = DEFAULT_STATS;
      if (statsResult.status === 'fulfilled') {
        const { data, error } = statsResult.value;
        if (!error && data) {
          resolvedStats = data;
          hasStatsRef.current = true;
        }
      }
      setStats(resolvedStats);

      // Process position data
      let resolvedPositionData: any[] = [];
      if (posResult.status === 'fulfilled') {
        const { data: posData, error: posError } = posResult.value;
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
          resolvedPositionData = posData
            .map((p) => ({
              name: p.position,
              value: p.hands_won || 0,
              fullName: fullNames[p.position] || p.position,
            }))
            .filter((p) => p.value > 0);
        }
      }
      setPositionData(resolvedPositionData);

      // Process sessions
      if (sessionsResult.status === 'fulfilled') {
        const { data: sessData } = sessionsResult.value;
        if (sessData && sessData.length > 0) {
          // Store raw data for BankrollTracker dedup
          setRawSessionData(sessData);
          let cumulative = 0;
          const history = sessData.map((session) => {
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
          setCachedSessions(targetUserId, history);
        } else {
          setSessionHistory([]);
          setRawSessionData([]);
        }
      }

      // Update SWR cache
      if (isMounted.current) {
        setCachedStats(targetUserId, {
          stats: resolvedStats,
          positionData: resolvedPositionData,
        });
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
      if (isMounted.current) toast.error('Failed to load player stats');
    } finally {
      if (isMounted.current) setLoading(false);
      statsLoadingRef.current = false;
    }
  };

  // Standalone stats reload (for bus events that only need stats)
  const loadStats = async () => {
    if (!targetUserId) return;
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
      if (!isMounted.current) return;
      if (!error && data) {
        setStats(data);
        hasStatsRef.current = true;
      }
    } catch {
      /* silent — bus-triggered refresh */
    }
  };

  const winRate = useMemo(
    () =>
      stats && stats.total_hands > 0
        ? ((stats.hands_won / stats.total_hands) * 100).toFixed(1)
        : '0.0',
    [stats]
  );

  const showdownWinRate = useMemo(
    () =>
      stats && stats.showdowns_total > 0
        ? ((stats.showdowns_won / stats.showdowns_total) * 100).toFixed(1)
        : '0',
    [stats]
  );

  if (loading) {
    return (
      <div className="stats-page">
        <PageSkeleton variant="stats" />
      </div>
    );
  }

  const hasData = stats && stats.total_hands > 0;

  return (
    <div className="stats-page">
      {/* ── HERO SECTION ── */}
      <div className="stats-hero">
        <WinRateGauge winRate={parseFloat(winRate)} />
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="hero-stat-label">Total Hands</span>
            <span className="hero-stat-value cyan">
              {(stats?.total_hands ?? 0).toLocaleString()}
            </span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">Total Profit</span>
            <span
              className={`hero-stat-value ${(stats?.total_profit ?? 0) >= 0 ? 'positive' : 'negative'}`}
            >
              {(stats?.total_profit ?? 0) >= 0 ? '+' : ''}
              {(stats?.total_profit ?? 0).toLocaleString()}
            </span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">BB/100</span>
            <span
              className={`hero-stat-value ${(stats?.bb_per_100 ?? 0) >= 0 ? 'positive' : 'negative'}`}
            >
              {(stats?.bb_per_100 ?? 0).toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* ── PILL TABS ── */}
      <div className="stats-pill-tabs">
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

      {/* ── STATS CONTENT ── */}
      <div className="stats-content" {...statsSwipeHandlers}>
        {/* EMPTY STATE */}
        {!hasData && category === 'overview' && (
          <div className="stats-empty-state">
            <span className="empty-icon">🃏</span>
            <span className="empty-title">No Stats Yet</span>
            <span className="empty-description">
              Play some hands at the tables and your statistics will appear here automatically.
            </span>
            <button className="empty-cta" onClick={() => navigate('/')}>
              🎰 Go to Lobby
            </button>
          </div>
        )}

        {/* ── OVERVIEW TAB ── */}
        {category === 'overview' && stats && hasData && (
          <>
            <div className="stats-grid">
              <StatRow
                label="VPIP"
                value={`${((stats.vpip || 0) * 100).toFixed(1)}%`}
                color="#00d4ff"
              />
              <StatRow
                label="PFR"
                value={`${((stats.pfr || 0) * 100).toFixed(1)}%`}
                color="#8b5cf6"
              />
              <StatRow
                label="Aggression Factor"
                value={(stats.aggression_factor || 0).toFixed(2)}
                color="#f59e0b"
              />
              <StatRow
                label="Hours Played"
                value={`${(stats.hours_played || 0).toFixed(1)}h`}
                color="#06b6d4"
              />
              <StatRow label="Showdown Win %" value={`${showdownWinRate}%`} color="#22c55e" />
              <StatRow
                label="BB/100"
                value={(stats.bb_per_100 || 0).toFixed(2)}
                color="#4169E1"
                highlight
              />
            </div>

            <button className="view-hands-btn" onClick={() => navigate('/hands')}>
              📋 View Hand Histories
            </button>
          </>
        )}

        {/* ── PERFORMANCE TAB ── */}
        {category === 'performance' && stats && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Preflop */}
            <div>
              <div className="stats-section-header">
                <span className="section-icon">🎯</span>
                <h3 style={{ color: '#00d4ff' }}>Preflop</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="VPIP"
                  value={`${((stats.vpip || 0) * 100).toFixed(1)}%`}
                  color="#00d4ff"
                />
                <StatRow
                  label="PFR"
                  value={`${((stats.pfr || 0) * 100).toFixed(1)}%`}
                  color="#8b5cf6"
                />
                <StatRow
                  label="3-Bet %"
                  value={`${((stats.three_bet_percent || 0) * 100).toFixed(1)}%`}
                  color="#f59e0b"
                />
                <StatRow
                  label="Fold to 3-Bet"
                  value={`${((stats.fold_to_three_bet || 0) * 100).toFixed(1)}%`}
                  color="#ef4444"
                />
              </div>
            </div>
            {/* Postflop */}
            <div>
              <div className="stats-section-header">
                <span className="section-icon">♠️</span>
                <h3 style={{ color: '#8b5cf6' }}>Postflop</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="C-Bet Flop"
                  value={`${((stats.cbet_flop || 0) * 100).toFixed(1)}%`}
                  color="#8b5cf6"
                />
                <StatRow
                  label="C-Bet Turn"
                  value={`${((stats.cbet_turn || 0) * 100).toFixed(1)}%`}
                  color="#6366f1"
                />
                <StatRow
                  label="Aggression Factor"
                  value={(stats.aggression_factor || 0).toFixed(2)}
                  color="#f59e0b"
                />
                <StatRow label="Showdown Win %" value={`${showdownWinRate}%`} color="#22c55e" />
              </div>
            </div>
            {/* Results */}
            <div>
              <div className="stats-section-header">
                <span className="section-icon">💰</span>
                <h3 style={{ color: '#22c55e' }}>Results</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="Total Profit"
                  value={stats.total_profit.toLocaleString()}
                  color="#22c55e"
                  highlight
                />
                <StatRow
                  label="BB/100"
                  value={(stats.bb_per_100 || 0).toFixed(2)}
                  color="#4169E1"
                />
                <StatRow
                  label="Biggest Pot Won"
                  value={stats.biggest_pot_won.toLocaleString()}
                  color="#10b981"
                />
                <StatRow
                  label="Biggest Pot Lost"
                  value={stats.biggest_pot_lost.toLocaleString()}
                  color="#ef4444"
                />
                <StatRow
                  label="Hands Won"
                  value={stats.hands_won.toLocaleString()}
                  color="#22c55e"
                />
                <StatRow
                  label="Hands Lost"
                  value={stats.hands_lost.toLocaleString()}
                  color="#ef4444"
                />
              </div>
            </div>
          </div>
        )}

        {/* ── POSITIONS TAB ── */}
        {category === 'positions' && (
          <div
            style={{
              opacity: 1,
              transform: 'translateY(0)',
              transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <PositionWinRates userId={targetUserId} />
          </div>
        )}

        {/* ── ANALYSIS TAB ── */}
        {category === 'analysis' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Advanced Stats */}
            <div>
              <div className="stats-section-header">
                <span className="section-icon">⚡</span>
                <h3 style={{ color: '#f59e0b' }}>Advanced Stats</h3>
              </div>
              <AdvancedStatsSummary userId={targetUserId} initialData={stats} />
            </div>

            {/* Charts */}
            <div className="charts-section">
              <div className="stats-section-header">
                <span className="section-icon">📊</span>
                <h3 style={{ color: '#00d4ff' }}>Charts</h3>
              </div>

              {sessionHistory.length > 0 && (
                <button
                  className="export-btn"
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
                <div className="chart-card-header">
                  <h3>Profit Over Time</h3>
                </div>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={sessionHistory}>
                      <defs>
                        <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#4169E1" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#4169E1" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(14, 14, 28, 0.95)',
                          border: '1px solid rgba(0, 212, 255, 0.2)',
                          borderRadius: '10px',
                          backdropFilter: 'blur(16px)',
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
                <div className="chart-card-header">
                  <h3>Daily Results</h3>
                </div>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={sessionHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(14, 14, 28, 0.95)',
                          border: '1px solid rgba(0, 212, 255, 0.2)',
                          borderRadius: '10px',
                          backdropFilter: 'blur(16px)',
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
                <div className="chart-card-header">
                  <h3>Win % by Position</h3>
                </div>
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
                        {positionData.map((_entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={CHART_COLORS[index % CHART_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(14, 14, 28, 0.95)',
                          border: '1px solid rgba(0, 212, 255, 0.2)',
                          borderRadius: '10px',
                          backdropFilter: 'blur(16px)',
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
              <div className="stats-section-header">
                <span className="section-icon">📅</span>
                <h3 style={{ color: '#3b82f6' }}>Session History</h3>
              </div>
              <SessionHistory userId={targetUserId} />
            </div>

            {/* Bankroll */}
            <div>
              <div className="stats-section-header">
                <span className="section-icon">💎</span>
                <h3 style={{ color: '#10b981' }}>Bankroll Tracker</h3>
              </div>
              <BankrollTracker
                userId={targetUserId}
                initialSessions={rawSessionData || undefined}
              />
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
  color = '#00d4ff',
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
}) {
  return (
    <div className={`stat-row ${highlight ? 'highlight' : ''}`}>
      <span className="row-label">
        <span className="row-dot" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span className="row-value" style={{ color }}>
        {value}
      </span>
    </div>
  );
}
