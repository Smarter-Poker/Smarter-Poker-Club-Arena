/**
 * AdvancedStatsSummary — the eight headline rates as tappable cards.
 *
 * PURE PRESENTATION (2026-09-03). This component used to carry a standalone
 * `ca_player_stats_overview_v2` fetch WITHOUT p_days (lifetime numbers under
 * the page's "7 Days" label), a localStorage cache, two bus listeners, and an
 * invented benchmark table ("based on typical 1/2 NL Hold'em") that awarded
 * "Elite" to a Fold-To-3-Bet of 0 - i.e. to no data at all. None of that could
 * run in production (the page always passes `initialData`) except the badges,
 * which were fabricated. The page has a real BenchmarkPanel measured against
 * the field; this one just shows the numbers, for the window they cover.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import './AdvancedStatsSummary.css';

interface AdvancedStat {
  id: string;
  label: string;
  value: number;
  format: (val: number) => string;
  unit?: string;
  description: string;
}

export interface AdvancedStatsInput {
  total_hands?: number;
  total_profit?: number;
  hours_played?: number;
  showdowns_won?: number;
  showdowns_total?: number;
  aggression_factor?: number;
  three_bet_percent?: number; // fraction 0..1
  fold_to_three_bet?: number; // fraction 0..1
  cbet_flop?: number; // fraction 0..1
  vpip?: number;
  pfr?: number;
  bb_per_100?: number;
  total_winnings?: number;
}

interface AdvancedStatsSummaryProps {
  /** The page's range-windowed `overall` block (rates as fractions). */
  initialData?: AdvancedStatsInput | null;
  /** The page's analysis window label, e.g. "7 Days" or "All". */
  rangeLabel?: string;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

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

function buildStats(d: AdvancedStatsInput): AdvancedStat[] {
  const totalHands = n(d.total_hands);
  const hoursPlayed = n(d.hours_played);
  const totalProfit = n(d.total_profit);
  const showdownsWon = n(d.showdowns_won);
  const showdownsTotal = n(d.showdowns_total);
  const hourlyRate = hoursPlayed > 0 ? totalProfit / hoursPlayed : 0;
  const showdownWinPct = showdownsTotal > 0 ? (showdownsWon / showdownsTotal) * 100 : 0;

  return [
    {
      id: 'hourly',
      label: 'Hourly Rate',
      value: hourlyRate,
      format: (val) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}`,
      unit: '/hr',
      description: 'Cash Profit Per Hour Played In This Window',
    },
    {
      id: 'totalHands',
      label: 'Hands Analysed',
      value: totalHands,
      format: (val) => Math.floor(val).toLocaleString(),
      description: 'Hands Inside This Analysis Window',
    },
    {
      id: 'showdownWin',
      label: 'Showdown Win %',
      value: showdownWinPct,
      format: (val) => `${val.toFixed(1)}%`,
      description: `Won ${showdownsWon.toLocaleString()} Of ${showdownsTotal.toLocaleString()} Showdowns`,
    },
    {
      id: 'aggression',
      label: 'Aggression Factor',
      value: n(d.aggression_factor),
      format: (val) => val.toFixed(2),
      description: 'Bets And Raises Divided By Calls',
    },
    {
      id: 'threeBet',
      label: '3-Bet %',
      value: n(d.three_bet_percent) * 100,
      format: (val) => `${val.toFixed(1)}%`,
      description: 'How Often You Re-Raise Preflop When You Have The Chance',
    },
    {
      id: 'foldTo3Bet',
      label: 'Fold To 3-Bet %',
      value: n(d.fold_to_three_bet) * 100,
      format: (val) => `${val.toFixed(1)}%`,
      description: 'How Often You Fold After Being Re-Raised Preflop',
    },
    {
      id: 'cbetFreq',
      label: 'C-Bet Frequency',
      value: n(d.cbet_flop) * 100,
      format: (val) => `${val.toFixed(1)}%`,
      description: 'How Often You Bet The Flop After Raising Preflop',
    },
    {
      id: 'bbPer100',
      label: 'BB/100',
      value: n(d.bb_per_100),
      format: (val) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}`,
      description: 'Big Blinds Won Per 100 Cash Hands',
    },
  ];
}

const AdvancedStatsSummary: React.FC<AdvancedStatsSummaryProps> = ({ initialData, rangeLabel }) => {
  const stats = useMemo(() => buildStats(initialData ?? {}), [initialData]);
  const [visibleStats, setVisibleStats] = useState<Set<number>>(new Set());
  const [selectedStat, setSelectedStat] = useState<string | null>(null);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    setVisibleStats(new Set());
    stats.forEach((_, i) => {
      const timer = setTimeout(() => {
        setVisibleStats((prev) => new Set([...prev, i]));
      }, i * 60);
      staggerTimersRef.current.push(timer);
    });
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, [stats]);

  const getTrendColor = (val: number) => {
    if (val > 0) return '#10b981';
    if (val < 0) return '#ef4444';
    return '#8a9aaa';
  };

  return (
    <div className="advanced-stats-summary">
      <div className="stats-header">
        <h3>Advanced Statistics</h3>
        <p className="stats-subtitle">
          Detailed Metrics From Your Play
          {rangeLabel && rangeLabel !== 'All' ? ` Over The Last ${rangeLabel}` : ''}
        </p>
      </div>

      <div className="advanced-stats-grid">
        {stats.map((stat, i) => {
          const isVisible = visibleStats.has(i);
          const isSelected = selectedStat === stat.id;

          return (
            <div
              key={stat.id}
              className={`advanced-stat-card ${isSelected ? 'selected' : ''}`}
              style={{
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateY(0)' : 'translateY(8px)',
                transition: `all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${i * 40}ms`,
              }}
              role="button"
              tabIndex={0}
              aria-expanded={isSelected}
              onClick={() => setSelectedStat(isSelected ? null : stat.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedStat(isSelected ? null : stat.id);
                }
              }}
            >
              <div className="card-top">
                <span className="stat-title">{stat.label}</span>
              </div>

              <div className="card-value">
                <span className="value-main" style={{ color: getTrendColor(stat.value) }}>
                  <AnimatedNumber target={stat.value} format={stat.format} />
                </span>
                {stat.unit && <span className="value-unit">{stat.unit}</span>}
              </div>

              {isSelected && (
                <div
                  className="card-description"
                  style={{
                    animation: 'animationsSlideDown 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <p>{stat.description}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

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
