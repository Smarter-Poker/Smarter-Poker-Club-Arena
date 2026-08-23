import React from 'react';
import { breakChips } from '../../lib/chipDenominations';
import './ChipDenominations.css';

/**
 * The chip breakdown of a stack, as a labelled grid.
 *
 * Dan 2026-08-23: `denominations` is now OPTIONAL. This component never had a
 * ladder of its own — it rendered whatever list a caller handed it, so the
 * breakdown shown here could disagree with the chips on the felt and nothing
 * would catch it. Omit the prop and it derives the fewest-chips breakdown of
 * `totalValue` from src/lib/chipDenominations.ts, the same function the seats
 * and the pot draw from.
 *
 * The prop is kept for callers that genuinely want a custom set (a tournament
 * chip-up preview, a rack that is not a valid amount).
 */

interface Denomination {
  value: number;
  color: string;
  count: number;
  /** Short face label. Derived from the ladder when the list is. */
  label?: string;
}

interface ChipDenominationsProps {
  /** Omit to derive the fewest-chips breakdown of `totalValue`. */
  denominations?: Denomination[];
  totalValue: number;
  onDenominationClick?: (value: number) => void;
}

export const ChipDenominations: React.FC<ChipDenominationsProps> = ({
  denominations,
  totalValue,
  onDenominationClick,
}) => {
  const rows: Denomination[] =
    denominations ??
    breakChips(totalValue).chips.map(({ denom, count }) => ({
      value: denom.value,
      color: denom.color,
      count,
      label: denom.label,
    }));

  return (
    <div className="chip-denominations">
      <div className="denom-header">
        <h4>Chip Stack</h4>
        <span className="total-value">{totalValue.toLocaleString()}</span>
      </div>

      <div className="denom-grid">
        {rows.map((denom) => (
          <div
            key={denom.value}
            className="denom-item"
            onClick={() => onDenominationClick?.(denom.value)}
          >
            <div className="chip-icon" style={{ backgroundColor: denom.color }}>
              {/* The ladder's short face label ("5K", "1M"), not the full
                  number: a real chip is stamped "5K", and the old two-decimal
                  form printed "5,000,000.00" on a disc the size of a thumbnail.
                  The exact value is in the subtotal on the same row. */}
              <span className="chip-value">
                {denom.label ?? denom.value.toLocaleString('en-US')}
              </span>
            </div>
            <span className="chip-count">×{denom.count}</span>
            <span className="chip-subtotal">{(denom.value * denom.count).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ChipDenominations;
