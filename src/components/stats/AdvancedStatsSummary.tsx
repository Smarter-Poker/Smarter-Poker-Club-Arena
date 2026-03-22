/**
 * AdvancedStatsSummary — Dashboard of advanced poker statistics
 * Wired to real Supabase `player_stats` table with bus listeners
 */

import React, { useState, useEffect, useCallback } from 'react';
import { supabase, getAuthUser } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './AdvancedStatsSummary.css';

interface AdvancedStat {
  id: string;
  label: string;
  value: number;
  format: (val: number) => string;
  unit?: string;
  description: string;
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

const AdvancedStatsSummary: React.FC = () => {
  const [stats, setStats] = useState<AdvancedStat[]>([]);
  const [visibleStats, setVisibleStats] = useState<Set<number>>(new Set());
  const [selectedStat, setSelectedStat] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      const { data: userResp } = await getAuthUser();
      if (!userResp.user) return;

      const { data, error } = await supabase
        .from('player_stats')
        .select(
          'total_hands, hands_won, showdowns_won, showdowns_total, vpip, pfr, aggression_factor, three_bet_percent, fold_to_three_bet, cbet_flop, hours_played, total_profit, bb_per_100'
        )
        .eq('user_id', userResp.user.id)
        .maybeSingle();

      if (error || !data) {
        // Show zeros if no data yet
        buildStats(null);
        return;
      }

      buildStats(data);
    } catch (err) {
      console.error('[AdvancedStatsSummary] Failed to load:', err);
      buildStats(null);
    }
  }, []);

  const buildStats = (data: any) => {
    const d = data || {};
    const totalHands = d.total_hands || 0;
    const hoursPlayed = d.hours_played || 0;
    const totalProfit = d.total_profit || 0;
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
        description: 'Profit per hour played',
      },
      {
        id: 'totalHands',
        label: 'Total Hands',
        value: totalHands,
        format: (val) => Math.floor(val).toLocaleString(),
        description: 'Total hands played across all sessions',
      },
      {
        id: 'showdownWin',
        label: 'Showdown Win %',
        value: showdownWinPct,
        format: (val) => `${val.toFixed(1)}%`,
        description: 'Win percentage when reaching showdown',
      },
      {
        id: 'aggression',
        label: 'Aggression Factor',
        value: d.aggression_factor || 0,
        format: (val) => val.toFixed(2),
        description: 'Ratio of aggressive actions to passive actions',
      },
      {
        id: 'threeBet',
        label: '3-Bet %',
        value: (d.three_bet_percent || 0) * 100,
        format: (val) => `${val.toFixed(1)}%`,
        description: 'Percentage of re-raises preflop',
      },
      {
        id: 'foldTo3Bet',
        label: 'Fold to 3-Bet %',
        value: (d.fold_to_three_bet || 0) * 100,
        format: (val) => `${val.toFixed(1)}%`,
        description: 'How often you fold to 3-bet raises',
      },
      {
        id: 'cbetFreq',
        label: 'C-Bet Frequency',
        value: (d.cbet_flop || 0) * 100,
        format: (val) => `${val.toFixed(1)}%`,
        description: 'How often you continuation bet on the flop',
      },
      {
        id: 'bbPer100',
        label: 'BB/100',
        value: d.bb_per_100 || 0,
        format: (val) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}`,
        description: 'Big blinds won per 100 hands — key profitability metric',
      },
    ];

    setStats(built);
    setLoaded(true);

    // Stagger animation
    built.forEach((_, i) => {
      setTimeout(() => {
        setVisibleStats((prev) => new Set([...prev, i]));
      }, i * 60);
    });
  };

  useEffect(() => {
    loadStats();
  }, [loadStats]);

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
        <h3>Advanced Statistics</h3>
        <p className="stats-subtitle">Detailed metrics from your play history</p>
      </div>

      {/* Stats grid */}
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
              onClick={() => setSelectedStat(isSelected ? null : stat.id)}
            >
              {/* Card header */}
              <div className="card-top">
                <span className="stat-title">{stat.label}</span>
              </div>

              {/* Main value */}
              <div className="card-value">
                <span className="value-main" style={{ color: getTrendColor(stat.value) }}>
                  <AnimatedNumber target={stat.value} format={stat.format} />
                </span>
                {stat.unit && <span className="value-unit">{stat.unit}</span>}
              </div>

              {/* Description (shown on select) */}
              {isSelected && (
                <div
                  className="card-description"
                  style={{
                    animation: 'slideDown 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <p>{stat.description}</p>
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
          <p>Big Blinds won per 100 hands — primary win rate metric</p>
        </div>
        <div className="legend-item">
          <span className="legend-label">C-Bet</span>
          <p>Continuation Bet — betting on the flop after raising preflop</p>
        </div>
        <div className="legend-item">
          <span className="legend-label">AF</span>
          <p>Aggression Factor — ratio of aggressive to passive actions</p>
        </div>
      </div>
    </div>
  );
};

export default AdvancedStatsSummary;
