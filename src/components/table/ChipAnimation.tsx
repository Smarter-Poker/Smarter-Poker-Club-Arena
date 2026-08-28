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
import { formatTableChips } from '../../utils/format';

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
  // AUDIT 2026-08-25: there was an `opacity` state here whose setter was never
  // called on any path, so it was 1 for the whole life of every chip and was
  // written into the inline style on every rAF frame. Removed: a state that
  // cannot change is not a fade, it is a promise of one, and the flight's fade
  // is done by `.chipContainer` in ChipAnimation.module.css.
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
  /** The chip's own DOM node — used to detect a hidden (background) table. */
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // ANIMATION AUDIT 2026-08-28 (multi-table): a background table is
    // display:none, not unmounted — every chip flight there still drove a
    // full rAF bezier loop nobody could see. If this chip's container has no
    // client rects, land it instantly and complete on the flight's own
    // wall-clock so parent sequencing (award staggers, holds) stays truthful.
    if (containerRef.current && containerRef.current.getClientRects().length === 0) {
      setPosition(to);
      hideTimerRef.current = setTimeout(
        () => {
          hideTimerRef.current = null;
          setIsVisible(false);
          onCompleteRef.current?.();
        },
        delay + duration + 100
      );
      return () => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      };
    }
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
      ref={containerRef}
      className={styles.chipContainer}
      style={{
        transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
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
 * The denomination each chip of a fan is PAINTED as, in flight order.
 *
 * Dan 2026-08-23: a fan used to be coloured by five hand-rolled thresholds
 * applied to `amount / chipCount` — a number that is not a chip at all. A 500
 * bet left the seat purple and arrived at the pot black, because the value it
 * was coloured by (500/4 = 125) is not on any ladder. The fan now takes its
 * colours from the REAL chips the amount breaks into, so what flies is what
 * was sitting on the felt.
 *
 * COLOUR ONLY. Each event's `amount` stays a SHARE of the total, because that
 * is the contract tests/pot-push-to-winner.test.tsx pins: a fan of N chips
 * still sums to the pot within N of rounding. Setting `amount` to a
 * denomination value instead looks tidier and silently breaks "the chips still
 * add up to the pot" — it was tried, and that spec caught it.
 *
 * `count` sprites are returned, cycling the breakdown when the fan is longer
 * than it (a 1,000 pot is one yellow chip, and a three-chip fan of it is three
 * yellow chips, which is what a dealer would actually push).
 */
function fanDenominations(amount: number, count: number): ChipDenomination[] {
  const { chips } = breakChips(amount);
  if (chips.length === 0) {
    return Array.from({ length: count }, () => chipDenominationFor(amount));
  }

  // Expand the breakdown into individual chips, highest denomination first.
  const expanded: ChipDenomination[] = [];
  for (const { denom, count: n } of chips) {
    for (let i = 0; i < n && expanded.length < count; i++) expanded.push(denom);
    if (expanded.length >= count) break;
  }

  return Array.from({ length: count }, (_, i) => expanded[i % expanded.length]);
}

/**
 * A monotonic counter for flight ids.
 *
 * AUDIT 2026-08-25 — THE IDS COLLIDED, AND THEY COLLIDED ON EVERY HAND.
 *
 * Both helpers below built their ids as `<kind>-${Date.now()}-${i}`, where `i`
 * is the index WITHIN one fan. Two fans created in the same millisecond
 * therefore produce the same ids, and both callers create fans in a loop
 * inside a single tick:
 *
 *   - TablePage's blind-posting handler pushes a fan per post, so the small
 *     blind's chip 0 and the big blind's chip 0 are the same id on every hand
 *     that is dealt;
 *   - the pot-award handler pushes a fan per winner, so a split pot collides
 *     the same way.
 *
 * The consequences are both visible. The manager renders the list with
 * `key={anim.id}`, so React warns and reconciles two different flights onto
 * one element; and TablePage reaps a finished flight with
 * `prev.filter((a) => a.id !== id)`, so the FIRST chip to land deletes the
 * other seat's chip mid-air. The blinds' flights are the ones users see, and
 * "one blind's chips vanish on the way to the pot" is exactly what that looks
 * like.
 *
 * A counter rather than a UUID: the ids also want to be short and stable in
 * test snapshots, and nothing outside this module parses them.
 */
let flightSeq = 0;

/** Create a chip-to-pot animation event (2-4 staggered chips from seat to pot center) */
export function createChipToPotEvent(
  seatPos: Position,
  potPos: Position,
  amount: number
): ChipAnimationEvent[] {
  const chipCount = Math.min(getChipCount(amount), 4);
  const fan = fanDenominations(amount, chipCount);

  return fan.map((denom, i) => ({
    id: `chip-to-pot-${Date.now()}-${i}-${++flightSeq}`,
    from: {
      x: seatPos.x + (Math.random() - 0.5) * 10,
      y: seatPos.y + (Math.random() - 0.5) * 10,
    },
    to: potPos,
    amount: Math.round(amount / chipCount),
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
  // At least three sprites so a clean one-chip pot is still a shipment, at
  // most eight so a 60,000 pot is not twelve discs to count mid-flight.
  const chipCount = Math.min(Math.max(getChipCount(amount), 3), 8);
  const fan = fanDenominations(amount, chipCount);

  return fan.map((denom, i) => ({
    id: `pot-to-winner-${Date.now()}-${i}-${++flightSeq}`,
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

// Dan 2026-08-28: the pot flying to its winner shows the real number.
// The 2026-08-25 note below is superseded — the K/M ladder it was fixing is
// gone entirely rather than given a ceiling, because "1.5K" was never the
// right label for a pot in the first place. formatTableChips keeps the
// 2026-08-14 rule that mattered: whole chips at >= 1, cents below it.
function formatAmount(amount: number): string {
  // Rounded before formatting, not by the formatter. Dan 2026-08-14 live
  // E2E: a 23 bet rendered as "23.08" mid-flight because engine amounts
  // carry sub-chip decimals. That is noise on a label that exists for
  // ~400ms, so it is squared off here — the amount itself is untouched.
  return formatTableChips(amount >= 1 ? Math.round(amount) : amount);
}
