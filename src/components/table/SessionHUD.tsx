/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION HUD — Minimizable floating stats display at table
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { sessionStatsService, type SessionStats } from '../../services/SessionStatsService';
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

  // ── Read the live session ──
  // Dan 2026-08-15: this used to call startSession() on mount and
  // endSession() on unmount, so simply OPENING this panel reset the session to
  // zero and CLOSING it threw the history away — including the Supabase
  // session_history write, which is gated on handsPlayed > 0. The session is
  // now owned by TablePage for as long as hero is seated (see the Session
  // Stats lifecycle block there); this component only reads and subscribes.
  //
  // startSession() is still called defensively when no session exists — e.g.
  // the panel opened from an observer context that never seated hero — so the
  // HUD renders honest zeros instead of a null.
  useEffect(() => {
    if (!sessionStatsService.getStats(tableId)) {
      sessionStatsService.startSession(tableId, userId, initialStackRef.current, bigBlind);
    }
    setStats(sessionStatsService.getStats(tableId));
  }, [tableId, userId, bigBlind]); // initialStack intentionally omitted — captured in ref

  // ── Listen for stats updates ──
  useMasterBusSubscription('SESSION_STATS_UPDATE', (payload: any) => {
    if (payload?.tableId === tableId) {
      setStats(payload.stats);
    }
  });

  // ── Also refresh on HAND_COMPLETED for real-time profit updates ──
  useMasterBusSubscription('HAND_COMPLETED', (payload: any) => {
    if (payload?.tableId === tableId) {
      setStats(sessionStatsService.getStats(tableId));
    }
  });

  // ── Session duration timer (updates every second) ──
  useEffect(() => {
    const formatDuration = () => {
      // Dan 2026-08-15: count from the REAL session start (when hero sat down)
      // rather than when this panel was opened. Previously these were the same
      // instant because the panel owned the session; now that TablePage owns
      // it, using the local mount time would under-report every session.
      const startedAt = sessionStatsService.getStats(tableId)?.sessionStartTime ?? sessionStartTime;
      const elapsed = Date.now() - startedAt;
      const totalMinutes = Math.floor(elapsed / 60_000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    };
    setSessionDuration(formatDuration());
    const timer = setInterval(() => setSessionDuration(formatDuration()), 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime, tableId]);

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
    const strokeColor = isPositive ? '#3fb950' : '#ef4444';

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

  /**
   * Dan 2026-08-19 session-stat additions. Hours are floored at one minute so
   * a session that is seconds old cannot divide by ~0 and print a nonsense
   * hourly rate.
   */
  const hoursElapsed = Math.max((Date.now() - stats.sessionStartTime) / 3_600_000, 1 / 60);
  const profitPerHour = stats.profitLoss / hoursElapsed;
  const bbPerHour = stats.bigBlindsWon / hoursElapsed;
  const winRatePercent =
    stats.handsPlayed > 0 ? Math.round((stats.handsWon / stats.handsPlayed) * 100) : 0;

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
              title={showAdvanced ? 'Hide Details' : 'Show Details'}
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
          {/* Dan 2026-08-19: the headline numbers a grinder actually reads.
              VPIP and PFR were buried behind the advanced toggle; profit per
              hour and win rate did not exist at all. */}
          <div className="sh-qstat">
            <span className={`sh-qstat-value ${plClass}`}>{formatPL(profitPerHour)}</span>
            <span className="sh-qstat-label">$/Hr</span>
          </div>
          <div className="sh-qstat">
            <span className="sh-qstat-value">{stats.vpipPercent}%</span>
            <span className="sh-qstat-label">VPIP</span>
          </div>
          <div className="sh-qstat">
            <span className="sh-qstat-value">{stats.pfrPercent}%</span>
            <span className="sh-qstat-label">PFR</span>
          </div>
          <div className="sh-qstat">
            <span className="sh-qstat-value">{winRatePercent}%</span>
            <span className="sh-qstat-label">Win%</span>
          </div>
          <div className="sh-qstat">
            <span className={`sh-qstat-value ${bbPerHour >= 0 ? 'sh-pos' : 'sh-neg'}`}>
              {bbPerHour.toFixed(1)}
            </span>
            <span className="sh-qstat-label">BB/Hr</span>
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
