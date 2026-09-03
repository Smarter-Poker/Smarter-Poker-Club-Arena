/**
 * TierProgressionCard — Visual VIP tier progression with animated progress
 * Shows current tier, next tier, and progress toward promotion with activity metrics
 */

import React, { useEffect, useState } from 'react';
import { VIP_TIERS, getTierByPoints, getNextTier } from '../../constants/vipTiers';
import './TierProgressionCard.css';

interface TierProgressionCardProps {
  currentPoints: number;
  lifetimePoints: number;
  monthlyPoints: number;
  activeStreak: number;
}

const AnimatedCounter: React.FC<{ value: number; duration?: number }> = ({
  value,
  duration = 1000,
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

export const TierProgressionCard: React.FC<TierProgressionCardProps> = ({
  currentPoints,
  lifetimePoints,
  monthlyPoints,
  activeStreak,
}) => {
  const currentTier = getTierByPoints(currentPoints);
  const nextTier = getNextTier(currentTier.id);

  // Calculate progress to next tier
  const progressToNext = nextTier
    ? ((currentPoints - currentTier.minPoints) / (nextTier.minPoints - currentTier.minPoints)) * 100
    : 100;

  const pointsToNextTier = nextTier ? nextTier.minPoints - currentPoints : 0;
  const estimatedDaysToNextTier =
    monthlyPoints > 0 ? Math.ceil(pointsToNextTier / (monthlyPoints / 30)) : 0;

  return (
    <div className="tier-progression-card">
      {/* Header with Current Tier Badge */}
      <div className="progression-header">
        <div
          className="tier-badge-large"
          style={{ '--tier-color': currentTier.color } as React.CSSProperties}
        >
          <span className="tier-icon">{currentTier.icon}</span>
          <div className="tier-badge-info">
            <span className="tier-name">{currentTier.name}</span>
            <span className="tier-label">VIP Tier</span>
          </div>
          <div className="tier-glow" style={{ boxShadow: `0 0 30px ${currentTier.color}` }} />
        </div>

        {/* Key Stats */}
        <div className="progression-stats">
          <div className="stat-item">
            <span className="stat-value">
              <AnimatedCounter value={currentPoints} />
            </span>
            <span className="stat-label">Current Points</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">
              <AnimatedCounter value={monthlyPoints} />
            </span>
            <span className="stat-label">This Month</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{activeStreak}</span>
            <span className="stat-label">Day Streak</span>
          </div>
        </div>
      </div>

      {/* Large Animated Progress Bar */}
      {nextTier && (
        <div className="progression-section">
          <div className="progress-container">
            <div className="progress-labels">
              <span className="progress-current">{currentTier.name}</span>
              <span className="progress-next">{nextTier.name}</span>
            </div>

            <div className="progress-bar-wrapper">
              <div
                className="progress-bar"
                style={{
                  background: `linear-gradient(90deg, ${currentTier.color}, ${nextTier.color})`,
                }}
              >
                <div
                  className="progress-fill"
                  style={{
                    width: `${progressToNext}%`,
                    background: `linear-gradient(90deg, ${currentTier.color}, ${nextTier.color})`,
                  }}
                />
                <div className="progress-indicator" style={{ left: `${progressToNext}%` }} />
              </div>
            </div>

            <div className="progress-info">
              <span className="progress-text">
                <span className="points-remaining">
                  <AnimatedCounter value={Math.max(0, pointsToNextTier)} />
                </span>
                Points To <strong>{nextTier.name}</strong>
              </span>
              {estimatedDaysToNextTier > 0 && (
                <span className="estimated-time">
                  ≈ {estimatedDaysToNextTier} Days At Current Rate
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mini Tier Roadmap */}
      <div className="tier-roadmap">
        <span className="roadmap-title">Your VIP Journey</span>
        <div className="tier-list">
          {VIP_TIERS.map((tier, idx) => {
            const isCurrentTier = tier.id === currentTier.id;
            const isPastTier = currentPoints >= tier.minPoints;

            return (
              <div
                key={tier.id}
                className={`tier-roadmap-item ${isCurrentTier ? 'current' : ''} ${isPastTier ? 'unlocked' : ''}`}
                style={{ '--tier-color': tier.color } as React.CSSProperties}
              >
                <div className="roadmap-icon">{tier.icon}</div>
                <div className="roadmap-name">{tier.name}</div>
                {isCurrentTier && <div className="current-indicator">●</div>}
                {!isCurrentTier && idx < VIP_TIERS.length - 1 && (
                  <div
                    className={`roadmap-arrow ${idx === VIP_TIERS.findIndex((t) => t.id === currentTier.id) ? 'active' : ''}`}
                  >
                    →
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Tier Benefits Preview */}
      <div className="benefits-summary">
        <span className="benefits-title">Your {currentTier.name} Benefits</span>
        <div className="benefits-grid">
          <div className="benefit-card">
            <span className="benefit-icon">$</span>
            <span className="benefit-value">{currentTier.rakeback}%</span>
            <span className="benefit-label">Rakeback</span>
          </div>
          <div className="benefit-card">
            <span className="benefit-icon">T</span>
            <span className="benefit-value">{currentTier.tournyTickets}</span>
            <span className="benefit-label">Monthly Tickets</span>
          </div>
          <div className="benefit-card">
            <span className="benefit-icon">▲</span>
            <span className="benefit-value">{currentTier.multiplier}x</span>
            <span className="benefit-label">Point Multiplier</span>
          </div>
          {currentTier.priority && (
            <div className="benefit-card">
              <span className="benefit-icon">*</span>
              <span className="benefit-value">Yes</span>
              <span className="benefit-label">Priority Support</span>
            </div>
          )}
        </div>
      </div>

      {/* Lifetime Stats */}
      <div className="lifetime-stats">
        <span className="stats-title">Career Overview</span>
        <div className="lifetime-value">
          <AnimatedCounter value={lifetimePoints} duration={1500} />
          <span className="lifetime-label">Lifetime VIP Points</span>
        </div>
      </div>
    </div>
  );
};

export default TierProgressionCard;
