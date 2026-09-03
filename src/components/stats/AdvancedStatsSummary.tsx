/**
 * AdvancedStatsSummary — Dashboard of advanced poker statistics
 * Wired to real Supabase `player_stats` table with bus listeners
 *
 * Enhancements:
 *  - Optional `initialData` prop to skip redundant fetch (dedup from parent)
 *  - localStorage SWR cache for instant render
 *  - Average player benchmarks for comparison
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, getAuthUser } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './AdvancedStatsSummary.css';
import { reportError } from '../../utils/errorReporter';

// ── Average player benchmarks (based on typical 1/2 NL Hold'em) ──
const BENCHMARKS: Record<string, { avg: number; good: number; label: string }> = {
  hourly: { avg: 15, good: 25, label: '$' },
  totalHands: { avg: 5000, good: 20000, label: '' },
  showdownWin: { avg: 50, good: 55, label: '%' },
  aggression: { avg: 2.0, good: 3.0, label: '' },
  threeBet: { avg: 7, good: 10, label: '%' },
  foldTo3Bet: { avg: 55, good: 45, label: '%' },
  cbetFreq: { avg: 65, good: 70, label: '%' },
  bbPer100: { avg: 2, good: 5, label: 'BB' },
};

// ── SWR cache ──
const CACHE_KEY = 'adv_stats_v1_';
const CACHE_TTL = 10 * 60 * 1000;

function getCached(uid: string) {
  try {
    const raw = localStorage.getItem(CACHE_KEY + uid);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p.ts && Date.now() - p.ts > CACHE_TTL) return null;
    return p.data;
  } catch {
    return null;
  }
}
function setCache(uid: string, data: any) {
  try {
    localStorage.setItem(CACHE_KEY + uid, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    /* quota */
  }
}

interface AdvancedStat {
  id: string;
  label: string;
  value: number;
  format: (val: number) => string;
  unit?: string;
  description: string;
  benchmark?: { avg: number; good: number; label: string };
}

interface AdvancedStatsSummaryProps {
  initialData?: any; // Pre-fetched player_stats from parent (dedup)
}

// Animated number component
const AnimatedNumber: React.FC<{
  target: number;
  format: (val: number) => string;
  duration?: number;
}> = ({ target, format, duration = 600 }) => {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let startTime: number;
    let rafId: number;
    const animate = (now: number) => {
      if (!startTime) startTime = now;
      const progress = Math.min((now - startTime) / duration, 1);
      setDisplay(target * progress);
      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      } else {
        setDisplay(target);
      }
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [target, duration]);

  return <>{format(display)}</>;
};

