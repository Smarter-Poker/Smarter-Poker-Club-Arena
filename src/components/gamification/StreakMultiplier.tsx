/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STREAK MULTIPLIER — Fire animation + streak day counter
 * ═══════════════════════════════════════════════════════════════════════════════
 * Displays current streak with animated flame that grows with streak length.
 */

import './StreakMultiplier.css';

interface StreakMultiplierProps {
  /** Current streak count (days) */
  streak: number;
  /** Current multiplier (e.g., 1.5x) */
  multiplier?: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
}

export default function StreakMultiplier({
  streak,
  multiplier = 1,
  size = 'md',
}: StreakMultiplierProps) {
  if (streak <= 0) return null;

  // Flame intensity: grows with streak
  const intensity = Math.min(streak / 30, 1); // caps at 30 days
  const flameClass =
    streak >= 14 ? 'inferno' : streak >= 7 ? 'blazing' : streak >= 3 ? 'warm' : 'spark';

  return (
    <div className={`streak-multiplier sm-${size}`}>
      <div className={`sm-flame-wrap ${flameClass}`}>
        {/* Layered flame SVGs for depth */}
        <div className="sm-flame sm-flame-outer" style={{ opacity: 0.4 + intensity * 0.6 }}>
          ▲
        </div>
        {streak >= 7 && <div className="sm-flame sm-flame-inner">▲</div>}
      </div>

      <div className="sm-info">
        <span className="sm-streak-count">×{streak}</span>
        {multiplier > 1 && <span className="sm-multiplier">{multiplier.toFixed(1)}× Earnings</span>}
      </div>
    </div>
  );
}
