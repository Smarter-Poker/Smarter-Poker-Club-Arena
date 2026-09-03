/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION STATS TRACKER — Real-Time Session Performance
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import './SessionStatsTracker.css';

interface SessionStatsTrackerProps {
  sessionStart: Date;
  handsPlayed: number;
  totalWon: number;
  totalLost: number;
  vpip?: number; // Voluntarily Put In Pot %
  pfr?: number; // Pre-Flop Raise %
  bigBlind: number;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export function SessionStatsTracker({
  sessionStart,
  handsPlayed,
  totalWon,
  totalLost,
  vpip = 0,
  pfr = 0,
  bigBlind,
  isExpanded = false,
  onToggle,
}: SessionStatsTrackerProps) {
  const [elapsedTime, setElapsedTime] = useState('0:00');

  const netProfit = totalWon - totalLost;
  const bbWon = bigBlind > 0 ? netProfit / bigBlind : 0;
  const bbPer100 = handsPlayed > 0 ? (bbWon / handsPlayed) * 100 : 0;

  useEffect(() => {
    const interval = setInterval(() => {
      const diff = Date.now() - sessionStart.getTime();
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setElapsedTime(
        hours > 0
          ? `${hours}:${minutes.toString().padStart(2, '0')}`
          : `0:${minutes.toString().padStart(2, '0')}`
      );
    }, 1000);

    return () => clearInterval(interval);
  }, [sessionStart]);

  return (
    <div className={`session-stats ${isExpanded ? 'expanded' : ''}`} onClick={onToggle}>
      {/* Compact View */}
      <div className="session-stats__compact">
        <div className="stat-primary">
          <span className={`value ${netProfit >= 0 ? 'positive' : 'negative'}`}>
            {netProfit >= 0 ? '+' : ''}
            {netProfit.toLocaleString()}
          </span>
          <span className="label">Net</span>
        </div>
        <div className="stat-secondary">
          <span className="value">{handsPlayed}</span>
          <span className="label">Hands</span>
        </div>
        <div className="stat-secondary">
          <span className="value">{elapsedTime}</span>
          <span className="label">Time</span>
        </div>
      </div>

      {/* Expanded View */}
      {isExpanded && (
        <div className="session-stats__expanded">
          <div className="stats-grid">
            <div className="stat">
              <span className="label">Won</span>
              <span className="value positive">+{totalWon.toLocaleString()}</span>
            </div>
            <div className="stat">
              <span className="label">Lost</span>
              <span className="value negative">-{totalLost.toLocaleString()}</span>
            </div>
            <div className="stat">
              <span className="label">BB/100</span>
              <span className={`value ${bbPer100 >= 0 ? 'positive' : 'negative'}`}>
                {bbPer100.toFixed(1)}
              </span>
            </div>
            <div className="stat">
              <span className="label">VPIP</span>
              <span className="value">{vpip.toFixed(1)}%</span>
            </div>
            <div className="stat">
              <span className="label">PFR</span>
              <span className="value">{pfr.toFixed(1)}%</span>
            </div>
            <div className="stat">
              <span className="label">BB Won</span>
              <span className={`value ${bbWon >= 0 ? 'positive' : 'negative'}`}>
                {bbWon.toFixed(1)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SessionStatsTracker;
