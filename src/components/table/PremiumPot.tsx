/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PremiumPot — Animated Pot Display with Tier Glow
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Replaces flat pot number with:
 *   - Animated counting effect on value change
 *   - Side pot indicators with player labels
 *   - Tier glow: normal → medium → large → monster
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { visualChipStacks } from '../../lib/chipDenominations';
import './PremiumPot.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SidePot {
  id: string;
  amount: number;
  eligible: string[]; // player names
}

export interface PremiumPotProps {
  mainPot: number;
  sidePots?: SidePot[];
  compact?: boolean;
  currency?: string;
}

// Smart precision — whole dollars for clean amounts, decimals only for fractional (all-in splits)
function formatAmount(amount: number): string {
  if (Math.abs(amount - Math.round(amount)) < 0.005) {
    return Math.round(amount).toLocaleString('en-US');
  }
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type PotTier = 'normal' | 'medium' | 'large' | 'monster';

function getPotTier(amount: number): PotTier {
  if (amount >= 1000) return 'monster';
  if (amount >= 200) return 'large';
  if (amount >= 50) return 'medium';
  return 'normal';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATED COUNTER HOOK
// ═══════════════════════════════════════════════════════════════════════════════

function useAnimatedCounter(target: number, duration = 400): number {
  const [display, setDisplay] = useState(target);
  const startRef = useRef(target);
  const currentRef = useRef(target); // Tracks actual displayed value
  const rafRef = useRef<number>(0);

  useEffect(() => {
    // Start from the CURRENT displayed value, not the initial one
    const start = currentRef.current;
    const diff = target - start;
    if (diff === 0) return;

    startRef.current = start;
    const startTime = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + diff * eased);

      currentRef.current = current;
      setDisplay(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function PremiumPot({
  mainPot,
  sidePots = [],
  compact = false,
  currency = '',
}: PremiumPotProps) {
  const animatedMain = useAnimatedCounter(mainPot);
  const tier = useMemo(() => getPotTier(mainPot), [mainPot]);
  const [showBurst, setShowBurst] = useState(false);

  // Trigger burst animation on tier upgrade
  useEffect(() => {
    if (tier !== 'normal') {
      setShowBurst(true);
      const timer = setTimeout(() => setShowBurst(false), 600);
      return () => clearTimeout(timer);
    }
  }, [tier]);

  if (mainPot <= 0) return null;

  return (
    <div className={`premium-pot pp--${tier} ${compact ? 'pp--compact' : ''}`}>
      {/* Glow layer */}
      <div className={`pp-glow ${showBurst ? 'pp-glow--burst' : ''}`} />

      {/* Dan 2026-08-23: the pot as real chips, coloured up to the fewest that
          equal it. Drawn from the animated value so the pile grows with the
          counter rather than snapping ahead of it.
          NOTE: this component is not currently mounted anywhere (TablePage
          dropped it on 2026-07-19 as a duplicate of PotDisplay). The pile is
          here so that if it is ever remounted it agrees with the felt instead
          of growing a third denomination ladder of its own. */}
      <PremiumPotChips amount={animatedMain} />

      {/* Main pot */}
      <div className="pp-main">
        <span className="pp-main__label">POT</span>
        <span className="pp-main__value">
          {currency}
          {formatAmount(animatedMain)}
        </span>
      </div>

      {/* Side pots */}
      {sidePots.length > 0 && (
        <div className="pp-sides">
          {sidePots.map((sp, i) => (
            <div key={sp.id} className="pp-side">
              <span className="pp-side__label">Side {i + 1}</span>
              <span className="pp-side__value">
                {currency}
                {formatAmount(sp.amount)}
              </span>
              <span className="pp-side__players" title={sp.eligible.join(', ')}>
                ({sp.eligible.length} Players)
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The pot drawn as chips: the fewest that add up to it, coloured by Dan's
 * ladder. Counts and colours come from src/lib/chipDenominations.ts, which is
 * also what the seats and PotDisplay draw from, so all three agree by
 * construction rather than by three people remembering to update three lists.
 */
function PremiumPotChips({ amount }: { amount: number }) {
  const stacks = useMemo(
    () => visualChipStacks(amount, { maxStacks: 5, maxPerStack: 8 }),
    [amount]
  );

  if (stacks.length === 0) return null;

  return (
    /* aria-hidden: the pot value is already announced by .pp-main__value. */
    <div className="pp-chips" aria-hidden="true">
      {stacks.map((stack) => (
        <div key={stack.denom.value} className="pp-chip-stack">
          {/* A clamped stack prints its true count: the pile is capped for
              layout, the value it stands for never is. */}
          {stack.truncated && (
            <span className="pp-chip-multi">×{stack.count.toLocaleString()}</span>
          )}
          {Array.from({ length: stack.drawn }, (_, i) => (
            <span
              key={i}
              className={`pp-chip${stack.partial ? ' pp-chip--partial' : ''}`}
              style={
                {
                  '--pp-chip-color': stack.denom.color,
                  '--pp-chip-accent': stack.denom.accent,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default PremiumPot;
