/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION TRAJECTORY MINI — Sparkline P&L graph for table HUD overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact SVG sparkline showing the session's profit/loss trajectory.
 * Designed to overlay on the table felt for real-time session awareness.
 * Data source: SessionStatsService.getStats().trajectory
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { sessionStatsService, type SessionStats } from '../../services/SessionStatsService';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './SessionTrajectoryMini.css';

interface SessionTrajectoryMiniProps {
  tableId: string;
  bigBlind: number;
}

export const SessionTrajectoryMini = memo(function SessionTrajectoryMini({
  tableId,
  bigBlind,
}: SessionTrajectoryMiniProps) {
  const [stats, setStats] = useState<SessionStats | null>(null);

  useEffect(() => {
    setStats(sessionStatsService.getStats(tableId));
  }, [tableId]);

  useMasterBusSubscription('SESSION_STATS_UPDATE', (payload: any) => {
    if (payload?.tableId === tableId) {
      setStats(payload.stats);
    }
  });

  const renderPath = useCallback(() => {
    if (!stats || stats.trajectory.length < 3) return null;

    const values = stats.trajectory.map((t) => t[1]);
    const baseline = stats.buyInTotal;
    const plValues = values.map((v) => v - baseline);
    const min = Math.min(...plValues);
    const max = Math.max(...plValues);
    const range = max - min || 1;

    const W = 160;
    const H = 48;
    const PAD = 4;
    const usableH = H - PAD * 2;

    // Generate SVG path
    const points = plValues.map((v, i) => {
      const x = (i / (plValues.length - 1)) * W;
      const y = PAD + usableH - ((v - min) / range) * usableH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    // Zero line position
    const zeroY = PAD + usableH - ((0 - min) / range) * usableH;
    const isPositive = plValues[plValues.length - 1] >= 0;
    const strokeColor = isPositive ? '#22c55e' : '#ef4444';
    const currentPL = plValues[plValues.length - 1];
    const plBB = bigBlind > 0 ? (currentPL / bigBlind).toFixed(1) : '0.0';

    return (
      <svg className="stm-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {/* Zero baseline */}
        <line
          x1="0"
          y1={zeroY}
          x2={W}
          y2={zeroY}
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="0.5"
          strokeDasharray="2,2"
        />
        {/* Gradient fill under the line */}
        <defs>
          <linearGradient id={`stm-grad-${tableId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.3" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon
          points={`0,${zeroY} ${points.join(' ')} ${W},${zeroY}`}
          fill={`url(#stm-grad-${tableId})`}
        />
        {/* Main line */}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Current value dot */}
        {points.length > 0 && (
          <circle
            cx={W}
            cy={parseFloat(points[points.length - 1].split(',')[1])}
            r="2.5"
            fill={strokeColor}
            className="stm-dot"
          />
        )}
        {/* P&L label */}
        <text x={W - 4} y={10} textAnchor="end" className="stm-label" fill={strokeColor}>
          {currentPL >= 0 ? '+' : ''}
          {currentPL.toLocaleString()}
        </text>
        <text
          x={W - 4}
          y={H - 4}
          textAnchor="end"
          className="stm-label-bb"
          fill="rgba(255,255,255,0.5)"
        >
          {currentPL >= 0 ? '+' : ''}
          {plBB} BB
        </text>
      </svg>
    );
  }, [stats, bigBlind, tableId]);

  if (!stats || stats.trajectory.length < 3) return null;

  return <div className="session-trajectory-mini">{renderPath()}</div>;
});

export default SessionTrajectoryMini;
