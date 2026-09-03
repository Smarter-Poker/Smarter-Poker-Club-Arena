/**
 * VIPStatsHeader — Compact premium header showing key VIP stats
 * Displays tier badge, points balance, monthly earnings, and streak
 */

import React, { useEffect, useState } from 'react';
import { getTierByPoints } from '../../constants/vipTiers';
import './VIPStatsHeader.css';

interface VIPStatsHeaderProps {
  currentPoints: number;
  monthlyPoints: number;
  lifetimePoints: number;
  activeStreak: number;
  daysSinceReview: number;
}

const AnimatedValue: React.FC<{ value: number; duration?: number }> = ({
  value,
  duration = 800,
}) => {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    let startTime: number;
    let animationId: number;

    const animate = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      setDisplayValue(Math.floor(value * progress));

      if (progress < 1) {
        animationId = requestAnimationFrame(animate);
      }
    };

    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, [value, duration]);

  return <>{displayValue.toLocaleString()}</>;
};

export const VIPStatsHeader: React.FC<VIPStatsHeaderProps> = ({
  currentPoints,
  monthlyPoints,
  lifetimePoints,
  activeStreak,
  daysSinceReview,
}) => {
  const currentTier = getTierByPoints(currentPoints);

  return (
    <div className="vip-stats-header">
      <div className="stats-grid">
        {/* Tier Badge */}
        <div className="stat-section tier-badge-section">
          <div
            className="tier-badge"
            style={{ '--tier-color': currentTier.color } as React.CSSProperties}
          >
            <span className="tier-icon">{currentTier.icon}</span>
            <div className="tier-info">
              <span className="tier-title">{currentTier.name} VIP</span>
              <span className="tier-description">Current Tier</span>
            </div>
            <div className="badge-glow" style={{ boxShadow: `0 0 20px ${currentTier.color}` }} />
          </div>
        </div>

        {/* Stats Grid */}
        <div className="stats-container">
          <div className="stat-card">
            <span className="stat-icon">*</span>
            <div className="stat-content">
              <span className="stat-value">
                <AnimatedValue value={lifetimePoints} duration={1200} />
              </span>
              <span className="stat-label">Lifetime Points</span>
            </div>
          </div>

          <div className="stat-card">
            <span className="stat-icon">+</span>
            <div className="stat-content">
              <span className="stat-value">
                <AnimatedValue value={monthlyPoints} />
              </span>
              <span className="stat-label">This Month</span>
            </div>
          </div>

          <div className="stat-card">
            <span className="stat-icon">O</span>
            <div className="stat-content">
              <span className="stat-value">
                <AnimatedValue value={currentPoints} />
              </span>
              <span className="stat-label">Current Balance</span>
            </div>
          </div>

          <div className="stat-card">
            <span className="stat-icon">~</span>
            <div className="stat-content">
              <span className="stat-value">{activeStreak}</span>
              <span className="stat-label">Day Streak</span>
            </div>
          </div>

          <div className="stat-card">
            <span className="stat-icon">#</span>
            <div className="stat-content">
              <span className="stat-value">{daysSinceReview}</span>
              <span className="stat-label">Days To Review</span>
            </div>
          </div>
        </div>
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <div className="status-item">
          <span className="status-indicator" style={{ backgroundColor: currentTier.color }} />
          <span className="status-text">VIP Status Active</span>
        </div>
        <div className="status-divider" />
        <div className="status-item">
          <span className="status-indicator earning" />
          <span className="status-text">Earning Points</span>
        </div>
      </div>
    </div>
  );
};

export default VIPStatsHeader;
