/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP ANIMATION — Premium Poker Chip Movement Effects
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Animated chip movement for bets, pots, and winnings with:
 * - Bezier curve flight paths (arc instead of straight line)
 * - Staggered multi-chip cascades
 * - Color-coded by denomination
 * - Scale pulse on arrival
 * - Supports chip-to-pot and pot-to-winner flows
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import styles from './ChipAnimation.module.css';
// Dan 2026-08-14 live E2E visual hotfix pack — bundled here because this
// component is always in the table bundle (avatars, chips, felt, pot column).
import './TableVisualHotfix.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface Position {
  x: number;
  y: number;
}

interface ChipAnimationProps {
  from: Position;
  to: Position;
  amount: number;
  duration?: number;
  delay?: number;
  onComplete?: () => void;
  chipColor?: 'red' | 'green' | 'blue' | 'black' | 'gold';
  /** Use arc path (true) vs straight line (false) */
  useArc?: boolean;
  /** Size of the arc (-1 to 1, negative = arc upward) */
  arcHeight?: number;
  /**
   * Dan 2026-08-19, bug list item 6 ("...showing chip amounts"): a pot going to
   * one winner is sent as a FAN of 3-8 chips, and every chip was labelled with
   * its own 1/Nth of the pot. Eight chips reading "125" for a 1,000 pot is not
   * showing the amount, it is showing eight wrong numbers. Only the lead chip
   * of a fan carries a label now, and it reads the whole amount being shipped.
   */
  showLabel?: boolean;
  /** What the label reads, when it differs from this chip's own value. */
  labelAmount?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BEZIER CURVE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Quadratic bezier: P0→P1→P2 at t ∈ [0,1] */
function quadBezier(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** Ease-out cubic: fast start, gentle land */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE CHIP ANIMATION
// ═══════════════════════════════════════════════════════════════════════════════

export default function ChipAnimation({
  from,
  to,
  amount,
  duration = 450,
  delay = 0,
  onComplete,
  chipColor = 'gold',
  useArc = true,
  arcHeight = -0.4,
  showLabel = true,
  labelAmount,
}: ChipAnimationProps) {
  const [position, setPosition] = useState(from);
  const [opacity, setOpacity] = useState(1);
  const [scale, setScale] = useState(1);
  const [isVisible, setIsVisible] = useState(true);
  const animRef = useRef<number>(0);
  // CA-12 BUG FIX: the 100ms hide-delay setTimeout after the rAF completes was
  // fire-and-forget. If the parent unmounts ChipAnimation during this window,
  // setIsVisible(false) fires on an unmounted component.
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // CHIP-GLITCH FIX 2026-08-15: `onComplete` used to sit in the animation
  // effect's dependency array, and ChipAnimationManager passes an inline
  // arrow — a new identity on EVERY parent render. TablePage re-renders many
  // times during an action (WS snapshots, action labels, pot updates), so
  // each render cancelled the rAF loop and the 100ms hide timer and REPLAYED
  // the flight from the start: chips visibly stuttered, looped seat-to-pot,
  // and lingered mid-felt until the 5s safety sweep reaped them. Keep the
  // latest callback in a ref so re-renders never restart a flight in the air.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    let startTime: number | null = null;

    // Calculate control point for bezier arc
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const dist = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
    const controlX = midX;
    const controlY = midY + dist * arcHeight; // Negative = arc upward

    const run = (timestamp: number) => {
      if (!startTime) startTime = timestamp + delay;
      if (timestamp < startTime) {
        animRef.current = requestAnimationFrame(run);
        return;
      }

      const elapsed = timestamp - startTime;
      const rawProgress = Math.min(elapsed / duration, 1);
      const t = easeOutCubic(rawProgress);

      // Position along bezier curve
      const x = useArc ? quadBezier(from.x, controlX, to.x, t) : from.x + (to.x - from.x) * t;
      const y = useArc ? quadBezier(from.y, controlY, to.y, t) : from.y + (to.y - from.y) * t;

      setPosition({ x, y });

      // Scale pulse near arrival (1.0 → 1.15 → 1.0 in last 20%)
      if (rawProgress > 0.8) {
        const arrivalT = (rawProgress - 0.8) / 0.2;
        const pulse = 1 + 0.15 * Math.sin(arrivalT * Math.PI);
        setScale(pulse);
      }

      if (rawProgress < 1) {
        animRef.current = requestAnimationFrame(run);
      } else {
        // Finished — brief pause then hide
        hideTimerRef.current = setTimeout(() => {
          hideTimerRef.current = null;
          setIsVisible(false);
          onCompleteRef.current?.();
        }, 100);
      }
    };

    animRef.current = requestAnimationFrame(run);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
     
    // intentionally read through onCompleteRef; see CHIP-GLITCH FIX above.
  }, [from, to, duration, delay, useArc, arcHeight]);

  if (!isVisible) return null;

  const chipCount = getChipCount(amount);

