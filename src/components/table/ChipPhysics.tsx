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
import { formatTableChips } from '../../utils/format';

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

  /**
   * The discs to draw, bottom-first.
   *
   * AUDIT 2026-08-25, two things. The flattening used to happen inline on every
   * render while only the breakdown it reads was memoised, so a seat re-rendered
   * for any reason at all rebuilt the whole disc list; and each entry carried a
   * `groupIdx` that NOTHING read. That field was left over from the row-of-
   * columns layout: `--group-idx` still exists in ChipPhysics.css (it staggers
   * `.cp-stack`'s animation) but Dan 2026-08-24 replaced the row with a single
   * offset tower, so there is exactly one `.cp-stack` and it is hard-coded to
   * group 0 below. Carrying a per-chip group index that can only ever be
   * discarded invites the next reader to stagger by it and get nothing.
   */
  const chips = useMemo(() => {
    const stacks = visualChipStacks(amount, compact ? COMPACT_LAYOUT : FULL_LAYOUT);
    const flat: {
      denom: ChipStackVisual['denom'];
      partial: boolean;
      isTopInDenom: boolean;
      truncated: boolean;
      count: number;
    }[] = [];
    stacks.forEach((stack) => {
      for (let i = 0; i < stack.drawn; i++) {
        flat.push({
          denom: stack.denom,
          partial: stack.partial,
          isTopInDenom: i === stack.drawn - 1,
          truncated: stack.truncated,
          count: stack.count,
        });
      }
    });
    return flat;
  }, [amount, compact]);

  useEffect(() => {
    if (animate !== 'none') {
      const timer = setTimeout(() => setIsVisible(true), 50);
      return () => clearTimeout(timer);
    }
  }, [animate]);

  if (amount <= 0) return null;

  return (
    <div
      className={`chip-physics${compact ? ' cp--compact' : ''} ${isVisible ? 'cp--visible' : ''} cp--${animate} ${className}`}
    >
      <div className="cp-stacks">
        <div className="cp-stack" style={{ '--group-idx': 0 } as React.CSSProperties}>
          {chips.map((chip, chipIdx) => (
            <div
              key={`${chip.denom.value}-${chipIdx}`}
              className={`cp-chip${chip.partial ? ' cp-chip--partial' : ''}`}
              style={
                {
                  '--chip-color': chip.denom.color,
                  '--chip-accent': chip.denom.accent,
                  '--chip-ink': chip.denom.ink,
                  '--chip-idx': chipIdx,
                  '--total-chips': chips.length,
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
  // Dan 2026-08-28: pot and bet chips on the felt show the real number.
  return formatTableChips(amount);
}

export default ChipPhysics;
