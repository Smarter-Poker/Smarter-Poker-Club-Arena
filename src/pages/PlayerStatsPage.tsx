/**
 *  PLAYER STATS PAGE — Premium Glassmorphism Design
 *
 * 2026-08-19 rebuild:
 *  - Stats now come from the ca_player_stats_full RPC which computes lifetime
 *    cash + tournament statistics directly from hand_history (the old
 *    player_stats query used .maybeSingle() and ERRORED whenever a user had
 *    rows in more than one club — that is why the page showed "No Stats Yet").
 *  - Adds a Tournaments tab (entries, ITM, wins, ROI, recent results).
 *  - Adds "Send to Personal Assistant" (runs leak detection server-side).
 *  - Full CSV export of sessions and overview stats.
 *  - Legacy player_stats fallback if the RPC is unavailable (aggregates the
 *    per-club rows instead of .maybeSingle()).
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
import { reportError } from '../utils/errorReporter';

// ── SWR Cache helpers (localStorage for cross-session persistence) ──
const STATS_CACHE_KEY = 'ps_stats_v3_';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedFull(userId: string): FullStats | null {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.cachedAt && Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
    return parsed.full || null;
  } catch {
    return null;
  }
}
function setCachedFull(userId: string, full: FullStats) {
  try {
    localStorage.setItem(STATS_CACHE_KEY + userId, JSON.stringify({ full, cachedAt: Date.now() }));
  } catch {
    /* quota */
  }
}

// ── Types matching the ca_player_stats_full RPC payload ──
interface OverallStats {
  total_hands: number;
  cash_hands: number;
  tourney_hands: number;
  tournaments_with_hands: number;
  hands_won: number;
  hands_lost: number;
  vpip: number; // fraction 0..1
  pfr: number;
  three_bet_percent: number;
  fold_to_three_bet: number;
  cbet_flop: number;
  aggression_factor: number;
  showdowns_total: number;
  showdowns_won: number;
  wtsd: number;
  total_profit: number;
  total_winnings: number;
  total_invested: number;
  biggest_pot_won: number;
  biggest_hand_loss: number;
  bb_per_100: number;
  hours_played: number;
  first_hand_at?: string;
  last_hand_at?: string;
}

interface DailyPoint {
  date: string;
  hands: number;
  profit: number;
}

interface SessionRow {
  id: number;
  date: string;
  ended: string;
  duration_minutes: number;
  hands_played: number;
  buy_in: number;
  cash_out: number;
  profit_loss: number;
}

interface PositionRow {
  position: string;
  hands_played: number;
  vpip_count: number;
  pfr_count: number;
  three_bet_count: number;
  hands_won: number;
  total_profit: number;
  bb100: number;
}

interface VariantRow {
  variant: string;
  hands: number;
  hands_won: number;
  profit: number;
  bb100: number;
}

interface TournamentSummary {
  entries: number;
  cashes: number;
  wins: number;
  best_finish: number | null;
  itm_percent: number;
  total_buyins: number;
  total_winnings: number;
  net_profit: number;
  roi: number;
}

interface RecentTournament {
  name: string;
  start_time: string | null;
  variant: string | null;
  finish_rank: number | null;
  status: string | null;
  prize: number;
  buyin: number;
}

interface FullStats {
  overall: OverallStats;
  daily: DailyPoint[];
  sessions: SessionRow[];
  positions: PositionRow[];
  variants: VariantRow[];
  tournaments: TournamentSummary;
  recent_tournaments: RecentTournament[];
}

type StatCategory = 'overview' | 'performance' | 'positions' | 'tournaments' | 'analysis';

const CHART_COLORS = ['#4169E1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#10b981'];

const EMPTY_OVERALL: OverallStats = {
  total_hands: 0,
  cash_hands: 0,
  tourney_hands: 0,
  tournaments_with_hands: 0,
  hands_won: 0,
  hands_lost: 0,
  vpip: 0,
  pfr: 0,
  three_bet_percent: 0,
  fold_to_three_bet: 0,
  cbet_flop: 0,
  aggression_factor: 0,
  showdowns_total: 0,
  showdowns_won: 0,
  wtsd: 0,
  total_profit: 0,
  total_winnings: 0,
  total_invested: 0,
  biggest_pot_won: 0,
  biggest_hand_loss: 0,
  bb_per_100: 0,
  hours_played: 0,
};