  return (
    <div
      className={styles.chipContainer}
      style={{
        transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
        opacity,
      }}
    >
      {/* Stack of chips */}
      {Array.from({ length: Math.min(chipCount, 5) }).map((_, i) => (
        <div
          key={i}
          className={`${styles.chip} ${styles[chipColor]}`}
          style={{ '--chip-offset': i } as React.CSSProperties}
        />
      ))}

      {/* Amount label */}
      {showLabel && <span className={styles.amount}>{formatAmount(labelAmount ?? amount)}</span>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHIP ANIMATION MANAGER — Controls multiple chip animations
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChipAnimationEvent {
  id: string;
  from: Position;
  to: Position;
  amount: number;
  chipColor?: 'red' | 'green' | 'blue' | 'black' | 'gold';
  delay?: number;
  /** 'to-pot' = arc upward, 'to-winner' = arc with slight lift */
  type?: 'to-pot' | 'to-winner' | 'straight';
  /** Only the lead chip of a fan is labelled — see ChipAnimationProps. */
  showLabel?: boolean;
  /** What that label reads. */
  labelAmount?: number;
}

interface ChipAnimationManagerProps {
  animations: ChipAnimationEvent[];
  onAnimationComplete?: (id: string) => void;
}

export function ChipAnimationManager({
  animations,
  onAnimationComplete,
}: ChipAnimationManagerProps) {
  return (
    <div className={styles.manager}>
      {animations.map((anim) => (
        <ChipAnimation
          key={anim.id}
          from={anim.from}
          to={anim.to}
          amount={anim.amount}
          chipColor={anim.chipColor || getChipColor(anim.amount)}
          delay={anim.delay || 0}
          duration={anim.type === 'to-winner' ? 600 : 400}
          useArc={anim.type !== 'straight'}
          arcHeight={anim.type === 'to-winner' ? -0.3 : -0.4}
          showLabel={anim.showLabel !== false}
          labelAmount={anim.labelAmount}
          onComplete={() => onAnimationComplete?.(anim.id)}
        />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS — Create chip-to-pot and pot-to-winner events
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a chip-to-pot animation event (2-4 staggered chips from seat to pot center) */
export function createChipToPotEvent(
  seatPos: Position,
  potPos: Position,
  amount: number
): ChipAnimationEvent[] {
  const chipCount = Math.min(getChipCount(amount), 4);
  return Array.from({ length: chipCount }).map((_, i) => ({
    id: `chip-to-pot-${Date.now()}-${i}`,
    from: {
      x: seatPos.x + (Math.random() - 0.5) * 10,
      y: seatPos.y + (Math.random() - 0.5) * 10,
    },
    to: potPos,
    amount: Math.round(amount / chipCount),
    delay: i * 50,
    type: 'to-pot' as const,
    chipColor: getChipColor(amount / chipCount),
    // AUDIT 2026-08-19: same rule as the pot-to-winner fan. A 100 bet drawn as
    // four chips used to print "25" four times; the label now names the bet.
    showLabel: i === 0,
    labelAmount: amount,
  }));
}

/** Create pot-to-winner animation event (6-8 chips from pot to winner seat) */
export function createPotToWinnerEvent(
  potPos: Position,
  winnerPos: Position,
  amount: number
): ChipAnimationEvent[] {
  const chipCount = Math.min(Math.max(getChipCount(amount), 3), 8);
  return Array.from({ length: chipCount }).map((_, i) => ({
    id: `pot-to-winner-${Date.now()}-${i}`,
    from: {
      x: potPos.x + (Math.random() - 0.5) * 20,
      y: potPos.y + (Math.random() - 0.5) * 10,
    },
    to: {
      x: winnerPos.x + (Math.random() - 0.5) * 15,
      y: winnerPos.y,
    },
    amount: Math.round(amount / chipCount),
    delay: i * 40,
    type: 'to-winner' as const,
    chipColor: getChipColor(amount / chipCount),
    // One label for the fan, reading the WHOLE amount being shipped to this
    // winner — not N chips each reading a share of it.
    showLabel: i === 0,
    labelAmount: amount,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function getChipCount(amount: number): number {
  if (amount >= 10000) return 5;
  if (amount >= 1000) return 4;
  if (amount >= 100) return 3;
  if (amount >= 10) return 2;
  return 1;
}

function getChipColor(amount: number): 'red' | 'green' | 'blue' | 'black' | 'gold' {
  if (amount >= 1000) return 'gold';
  if (amount >= 500) return 'black';
  if (amount >= 100) return 'blue';
  if (amount >= 25) return 'green';
  return 'red';
}

function formatAmount(amount: number): string {
  if (amount >= 1000) {
    return `${(amount / 1000).toFixed(1)}K`;
  }
  // Dan 2026-08-14 live E2E: a 23 bet rendered as "23.08" mid-flight (engine
  // amounts carry sub-chip decimals). Whole chips for >= 1, cents below 1.
  if (amount >= 1) return Math.round(amount).toLocaleString('en-US');
  return amount.toFixed(2);
}
