/**
 * PositionWinRates — Visual breakdown of player performance by table position
 * Shows VPIP, PFR, and win rate for each position
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, getAuthUser } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './PositionWinRates.css';
import { reportError } from '../../utils/errorReporter';

interface PositionStats {
  position: string;
  positionLabel: string;
  handsPlayed: number;
  vpip: number;
  pfr: number;
  threeBet: number; // 3-bet %
  winRate: number; // bb/100
  totalProfit: number;
}

const DEFAULT_STATS: PositionStats[] = [
  {
    position: 'UTG',
    positionLabel: 'Under The Gun',
    handsPlayed: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    winRate: 0,
    totalProfit: 0,
  },
  {
    position: 'UTG+1',
    positionLabel: 'UTG+1',
    handsPlayed: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    winRate: 0,
    totalProfit: 0,
  },
  {
    position: 'MP',
    positionLabel: 'Middle Position',
    handsPlayed: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    winRate: 0,
    totalProfit: 0,
  },
  {
    position: 'CO',
    positionLabel: 'Cutoff',
    handsPlayed: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    winRate: 0,
    totalProfit: 0,
  },
  {
    position: 'BTN',
    positionLabel: 'Button',
    handsPlayed: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    winRate: 0,
    totalProfit: 0,
  },
  {
    position: 'SB',
    positionLabel: 'Small Blind',
    handsPlayed: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    winRate: 0,
    totalProfit: 0,
  },
  {
    position: 'BB',
    positionLabel: 'Big Blind',
    handsPlayed: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    winRate: 0,
    totalProfit: 0,
  },
];

interface PositionWinRatesProps {
  userId?: string;
}

const PositionWinRates: React.FC<PositionWinRatesProps> = ({ userId }) => {
  const [statsData, setStatsData] = useState<PositionStats[]>(DEFAULT_STATS);
  const [visiblePositions, setVisiblePositions] = useState<Set<number>>(new Set());
  const [hoveredPosition, setHoveredPosition] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, []);

  const resolveUserId = useCallback(async (): Promise<string | null> => {
    if (userId) return userId;
    try {
      const { data: userResp } = await getAuthUser();
      return userResp.user?.id || null;
    } catch (e) {
      reportError(e, 'PositionWinRates.useCallback');
      return null;
    }
  }, [userId]);

  const loadPositionStats = useCallback(async () => {
    try {
      const uid = await resolveUserId();
      if (!uid || !mountedRef.current) return;

      const { data: posData, error } = await supabase
        .from('player_position_stats')
        .select(
          'position, hands_played, vpip_count, pfr_count, three_bet_count, hands_won, total_profit'
        )
        .eq('user_id', uid);

      if (!mountedRef.current) return;

      if (!error && posData && posData.length > 0) {
        const updatedStats = DEFAULT_STATS.map((defPos) => {
          const live = posData.find((p) => p.position === defPos.position);
          if (live) {
            const hp = live.hands_played || 0;
            return {
              ...defPos,
              handsPlayed: hp,
              vpip: hp > 0 ? (live.vpip_count / hp) * 100 : 0,
              pfr: hp > 0 ? (live.pfr_count / hp) * 100 : 0,
              threeBet: hp > 0 ? ((live.three_bet_count || 0) / hp) * 100 : 0,
              winRate: hp > 0 ? ((live.hands_won || 0) / hp) * 100 : 0,
              totalProfit: live.total_profit || 0,
            };
          }
          return defPos;
        });
        setStatsData(updatedStats);
      }
    } catch (err) {
      reportError(err, 'PositionWinRates.Failed_to_load');
    }
  }, [resolveUserId]);

  useEffect(() => {
    loadPositionStats();

    // Clear previous stagger timers
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];

    DEFAULT_STATS.forEach((_, i) => {
      const timer = setTimeout(() => {
        if (mountedRef.current) {
          setVisiblePositions((prev) => new Set([...prev, i]));
        }
      }, i * 80);
      staggerTimersRef.current.push(timer);
    });
  }, [loadPositionStats]);

  // Bus listener: refresh position stats when a hand completes
  useEffect(() => {
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => loadPositionStats(),
      2000
    );
    return () => {
      unsubHand();
    };
  }, [loadPositionStats]);

  // Find best and worst positions (with at least 1 hand played to prevent 0.0 ties)
  const activeStats = statsData.filter((s) => s.handsPlayed > 0);
  const bestPosition =
    activeStats.length > 0
      ? activeStats.reduce((best, current) => (current.winRate > best.winRate ? current : best))
      : statsData[0];

  const worstPosition =
    activeStats.length > 0
      ? activeStats.reduce((worst, current) => (current.winRate < worst.winRate ? current : worst))
      : statsData[0];

  const getTrendArrow = (value: number) => {
    if (value > 3) return '↑ Exceptional';
    if (value > 1.5) return '↑ Strong';
    if (value > 0) return '→ Neutral';
    return '↓ Leak';
  };

  const getPositionColor = (winRate: number) => {
    if (winRate > 4) return 'var(--accent-green)';
    if (winRate > 2) return 'var(--accent-cyan)';
    if (winRate > 0) return 'var(--accent-orange)';
    return 'var(--accent-red)';
  };

  return (
    <div className="position-win-rates">
      <div className="position-header">
        <h3>Win Rate by Position</h3>
        <p className="position-subtitle">
          Position profitability at{' '}
          {statsData.reduce((sum, p) => sum + p.handsPlayed, 0).toLocaleString()} hands
        </p>
      </div>

      {/* Circular table diagram */}
      <div className="position-table-diagram">
        <svg width="100%" height="350" viewBox="0 0 400 350" className="position-svg">
          {/* Table ellipse */}
          <ellipse
            cx="200"
            cy="160"
            rx="120"
            ry="100"
            fill="none"
            stroke="rgba(0, 212, 255, 0.15)"
            strokeWidth="2"
          />

          {/* Position markers on circle - arranged like poker table */}
          {statsData.map((pos, i) => {
            const angleStep = (2 * Math.PI) / statsData.length;
            const angle = i * angleStep - Math.PI / 2; // Start from top
            const radius = 130;
            const x = 200 + radius * Math.cos(angle);
            const y = 160 + radius * Math.sin(angle);

            const isVisible = visiblePositions.has(i);
            const isHovered = hoveredPosition === i;

            return (
              <g key={i}>
                {/* Position circle background */}
                <circle
                  cx={x}
                  cy={y}
                  r="45"
                  fill={getPositionColor(pos.winRate)}
                  fillOpacity={isHovered ? 0.25 : 0.1}
                  stroke={getPositionColor(pos.winRate)}
                  strokeWidth={isHovered ? 2 : 1}
                  className="position-circle"
                  style={{
                    opacity: isVisible ? 1 : 0,
                    transform: isVisible ? 'scale(1)' : 'scale(0.8)',
                    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                  onMouseEnter={() => setHoveredPosition(i)}
                  onMouseLeave={() => setHoveredPosition(null)}
                />

                {/* Position label */}
                <text
                  x={x}
                  y={y - 12}
                  textAnchor="middle"
                  className="position-label"
                  fill={getPositionColor(pos.winRate)}
                  style={{
                    opacity: isVisible ? 1 : 0,
                    transition: 'opacity 0.3s ease-out',
                    fontSize: isHovered ? '15px' : '13px',
                    fontWeight: isHovered ? 700 : 600,
                  }}
                >
                  {pos.position}
                </text>

                {/* Win rate value */}
                <text
                  x={x}
                  y={y + 8}
                  textAnchor="middle"
                  className="position-winrate"
                  fill={getPositionColor(pos.winRate)}
                  style={{
                    opacity: isVisible ? 1 : 0,
                    transition: 'opacity 0.3s ease-out',
                    fontSize: '14px',
                    fontWeight: 700,
                  }}
                >
                  {pos.winRate.toFixed(2)}
                </text>

                {/* Hover tooltip background */}
                {isHovered && (
                  <g>
                    <rect
                      x={x - 55}
                      y={y - 75}
                      width="110"
                      height="120"
                      rx="8"
                      fill="rgba(10, 10, 20, 0.95)"
                      stroke={getPositionColor(pos.winRate)}
                      strokeWidth="1.5"
                    />
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {/* Tooltip overlay */}
        {hoveredPosition !== null && (
          <div className="position-tooltip" style={{ display: 'block' }}>
            <div className="tooltip-content">
              <h4>{statsData[hoveredPosition].positionLabel}</h4>
              <div className="tooltip-stat">
                <span>Hands:</span>
                <span>{statsData[hoveredPosition].handsPlayed}</span>
              </div>
              <div className="tooltip-stat">
                <span>VPIP:</span>
                <span>{statsData[hoveredPosition].vpip.toFixed(1)}%</span>
              </div>
              <div className="tooltip-stat">
                <span>PFR:</span>
                <span>{statsData[hoveredPosition].pfr.toFixed(1)}%</span>
              </div>
              <div className="tooltip-stat">
                <span>3-Bet:</span>
                <span>{statsData[hoveredPosition].threeBet.toFixed(1)}%</span>
              </div>
              <div className="tooltip-stat">
                <span>Win Rate:</span>
                <span style={{ color: getPositionColor(statsData[hoveredPosition].winRate) }}>
                  {statsData[hoveredPosition].winRate.toFixed(2)} bb/100
                </span>
              </div>
              <div className="tooltip-stat total">
                <span>Total Profit:</span>
                <span style={{ color: getPositionColor(statsData[hoveredPosition].winRate) }}>
                  {statsData[hoveredPosition].totalProfit > 0 ? '+' : ''}
                  {statsData[hoveredPosition].totalProfit}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Position callouts */}
      <div className="position-callouts">
        <div className="callout strongest">
          <span className="callout-icon">▲</span>
          <div className="callout-text">
            <span className="callout-label">Strongest Position</span>
            <span className="callout-value">{bestPosition.position}</span>
            <span className="callout-detail">{bestPosition.winRate.toFixed(2)} bb/100</span>
          </div>
        </div>
        <div className="callout weakest">
          <span className="callout-icon">▼</span>
          <div className="callout-text">
            <span className="callout-label">Weakest Position</span>
            <span className="callout-value">{worstPosition.position}</span>
            <span className="callout-detail">{worstPosition.winRate.toFixed(2)} bb/100</span>
          </div>
        </div>
      </div>

      {/* Detailed stats grid */}
      <div className="position-stats-grid">
        {statsData.map((pos, i) => {
          const isVisible = visiblePositions.has(i);
          return (
            <div
              key={i}
              className="position-stat-card"
              style={{
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateY(0)' : 'translateY(8px)',
                transition: `all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${i * 30}ms`,
              }}
            >
              <div className="card-header">
                <span className="position-name">{pos.position}</span>
                <span className="win-rate-badge" style={{ color: getPositionColor(pos.winRate) }}>
                  {pos.winRate > 0 ? '+' : ''}
                  {pos.winRate.toFixed(2)}
                </span>
              </div>
              <div className="card-stats">
                <div className="stat">
                  <span className="stat-key">Hands</span>
                  <span className="stat-val">{pos.handsPlayed}</span>
                </div>
                <div className="stat">
                  <span className="stat-key">VPIP</span>
                  <span className="stat-val">{pos.vpip.toFixed(1)}%</span>
                </div>
                <div className="stat">
                  <span className="stat-key">PFR</span>
                  <span className="stat-val">{pos.pfr.toFixed(1)}%</span>
                </div>
              </div>
              <div className="card-progress">
                <div
                  className="progress-bar"
                  style={{
                    width: `${Math.min(100, Math.max(0, (pos.winRate / 5.5) * 100))}%`,
                    backgroundColor: getPositionColor(pos.winRate),
                  }}
                />
              </div>
              <div className="card-trend">
                <span>{getTrendArrow(pos.winRate)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PositionWinRates;
