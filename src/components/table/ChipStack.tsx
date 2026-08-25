/**
 *  CHIP STACK COMPONENT
 * Premium visual chip stacks with denomination colors and animations
 *
 * Dan 2026-08-23: the denomination ladder that used to live in this file has
 * moved to src/lib/chipDenominations.ts, the single source for the colours,
 * the "fewest chips" rule, and both spec ambiguities (purple listed twice;
 * nothing between 5,000 and 100,000).
 *
 * The local copy was wrong in two ways worth recording so neither comes back:
 *
 *   1. It stopped at 5,000, so every chip above that (100K blue, 500K pink,
 *      1M teal, 5M maroon) did not exist and a million-chip pot drew as a pile
 *      of oranges.
 *   2. calculateChips clamped each stack at ten chips for "visual clarity" and
 *      then subtracted the CLAMPED count from the remainder. Value therefore
 *      evaporated: the chips drawn never added up to the amount, which is the
 *      one property Dan actually asked for. visualChipStacks clamps the DISCS
 *      DRAWN and keeps the true count, so a clamped stack prints "x12" rather
 *      than quietly losing 35,000.
 */

import { visualChipStacks, type ChipStackVisual } from '../../lib/chipDenominations';
import './ChipStack.css';

export interface ChipStackProps {
  amount: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  animated?: boolean;
  className?: string;
  prevAmount?: number; // For detecting amount changes
}

// Chip sizes
const SIZES = {
  sm: { chipSize: 20, spacing: 3 },
  md: { chipSize: 28, spacing: 4 },
  lg: { chipSize: 36, spacing: 5 },
};

export default function ChipStack({
  amount,
  size = 'md',
  showLabel = true,
  animated = true,
  className = '',
  prevAmount,
}: ChipStackProps) {
  if (amount <= 0) return null;

  // Five stacks of five is what this component's absolute-positioned chip
  // layout can hold without stacks overlapping their neighbours.
  // UPDATE: We flatten all denominations into a single vertical pile
  // to satisfy the "all stacked in one pile" requirement.
  const stacks: ChipStackVisual[] = visualChipStacks(amount, { maxStacks: 5, maxPerStack: 4 });
  const { chipSize, spacing } = SIZES[size];

  const flattenedChips: {
    denom: any;
    partial: boolean;
    isTopInDenom: boolean;
    truncated: boolean;
    count: number;
  }[] = [];
  stacks.forEach((stack) => {
    for (let i = 0; i < stack.drawn; i++) {
      flattenedChips.push({
        denom: stack.denom,
        partial: stack.partial,
        isTopInDenom: i === stack.drawn - 1,
        truncated: stack.truncated,
        count: stack.count,
      });
    }
  });

  const shadowDepth = Math.min(flattenedChips.length * 3, 16);

  // Detect amount change for bounce animation
  const hasAmountChanged = prevAmount !== undefined && amount !== prevAmount;
  const bounceClass = hasAmountChanged ? 'chip-stack-container--bounce' : '';

  return (
    <div className={`chip-stack-container ${bounceClass} ${className}`}>
      {/* Chip Stacks */}
      <div className="chip-stacks">
        <div
          className={`chip-stack ${animated ? 'animated' : ''}`}
          style={{
            height: chipSize * 0.2 + (flattenedChips.length - 1) * spacing,
            width: chipSize,
            filter: `drop-shadow(0 ${shadowDepth}px ${shadowDepth * 1.5}px rgba(0, 0, 0, ${0.3 + flattenedChips.length * 0.05}))`,
          }}
        >
          {flattenedChips.map((chip, index) => {
            const { denom, partial, isTopInDenom, truncated, count } = chip;

            // SLIGHTLY OFF SET logic: pseudo-random based on index
            const offsetX = Math.sin(index * 23.45) * 1.5;
            const offsetY = Math.cos(index * 34.56) * 0.5;

            return (
              <div
                key={index}
                className={`chip${partial ? ' chip--partial' : ''}`}
                style={{
                  width: chipSize,
                  height: chipSize * (partial ? 0.12 : 0.2),
                  background: `linear-gradient(135deg, ${denom.color} 0%, ${denom.accent} 100%)`,
                  borderColor: denom.accent,
                  bottom: index * spacing + offsetY,
                  left: offsetX,
                  zIndex: flattenedChips.length - index,
                }}
              >
                {/* Clamped stacks print their real count */}
                {truncated && isTopInDenom && (
                  <span
                    className="chip-stack__multi"
                    style={{
                      fontSize: chipSize * 0.3,
                      bottom: '100%',
                      left: '50%',
                      transform: 'translateX(-50%)',
                    }}
                  >
                    ×{count.toLocaleString()}
                  </span>
                )}

                {/* Only the top chip carries the value */}
                {isTopInDenom && !partial && (
                  <span
                    className="chip-value"
                    style={{ color: denom.ink, fontSize: chipSize * 0.35 }}
                  >
                    {denom.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Amount Label */}
      {showLabel && <div className="chip-amount">{amount.toLocaleString()}</div>}
    </div>
  );
}

// Pot display with chip pile visualization
export function PotDisplay({ amount, size = 'md' }: { amount: number; size?: 'sm' | 'md' | 'lg' }) {
  if (amount <= 0) return null;

  return (
    <div className="pot-display-premium">
      <div className="pot-chips">
        <ChipStack amount={amount} size={size} showLabel={false} />
      </div>
      <div className="pot-info">
        <span className="pot-label">POT</span>
        <span className="pot-value">{amount.toLocaleString()}</span>
      </div>
    </div>
  );
}

export { ChipStack };
