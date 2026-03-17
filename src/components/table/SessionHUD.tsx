/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION HUD — Minimizable floating stats display at table
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { sessionStatsService, type SessionStats } from '../../services/SessionStatsService';
import { masterBus } from '../../core/MasterBus';
import './SessionHUD.css';

interface SessionHUDProps {
  isOpen: boolean;
  onClose: () => void;
  tableId: string;
  userId: string;
  initialStack: number;
  bigBlind: number;
}

// ── Tier classification helpers ──
function getVpipTier(vpip: number): string {
  if (vpip <= 18) return 'tight';
  if (vpip <= 28) return 'normal';
  if (vpip <= 40) return 'loose';
  return 'maniac';
}

function getPfrTier(pfr: number): string {
  if (pfr <= 12) return 'tight';
  if (pfr <= 22) return 'normal';
  return 'aggressive';
}

export const SessionHUD: React.FC<SessionHUDProps> = ({
  isOpen,
  onClose,
  tableId,
  userId,
  initialStack,
  bigBlind,
}) => {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [sessionDuration, setSessionDuration] = useState('0m');
  const [sessionStartTime] = useState(() => Date.now());

  // Capture initialStack only on first mount — do NOT let stack updates restart session
  const initialStackRef = useRef(initialStack);

  // ── Initialize session tracking ──
  useEffect(() => {
    sessionStatsService.startSession(tableId, userId, initialStackRef.current, bigBlind);
    setStats(sessionStatsService.getStats(tableId));

    return () => {
      sessionStatsService.endSession(tableId);
    };
  }, [tableId, userId, bigBlind]); // initialStack intentionally omitted — captured in ref

  // ── Listen for stats updates ──
  useEffect(() => {
    const unsub = masterBus.subscribe('SESSION_STATS_UPDATE', (event: any) => {
      if (event?.payload?.tableId === tableId) {
        setStats(event.payload.stats);
      }
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [tableId]);

  // ── Also refresh on HAND_COMPLETED for real-time profit updates ──
  useEffect(() => {
    const unsub = masterBus.subscribe('HAND_COMPLETED', (event: any) => {
      if (event?.payload?.tableId === tableId) {
        setStats(sessionStatsService.getStats(tableId));
      }
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [tableId]);

  // ── Session duration timer (updates every second) ──
  useEffect(() => {
    const formatDuration = () => {
      const elapsed = Date.now() - sessionStartTime;
      const totalMinutes = Math.floor(elapsed / 60_000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    };
    setSessionDuration(formatDuration());
    const timer = setInterval(() => setSessionDuration(formatDuration()), 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  const formatPL = (value: number): string => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toLocaleString()}`;
  };

  // ── Mini sparkline (CSS-only, using trajectory points) ──
  const renderSparkline = useCallback(() => {
    if (!stats || stats.trajectory.length < 3) return null;

    const values = stats.trajectory.map((t) => t[1]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    // Generate SVG polyline points
    const width = 120;
    const height = 32;
    const points = values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * width;
        const y = height - ((v - min) / range) * (height - 4) - 2;
        return `${x},${y}`;
      })
      .join(' ');

    const isPositive = values[values.length - 1] >= values[0];
    const strokeColor = isPositive ? '#22c55e' : '#ef4444';

    return (
      <svg className="sh-sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <polyline
          points={points}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }, [stats]);

  if (!isOpen || !stats) return null;

  const plClass = stats.profitLoss >= 0 ? 'sh-positive' : 'sh-negative';

  return (
    <div className="session-hud-overlay" onClick={onClose}>
      <div className="session-hud" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="sh-header">
          <span className="sh-title">Session Stats</span>
          <div className="sh-controls">
            <button
              className="sh-toggle"
              onClick={() => setShowAdvanced(!showAdvanced)}
              title={showAdvanced ? 'Hide details' : 'Show details'}
            >
              {showAdvanced ? '▾' : '▸'}
            </button>
            <button className="sh-minimize" onClick={onClose} title="Close">
              ×
            </button>
          </div>
        </div>

        {/* ── P&L Display ── */}
        <div className="sh-pl-section">
          <span className={`sh-pl-value ${plClass}`}>{formatPL(stats.profitLoss)}</span>
          <span className="sh-pl-bb">({formatPL(stats.bigBlindsWon)} BB)</span>
        </div>

        {/* ── Sparkline ── */}
        <div className="sh-sparkline-wrapper">{renderSparkline()}</div>

        {/* ── Quick Stats ── */}
        <div className="sh-quick-stats">
          <div className="sh-qstat">
            <span className="sh-qstat-value">{stats.handsPlayed}</span>
            <span className="sh-qstat-label">Hands</span>
          </div>
          <div className="sh-qstat">
            <span className="sh-qstat-value">{stats.handsPerHour}</span>
            <span className="sh-qstat-label">H/Hr</span>
          </div>
          <div className="sh-qstat">
            <span className="sh-qstat-value">{stats.handsWon}</span>
            <span className="sh-qstat-label">Won</span>
          </div>
          <div className="sh-qstat">
            <span className="sh-qstat-value">{sessionDuration}</span>
            <span className="sh-qstat-label">Time</span>
          </div>
          <div className="sh-qstat">
            <span className={`sh-qstat-value ${stats.handsPlayed > 0 ? plClass : ''}`}>
              {stats.handsPlayed > 0
                ? ((stats.bigBlindsWon / stats.handsPlayed) * 100).toFixed(1)
                : '0.0'}
            </span>
            <span className="sh-qstat-label">BB/100</span>
          </div>
        </div>

        {/* ── Advanced Stats (togglable) ── */}
        {showAdvanced && (
          <div className="sh-advanced">
            <div className="sh-adv-row">
              <span className="sh-adv-label">VPIP</span>
              <div className="sh-adv-bar">
                <div
                  className="sh-adv-fill sh-vpip-fill"
                  data-vpip-tier={getVpipTier(stats.vpipPercent)}
                  style={{ width: `${Math.min(stats.vpipPercent, 100)}%` }}
                />
              </div>
              <span className="sh-adv-value">{stats.vpipPercent}%</span>
              {stats.handsWon >= 3 &&
                stats.handsPlayed > 0 &&
                stats.handsWon / stats.handsPlayed > 0.4 && (
                  <span className="sh-hot-streak">{stats.handsWon}W</span>
                )}
            </div>
            <div className="sh-adv-row">
              <span className="sh-adv-label">PFR</span>
              <div className="sh-adv-bar">
                <div
                  className="sh-adv-fill sh-pfr-fill"
                  data-pfr-tier={getPfrTier(stats.pfrPercent)}
                  style={{ width: `${Math.min(stats.pfrPercent, 100)}%` }}
                />
              </div>
              <span className="sh-adv-value">{stats.pfrPercent}%</span>
            </div>
            <div className="sh-adv-row">
              <span className="sh-adv-label">Buy-In</span>
              <span className="sh-adv-value">{stats.buyInTotal.toLocaleString()}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionHUD;
