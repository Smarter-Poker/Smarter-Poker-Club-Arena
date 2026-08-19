/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOURNAMENT STATS DASHBOARD — Compact summary widget
 * Shows key tournament metrics with animated number transitions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { formatDurationMinutes as formatTime } from '@/lib/date';
import './TournamentStatsDashboard.css';

interface TournamentStats {
  playersRemaining: number;
  totalEntries: number;
  averageStack: number;
  largestStack: number;
  smallestStack: number;
  currentLevel: number;
  totalLevels: number;
  timeElapsed: number; // minutes
  handsPlayed?: number;
}

interface TournamentStatsDashboardProps {
  stats: TournamentStats;
  currentBigBlind: number;
}

export const TournamentStatsDashboard: React.FC<TournamentStatsDashboardProps> = ({
  stats,
  currentBigBlind,
}) => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  const formatChips = (amount: number) => {
    if (amount >= 1000000) {
      return (amount / 1000000).toFixed(1) + 'M';
    }
    if (amount >= 1000) {
      return (amount / 1000).toFixed(1) + 'K';
    }
    return amount.toLocaleString();
  };

  const getMRatio = (chips: number) => {
    return currentBigBlind > 0 ? Math.floor(chips / currentBigBlind) : 0;
  };

  const getChipSpread = () => {
    if (stats.largestStack === 0) return 0;
    return Math.round((stats.smallestStack / stats.largestStack) * 100);
  };

  const levelProgress = (stats.currentLevel / stats.totalLevels) * 100;

  return (
    <div
      className="tournament-stats-dashboard"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(12px)',
        transition: 'all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.2s',
      }}
    >
      {/* Grid of stat cards */}
      <div className="stats-grid">
        {/* Players Remaining */}
        <div className="stat-card players">
          <div className="stat-icon">◉</div>
          <div className="stat-content">
            <span className="stat-value">{stats.playersRemaining}</span>
            <span className="stat-label">
              Remaining {stats.totalEntries > 0 && `/ ${stats.totalEntries}`}
            </span>
          </div>
        </div>

        {/* Current Level */}
        <div className="stat-card level">
          <div className="stat-icon">▦</div>
          <div className="stat-content">
            <span className="stat-value">{stats.currentLevel}</span>
            <span className="stat-label">
              Level {stats.currentLevel}/{stats.totalLevels}
            </span>
          </div>
          <div className="stat-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${levelProgress}%` }} />
            </div>
          </div>
        </div>

        {/* Average Stack */}
        <div className="stat-card average">
          <div className="stat-icon">▲</div>
          <div className="stat-content">
            <span className="stat-value">{formatChips(stats.averageStack)}</span>
            <span className="stat-label">Avg ({getMRatio(stats.averageStack)}BB)</span>
          </div>
        </div>

        {/* Largest Stack */}
        <div className="stat-card largest">
          <div className="stat-icon">♛</div>
          <div className="stat-content">
            <span className="stat-value">{formatChips(stats.largestStack)}</span>
            <span className="stat-label">Largest ({getMRatio(stats.largestStack)}BB)</span>
          </div>
        </div>

        {/* Smallest Stack */}
        <div className="stat-card smallest">
          <div className="stat-icon">⚠</div>
          <div className="stat-content">
            <span className="stat-value">{formatChips(stats.smallestStack)}</span>
            <span className="stat-label">Smallest ({getMRatio(stats.smallestStack)}BB)</span>
          </div>
        </div>

        {/* Time Elapsed */}
        <div className="stat-card time">
          <div className="stat-icon">◷</div>
          <div className="stat-content">
            <span className="stat-value">{formatTime(stats.timeElapsed)}</span>
            <span className="stat-label">Time Elapsed</span>
          </div>
        </div>

        {/* Chip Spread */}
        <div className="stat-card spread">
          <div className="stat-icon">▦</div>
          <div className="stat-content">
            <span className="stat-value">{getChipSpread()}%</span>
            <span className="stat-label">Chip Spread</span>
          </div>
        </div>

        {/* Hands Played */}
        {stats.handsPlayed !== undefined && (
          <div className="stat-card hands">
            <div className="stat-icon">◆</div>
            <div className="stat-content">
              <span className="stat-value">{stats.handsPlayed}</span>
              <span className="stat-label">Hands Played</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TournamentStatsDashboard;
