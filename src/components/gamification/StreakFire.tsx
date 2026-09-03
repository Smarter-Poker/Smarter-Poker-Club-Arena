/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ STREAK FIRE — Q3 Social Upgrade (Phase 4: Engagement Engine)
 * Animated fire visual for daily login streaks.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './StreakFire.css';

interface StreakFireProps {
  streakCount: number;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Fire animation intensity scales with streak length:
 * - 1-3 days:   Small ember (orange)
 * - 4-7 days:   Medium flame (orange-red)
 * - 8-14 days:  Large blaze (red-yellow)
 * - 15-29 days: Inferno (blue-white)
 * - 30+ days:   Supernova (prismatic)
 */
export const StreakFire: React.FC<StreakFireProps> = ({
  streakCount,
  showLabel = true,
  size = 'md',
  className = '',
}) => {
  if (streakCount <= 0) return null;

  const getFireTier = (): string => {
    if (streakCount >= 30) return 'supernova';
    if (streakCount >= 15) return 'inferno';
    if (streakCount >= 8) return 'blaze';
    if (streakCount >= 4) return 'flame';
    return 'ember';
  };

  const tier = getFireTier();

  return (
    <div className={`streak-fire streak-fire-${size} streak-${tier} ${className}`}>
      <div className="fire-container">
        {/* Layered fire SVG */}
        <svg viewBox="0 0 36 48" className="fire-svg" xmlns="http://www.w3.org/2000/svg">
          {/* Outer glow */}
          <path
            className="fire-glow"
            d="M18 4C18 4 6 18 6 28C6 36 11 44 18 44C25 44 30 36 30 28C30 18 18 4 18 4Z"
          />
          {/* Main flame */}
          <path
            className="fire-main"
            d="M18 8C18 8 10 20 10 28C10 34 13 40 18 40C23 40 26 34 26 28C26 20 18 8 18 8Z"
          />
          {/* Inner flame */}
          <path
            className="fire-inner"
            d="M18 16C18 16 13 24 13 30C13 34 15 38 18 38C21 38 23 34 23 30C23 24 18 16 18 16Z"
          />
          {/* Core */}
          <ellipse className="fire-core" cx="18" cy="34" rx="4" ry="5" />
        </svg>

        {/* Particle sparks */}
        {streakCount >= 8 && (
          <div className="spark-container">
            <span className="spark spark-1" />
            <span className="spark spark-2" />
            <span className="spark spark-3" />
          </div>
        )}
      </div>

      {showLabel && <span className="streak-count">{streakCount}</span>}
    </div>
  );
};

export default StreakFire;
