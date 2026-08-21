/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STREAK BADGE — Hot streak indicator for table HUD
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays a fire/streak indicator when the player is on a winning streak.
 * Shows animated badge with streak count.
 */

import { memo } from 'react';
import './StreakBadge.css';

interface StreakBadgeProps {
  streak: number;
}

export const StreakBadge = memo(function StreakBadge({ streak }: StreakBadgeProps) {
  if (streak < 2) return null;

  const tier =
    streak >= 10
      ? 'legendary'
      : streak >= 7
        ? 'epic'
        : streak >= 5
          ? 'hot'
          : streak >= 3
            ? 'warm'
            : 'warm';

  return (
    <div className={`streak-badge streak-badge--${tier}`}>
      <span className="streak-badge__icon">▲</span>
      <span className="streak-badge__count">{streak}</span>
      <span className="streak-badge__label">Streak</span>
    </div>
  );
});

export default StreakBadge;
