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
/*
 * maxTotal is the height of the TOWER, in discs. Dan 2026-08-24 asked for one
 * offset stack rather than a row of columns, and a single tower needs a single
 * height budget - six groups of ten would be sixty discs tall. See maxTotal in
 * chipDenominations.ts for how the budget is spent (bottom-up, largest chips
 * first) and why it never changes the value drawn.
 */
const COMPACT_LAYOUT = { maxStacks: 4, maxPerStack: 6, maxTotal: 6 };
const FULL_LAYOUT = { maxStacks: 5, maxPerStack: 10, maxTotal: 10 };

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

  // Flatten the stacks to render multiple chips in one column, highest denom on bottom
  const flattenedChips: {
    denom: any;
    partial: boolean;
    isTopInDenom: boolean;
    truncated: boolean;
    count: number;
    groupIdx: number;
  }[] = [];

  stacks.forEach((stack, groupIdx) => {
    for (let i = 0; i < stack.drawn; i++) {
      flattenedChips.push({
        denom: stack.denom,
        partial: stack.partial,
        isTopInDenom: i === stack.drawn - 1,
        truncated: stack.truncated,
        count: stack.count,
        groupIdx,
      });
    }
  });

  return (
    <div
      className={`chip-physics${compact ? ' cp--compact' : ''} ${isVisible ? 'cp--visible' : ''} cp--${animate} ${className}`}
    >
      <div className="cp-stacks">
        <div className="cp-stack" style={{ '--group-idx': 0 } as React.CSSProperties}>
          {flattenedChips.map((chip, chipIdx) => (
            <div
              key={`${chip.denom.value}-${chipIdx}`}
              className={`cp-chip${chip.partial ? ' cp-chip--partial' : ''}`}
              style={
                {
                  '--chip-color': chip.denom.color,
                  '--chip-accent': chip.denom.accent,
                  '--chip-ink': chip.denom.ink,
                  '--chip-idx': chipIdx,
                  '--total-chips': flattenedChips.length,
                  transform: `translateX(${Math.sin(chipIdx * 23.45) * 1.5}px)`,
                } as React.CSSProperties
              }
            >
              {/* Clamped stacks print their real count */}
              {chip.truncated && chip.isTopInDenom && (
                <span className="cp-stack__multi">×{chip.count.toLocaleString()}</span>
              )}

              <div className="cp-chip__face">
                {!chip.partial && chip.isTopInDenom && (
                  <span className="cp-chip__label">{chip.denom.label}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Amount display */}
      {showAmount && <span className="cp-amount">{formatChipAmount(amount)}</span>}
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
