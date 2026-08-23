/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ChipPhysics — Realistic Chip Sprite Renderer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders micro chip towers with denomination colors and physics-like animations:
 *   - Stack height proportional to bet size
 *   - Bet-to-pot arc trajectory
 *   - Splash animation (chips scatter then settle)
 *   - Denomination color system (src/lib/chipDenominations.ts)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Dan 2026-08-23: "IF A PLAYER RAISES, OR CALLS TO 7, ONE RED AND TWO WHITE
 * CHIPS SHOULD BE ADDED IN FRONT OF THEM."
 *
 * SeatSlot renders this component in `compact` mode for every seat's live bet,
 * and compact mode used to draw EXACTLY ONE CHIP regardless of the amount. The
 * comment there said that was deliberate, "to avoid misleading chip counts
 * that don't match the bet value" — the right instinct aimed at the wrong fix.
 * The counts did not match because the local breakdown clamped each stack at
 * five chips and then subtracted the UNCLAMPED count from the remainder, so
 * the discs never summed to the bet. Drawing one chip for every bet is not
 * less misleading than a wrong count, it only hides it.
 *
 * The breakdown now comes from src/lib/chipDenominations.ts, which is exact
 * and unit-tested, so compact mode can draw the real chips: a 7 bet draws one
 * red and two white.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo, useEffect, useState } from 'react';
import { visualChipStacks, type ChipStackVisual } from '../../lib/chipDenominations';
import './ChipPhysics.css';

// ═══════════════════════════════════════════════════════════════════════════════
// DENOMINATION SYSTEM — see src/lib/chipDenominations.ts for the ladder, why
// greedy descent is the "fewest chips" Dan asked for, and both spec
// ambiguities (purple listed twice; the 5,000 -> 100,000 gap).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In front of a seat there is room for a short row of short stacks; the pot in
 * the middle of the felt can carry a taller pile. Neither cap ever changes the
 * VALUE drawn — a clamped stack reports `truncated` and prints its real count
 * beside itself, which is exactly what the old local breakdown failed to do.
 */
const COMPACT_LAYOUT = { maxStacks: 4, maxPerStack: 6 };
const FULL_LAYOUT = { maxStacks: 5, maxPerStack: 10 };

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChipPhysicsProps {
  amount: number;
  animate?: 'none' | 'splash' | 'slide-in' | 'collect';
  compact?: boolean;
  showAmount?: boolean;
  className?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ChipPhysics({
  amount,
  animate = 'none',
  compact = false,
  showAmount = true,
  className = '',
}: ChipPhysicsProps) {
  const [isVisible, setIsVisible] = useState(animate === 'none');

  const stacks = useMemo(
    () => visualChipStacks(amount, compact ? COMPACT_LAYOUT : FULL_LAYOUT),
    [amount, compact]
  );

  useEffect(() => {
    if (animate !== 'none') {
      const timer = setTimeout(() => setIsVisible(true), 50);
      return () => clearTimeout(timer);
    }
  }, [animate]);

  if (amount <= 0) return null;

  // Compact (in front of a seat) and full (the pot) differ only in chip size
  // and how much room the stacks get — both draw the real, exact breakdown.
  return (
    <div
      className={`chip-physics${compact ? ' cp--compact' : ''} ${isVisible ? 'cp--visible' : ''} cp--${animate} ${className}`}
    >
      <div className="cp-stacks">
        {stacks.map((stack, groupIdx) => (
          <ChipTower key={stack.denom.value} stack={stack} groupIdx={groupIdx} />
        ))}
      </div>

      {/* Amount display */}
      {showAmount && <span className="cp-amount">{formatChipAmount(amount)}</span>}
    </div>
  );
}

/** One denomination's stack: N discs of a single colour, tallest disc labelled. */
function ChipTower({ stack, groupIdx }: { stack: ChipStackVisual; groupIdx: number }) {
  const { denom, count, drawn, truncated, partial } = stack;

  return (
    <div className="cp-stack" style={{ '--group-idx': groupIdx } as React.CSSProperties}>
      {/* A stack too tall to draw prints its real count, so the pile never
          claims a value it is not showing. See visualChipStacks. */}
      {truncated && <span className="cp-stack__multi">×{count.toLocaleString()}</span>}

      {Array.from({ length: drawn }, (_, chipIdx) => (
        <div
          key={chipIdx}
          className={`cp-chip${partial ? ' cp-chip--partial' : ''}`}
          style={
            {
              '--chip-color': denom.color,
              '--chip-accent': denom.accent,
              '--chip-ink': denom.ink,
              '--chip-idx': chipIdx,
              '--total-chips': drawn,
            } as React.CSSProperties
          }
        >
          <div className="cp-chip__face">
            {/* The partial disc stands in for a sub-1 remainder that no chip on
                the ladder can represent (a 0.5 small blind). Labelling it "1"
                would be a lie about its value, so it carries no label. */}
            {!partial && <span className="cp-chip__label">{denom.label}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatChipAmount(amount: number): string {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 10000) return `${(amount / 1000).toFixed(1)}K`;
  // Always show whole numbers for amounts >= 1. Sub-dollar shows 2 decimals.
  if (amount >= 1) return Math.round(amount).toLocaleString();
  if (amount > 0) return amount.toFixed(2);
  return '0';
}

export default ChipPhysics;
