/**
 * PositionWinRates — Visual breakdown of player performance by table position
 * Shows VPIP, PFR, 3-bet and bb/100 for each position.
 *
 * PURE PRESENTATION (2026-09-03). This component used to carry its own
 * lifetime `player_position_stats` query as a "fallback", a HAND_COMPLETED bus
 * listener that re-ran it, and a fixed seven-position template it mapped every
 * payload onto. Three defects came from that:
 *
 *   - the fallback was LIFETIME and had no `bb100` column, so under a "7 Days"
 *     label every seat rendered 0.00 BB/100, "Leak" and red;
 *   - LJ, HJ and UNK were silently dropped by the template, so the hands
 *     subtitle undercounted and a nine-handed player never saw two seats;
 *   - `three_bet_count / hands_played` was labelled "3-Bet", which every
 *     player reads as per OPPORTUNITY.
 *
 * The page RPC already returns range-scoped positions (with three_bet_opps as
 * of the 2026-09-03 migration), the page already refetches on every hand, and
 * that array is the only input now. What the RPC returns is what is drawn.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import './PositionWinRates.css';

interface PositionStats {
  position: string;
  positionLabel: string;
  handsPlayed: number;
  vpip: number;
  pfr: number;
  /** Per OPPORTUNITY when the payload carries three_bet_opps, else per hand dealt. */
  threeBet: number;
  threeBetPerOpp: boolean;
  winRate: number; // bb/100
  totalProfit: number;
}

