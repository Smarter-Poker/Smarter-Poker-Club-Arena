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
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
}

/*
 * THERE IS NO EARNINGS MULTIPLIER (2026-09-05).
 *
 * This component took a `multiplier` prop and rendered "{n}x Earnings". Its
 * one caller, ProfilePage, computed it as `1 + streak * 0.1` in the JSX, so
 * the profile advertised a payout boost that no service, RPC or ledger has
 * ever applied. The prop is gone rather than defaulted, so a future caller
 * cannot quietly reintroduce the claim; if a real streak multiplier is ever
 * built, it arrives with the service that pays it.
 */

export default function StreakMultiplier({ streak, size = 'md' }: StreakMultiplierProps) {
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
        <span className="sm-streak-label">Day Streak</span>
      </div>
    </div>
  );
}