const EMPTY_FULL: FullStats = {
  overall: EMPTY_OVERALL,
  daily: [],
  sessions: [],
  positions: [],
  variants: [],
  tournaments: {
    entries: 0,
    cashes: 0,
    wins: 0,
    best_finish: null,
    itm_percent: 0,
    total_buyins: 0,
    total_winnings: 0,
    net_profit: 0,
    roi: 0,
  },
  recent_tournaments: [],
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

// ── Legacy fallback: aggregate per-club player_stats rows ──
// (values may be stored as fractions or percentages depending on writer;
//  normalize anything > 1 as a percentage)
function normFraction(v: number): number {
  return v > 1 ? v / 100 : v;
}

async function loadLegacyStats(userId: string): Promise<FullStats | null> {
  const { data, error } = await supabase
    .from('player_stats')
    .select('hands_played, total_winnings, total_losses, vpip, pfr')
    .eq('user_id', userId);
  if (error || !data || data.length === 0) return null;
  const hands = data.reduce((s, r) => s + (r.hands_played || 0), 0);
  const winnings = data.reduce((s, r) => s + (r.total_winnings || 0), 0);
  const losses = data.reduce((s, r) => s + (r.total_losses || 0), 0);
  const wVpip =
    hands > 0
      ? data.reduce((s, r) => s + normFraction(r.vpip || 0) * (r.hands_played || 0), 0) / hands
      : 0;
  const wPfr =
    hands > 0
      ? data.reduce((s, r) => s + normFraction(r.pfr || 0) * (r.hands_played || 0), 0) / hands
      : 0;
  return {
    ...EMPTY_FULL,
    overall: {
      ...EMPTY_OVERALL,
      total_hands: hands,
      cash_hands: hands,
      vpip: wVpip,
      pfr: wPfr,
      total_profit: winnings - losses,
      total_winnings: winnings,
    },
  };
}

export default function PlayerStatsPage() {
  const { userId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();

  const targetUserId = userId || user?.id;
  const [full, setFull] = useState<FullStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [category, setCategory] = useState<StatCategory>('overview');
  const statsSwipeHandlers = useSwipeTabs({
    tabs: ['overview', 'performance', 'positions', 'tournaments', 'analysis'] as StatCategory[],
    activeTab: category,
    onTabChange: setCategory,
  });
  const toast = useToast();
  const isMounted = useIsMounted();
  const hasStatsRef = useRef(false);
  const statsLoadingRef = useRef(false);
  useVisibilityRefresh(() => loadAllData());

  // SWR: show cached stats instantly on mount
  useEffect(() => {
    if (!targetUserId) return;
    const cached = getCachedFull(targetUserId);
    if (cached) {
      setFull(cached);
      hasStatsRef.current = true;
      setLoading(false);
    }
  }, [targetUserId]);

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  // (10s: the RPC itself may take several seconds for very high-volume players)
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 10000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (targetUserId) loadAllData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  // ── Bus Listeners: debounced refresh from engine events ──
  useEffect(() => {
    const unsubHand = masterBus.subscribeDebounced('HAND_COMPLETED', () => loadAllData(), 2000);
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadAllData(), 2000);
    const unsubChips = masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', () => loadAllData(), 2000);
    const unsubCashout = masterBus.subscribeDebounced('CASHOUT_APPROVED', () => loadAllData(), 2000);
    const unsubCredit = masterBus.subscribeDebounced('CREDIT_UPDATED', () => loadAllData(), 2000);
    return () => {
      unsubHand();
      unsubBalance();
      unsubChips();
      unsubCashout();
      unsubCredit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  // ── Single RPC pulls everything from hand_history server-side ──
  const loadAllData = async () => {
    if (!targetUserId) return;
    if (statsLoadingRef.current) return;
    statsLoadingRef.current = true;
    if (!hasStatsRef.current) setLoading(true);

    try {
      const { data, error } = await retryFetch(
        () =>
          supabase
            .rpc('ca_player_stats_full', { p_user: targetUserId })
            .then((r: any) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (!isMounted.current) return;

      if (!error && data && data.overall) {
        const resolved: FullStats = {
          ...EMPTY_FULL,
          ...data,
          overall: { ...EMPTY_OVERALL, ...data.overall },
          tournaments: { ...EMPTY_FULL.tournaments, ...(data.tournaments || {}) },
        };
        setFull(resolved);
        hasStatsRef.current = true;
        setCachedFull(targetUserId, resolved);
      } else {
        // Legacy fallback (aggregates per-club rows; never .maybeSingle())
        const legacy = await loadLegacyStats(targetUserId);
        if (!isMounted.current) return;
        if (legacy) {
          setFull(legacy);
          hasStatsRef.current = true;
        } else if (!hasStatsRef.current) {
          setFull(EMPTY_FULL);
        }
        if (error) reportError(error, 'PlayerStatsPage.rpc_ca_player_stats_full');
      }
    } catch (error) {
      reportError(error, 'PlayerStatsPage.Failed_to_load_stats');
      if (isMounted.current && !hasStatsRef.current) {
        setFull(EMPTY_FULL);
        toast.error('Failed to load player stats');
      }
    } finally {
      if (isMounted.current) setLoading(false);
      statsLoadingRef.current = false;
    }
  };

  const overall = full?.overall ?? EMPTY_OVERALL;
  const tourn = full?.tournaments ?? EMPTY_FULL.tournaments;

  const winRate = useMemo(
    () =>
      overall.total_hands > 0
        ? ((overall.hands_won / overall.total_hands) * 100).toFixed(1)
        : '0.0',
    [overall]
  );

  const showdownWinRate = useMemo(
    () =>
      overall.showdowns_total > 0
        ? ((overall.showdowns_won / overall.showdowns_total) * 100).toFixed(1)
        : '0',
    [overall]
  );

  // Chart series with cumulative line
  const dailySeries = useMemo(() => {
    let cumulative = 0;
    return (full?.daily || []).map((d) => {
      cumulative += d.profit || 0;
      return {
        date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        profit: d.profit || 0,
        hands: d.hands || 0,
        cumulative: Math.round(cumulative * 100) / 100,
      };
    });
  }, [full]);

  const positionPie = useMemo(
    () =>
      (full?.positions || [])
        .filter((p) => p.hands_won > 0)
        .map((p) => ({ name: p.position, value: p.hands_won })),
    [full]
  );

  // AdvancedStatsSummary expects a player_stats-like object (fractions)
  const advancedInitialData = useMemo(
    () => ({
      total_hands: overall.total_hands,
      total_profit: overall.total_profit,
      hours_played: overall.hours_played,
      showdowns_won: overall.showdowns_won,
      showdowns_total: overall.showdowns_total,
      aggression_factor: overall.aggression_factor,
      three_bet_percent: overall.three_bet_percent,
      fold_to_three_bet: overall.fold_to_three_bet,
      cbet_flop: overall.cbet_flop,
      vpip: overall.vpip,
      pfr: overall.pfr,
      bb_per_100: overall.bb_per_100,
      total_winnings: overall.total_winnings,
    }),
    [overall]
  );

  const sessionRows = full?.sessions || [];

  // ── Send stats to the Personal Assistant (server-side leak detection) ──
  const sendToAssistant = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const res = await fetch('/api/assistant/leaks/detect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (res.ok) {
        toast.success('Stats exported. Opening your Personal Assistant...');
        setTimeout(() => {
          window.location.href = '/hub/personal-assistant';
        }, 900);
      } else {
        toast.error('Assistant export failed. Try again in a moment.');
      }
    } catch (e) {
      reportError(e, 'PlayerStatsPage.sendToAssistant');
      toast.error('Assistant export failed. Try again in a moment.');
    } finally {
      if (isMounted.current) setExporting(false);
    }
  };

  const exportSessionsCSV = () => {
    try {
      exportToCSV(
        sessionRows.map((s) => ({
          date: new Date(s.date).toLocaleString(),
          duration_minutes: s.duration_minutes,
          hands: s.hands_played,
          profit: s.profit_loss,
        })),
        'player_session_history.csv',
        [
          { key: 'date', label: 'Date' },
          { key: 'duration_minutes', label: 'Duration (min)' },
          { key: 'hands', label: 'Hands' },
          { key: 'profit', label: 'Profit' },
        ]
      );
    } catch (e) {
      reportError(e, 'PlayerStatsPage.exportSessionsCSV');
    }
  };

  const exportOverviewCSV = () => {
    try {
      const rows = Object.entries({
        ...overall,
        tournament_entries: tourn.entries,
        tournament_cashes: tourn.cashes,
        tournament_wins: tourn.wins,
        tournament_net_profit: tourn.net_profit,
        tournament_roi: tourn.roi,
      }).map(([k, v]) => ({ stat: k, value: String(v ?? '') }));
      exportToCSV(rows, 'player_stats_overview.csv', [
        { key: 'stat', label: 'Stat' },
        { key: 'value', label: 'Value' },
      ]);
    } catch (e) {
      reportError(e, 'PlayerStatsPage.exportOverviewCSV');
    }
  };

  if (loading) {
    return (
      <div className="stats-page">
        <PageSkeleton variant="stats" />
      </div>
    );
  }

  const hasData = overall.total_hands > 0 || tourn.entries > 0;

  return (
    <div className="stats-page">
      {/* ── HERO SECTION ── */}
      <div className="stats-hero">
        <WinRateGauge winRate={parseFloat(winRate)} />
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="hero-stat-label">Total Hands</span>
            <span className="hero-stat-value cyan">{overall.total_hands.toLocaleString()}</span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">Cash Profit</span>
            <span
              className={`hero-stat-value ${overall.total_profit >= 0 ? 'positive' : 'negative'}`}
            >
              {overall.total_profit >= 0 ? '+' : ''}
              {overall.total_profit.toLocaleString()}
            </span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">BB/100</span>
            <span
              className={`hero-stat-value ${overall.bb_per_100 >= 0 ? 'positive' : 'negative'}`}
            >
              {overall.bb_per_100.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* ── PILL TABS ── */}
      <div className="stats-pill-tabs">
        {(
          ['overview', 'performance', 'positions', 'tournaments', 'analysis'] as StatCategory[]
        ).map((cat) => (
          <button
            key={cat}
            className={category === cat ? 'active' : ''}
            onClick={() => setCategory(cat)}
          >
            {cat === 'overview'
              ? 'Overview'
              : cat === 'performance'
                ? 'Performance'
                : cat === 'positions'
                  ? 'Positions'
                  : cat === 'tournaments'
                    ? 'Tournaments'
                    : 'Analysis'}
          </button>
        ))}
      </div>

      {/* ── STATS CONTENT ── */}
      <div className="stats-content" {...statsSwipeHandlers}>
        {/* EMPTY STATE */}
        {!hasData && category === 'overview' && (
          <div className="stats-empty-state">
            <span className="empty-icon">{'♠'}</span>
            <span className="empty-title">No Stats Yet</span>
            <span className="empty-description">
              Play some hands at the tables and your statistics will appear here automatically.
            </span>
            <button className="empty-cta" onClick={() => navigate('/')}>
              Go to Lobby
            </button>
          </div>
        )}

        {/* ── OVERVIEW TAB ── */}
        {category === 'overview' && hasData && (
          <>
            <div className="stats-grid">
              <StatRow label="VPIP" value={`${(overall.vpip * 100).toFixed(1)}%`} color="#00d4ff" />
              <StatRow label="PFR" value={`${(overall.pfr * 100).toFixed(1)}%`} color="#8b5cf6" />
              <StatRow
                label="Aggression Factor"
                value={overall.aggression_factor.toFixed(2)}
                color="#f59e0b"
              />
              <StatRow
                label="Hours Played"
                value={`${overall.hours_played.toFixed(1)}h`}
                color="#06b6d4"
              />
              <StatRow label="Showdown Win %" value={`${showdownWinRate}%`} color="#22c55e" />
              <StatRow
                label="BB/100"
                value={overall.bb_per_100.toFixed(2)}
                color="#4169E1"
                highlight
              />
              <StatRow
                label="Cash Hands"
                value={overall.cash_hands.toLocaleString()}
                color="#00d4ff"
              />
              <StatRow
                label="Tournament Hands"
                value={overall.tourney_hands.toLocaleString()}
                color="#8b5cf6"
              />
            </div>

            {/* Per-variant breakdown */}
            {(full?.variants?.length ?? 0) > 0 && (
              <div className="variant-table">
                <div className="variant-row variant-head">
                  <span>Game</span>
                  <span>Hands</span>
                  <span>Won</span>
                  <span>Profit</span>
                  <span>BB/100</span>
                </div>
                {(full?.variants || []).map((v) => (
                  <div className="variant-row" key={v.variant}>
                    <span className="variant-name">{v.variant.toUpperCase()}</span>
                    <span>{v.hands.toLocaleString()}</span>
                    <span>{v.hands_won.toLocaleString()}</span>
                    <span className={v.profit >= 0 ? 'positive' : 'negative'}>
                      {v.profit >= 0 ? '+' : ''}
                      {v.profit.toLocaleString()}
                    </span>
                    <span className={v.bb100 >= 0 ? 'positive' : 'negative'}>
                      {v.bb100.toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="stats-action-row">
              <button className="view-hands-btn" onClick={() => navigate('/hands')}>
                View Hand Histories
              </button>
              <button
                className="assistant-export-btn"
                onClick={sendToAssistant}
                disabled={exporting}
              >
                {exporting ? 'Exporting...' : 'Send to Personal Assistant'}
              </button>
            </div>
          </>
        )}

        {/* ── PERFORMANCE TAB ── */}
        {category === 'performance' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Preflop */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#00d4ff' }}>Preflop</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="VPIP"
                  value={`${(overall.vpip * 100).toFixed(1)}%`}
                  color="#00d4ff"
                />
                <StatRow label="PFR" value={`${(overall.pfr * 100).toFixed(1)}%`} color="#8b5cf6" />
                <StatRow
                  label="3-Bet %"
                  value={`${(overall.three_bet_percent * 100).toFixed(1)}%`}
                  color="#f59e0b"
                />
                <StatRow
                  label="Fold to 3-Bet"
                  value={`${(overall.fold_to_three_bet * 100).toFixed(1)}%`}
                  color="#ef4444"
                />
              </div>
            </div>
            {/* Postflop */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#8b5cf6' }}>Postflop</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="C-Bet Flop"
                  value={`${(overall.cbet_flop * 100).toFixed(1)}%`}
                  color="#8b5cf6"
                />
                <StatRow
                  label="WTSD"
                  value={`${(overall.wtsd * 100).toFixed(1)}%`}
                  color="#6366f1"
                />
                <StatRow
                  label="Aggression Factor"
                  value={overall.aggression_factor.toFixed(2)}
                  color="#f59e0b"
                />
                <StatRow label="Showdown Win %" value={`${showdownWinRate}%`} color="#22c55e" />
              </div>
            </div>
            {/* Results */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#22c55e' }}>Results</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="Cash Profit"
                  value={overall.total_profit.toLocaleString()}
                  color="#22c55e"
                  highlight
                />
                <StatRow label="BB/100" value={overall.bb_per_100.toFixed(2)} color="#4169E1" />
                <StatRow
                  label="Total Won"
                  value={overall.total_winnings.toLocaleString()}
                  color="#10b981"
                />
                <StatRow
                  label="Total Invested"
                  value={overall.total_invested.toLocaleString()}
                  color="#06b6d4"
                />
                <StatRow
                  label="Biggest Pot Won"
                  value={overall.biggest_pot_won.toLocaleString()}
                  color="#10b981"
                />
                <StatRow
                  label="Biggest Hand Loss"
                  value={overall.biggest_hand_loss.toLocaleString()}
                  color="#ef4444"
                />
                <StatRow
                  label="Hands Won"
                  value={overall.hands_won.toLocaleString()}
                  color="#22c55e"
                />
                <StatRow
                  label="Hands Lost"
                  value={overall.hands_lost.toLocaleString()}
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
            <PositionWinRates userId={targetUserId} initialPositions={full?.positions} />
          </div>
        )}

        {/* ── TOURNAMENTS TAB ── */}
        {category === 'tournaments' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#f59e0b' }}>Tournament Results</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="Entries"
                  value={tourn.entries.toLocaleString()}
                  color="#00d4ff"
                />
                <StatRow label="Cashes" value={tourn.cashes.toLocaleString()} color="#22c55e" />
                <StatRow
                  label="ITM %"
                  value={`${(tourn.itm_percent * 100).toFixed(1)}%`}
                  color="#10b981"
                />
                <StatRow label="Wins" value={tourn.wins.toLocaleString()} color="#f59e0b" />
                <StatRow
                  label="Best Finish"
                  value={tourn.best_finish ? `#${tourn.best_finish}` : '-'}
                  color="#8b5cf6"
                />
                <StatRow
                  label="Total Buy-ins"
                  value={tourn.total_buyins.toLocaleString()}
                  color="#06b6d4"
                />
                <StatRow
                  label="Total Winnings"
                  value={tourn.total_winnings.toLocaleString()}
                  color="#10b981"
                />
                <StatRow
                  label="Net Profit"
                  value={`${tourn.net_profit >= 0 ? '+' : ''}${tourn.net_profit.toLocaleString()}`}
                  color={tourn.net_profit >= 0 ? '#22c55e' : '#ef4444'}
                  highlight
                />
                <StatRow
                  label="ROI"
                  value={`${(tourn.roi * 100).toFixed(1)}%`}
                  color={tourn.roi >= 0 ? '#22c55e' : '#ef4444'}
                />
                <StatRow
                  label="Tournament Hands"
                  value={overall.tourney_hands.toLocaleString()}
                  color="#8b5cf6"
                />
              </div>
            </div>

            {(full?.recent_tournaments?.length ?? 0) > 0 ? (
              <div>
                <div className="stats-section-header">
                  <h3 style={{ color: '#3b82f6' }}>Recent Tournaments</h3>
                </div>
                <div className="tournament-list">
                  {(full?.recent_tournaments || []).map((t, i) => (
                    <div className="tournament-item" key={i}>
                      <div className="tournament-item-main">
                        <span className="tournament-item-name">{t.name}</span>
                        <span className="tournament-item-date">
                          {t.start_time
                            ? new Date(t.start_time).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })
                            : '-'}
                          {t.variant ? ` · ${t.variant.toUpperCase()}` : ''}
                        </span>
                      </div>
                      <div className="tournament-item-result">
                        <span className="tournament-item-rank">
                          {t.finish_rank ? `#${t.finish_rank}` : (t.status || '-')}
                        </span>
                        <span
                          className={`tournament-item-net ${t.prize - t.buyin >= 0 ? 'positive' : 'negative'}`}
                        >
                          {t.prize - t.buyin >= 0 ? '+' : ''}
                          {(t.prize - t.buyin).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="stats-empty-state">
                <span className="empty-title">No Tournaments Yet</span>
                <span className="empty-description">
                  Register for a tournament in the lobby and your results will show up here.
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── ANALYSIS TAB ── */}
        {category === 'analysis' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Advanced Stats */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#f59e0b' }}>Advanced Stats</h3>
              </div>
              <AdvancedStatsSummary userId={targetUserId} initialData={advancedInitialData} />
            </div>

            {/* Charts */}
            <div className="charts-section">
              <div className="stats-section-header">
                <h3 style={{ color: '#00d4ff' }}>Charts</h3>
              </div>

              <div className="stats-action-row">
                {sessionRows.length > 0 && (
                  <button className="export-btn" onClick={exportSessionsCSV}>
                    Export Sessions CSV
                  </button>
                )}
                <button className="export-btn" onClick={exportOverviewCSV}>
                  Export Stats CSV
                </button>
                <button
                  className="assistant-export-btn"
                  onClick={sendToAssistant}
                  disabled={exporting}
                >
                  {exporting ? 'Exporting...' : 'Send to Personal Assistant'}
                </button>
              </div>

              {/* Profit Over Time Chart */}
              <div className="chart-card">
                <div className="chart-card-header">
                  <h3>Profit Over Time (90 days)</h3>
                </div>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={dailySeries}>
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
                    <BarChart data={dailySeries}>
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
                        {dailySeries.map((entry, index) => (
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
              {positionPie.length > 0 && (
                <div className="chart-card">
                  <div className="chart-card-header">
                    <h3>Hands Won by Position</h3>
                  </div>
                  <div className="chart-container pie-chart">
                    <ResponsiveContainer width="100%" height={250}>
                      <PieChart>
                        <Pie
                          data={positionPie}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={90}
                          paddingAngle={2}
                          dataKey="value"
                          nameKey="name"
                          label={({ name, value }) => `${name}: ${value}`}
                          labelLine={{ stroke: 'rgba(255,255,255,0.3)' }}
                        >
                          {positionPie.map((_entry, index) => (
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
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>

            {/* Sessions */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#3b82f6' }}>Session History</h3>
              </div>
              <SessionHistory userId={targetUserId} initialSessions={sessionRows} />
            </div>

            {/* Bankroll */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#10b981' }}>Bankroll Tracker</h3>
              </div>
              <BankrollTracker userId={targetUserId} initialSessions={sessionRows} />
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
