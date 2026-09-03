/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DAILY BONUS WHEEL — Spin-to-Win Component
 * Animated wheel for daily bonus claims
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useRef } from 'react';
import styles from './DailyBonusWheel.module.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface WheelSegment {
  /** Streak day this segment represents (1-7). */
  day: number;
  label: string;
  value: number;
  type: 'chips' | 'vip' | 'diamonds';
  color: string;
}

/** What the SERVER actually credited. The wheel lands on this, it does not pick it. */
export interface DailyBonusOutcome {
  day: number;
  reward: number;
  rewardType: 'chips' | 'vip' | 'diamonds';
}

interface DailyBonusWheelProps {
  /**
   * Claim the bonus and report what was credited.
   *
   * ── 2026-08-20: THE WHEEL NO LONGER DECIDES ANYTHING ─────────────────────
   * It used to pick a segment with `Math.random()` over a weighted list, animate
   * to it, and then hand that segment to the parent — which ignored it entirely
   * and toasted the amount the SERVER had credited. So the wheel would visibly
   * stop on "5000 Chips" and the toast underneath would say "Daily bonus: 100
   * chips". In a gambling product that reads as the house rigging the wheel.
   *
   * It was worse than a mismatch. `fn_claim_daily_bonus` has no randomness at
   * all: the reward is a fixed 7-day streak ladder read from
   * `daily_bonus_rewards` (100 / 150 / 200 / 300 / 500 / 200 VIP / 1000). Two of
   * the segments on the old wheel — "5000 Chips" and "5 Diamonds" — could never
   * be paid by any code path, at any streak, ever.
   *
   * So the wheel is now a reveal of the day you actually reached, and the
   * segments are the real ladder. Resolve `null` if the claim failed; the parent
   * surfaces the error and the wheel simply does not spin.
   */
  onSpin: () => Promise<DailyBonusOutcome | null>;
  segments?: WheelSegment[];
  disabled?: boolean;
  spinCount?: number;
}

/**
 * The real 7-day streak ladder, mirroring `public.daily_bonus_rewards`. Keep this
 * in step with that table — a segment the server cannot pay is the bug this
 * component was rewritten to remove.
 */
const DEFAULT_SEGMENTS: WheelSegment[] = [
  { day: 1, label: 'Day 1 · 100', value: 100, type: 'chips', color: '#10b981' },
  { day: 2, label: 'Day 2 · 150', value: 150, type: 'chips', color: '#34d399' },
  { day: 3, label: 'Day 3 · 200', value: 200, type: 'chips', color: '#22c55e' },
  { day: 4, label: 'Day 4 · 300', value: 300, type: 'chips', color: '#16a34a' },
  { day: 5, label: 'Day 5 · 500', value: 500, type: 'chips', color: '#059669' },
  { day: 6, label: 'Day 6 · 200 VIP', value: 200, type: 'vip', color: '#a78bfa' },
  { day: 7, label: 'Day 7 · 1,000', value: 1000, type: 'chips', color: '#fbbf24' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DailyBonusWheel({
  onSpin,
  segments = DEFAULT_SEGMENTS,
  disabled = false,
  spinCount = 0,
}: DailyBonusWheelProps) {
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [result, setResult] = useState<WheelSegment | null>(null);
  const wheelRef = useRef<HTMLDivElement>(null);

  const handleSpin = async () => {
    if (spinning || disabled) return;

    setSpinning(true);
    setResult(null);

    // Claim FIRST. The server is the only thing that decides what this pays, so
    // the wheel cannot start until it knows where it is allowed to stop.
    const outcome = await onSpin();
    if (!outcome) {
      // Claim refused (already claimed today, network, etc). The parent has
      // surfaced the reason; do not animate a win that did not happen.
      setSpinning(false);
      return;
    }

    const landedIndex = Math.max(
      0,
      segments.findIndex((seg) => seg.day === outcome.day)
    );
    const landed = segments[landedIndex];

    // At least 5 full turns, then stop on the segment the server actually paid.
    const segmentAngle = 360 / segments.length;
    const targetAngle = 360 - landedIndex * segmentAngle - segmentAngle / 2;
    const spins = 5;
    setRotation((prev) => prev + spins * 360 + targetAngle);

    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Report the SERVER's figures, not the segment's, so the two can never
    // disagree even if this table drifts from daily_bonus_rewards.
    setResult({
      ...landed,
      value: outcome.reward,
      type: outcome.rewardType,
      label: `${outcome.reward.toLocaleString()} ${outcome.rewardType === 'chips' ? 'Chips' : outcome.rewardType === 'vip' ? 'VIP Points' : 'Diamonds'}`,
    });
    setSpinning(false);
  };

  const getTypeIcon = (type: string): string => {
    switch (type) {
      case 'chips':
        return '♠';

      case 'vip':
        return '♛';
      case 'diamonds':
        return '◆';
      default:
        return '●';
    }
  };

  return (
    <div className={styles.wheelContainer}>
      {/* Wheel */}
      <div className={styles.wheelWrapper}>
        <div className={styles.pointer}>▼</div>
        <div
          ref={wheelRef}
          className={styles.wheel}
          style={{ transform: `rotate(${rotation}deg)` }}
        >
          {segments.map((segment, i) => {
            const angle = (360 / segments.length) * i;
            return (
              <div
                key={i}
                className={styles.segment}
                style={{
                  transform: `rotate(${angle}deg)`,
                  backgroundColor: segment.color,
                }}
              >
                <span className={styles.segmentLabel}>
                  {getTypeIcon(segment.type)} {segment.label}
                </span>
              </div>
            );
          })}
        </div>
        <div className={styles.centerButton} onClick={handleSpin}>
          {spinning ? '' : 'SPIN'}
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className={styles.resultCard}>
          <span className={styles.resultIcon}>{getTypeIcon(result.type)}</span>
          <span className={styles.resultText}>You Won {result.label}!</span>
        </div>
      )}

      {/* Spin Button */}
      <button className={styles.spinButton} onClick={handleSpin} disabled={spinning || disabled}>
        {disabled ? 'Come Back Tomorrow!' : spinning ? 'Spinning...' : ` Spin The Wheel`}
      </button>

      {/* Spin Count */}
      {spinCount > 0 && <div className={styles.spinCount}>{spinCount} Day Streak!</div>}
    </div>
  );
}
