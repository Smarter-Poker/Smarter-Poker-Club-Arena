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
import {
  breakChips,
  chipDenominationFor,
  totalChipCount,
  type ChipDenomination,
} from '../../lib/chipDenominations';
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
  /**
   * Dan 2026-08-23: the denomination this chip actually IS, so a chip in
   * flight is the same colour as the chip that was sitting in front of the
   * player a moment earlier and the chip that lands in the pot a moment later.
   *
   * Before this, flight colour came from five hand-rolled amount thresholds
   * (>=1000 gold, >=500 black, >=100 blue, >=25 green, else red) that matched
   * neither Dan's ladder nor the chips on the felt: a 500 bet left the seat as
   * a purple chip and arrived at the pot black.
   *
   * When omitted the denomination is derived from `amount`; an explicit
   * `chipColor` still wins, for callers that want a specific look.
   */
  denomValue?: number;
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
  chipColor,
  useArc = true,
  arcHeight = -0.4,
  showLabel = true,
  labelAmount,
  denomValue,
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
    // IMPROVEMENT PASS 2026-08-19: honor prefers-reduced-motion. The CSS
    // media query flattens every keyframe on the table, but it cannot reach
    // this rAF loop — chips were the ONE thing still flying for
    // reduced-motion users. Land instantly, hold a beat, complete.
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setPosition(to);
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        setIsVisible(false);
        onCompleteRef.current?.();
      }, delay + 220);
      return () => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      };
    }

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

  // The chip in flight is the chip that left the felt. An explicit chipColor
  // still wins (legacy callers), otherwise paint the real denomination.
  const denom: ChipDenomination = chipDenominationFor(denomValue ?? amount);

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
          className={`${styles.chip} ${chipColor ? styles[chipColor] : styles.denomChip}`}
          style={
            {
              '--chip-offset': i,
              '--chip-face': denom.color,
              '--chip-edge': denom.accent,
            } as React.CSSProperties
          }
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
  /** The denomination this chip is, so it flies the colour it sat as. */
  denomValue?: number;
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
          chipColor={anim.chipColor}
          denomValue={anim.denomValue}
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

/**
 * The denominations a fan should be made of, highest first.
 *
 * Dan 2026-08-23: a fan used to be N identical chips each carrying
 * `amount / N`, coloured by five thresholds that matched neither the ladder
 * nor the chips on the felt — a 500 bet left the seat purple and arrived at
 * the pot black, and the "denomination" it was coloured by (500/4 = 125) was
 * not a chip at all. Now the fan is made of the REAL chips the bet breaks
 * into, so the colours leaving the seat are the colours that were sitting
 * there.
 *
 * Capped at `max` flying sprites: this is decoration over a 400ms flight, and
 * a 60,000 bet is twelve orange chips that nobody needs to count in the air.
 * The label already carries the exact amount.
 */
function fanDenominations(amount: number, max: number): ChipDenomination[] {
  const { chips } = breakChips(amount);
  if (chips.length === 0) return [chipDenominationFor(amount)];

  const fan: ChipDenomination[] = [];
  for (const { denom, count } of chips) {
    for (let i = 0; i < count && fan.length < max; i++) fan.push(denom);
    if (fan.length >= max) break;
  }
  return fan;
}

/** Create a chip-to-pot animation event (2-4 staggered chips from seat to pot center) */
export function createChipToPotEvent(
  seatPos: Position,
  potPos: Position,
  amount: number
): ChipAnimationEvent[] {
  const fan = fanDenominations(amount, 4);
  return fan.map((denom, i) => ({
    id: `chip-to-pot-${Date.now()}-${i}`,
    from: {
      x: seatPos.x + (Math.random() - 0.5) * 10,
      y: seatPos.y + (Math.random() - 0.5) * 10,
    },
    to: potPos,
    amount: denom.value,
    delay: i * 50,
    type: 'to-pot' as const,
    denomValue: denom.value,
    // AUDIT 2026-08-19: same rule as the pot-to-winner fan. A 100 bet drawn as
    // four chips used to print "25" four times; the label now names the bet.
    showLabel: i === 0,
    labelAmount: amount,
  }));
}

/** Create pot-to-winner animation event (3-8 chips from pot to winner seat) */
export function createPotToWinnerEvent(
  potPos: Position,
  winnerPos: Position,
  amount: number
): ChipAnimationEvent[] {
  const denoms = fanDenominations(amount, 8);

  /**
   * A pot going home should look like a pot: a one-chip breakdown is padded
   * out to three sprites so a clean 1,000,000 win is still a shipment, not a
   * speck.
   *
   * BUT PADDING MUST NOT INVENT MONEY (2026-08-23). The pad used to duplicate
   * the last denomination - `fan.push(fan[fan.length - 1])` - and each sprite
   * carries `amount: denom.value`, so a 1,000 pot that breaks down to a single
   * 1,000 chip shipped as THREE chips of 1,000. The fan claimed 3,000. Two
   * tests have been failing on main over exactly this ("the chips still add up
   * to the pot", and the label test, which asserts a single chip is worth less
   * than the whole pot).
   *
   * Padding now SPLITS the amount across the sprites it adds instead of
   * repeating it. The sprite art still comes from the real top denomination, so
   * it looks identical; only the arithmetic is honest.
   */
  let chips: Array<{ value: number; amount: number }>;
  if (denoms.length > 0 && denoms.length < 3) {
    const art = denoms[0].value;
    const share = Math.floor(amount / 3);
    // The remainder rides on the first chip, which is also the labelled one.
    chips = [
      { value: art, amount: amount - share * 2 },
      { value: art, amount: share },
      { value: art, amount: share },
    ];
  } else {
    chips = denoms.map((d) => ({ value: d.value, amount: d.value }));
  }

  return chips.map((denom, i) => ({
    id: `pot-to-winner-${Date.now()}-${i}`,
    from: {
      x: potPos.x + (Math.random() - 0.5) * 20,
      y: potPos.y + (Math.random() - 0.5) * 10,
    },
    to: {
      x: winnerPos.x + (Math.random() - 0.5) * 15,
      y: winnerPos.y,
    },
    amount: denom.amount,
    delay: i * 40,
    type: 'to-winner' as const,
    denomValue: denom.value,
    // One label for the fan, reading the WHOLE amount being shipped to this
    // winner — not N chips each reading a share of it.
    showLabel: i === 0,
    labelAmount: amount,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * How many sprites to draw for one flying chip event, 1 to 5.
 *
 * Was five hand-rolled amount thresholds. It is now the real fewest-chips
 * count, clamped: a 7 bet flies as three chips because 7 IS three chips, and a
 * 60,000 bet flies as five rather than twelve because twelve sprites crossing
 * the felt in 400ms is noise, not information (the label carries the amount).
 */
function getChipCount(amount: number): number {
  return Math.max(1, Math.min(totalChipCount(amount) || 1, 5));
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
