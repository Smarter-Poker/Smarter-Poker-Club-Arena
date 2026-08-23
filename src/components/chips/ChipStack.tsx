import React from 'react';
import { visualChipStacks } from '../../lib/chipDenominations';
import './ChipStack.css';

/**
 * A chip amount rendered as an inline pill with the real chips beside it.
 *
 * Dan 2026-08-23: this used to draw a single "◉" glyph next to the number,
 * which is a bullet point, not a chip. It now shows the fewest chips that add
 * up to the amount on Dan's ladder, from src/lib/chipDenominations.ts — the
 * one place the denominations, the colours and both spec ambiguities live.
 *
 * Kept deliberately small: this is the compact inline badge (wallets, lists),
 * not the felt. table/ChipPhysics draws the chips in front of a seat and
 * table/PotDisplay draws the pot.
 */

interface ChipStackProps {
  amount: number;
  size?: 'small' | 'medium' | 'large';
  animated?: boolean;
}

const formatChips = (amount: number): string => {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const ChipStack: React.FC<ChipStackProps> = ({
  amount,
  size = 'medium',
  animated = false,
}) => {
  // An inline pill has room for a short row of short stacks and no more.
  const stacks = visualChipStacks(amount, { maxStacks: 3, maxPerStack: 4 });

  return (
    <div className={`chip-stack size-${size} ${animated ? 'animated' : ''}`}>
      {/* aria-hidden: the amount is spelled out in full right beside it, so
          announcing "two red chips" adds nothing a reader can act on. */}
      <span className="chip-stack__denoms" aria-hidden="true">
        {stacks.map((stack) => (
          <span key={stack.denom.value} className="chip-stack__denom-stack">
            {stack.truncated && (
              <span className="chip-stack__denom-multi">×{stack.count.toLocaleString()}</span>
            )}
            {Array.from({ length: stack.drawn }, (_, chipIdx) => (
              <span
                key={chipIdx}
                className={`chip-stack__denom-chip${
                  stack.partial ? ' chip-stack__denom-chip--partial' : ''
                }`}
                style={
                  {
                    '--denom-color': stack.denom.color,
                    '--denom-accent': stack.denom.accent,
                  } as React.CSSProperties
                }
              />
            ))}
          </span>
        ))}
      </span>
      <span className="chip-amount">{formatChips(amount)}</span>
    </div>
  );
};

export default ChipStack;
