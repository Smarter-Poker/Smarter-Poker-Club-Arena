/**
 * ♠ CLUB ARENA — Bankroll Widget
 * Quick session bankroll overview for the table
 */

import React, { useState, useEffect } from 'react';
import './BankrollWidget.css';

interface SessionStats {
  buyIn: number;
  currentStack: number;
  handsPlayed: number;
  sessionDuration: number; // minutes
  bigBlinds: number;
}

interface BankrollWidgetProps {
  stats: SessionStats;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export const BankrollWidget: React.FC<BankrollWidgetProps> = ({
  stats,
  isExpanded = false,
  onToggle,
}) => {
  const [animatedProfit, setAnimatedProfit] = useState(0);

  const profit = stats.currentStack - stats.buyIn;
  const profitPercent = stats.buyIn > 0 ? ((profit / stats.buyIn) * 100).toFixed(1) : '0.0';
  const bbWon = stats.bigBlinds > 0 ? (profit / stats.bigBlinds).toFixed(1) : '0.0';
  const bbPer100 =
    stats.handsPlayed > 0 && stats.bigBlinds > 0
      ? ((profit / stats.bigBlinds / stats.handsPlayed) * 100).toFixed(1)
      : '0.0';

  useEffect(() => {
    // Animate profit changes
    const duration = 500;
    const steps = 20;
    const stepValue = (profit - animatedProfit) / steps;
    let current = animatedProfit;

    const interval = setInterval(() => {
      current += stepValue;
      if ((stepValue > 0 && current >= profit) || (stepValue < 0 && current <= profit)) {
        setAnimatedProfit(profit);
        clearInterval(interval);
      } else {
        setAnimatedProfit(Math.trunc(current * 100) / 100);
      }
    }, duration / steps);

    return () => clearInterval(interval);
  }, [profit]);

  const formatDuration = (minutes: number) => {
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  };

  // EXACT precision — no abbreviations, no rounding
  const formatNumber = (n: number) => {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  return (
    <div className={`bankroll-widget ${isExpanded ? 'expanded' : ''}`}>
      {/* Compact View */}
      <button className="widget-toggle" onClick={onToggle}>
        <div className="compact-view">
          <span className="stack-value">{formatNumber(stats.currentStack)}</span>
          <span className={`profit-badge ${profit >= 0 ? 'positive' : 'negative'}`}>
            {profit >= 0 ? '+' : ''}
            {formatNumber(animatedProfit)}
          </span>
        </div>
        <span className="toggle-icon">{isExpanded ? '▼' : '▲'}</span>
      </button>

      {/* Expanded View */}
      {isExpanded && (
        <div className="expanded-view">
          {/* Session Profit */}
          <div className="profit-section">
            <div className={`profit-display ${profit >= 0 ? 'positive' : 'negative'}`}>
              <span className="profit-label">Session P/L</span>
              <span className="profit-value">
                {profit >= 0 ? '+' : ''}
                {formatNumber(profit)}
              </span>
              <span className="profit-percent">({profitPercent}%)</span>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="stats-grid">
            <div className="stat-item">
              <span className="stat-value">{formatNumber(stats.buyIn)}</span>
              <span className="stat-label">Buy-In</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">{formatNumber(stats.currentStack)}</span>
              <span className="stat-label">Stack</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">{stats.handsPlayed}</span>
              <span className="stat-label">Hands</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">{formatDuration(stats.sessionDuration)}</span>
              <span className="stat-label">Time</span>
            </div>
          </div>

          {/* BB Stats */}
          <div className="bb-stats">
            <div className="bb-item">
              <span className={`bb-value ${parseFloat(bbWon) >= 0 ? 'positive' : 'negative'}`}>
                {bbWon} BB
              </span>
              <span className="bb-label">Won</span>
            </div>
            <div className="bb-divider" />
            <div className="bb-item">
              <span className={`bb-value ${parseFloat(bbPer100) >= 0 ? 'positive' : 'negative'}`}>
                {bbPer100} BB/100
              </span>
              <span className="bb-label">Win Rate</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BankrollWidget;