const AdvancedStatsSummary: React.FC<AdvancedStatsSummaryProps> = ({ initialData }) => {
  const [stats, setStats] = useState<AdvancedStat[]>([]);
  const [visibleStats, setVisibleStats] = useState<Set<number>>(new Set());
  const [selectedStat, setSelectedStat] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showBenchmarks, setShowBenchmarks] = useState(false);
  const mountedRef = useRef(true);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const resolvedUidRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, []);

  const resolveUserId = useCallback(async (): Promise<string | null> => {
    try {
      const { data: userResp } = await getAuthUser();
      return userResp.user?.id || null;
    } catch (e) {
      reportError(e, 'AdvancedStatsSummary.useCallback');
      return null;
    }
  }, []);

  // If parent passes initialData, use it directly (dedup)
  useEffect(() => {
    if (initialData) {
      buildStats(initialData);
    }
  }, [initialData]);

  const loadStats = useCallback(async () => {
    // Skip fetch if parent already provided data
    if (initialData) return;

    try {
      const uid = await resolveUserId();
      if (!uid || !mountedRef.current) return;
      resolvedUidRef.current = uid;

      // SWR: show cached instantly
      const cached = getCached(uid);
      if (cached && !loaded) {
        buildStats(cached);
      }

      // Read the same RPC the parent uses. The previous query hit player_stats
      // with .maybeSingle() filtered only by user_id — which ERRORS the moment a
      // player has rows in more than one club (the original cause of the empty
      // stats page) — and it selected none of the advanced columns this panel
      // exists to show, so the standalone render was six zeroed cards.
      const { data, error } = await supabase.rpc('ca_player_stats_overview_v2', {
        p_user: uid,
      });

      if (!mountedRef.current) return;

      const overall = (data as any)?.overall;
      if (error || !overall) {
        buildStats(null);
        return;
      }

      setCache(uid, overall);
      buildStats(overall);
    } catch (err) {
      reportError(err, 'AdvancedStatsSummary.Failed_to_load');
      if (mountedRef.current) buildStats(null);
    }
  }, [resolveUserId, initialData, loaded]);

  const buildStats = (data: any) => {
    if (!mountedRef.current) return;

    const d = data || {};
    const totalHands = d.total_hands || 0;
    // Advanced analytics below are not tracked by the DB — default to 0 / N/A.
    const hoursPlayed = d.hours_played || 0;
    // total_profit is derived from real columns (parent may pass it pre-computed).
    const totalProfit = d.total_profit ?? (d.total_winnings || 0) - (d.total_losses || 0);
    const showdownsWon = d.showdowns_won || 0;
    const showdownsTotal = d.showdowns_total || 0;

    const hourlyRate = hoursPlayed > 0 ? totalProfit / hoursPlayed : 0;
    const showdownWinPct = showdownsTotal > 0 ? (showdownsWon / showdownsTotal) * 100 : 0;

    const built: AdvancedStat[] = [
      {
        id: 'hourly',
        label: 'Hourly Rate',
        value: hourlyRate,
        format: (val) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}`,
        unit: '/hr',
        description: 'Profit Per Hour Played',
        benchmark: BENCHMARKS.hourly,
      },
      {
        id: 'totalHands',
        label: 'Total Hands',
        value: totalHands,
        format: (val) => Math.floor(val).toLocaleString(),
        description: 'Total Hands Played Across All Sessions',
        benchmark: BENCHMARKS.totalHands,
      },
      {
        id: 'showdownWin',
        label: 'Showdown Win %',
        value: showdownWinPct,
        format: (val) => `${val.toFixed(1)}%`,
        description: 'Win Percentage When Reaching Showdown',
        benchmark: BENCHMARKS.showdownWin,
      },
      {
        id: 'aggression',
        label: 'Aggression Factor',
        value: d.aggression_factor || 0,
        format: (val) => val.toFixed(2),
        description: 'Ratio Of Aggressive Actions To Passive Actions',
        benchmark: BENCHMARKS.aggression,
      },
      {
        id: 'threeBet',
        label: '3-Bet %',
        value: (d.three_bet_percent || 0) * 100,
        format: (val) => `${val.toFixed(1)}%`,
        description: 'Percentage Of Re-Raises Preflop',
        benchmark: BENCHMARKS.threeBet,
      },
      {
        id: 'foldTo3Bet',
        label: 'Fold To 3-Bet %',
        value: (d.fold_to_three_bet || 0) * 100,
        format: (val) => `${val.toFixed(1)}%`,
        description: 'How Often You Fold To 3-Bet Raises',
        benchmark: BENCHMARKS.foldTo3Bet,
      },
      {
        id: 'cbetFreq',
        label: 'C-Bet Frequency',
        value: (d.cbet_flop || 0) * 100,
        format: (val) => `${val.toFixed(1)}%`,
        description: 'How Often You Continuation Bet On The Flop',
        benchmark: BENCHMARKS.cbetFreq,
      },
      {
        id: 'bbPer100',
        label: 'BB/100',
        value: d.bb_per_100 || 0,
        format: (val) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}`,
        description: 'Big Blinds Won Per 100 Hands - Key Profitability Metric',
        benchmark: BENCHMARKS.bbPer100,
      },
    ];

    setStats(built);
    setLoaded(true);

    // Clear previous stagger timers
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];

    // Stagger animation with cleanup
    built.forEach((_, i) => {
      const timer = setTimeout(() => {
        if (mountedRef.current) {
          setVisibleStats((prev) => new Set([...prev, i]));
        }
      }, i * 60);
      staggerTimersRef.current.push(timer);
    });
  };

  useEffect(() => {
    if (!initialData) loadStats();
  }, [loadStats, initialData]);

  // Bus listeners: refresh when stats change
  useEffect(() => {
    const unsubHand = masterBus.subscribeDebounced('HAND_COMPLETED', () => loadStats(), 2000);
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadStats(), 2000);
    return () => {
      unsubHand();
      unsubBalance();
    };
  }, [loadStats]);

  const getTrendColor = (val: number) => {
    if (val > 0) return '#10b981';
    if (val < 0) return '#ef4444';
    return '#8a9aaa';
  };

  const getBenchmarkBadge = (stat: AdvancedStat): { label: string; color: string } | null => {
    if (!stat.benchmark || !showBenchmarks) return null;
    const { avg, good } = stat.benchmark;
    const val = stat.value;

    // For fold_to_3bet, lower is better
    if (stat.id === 'foldTo3Bet') {
      if (val <= good) return { label: 'Elite', color: '#10b981' };
      if (val <= avg) return { label: 'Above Avg', color: '#22c55e' };
      return { label: 'Below Avg', color: '#f59e0b' };
    }

    if (val >= good) return { label: 'Elite', color: '#10b981' };
    if (val >= avg) return { label: 'Above Avg', color: '#22c55e' };
    if (val > 0) return { label: 'Below Avg', color: '#f59e0b' };
    return null;
  };

  if (!loaded) {
    return (
      <div className="advanced-stats-summary">
        <div className="stats-header">
          <h3>Advanced Statistics</h3>
          <p className="stats-subtitle">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="advanced-stats-summary">
      <div className="stats-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3>Advanced Statistics</h3>
            <p className="stats-subtitle">Detailed Metrics From Your Play History</p>
          </div>
          <button
            className="benchmark-toggle"
            onClick={() => setShowBenchmarks(!showBenchmarks)}
            style={{
              background: showBenchmarks ? 'rgba(0, 212, 255, 0.15)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${showBenchmarks ? 'rgba(0, 212, 255, 0.4)' : 'rgba(255,255,255,0.1)'}`,
              color: showBenchmarks ? '#00d4ff' : 'rgba(255,255,255,0.5)',
              padding: '6px 12px',
              borderRadius: '8px',
              fontSize: '11px',
              cursor: 'pointer',
              transition: 'all 0.2s',
              whiteSpace: 'nowrap',
            }}
          >
            {showBenchmarks ? 'Hide Avg' : 'Vs Average'}
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="advanced-stats-grid">
        {stats.map((stat, i) => {
          const isVisible = visibleStats.has(i);
          const isSelected = selectedStat === stat.id;
          const badge = getBenchmarkBadge(stat);

          return (
            <div
              key={stat.id}
              className={`advanced-stat-card ${isSelected ? 'selected' : ''}`}
              style={{
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateY(0)' : 'translateY(8px)',
                transition: `all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${i * 40}ms`,
              }}
              onClick={() => setSelectedStat(isSelected ? null : stat.id)}
            >
              {/* Card header */}
              <div className="card-top">
                <span className="stat-title">{stat.label}</span>
                {badge && (
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 700,
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: `${badge.color}20`,
                      color: badge.color,
                      letterSpacing: '0.5px',
                      textTransform: 'uppercase',
                    }}
                  >
                    {badge.label}
                  </span>
                )}
              </div>

              {/* Main value */}
              <div className="card-value">
                <span className="value-main" style={{ color: getTrendColor(stat.value) }}>
                  <AnimatedNumber target={stat.value} format={stat.format} />
                </span>
                {stat.unit && <span className="value-unit">{stat.unit}</span>}
              </div>

              {/* Benchmark bar (visible when toggled) */}
              {showBenchmarks && stat.benchmark && stat.value > 0 && (
                <div
                  style={{
                    marginTop: '6px',
                    height: '3px',
                    background: 'rgba(255,255,255,0.06)',
                    borderRadius: '2px',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, (stat.value / (stat.benchmark.good * 1.2)) * 100)}%`,
                      background: `linear-gradient(90deg, #f59e0b, #10b981)`,
                      borderRadius: '2px',
                      transition: 'width 0.6s ease',
                    }}
                  />
                </div>
              )}

              {/* Description (shown on select) */}
              {isSelected && (
                <div
                  className="card-description"
                  style={{
                    animation: 'animationsSlideDown 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <p>{stat.description}</p>
                  {showBenchmarks && stat.benchmark && (
                    <p
                      style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}
                    >
                      Avg: {stat.benchmark.avg}
                      {stat.benchmark.label} · Good: {stat.benchmark.good}
                      {stat.benchmark.label}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="stats-legend">
        <div className="legend-item">
          <span className="legend-label">BB/100</span>
          <p>Big Blinds Won Per 100 Hands - Primary Win Rate Metric</p>
        </div>
        <div className="legend-item">
          <span className="legend-label">C-Bet</span>
          <p>Continuation Bet - Betting On The Flop After Raising Preflop</p>
        </div>
        <div className="legend-item">
          <span className="legend-label">AF</span>
          <p>Aggression Factor - Ratio Of Aggressive To Passive Actions</p>
        </div>
      </div>
    </div>
  );
};

export default AdvancedStatsSummary;