/** Table order, button last. Anything the RPC sends that is not here is appended. */
const POSITION_ORDER = ['UTG', 'UTG+1', 'UTG+2', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

const POSITION_LABELS: Record<string, string> = {
  UTG: 'Under The Gun',
  'UTG+1': 'UTG+1',
  'UTG+2': 'UTG+2',
  MP: 'Middle Position',
  LJ: 'Lojack',
  HJ: 'Hijack',
  CO: 'Cutoff',
  BTN: 'Button',
  SB: 'Small Blind',
  BB: 'Big Blind',
  UNK: 'Unknown Seat',
};

interface PositionRowLike {
  position?: string | null;
  hands_played?: number | null;
  vpip_count?: number | null;
  pfr_count?: number | null;
  three_bet_count?: number | null;
  three_bet_opps?: number | null;
  total_profit?: number | null;
  bb100?: number | null;
}

interface PositionWinRatesProps {
  userId?: string;
  /** Range-scoped rows from the page RPC (ca_player_stats_overview_v2.positions). */
  initialPositions?: PositionRowLike[] | null;
  /** The page's analysis window, for the subtitle. `null` is all time. */
  days?: number | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function mapRows(rows: PositionRowLike[]): PositionStats[] {
  const out: PositionStats[] = [];
  for (const live of rows) {
    const position = typeof live?.position === 'string' && live.position ? live.position : 'UNK';
    const hp = num(live?.hands_played);
    if (hp <= 0) continue;
    const opps = num(live?.three_bet_opps);
    const perOpp = opps > 0;
    out.push({
      position,
      positionLabel: POSITION_LABELS[position] ?? position,
      handsPlayed: hp,
      vpip: (num(live?.vpip_count) / hp) * 100,
      pfr: (num(live?.pfr_count) / hp) * 100,
      threeBet: perOpp
        ? (num(live?.three_bet_count) / opps) * 100
        : (num(live?.three_bet_count) / hp) * 100,
      threeBetPerOpp: perOpp,
      winRate: num(live?.bb100),
      totalProfit: num(live?.total_profit),
    });
  }
  const rank = (p: string) => {
    const i = POSITION_ORDER.indexOf(p);
    return i === -1 ? POSITION_ORDER.length : i;
  };
  return out.sort((a, b) => rank(a.position) - rank(b.position));
}

const PositionWinRates: React.FC<PositionWinRatesProps> = ({ initialPositions, days = null }) => {
  const statsData = useMemo(
    () => mapRows(Array.isArray(initialPositions) ? initialPositions : []),
    [initialPositions]
  );
  const [visiblePositions, setVisiblePositions] = useState<Set<number>>(new Set());
  const [hoveredPosition, setHoveredPosition] = useState<number | null>(null);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Stagger the entrance once per data set; a new range restarts it.
  useEffect(() => {
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    setVisiblePositions(new Set());
    setHoveredPosition(null);
    statsData.forEach((_, i) => {
      const timer = setTimeout(() => {
        setVisiblePositions((prev) => new Set([...prev, i]));
      }, i * 80);
      staggerTimersRef.current.push(timer);
    });
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, [statsData]);

  const totalHands = statsData.reduce((sum, p) => sum + p.handsPlayed, 0);
  const bestPosition =
    statsData.length > 0
      ? statsData.reduce((best, current) => (current.winRate > best.winRate ? current : best))
      : null;
  const worstPosition =
    statsData.length > 0
      ? statsData.reduce((worst, current) => (current.winRate < worst.winRate ? current : worst))
      : null;

  const getTrendArrow = (value: number) => {
    if (value > 3) return '↑ Exceptional';
    if (value > 1.5) return '↑ Strong';
    if (value >= 0) return '→ Neutral';
    return '↓ Losing';
  };

  const getPositionColor = (winRate: number) => {
    if (winRate > 4) return 'var(--accent-green)';
    if (winRate > 2) return 'var(--accent-cyan)';
    if (winRate >= 0) return 'var(--accent-orange)';
    return 'var(--accent-red)';
  };

  const hovered = hoveredPosition !== null ? statsData[hoveredPosition] : null;
  const anyPerOpp = statsData.some((p) => p.threeBetPerOpp);

  return (
    <div className="position-win-rates">
      <div className="position-header">
        <h3>Win Rate By Position</h3>
        <p className="position-subtitle">
          Position Profitability At {totalHands.toLocaleString()} Hands
          {days ? ` In The Last ${days} Days` : ''}
        </p>
      </div>

      {statsData.length === 0 && (
        <div className="position-subtitle" style={{ textAlign: 'center', padding: '8px 0' }}>
          No Position Data In This Window Yet.
        </div>
      )}

      {statsData.length > 0 && (
        <div className="position-table-diagram">
          <svg width="100%" height="350" viewBox="0 0 400 350" className="position-svg">
            <ellipse
              cx="200"
              cy="160"
              rx="120"
              ry="100"
              fill="none"
              stroke="rgba(0, 212, 255, 0.15)"
              strokeWidth="2"
            />

            {statsData.map((pos, i) => {
              const angleStep = (2 * Math.PI) / statsData.length;
              const angle = i * angleStep - Math.PI / 2;
              const radius = 130;
              const x = 200 + radius * Math.cos(angle);
              const y = 160 + radius * Math.sin(angle);

              const isVisible = visiblePositions.has(i);
              const isHovered = hoveredPosition === i;

              return (
                <g key={pos.position}>
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
                    tabIndex={0}
                    role="button"
                    aria-label={`${pos.position}, ${pos.winRate.toFixed(1)} BB Per 100`}
                    onMouseEnter={() => setHoveredPosition(i)}
                    onMouseLeave={() => setHoveredPosition(null)}
                    onFocus={() => setHoveredPosition(i)}
                    onBlur={() => setHoveredPosition(null)}
                    onClick={() => setHoveredPosition((cur) => (cur === i ? null : i))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setHoveredPosition((cur) => (cur === i ? null : i));
                      }
                    }}
                  />
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
                </g>
              );
            })}
          </svg>

          {hovered && (
            <div className="position-tooltip" style={{ display: 'block' }}>
              <div className="tooltip-content">
                <h4>{hovered.positionLabel}</h4>
                <div className="tooltip-stat">
                  <span>Hands:</span>
                  <span>{hovered.handsPlayed.toLocaleString()}</span>
                </div>
                <div className="tooltip-stat">
                  <span>VPIP:</span>
                  <span>{hovered.vpip.toFixed(1)}%</span>
                </div>
                <div className="tooltip-stat">
                  <span>PFR:</span>
                  <span>{hovered.pfr.toFixed(1)}%</span>
                </div>
                <div className="tooltip-stat">
                  <span>
                    {hovered.threeBetPerOpp
                      ? '3-Bet (Per Opportunity):'
                      : '3-Bet (Per Hand Dealt):'}
                  </span>
                  <span>{hovered.threeBet.toFixed(1)}%</span>
                </div>
                <div className="tooltip-stat">
                  <span>Win Rate:</span>
                  <span style={{ color: getPositionColor(hovered.winRate) }}>
                    {hovered.winRate.toFixed(2)} BB/100
                  </span>
                </div>
                <div className="tooltip-stat total">
                  <span>Total Profit:</span>
                  <span style={{ color: getPositionColor(hovered.winRate) }}>
                    {hovered.totalProfit > 0 ? '+' : ''}
                    {hovered.totalProfit.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {bestPosition && worstPosition && statsData.length > 1 && (
        <div className="position-callouts">
          <div className="callout strongest">
            <span className="callout-icon">▲</span>
            <div className="callout-text">
              <span className="callout-label">Strongest Position</span>
              <span className="callout-value">{bestPosition.position}</span>
              <span className="callout-detail">{bestPosition.winRate.toFixed(2)} BB/100</span>
            </div>
          </div>
          <div className="callout weakest">
            <span className="callout-icon">▼</span>
            <div className="callout-text">
              <span className="callout-label">Weakest Position</span>
              <span className="callout-value">{worstPosition.position}</span>
              <span className="callout-detail">{worstPosition.winRate.toFixed(2)} BB/100</span>
            </div>
          </div>
        </div>
      )}

      {statsData.length > 0 && (
        <div className="position-stats-grid">
          {statsData.map((pos, i) => {
            const isVisible = visiblePositions.has(i);
            return (
              <div
                key={pos.position}
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
                    <span className="stat-val">{pos.handsPlayed.toLocaleString()}</span>
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
      )}

      {statsData.length > 0 && (
        <p className="position-subtitle" style={{ marginTop: 8 }}>
          {anyPerOpp
            ? '3-Bet Is Measured Per Opportunity To Re-Raise.'
            : '3-Bet Is Measured Per Hand Dealt For This Payload.'}{' '}
          Positions Under A Few Hundred Hands Swing A Long Way; Read The Shape, Not The Decimals.
        </p>
      )}
    </div>
  );
};

export default PositionWinRates;
